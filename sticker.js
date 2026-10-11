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
