import assert from "node:assert/strict";
import test from "node:test";
import { coverageQueriesFor } from "../../eval/semantic/coverage-queries.js";

for (const subsystem of ["ethernet", "dma", "gpio-pinctrl", "watchdog", "pwm-timer", "usb"]) {
  test(`semantic coverage includes 20 realistic ${subsystem} query classes`, () => {
    const queries = coverageQueriesFor(subsystem);
    assert.ok(queries.length >= 20);
    assert.equal(new Set(queries.map((entry) => entry.id)).size, queries.length);
    assert.equal(queries.some((entry) => entry.id.includes("locator")), true);
    assert.equal(queries.some((entry) => entry.id.includes("alias")), true);
    assert.equal(queries.some((entry) => /offset|reset|access/i.test(entry.query)), true);
    assert.equal(queries.some((entry) => /sequence|write order|written first|completes/i.test(entry.query)), true);
    assert.equal(queries.some((entry) => /caution|restriction|must not|avoid/i.test(entry.query)), true);
    assert.equal(queries.some((entry) => entry.includeOcr), true);
    assert.equal(queries.some((entry) => entry.id === "short-symbol" && entry.register), true);
    assert.equal(queries.every((entry) => entry.expectation && typeof entry.expectation === "object" && entry.expectation.type), true);
    assert.equal(queries.some((entry) => entry.expectation.type === "negative"), true);
    assert.equal(queries.filter((entry) => entry.expectation.type !== "runtime-only").every((entry) => Object.keys(entry.expectation).length > 1), true);
  });
}

test("coverage expectation classification treats clock as a register query, not a lock sequence", () => {
  for (const subsystem of ["ethernet", "pwm-timer", "usb"]) {
    const clock = coverageQueriesFor(subsystem).find((entry) => entry.id === "clock");
    assert.equal(clock.expectation.type, "entity");
    assert.deepEqual(clock.expectation.requiredEntityTypes, ["register"]);
  }
  assert.equal(coverageQueriesFor("gpio-pinctrl").find((entry) => entry.id === "lock").expectation.type, "sequence");
});

test("numbered sequence probes remain sequences and unsupported GBETH probes have individual manual-backed reasons", () => {
  assert.equal(coverageQueriesFor("dma").find((entry) => entry.id === "sequence2").expectation.type, "sequence");
  assert.equal(coverageQueriesFor("watchdog").find((entry) => entry.id === "sequence3").expectation.type, "sequence");
  const ethernet = coverageQueriesFor("ethernet");
  const shortSymbol = ethernet.find((entry) => entry.id === "short-symbol");
  const sequence = ethernet.find((entry) => entry.id === "sequence");
  const sequenceStop = ethernet.find((entry) => entry.id === "sequence-stop");
  assert.equal(shortSymbol.expectation.type, "runtime-only");
  assert.match(shortSymbol.expectation.reason, /page 1420.*TXEN.*pin name/i);
  assert.equal(sequence.expectation.type, "runtime-only");
  assert.match(sequence.expectation.reason, /pages 1417-1420/i);
  assert.match(sequence.expectation.reason, /no initialization procedure/i);
  assert.equal(sequenceStop.expectation.type, "runtime-only");
  assert.match(sequenceStop.expectation.reason, /pages 1417-1420/i);
  assert.match(sequenceStop.expectation.reason, /no transmitter-stop procedure/i);
  assert.equal(new Set([shortSymbol.expectation.reason, sequence.expectation.reason, sequenceStop.expectation.reason]).size, 3);
});

test("DMA reserved-area runtime coverage and active-transfer semantics remain separate", () => {
  const dma = coverageQueriesFor("dma");
  const reserved = dma.find((entry) => entry.id === "caution-reserved-area");
  const active = dma.find((entry) => entry.id === "caution-active-transfer");
  assert.equal(reserved.query, "What DMA reserved-bit cautions apply?");
  assert.equal(reserved.expectation.type, "runtime-only");
  assert.match(reserved.expectation.reason, /page 819/i);
  assert.match(reserved.expectation.reason, /no dedicated entity for caution 1/i);
  assert.equal(active.query, "What DMA write restrictions apply while a transfer is in progress?");
  assert.equal(active.topK, 20);
  assert.deepEqual(active.expectation, {
    type: "text",
    requiredText: "Do not modify the registers by software while DMA transfer is in progress",
    allowedPages: [819],
    requiredEntityTypes: ["caution"],
  });
});
