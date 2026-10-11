import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { hasDatabase, readUsage, writeUsage, today } from "./db.js";

// Controle de uso diário por pessoa, salvo em disco (data/usage.json).
// Sobrevive a restart/redeploy — essencial no free tier.
// Formato: { "5511999998888": { day: "2026-10-11", count: 3, lastAt: 1728... } }

const file = path.join(config.dataDir, "usage.json");

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
async function entryFor(key) {
  if (hasDatabase()) return readUsage(key);
  const db = await load();
  return db[key] || null;
}

export async function checkQuota(jid) {
  const key = senderKey(jid);
  const entry = await entryFor(key);
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
  const entry = await entryFor(key);
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
  return { used: next.count, limit: config.dailyLimit };
}
