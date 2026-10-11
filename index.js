import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const databaseArg = process.argv.find((arg) => arg.startsWith("mysql://"));
if (databaseArg) process.env.DATABASE_URL = databaseArg;

const require = createRequire(import.meta.url);
const required = ["@whiskeysockets/baileys", "sharp", "pino", "qrcode-terminal", "mysql2"];

function installed() {
  return required.every((name) => {
    try {
      require.resolve(name);
      return true;
    } catch {
      return false;
    }
  });
}

function install() {
  return new Promise((resolve) => {
    const child = spawn("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

for (let attempt = 1; !installed() && attempt <= 4; attempt += 1) {
  console.log(`Instalando dependências, tentativa ${attempt} de 4...`);
  await install();
  if (!installed()) await new Promise((resolve) => setTimeout(resolve, 5000));
}

if (!installed()) {
  console.error("Não consegui instalar as dependências depois de 4 tentativas.");
  process.exit(1);
}

if (process.env.DATABASE_URL) {
  const { setupDatabase } = await import("./db.js");
  await setupDatabase();
  console.log("Banco MySQL conectado.");
}

await import("./bot.js");
