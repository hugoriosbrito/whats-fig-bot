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
import { imageToSticker, assertSizeOk, cleanup } from "./sticker.js";

const log = pino({ level: process.env.LOG_LEVEL || "info" });

// Como usar (o bot explica isso no !menu):
//  â€¢ Envie uma FOTO com a legenda "!fig" â†’ vira figurinha na hora
//  â€¢ Responda uma foto/vÃ­deo com "!fig" â†’ vira figurinha
//  â€¢ "!menu" â†’ mostra as opÃ§Ãµes | "!ajuda" â†’ como funciona | "!resto" â†’ sua cota de hoje
const MENU = `ðŸ¤– *FigBot* â€” escolha uma opÃ§Ã£o:

1ï¸âƒ£ *Criar figurinha*
Envie uma foto com a legenda *!fig*
(ou responda uma foto/vÃ­deo com *!fig*)

2ï¸âƒ£ *Meus limites*
Envie *!resto* para ver quantas figurinhas
restam hoje (mÃ¡x. ${config.dailyLimit}/dia)

3ï¸âƒ£ *Ajuda*
Envie *!ajuda*

ðŸ“Œ Dica: no modo 1 Ã© sÃ³ mandar a foto com *!fig* na legenda!`;

const HELP = `â“ *Como funciona:*

â€¢ Mande uma *foto* com a legenda *!fig* â†’ vira figurinha 512x512
â€¢ Ou *responda* uma foto/vÃ­deo curto (atÃ© ${config.maxVideoSeconds}s) com *!fig*
â€¢ Modos de corte: *!fig*, *!fig fill* (preenche), *!fig stretch* (esticada)
â€¢ Limite: *${config.dailyLimit} figurinhas por dia* por pessoa + pausa de ${config.cooldownSeconds}s entre cada uma (proteÃ§Ã£o anti-ban)
â€¢ SÃ³ respondo no privado e em menÃ§Ãµes em grupo (nÃ£o floodo grupo)`;

function extractBody(msg) {
  // Texto da mensagem (conversa simples, legenda de mÃ­dia ou resposta)
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    ""
  ).trim();
}

function parseCommand(body) {
  // "!fig fill" -> { cmd: "fig", args: ["fill"] }
  if (!body.startsWith(config.prefix)) return null;
  const [raw, ...args] = body.slice(config.prefix.length).trim().split(/\s+/);
  return { cmd: (raw || "").toLowerCase(), args };
}

function senderOf(msg) {
  // Em grupo, participant Ã© quem enviou; no privado, remoteJid Ã© a pessoa
  return msg.key.participant || msg.key.remoteJid;
}

function isGroup(jid) {
  return String(jid || "").endsWith("@g.us");
}

function botMentioned(msg, botJid) {
  // Em grupo, sÃ³ responde se mencionarem o bot (evita flood â†’ anti-ban)
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  return Boolean(ctx?.mentionedJid?.includes(botJid));
}

// Mensagem citada que contÃ©m mÃ­dia (responder foto/vÃ­deo com !fig).
// Retorna a mensagem citada COMPLETA + contexto (stanzaId/participant),
// que o Baileys precisa para baixar a mÃ­dia citada.
function quotedMedia(msg) {
  const ctx =
    msg.message?.extendedTextMessage?.contextInfo ||
    msg.message?.imageMessage?.contextInfo ||
    msg.message?.videoMessage?.contextInfo;
  const quotedMessage = ctx?.quotedMessage;
  if (!quotedMessage) return null;
  if (quotedMessage.imageMessage) return { type: "image", quotedMessage, ctx };
  if (quotedMessage.videoMessage) return { type: "video", quotedMessage, ctx };
  return null;
}

async function sendText(sock, jid, text, quote) {
  // Pequena pausa antes de responder: ritmo humano reduz risco de ban
  await new Promise((r) => setTimeout(r, 800));
  await sock.sendMessage(jid, { text }, quote ? { quoted: quote } : undefined);
}

// Baixa a mÃ­dia e salva direto em disco. O buffer Ã© transitÃ³rio e limitado
// a config.maxMediaMB â€” seguro nos 256MB do free tier.
async function downloadToTemp(sock, target) {
  const tmp = path.join(os.tmpdir(), `in-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const buf = await downloadMediaMessage(target, "buffer", {}, {
    logger: log,
    reuploadRequest: (m) => sock.updateMediaMessage(m),
  });
  assertSizeOk(buf.length); // aborta se passar do limite
  await fs.writeFile(tmp, buf);
  return tmp;
}

async function handleSticker(sock, msg, mode) {
  const chat = msg.key.remoteJid;
  const sender = senderOf(msg);

  // 1. Cota diÃ¡ria e intervalo mÃ­nimo, por pessoa.
  const quota = await checkQuota(sender);
  if (!quota.ok) {
    await sendText(
      sock, chat,
      `ðŸš« VocÃª usou suas *${quota.used}/${quota.limit}* figurinhas de hoje. Volte amanhÃ£! ðŸ‘`,
      msg
    );
    return;
  }
  const pace = await checkCooldown(sender);
  if (!pace.ok) {
    await sendText(sock, chat, `â³ Calma aÃ­! Aguarde *${pace.wait}s* antes da prÃ³xima.`, msg);
    return;
  }

  // 2. Descobre a mÃ­dia: anexada na mensagem ou citada (resposta).
  // Para citada, remontamos uma mensagem com stanzaId/participant,
  // que o Baileys exige para localizar e baixar a mÃ­dia original.
  const directImage = msg.message?.imageMessage;
  const directVideo = msg.message?.videoMessage;
  const quoted = quotedMedia(msg);

  let target = null; // o que serÃ¡ baixado
  let isVideo = Boolean(directVideo);
  if (directImage || directVideo) {
    target = msg;
  } else if (quoted) {
    isVideo = quoted.type === "video";
    target = {
      key: {
        remoteJid: chat,
        id: quoted.ctx?.stanzaId,
        participant: quoted.ctx?.participant, // sÃ³ existe em grupo
        fromMe: false,
      },
      message: quoted.quotedMessage,
    };
  }

  if (!target) {
    await sendText(
      sock, chat,
      `ðŸ“Ž Envie uma *foto com a legenda !fig* ou *responda* uma foto/vÃ­deo com *!fig*.\n\n${HELP}`,
      msg
    );
    return;
  }

  if (isVideo) {
    // VÃ­deo animado precisa de ffmpeg â€” fora do escopo leve. Oferece o caminho simples.
    await sendText(
      sock, chat,
      `ðŸŽ¬ Por enquanto converto sÃ³ *fotos*. Me manda a foto (ou um print do vÃ­deo) com a legenda *!fig* que eu faÃ§o! ðŸ‘`,
      msg
    );
    return;
  }

  // 3. Converte e envia
  let input, output;
  try {
    await sendText(sock, chat, `âœ¨ Fazendo sua figurinha... (${quota.used + 1}/${quota.limit} hoje)`, msg);
    input = await downloadToTemp(sock, target);
    output = await imageToSticker(input, { mode });
    const webp = await fs.readFile(output);
    await sock.sendMessage(chat, { sticker: webp }, { quoted: msg });
    const usage = await registerUse(sender);
    log.info({ sender, used: usage.used }, "figurinha enviada");
  } catch (err) {
    log.error({ err }, "falha ao criar figurinha");
    await sendText(sock, chat, `ðŸ˜• NÃ£o consegui converter: ${err.message}`, msg);
  } finally {
    await cleanup(input, output);
  }
}

async function handleIncoming(sock, msg, botJid) {
  try {
    if (!msg.message || msg.key.fromMe) return; // ignora prÃ³prias mensagens e status

    const chat = msg.key.remoteJid;
    const body = extractBody(msg);
    const parsed = parseCommand(body);

    // Sem comando: sÃ³ reage se for foto com legenda vazia? NÃ£o â€” fica quieto (anti-ban).
    if (!parsed) return;

    // Em grupo, sÃ³ obedece com menÃ§Ã£o ao bot (evita o bot floodar o grupo)
    if (isGroup(chat) && !botMentioned(msg, botJid)) return;

    const { cmd, args } = parsed;

    if (cmd === "menu" || cmd === "start" || cmd === "oi" || cmd === "ola" || cmd === "olÃ¡") {
      await sendText(sock, chat, MENU, msg);
    } else if (cmd === "ajuda" || cmd === "help") {
      await sendText(sock, chat, HELP, msg);
    } else if (cmd === "resto" || cmd === "limite" || cmd === "cota") {
      const q = await checkQuota(senderOf(msg));
      await sendText(
        sock, chat,
        q.ok
          ? `ðŸŽŸï¸ VocÃª usou *${q.used}/${q.limit}* hoje. Restam *${q.limit - q.used}*.`
          : `ðŸš« Limite de hoje atingido: *${q.used}/${q.limit}*. Volte amanhÃ£! ðŸ‘`,
        msg
      );
    } else if (cmd === "fig" || cmd === "s" || cmd === "sticker") {
      const mode = ["fill", "stretch"].includes((args[0] || "").toLowerCase())
        ? args[0].toLowerCase()
        : "fit";
      await handleSticker(sock, msg, mode);
    } else if (cmd === "1") {
      await sendText(sock, chat, `1ï¸âƒ£ Beleza! Envie a *foto com a legenda !fig* que eu converto. ðŸ“¸`, msg);
    } else if (cmd === "2") {
      const q = await checkQuota(senderOf(msg));
      await sendText(sock, chat, `2ï¸âƒ£ Sua cota: *${q.used || 0}/${q.limit}* usadas hoje.`, msg);
    } else if (cmd === "3") {
      await sendText(sock, chat, HELP, msg);
    }
    // Comando desconhecido: silÃªncio (nÃ£o polui o chat, nÃ£o gasta cota)
  } catch (err) {
    log.error({ err }, "erro ao processar mensagem");
  }
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(config.sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }), // Baileys verboso desligado (economiza CPU/log no free tier)
    printQRInTerminal: false,
    // Sem cache de grupo em memÃ³ria: economiza RAM no servidor pequeno
    cachedGroupMetadata: async () => undefined,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      // QR aparece no log do painel sillydev â†’ escaneie com o WhatsApp para parear
      qrcode.generate(qr, { small: true });
      log.info("Escaneie o QR acima com o WhatsApp (Aparelhos conectados)");
    }
    if (connection === "open") log.info("âœ… Conectado ao WhatsApp!");
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      log.warn({ code }, shouldReconnect ? "ConexÃ£o caiu, reconectando..." : "SessÃ£o deslogada. Apague session/ e pareie de novo.");
      if (shouldReconnect) setTimeout(start, 5_000);
    }
  });

  // Registra o handler UMA vez por conexÃ£o (sem duplicar em reconnect â€” evita leak de memÃ³ria)
  sock.ev.on("messages.upsert", ({ messages }) => {
    for (const m of messages) handleIncoming(sock, m, sock.user?.id);
  });

  log.info("FigBot iniciado. Aguardando conexÃ£o...");
}

start().catch((err) => {
  log.error({ err }, "falha fatal");
  process.exit(1);
});
