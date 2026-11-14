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

export async function emojiSticker(first, second) {
  const out = path.join(os.tmpdir(), `emoji-${Date.now()}.webp`);
  const svg = `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
    <rect width="512" height="512" fill="none"/>
    <text x="150" y="300" font-size="180" text-anchor="middle">${escapeXml(first)}</text>
    <text x="360" y="340" font-size="180" text-anchor="middle">${escapeXml(second)}</text>
  </svg>`;
  await sharp(Buffer.from(svg)).webp({ quality: 80 }).toFile(out);
  const made = await fs.readFile(out);
  await fs.unlink(out);
  return made;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function removeFile(file) {
  if (!file) return;
  try {
    await fs.unlink(file);
  } catch {
    /* já foi */
  }
}
