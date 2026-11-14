import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

function run(args, out) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-y", "-threads", "1", ...args, out], { stdio: ["ignore", "ignore", "pipe"] });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("A conversão demorou demais."));
    }, 120_000);
    let errorText = "";
    child.stderr.on("data", (chunk) => {
      errorText += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error.code === "ENOENT" ? new Error("FFmpeg não está instalado neste servidor.") : error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(errorText.includes("Invalid") ? "Não consegui ler esse arquivo." : "Não consegui converter."));
    });
  });
}

export async function toMp3(input) {
  const out = path.join(os.tmpdir(), `audio-${Date.now()}.mp3`);
  await run(["-i", input, "-vn", "-ac", "1", "-b:a", "64k"], out);
  return out;
}

export async function toMp4(input) {
  const out = path.join(os.tmpdir(), `video-${Date.now()}.mp4`);
  await run(["-i", input, "-an", "-vf", "scale=512:-2", "-t", "10", "-movflags", "+faststart"], out);
  return out;
}

const EMOJI_SVG = "https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/svg";

export function emojiGlyphs(text) {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(String(text || ""))]
    .map((part) => part.segment)
    .filter((segment) => /\p{Extended_Pictographic}/u.test(segment));
}

function emojiCode(glyph) {
  return [...glyph]
    .map((char) => char.codePointAt(0).toString(16))
    .filter((code) => code !== "fe0f")
    .join("-");
}

async function emojiSvg(glyph) {
  const response = await fetch(`${EMOJI_SVG}/${emojiCode(glyph)}.svg`);
  if (!response.ok) throw new Error("Não achei a imagem desse emoji.");
  const text = await response.text();
  if (!text.includes("<svg")) throw new Error("A imagem desse emoji veio vazia.");
  return Buffer.from(text);
}

export async function emojiSticker(first, second) {
  const [left, right] = await Promise.all([emojiSvg(first), emojiSvg(second)]);
  const size = 250;
  const rendered = await Promise.all(
    [left, right].map((svg) => sharp(svg).resize(size, size, { fit: "contain" }).png().toBuffer())
  );
  return sharp({
    create: { width: 512, height: 512, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      { input: rendered[0], left: 6, top: 131 },
      { input: rendered[1], left: 256, top: 131 },
    ])
    .webp({ quality: 80 })
    .toBuffer();
}

export async function removeFile(file) {
  if (!file) return;
  try {
    await fs.unlink(file);
  } catch {
    /* já foi */
  }
}
