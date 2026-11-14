import { readFileSync } from "node:fs";
import { isAdmin, phoneOf } from "./limits.js";
import { readStore, writeStore } from "./store.js";
import { measurePinto, pintoComment, PINTO } from "./logic.js";

function loadPhrases() {
  try {
    return JSON.parse(readFileSync(new URL("./data/phrases.json", import.meta.url), "utf8"));
  } catch {
    return {
      biscoito: ["A sorte hoje é não esperar sorte."],
      cantada: ["seu sorriso bugou meu sistema"],
      violencia: ["xingou o vento e o vento devolveu"],
      morreu: ["de causas naturais: o grupo"],
      aniversario: ["mais um ano sobrevivendo a esse grupo"],
      pecados: ["abrir o grupo só para ver"],
      presente: ["uma meia"],
      genshin: ["um viajante sem elemento definido"],
    };
  }
}

let phrases;
function book() {
  if (!phrases) phrases = loadPhrases();
  return phrases;
}

function line(key) {
  const list = book()[key] || ["nada hoje"];
  return list[Math.floor(Math.random() * list.length)];
}

function groupOf(msg) {
  return msg.group;
}

export function biscoito() {
  return line("biscoito");
}

function shown(msg, phone) {
  if (phone && phone === msg.mention) return msg.mentionName || phone;
  if (!phone || phone === phoneOf(msg.sender)) return msg.name || phoneOf(msg.sender);
  return phone;
}

export function cantada(msg, mention) {
  if (!groupOf(msg)) return "Cantada é no grupo. Marca alguém ou deixa eu sortear.";
  const who = mention ? shown(msg, mention) : "alguém que estava quieto";
  return `*${shown(msg)}* chegou em *${who}* com: ${line("cantada")}`;
}

export function violencia() {
  return line("violencia");
}

export function morreu() {
  return line("morreu");
}

export function presente() {
  return `Presente sorteado: *${line("presente")}*.`;
}

export function pix(msg, mention) {
  if (!mention) return "Marca quem recebe o Pix fictício: *!pix @*.";
  const value = (Math.random() * 200 + 1).toFixed(2).replace(".", ",");
  return `Pix *fictício* de R$ ${value} para *${shown(msg, mention)}*. Não saiu dinheiro de lugar nenhum.`;
}

export function boleto(msg) {
  if (!groupOf(msg)) return "O boleto fictício é no grupo.";
  return `Boleto *fictício* caiu no colo de alguém do grupo. Quem quiser encenar o pagamento manda *!pagar*. Não existe cobrança.`;
}

export function pagar() {
  return "Pago. O boleto era de brincadeira e continua sem valor.";
}

export function aniversario(msg, mention) {
  if (!mention) return "Marca a pessoa: *!aniversario @*.";
  return `Parabéns, *${shown(msg, mention)}*. ${line("aniversario")}`;
}

export async function pecar(msg) {
  const phone = phoneOf(msg.sender);
  const store = await readStore("jokes");
  const row = store[phone] || { sins: 0 };
  row.sins += 1;
  store[phone] = row;
  await writeStore("jokes", store);
  return `Pecado de hoje: *${line("pecados")}*.\nTotal na ficha: *${row.sins}*.`;
}

export async function meusPecados(msg) {
  const store = await readStore("jokes");
  const row = store[phoneOf(msg.sender)];
  return `Você tem *${row?.sins || 0}* pecado(s) na ficha.`;
}

export function genshin() {
  return `Sorteio: *${line("genshin")}*.`;
}

export function hora() {
  const when = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date());
  return when;
}

export async function pinto(msg, mention) {
  if (!groupOf(msg)) return "A medição é no grupo.";
  const phone = mention || phoneOf(msg.sender);
  const label = shown(msg, phone);
  const key = `${msg.group}:${phone}`;
  const store = await readStore("pinto");
  const previous = store[key];
  const now = Date.now();
  if (previous && now - previous.at < PINTO.cooldownMs) {
    const when = new Date(previous.at + PINTO.cooldownMs);
    const day = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short" }).format(when);
    return `*${label}* já mediu. A próxima é em *${day}*. Nota guardada: *${previous.score}*.`;
  }
  const result = measurePinto();
  store[key] = { ...result, at: now, name: label };
  await writeStore("pinto", store);
  return `Dr. FigBot mediu *${label}*.\nFlácido: ${result.flaccid} cm\nEreto: ${result.erect} cm\nCircunferência: ${result.girth} cm\nCurvatura: ${result.curvature}°\nNota: *${result.score}*\n${pintoComment(result.score)}`;
}

export async function pintoRank(msg) {
  if (!groupOf(msg)) return "O ranking é no grupo.";
  const store = await readStore("pinto");
  const rows = Object.entries(store)
    .filter(([key]) => key.startsWith(`${msg.group}:`))
    .map(([key, data]) => ({ phone: data.name || key.slice(msg.group.length + 1), score: data.score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  if (!rows.length) return "Ninguém mediu neste grupo. Manda *!pinto*.";
  return rows.map((row, i) => `${i + 1}. ${row.phone} — ${row.score}`).join("\n");
}

export async function pintoReset(msg) {
  if (!groupOf(msg)) return "O reset é no grupo.";
  if (!isAdmin(msg.sender)) return "Só o admin apaga o ranking.";
  const store = await readStore("pinto");
  for (const key of Object.keys(store)) {
    if (key.startsWith(`${msg.group}:`)) delete store[key];
  }
  await writeStore("pinto", store);
  return "Ranking deste grupo apagado.";
}
