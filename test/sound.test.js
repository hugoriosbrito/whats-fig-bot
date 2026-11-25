import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { proto } from "@whiskeysockets/baileys";
import { getMediaKeys } from "@whiskeysockets/baileys/lib/Utils/messages-media.js";
import sharp from "sharp";
import { pickVideo } from "../link.js";
import { extractStickerAudio } from "../sticker.js";
import { markSoundSticker, rememberSound, streamingSidecar } from "../sound.js";

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-y", ...args], { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`))));
  });
}

test("a figurinha com som vai no campo 134, com o campo 24 em zero", () => {
  const message = proto.Message.create({
    stickerMessage: { url: "https://exemplo/figurinha", mimetype: "image/webp", isAnimated: true },
  });
  const audio = proto.Message.AudioMessage.create({
    url: "https://exemplo/audio",
    mimetype: "audio/ogg; codecs=opus",
    seconds: 5,
  });
  rememberSound(message, audio);
  const encoded = proto.Message.encode(message).finish();
  assert.equal(readLengthDelimited(encoded, 26).length, 0);

  const wrapper = readLengthDelimited(encoded, 134);
  const inner = readLengthDelimited(wrapper, 1);
  const stickerBytes = readLengthDelimited(inner, 26);
  const decoded = proto.Message.StickerMessage.decode(stickerBytes);
  assert.equal(decoded.url, "https://exemplo/figurinha");
  assert.equal(decoded.isAnimated, true);

  const extra = stickerBytes.subarray(proto.Message.StickerMessage.encode(decoded).finish().length);
  assert.equal(readVarint(extra, 24), 0);
  const sound = proto.Message.AudioMessage.decode(readLengthDelimited(extra, 26));
  assert.equal(sound.mimetype, "audio/ogg; codecs=opus");
  assert.equal(sound.seconds, 5);

  const plain = proto.Message.encode(proto.Message.create({ conversation: "oi" })).finish();
  assert.equal(readLengthDelimited(plain, 134).length, 0);
});

test("o WebP ganha o hash do áudio no EXIF", async () => {
  const webp = await sharp({
    create: { width: 32, height: 32, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).webp().toBuffer();
  const audio = Buffer.from("opus-de-teste");
  const marked = await markSoundSticker(webp, audio);
  const text = marked.toString("utf8");
  assert.match(text, /sound-sha256/);
  const hash = createHash("sha256").update(audio).digest("base64");
  assert.ok(text.includes(hash));
});

test("a tabela do áudio bate com o arquivo criptografado", async () => {
  const mediaKey = randomBytes(32);
  const { iv, macKey, cipherKey } = await getMediaKeys(mediaKey, "audio");
  const plain = randomBytes(70_000);
  const cipher = createCipheriv("aes-256-cbc", cipherKey, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const file = path.join(os.tmpdir(), `sidecar-${Date.now()}`);
  await fs.writeFile(file, encrypted);
  const sidecar = await streamingSidecar(file, iv, macKey);
  await fs.unlink(file);

  assert.equal(sidecar.length, 20);
  const first = createHmac("sha256", macKey).update(iv).update(encrypted.subarray(0, 65_536)).digest().subarray(0, 10);
  const second = createHmac("sha256", macKey)
    .update(encrypted.subarray(65_536 - 16, 65_536))
    .update(encrypted.subarray(65_536))
    .digest()
    .subarray(0, 10);
  assert.deepEqual(sidecar.subarray(0, 10), first);
  assert.deepEqual(sidecar.subarray(10), second);
});

test("vídeo do X guarda as versões mais pesadas para o caso da leve vir muda", () => {
  const media = pickVideo({
    media: {
      videos: [{
        type: "video",
        duration: 4.921,
        formats: [
          { container: "mp4", bitrate: 632000, url: "https://video.twimg.com/leve.mp4" },
          { container: "mp4", bitrate: 950000, url: "https://video.twimg.com/media.mp4" },
          { container: "mp4", bitrate: 2176000, url: "https://video.twimg.com/alta.mp4" },
        ],
      }],
    },
  });
  assert.equal(media.url, "https://video.twimg.com/leve.mp4");
  assert.deepEqual(media.alternates, [
    "https://video.twimg.com/alta.mp4",
    "https://video.twimg.com/media.mp4",
  ]);
});

test("vídeo com som devolve áudio e vídeo mudo não devolve", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "figsom-"));
  const tone = path.join(dir, "tom.ogg");
  const loud = path.join(dir, "com-som.mp4");
  const quiet = path.join(dir, "mudo.mp4");
  await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "libopus", tone]);
  await ffmpeg([
    "-f", "lavfi", "-i", "color=c=black:s=64x64:d=1",
    "-i", tone,
    "-shortest", "-c:v", "libx264", "-c:a", "aac", loud,
  ]);
  await ffmpeg(["-f", "lavfi", "-i", "color=c=black:s=64x64:d=1", "-c:v", "libx264", "-an", quiet]);

  const audio = await extractStickerAudio(loud);
  const silent = await extractStickerAudio(quiet);
  assert.equal(typeof audio, "string");
  const stat = await fs.stat(audio);
  assert.ok(stat.size > 0);
  assert.equal(silent, null);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.unlink(audio);
});

function readField(buffer, field, wireType) {
  let offset = 0;
  while (offset < buffer.length) {
    const key = readVarintAt(buffer, offset);
    offset = key.next;
    const wire = key.value & 7;
    const number = Math.floor(key.value / 8);
    if (wire === 2) {
      const length = readVarintAt(buffer, offset);
      const start = length.next;
      const end = start + length.value;
      if (number === field && wireType === 2) return buffer.subarray(start, end);
      offset = end;
    } else if (wire === 0) {
      const value = readVarintAt(buffer, offset);
      if (number === field && wireType === 0) return value.value;
      offset = value.next;
    } else {
      break;
    }
  }
  return wireType === 2 ? Buffer.alloc(0) : null;
}

function readLengthDelimited(buffer, field) {
  return readField(buffer, field, 2);
}

function readVarint(buffer, field) {
  return readField(buffer, field, 0);
}

function readVarintAt(buffer, offset) {
  let value = 0;
  let shift = 0;
  while (offset < buffer.length) {
    const byte = buffer[offset];
    offset += 1;
    value += (byte & 127) * (2 ** shift);
    if ((byte & 128) === 0) return { value, next: offset };
    shift += 7;
  }
  return { value, next: offset };
}
