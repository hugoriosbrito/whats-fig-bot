import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { checkQuota, checkCooldown, registerUse } from "./limits.js";
import { imageToSticker, videoToSticker, assertSizeOk, cleanup } from "./sticker.js";
import { hasDatabase, setupDatabase } from "./db.js";
import { useMysqlAuthState } from "./auth-store.js";
import { synthesize, ttsEnabled, TtsError } from "./fish.js";
import { prepareVoice, prepareVoiceFromOpus, ttsTextFrom, validateTtsText } from "./voice.js";

const log = pino({ level: process.env.LOG_LEVEL || "info" });

const MENU = `*FigBot* — escolha uma opção:

*1* Criar figurinha
Mande uma foto ou um vídeo com a legenda *!fig*.
Também vale responder a mídia com *!fig*.

*2* Meus limites
Mande *!resto* para ver quantas restam hoje.
O máximo é ${config.dailyLimit} por dia.

*3* Ajuda
Mande *!ajuda*.

*4* Falar um texto
Mande *!tts* e o texto. Exemplo: *!tts bom dia a todos*.`;

const HELP = `Como funciona:

- Foto com *!fig* vira figurinha 512x512.
- Vídeo de até ${config.maxVideoSeconds}s com *!fig* vira figurinha animada.
- *!fig fill* preenche e *!fig stretch* estica.
- Cada número tem ${config.dailyLimit} figurinhas por dia e ${config.cooldownSeconds}s entre cada uma.
- *!tts seu texto* vira uma mensagem de voz (até ${config.ttsMaxChars} caracteres).
- Cada número tem ${config.ttsDailyLimit} áudios por dia e ${config.ttsCooldownSeconds}s entre cada um.
- Funciona no privado e no grupo. Sem comando, eu fico quieto.`;

function unwrapMessage(message) {
  return (
    message?.ephemeralMessage?.message ||
    message?.viewOnceMessage?.message ||
    message?.viewOnceMessageV2?.message ||
    message?.documentWithCaptionMessage?.message ||
    message
  );
}

function extractBody(msg) {
  const message = unwrapMessage(msg.message);
  return (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    ""
  ).trim();
}

function parseCommand(body) {
  if (!body.startsWith(config.prefix)) return null;
  const raw = body.slice(config.prefix.length);
  const [cmd, ...args] = raw.trim().split(/\s+/);
  // Texto original depois do comando, com quebras de linha preservadas
  const rest = raw.trim().slice(cmd.length).replace(/^\s+/, "");
  return { cmd: (cmd || "").toLowerCase(), args, rest };
}

function senderOf(msg) {
  return msg.key.participantAlt || msg.key.participant || msg.key.remoteJidAlt || msg.key.remoteJid;
}

function quotedMedia(msg) {
  const message = unwrapMessage(msg.message);
  const ctx =
    message?.extendedTextMessage?.contextInfo ||
    message?.imageMessage?.contextInfo ||
    message?.videoMessage?.contextInfo;
  const quotedMessage = unwrapMessage(ctx?.quotedMessage);
  if (!quotedMessage) return null;
  if (quotedMessage.imageMessage) return { type: "image", quotedMessage, ctx };
  if (quotedMessage.videoMessage) return { type: "video", quotedMessage, ctx };
  return null;
}

async function sendText(sock, jid, text, quote) {
  await new Promise((resolve) => setTimeout(resolve, 800));
  await sock.sendMessage(jid, { text }, quote ? { quoted: quote } : undefined);
}

async function downloadToTemp(sock, target) {
  const tmp = path.join(os.tmpdir(), `in-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const buf = await downloadMediaMessage(target, "buffer", {}, {
    logger: log,
    reuploadRequest: (media) => sock.updateMediaMessage(media),
  });
  assertSizeOk(buf.length);
  await fs.writeFile(tmp, buf);
  return tmp;
}

let queue = Promise.resolve();
let queueSize = 0;

function enqueue(task) {
  const position = queueSize + 1;
  queueSize += 1;
  let rejectRun;
  const run = new Promise((resolve, reject) => {
    rejectRun = reject;
    queue = queue.then(task).then(resolve, reject);
  });
  queue = queue.catch(() => {}).finally(() => {
    queueSize -= 1;
  });
  run.cancel = rejectRun;
  return { position, run };
}

async function handleSticker(sock, msg, mode) {
  const chat = msg.key.remoteJid;
  const sender = senderOf(msg);
  const quota = await checkQuota(sender);
  if (!quota.ok) {
    await sendText(sock, chat, `Você usou suas *${quota.used}/${quota.limit}* figurinhas de hoje. Volte amanhã.`, msg);
    return;
  }
  const pace = await checkCooldown(sender);
  if (!pace.ok) {
    await sendText(sock, chat, `Calma aí. Aguarde *${pace.wait}s* antes da próxima.`, msg);
    return;
  }

  const message = unwrapMessage(msg.message);
  const directImage = message?.imageMessage;
  const directVideo = message?.videoMessage;
  const quoted = quotedMedia(msg);
  let target = null;
  let isVideo = Boolean(directVideo);

  if (directImage || directVideo) {
    target = { ...msg, message };
  } else if (quoted) {
    isVideo = quoted.type === "video";
    target = {
      key: {
        remoteJid: chat,
        id: quoted.ctx?.stanzaId,
        participant: quoted.ctx?.participant,
        fromMe: false,
      },
      message: quoted.quotedMessage,
    };
  }

  if (!target) {
    await sendText(sock, chat, `Manda uma foto ou um vídeo com a legenda *!fig*, ou responde uma mídia com *!fig*.\n\n${HELP}`, msg);
    return;
  }

  const seconds = Number(directVideo?.seconds || quoted?.quotedMessage?.videoMessage?.seconds || 0);
  if (isVideo && seconds > config.maxVideoSeconds) {
    await sendText(sock, chat, `Esse vídeo tem ${seconds}s. O máximo para figurinha animada é ${config.maxVideoSeconds}s.`, msg);
    return;
  }

  const { position, run } = enqueue(async () => {
    let input;
    let output;
    try {
      input = await downloadToTemp(sock, target);
      output = isVideo
        ? await videoToSticker(input, { mode })
        : await imageToSticker(input, { mode });
      const webp = await fs.readFile(output);
      if (chat.endsWith("@g.us") && !groupCache.has(chat)) {
        groupCache.set(chat, await sock.groupMetadata(chat));
      }
      await sock.sendMessage(chat, { sticker: webp }, { quoted: msg });
      const usage = await registerUse(sender);
      log.info({ sender, used: usage.used, video: isVideo }, "figurinha enviada");
    } finally {
      await cleanup(input, output);
    }
  });

  const waiting = position > 1 ? ` Você está na posição ${position} da fila.` : "";
  await sendText(sock, chat, `Fazendo sua figurinha (${quota.used + 1}/${quota.limit} hoje).${waiting}`, msg);
  try {
    await run;
  } catch (error) {
    log.error({ err: error }, "falha ao criar figurinha");
    await sendText(sock, chat, `Não consegui converter: ${error.message}`, msg);
  }
}

// Gera o áudio no formato do WhatsApp. O caminho normal é MP3 + FFmpeg;
// sem FFmpeg no servidor, pede Opus direto à Fish Audio.
let ffmpegMissing = false;

async function speak(text) {
  if (!ffmpegMissing) {
    try {
      const { audio: mp3 } = await synthesize(text, { format: "mp3" });
      return await prepareVoice(mp3);
    } catch (error) {
      if (!/FFmpeg/.test(error.message)) throw error;
      ffmpegMissing = true;
      log.warn("FFmpeg indisponível; usando o Opus nativo da Fish Audio.");
    }
  }
  const { audio: opus } = await synthesize(text, { format: "opus" });
  return prepareVoiceFromOpus(opus);
}

async function handleVoice(sock, msg, text) {
  const chat = msg.key.remoteJid;
  const sender = senderOf(msg);

  if (!ttsEnabled()) {
    await sendText(sock, chat, "O comando de voz está desligado: falta configurar *FISH_API_KEY* no servidor.", msg);
    return;
  }

  const check = validateTtsText(text);
  if (!check.ok) {
    await sendText(sock, chat, check.message, msg);
    return;
  }

  const quota = await checkQuota(sender, "tts");
  if (!quota.ok) {
    await sendText(sock, chat, `Você usou seus *${quota.used}/${quota.limit}* mensagens de voz de hoje. Volte amanhã.`, msg);
    return;
  }
  const pace = await checkCooldown(sender, "tts");
  if (!pace.ok) {
    await sendText(sock, chat, `Calma aí. Aguarde *${pace.wait}s* antes da próxima.`, msg);
    return;
  }

  // Entra na mesma fila das figurinhas: o servidor tem pouca CPU e RAM.
  const { position, run } = enqueue(async () => {
    const started = Date.now();
    const { audio, seconds } = await speak(text);
    await sock.sendMessage(chat, { audio, ptt: true, mimetype: "audio/ogg; codecs=opus", seconds }, { quoted: msg });
    const usage = await registerUse(sender, "tts");
    log.info(
      { sender, chars: text.length, seconds, used: usage.used, ms: Date.now() - started },
      "mensagem de voz enviada"
    );
  });

  const waiting = position > 1 ? ` Você está na posição ${position} da fila.` : "";
  await sendText(sock, chat, `Gravando seu áudio (${quota.used + 1}/${quota.limit} hoje).${waiting}`, msg);
  try {
    await run;
  } catch (error) {
    log.error({ err: error }, "falha ao gerar áudio");
    const friendly =
      error instanceof TtsError && error.reason === "disabled"
        ? "O comando de voz está desligado: falta configurar *FISH_API_KEY* no servidor."
        : error.message;
    await sendText(sock, chat, `Não consegui gerar o áudio: ${friendly}`, msg);
  }
}

async function handleIncoming(sock, msg) {
  try {
    if (!msg.message || msg.key.fromMe || msg.key.remoteJid === "status@broadcast") return;
    const chat = msg.key.remoteJid;
    const parsed = parseCommand(extractBody(msg));
    if (!parsed) return;

    const { cmd, args, rest } = parsed;
    if (["menu", "start", "oi", "ola", "olá"].includes(cmd)) {
      await sendText(sock, chat, MENU, msg);
    } else if (cmd === "ajuda" || cmd === "help") {
      await sendText(sock, chat, HELP, msg);
    } else if (["resto", "limite", "cota"].includes(cmd)) {
      const sticker = await checkQuota(senderOf(msg), "fig");
      const voice = await checkQuota(senderOf(msg), "tts");
      const stickerLine = sticker.ok
        ? `Figurinhas: restam *${sticker.limit - sticker.used}* de ${sticker.limit}.`
        : `Figurinhas: limite de hoje atingido (${sticker.used}/${sticker.limit}).`;
      const voiceLine = voice.ok
        ? `Áudios: restam *${voice.limit - voice.used}* de ${voice.limit}.`
        : `Áudios: limite de hoje atingido (${voice.used}/${voice.limit}).`;
      await sendText(sock, chat, `${stickerLine}\n${voiceLine}`, msg);
    } else if (["fig", "s", "sticker"].includes(cmd)) {
      const requested = (args[0] || "").toLowerCase();
      const mode = ["fit", "fill", "stretch"].includes(requested) ? requested : "fill";
      await handleSticker(sock, msg, mode);
    } else if (["tts", "fala", "voz", "audio", "áudio"].includes(cmd)) {
      await handleVoice(sock, msg, ttsTextFrom([rest]));
    } else if (cmd === "1") {
      await sendText(sock, chat, "Beleza. Manda a foto ou o vídeo com a legenda *!fig*.", msg);
    } else if (cmd === "2") {
      const sticker = await checkQuota(senderOf(msg), "fig");
      const voice = await checkQuota(senderOf(msg), "tts");
      await sendText(
        sock,
        chat,
        `Figurinhas: *${sticker.used || 0}/${sticker.limit}* hoje.\nÁudios: *${voice.used || 0}/${voice.limit}* hoje.`,
        msg
      );
    } else if (cmd === "3") {
      await sendText(sock, chat, HELP, msg);
    } else if (cmd === "4") {
      await sendText(sock, chat, `Manda *!tts* e o texto. Exemplo: *!tts bom dia a todos*.`, msg);
    }
  } catch (error) {
    log.error({ err: error }, "erro ao processar mensagem");
  }
}

let activeSock;
let reconnectTimer;
let reconnectDelay = 15000;
let starting = false;
const groupCache = new Map();

async function start() {
  if (starting) return;
  starting = true;
  clearTimeout(reconnectTimer);
  try {
  activeSock?.end(undefined);
  const auth = hasDatabase()
    ? await useMysqlAuthState()
    : await useMultiFileAuthState(config.sessionDir);
  const { state, saveCreds } = auth;
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    cachedGroupMetadata: async (jid) => groupCache.get(jid),
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 20000,
    shouldSyncHistoryMessage: () => false,
  });
  activeSock = sock;
  sock.ev.on("groups.update", (updates) => {
    for (const update of updates) {
      if (update.id && update.participants) groupCache.set(update.id, update);
    }
  });
  sock.ev.on("group-participants.update", ({ id }) => groupCache.delete(id));

  let credsTimer;
  sock.ev.on("creds.update", () => {
    clearTimeout(credsTimer);
    credsTimer = setTimeout(() => {
      saveCreds().catch((error) => log.error({ err: error }, "falha temporária ao salvar a sessão"));
    }, 3000);
  });
  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrcode.generate(qr, { small: true });
      log.info("Escaneie o QR acima com o WhatsApp, em Aparelhos conectados.");
    }
    if (connection === "open") {
      reconnectDelay = 15000;
      log.info("Conectado ao WhatsApp.");
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      log.warn({ code }, shouldReconnect ? "Conexão caiu. Reconectando." : "Sessão deslogada. Apague session/ e pareie de novo.");
      if (shouldReconnect && sock === activeSock) {
        reconnectTimer = setTimeout(start, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 120000);
      }
    }
  });
  sock.ev.on("messages.upsert", ({ messages }) => {
    if (sock !== activeSock) return;
    for (const message of messages) handleIncoming(sock, message);
  });
  log.info("FigBot iniciado. Aguardando conexão.");
  } finally {
    starting = false;
  }
}

process.on("unhandledRejection", (error) => log.error({ err: error }, "falha isolada"));

async function run() {
  try {
    await start();
  } catch (error) {
    log.error({ err: error }, "falha ao iniciar; tentando novamente");
    setTimeout(run, 5000);
  }
}

run();
