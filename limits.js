import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "./config.js";

// Controle de uso diário por pessoa, salvo em disco (data/usage.json).
// Sobrevive a restart/redeploy — essencial no free tier.
// Formato: { "5511999998888": { day: "2026-10-11", count: 3, lastAt: 1728... } }

const file = path.join(config.dataDir, "usage.json");

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

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

function senderKey(jid) {
  // "5511999998888@s.whatsapp.net" -> "5511999998888" (só o número)
  return String(jid || "").split("@")[0].split(":")[0];
}

// Só a cota diária. Não olha o intervalo entre figurinhas.
export async function checkQuota(jid) {
  const key = senderKey(jid);
  const db = await load();
  const entry = db[key];
  const day = today();
  const used = entry && entry.day === day ? entry.count : 0;

  if (used >= config.dailyLimit) {
    return { ok: false, reason: "limit", used, limit: config.dailyLimit };
  }
  return { ok: true, used, limit: config.dailyLimit };
}

// Intervalo mínimo entre figurinhas da mesma pessoa. Independente da cota.
export async function checkCooldown(jid) {
  const key = senderKey(jid);
  const db = await load();
  const entry = db[key];
  if (!entry?.lastAt) return { ok: true };

  const elapsed = (Date.now() - entry.lastAt) / 1000;
  if (elapsed < config.cooldownSeconds) {
    return { ok: false, wait: Math.ceil(config.cooldownSeconds - elapsed) };
  }
  return { ok: true };
}

// Registra 1 figurinha gerada para a pessoa.
export async function registerUse(jid) {
  const key = senderKey(jid);
  const db = await load();
  const day = today();
  const prev = db[key] && db[key].day === day ? db[key].count : 0;
  db[key] = { day, count: prev + 1, lastAt: Date.now() };
  await save(db);
  return { used: prev + 1, limit: config.dailyLimit };
}
