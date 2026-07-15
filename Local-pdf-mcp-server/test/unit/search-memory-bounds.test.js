import assert from "node:assert/strict";
import test from "node:test";
import { createAppContext } from "../../src/core/app-context.js";
import { wireRuntimePorts } from "../../src/app/runtime-wiring.js";
import {
  buildHybridQuery,
  rankNativeSearchChunks,
  rankNativeSearchChunksCached,
  scoreChunk,
  selectHybridCandidateChunks,
  updateBitfieldCandidate,
} from "../../src/services/search.js";

wireRuntimePorts(createAppContext());

test("field-local evidence does not occupy the physical bit position", () => {
  const candidates = new Map();
  const common = { filename: "manual.pdf", register: "DMACm_DCTRL", bitfield: "LWCA", page: 843, access: "R/W", reset: "0", evidenceLines: [] };
  updateBitfieldCandidate(candidates, { ...common, bitRange: "3:0", bitPositionRange: "unknown", fieldBitRange: "3:0", source: "field-layout" });
  let entry = [...candidates.values()][0];
  assert.equal(entry.bitPositionRange, "unknown");
  assert.equal(entry.fieldBitRange, "3:0");
  assert.equal(entry.bitRange, "3:0");

  updateBitfieldCandidate(candidates, { ...common, bitRange: "31:28", bitPositionRange: "31:28", fieldBitRange: "3:0", source: "physical-row" });
  entry = [...candidates.values()][0];
  assert.equal(entry.bitPositionRange, "31:28");
  assert.equal(entry.fieldBitRange, "3:0");
  assert.equal(entry.bitRange, "31:28");
});

function chunk(index, text) {
  return {
    id: `manual.pdf:p${index + 1}:c0`,
    filename: "manual.pdf",
    page: index + 1,
    chunkIndex: 0,
    text,
    searchText: text.toLowerCase(),
    headings: [],
    registers: [],
    bitFields: [],
    symbols: [],
  };
}

test("native lexical ranking scans once and returns the exact global top-k", () => {
  const values = Array.from({ length: 10_000 }, (_, index) => chunk(index, `needle ${"needle ".repeat(index % 97)}`));
  let iterations = 0;
  const observed = new Proxy(values, {
    get(target, property, receiver) {
      if (property === Symbol.iterator) iterations += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const actual = rankNativeSearchChunks(observed, "needle", 5);
  const expected = values.map((value) => ({ value, score: scoreChunk(value, "needle") }))
    .sort((left, right) => right.score - left.score || left.value.page - right.value.page)
    .slice(0, 5)
    .map((item) => item.value.id);
  assert.equal(iterations, 1);
  assert.equal(actual.length, 5);
  assert.deepEqual(actual.map((item) => item.id), expected);
});

test("identical warm lexical queries reuse their bounded native result", () => {
  const values = Array.from({ length: 1_000 }, (_, index) => chunk(index, `status register ${index % 2 ? "status" : ""}`));
  let iterations = 0;
  const indexData = {
    chunks: new Proxy(values, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) iterations += 1;
        return Reflect.get(target, property, receiver);
      },
    }),
  };
  const first = rankNativeSearchChunksCached(indexData, "status register", 8);
  const second = rankNativeSearchChunksCached(indexData, "status register", 8);
  assert.equal(second, first);
  assert.equal(iterations, 1);
  assert.equal(second.length, 8);
});

test("hybrid candidate selection returns no corpus for an unrelated no-hit query", async () => {
  const indexData = { chunks: [chunk(0, "DMA start register sequence")] };
  const context = { relatedChunkIds: new Set(), relatedPages: new Set() };
  const noHit = await selectHybridCandidateChunks(
    "unit-search-memory-missing.pdf",
    indexData,
    buildHybridQuery("ZZQVNONEXISTENTTOKENX"),
    context,
    10,
  );
  assert.deepEqual(noHit, []);

  const fallbackHit = await selectHybridCandidateChunks(
    "unit-search-memory-missing.pdf",
    indexData,
    buildHybridQuery("DMA start"),
    context,
    10,
  );
  assert.deepEqual(fallbackHit.map((item) => item.id), [indexData.chunks[0].id]);
});
