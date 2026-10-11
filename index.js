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
//  • Envie uma FOTO com a legenda "!fig" → vira figurinha na hora
//  • Responda uma foto/vídeo com "!fig" → vira figurinha
//  • "!menu" → mostra as opções | "!ajuda" → como funciona | "!resto" → sua cota de hoje
const MENU = `🤖 *FigBot* — escolha uma opção:

1️⃣ *Criar figurinha*
Envie uma foto com a legenda *!fig*
(ou responda uma foto/vídeo com *!fig*)

2️⃣ *Meus limites*
Envie *!resto* para ver quantas figurinhas
restam hoje (máx. ${config.dailyLimit}/dia)

3️⃣ *Ajuda*
Envie *!ajuda*

📌 Dica: no modo 1 é só mandar a foto com *!fig* na legenda!`;

const HELP = `❓ *Como funciona:*

• Mande uma *foto* com a legenda *!fig* → vira figurinha 512x512
• Ou *responda* uma foto/vídeo curto (até ${config.maxVideoSeconds}s) com *!fig*
• Modos de corte: *!fig*, *!fig fill* (preenche), *!fig stretch* (esticada)
• Limite: *${config.dailyLimit} figurinhas por dia* por pessoa + pausa de ${config.cooldownSeconds}s entre cada uma (proteção anti-ban)
• Só respondo no privado e em menções em grupo (não floodo grupo)`;

function extractBody(msg) {
  // Texto da mensagem (conversa simples, legenda de mídia ou resposta)
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
  // Em grupo, participant é quem enviou; no privado, remoteJid é a pessoa
  return msg.key.participant || msg.key.remoteJid;
}

function isGroup(jid) {
  return String(jid || "").endsWith("@g.us");
}

function botMentioned(msg, botJid) {
  // Em grupo, só responde se mencionarem o bot (evita flood → anti-ban)
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  return Boolean(ctx?.mentionedJid?.includes(botJid));
}

// Mensagem citada que contém mídia (responder foto/vídeo com !fig).
// Retorna a mensagem citada COMPLETA + contexto (stanzaId/participant),
// que o Baileys precisa para baixar a mídia citada.
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

// Baixa a mídia e salva direto em disco. O buffer é transitório e limitado
// a config.maxMediaMB — seguro nos 256MB do free tier.
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

  // 1. Cota diária e intervalo mínimo, por pessoa.
  const quota = await checkQuota(sender);
  if (!quota.ok) {
    await sendText(
      sock, chat,
      `🚫 Você usou suas *${quota.used}/${quota.limit}* figurinhas de hoje. Volte amanhã! 👍`,
      msg
    );
    return;
  }
  const pace = await checkCooldown(sender);
  if (!pace.ok) {
    await sendText(sock, chat, `⏳ Calma aí! Aguarde *${pace.wait}s* antes da próxima.`, msg);
    return;
  }

  // 2. Descobre a mídia: anexada na mensagem ou citada (resposta).
  // Para citada, remontamos uma mensagem com stanzaId/participant,
  // que o Baileys exige para localizar e baixar a mídia original.
  const directImage = msg.message?.imageMessage;
  const directVideo = msg.message?.videoMessage;
  const quoted = quotedMedia(msg);

  let target = null; // o que será baixado
  let isVideo = Boolean(directVideo);
  if (directImage || directVideo) {
    target = msg;
  } else if (quoted) {
    isVideo = quoted.type === "video";
    target = {
      key: {
        remoteJid: chat,
        id: quoted.ctx?.stanzaId,
        participant: quoted.ctx?.participant, // só existe em grupo
        fromMe: false,
      },
      message: quoted.quotedMessage,
    };
  }

  if (!target) {
    await sendText(
      sock, chat,
      `📎 Envie uma *foto com a legenda !fig* ou *responda* uma foto/vídeo com *!fig*.\n\n${HELP}`,
      msg
    );
    return;
  }

  if (isVideo) {
    // Vídeo animado precisa de ffmpeg — fora do escopo leve. Oferece o caminho simples.
    await sendText(
      sock, chat,
      `🎬 Por enquanto converto só *fotos*. Me manda a foto (ou um print do vídeo) com a legenda *!fig* que eu faço! 👍`,
      msg
    );
    return;
  }

  // 3. Converte e envia
  let input, output;
  try {
    await sendText(sock, chat, `✨ Fazendo sua figurinha... (${quota.used + 1}/${quota.limit} hoje)`, msg);
    input = await downloadToTemp(sock, target);
    output = await imageToSticker(input, { mode });
    const webp = await fs.readFile(output);
    await sock.sendMessage(chat, { sticker: webp }, { quoted: msg });
    const usage = await registerUse(sender);
    log.info({ sender, used: usage.used }, "figurinha enviada");
  } catch (err) {
    log.error({ err }, "falha ao criar figurinha");
    await sendText(sock, chat, `😕 Não consegui converter: ${err.message}`, msg);
  } finally {
    await cleanup(input, output);
  }
}

async function handleIncoming(sock, msg, botJid) {
  try {
    if (!msg.message || msg.key.fromMe) return; // ignora próprias mensagens e status

    const chat = msg.key.remoteJid;
    const body = extractBody(msg);
    const parsed = parseCommand(body);

    // Sem comando: só reage se for foto com legenda vazia? Não — fica quieto (anti-ban).
    if (!parsed) return;

    // Em grupo, só obedece com menção ao bot (evita o bot floodar o grupo)
    if (isGroup(chat) && !botMentioned(msg, botJid)) return;

    const { cmd, args } = parsed;

    if (cmd === "menu" || cmd === "start" || cmd === "oi" || cmd === "ola" || cmd === "olá") {
      await sendText(sock, chat, MENU, msg);
    } else if (cmd === "ajuda" || cmd === "help") {
      await sendText(sock, chat, HELP, msg);
    } else if (cmd === "resto" || cmd === "limite" || cmd === "cota") {
      const q = await checkQuota(senderOf(msg));
      await sendText(
        sock, chat,
        q.ok
          ? `🎟️ Você usou *${q.used}/${q.limit}* hoje. Restam *${q.limit - q.used}*.`
          : `🚫 Limite de hoje atingido: *${q.used}/${q.limit}*. Volte amanhã! 👍`,
        msg
      );
    } else if (cmd === "fig" || cmd === "s" || cmd === "sticker") {
      const mode = ["fill", "stretch"].includes((args[0] || "").toLowerCase())
        ? args[0].toLowerCase()
        : "fit";
      await handleSticker(sock, msg, mode);
    } else if (cmd === "1") {
      await sendText(sock, chat, `1️⃣ Beleza! Envie a *foto com a legenda !fig* que eu converto. 📸`, msg);
    } else if (cmd === "2") {
      const q = await checkQuota(senderOf(msg));
      await sendText(sock, chat, `2️⃣ Sua cota: *${q.used || 0}/${q.limit}* usadas hoje.`, msg);
    } else if (cmd === "3") {
      await sendText(sock, chat, HELP, msg);
    }
    // Comando desconhecido: silêncio (não polui o chat, não gasta cota)
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
    // Sem cache de grupo em memória: economiza RAM no servidor pequeno
    cachedGroupMetadata: async () => undefined,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      // QR aparece no log do painel sillydev → escaneie com o WhatsApp para parear
      qrcode.generate(qr, { small: true });
      log.info("Escaneie o QR acima com o WhatsApp (Aparelhos conectados)");
    }
    if (connection === "open") log.info("✅ Conectado ao WhatsApp!");
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      log.warn({ code }, shouldReconnect ? "Conexão caiu, reconectando..." : "Sessão deslogada. Apague session/ e pareie de novo.");
      if (shouldReconnect) setTimeout(start, 5_000);
    }
  });

  // Pareamento por código (ideal no servidor: sem câmera no QR do console).
  // Defina PHONE_NUMBER=5511999998888 (só dígitos) nas env vars do painel.
  // Sem ele, o QR é impresso no console do painel para escanear.
  if (!sock.authState.creds.registered) {
    const phone = (process.env.PHONE_NUMBER || "").replace(/\D/g, "");
    if (phone) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(phone);
          log.info(`🔑 Código de pareamento para ${phone}: ${code} (WhatsApp > Aparelhos conectados > Conectar com número)`);
        } catch (err) {
          log.error({ err }, "falha ao gerar código de pareamento");
        }
      }, 3_000);
    }
  }

  // Registra o handler UMA vez por conexão (sem duplicar em reconnect — evita leak de memória)
  sock.ev.on("messages.upsert", ({ messages }) => {
    for (const m of messages) handleIncoming(sock, m, sock.user?.id);
  });

  log.info("FigBot iniciado. Aguardando conexão...");
}

start().catch((err) => {
  log.error({ err }, "falha fatal");
  process.exit(1);
});
