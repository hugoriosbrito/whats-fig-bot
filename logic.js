// Regras puras dos jogos. Sem WhatsApp e sem disco, para o teste rodar sozinho.

export const PINTO = {
  minFlaccid: 3,
  maxFlaccid: 12,
  minErect: 5,
  maxErect: 25,
  minGirth: 8,
  maxGirth: 18,
  maxCurvature: 30,
  cooldownMs: 3 * 24 * 60 * 60 * 1000,
};

export function round1(min, max, random = Math.random) {
  const value = random() * (max - min) + min;
  return Math.round(value * 10) / 10;
}

export function pintoScore(flaccid, erect, girth, curvature) {
  const norm = (value, min, max) => (value - min) / (max - min);
  const weighted =
    norm(flaccid, PINTO.minFlaccid, PINTO.maxFlaccid) * 0.2 +
    norm(erect, PINTO.minErect, PINTO.maxErect) * 0.5 +
    norm(girth, PINTO.minGirth, PINTO.maxGirth) * 0.2 +
    (1 - Math.abs(curvature) / PINTO.maxCurvature) * 0.1;
  return Math.round(Math.min(1, Math.max(0, weighted)) * 1000);
}

export function pintoComment(score) {
  if (score >= 900) return "Ou é lenda ou a régua estava bêbada. O grupo vai cobrar prova.";
  if (score >= 750) return "Acima do que esse consultório aguenta sem processar alguém.";
  if (score >= 600) return "Bom o bastante para contar vantagem. Não o bastante para calar o grupo.";
  if (score >= 450) return "Na média. Serve. Ninguém pediu mais que isso, e ainda assim.";
  if (score >= 300) return "Abaixo. Dá para culpar o ar, a luz ou a genética. Escolhe uma.";
  if (score >= 150) return "Compacto. A mala de mão agradece. O ego, não.";
  return "A ciência pediu a amostra de volta. Disse que não era representativa.";
}

export const BODY = {
  peito: {
    title: "Peito",
    lines: [
      ["esquerdo", "Esquerdo", 70, 120],
      ["direito", "Direito", 70, 120],
      ["diferenca", "Diferença", 0, 4],
    ],
    unit: "cm",
  },
  bunda: {
    title: "Bunda",
    lines: [
      ["esquerda", "Esquerda", 80, 140],
      ["direita", "Direita", 80, 140],
      ["diferenca", "Diferença", 0, 4],
    ],
    unit: "cm",
  },
};

export function measureBody(kind, random = Math.random) {
  const spec = BODY[kind];
  const parts = {};
  for (const [key, , min, max] of spec.lines) parts[key] = round1(min, max, random);
  const span = spec.lines.reduce((sum, [, , min, max]) => sum + (max - min), 0);
  const filled = spec.lines.reduce((sum, [key, , min]) => sum + (parts[key] - min), 0);
  const balance = 1 - Math.min(1, parts.diferenca / 4);
  const score = Math.round(Math.min(1, Math.max(0, (filled / span) * 0.7 + balance * 0.3)) * 1000);
  return { ...parts, score };
}

export function measurePinto(random = Math.random) {
  const flaccid = round1(PINTO.minFlaccid, PINTO.maxFlaccid, random);
  const erect = round1(Math.max(PINTO.minErect, flaccid), PINTO.maxErect, random);
  const girth = round1(PINTO.minGirth, PINTO.maxGirth, random);
  const curvature = round1(-PINTO.maxCurvature, PINTO.maxCurvature, random);
  return { flaccid, erect, girth, curvature, score: pintoScore(flaccid, erect, girth, curvature) };
}

export function scrambleWord(word, random = Math.random) {
  const letters = [...word];
  if (new Set(letters).size < 2) return word;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const copy = [...letters];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    const next = copy.join("");
    if (next !== word) return next;
  }
  return `${letters[letters.length - 1]}${letters.slice(0, -1).join("")}`;
}

export function normalizeAnswer(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

const STOP_POINTS = { unique: 10, repeated: 5, invalid: 0 };

// answers: [{ user, values: { fruta: "banana" } }]
// Uma resposta por categoria. Vazia ou com a letra errada vale 0.
// Igual à de outra pessoa na mesma categoria vale 5. Única vale 10.
export function scoreStop(letter, answers) {
  const initial = normalizeAnswer(letter).slice(0, 1);
  const byCategory = new Map();
  for (const entry of answers) {
    for (const [category, raw] of Object.entries(entry.values || {})) {
      const word = normalizeAnswer(raw);
      if (!byCategory.has(category)) byCategory.set(category, []);
      byCategory.get(category).push({ user: entry.user, word });
    }
  }
  const scores = {};
  for (const entry of answers) scores[entry.user] = 0;
  for (const group of byCategory.values()) {
    const valid = [];
    const seenUser = new Set();
    for (const item of group) {
      if (!item.word || !item.word.startsWith(initial)) continue;
      const once = `${item.user}:${item.word}`;
      if (seenUser.has(once)) continue;
      seenUser.add(once);
      valid.push(item);
    }
    const counts = new Map();
    for (const item of valid) counts.set(item.word, (counts.get(item.word) || 0) + 1);
    for (const item of valid) {
      scores[item.user] += counts.get(item.word) === 1 ? STOP_POINTS.unique : STOP_POINTS.repeated;
    }
  }
  return scores;
}

export function parseStopResponse(text, categories) {
  const known = new Map(categories.map((name) => [normalizeAnswer(name), name]));
  const values = {};
  for (const part of String(text || "").split(/[,\n]/)) {
    const split = part.split(":");
    if (split.length < 2) continue;
    const category = known.get(normalizeAnswer(split[0]));
    if (!category) continue;
    values[category] = split.slice(1).join(":").trim();
  }
  return values;
}

export function regenCount(lastAt, now, everyMs, have, max) {
  if (have >= max) return { have: max, lastAt: now };
  if (lastAt === undefined || lastAt === null) return { have, lastAt: now };
  const gained = Math.floor((now - lastAt) / everyMs);
  if (gained <= 0) return { have, lastAt };
  const next = Math.min(max, have + gained);
  const spent = next >= max ? now : lastAt + gained * everyMs;
  return { have: next, lastAt: spent };
}

export function spinSlots(random = Math.random) {
  const symbols = ["peixe", "isca", "moeda", "estrela", "lixo"];
  const roll = () => symbols[Math.floor(random() * symbols.length)];
  const reels = [roll(), roll(), roll()];
  const same = reels[0] === reels[1] && reels[1] === reels[2];
  const pair = !same && (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2]);
  return { reels, kind: same ? "triple" : pair ? "pair" : "miss" };
}

export function slotPayout(kind, random = Math.random) {
  if (kind === "triple") return 1 + 2 + Math.floor(random() * 7);
  if (kind === "pair") return 1;
  return 0;
}

export function pickFishWeight(random = Math.random) {
  const curved = random() ** 2;
  const kilos = 0.1 + curved * 29.9;
  return Math.round(kilos * 10) / 10;
}

export const SLOT_MAX_COINS = 5;
export const SLOT_STOCK_CAP = 50;
export const SLOT_REGEN_MS = 30 * 60 * 1000;
export const BAIT_MAX = 5;
export const BAIT_REGEN_MS = 60 * 60 * 1000;
export const FISH_KEEP = 10;
