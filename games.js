import { readFileSync } from "node:fs";
import { phoneOf } from "./limits.js";
import { readStore, writeStore } from "./store.js";
import {
  BAIT_MAX,
  BAIT_REGEN_MS,
  FISH_KEEP,
  SLOT_MAX_COINS,
  SLOT_REGEN_MS,
  SLOT_STOCK_CAP,
  pickFishWeight,
  regenCount,
  scrambleWord,
  scoreStop,
  parseStopResponse,
  spinSlots,
  slotPayout,
} from "./logic.js";

const FISH = [
  "tilápia", "pacu", "dourado", "pintado", "traíra", "tucunaré", "lambari", "bagre",
  "pirarucu", "tambaqui", "corvina", "robalo", "linguado", "atum", "sardinha", "anchova",
  "badejo", "garoupa", "peixe-espada", "cavala",
];

const STOP_CATEGORIES = ["nome", "fruta", "animal", "objeto", "cor", "país", "comida", "profissão", "marca", "cidade"];
const STOP_LETTERS = "ABCDEFGHIJLMNOPQRSTUVXZ".split("");
const STOP_MS = 90_000;
const ANAGRAM_ROUNDS = 5;

const anagrams = new Map();
const stops = new Map();

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function loadWords() {
  try {
    return readFileSync(new URL("./data/anagrama-pt.txt", import.meta.url), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line.length >= 4 && line.length <= 12 && !line.includes("-"));
  } catch {
    return ["barco", "nuvem", "ponte", "festa", "janela", "caminho", "estrela"];
  }
}

let words;

function wordList() {
  if (!words) words = loadWords();
  return words;
}

function groupOf(msg) {
  return msg.key.remoteJid.endsWith("@g.us") ? msg.key.remoteJid : null;
}

async function touch(name, key, create) {
  const store = await readStore(name);
  const now = Date.now();
  const current = store[key] || create(now);
  store[key] = current;
  return { store, current, now };
}

export async function fish(msg) {
  const phone = phoneOf(msg.sender);
  const { store, current, now } = await touch("fishing", phone, (at) => ({
    baits: BAIT_MAX,
    lastAt: at,
    catches: [],
    weight: 0,
    groups: {},
  }));
  const regen = regenCount(current.lastAt, now, BAIT_REGEN_MS, current.baits, BAIT_MAX);
  current.baits = regen.have;
  current.lastAt = regen.lastAt;
  if (current.baits < 1) {
    const wait = Math.ceil((BAIT_REGEN_MS - (now - current.lastAt)) / 60000);
    await writeStore("fishing", store);
    return `Sem isca. A próxima chega em cerca de *${Math.max(wait, 1)} min*.`;
  }
  current.baits -= 1;
  const weight = pickFishWeight();
  const name = pick(FISH);
  current.catches.push({ name, weight });
  current.catches.sort((a, b) => a.weight - b.weight);
  while (current.catches.length > FISH_KEEP) current.catches.shift();
  current.weight = Math.round(current.catches.reduce((sum, item) => sum + item.weight, 0) * 10) / 10;
  const group = groupOf(msg);
  if (group) current.groups[group] = current.weight;
  await writeStore("fishing", store);
  return `Você pescou um *${name}* de *${weight.toFixed(1)} kg*.\nIscas: *${current.baits}/${BAIT_MAX}*. No balde: *${current.weight.toFixed(1)} kg*.`;
}

export async function fishStatus(msg) {
  const store = await readStore("fishing");
  const current = store[phoneOf(msg.sender)];
  if (!current?.catches?.length) return "Você ainda não pescou nada. Manda *!pescar*.";
  const lines = current.catches
    .slice()
    .reverse()
    .map((item) => `${item.name} — ${item.weight.toFixed(1)} kg`);
  return `Iscas: *${current.baits}/${BAIT_MAX}*.\n${lines.join("\n")}`;
}

export async function fishRank(msg) {
  const group = groupOf(msg);
  if (!group) return "O ranking da pesca é no grupo.";
  const store = await readStore("fishing");
  const rows = Object.entries(store)
    .map(([phone, data]) => ({ phone, weight: data.groups?.[group] || 0 }))
    .filter((row) => row.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 10);
  if (!rows.length) return "Ninguém pescou neste grupo ainda.";
  return rows.map((row, i) => `${i + 1}. ${row.phone} — ${row.weight.toFixed(1)} kg`).join("\n");
}

export async function slots(msg, times) {
  const rolls = Math.min(3, Math.max(1, Number(times) || 1));
  const phone = phoneOf(msg.sender);
  const { store, current, now } = await touch("slots", phone, (at) => ({
    coins: SLOT_MAX_COINS,
    lastAt: at,
    wins: {},
  }));
  const regen = regenCount(current.lastAt, now, SLOT_REGEN_MS, current.coins, SLOT_MAX_COINS);
  current.coins = regen.have;
  current.lastAt = regen.lastAt;
  if (current.coins < 1) {
    await writeStore("slots", store);
    return `Sem moeda. Você tem *0/${SLOT_MAX_COINS}*. Uma volta a cada 30 min.`;
  }
  const lines = [];
  let played = 0;
  for (let i = 0; i < rolls && current.coins > 0; i += 1) {
    current.coins -= 1;
    played += 1;
    const spin = spinSlots();
    const gain = slotPayout(spin.kind);
    current.coins = Math.min(SLOT_STOCK_CAP, current.coins + gain);
    const group = groupOf(msg);
    if (spin.kind === "triple" && group) current.wins[group] = (current.wins[group] || 0) + 1;
    const label = spin.kind === "triple" ? "três iguais" : spin.kind === "pair" ? "par" : "nada";
    lines.push(`${spin.reels.join(" | ")} — ${label}${gain ? `, +${gain}` : ""}`);
  }
  current.coins = Math.min(SLOT_STOCK_CAP, current.coins);
  await writeStore("slots", store);
  return `${lines.join("\n")}\n\nMoedas: *${current.coins}* (teto solto ${SLOT_STOCK_CAP}, regenera até ${SLOT_MAX_COINS}). Giros: ${played}.`;
}

export async function slotsRank(msg) {
  const group = groupOf(msg);
  if (!group) return "O ranking do caça-níquel é no grupo.";
  const store = await readStore("slots");
  const rows = Object.entries(store)
    .map(([phone, data]) => ({ phone, wins: data.wins?.[group] || 0 }))
    .filter((row) => row.wins > 0)
    .sort((a, b) => b.wins - a.wins)
    .slice(0, 10);
  if (!rows.length) return "Ninguém fez três iguais neste grupo.";
  return rows.map((row, i) => `${i + 1}. ${row.phone} — ${row.wins}`).join("\n");
}

const chambers = new Map();

export async function roulette(msg) {
  const group = groupOf(msg);
  if (!group) return "A roleta russa é só no grupo.";
  let chamber = chambers.get(group);
  if (!chamber || chamber.bullet >= 6) {
    chamber = { bullet: Math.floor(Math.random() * 6), shot: 0 };
    chambers.set(group, chamber);
  }
  const dead = chamber.shot === chamber.bullet;
  chamber.shot += 1;
  const phone = phoneOf(msg.sender);
  const store = await readStore("roleta");
  const key = `${group}:${phone}`;
  const row = store[key] || { survived: 0, died: 0 };
  if (dead) {
    row.died += 1;
    chambers.delete(group);
  } else {
    row.survived += 1;
  }
  store[key] = row;
  await writeStore("roleta", store);
  if (dead) return `*${phone}* puxou o gatilho e a bala saiu. O tambor recarrega.`;
  return `*${phone}* sobreviveu. Já foram ${chamber.shot} de 6.`;
}

export async function rouletteRank(msg) {
  const group = groupOf(msg);
  if (!group) return "O ranking da roleta é no grupo.";
  const store = await readStore("roleta");
  const rows = Object.entries(store)
    .filter(([key]) => key.startsWith(`${group}:`))
    .map(([key, data]) => ({ phone: key.split(":").pop(), survived: data.survived }))
    .sort((a, b) => b.survived - a.survived)
    .slice(0, 10);
  if (!rows.length) return "Ninguém jogou roleta neste grupo.";
  return rows.map((row, i) => `${i + 1}. ${row.phone} — ${row.survived} sobrevivências`).join("\n");
}

export function anagramStart(msg) {
  const group = groupOf(msg);
  if (!group) return "O anagrama é no grupo.";
  if (anagrams.has(group)) return "Já tem uma palavra no ar. Manda o palpite ou *!anagrama-parar*.";
  const round = nextRound();
  anagrams.set(group, { ...round, left: ANAGRAM_ROUNDS, hints: 0, scores: {} });
  return `Anagrama: *${round.scrambled}*\nManda a palavra. Rodadas: ${ANAGRAM_ROUNDS}.`;
}

function nextRound() {
  const list = wordList();
  const word = pick(list);
  return { word, scrambled: scrambleWord(word), shown: [] };
}

export async function anagramGuess(msg, text) {
  const group = groupOf(msg);
  const game = group && anagrams.get(group);
  if (!game) return null;
  const guess = String(text || "").trim().toLowerCase();
  if (!guess || guess.startsWith("!")) return null;
  if (guess !== game.word) return null;
  const phone = phoneOf(msg.sender);
  game.scores[phone] = (game.scores[phone] || 0) + 1;
  const store = await readStore("anagram");
  const key = `${group}:${phone}`;
  store[key] = (store[key] || 0) + 1;
  await writeStore("anagram", store);
  game.left -= 1;
  if (game.left <= 0) {
    anagrams.delete(group);
    return `*${phone}* acertou *${game.word}*. Acabaram as rodadas.`;
  }
  const round = nextRound();
  game.word = round.word;
  game.scrambled = round.scrambled;
  game.shown = [];
  game.hints = 0;
  return `*${phone}* acertou. Próxima: *${game.scrambled}* (${game.left} restantes).`;
}

export function anagramHint(msg) {
  const group = groupOf(msg);
  const game = group && anagrams.get(group);
  if (!game) return "Não tem anagrama neste grupo.";
  if (game.hints >= 3) return "As 3 dicas desta palavra já foram usadas.";
  const hidden = [...game.word].findIndex((letter, index) => game.shown[index] !== letter);
  if (hidden < 0) return "A palavra já está aberta.";
  game.shown[hidden] = game.word[hidden];
  game.hints += 1;
  const mask = [...game.word].map((letter, index) => (game.shown[index] === letter ? letter : "_")).join(" ");
  return `Dica: ${mask}`;
}

export function anagramStop(msg) {
  const group = groupOf(msg);
  if (!group || !anagrams.has(group)) return "Não tem anagrama neste grupo.";
  anagrams.delete(group);
  return "Anagrama encerrado.";
}

export async function anagramRank(msg) {
  const group = groupOf(msg);
  if (!group) return "O ranking do anagrama é no grupo.";
  const store = await readStore("anagram");
  const rows = Object.entries(store)
    .filter(([key]) => key.startsWith(`${group}:`))
    .map(([key, points]) => ({ phone: key.split(":").pop(), points }))
    .sort((a, b) => b.points - a.points)
    .slice(0, 10);
  if (!rows.length) return "Ninguém pontuou no anagrama deste grupo.";
  return rows.map((row, i) => `${i + 1}. ${row.phone} — ${row.points}`).join("\n");
}

export function stopStart(msg) {
  const group = groupOf(msg);
  if (!group) return "O stop é no grupo.";
  if (stops.has(group)) return "Já tem um stop rolando. Responda no meu privado com *!stop-resp*.";
  const categories = [...STOP_CATEGORIES].sort(() => Math.random() - 0.5).slice(0, 5);
  const letter = pick(STOP_LETTERS);
  const game = {
    letter,
    categories,
    host: phoneOf(msg.sender),
    answers: [],
    timer: null,
    endsAt: Date.now() + STOP_MS,
  };
  stops.set(group, game);
  return {
    text: `Stop com a letra *${letter}*.\n${categories.map((item) => `• ${item}`).join("\n")}\n\nManda no meu privado, em até 90s:\n*!stop-resp* ${categories[0]}: ..., ${categories[1]}: ...`,
    game,
    group,
  };
}

export function takeStop(group) {
  const game = stops.get(group);
  if (!game) return null;
  stops.delete(group);
  return game;
}

export function stopForPrivate() {
  for (const [group, game] of stops) {
    if (Date.now() > game.endsAt) continue;
    return { group, game };
  }
  return null;
}

export async function stopAnswer(msg, rest) {
  const phone = phoneOf(msg.sender);
  const found = [...stops.entries()].find(([, game]) => Date.now() <= game.endsAt);
  if (!found) return "Não tem stop esperando resposta.";
  const [group, game] = found;
  if (game.answers.some((entry) => entry.user === phone)) return "Você já respondeu este stop.";
  const values = parseStopResponse(rest, game.categories);
  if (!Object.keys(values).length) {
    return `Não entendi. Manda assim: *!stop-resp* ${game.categories[0]}: palavra`;
  }
  game.answers.push({ user: phone, values });
  return `Resposta guardada para o grupo. Categorias: ${Object.keys(values).join(", ")}.`;
}

export async function finishStop(game, group) {
  const scores = scoreStop(game.letter, game.answers);
  const store = await readStore("stop");
  for (const [phone, points] of Object.entries(scores)) {
    const key = `${group}:${phone}`;
    store[key] = (store[key] || 0) + points;
  }
  await writeStore("stop", store);
  if (!game.answers.length) return `Ninguém respondeu o stop da letra *${game.letter}*.`;
  const lines = Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .map(([phone, points]) => `${phone}: *${points}*`);
  return `Stop da letra *${game.letter}*:\n${lines.join("\n")}`;
}

export function stopEnd(msg) {
  const group = groupOf(msg);
  const game = group && stops.get(group);
  if (!game) return null;
  if (game.host !== phoneOf(msg.sender)) return { text: "Só quem começou pode encerrar com *!stop-fim*." };
  stops.delete(group);
  return { game, group };
}

export async function stopRank(msg) {
  const group = groupOf(msg);
  if (!group) return "O ranking do stop é no grupo.";
  const store = await readStore("stop");
  const rows = Object.entries(store)
    .filter(([key]) => key.startsWith(`${group}:`))
    .map(([key, points]) => ({ phone: key.split(":").pop(), points }))
    .sort((a, b) => b.points - a.points)
    .slice(0, 10);
  if (!rows.length) return "Ninguém pontuou no stop deste grupo.";
  return rows.map((row, i) => `${i + 1}. ${row.phone} — ${row.points}`).join("\n");
}
