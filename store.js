import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { hasDatabase } from "./db.js";
import mysql from "mysql2/promise";

// Um JSON por domínio quando não há MySQL. Escrita atômica, igual ao limits.js.
// Com DATABASE_URL, a mesma chave vira uma linha em bot_store.

const memory = new Map();

let pool;

function database() {
  if (!pool) {
    pool = mysql.createPool({
      uri: process.env.DATABASE_URL,
      waitForConnections: true,
      connectionLimit: 1,
      connectTimeout: 10000,
      enableKeepAlive: true,
      maxIdle: 1,
      idleTimeout: 20000,
    });
    pool.on("error", () => {});
  }
  return pool;
}

function fileOf(name) {
  return path.join(config.dataDir, `${name}.json`);
}

async function readFileStore(name) {
  try {
    return JSON.parse(await fs.readFile(fileOf(name), "utf8"));
  } catch {
    return {};
  }
}

async function writeFileStore(name, data) {
  await fs.mkdir(config.dataDir, { recursive: true });
  const file = fileOf(name);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data));
  await fs.rename(tmp, file);
}

export async function setupStore() {
  if (!hasDatabase()) return;
  await database().query(`
    CREATE TABLE IF NOT EXISTS bot_store (
      name VARCHAR(64) NOT NULL,
      item_key VARCHAR(191) NOT NULL,
      data MEDIUMTEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (name, item_key)
    )
  `);
}

export async function readStore(name) {
  if (memory.has(name)) return memory.get(name);
  if (!hasDatabase()) {
    const data = await readFileStore(name);
    memory.set(name, data);
    return data;
  }
  const [rows] = await database().query("SELECT item_key, data FROM bot_store WHERE name = ?", [name]);
  const data = {};
  for (const row of rows) {
    try {
      data[row.item_key] = JSON.parse(row.data);
    } catch {
      /* linha corrompida não derruba o resto */
    }
  }
  memory.set(name, data);
  return data;
}

async function persistPair(name, key, value) {
  if (!hasDatabase()) return;
  await database().query(
    `INSERT INTO bot_store (name, item_key, data) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE data = VALUES(data)`,
    [name, key.slice(0, 191), JSON.stringify(value)]
  );
}

async function deletePair(name, key) {
  if (!hasDatabase()) return;
  await database().query("DELETE FROM bot_store WHERE name = ? AND item_key = ?", [name, key.slice(0, 191)]);
}

export async function writeStore(name, data) {
  const previous = memory.get(name) || {};
  memory.set(name, data);
  if (!hasDatabase()) {
    await writeFileStore(name, data);
    return;
  }
  for (const key of Object.keys(previous)) {
    if (!(key in data)) await deletePair(name, key);
  }
  for (const key of Object.keys(data)) await persistPair(name, key, data[key]);
}

export function remember(name, data) {
  memory.set(name, data);
}
