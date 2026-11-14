import { phoneOf } from "./limits.js";
import { readStore, writeStore } from "./store.js";

const DAY = 24 * 60 * 60 * 1000;

const COISAR = [
  "chegou junto e não explicou nada",
  "trocou um olhar que o grupo inteiro viu",
  "mandou um oi que durou demais",
  "ficou do lado e fingiu que era coincidência",
];

function pairKey(a, b) {
  return [a, b].sort().join(":");
}

function activeOf(store, group, phone) {
  return Object.values(store).find(
    (row) => row.group === group && row.people.includes(phone) && (row.state === "namoro" || row.state === "casamento")
  );
}

function pendingFor(store, group, phone) {
  return Object.values(store).find(
    (row) => row.group === group && row.to === phone && row.state.startsWith("pedido") && Date.now() - row.at < DAY
  );
}

async function load() {
  return readStore("social");
}

export async function namorar(msg, mention) {
  const group = msg.group;
  if (!group) return "Namoro só no grupo. Marca a pessoa: *!namorar @*.";
  const me = phoneOf(msg.sender);
  const store = await load();
  const incoming = pendingFor(store, group, me);
  if (!mention && incoming?.state === "pedido-namoro") {
    incoming.state = "namoro";
    incoming.at = Date.now();
    await writeStore("social", store);
    return `*${me}* e *${incoming.from}* estão namorando.`;
  }
  if (!mention) return "Marca a pessoa: *!namorar @fulano*.";
  if (mention === me) return "Sozinho não conta.";
  if (activeOf(store, group, me) || activeOf(store, group, mention)) {
    return "Alguém desse par já está em um relacionamento neste grupo.";
  }
  const key = `${group}:${pairKey(me, mention)}`;
  store[key] = { group, people: [me, mention], from: me, to: mention, state: "pedido-namoro", at: Date.now(), betrayals: [] };
  await writeStore("social", store);
  return {
    text: `*${me}* chamou *${mention}* para namorar.\n*!namorar* aceita. *!recusar* recusa.`,
  };
}

export async function casar(msg, mention) {
  const group = msg.group;
  if (!group) return "Casamento só no grupo.";
  const me = phoneOf(msg.sender);
  const store = await load();
  const incoming = pendingFor(store, group, me);
  if (!mention && incoming?.state === "pedido-casamento") {
    incoming.state = "casamento";
    incoming.at = Date.now();
    await writeStore("social", store);
    return `*${me}* e *${incoming.from}* casaram.`;
  }
  if (!mention) return "Marca quem você já namora: *!casar @*.";
  const row = activeOf(store, group, me);
  if (!row || row.state !== "namoro" || !row.people.includes(mention)) {
    return "Só dá para casar com quem você já namora neste grupo.";
  }
  row.previous = row.state;
  row.state = "pedido-casamento";
  row.from = me;
  row.to = mention;
  row.at = Date.now();
  await writeStore("social", store);
  return {
    text: `*${me}* pediu *${mention}* em casamento.\n*!casar* aceita. *!recusar* recusa.`,
  };
}

export async function separar(msg) {
  const group = msg.group;
  if (!group) return "Separação só no grupo.";
  const me = phoneOf(msg.sender);
  const store = await load();
  const incoming = pendingFor(store, group, me);
  if (incoming?.state === "pedido-separacao") {
    const key = Object.keys(store).find((item) => store[item] === incoming);
    delete store[key];
    await writeStore("social", store);
    return `*${me}* e *${incoming.from}* se separaram.`;
  }
  const row = activeOf(store, group, me);
  if (!row) return "Você não está em um relacionamento neste grupo.";
  const other = row.people.find((phone) => phone !== me);
  row.previous = row.state;
  row.state = "pedido-separacao";
  row.from = me;
  row.to = other;
  row.at = Date.now();
  await writeStore("social", store);
  return {
    text: `*${me}* pediu para terminar com *${other}*.\n*!separar* confirma. *!recusar* mantém. Em 24 h sem resposta, continua tudo como está.`,
  };
}

export async function recusar(msg) {
  const group = msg.group;
  if (!group) return "Isso é no grupo.";
  const me = phoneOf(msg.sender);
  const store = await load();
  const incoming = pendingFor(store, group, me);
  if (!incoming) return "Não há pedido esperando você.";
  if (incoming.state === "pedido-separacao" || incoming.state === "pedido-casamento") {
    incoming.state = incoming.previous || "namoro";
    incoming.at = Date.now();
    await writeStore("social", store);
    return `*${me}* recusou o pedido. O relacionamento continua.`;
  }
  const key = Object.keys(store).find((item) => store[item] === incoming);
  delete store[key];
  await writeStore("social", store);
  return `*${me}* recusou o pedido de namoro.`;
}

export async function celibar(msg) {
  const group = msg.group;
  if (!group) return "Isso é no grupo.";
  const me = phoneOf(msg.sender);
  const store = await load();
  let removed = 0;
  for (const key of Object.keys(store)) {
    const row = store[key];
    if (row.group === group && row.people.includes(me)) {
      delete store[key];
      removed += 1;
    }
  }
  await writeStore("social", store);
  return removed ? `Você encerrou *${removed}* relacionamento(s) neste grupo.` : "Você já não tinha ninguém aqui.";
}

export async function coisar(msg, mention) {
  const group = msg.group;
  if (!group) return "Isso é no grupo.";
  const me = phoneOf(msg.sender);
  const other = mention || "alguém do grupo";
  return `*${me}* ${COISAR[Math.floor(Math.random() * COISAR.length)]} com *${other}*.`;
}

export async function trair(msg, mention) {
  const group = msg.group;
  if (!group) return "Isso é no grupo.";
  if (!mention) return "Marca a pessoa: *!trair @*.";
  const me = phoneOf(msg.sender);
  const store = await load();
  const row = activeOf(store, group, me);
  if (!row) return "Você não está em um relacionamento para trair.";
  row.betrayals.push({ with: mention, at: Date.now() });
  await writeStore("social", store);
  const other = row.people.find((phone) => phone !== me);
  return `*${me}* traiu *${other}* com *${mention}*. Ficou na ficha. O relacionamento continua.`;
}

export async function ficha(msg) {
  const group = msg.group;
  if (!group) return "A ficha é no grupo.";
  const me = phoneOf(msg.sender);
  const store = await load();
  const row = Object.values(store).find((item) => item.group === group && item.people.includes(me) && !item.state.startsWith("pedido"));
  if (!row) return "Você não tem relacionamento neste grupo.";
  const other = row.people.find((phone) => phone !== me);
  const extras = row.betrayals.length ? `\nTraições na ficha: *${row.betrayals.length}*.` : "";
  return `Você está em *${row.state}* com *${other}*.${extras}`;
}

export async function lista(msg) {
  const group = msg.group;
  if (!group) return "A lista é no grupo.";
  const store = await load();
  const rows = Object.values(store).filter((item) => item.group === group && (item.state === "namoro" || item.state === "casamento"));
  if (!rows.length) return "Ninguém está junto neste grupo.";
  return rows.map((item) => `${item.people[0]} e ${item.people[1]} — ${item.state}`).join("\n");
}
