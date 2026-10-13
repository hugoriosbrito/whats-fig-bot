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

  let pipeline = sharp(inputPath, { animated: false }).rotate(); // respeita EXIF

  if (mode === "fill") {
    // Preenche tudo (corta as bordas que sobrarem)
    pipeline = pipeline.resize(512, 512, { fit: "cover", position: "centre" });
  } else if (mode === "stretch") {
    // Estica (distorce, mas ocupa tudo)
    pipeline = pipeline.resize(512, 512, { fit: "fill" });
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

function videoFilter(mode) {
  const upright = "fps=10,scale=iw*sar:ih,setsar=1";
  if (mode === "fit") {
    return `${upright},scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000`;
  }
  if (mode === "stretch") return `${upright},scale=512:512`;
  return `${upright},scale=512:512:force_original_aspect_ratio=increase,crop=512:512`;
}

function runFfmpeg(inputPath, out, mode, fps) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-y",
      "-i", inputPath,
      "-t", String(config.maxVideoSeconds),
      "-vf", videoFilter(mode).replace("fps=10", `fps=${fps}`),
      "-c:v", "libwebp_anim",
      "-loop", "0",
      "-an",
      "-q:v", "55",
      "-compression_level", "6",
      out,
    ], { stdio: ["ignore", "ignore", "ignore"] });
    const timer = setTimeout(() => {
      ffmpeg.kill();
      reject(new Error("A conversão do vídeo demorou demais."));
    }, 60_000);

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

// Vídeo curto vira WebP animado. O FFmpeg limita duração, tamanho e resolução.
export async function videoToSticker(inputPath, { mode = "fit" } = {}) {
  for (const fps of [10, 8, 6]) {
    const out = path.join(os.tmpdir(), `figvid-${Date.now()}-${fps}.webp`);
    try {
      return await runFfmpeg(inputPath, out, mode, fps);
    } catch (error) {
      await cleanup(out);
      if (error.code !== "STICKER_TOO_LARGE" || fps === 6) {
        if (error.code === "STICKER_TOO_LARGE") throw new Error("O vídeo ficou acima de 500 KB. Manda um trecho mais curto.");
        throw error;
      }
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
