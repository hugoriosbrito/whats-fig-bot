import { createHash, createHmac } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { proto } from "@whiskeysockets/baileys";
import { encryptedStream, getMediaKeys } from "@whiskeysockets/baileys/lib/Utils/messages-media.js";
import { unixTimestampSeconds } from "@whiskeysockets/baileys/lib/Utils/generics.js";
import webpmux from "node-webpmux";

const CHUNK = 64 * 1024;
const MAC_LENGTH = 10;

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
let encoderInstalled = false;

export function rememberSound(message, audio) {
  if (!message?.stickerMessage || !audio) return;
  message[SOUND] = audio;
}

function fieldVarint(field, value) {
  const bytes = [];
  let rest = value;
  do {
    let next = rest & 127;
    rest = Math.floor(rest / 128);
    if (rest) next |= 128;
    bytes.push(next);
  } while (rest);
  return Buffer.concat([varint((field << 3) | 0), Buffer.from(bytes)]);
}

function fieldBytes(field, bytes) {
  return Buffer.concat([varint((field << 3) | 2), varint(bytes.length), Buffer.from(bytes)]);
}

function varint(value) {
  const bytes = [];
  let rest = value;
  do {
    let next = rest & 127;
    rest = Math.floor(rest / 128);
    if (rest) next |= 128;
    bytes.push(next);
  } while (rest);
  return Buffer.from(bytes);
}

// O WhatsApp não deixa o áudio no stickerMessage da raiz. A figurinha com som
// vai no campo 134, e o campo 24 dentro dela é 0. Isso foi conferido enviando
// e tocando no celular: https://github.com/WhiskeySockets/Baileys/issues/2932
export function installSoundStickerEncoder() {
  if (encoderInstalled) return;
  encoderInstalled = true;
  const original = proto.Message.encode;
  proto.Message.encode = function encodeSoundSticker(message, writer) {
    const audio = message?.[SOUND];
    const sticker = message?.stickerMessage;
    if (!audio || !sticker) return original.call(this, message, writer);
    message.stickerMessage = null;
    try {
      const encoded = original.call(this, message, writer);
      const stickerBytes = Buffer.concat([
        proto.Message.StickerMessage.encode(sticker).finish(),
        fieldVarint(24, 0),
        fieldBytes(26, proto.Message.AudioMessage.encode(audio).finish()),
      ]);
      const wrapped = fieldBytes(1, fieldBytes(26, stickerBytes));
      encoded.uint32((134 << 3) | 2).bytes(wrapped);
      return encoded;
    } finally {
      message.stickerMessage = sticker;
    }
  };
}

installSoundStickerEncoder();

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
