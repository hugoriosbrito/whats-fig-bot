import { isAdmin, phoneOf } from "./limits.js";
import { readStore, writeStore } from "./store.js";

export const BATCH_SIZE = 5;
export const GAP_MS = 20_000;
export const BATCH_GAP_MS = 60_000;
const MAX_CHARS = 500;

const NAME = "announce";
let running = null;

export function planBatches({ admin, text, phones, size = BATCH_SIZE }) {
  const clean = String(text || "").trim();
  if (!admin) return { ok: false, reason: "admin" };
  if (!clean) return { ok: false, reason: "empty" };
  if (clean.length > MAX_CHARS) return { ok: false, reason: "long" };
  const list = [...new Set(phones.filter(Boolean))];
  const batches = [];
  for (let i = 0; i < list.length; i += size) batches.push(list.slice(i, i + size));
  return { ok: true, text: clean, batches };
}

async function loadJob() {
  const store = await readStore(NAME);
  return store.current || null;
}

async function saveJob(job) {
  await writeStore(NAME, job ? { current: job } : {});
}

function wait(ms, state) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    state.cancelWait = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

export function announceBusy() {
  return Boolean(running);
}

export async function stopAnnounce() {
  if (!running) return false;
  running.stopped = true;
  running.cancelWait?.();
  return true;
}

// send(jid, text) devolve true se saiu. O admin recebe o resumo no fim.
export async function startAnnounce({ sock, adminJid, text, phones, send }) {
  if (running) return { ok: false, reason: "busy" };
  const plan = planBatches({ admin: true, text, phones });
  if (!plan.ok) return plan;
  if (!plan.batches.length) return { ok: false, reason: "nobody" };

  const flat = plan.batches.flat();
  const job = { text: plan.text, phones: flat, next: 0, sent: 0, failed: 0 };
  await saveJob(job);
  const state = { stopped: false, cancelWait() {} };
  running = state;

  const run = (async () => {
    try {
      await send(adminJid, `Vou avisar *${flat.length}* pessoas, em lotes de ${BATCH_SIZE}.`);
      while (job.next < job.phones.length && !state.stopped) {
        const phone = job.phones[job.next];
        const jid = `${phone}@s.whatsapp.net`;
        try {
          const ok = await send(jid, job.text);
          if (ok === false) job.failed += 1;
          else job.sent += 1;
        } catch {
          job.failed += 1;
        }
        job.next += 1;
        await saveJob(job);
        if (state.stopped || job.next >= job.phones.length) break;
        const endOfBatch = job.next % BATCH_SIZE === 0;
        await wait(endOfBatch ? BATCH_GAP_MS : GAP_MS, state);
      }
      const status = state.stopped ? "Anúncio interrompido." : "Anúncio terminou.";
      await send(adminJid, `${status}\nEnviados: *${job.sent}*. Falhas: *${job.failed}*. Total: *${job.phones.length}*.`);
    } finally {
      await saveJob(null);
      if (running === state) running = null;
    }
  })();

  return { ok: true, total: flat.length, run };
}

export async function knownPhones() {
  const store = await readStore("known");
  return Object.keys(store);
}

export async function rememberUser(jid) {
  if (isAdmin(jid)) return;
  const phone = phoneOf(jid);
  if (!phone || phone.length < 10) return;
  const store = await readStore("known");
  if (store[phone]) return;
  store[phone] = Date.now();
  await writeStore("known", store);
}

export async function resumeAnnounce(send, adminJid) {
  const job = await loadJob();
  if (!job || running) return;
  await startAnnounce({
    adminJid,
    text: job.text,
    phones: job.phones.slice(job.next),
    send,
  });
}
