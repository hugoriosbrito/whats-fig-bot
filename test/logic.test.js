import test from "node:test";
import assert from "node:assert/strict";
import {
  pintoScore,
  measurePinto,
  scrambleWord,
  scoreStop,
  parseStopResponse,
  regenCount,
  spinSlots,
  slotPayout,
  pickFishWeight,
  SLOT_MAX_COINS,
  BAIT_MAX,
} from "../logic.js";
import { menuCategory, menuHome } from "../menu.js";

test("nota do pinto fica entre 0 e 1000 nos extremos", () => {
  assert.equal(pintoScore(3, 5, 8, 30), 0);
  assert.equal(pintoScore(12, 25, 18, 0), 1000);
  const mid = pintoScore(7.5, 15, 13, 0);
  assert.ok(mid > 400 && mid < 800);
});

test("medição sorteada cabe nas faixas", () => {
  const sample = measurePinto(() => 0.5);
  assert.ok(sample.flaccid >= 3 && sample.flaccid <= 12);
  assert.ok(sample.erect >= sample.flaccid && sample.erect <= 25);
  assert.ok(sample.score >= 0 && sample.score <= 1000);
});

test("anagrama não devolve a palavra quando há letras diferentes", () => {
  const mixed = scrambleWord("barco", () => 0.1);
  assert.notEqual(mixed, "barco");
  assert.equal([...mixed].sort().join(""), [..."barco"].sort().join(""));
  assert.equal(scrambleWord("aaa"), "aaa");
});

test("stop dá 10 para única, 5 para repetida e 0 para letra errada", () => {
  const scores = scoreStop("b", [
    { user: "a", values: { fruta: "banana", animal: "bode" } },
    { user: "c", values: { fruta: "banana", animal: "gato" } },
  ]);
  assert.equal(scores.a, 15);
  assert.equal(scores.c, 5);
});

test("stop lê categoria: palavra", () => {
  const values = parseStopResponse("fruta: banana, animal: bode", ["fruta", "animal", "cor"]);
  assert.deepEqual(values, { fruta: "banana", animal: "bode" });
});

test("isca e moeda regeneram pelo relógio", () => {
  const hour = 60 * 60 * 1000;
  const bait = regenCount(0, 3 * hour, hour, 1, BAIT_MAX);
  assert.equal(bait.have, 4);
  const coins = regenCount(0, 2 * 30 * 60 * 1000, 30 * 60 * 1000, SLOT_MAX_COINS, SLOT_MAX_COINS);
  assert.equal(coins.have, SLOT_MAX_COINS);
});

test("slots pagam moeda só quando acerta", () => {
  assert.equal(slotPayout("miss"), 0);
  assert.equal(slotPayout("pair"), 1);
  assert.ok(slotPayout("triple", () => 0) >= 3);
  const spin = spinSlots(() => 0);
  assert.equal(spin.kind, "triple");
  assert.ok(pickFishWeight(() => 0) < pickFishWeight(() => 1));
});

test("menu lista os comandos da categoria", () => {
  assert.match(menuHome(false).text, /Figurinhas/);
  assert.match(menuCategory("jogos").text, /!pescar/);
  assert.match(menuCategory("jogos").text, /!anagrama/);
  assert.match(menuCategory("5").text, /!pinto/);
  assert.equal(menuCategory("naoexiste"), null);
});
