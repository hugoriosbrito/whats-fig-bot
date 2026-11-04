import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseBuffer } from "music-metadata";
import { config } from "./config.js";

// Áudio de voz para o WhatsApp: o PTT (mensagem de voz) exige OGG com codec Opus.
// O MP3 que a Fish Audio devolve não toca como voz, então a conversão passa pelo
// FFmpeg — o mesmo já usado nas figurinhas animadas.

const tmpName = (ext) =>
  path.join(os.tmpdir(), `tts-${Date.now()}-${Math.floor(Math.random() * 1e6)}.${ext}`);

export function ttsTextFrom(args) {
  return (args || []).join(" ").replace(/\s+/g, " ").trim();
}

export function validateTtsText(text) {
  if (!text) {
    return { ok: false, reason: "empty", message: `Qual texto eu falo? Exemplo: *${config.prefix}tts bom dia a todos*` };
  }
  if (text.length > config.ttsMaxChars) {
    return {
      ok: false,
      reason: "long",
      message: `Texto muito longo (${text.length} caracteres). O máximo é ${config.ttsMaxChars}.`,
    };
  }
  return { ok: true };
}

async function toOpus(inputPath) {
  const out = tmpName("ogg");
  await new Promise((resolve, reject) => {
    const ffmpeg = spawn(
      "ffmpeg",
      [
        "-y",
        "-threads", "1",
        "-filter_threads", "1",
        "-i", inputPath,
        "-vn",
        "-c:a", "libopus",
        "-b:a", "32k",
        "-ar", "48000",
        "-ac", "1",
        "-application", "voip",
        out,
      ],
      { stdio: ["ignore", "ignore", "ignore"] }
    );
    const timer = setTimeout(() => {
      ffmpeg.kill();
      reject(new Error("A conversão do áudio demorou demais."));
    }, 120_000);

    ffmpeg.on("error", (error) => {
      clearTimeout(timer);
      reject(error.code === "ENOENT"
        ? new Error("FFmpeg não está instalado neste servidor.")
        : error);
    });
    ffmpeg.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error("Não consegui preparar o áudio para o WhatsApp."));
    });
  });
  return out;
}

// Recebe o MP3 da Fish Audio e devolve o OGG/Opus com a duração já medida.
export async function prepareVoice(mp3) {
  const input = tmpName("mp3");
  let output;
  try {
    await fs.writeFile(input, mp3);
    output = await toOpus(input);
    const audio = await fs.readFile(output);
    return await measure(audio);
  } finally {
    await fs.unlink(input).catch(() => {});
    if (output) await fs.unlink(output).catch(() => {});
  }
}

async function measure(audio) {
  const { format } = await parseBuffer(audio, { mimeType: "audio/ogg", size: audio.length }, { duration: true });
  const seconds = Math.round(format.duration || 0);

  if (audio.length > config.ttsMaxBytes) {
    throw new Error(
      `O áudio ficou com ${(audio.length / 1024 / 1024).toFixed(1)}MB, acima do limite de ${Math.round(config.ttsMaxBytes / 1024 / 1024)}MB. Tente um texto menor.`
    );
  }
  return { audio, seconds };
}

// Plano B quando o servidor não tem FFmpeg: pede Opus direto à Fish Audio.
// O áudio chega no formato certo para o WhatsApp e só é medido aqui.
export async function prepareVoiceFromOpus(opus) {
  if (!opus.length || opus.subarray(0, 4).toString() !== "OggS") {
    throw new Error("A Fish Audio devolveu um áudio em formato inesperado.");
  }
  return measure(opus);
}
