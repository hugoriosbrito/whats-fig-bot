import test from "node:test";
import assert from "node:assert/strict";
import { planBatches } from "../announce.js";

test("anúncio recusa texto vazio e quem não é admin antes de montar lote", () => {
  assert.equal(planBatches({ admin: false, text: "oi", phones: ["1"] }).ok, false);
  assert.equal(planBatches({ admin: true, text: "   ", phones: ["1"] }).ok, false);
  assert.equal(planBatches({ admin: true, text: "x".repeat(501), phones: ["1"] }).ok, false);
});

test("anúncio sai em lotes de 5", () => {
  const phones = Array.from({ length: 12 }, (_, i) => String(i));
  const plan = planBatches({ admin: true, text: "novidade", phones });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.batches.map((batch) => batch.length), [5, 5, 2]);
  assert.equal(plan.batches.flat().join(","), phones.join(","));
});
