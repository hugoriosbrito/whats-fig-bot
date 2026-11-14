import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { deleteVip, hasDatabase, listVips, readUsage, readVip, today, writeUsage, writeVip } from "./db.js";

// Controle de uso diário por pessoa, salvo em disco (data/usage.json).
// Sobrevive a restart/redeploy — essencial no free tier.
// Formato: { "5511999998888": { day: "2026-10-11", count: 3, lastAt: 1728... } }
//
// Cada recurso tem seu próprio contador. "fig" usa a chave antiga (só o número)
// para não perder o histórico; os demais ganham prefixo, ex: "tts:5511999998888".

const file = path.join(config.dataDir, "usage.json");
const vipFile = path.join(config.dataDir, "vips.json");

async function load() {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function save(db) {
  await fs.mkdir(config.dataDir, { recursive: true });
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(db));
  await fs.rename(tmp, file); // escrita atômica: nunca corrompe em crash
}

async function loadVips() {
  try {
    const raw = await fs.readFile(vipFile, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function saveVips(vips) {
  await fs.mkdir(config.dataDir, { recursive: true });
  const tmp = vipFile + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(vips));
  await fs.rename(tmp, vipFile);
}

function senderKey(jid) {
  // "5511999998888@s.whatsapp.net" -> "5511999998888" (só o número)
  return String(jid || "").split("@")[0].split(":")[0];
}

function usageKey(jid, kind) {
  const phone = senderKey(jid);
  return kind === "fig" ? phone : `${kind}:${phone}`;
}

const quotaOf = (kind, vip) => {
  if (kind === "tts") return vip?.ttsLimit ?? config.ttsDailyLimit;
  return vip?.stickerLimit ?? config.dailyLimit;
};
const cooldownOf = (kind) => (kind === "tts" ? config.ttsCooldownSeconds : config.cooldownSeconds);

export function phoneOf(jid) {
  return senderKey(jid);
}

// Celular brasileiro chega com e sem o 9.
// 55 + DDD (2) + 9 + 8 dígitos = 13, ou 55 + DDD + número antigo de 8 = 12.
// No WhatsApp o formato longo também aparece com 14 dígitos.
export function samePhone(a, b) {
  const left = phoneOf(a);
  const right = phoneOf(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const mobile = (value) => {
    if (!value.startsWith("55") || value[4] !== "9") return value;
    if (value.length !== 13 && value.length !== 14) return value;
    return `${value.slice(0, 4)}${value.slice(5)}`;
  };
  return mobile(left) === mobile(right);
}

export function isAdmin(jid) {
  return config.adminNumbers.includes(phoneOf(jid));
}

async function vipFor(phone) {
  if (!phone) return null;
  if (hasDatabase()) return readVip(phone);
  const vips = await loadVips();
  return vips[phone] || null;
}

// Só a cota diária. Não olha o intervalo entre usos.
async function entryFor(key) {
  if (hasDatabase()) return readUsage(key);
  const db = await load();
  return db[key] || null;
}

export async function checkQuota(jid, kind = "fig") {
  const phone = senderKey(jid);
  const key = usageKey(jid, kind);
  const vip = await vipFor(phone);
  const limit = quotaOf(kind, vip);
  const entry = await entryFor(key);
  const day = today();
  const used = entry && entry.day === day ? entry.count : 0;

  if (used >= limit) {
    return { ok: false, reason: "limit", used, limit, vip: Boolean(vip) };
  }
  return { ok: true, used, limit, vip: Boolean(vip) };
}

// Intervalo mínimo entre usos da mesma pessoa. Independente da cota.
export async function checkCooldown(jid, kind = "fig") {
  const key = usageKey(jid, kind);
  const entry = await entryFor(key);
  if (!entry?.lastAt) return { ok: true };

  const cooldown = cooldownOf(kind);
  const elapsed = (Date.now() - entry.lastAt) / 1000;
  if (elapsed < cooldown) {
    return { ok: false, wait: Math.ceil(cooldown - elapsed) };
  }
  return { ok: true };
}

// Registra 1 uso (figurinha ou áudio) para a pessoa.
export async function registerUse(jid, kind = "fig") {
  const key = usageKey(jid, kind);
  const day = today();
  const current = await entryFor(key);
  const prev = current && current.day === day ? current.count : 0;
  const next = { day, count: prev + 1, lastAt: Date.now() };
  if (hasDatabase()) {
    await writeUsage(key, next.count, next.lastAt);
  } else {
    const db = await load();
    db[key] = next;
    await save(db);
  }
  const vip = await vipFor(senderKey(jid));
  return { used: next.count, limit: quotaOf(kind, vip) };
}

function limitsOf(stickerLimit, ttsLimit) {
  const sticker = Number(stickerLimit);
  const voice = ttsLimit === undefined || ttsLimit === "" ? config.ttsDailyLimit : Number(ttsLimit);
  if (!Number.isInteger(sticker) || sticker < 1 || sticker > 10000) return null;
  if (!Number.isInteger(voice) || voice < 1 || voice > 10000) return null;
  return { stickerLimit: sticker, ttsLimit: voice };
}

export async function setVip(phone, stickerLimit, ttsLimit) {
  const limits = limitsOf(stickerLimit, ttsLimit);
  if (!limits) return null;
  if (hasDatabase()) {
    await writeVip(phone, limits.stickerLimit, limits.ttsLimit);
  } else {
    const vips = await loadVips();
    vips[phone] = limits;
    await saveVips(vips);
  }
  return { phone, ...limits };
}

export async function removeVip(phone) {
  if (hasDatabase()) return deleteVip(phone);
  const vips = await loadVips();
  if (!vips[phone]) return false;
  delete vips[phone];
  await saveVips(vips);
  return true;
}

export async function vipList() {
  if (hasDatabase()) return listVips();
  const vips = await loadVips();
  return Object.entries(vips)
    .map(([phone, limits]) => ({ phone, ...limits }))
    .sort((a, b) => a.phone.localeCompare(b.phone));
}
