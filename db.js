import mysql from "mysql2/promise";
import { config } from "./config.js";

let pool;

export function hasDatabase() {
  return Boolean(process.env.DATABASE_URL);
}

function database() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL não está configurada.");
  }
  pool ??= mysql.createPool({
    uri: process.env.DATABASE_URL,
    waitForConnections: true,
    connectionLimit: 4,
    connectTimeout: 10000,
    enableKeepAlive: true,
  });
  return pool;
}

export async function closeDatabase() {
  if (pool) await pool.end();
}

export async function setupDatabase() {
  const db = database();
  await db.query(`
    CREATE TABLE IF NOT EXISTS wa_auth (
      id VARCHAR(191) PRIMARY KEY,
      data MEDIUMTEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS usage_daily (
      phone VARCHAR(32) PRIMARY KEY,
      day CHAR(10) NOT NULL,
      count INT NOT NULL,
      last_at BIGINT NOT NULL
    )
  `);
}

export async function readAuth(id) {
  const [rows] = await database().query("SELECT data FROM wa_auth WHERE id = ?", [id]);
  return rows[0]?.data || null;
}

export async function writeAuth(id, data) {
  await database().query(
    "INSERT INTO wa_auth (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)",
    [id, data]
  );
}

export async function deleteAuth(id) {
  await database().query("DELETE FROM wa_auth WHERE id = ?", [id]);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

export async function readUsage(phone) {
  const [rows] = await database().query(
    "SELECT day, count, last_at AS lastAt FROM usage_daily WHERE phone = ?",
    [phone]
  );
  return rows[0] || null;
}

export async function writeUsage(phone, count, lastAt) {
  await database().query(
    `INSERT INTO usage_daily (phone, day, count, last_at) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE day = VALUES(day), count = VALUES(count), last_at = VALUES(last_at)`,
    [phone, today(), count, lastAt]
  );
}

export { today, config };
