import assert from "node:assert/strict";
import test from "node:test";
import { buildSequenceEdges, extractOrderedWritePair, extractStructuredSequenceSteps, formatPersistentSequenceResult, isSequenceBoilerplate, isTrustedSequenceTopic, sequenceConfidenceFromScore, sequenceSemanticAnchorScore, sequenceStructureStatus } from "../../src/domains/sequences.js";

test("sequence v2 extracts ordered register steps with values and conditions", () => {
  const chunks = [{ id: "manual.pdf:p10:c0", page: 10, registers: ["CTRL", "STAT"], text: "Operation Procedure\n1. Write 1 to CTRL.EN to start operation.\n2. Poll STAT.DONE until it becomes 1." }];
  const registers = { registers: [{ displayName: "CTRL", aliases: ["CTRL"] }, { displayName: "STAT", aliases: ["STAT"] }] };
  const bitfields = { bitfields: [{ register: "CTRL", bitfield: "EN" }, { register: "STAT", bitfield: "DONE" }] };
  const steps = extractStructuredSequenceSteps(chunks, registers, bitfields);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].operation, "write");
  assert.equal(steps[0].register, "CTRL");
  assert.equal(steps[0].bitfield, "EN");
  assert.equal(steps[0].value, "1");
  assert.equal(steps[1].operation, "poll");
  assert.equal(sequenceStructureStatus(steps), "complete");
  assert.deepEqual(buildSequenceEdges(steps), [{ from: 1, to: 2, relation: "before" }]);
});

test("sequence v2 expands ordered writes embedded in one manual sentence", () => {
  assert.deepEqual(extractOrderedWritePair("The counter is refreshed by writing 00h and then writing FFh to WDTRR."), { firstValue: "00h", secondValue: "FFh", registerHint: "WDTRR" });
  const steps = extractStructuredSequenceSteps([{ id: "m:p1016:c0", page: 1016, registers: ["WDTm_WDTRR"], text: "Refresh operation\nThe counter is refreshed by writing 00h and then writing FFh to WDTRR." }], { registers: [{ displayName: "WDTm_WDTRR", aliases: ["WDTRR"], pages: [1016] }] }, { bitfields: [] });
  assert.deepEqual(steps.map((step) => step.value), ["00h", "FFh"]);
  assert.equal(sequenceStructureStatus(steps), "complete");
  const multiline = extractStructuredSequenceSteps([{ id: "m:p1016:c0", page: 1016, registers: ["WDTRR"], text: "Watchdog Timer (WDT)\nRefresh Operation\nWrite to the WDT Refresh Register (WDTRR) in the\norder of values from 00h to FFh." }], { registers: [{ displayName: "WDTRR", aliases: ["WDTRR"], pages: [1016] }, { displayName: "WDTm_WDTRR", aliases: ["WDTRR"], pages: [1007] }] }, { bitfields: [] });
  assert.deepEqual(multiline.slice(0, 2).map((step) => [step.register, step.value]), [["WDTm_WDTRR", "00h"], ["WDTm_WDTRR", "FFh"]]);
});

test("watchdog refresh semantic anchor outranks generic reset sequence text", () => {
  const anchored = sequenceSemanticAnchorScore({ text: "5.4.3.3 Refresh Operation. Write to the WDT Refresh Register (WDTRR) in the order of values from 00h to FFh." }, "watchdog refresh");
  const generic = sequenceSemanticAnchorScore({ text: "The reset sequence by the WDT is as follows." }, "watchdog refresh");
  assert.ok(anchored >= 600);
  assert.equal(generic, 0);
});

test("sequence v2 rejects manual boilerplate and gates high confidence", () => {
  assert.equal(isSequenceBoilerplate("Otherwise, the correct operation of this LSI chip is not guaranteed"), true);
  assert.equal(isTrustedSequenceTopic("Settings other than the above are prohibited"), false);
  assert.equal(sequenceConfidenceFromScore(300, "unstructured"), "medium");
  assert.equal(sequenceConfidenceFromScore(300, "complete"), "high");
});


test("persistent sequence formatter includes related chunk reads without throwing", () => {
  const result = {
    sequencesIndex: {
      filename: "manual.pdf",
      createdAt: "2026-06-30T00:00:00.000Z",
    },
    topic: "enable channel",
    register: "DMACm_CHCTRL_n",
    persistentMatches: [
      {
        id: "manual.pdf:seq:enable-channel",
        topic: "enable channel",
        kind: "start",
        pages: [10],
        relatedRegisters: ["DMACm_CHCTRL_n"],
        relatedSections: [{ title: "Channel Enable", page: 10 }],
        confidence: "medium",
        structureStatus: "partial",
        score: 123,
        matchScore: 80,
        evidenceLines: ["Set the channel enable bit."],
        chunks: [
          {
            id: "manual.pdf:p10:c0",
            page: 10,
            score: 100,
          },
        ],
        steps: [
          {
            order: 1,
            operation: "enable",
            text: "Set channel enable.",
            register: "DMACm_CHCTRL_n",
            bitfield: "SETEN",
            evidence: { page: 10, chunkId: "manual.pdf:p10:c0" },
          },
        ],
        cautions: [],
      },
    ],
    fallback: null,
  };

  const output = formatPersistentSequenceResult(result);

  assert.match(output, /Persistent sequence result/);
  assert.match(output, /Suggested chunk read/);
  assert.match(output, /read_pdf_pages/);
  assert.match(output, /DMACm_CHCTRL_n/);
});
