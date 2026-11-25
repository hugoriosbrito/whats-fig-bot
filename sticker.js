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

const STICKER_BYTES = 500 * 1024;
// Espaço reservado para o clipe de trabalho. O original é apagado em seguida.
const CLIP_BYTES = 2 * 1024 * 1024;
const LEFTOVER = /^(?:fig(?:cut|vid|som)?|in|x|ig)-\d/;

function videoFilter(mode, fps, size = 512) {
  const frame = `fps=${fps},scale='min(${size},iw)':-2,setsar=1`;
  const pad = "pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000";
  if (mode === "fit") {
    return `${frame},scale=${size}:${size}:force_original_aspect_ratio=decrease,${pad}`;
  }
  if (mode === "stretch") return `${frame},scale=${size}:${size},${pad}`;
  if (mode === "top") {
    return `${frame},scale=${size}:${size}:force_original_aspect_ratio=increase,crop=${size}:${size}:0:0,${pad}`;
  }
  if (mode === "bottom") {
    return `${frame},scale=${size}:${size}:force_original_aspect_ratio=increase,crop=${size}:${size}:0:ih-${size},${pad}`;
  }
  return `${frame},scale=${size}:${size}:force_original_aspect_ratio=increase,crop=${size}:${size},${pad}`;
}

// A primeira tentativa privilegia o movimento. As seguintes cabem nos 500 KB.
function encodePasses(seconds) {
  const span = Math.min(config.maxVideoSeconds, Math.max(1, Number(seconds) || config.maxVideoSeconds));
  const fps = Math.max(4, Math.min(12, Math.round(60 / span)));
  return [
    { fps, quality: 48, size: 512 },
    { fps: Math.max(3, fps - 2), quality: 30, size: 512 },
    { fps: 3, quality: 20, size: 320 },
    { fps: 2, quality: 15, size: 256 },
  ];
}

// Apaga sobras de uma conversão interrompida e só segue se ainda houver
// disco para o vídeo e para a figurinha.
export async function prepareDisk() {
  const dir = os.tmpdir();
  const cutoff = Date.now() - 10 * 60 * 1000;
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    names = [];
  }
  await Promise.all(names.map(async (name) => {
    if (!LEFTOVER.test(name)) return;
    const full = path.join(dir, name);
    try {
      const stat = await fs.stat(full);
      if (stat.mtimeMs < cutoff) await fs.unlink(full);
    } catch {
      /* já foi */
    }
  }));

  try {
    const stats = await fs.statfs(dir);
    const free = Number(stats.bavail) * Number(stats.bsize);
    const need = (config.maxMediaMB + 12) * 1024 * 1024;
    if (free < need) {
      throw new Error("O servidor está sem espaço agora. Tenta de novo daqui a pouco.");
    }
  } catch (error) {
    if (error.message.startsWith("O servidor está sem espaço")) throw error;
  }
}

function runCut(inputPath, out, seconds, { audio = true } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y", "-threads", "1", "-filter_threads", "1",
      "-t", String(seconds),
      "-i", inputPath,
      "-map", "0:v:0",
    ];
    if (audio) args.push("-map", "0:a:0?");
    args.push(
      "-vf", "scale='min(512,iw)':-2",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-b:v", "280k",
      "-maxrate", "280k",
      "-bufsize", "560k",
      "-pix_fmt", "yuv420p",
      "-fs", String(CLIP_BYTES),
    );
    args.push(...(audio ? ["-c:a", "aac", "-b:a", "32k", "-ac", "1"] : ["-an"]));
    args.push("-movflags", "+faststart", out);

    const ffmpeg = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    const timer = setTimeout(() => {
      ffmpeg.kill();
      reject(new Error("O corte do vídeo demorou demais."));
    }, 120_000);
    let errorText = "";
    ffmpeg.stderr.on("data", (chunk) => {
      errorText = `${errorText}${chunk}`.slice(-4000);
    });
    ffmpeg.on("error", (error) => {
      clearTimeout(timer);
      reject(error.code === "ENOENT"
        ? new Error("FFmpeg não está instalado neste servidor.")
        : error);
    });
    ffmpeg.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const failure = new Error("Não consegui cortar esse vídeo.");
        if (/matches no streams|does not contain any stream|Stream specifier/i.test(errorText)) failure.noAudio = true;
        reject(failure);
        return;
      }
      resolve(out);
    });
  });
}

// Reserva um clipe de no máximo 2 MB. O vídeo original é apagado depois,
// para a conversão não ficar com os dois arquivos no disco.
export async function cutVideo(inputPath) {
  const seconds = config.maxVideoSeconds;
  const out = path.join(os.tmpdir(), `figcut-${Date.now()}-${Math.floor(Math.random() * 1e6)}.mp4`);
  const missingFfmpeg = (error) => error?.code === "ENOENT" || /FFmpeg não está instalado/.test(error?.message || "");

  try {
    await runCut(inputPath, out, seconds, { audio: true });
    const size = (await fs.stat(out)).size;
    if (size >= 1024 && size <= CLIP_BYTES * 2) return out;
    throw new Error("Não consegui cortar esse vídeo.");
  } catch (error) {
    await cleanup(out);
    if (missingFfmpeg(error) || !error.noAudio) throw error;
  }

  try {
    await runCut(inputPath, out, seconds, { audio: false });
    return out;
  } catch (error) {
    await cleanup(out);
    throw error;
  }
}

function runFfmpeg(inputPath, out, mode, { fps, quality, size }) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-y",
      "-threads", "1",
      "-filter_threads", "1",
      "-i", inputPath,
      "-t", String(config.maxVideoSeconds),
      "-vf", videoFilter(mode, fps, size),
      "-c:v", "libwebp_anim",
      "-loop", "0",
      "-an",
      "-q:v", String(quality),
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
      if (stat.size > STICKER_BYTES) {
        reject(Object.assign(new Error("Muito grande."), { code: "STICKER_TOO_LARGE" }));
      } else {
        resolve(out);
      }
    });
  });
}

// O áudio acompanha o mesmo trecho cortado do vídeo.
const SOUND_SECONDS = config.maxVideoSeconds;

function runAudio(inputPath, out) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-y",
      "-threads", "1",
      "-i", inputPath,
      "-t", String(SOUND_SECONDS),
      "-vn",
      "-map", "0:a:0",
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
        if (/matches no streams|does not contain any stream|Stream specifier/i.test(errorText)) {
          resolve(null);
          return;
        }
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

// Vídeo com som devolve o áudio em Opus. Vídeo mudo devolve null.
// Não usa ffprobe: no servidor só o ffmpeg é garantido, e sem a checagem
// o vídeo do X saía mudo.
export async function extractStickerAudio(inputPath) {
  const out = path.join(os.tmpdir(), `figsom-${Date.now()}-${Math.floor(Math.random() * 1e6)}.ogg`);
  try {
    const audio = await runAudio(inputPath, out);
    if (!audio) await cleanup(out);
    return audio;
  } catch (error) {
    await cleanup(out);
    throw error;
  }
}

// Vídeo curto vira WebP animado. Se passar de 500 KB, a próxima tentativa
// sacrifica quadro e qualidade — o arquivo que não serviu é apagado na hora.
export async function videoToSticker(inputPath, { mode = "fit", seconds } = {}) {
  const passes = encodePasses(seconds);
  for (const pass of passes) {
    const out = path.join(os.tmpdir(), `figvid-${Date.now()}-${pass.fps}.webp`);
    try {
      return await runFfmpeg(inputPath, out, mode, pass);
    } catch (error) {
      await cleanup(out);
      if (error.code === "STICKER_TIMEOUT" || pass === passes.at(-1)) throw error;
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
