import test from "node:test";
import assert from "node:assert/strict";
import { remember, writeStore } from "../store.js";
import { namorar, casar, separar, recusar, ficha } from "../social.js";

function msg(phone, { mention = "", name = phone, mentionName = "" } = {}) {
  return {
    sender: `${phone}@s.whatsapp.net`,
    name,
    group: "grupo@g.us",
    mention,
    mentionName,
  };
}

test("quem aceita com o 9 a mais fecha o namoro", async () => {
  remember("social", {});
  const asked = await namorar(msg("5511911112222", { name: "Ana", mention: "5511888887777", mentionName: "Bia" }), "5511888887777");
  assert.match(asked.text, /Ana/);
  const accepted = await namorar(msg("55119888887777", { name: "Bia" }), "");
  assert.match(accepted, /namorando/);
  const card = await ficha(msg("5511911112222", { name: "Ana" }));
  assert.match(card, /namoro/);
});

test("casamento e separação acham o par mesmo com o número em outro formato", async () => {
  remember("social", {});
  await namorar(msg("5511911112222", { mention: "5511888887777", mentionName: "Bia" }), "5511888887777");
  await namorar(msg("55119888887777", { name: "Bia" }), "");
  const asked = await casar(msg("5511911112222", { mention: "55119888887777", mentionName: "Bia" }), "55119888887777");
  assert.match(asked.text, /casamento/);
  const married = await casar(msg("5511888887777", { name: "Bia" }), "");
  assert.match(married, /casaram/);
  const split = await separar(msg("5511911112222", { name: "Ana" }));
  assert.match(split.text, /terminar/);
  const done = await separar(msg("55119888887777", { name: "Bia" }));
  assert.match(done, /separaram/);
});

test("recusa apaga o pedido guardado", async () => {
  remember("social", {});
  await namorar(msg("5511911112222", { mention: "5511888887777" }), "5511888887777");
  const refused = await recusar(msg("55119888887777", { name: "Bia" }));
  assert.match(refused, /recusou/);
  const again = await namorar(msg("55119888887777", { name: "Bia" }), "");
  assert.match(again, /Marca a pessoa/);
  await writeStore("social", {});
});
