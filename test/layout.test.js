import test from "node:test";
import assert from "node:assert/strict";
import * as sticker from "../sticker.js";
import * as link from "../link.js";

test("vídeo quadrato não avisa que vai ganhar borda", () => {
  assert.equal(typeof sticker.borderNote, "function");
  const note = sticker.borderNote([
    { kind: "video", width: 720, height: 720 },
  ], "fit");
  assert.equal(note, "");
});

test("vídeo vertical avisa que vai ganhar borda vazia nas laterais", () => {
  assert.equal(typeof sticker.borderNote, "function");
  const note = sticker.borderNote([
    { kind: "video", width: 720, height: 1280 },
  ], "fit");
  assert.match(note, /vertical/i);
  assert.match(note, /laterais/i);
  assert.doesNotMatch(note, /pretas/i);
});

test("vídeo sem dimensões conhecidas não avisa sobre borda", () => {
  assert.equal(typeof sticker.borderNote, "function");
  assert.equal(sticker.borderNote([{ kind: "video" }], "fit"), "");
});

test("Instagram usa a versão escolhida e só tenta as alternativas se o áudio faltar", () => {
  assert.equal(typeof link.videoLinkPlan, "function");
  const plan = link.videoLinkPlan("ig", {
    url: "https://cdninstagram/video.mp4",
    alternates: ["https://cdninstagram/alternativa.mp4"],
    hasAudio: true,
  });
  assert.deepEqual(plan.sources, [
    "https://cdninstagram/video.mp4",
    "https://cdninstagram/alternativa.mp4",
  ]);
  assert.equal(plan.cut, false);
  assert.equal(plan.audio, true);
});

test("vídeo sem áudio do Instagram não procura faixa nem alternativa", () => {
  assert.equal(typeof link.videoLinkPlan, "function");
  const plan = link.videoLinkPlan("ig", {
    url: "https://cdninstagram/video.mp4",
    alternates: ["https://cdninstagram/alternativa.mp4"],
    hasAudio: false,
  });
  assert.deepEqual(plan.sources, ["https://cdninstagram/video.mp4"]);
  assert.equal(plan.audio, false);
});

test("X mantém as alternativas e o corte intermediário", () => {
  assert.equal(typeof link.videoLinkPlan, "function");
  const plan = link.videoLinkPlan("x", {
    url: "https://twimg/video.mp4",
    alternates: ["https://twimg/alternativa.mp4"],
  });
  assert.deepEqual(plan.sources, [
    "https://twimg/video.mp4",
    "https://twimg/alternativa.mp4",
  ]);
  assert.equal(plan.cut, true);
  assert.equal(plan.audio, true);
});
