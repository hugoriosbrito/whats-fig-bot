import { createWriteStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "./config.js";
import { assertSizeOk } from "./sticker.js";

const HOSTS = new Set(["x.com", "twitter.com", "mobile.twitter.com", "mobile.x.com"]);
const API = "https://api.fxtwitter.com";

export function xLinkOf(text) {
  const match = String(text || "").match(
    /https?:\/\/(?:mobile\.)?(?:twitter|x)\.com\/(?:i\/web\/|[^/\s]+\/)?status(?:es)?\/(\d+)/i
  );
  return match ? { url: match[0], id: match[1] } : null;
}

function mp4Variants(item) {
  const formats = item?.formats || [];
  const variants = item?.variants || [];
  const fromFormats = formats
    .filter((entry) => entry.container === "mp4" && entry.url && entry.bitrate)
    .map((entry) => ({ url: entry.url, bitrate: entry.bitrate }));
  if (fromFormats.length) return fromFormats;
  return variants
    .filter((entry) => entry.content_type === "video/mp4" && entry.url && entry.bitrate)
    .map((entry) => ({ url: entry.url, bitrate: entry.bitrate }));
}

const PHOTO_NAME = /([?&])name=[^&]*/;

// A figurinha é 512px. "large" (~2048px no lado maior) chega nítida
// sem baixar o original, que em foto de câmera passa fácil dos 16 MB.
export function photoUrl(url) {
  if (!url) return null;
  if (PHOTO_NAME.test(url)) return url.replace(PHOTO_NAME, "$1name=large");
  return `${url}${url.includes("?") ? "&" : "?"}name=large`;
}

export function pickPhotos(tweet) {
  const items = (tweet?.media?.all || tweet?.media?.photos || [])
    .filter((entry) => entry.type === "photo" && entry.url);
  return items.map((entry) => photoUrl(entry.url));
}

export function pickVideo(tweet) {
  const items = tweet?.media?.all || tweet?.media?.videos || [];
  const item = items.find((entry) => entry.type === "video" || entry.type === "gif");
  if (!item) return null;
  const variants = mp4Variants(item);
  if (!variants.length) return null;
  // A figurinha final é 512px. A variante mais leve que ainda passa disso
  // chega boa e gasta menos disco e CPU do que o original em alta.
  const ranked = [...variants].sort((a, b) => a.bitrate - b.bitrate);
  const lightEnough = ranked.filter((entry) => entry.bitrate <= 900_000);
  const chosen = lightEnough.at(-1) || ranked[0];
  return {
    url: chosen.url,
    seconds: Number(item.duration) || 0,
    kind: item.type,
  };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "zap-fig-bot" },
    signal: AbortSignal.timeout(20_000),
    redirect: "follow",
  });
  if (!response.ok) throw new Error("Não consegui abrir esse post do X.");
  return response.json();
}

async function loadTweet(link) {
  const parsed = typeof link === "string" ? xLinkOf(link) : link;
  if (!parsed) throw new Error("Esse link não é de um post do X.");
  try {
    const data = await fetchJson(`${API}/status/${parsed.id}`);
    if (!data?.tweet) throw new Error("sem post");
    return data.tweet;
  } catch {
    throw new Error("Não consegui abrir esse post do X.");
  }
}

export async function resolveXMedia(link) {
  const tweet = await loadTweet(link);
  const photos = pickPhotos(tweet);
  if (photos.length) return { kind: "photo", urls: photos };
  const video = pickVideo(tweet);
  if (video) return { kind: video.kind, ...video };
  throw new Error("Esse post não tem foto, vídeo nem GIF.");
}

export async function resolveXVideo(link) {
  const media = await resolveXMedia(link);
  if (media.kind === "photo") throw new Error("Esse post não tem vídeo nem GIF.");
  return media;
}

function extensionOf(url) {
  const name = new URL(url).pathname.split(".").pop()?.toLowerCase();
  return ["jpg", "jpeg", "png", "webp"].includes(name) ? name : "mp4";
}

export async function downloadMedia(url) {
  const target = new URL(url);
  if (target.protocol !== "https:" || !target.hostname.endsWith("twimg.com")) {
    throw new Error("A mídia desse post não está disponível para download.");
  }
  const tmp = path.join(
    os.tmpdir(),
    `x-${Date.now()}-${Math.floor(Math.random() * 1e6)}.${extensionOf(url)}`
  );
  let response;
  try {
    response = await fetch(target, {
      headers: { "user-agent": "zap-fig-bot" },
      signal: AbortSignal.timeout(60_000),
      redirect: "follow",
    });
  } catch {
    await fs.unlink(tmp).catch(() => {});
    throw new Error("Não consegui baixar a mídia do X.");
  }
  if (!response.ok || !response.body) {
    throw new Error("Não consegui baixar a mídia do X.");
  }
  const announced = Number(response.headers.get("content-length") || 0);
  if (announced) assertSizeOk(announced);
  const max = config.maxMediaMB * 1024 * 1024;
  let received = 0;
  const limited = Readable.fromWeb(response.body);
  limited.on("data", (chunk) => {
    received += chunk.length;
    if (received > max) {
      limited.destroy(new Error(
        `Mídia muito pesada. Máximo: ${config.maxMediaMB}MB.`
      ));
    }
  });
  try {
    await pipeline(limited, createWriteStream(tmp));
  } catch (error) {
    await fs.unlink(tmp).catch(() => {});
    throw error.code === "ABORT_ERR"
      ? new Error("O download da mídia do X demorou demais.")
      : error;
  }
  return tmp;
}

export async function downloadVideo(url) {
  return downloadMedia(url);
}

export { HOSTS };
