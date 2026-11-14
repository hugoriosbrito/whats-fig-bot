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
import { checkQuota, checkCooldown, isAdmin, phoneOf, registerUse, removeVip, setVip, vipList } from "./limits.js";
import { imageToSticker, videoToSticker, assertSizeOk, cleanup } from "./sticker.js";
import { hasDatabase, setupDatabase } from "./db.js";
import { useMysqlAuthState } from "./auth-store.js";
import { synthesize, ttsEnabled, TtsError } from "./fish.js";
import { downloadMedia, resolveXMedia, xLinkOf } from "./link.js";
import { prepareVoice, prepareVoiceFromOpus, ttsTextFrom, validateTtsText } from "./voice.js";
import { HELP, menuCategory, menuHome } from "./menu.js";
import { buttonContent } from "./buttons.js";
import { announceBusy, knownPhones, rememberUser, startAnnounce, stopAnnounce } from "./announce.js";
import * as games from "./games.js";
import * as jokes from "./jokes.js";
import * as social from "./social.js";
import { emojiSticker, removeFile, toMp3, toMp4 } from "./media.js";

const log = pino({ level: process.env.LOG_LEVEL || "info" });

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

function cleanName(value) {
  const name = String(value || "").replace(/[\r\n*_`]/g, " ").trim();
  if (!name || /^\d{8,}$/.test(name)) return "";
  return name.slice(0, 40);
}

function mentionInfo(msg) {
  const message = unwrapMessage(msg.message);
  const ctx = message?.extendedTextMessage?.contextInfo;
  const jid = ctx?.mentionedJid?.[0];
  if (!jid) return { jid: "", phone: "", name: "" };
  const phone = jid.endsWith("@lid") ? "" : phoneOf(jid);
  return { jid, phone, name: cleanName(ctx.mentionName || ctx.quotedName) };
}

function phoneFromGroup(group, jid) {
  const meta = groupCache.get(group);
  const found = meta?.participants?.find((person) => person.id === jid || person.lid === jid);
  return phoneOf(found?.phoneNumber || "");
}

async function phoneForJid(sock, jid, group) {
  if (!jid || !jid.endsWith("@lid")) return phoneOf(jid);
  const known = phoneFromGroup(group, jid) || lidPhones.get(jid);
  if (known) return known;
  try {
    const pn = await sock.signalRepository.lidMapping.getPNForLID(jid);
    const phone = phoneOf(pn);
    if (phone) lidPhones.set(jid, phone);
    return phone;
  } catch (error) {
    log.warn({ err: error, jid }, "não achei o telefone desse id");
    return "";
  }
}

async function resolveMention(sock, msg) {
  const mention = mentionInfo(msg);
  if (!mention.jid || mention.phone) return mention;
  const group = msg.key.remoteJid.endsWith("@g.us") ? msg.key.remoteJid : "";
  mention.phone = await phoneForJid(sock, mention.jid, group);
  return mention;
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
  const content = typeof text === "string" ? buttonContent(text) : text;
  await sock.sendMessage(jid, content, quote ? { quoted: quote } : undefined);
}

function replyOf(value) {
  if (!value) return null;
  if (typeof value === "string") return { text: value };
  return value;
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

async function handleLinkSticker(sock, msg, mode, link) {
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

  let media;
  try {
    media = await resolveXMedia(link);
  } catch (error) {
    await sendText(sock, chat, error.message, msg);
    return;
  }
  const isVideo = media.kind !== "photo";
  if (isVideo && media.seconds > config.maxVideoSeconds) {
    await sendText(
      sock,
      chat,
      `Esse vídeo tem ${Math.ceil(media.seconds)}s. O máximo para figurinha animada é ${config.maxVideoSeconds}s.`,
      msg
    );
    return;
  }
  const urls = isVideo ? [media.url] : media.urls;
  const room = quota.limit - quota.used;
  if (urls.length > room) {
    await sendText(
      sock,
      chat,
      `Esse post tem ${urls.length} fotos e você só tem *${room}* figurinha(s) hoje.`,
      msg
    );
    return;
  }

  const { position, run } = enqueue(async () => {
    if (chat.endsWith("@g.us") && !groupCache.has(chat)) {
      groupCache.set(chat, await sock.groupMetadata(chat));
    }
    for (const url of urls) {
      let input;
      let output;
      try {
        input = await downloadMedia(url);
        output = isVideo
          ? await videoToSticker(input, { mode })
          : await imageToSticker(input, { mode });
        const webp = await fs.readFile(output);
        await sock.sendMessage(chat, { sticker: webp }, { quoted: msg });
        const usage = await registerUse(sender);
        log.info({ sender, used: usage.used, video: isVideo, source: "x" }, "figurinha enviada");
      } finally {
        await cleanup(input, output);
      }
    }
  });

  const waiting = position > 1 ? ` Você está na posição ${position} da fila.` : "";
  const what = isVideo ? "o vídeo" : urls.length > 1 ? `as ${urls.length} fotos` : "a foto";
  await sendText(sock, chat, `Baixando ${what} do X e fazendo sua figurinha (${quota.used + 1}/${quota.limit} hoje).${waiting}`, msg);
  try {
    await run;
  } catch (error) {
    log.error({ err: error }, "falha ao criar figurinha do X");
    await sendText(sock, chat, `Não consegui converter: ${error.message}`, msg);
  }
}

async function handleSticker(sock, msg, mode) {
  // Sem modo explícito: foto e link do X cabem inteiros (fit).
  // Vídeo enviado no WhatsApp continua preenchendo (fill).
  const imageMode = mode || "fit";
  const videoMode = mode || "fill";
  const linkMode = mode || "fit";
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
    const link = xLinkOf(extractBody(msg));
    if (link) {
      await handleLinkSticker(sock, msg, linkMode, link);
      return;
    }
    await sendText(sock, chat, `Manda uma foto ou um vídeo com a legenda *!fig*, responde uma mídia com *!fig*, ou manda *!fig* com um link de foto, vídeo ou GIF do X.\n\n${HELP}`, msg);
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
        ? await videoToSticker(input, { mode: videoMode })
        : await imageToSticker(input, { mode: imageMode });
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

function targetPhone(msg, raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits) return digits;
  const message = unwrapMessage(msg.message);
  const ctx = message?.extendedTextMessage?.contextInfo;
  return phoneOf(ctx?.participantAlt || ctx?.participant || "");
}

async function handleAdmin(sock, msg, action, args) {
  const chat = msg.key.remoteJid;
  if (!isAdmin(senderOf(msg))) {
    await sendText(sock, chat, "Só o admin pode mexer nos VIPs.", msg);
    return;
  }

  if (action === "vips") {
    const vips = await vipList();
    if (!vips.length) {
      await sendText(sock, chat, "Nenhum VIP cadastrado.", msg);
      return;
    }
    const lines = vips.map((vip) => `*${vip.phone}* — ${vip.stickerLimit} figurinhas e ${vip.ttsLimit} áudios por dia.`);
    await sendText(sock, chat, lines.join("\n"), msg);
    return;
  }

  const phone = targetPhone(msg, args[0]);
  if (!phone) {
    await sendText(
      sock,
      chat,
      "Responde a mensagem da pessoa ou manda o número.\n*!vip 5511999998888 50* dá 50 figurinhas.\n*!vip 5511999998888 50 30* também muda os áudios.\n*!tirarvip 5511999998888* volta ao limite normal.\n*!vips* lista todo mundo.",
      msg
    );
    return;
  }

  if (action === "tirarvip") {
    const removed = await removeVip(phone);
    await sendText(
      sock,
      chat,
      removed ? `*${phone}* voltou ao limite normal.` : `*${phone}* não estava na lista VIP.`,
      msg
    );
    return;
  }

  const stickerLimit = Number(args[1]);
  if (!Number.isInteger(stickerLimit)) {
    await sendText(sock, chat, "Faltou a quantidade de figurinhas. Exemplo: *!vip 5511999998888 50*.", msg);
    return;
  }
  const saved = await setVip(phone, stickerLimit, args[2]);
  if (!saved) {
    await sendText(sock, chat, "A quantidade precisa ser um número inteiro de 1 a 10000.", msg);
    return;
  }
  await sendText(
    sock,
    chat,
    `*${saved.phone}* agora tem *${saved.stickerLimit}* figurinhas e *${saved.ttsLimit}* áudios por dia.`,
    msg
  );
}

function nameInGroup(jid, phone) {
  const meta = groupCache.get(jid);
  const found = meta?.participants?.find((person) => phoneOf(person.id || person.jid || "") === phone);
  return cleanName(found?.notify || found?.name || found?.verifiedName);
}

function withChat(msg, mention = mentionInfo(msg), senderPhone = "") {
  const group = msg.key.remoteJid.endsWith("@g.us") ? msg.key.remoteJid : "";
  const sender = senderPhone || phoneOf(senderOf(msg));
  return {
    ...msg,
    sender: sender ? `${sender}@s.whatsapp.net` : senderOf(msg),
    name: cleanName(msg.pushName) || nameInGroup(group, sender) || sender,
    group,
    mention: mention.phone || "",
    mentionName: mention.name || nameInGroup(group, mention.phone) || "",
  };
}

async function playGame(sock, msg) {
  const guess = await games.anagramGuess(withChat(msg), extractBody(msg));
  if (guess) await sendText(sock, msg.key.remoteJid, guess, msg);
}

async function spendFig(sock, msg) {
  const sender = senderOf(msg);
  const quota = await checkQuota(sender);
  if (!quota.ok) {
    await sendText(sock, msg.key.remoteJid, `Você usou suas *${quota.used}/${quota.limit}* figurinhas de hoje. Volte amanhã.`, msg);
    return false;
  }
  const pace = await checkCooldown(sender);
  if (!pace.ok) {
    await sendText(sock, msg.key.remoteJid, `Calma aí. Aguarde *${pace.wait}s* antes da próxima.`, msg);
    return false;
  }
  return quota;
}

async function handleAnnounce(sock, msg, text) {
  const chat = msg.key.remoteJid;
  if (!isAdmin(senderOf(msg))) {
    await sendText(sock, chat, "Só o admin anuncia.", msg);
    return;
  }
  if (announceBusy()) {
    await sendText(sock, chat, "Já tem um anúncio em andamento.", msg);
    return;
  }
  const phones = (await knownPhones()).filter((phone) => phone !== phoneOf(senderOf(msg)));
  const started = await startAnnounce({
    adminJid: chat,
    text,
    phones,
    send: async (jid, body) => {
      await sock.sendMessage(jid, { text: body });
      return true;
    },
  });
  if (!started.ok && started.reason === "empty") {
    await sendText(sock, chat, "Manda *!anunciar* e o texto. Vou no privado de quem já usou o bot, em lotes de 5.", msg);
  } else if (!started.ok && started.reason === "long") {
    await sendText(sock, chat, "O texto passa de 500 caracteres.", msg);
  } else if (!started.ok && started.reason === "nobody") {
    await sendText(sock, chat, "Ainda não tenho ninguém na lista. Ela cresce quando as pessoas mandam um comando.", msg);
  }
}

async function quotedFile(sock, msg) {
  const message = unwrapMessage(msg.message);
  const ctx = message?.extendedTextMessage?.contextInfo;
  const quoted = unwrapMessage(ctx?.quotedMessage);
  if (!quoted) return null;
  const kind = quoted.videoMessage ? "video" : quoted.audioMessage ? "audio" : quoted.stickerMessage ? "sticker" : null;
  if (!kind) return null;
  const target = {
    key: { remoteJid: msg.key.remoteJid, id: ctx.stanzaId, participant: ctx.participant, fromMe: false },
    message: quoted,
  };
  const file = await downloadToTemp(sock, target);
  return { file, kind };
}

async function charge(sock, msg) {
  const quota = await spendFig(sock, msg);
  if (!quota) return false;
  await registerUse(msg.sender);
  return true;
}

async function handleFeature(sock, msg, cmd, args, rest, mention) {
  const chat = msg.key.remoteJid;

  if (cmd === "pescar") {
    if (!(await charge(sock, msg))) return true;
    return deliver(sock, msg, await games.fish(msg)), true;
  }
  if (cmd === "pesca") return deliver(sock, msg, await games.fishStatus(msg)), true;
  if (cmd === "pesca-ranking") return deliver(sock, msg, await games.fishRank(msg)), true;
  if (cmd === "slots") {
    if (!(await charge(sock, msg))) return true;
    return deliver(sock, msg, await games.slots(msg, args[0])), true;
  }
  if (cmd === "slots-ranking") return deliver(sock, msg, await games.slotsRank(msg)), true;
  if (cmd === "roleta") {
    if (!(await charge(sock, msg))) return true;
    return deliver(sock, msg, await games.roulette(msg)), true;
  }
  if (cmd === "roleta-ranking") return deliver(sock, msg, await games.rouletteRank(msg)), true;
  if (cmd === "anagrama") {
    if (!(await charge(sock, msg))) return true;
    return deliver(sock, msg, games.anagramStart(msg)), true;
  }
  if (cmd === "anagrama-dica") return deliver(sock, msg, games.anagramHint(msg)), true;
  if (cmd === "anagrama-parar") return deliver(sock, msg, games.anagramStop(msg)), true;
  if (cmd === "anagrama-ranking") return deliver(sock, msg, await games.anagramRank(msg)), true;
  if (cmd === "stop") {
    if (!(await charge(sock, msg))) return true;
    const started = games.stopStart(msg);
    await deliver(sock, msg, started.text || started);
    if (started.game) setTimeout(async () => {
      const live = games.takeStop(started.group);
      if (!live) return;
      const text = await games.finishStop(live, started.group);
      await sendText(sock, started.group, text);
    }, 90_000);
    return true;
  }
  if (cmd === "stop-resp") {
    if (!(await charge(sock, msg))) return true;
    return deliver(sock, msg, await games.stopAnswer(msg, rest)), true;
  }
  if (cmd === "stop-fim") {
    const ended = games.stopEnd(msg);
    if (!ended) return deliver(sock, msg, "Não tem stop neste grupo."), true;
    if (ended.text) return deliver(sock, msg, ended.text), true;
    return deliver(sock, msg, await games.finishStop(ended.game, ended.group)), true;
  }
  if (cmd === "stop-ranking") return deliver(sock, msg, await games.stopRank(msg)), true;

  if (cmd === "namorar") return deliver(sock, msg, await social.namorar(msg, mention)), true;
  if (cmd === "casar") return deliver(sock, msg, await social.casar(msg, mention)), true;
  if (cmd === "separar") return deliver(sock, msg, await social.separar(msg)), true;
  if (cmd === "recusar") return deliver(sock, msg, await social.recusar(msg)), true;
  if (cmd === "celibar") return deliver(sock, msg, await social.celibar(msg)), true;
  if (cmd === "coisar") return deliver(sock, msg, await social.coisar(msg, mention)), true;
  if (cmd === "trair") return deliver(sock, msg, await social.trair(msg, mention)), true;
  if (cmd === "relacionamento") return deliver(sock, msg, await social.ficha(msg)), true;
  if (cmd === "relacionamentos") return deliver(sock, msg, await social.lista(msg)), true;

  if (cmd === "biscoito") return deliver(sock, msg, jokes.biscoito()), true;
  if (cmd === "cantada") return deliver(sock, msg, jokes.cantada(msg, mention)), true;
  if (cmd === "violencia" || cmd === "violência") return deliver(sock, msg, jokes.violencia()), true;
  if (cmd === "morreu") return deliver(sock, msg, jokes.morreu()), true;
  if (cmd === "presente") return deliver(sock, msg, jokes.presente()), true;
  if (cmd === "pix") return deliver(sock, msg, jokes.pix(msg, mention)), true;
  if (cmd === "boleto") return deliver(sock, msg, jokes.boleto(msg)), true;
  if (cmd === "pagar") return deliver(sock, msg, jokes.pagar()), true;
  if (cmd === "aniversario" || cmd === "aniversário") return deliver(sock, msg, jokes.aniversario(msg, mention)), true;
  if (cmd === "pecar") return deliver(sock, msg, await jokes.pecar(msg)), true;
  if (cmd === "meus-pecados") return deliver(sock, msg, await jokes.meusPecados(msg)), true;
  if (cmd === "genshin") return deliver(sock, msg, jokes.genshin()), true;
  if (cmd === "hora" || cmd === "data") return deliver(sock, msg, jokes.hora()), true;
  if (cmd === "pinto") return deliver(sock, msg, await jokes.pinto(msg, mention)), true;
  if (cmd === "pinto-ranking") return deliver(sock, msg, await jokes.pintoRank(msg)), true;
  if (cmd === "pinto-reset") return deliver(sock, msg, await jokes.pintoReset(msg)), true;
  if (cmd === "peito" || cmd === "bunda") return deliver(sock, msg, await jokes.body(msg, mention, cmd)), true;
  if (cmd === "peito-ranking" || cmd === "bunda-ranking") return deliver(sock, msg, await jokes.bodyRank(msg, cmd.replace("-ranking", ""))), true;
  if (cmd === "peito-reset" || cmd === "bunda-reset") return deliver(sock, msg, await jokes.bodyReset(msg, cmd.replace("-reset", ""))), true;

  if (cmd === "emoji") {
    const glyphs = [...rest].filter((char) => /\p{Extended_Pictographic}/u.test(char));
    if (glyphs.length < 2) {
      await sendText(sock, chat, "Manda dois emojis: *!emoji* 😀 🔥", msg);
      return true;
    }
    const quota = await spendFig(sock, msg);
    if (!quota) return true;
    const { position, run } = enqueue(async () => {
      const webp = await emojiSticker(glyphs[0], glyphs[1]);
      await sock.sendMessage(chat, { sticker: webp }, { quoted: msg });
      await registerUse(msg.sender);
    });
    const waiting = position > 1 ? ` Você está na posição ${position} da fila.` : "";
    await sendText(sock, chat, `Juntando os emojis (${quota.used + 1}/${quota.limit} hoje).${waiting}`, msg);
    try {
      await run;
    } catch (error) {
      await sendText(sock, chat, `Não consegui fazer a figurinha: ${error.message}`, msg);
    }
    return true;
  }

  if (cmd === "tomp3" || cmd === "tomp4") {
    const quota = await spendFig(sock, msg);
    if (!quota) return true;
    const quoted = await quotedFile(sock, msg);
    if (!quoted) {
      await sendText(sock, chat, cmd === "tomp3" ? "Responde um vídeo ou áudio com *!tomp3*." : "Responde uma figurinha animada ou GIF com *!tomp4*.", msg);
      return true;
    }
    const { position, run } = enqueue(async () => {
      const out = cmd === "tomp3" ? await toMp3(quoted.file) : await toMp4(quoted.file);
      const data = await fs.readFile(out);
      if (cmd === "tomp3") await sock.sendMessage(chat, { audio: data, mimetype: "audio/mpeg" }, { quoted: msg });
      else await sock.sendMessage(chat, { video: data, mimetype: "video/mp4" }, { quoted: msg });
      await registerUse(msg.sender);
      await removeFile(quoted.file);
      await removeFile(out);
    });
    const waiting = position > 1 ? ` Você está na posição ${position} da fila.` : "";
    await sendText(sock, chat, `Convertendo (${quota.used + 1}/${quota.limit} hoje).${waiting}`, msg);
    try {
      await run;
    } catch (error) {
      await removeFile(quoted.file);
      await sendText(sock, chat, error.message, msg);
    }
    return true;
  }

  return false;
}

async function deliver(sock, msg, result) {
  const reply = replyOf(result);
  if (!reply?.text) return;
  await sendText(sock, msg.key.remoteJid, reply.text, msg);
}

async function handleIncoming(sock, msg) {
  try {
    if (!msg.message || msg.key.fromMe || msg.key.remoteJid === "status@broadcast") return;
    const chat = msg.key.remoteJid;
    const body = extractBody(msg);
    const parsed = parseCommand(body);
    if (!parsed) {
      await playGame(sock, msg);
      return;
    }

    const { cmd, args, rest } = parsed;
    if (chat.endsWith("@g.us") && !groupCache.has(chat)) {
      try {
        groupCache.set(chat, await sock.groupMetadata(chat));
      } catch {
        /* sem a lista, a mensagem segue com o nome de quem enviou */
      }
    }
    const resolved = await resolveMention(sock, msg);
    const senderPhone = await phoneForJid(sock, senderOf(msg), chat.endsWith("@g.us") ? chat : "");
    const view = withChat(msg, resolved, senderPhone);
    const mention = resolved.phone;
    if (resolved.jid && !mention && ["namorar", "casar", "trair", "pix", "aniversario", "aniversário", "pinto", "cantada"].includes(cmd)) {
      await sendText(sock, chat, "Não consegui identificar o telefone dessa marcação. Pede de novo marcando a pessoa.", msg);
      return;
    }
    await rememberUser(view.sender);
    const admin = isAdmin(senderOf(msg));

    if (["menu", "start", "oi", "ola", "olá"].includes(cmd)) {
      const home = args[0] ? menuCategory(args[0], admin) : menuHome(admin);
      if (!home) {
        await sendText(sock, chat, "Não achei essa categoria. Manda *!menu*.", msg);
        return;
      }
      await sendText(sock, chat, home.text, msg);
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
      const mode = ["fit", "fill", "stretch", "top", "bottom"].includes(requested) ? requested : null;
      await handleSticker(sock, msg, mode);
    } else if (["tts", "fala", "voz", "audio", "áudio"].includes(cmd)) {
      await handleVoice(sock, msg, ttsTextFrom([rest]));
    } else if ("123456".includes(cmd) && cmd.length === 1) {
      const page = menuCategory(cmd, admin);
      await sendText(sock, chat, page.text, msg);
    } else if (["vip", "tirarvip", "vips"].includes(cmd)) {
      await handleAdmin(sock, msg, cmd, args);
    } else if (cmd === "anunciar") {
      await handleAnnounce(sock, msg, rest);
    } else if (cmd === "anunciar-parar") {
      if (!admin) {
        await sendText(sock, chat, "Só o admin para um anúncio.", msg);
        return;
      }
      const stopped = await stopAnnounce();
      await sendText(sock, chat, stopped ? "Vou parar o anúncio depois da mensagem que já está saindo." : "Não tem anúncio em andamento.", msg);
    } else if (await handleFeature(sock, view, cmd, args, rest, mention)) {
      /* o handler já respondeu */
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
const lidPhones = new Map();

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
  sock.ev.on("lid-mapping.update", (mappings) => {
    for (const mapping of mappings || []) {
      if (mapping.lid && mapping.pn) lidPhones.set(mapping.lid, phoneOf(mapping.pn));
    }
  });
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
