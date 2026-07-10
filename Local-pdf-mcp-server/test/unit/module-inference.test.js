import assert from "node:assert/strict";
import test from "node:test";
import { inferModuleCandidates, inferModuleType } from "../../src/workflows/driver-pack.js";
import { validateModuleInferenceProfiles } from "../../src/driver-profiles/module-inference.js";

test("declarative module inference returns ranked multi-label candidates", () => {
  assert.deepEqual(validateModuleInferenceProfiles(), { ok: true, errors: [] });
  const candidates = inferModuleCandidates("manual.pdf", [
    { name: "GBETH_DMA_CTRL", description: "Ethernet MAC DMA control" },
    { name: "USB_HOST_CTRL", description: "USB host control" },
  ], [{ title: "Ethernet MAC and DMA operation" }, { title: "USB host interface" }]);
  assert.ok(candidates.length >= 2);
  assert.equal(candidates[0].module, "ethernet");
  assert.equal(candidates.some((candidate) => candidate.module === "dmaengine"), true);
  assert.equal(candidates.some((candidate) => candidate.module === "usb"), true);
  assert.equal(inferModuleType("manual.pdf", [], [], "watchdog"), "watchdog");
});
