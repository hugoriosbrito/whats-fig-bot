// O post público devolve o arquivo original do Instagram.
// Site de "baixar vídeo" reencoda, corta e mete marca d'água.
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const DOC_ID = "27128499623469141";
const APP_ID = "936619743392459";
const KINDS = new Set(["p", "reel", "reels", "tv"]);

let session = null;

export function igLinkOf(text) {
  const match = String(text || "").match(/https?:\/\/(?:(?:www|m)\.)?instagram\.com\/[^\s]+/i);
  if (!match) return null;
  const url = match[0].replace(/[),.;!?]+$/, "");
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "instagram.com" && host !== "www.instagram.com" && host !== "m.instagram.com") return null;
  const share = /\/share\//i.test(parsed.pathname);
  const shortcode = share ? null : shortcodeOf(parsed.pathname);
  if (!share && !shortcode) return null;
  return { source: "ig", url, shortcode };
}

export function shortcodeOf(pathname) {
  const parts = String(pathname || "").split("/").filter(Boolean);
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!KINDS.has(parts[i].toLowerCase())) continue;
    const code = parts[i + 1];
    if (/^[A-Za-z0-9_-]{5,11}$/.test(code)) return code;
  }
  return null;
}

function byWidth(a, b) {
  return (Number(a.width) || 0) - (Number(b.width) || 0);
}

// A figurinha é 512px. A versão mais leve que ainda passa disso
// chega boa e gasta menos disco do que o original em alta.
export function pickIgVideo(versions) {
  const ready = (versions || []).filter((entry) => entry?.url);
  if (!ready.length) return null;
  const known = ready.some((entry) => Number(entry.width) > 0);
  if (!known) {
    return { url: ready[0].url, alternates: ready.slice(1).map((entry) => entry.url) };
  }
  const ranked = [...ready].sort(byWidth);
  const enough = ranked.filter((entry) => (Number(entry.width) || 0) >= 480);
  const chosen = enough[0] || ranked.at(-1);
  const alternates = ranked
    .filter((entry) => entry.url !== chosen.url)
    .sort((a, b) => (Number(b.width) || 0) - (Number(a.width) || 0))
    .map((entry) => entry.url);
  return { url: chosen.url, alternates };
}

export function pickIgPhoto(candidates) {
  const ready = (candidates || []).filter((entry) => entry?.url);
  if (!ready.length) return null;
  const ranked = [...ready].sort(byWidth);
  const enough = ranked.filter((entry) => (Number(entry.width) || 0) >= 640);
  return (enough[0] || ranked.at(-1)).url;
}

export function pickIgItems(post) {
  const slides = post?.carousel_media?.length ? post.carousel_media : [post];
  const items = [];
  for (const slide of slides) {
    if (!slide) continue;
    const versions = slide.video_versions || [];
    const isVideo = slide.media_type === 2 || versions.some((entry) => entry?.url);
    if (isVideo) {
      const video = pickIgVideo(versions);
      if (!video) continue;
      const own = Number(slide.video_duration) || 0;
      const fallback = slides.length === 1 ? Number(post?.video_duration) || 0 : 0;
      items.push({ kind: "video", ...video, seconds: own || fallback });
      continue;
    }
    const photo = pickIgPhoto(slide.image_versions2?.candidates);
    if (photo) items.push({ kind: "photo", url: photo });
  }
  return items;
}

function cookieValue(cookies, name) {
  const row = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  return row ? row.slice(name.length + 1) : "";
}

async function igSession() {
  if (session && Date.now() - session.at < 10 * 60 * 1000) return session;
  let response;
  try {
    response = await fetch("https://www.instagram.com/", {
      headers: {
        "user-agent": UA,
        accept: "text/html",
        "accept-language": "en-US,en;q=0.8",
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error("Não consegui abrir esse post do Instagram.");
  }
  const html = await response.text();
  const cookies = (response.headers.getSetCookie?.() || []).map((cookie) => cookie.split(";")[0]);
  const csrf = cookieValue(cookies, "csrftoken");
  const lsd = html.match(/"LSD",\[\],\{[^{}]*"token":"([^"]+)"/)?.[1] || "";
  const av = html.match(/"IG_USER_EIMU":"?(\d+)/)?.[1] || "";
  if (!response.ok || !csrf || !lsd) throw new Error("Não consegui abrir esse post do Instagram.");
  session = { at: Date.now(), csrf, lsd, av, cookie: cookies.join("; ") };
  return session;
}

async function loadPost(shortcode) {
  const gate = await igSession();
  const body = new URLSearchParams({
    variables: JSON.stringify({
      shortcode,
      __relay_internal__pv__PolarisAIGMMediaWebLabelEnabledrelayprovider: false,
    }),
    doc_id: DOC_ID,
    server_timestamps: "true",
    lsd: gate.lsd,
  });
  if (gate.av) body.set("av", gate.av);
  let response;
  try {
    response = await fetch("https://www.instagram.com/api/graphql", {
      method: "POST",
      headers: {
        "user-agent": UA,
        accept: "*/*",
        "accept-language": "en-US,en;q=0.8",
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://www.instagram.com",
        referer: `https://www.instagram.com/p/${shortcode}/`,
        "x-ig-app-id": APP_ID,
        "x-csrftoken": gate.csrf,
        "x-fb-lsd": gate.lsd,
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        cookie: gate.cookie,
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error("Não consegui abrir esse post do Instagram.");
  }
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  const message = data?.errors?.[0]?.message || "";
  if (response.status === 429 || /rate limit/i.test(message)) {
    session = null;
    throw new Error("O Instagram pediu para esperar um pouco. Tenta de novo daqui a pouco.");
  }
  const item = data?.data?.xdt_api__v1__media__shortcode__web_info?.items?.[0];
  if (!item) throw new Error("Não consegui abrir esse post do Instagram.");
  return item;
}

async function shortcodeFromShare(url) {
  let response;
  try {
    response = await fetch(url, {
      headers: { "user-agent": UA },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error("Não consegui abrir esse post do Instagram.");
  }
  let code = null;
  try {
    code = shortcodeOf(new URL(response.url).pathname);
  } catch {
    code = null;
  }
  if (!code) throw new Error("Não consegui abrir esse post do Instagram.");
  return code;
}

export async function resolveIgMedia(link) {
  const parsed = typeof link === "string" ? igLinkOf(link) : link;
  if (!parsed?.url) throw new Error("Esse link não é de um post do Instagram.");
  const shortcode = parsed.shortcode || await shortcodeFromShare(parsed.url);
  const post = await loadPost(shortcode);
  const items = pickIgItems(post);
  if (!items.length) throw new Error("Esse post não tem foto nem vídeo.");
  return { items };
}
