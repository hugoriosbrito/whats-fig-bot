import { createHash, createHmac } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { proto } from "@whiskeysockets/baileys";
import { encryptedStream, getMediaKeys } from "@whiskeysockets/baileys/lib/Utils/messages-media.js";
import { unixTimestampSeconds } from "@whiskeysockets/baileys/lib/Utils/generics.js";
import webpmux from "node-webpmux";

const CHUNK = 64 * 1024;
const MAC_LENGTH = 10;
const AUDIO_FIELD = (26 << 3) | 2;

// O cliente só desenha o ícone de som se o WebP traz "sound-sha256" no EXIF
// e o StickerMessage traz o AudioMessage no campo 26. O proto do Baileys
// ainda não declara esse campo, então ele é escrito na hora de enviar.

// Tabela de HMAC que o cliente usa para ir tocando enquanto baixa.
// São 10 bytes a cada 64 KB do arquivo criptografado, com o IV na frente.
export async function streamingSidecar(file, iv, macKey) {
  const handle = await fs.open(file, "r");
  try {
    const parts = [];
    let previous = Buffer.from(iv);
    const chunk = Buffer.alloc(CHUNK);
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, CHUNK, null);
      if (!bytesRead) break;
      const mac = createHmac("sha256", macKey).update(previous).update(chunk.subarray(0, bytesRead)).digest();
      parts.push(mac.subarray(0, MAC_LENGTH));
      previous = chunk.subarray(bytesRead - 16, bytesRead);
    }
    return Buffer.concat(parts);
  } finally {
    await handle.close();
  }
}

async function sha256Of(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest();
}

// Sobe o Opus criptografado como áudio e devolve o AudioMessage pronto
// para entrar na figurinha. O upload é o mesmo que o Baileys usa.
export async function uploadStickerAudio(file, { upload, seconds }) {
  const encrypted = await encryptedStream(file, "audio");
  try {
    const digest = (await sha256Of(encrypted.encFilePath)).toString("base64");
    const uploaded = await upload(encrypted.encFilePath, {
      fileEncSha256B64: digest,
      mediaType: "audio",
      timeoutMs: 60_000,
    });
    const { macKey, iv } = await getMediaKeys(encrypted.mediaKey, "audio");
    return proto.Message.AudioMessage.create({
      url: uploaded.mediaUrl,
      directPath: uploaded.directPath,
      mediaKey: encrypted.mediaKey,
      fileEncSha256: encrypted.fileEncSha256,
      fileSha256: encrypted.fileSha256,
      fileLength: encrypted.fileLength,
      seconds: Math.max(1, Math.round(seconds || 1)),
      mediaKeyTimestamp: unixTimestampSeconds(),
      mimetype: "audio/ogg; codecs=opus",
      streamingSidecar: await streamingSidecar(encrypted.encFilePath, iv, macKey),
    });
  } finally {
    await fs.unlink(encrypted.encFilePath).catch(() => {});
  }
}

const SOUND = Symbol("sound");

export function rememberSound(message, audio) {
  if (!message?.stickerMessage || !audio) return;
  message.stickerMessage[SOUND] = audio;
}

// Escreve o áudio dentro da figurinha, no campo 26, só na cópia criptografada.
export function patchSoundSticker(message) {
  const audio = message?.stickerMessage?.[SOUND];
  if (!audio) return message;
  delete message.stickerMessage[SOUND];
  const original = proto.Message.StickerMessage.encode;
  proto.Message.StickerMessage.encode = function encodeWithAudio(value, writer) {
    proto.Message.StickerMessage.encode = original;
    const encoded = original.call(proto.Message.StickerMessage, value, writer);
    if (value === message.stickerMessage) {
      proto.Message.AudioMessage.encode(audio, encoded.uint32(AUDIO_FIELD).fork()).ldelim();
    }
    return encoded;
  };
  return message;
}

// O ícone de som sai do hash do áudio gravado no EXIF do WebP.
export async function markSoundSticker(webp, audio) {
  const hash = createHash("sha256").update(audio).digest("base64");
  const json = Buffer.from(JSON.stringify({
    "sticker-pack-id": "com.figbot.sticker",
    "sticker-pack-name": "FigBot",
    "sticker-pack-publisher": "FigBot",
    "sound-sha256": hash,
  }));
  const header = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
  ]);
  header.writeUInt32LE(json.length, 14);
  const image = new webpmux.Image();
  await image.load(webp);
  image.exif = Buffer.concat([header, json]);
  return image.save(null);
}
