import { initAuthCreds, BufferJSON, proto } from "@whiskeysockets/baileys";
import { readAuth, writeAuth, deleteAuth } from "./db.js";

function keyName(type, id) {
  return `${type}-${id}`.replaceAll("/", "__").replaceAll(":", "-");
}

async function readData(id) {
  const raw = await readAuth(id);
  return raw ? JSON.parse(raw, BufferJSON.reviver) : null;
}

async function writeData(id, value) {
  await writeAuth(id, JSON.stringify(value, BufferJSON.replacer));
}

export async function useMysqlAuthState() {
  const creds = (await readData("creds")) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        async get(type, ids) {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            let value = await readData(keyName(type, id));
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }));
          return data;
        },
        async set(data) {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = keyName(category, id);
              tasks.push(value ? writeData(key, value) : deleteAuth(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData("creds", creds),
  };
}
