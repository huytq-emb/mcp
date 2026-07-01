import test from "node:test";
import assert from "node:assert/strict";
import { detectVisualSemanticIntent, withVisualSemanticGuard } from "../../src/core/visual-guard.js";
import { formatSearchResults, formatHybridSearchResults } from "../../src/services/search.js";
import { formatLayoutExtractedTables } from "../../src/domains/manual-intelligence.js";
import { formatToolUsage } from "../../src/workflows/manual-workflow.js";

test("visual semantic detector catches visual table/figure intents", () => {
  const samples = [
    "Table 8.2-5 Data Formats Handled in the SCU",
    "MSB and LSB bit arrangement",
    "data format for BUSIF",
    "timing waveform table",
    "Figure 10.1 clock timing diagram",
  ];
  for (const sample of samples) {
    const detected = detectVisualSemanticIntent(sample);
    assert.equal(detected.triggered, true, sample);
    assert.equal(detected.artifact_index, ".figures.json");
    assert.equal(detected.text_only_answer_forbidden, true);
    assert.ok(detected.required_next_tools.includes("search_figures"));
    assert.ok(detected.required_next_tools.includes("get_figure_context_pack"));
    assert.ok(detected.required_next_tools.includes("get_figure_image"));
  }
  assert.equal(detectVisualSemanticIntent("plain register description for CTRL enable bit").triggered, false);
});

test("search text formatters emit visual guard for visual-table query", () => {
  const query = "Table 8.2-5 Data Formats Handled in the SCU";
  const text = formatSearchResults([], query);
  for (const expected of ["VISUAL SEMANTIC GUARD", "locator evidence only", "Do not answer semantic visual content", "Visual tables are indexed in .figures.json", "search_figures", "get_figure_context_pack", "get_figure_image", "image_path is only a locator", "transport=\"metadata\"", "NO_IMAGE_INPUT", "image_path is only a locator"]) {
    assert.match(text, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }

  const hybrid = formatHybridSearchResults({ filename: "manual.pdf", query, intent: ["table"], register: "", expandedTerms: [], context: { sectionMatches: [], registerMatches: [], sequenceMatches: [], cautionMatches: [], candidateCount: 0, fullChunkCount: 0 }, results: [] });
  assert.match(hybrid, /VISUAL SEMANTIC GUARD/);
  assert.match(hybrid, /search_figures/);
});

test("read page/chunk formatter guard helper emits read warning from content", () => {
  const output = withVisualSemanticGuard("--- Page 10 ---\nTable 8.2-5 Data Formats Handled in the SCU\nMSB LSB bit arrangement", "Table 8.2-5 Data Formats Handled in the SCU\nMSB LSB bit arrangement", { mode: "read" });
  assert.match(output, /VISUAL SEMANTIC GUARD/);
  assert.match(output, /Use this text only to locate or cross-check/);
  assert.match(output, /Do not provide semantic analysis from this text alone/);
  assert.match(output, /transport="metadata"/);
  assert.match(output, /NO_IMAGE_INPUT/);
  assert.match(output, /image_path is only a locator/);
});

test("extract layout tables warns visual semantics are not table truth", () => {
  const text = formatLayoutExtractedTables({ filename: "manual.pdf", startPage: 1, endPage: 1, tables: [{ tableId: "t1", page: 1, kind: "layout-table", confidence: "medium", columns: [{ index: 0, x: 1 }], rows: [{ rawCells: ["Table 8.2-5", "MSB", "LSB", "data format"], cells: ["Table 8.2-5", "MSB", "LSB", "data format"] }] }] }, "all");
  assert.match(text, /coordinate\/text-item extraction/i);
  assert.match(text, /not visual semantic truth/i);
  assert.match(text, /search_figures -> get_figure_context_pack -> get_figure_image/i);
});

test("table coverage report model supports visual-table-in-figures-index status", () => {
  const report = { data_model: { tables_json: ".tables.json covers structured/layout text tables only", figures_json: "Captioned visual tables are tracked in .figures.json as visual-table records" }, rows: [{ status: "visual-table-in-figures-index" }] };
  const text = JSON.stringify(report);
  assert.match(text, /visual-table-in-figures-index/);
  assert.match(text, /\.tables\.json covers structured\/layout text tables only/);
  assert.match(text, /visual tables are tracked in \.figures\.json/i);
});

test("tool usage catalog explains visual table workflow", () => {
  const text = formatToolUsage();
  assert.match(text, /Visual\/captioned tables live in \.figures\.json/);
  assert.match(text, /search_figures -> get_figure_context_pack/);
  assert.match(text, /text extraction is locator\/supporting only/i);
});
