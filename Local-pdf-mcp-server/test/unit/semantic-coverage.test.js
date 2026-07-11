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
