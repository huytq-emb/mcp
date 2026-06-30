import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { FIGURE_INDEX_SCHEMA_VERSION, FIGURE_SEMANTIC_SCHEMA_VERSION, PAGE_CACHE_SCHEMA_VERSION } from "../../src/core/runtime-constants.js";
import { atomicWriteJson, getPdfSourceInfo, safeFigureSemanticIndexPath, safeFiguresIndexPath, safePagesCachePath, safePdfPath } from "../../src/core/runtime-helpers.js";
import { analyzeFigureSemantics } from "../../src/domains/figure-semantics.js";
import { classifyFigureType } from "../../src/figure/figureTypeClassifier.js";
import { normalizeOcrBlock } from "../../src/figure/ocrNormalization.js";
import { parseTimingDiagram } from "../../src/figure/timingDiagramParser.js";
import { parseSequenceDiagram } from "../../src/figure/sequenceDiagramParser.js";
import { parseStateMachine } from "../../src/figure/stateMachineParser.js";
import { parseBlockDiagram } from "../../src/figure/blockDiagramParser.js";
import { createRuntimeToolRegistry } from "../../src/mcp/runtime-registry.js";
import { PUBLIC_TOOL_NAMES } from "../../src/mcp/tool-definitions.js";
import { artifactPathsForStatus, normalizeArtifactName } from "../../src/services/jobs.js";

const figure5718Text = [
  "Figure 5.7-18 Example of GTCCRA and GTCCRB Double Buffer Operation with Input Capture at Both Edges of GTIOCnB Input, Saw Waves in Up-counting, and GTCNT Counter Cleared at Both Edges of GTIOCnB Input",
  "GTCCRB register aaaa bbbb cccc",
  "Buffer transfer at input capture",
  "GTCCRE register aaaa bbbb",
  "GTCCRF register aaaa",
  "1 Set operating mode and Set the operating mode with the GTCR.MD[2:0] bits and count clear source with the GTCSR register.",
  "7 Set buffer operation Set buffer operation with the CCRA and CCRB bits in the GTBER register.",
].join("\n");

test("figure-type classifier recognizes timing diagram semantics from caption/OCR text", () => {
  const result = classifyFigureType({
    title: "GTCCRA and GTCCRB Double Buffer Operation",
    caption: figure5718Text,
    page: 1190,
    figureId: "p1190_f001",
  });
  assert.equal(result.figure_type, "timing_diagram");
  assert.ok(result.confidence >= 0.55);
  assert.match(result.reasons.join("\n"), /timing|waveform|counter|edge/i);
});

test("timing parser extracts GTIOCnB, GTCNT, capture, clear, and buffer semantics", () => {
  const parsed = parseTimingDiagram({
    caption: figure5718Text,
    pageText: figure5718Text,
    page: 1190,
    figureId: "p1190_f001",
  });
  assert.equal(parsed.signals.some((signal) => signal.name === "GTIOCnB"), true);
  assert.equal(parsed.signals.some((signal) => signal.name === "GTCNT" && signal.kind === "counter"), true);
  assert.equal(parsed.events.some((event) => event.edge === "rising" && event.signal === "GTIOCnB"), true);
  assert.equal(parsed.events.some((event) => event.edge === "falling" && event.signal === "GTIOCnB"), true);
  assert.equal(parsed.register_actions.some((action) => action.register === "GTCCRA" && action.action === "input_capture"), true);
  assert.equal(parsed.register_actions.some((action) => action.register === "GTCCRB" && action.action === "buffer_transfer"), true);
  assert.equal(parsed.counter_actions.some((action) => action.counter === "GTCNT" && action.action === "clear"), true);
  assert.match(parsed.engineering_inferences.map((item) => item.statement).join("\n"), /Input capture|GTCNT|buffer/i);
  assert.match(parsed.uncertainties.join("\n"), /waveform geometry/i);
});

test("sequence parser extracts numbered hardware flow steps with source text", () => {
  const parsed = parseSequenceDiagram({
    pageText: [
      "1 Set operating mode and Set the operating mode with the GTCR.MD[2:0] bits.",
      "2 Select count clock Select the count clock with the GTCR.TPCS[3:0] bits.",
      "3 Start count operation Set the GTCR.CST bit to 1b to start count operation.",
    ].join("\n"),
  });
  assert.equal(parsed.sequence_steps.length, 3);
  assert.equal(parsed.sequence_steps[0].step, 1);
  assert.match(parsed.sequence_steps[0].source_text, /GTCR\.MD/);
  assert.equal(parsed.edges.some((edge) => edge.kind === "ordered_step"), true);
});

test("state parser extracts states and weak transitions from text", () => {
  const parsed = parseStateMachine({
    ocrBlocks: [
      { text_normalized: "Reset state", confidence: 0.9 },
      { text_normalized: "Idle state", confidence: 0.9 },
      { text_normalized: "Idle state -> Running state", confidence: 0.8 },
      { text_normalized: "Running state transitions to Error state when timeout occurs", confidence: 0.8 },
    ],
  });
  assert.equal(parsed.states.some((state) => /Reset/i.test(state.name)), true);
  assert.equal(parsed.transitions.some((transition) => /Idle/i.test(transition.from) && /Running/i.test(transition.to)), true);
  assert.equal(parsed.transitions.some((transition) => /timeout/i.test(transition.condition)), true);
});

test("block parser extracts blocks and explicit candidate edges", () => {
  const parsed = parseBlockDiagram({
    ocrBlocks: [
      { text_normalized: "DMA Controller", confidence: 0.9 },
      { text_normalized: "AXI Bus", confidence: 0.9 },
      { text_normalized: "DMA Controller -> AXI Bus", confidence: 0.8 },
      { text_normalized: "IRQ output from DMA Controller to Interrupt Controller", confidence: 0.8 },
    ],
  });
  assert.equal(parsed.blocks.some((block) => block.name === "DMA Controller" && block.kind === "dma"), true);
  assert.equal(parsed.blocks.some((block) => block.name === "AXI Bus" && block.kind === "bus"), true);
  assert.equal(parsed.edges.some((edge) => edge.from === "DMA Controller" && edge.to === "AXI Bus"), true);
  assert.match(parsed.uncertainties.join("\n"), /not verified/i);
});

test("OCR normalization preserves original text and fixes register-like tokens", () => {
  const block = normalizeOcrBlock({ text: "GTCCR $ _B $", confidence: 0.91, bbox: [1, 2, 3, 4] });
  assert.equal(block.text_original, "GTCCR $ _B $");
  assert.equal(block.text_normalized, "GTCCRB");
  assert.equal(block.token_type, "register");
  assert.deepEqual(block.candidates.slice(0, 1), ["GTCCRB"]);
  assert.deepEqual(block.bbox, [1, 2, 3, 4]);
});

test("figure semantic MCP tools are advertised and handled", () => {
  const registry = createRuntimeToolRegistry();
  for (const name of ["analyze_figure_semantics", "get_figure_semantics", "list_figure_semantics", "search_figure_semantics", "rebuild_figure_semantics"]) {
    assert.equal(PUBLIC_TOOL_NAMES.includes(name), true, name);
    assert.equal(registry.has(name), true, name);
  }
});

test("figure semantic artifact contract is exposed to control-plane status", () => {
  assert.equal(FIGURE_SEMANTIC_SCHEMA_VERSION, 1);
  assert.equal(normalizeArtifactName("figure_semantic"), "figure_semantic");
  assert.equal(normalizeArtifactName("figure-semantic"), "figure_semantic");
  assert.equal(normalizeArtifactName("semantics"), "figure_semantic");

  const filename = "manual.pdf";
  const statusEntry = artifactPathsForStatus(filename).find((entry) => entry.key === "figure_semantic");
  assert.equal(statusEntry.optional, true);
  assert.equal(statusEntry.schemaVersion, FIGURE_SEMANTIC_SCHEMA_VERSION);
  assert.equal(statusEntry.path, safeFigureSemanticIndexPath(filename));
});

test("figure semantic analysis supports caption-only records without bbox or OCR", async () => {
  const filename = `unit-figure-semantic-${Date.now()}.pdf`;
  const pdfPath = safePdfPath(filename);
  const figuresPath = safeFiguresIndexPath(filename);
  const pagesPath = safePagesCachePath(filename);
  const semanticPath = safeFigureSemanticIndexPath(filename);
  try {
    await fs.mkdir(path.dirname(pdfPath), { recursive: true });
    await fs.writeFile(pdfPath, "unit pdf bytes");
    const source = await getPdfSourceInfo(filename);
    const pageText = "Figure 1 DMA Controller -> AXI Bus\nDMA Controller block diagram";
    await atomicWriteJson(figuresPath, {
      schemaVersion: FIGURE_INDEX_SCHEMA_VERSION,
      filename,
      source,
      sourceFingerprint: `${Number(source.size || 0)}:${Math.round(Number(source.mtimeMs || 0))}`,
      figureCount: 1,
      figures: [{
        figure_id: "p0001_caption",
        id: "p0001_caption",
        legacy_ids: [],
        aliases: [],
        page: 1,
        bbox: [],
        image_path: "",
        image_access: { local_path: "", exists: false, agent_should_open_as_image: true },
        caption: "Figure 1 DMA Controller -> AXI Bus",
        title: "DMA block diagram",
        kind: "block-diagram",
        type: "Figure",
        confidence: 80,
      }],
    });
    await atomicWriteJson(pagesPath, {
      schemaVersion: PAGE_CACHE_SCHEMA_VERSION,
      filename,
      source,
      pageCount: 1,
      pages: [{ page: 1, text: pageText }],
    });

    const result = await analyzeFigureSemantics(filename, { figure_id: "p0001_caption" });
    assert.equal(result.cached, false);
    assert.equal(result.record.figure_id, "p0001_caption");
    assert.deepEqual(result.record.bbox, []);
    assert.equal(result.record.figure_type, "block_diagram");
    assert.equal(result.record.provenance.cached_ocr, false);
  } finally {
    await fs.rm(pdfPath, { force: true }).catch(() => {});
    await fs.rm(figuresPath, { force: true }).catch(() => {});
    await fs.rm(pagesPath, { force: true }).catch(() => {});
    await fs.rm(semanticPath, { force: true }).catch(() => {});
  }
});
