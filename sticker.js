import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { config } from "./config.js";

// Converte imagem em figurinha WebP 512x512 (padrão do WhatsApp).
// Lê de arquivo em disco e escreve em disco — nunca segura a mídia toda na RAM.
export async function imageToSticker(inputPath, { mode = "fit" } = {}) {
  const out = path.join(
    os.tmpdir(),
    `fig-${Date.now()}-${Math.floor(Math.random() * 1e6)}.webp`
  );

  let pipeline = sharp(inputPath, {
    animated: false,
    limitInputPixels: 16_777_216,
    sequentialRead: true,
  }).rotate();

  if (mode === "fill") {
    // Preenche tudo (corta as bordas que sobrarem)
    pipeline = pipeline.resize(512, 512, { fit: "cover", position: "centre" });
  } else if (mode === "stretch") {
    // Estica (distorce, mas ocupa tudo)
    pipeline = pipeline.resize(512, 512, { fit: "fill" });
  } else if (mode === "top" || mode === "bottom") {
    pipeline = pipeline.resize(512, 512, { fit: "cover", position: mode });
  } else {
    // Padrão: cabe inteira, fundo transparente nas sobras
    pipeline = pipeline.resize(512, 512, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    });
  }

  await pipeline.webp({ quality: 80 }).toFile(out);
  return out;
}

function videoFilter(mode, fps) {
  const upright = `fps=${fps},scale='min(512,iw)':-2,setsar=1`;
  if (mode === "fit") {
    return `${upright},scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000`;
  }
  if (mode === "stretch") return `${upright},scale=512:512`;
  if (mode === "top") {
    return `${upright},scale=512:512:force_original_aspect_ratio=increase,crop=512:512:0:0`;
  }
  if (mode === "bottom") {
    return `${upright},scale=512:512:force_original_aspect_ratio=increase,crop=512:512:0:ih-512`;
  }
  return `${upright},scale=512:512:force_original_aspect_ratio=increase,crop=512:512`;
}

function runFfmpeg(inputPath, out, mode, fps) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-y",
      "-threads", "1",
      "-filter_threads", "1",
      "-i", inputPath,
      "-t", String(Math.min(config.maxVideoSeconds, 6)),
      "-vf", videoFilter(mode, fps),
      "-c:v", "libwebp_anim",
      "-loop", "0",
      "-an",
      "-q:v", "60",
      "-compression_level", "2",
      out,
    ], { stdio: ["ignore", "ignore", "ignore"] });
    const timer = setTimeout(() => {
      ffmpeg.kill();
      reject(Object.assign(new Error("A conversão do vídeo demorou demais. Manda um vídeo mais curto."), { code: "STICKER_TIMEOUT" }));
    }, 180_000);

    ffmpeg.on("error", (error) => {
      clearTimeout(timer);
      reject(error.code === "ENOENT"
        ? new Error("FFmpeg não está instalado neste servidor.")
        : error);
    });
    ffmpeg.on("close", async (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error("Não consegui converter esse vídeo."));
        return;
      }
      const stat = await fs.stat(out);
      if (stat.size > 500 * 1024) {
        reject(Object.assign(new Error("Muito grande."), { code: "STICKER_TOO_LARGE" }));
      } else {
        resolve(out);
      }
    });
  });
}

// O WhatsApp toca no máximo 10s de áudio numa figurinha, e a figurinha
// feita de vídeo leva os 5 primeiros segundos do som original.
const SOUND_SECONDS = 5;

function runAudio(inputPath, out) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-y",
      "-threads", "1",
      "-i", inputPath,
      "-t", String(SOUND_SECONDS),
      "-vn",
      "-map", "0:a:0?",
      "-c:a", "libopus",
      "-b:a", "32k",
      "-ac", "1",
      "-ar", "48000",
      "-application", "voip",
      out,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    const timer = setTimeout(() => {
      ffmpeg.kill();
      reject(new Error("A extração do áudio demorou demais."));
    }, 60_000);
    let errorText = "";
    ffmpeg.stderr.on("data", (chunk) => {
      errorText = `${errorText}${chunk}`.slice(-4000);
    });
    ffmpeg.on("error", (error) => {
      clearTimeout(timer);
      reject(error.code === "ENOENT" ? new Error("FFmpeg não está instalado neste servidor.") : error);
    });
    ffmpeg.on("close", async (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error("Não consegui tirar o áudio desse vídeo."));
        return;
      }
      try {
        const stat = await fs.stat(out);
        resolve(stat.size > 0 ? out : null);
      } catch {
        resolve(null);
      }
    });
  });
}

function hasAudioTrack(inputPath) {
  return new Promise((resolve) => {
    const probe = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "a:0",
      "-show_entries", "stream=codec_type",
      "-of", "csv=p=0",
      inputPath,
    ], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    const timer = setTimeout(() => {
      probe.kill();
      resolve(false);
    }, 15_000);
    probe.stdout.on("data", (chunk) => {
      output += chunk;
    });
    probe.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    probe.on("close", () => {
      clearTimeout(timer);
      resolve(output.includes("audio"));
    });
  });
}

// Vídeo com som devolve o áudio em Opus. Vídeo mudo devolve null.
export async function extractStickerAudio(inputPath) {
  if (!(await hasAudioTrack(inputPath))) return null;
  const out = path.join(os.tmpdir(), `figsom-${Date.now()}-${Math.floor(Math.random() * 1e6)}.ogg`);
  try {
    return await runAudio(inputPath, out);
  } catch (error) {
    await cleanup(out);
    throw error;
  }
}

// Vídeo curto vira WebP animado. O FFmpeg limita duração, tamanho e resolução.
export async function videoToSticker(inputPath, { mode = "fit" } = {}) {
  const fpsSteps = [15, 12, 10, 8, 6];
  for (const fps of fpsSteps) {
    const out = path.join(os.tmpdir(), `figvid-${Date.now()}-${fps}.webp`);
    try {
      return await runFfmpeg(inputPath, out, mode, fps);
    } catch (error) {
      await cleanup(out);
      if (error.code === "STICKER_TIMEOUT" || fps === fpsSteps.at(-1)) throw error;
      if (error.code !== "STICKER_TOO_LARGE") throw error;
    }
  }
}

// Valida o tamanho antes de baixar: protege a RAM de 256MB do free tier.
export function assertSizeOk(bytes) {
  const max = config.maxMediaMB * 1024 * 1024;
  if (bytes > max) {
    throw new Error(
      `Mídia muito pesada (${(bytes / 1024 / 1024).toFixed(1)}MB). Máximo: ${config.maxMediaMB}MB.`
    );
  }
}

export async function cleanup(...paths) {
  for (const p of paths) {
    if (!p) continue;
    try {
      await fs.unlink(p);
    } catch {
      /* já removido ou nunca existiu */
    }
  }
}
