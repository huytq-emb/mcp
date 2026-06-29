import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createRuntimeToolRegistry } from "../../src/mcp/runtime-registry.js";
import { PUBLIC_TOOL_NAMES } from "../../src/mcp/tool-definitions.js";
import { buildSemanticEvidence, clearOcrHealthCache, getOcrHealth, selectInspectParser } from "../../src/services/ocr.js";
import { resolvePythonInterpreter } from "../../src/services/python-worker.js";
import { atomicWriteJson, clearJsonFileCache, getJsonFileCacheStats, getPdfSourceInfo, readJsonCached, safeFigureLookupIndexPath, safeFiguresIndexPath, safePagesCachePath, safePdfPath } from "../../src/core/runtime-helpers.js";

const execFileAsync = promisify(execFile);

function parseJsonResult(result) {
  return JSON.parse((result.content || []).map((item) => item.text || "").join("\n"));
}

async function createSyntheticPdf(filename) {
  const pdfPath = safePdfPath(filename);
  await fs.mkdir(path.dirname(pdfPath), { recursive: true });
  const interpreter = resolvePythonInterpreter({ rootDir: process.cwd() });
  const code = [
    "import fitz, sys",
    "doc = fitz.open()",
    "page = doc.new_page(width=220, height=180)",
    "page.draw_rect(fitz.Rect(40, 40, 180, 130), color=(0, 0, 0), width=1)",
    "page.insert_text((78, 88), 'DMA FIFO', fontsize=12)",
    "doc.save(sys.argv[1])",
    "doc.close()",
  ].join("; ");
  try {
    await execFileAsync(interpreter.command, [...(interpreter.argsPrefix || []), "-c", code, pdfPath], { cwd: process.cwd(), windowsHide: true });
    return pdfPath;
  } catch {
    await fs.rm(pdfPath, { force: true }).catch(() => {});
    return "";
  }
}

async function removeCacheFor(filename) {
  for (const dir of [
    path.join("indexes", "cache", "figure-images"),
    path.join("indexes", "cache", "figure-ocr"),
    path.join("indexes", "cache", "figure-structure"),
    path.join("indexes", "cache", "figure-vl"),
    path.join("indexes", "cache", "figure-semantic-evidence"),
    path.join("indexes", "cache", "page-context"),
  ]) {
    const entries = await fs.readdir(dir).catch(() => []);
    await Promise.all(entries
      .filter((entry) => entry.startsWith(`${filename}-`))
      .map((entry) => fs.rm(path.join(dir, entry), { force: true }).catch(() => {})));
  }
  await fs.rm(safePagesCachePath(filename), { force: true }).catch(() => {});
  await fs.rm(safeFiguresIndexPath(filename), { force: true }).catch(() => {});
  await fs.rm(safeFigureLookupIndexPath(filename), { force: true }).catch(() => {});
}

test("readJsonCached evicts old entries with bounded cache settings", async () => {
  const oldEntries = process.env.RENESAS_MCP_JSON_CACHE_MAX_ENTRIES;
  const oldBytes = process.env.RENESAS_MCP_JSON_CACHE_MAX_BYTES;
  process.env.RENESAS_MCP_JSON_CACHE_MAX_ENTRIES = "2";
  process.env.RENESAS_MCP_JSON_CACHE_MAX_BYTES = String(1024 * 1024);
  clearJsonFileCache();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-json-cache-"));
  try {
    for (let index = 0; index < 3; index += 1) {
      const filePath = path.join(root, `cache-${index}.json`);
      await fs.writeFile(filePath, JSON.stringify({ index }), "utf-8");
      assert.equal((await readJsonCached(filePath)).index, index);
    }
    const stats = getJsonFileCacheStats();
    assert.equal(stats.maxEntries, 2);
    assert.ok(stats.entries <= 2);
  } finally {
    clearJsonFileCache();
    if (oldEntries === undefined) delete process.env.RENESAS_MCP_JSON_CACHE_MAX_ENTRIES;
    else process.env.RENESAS_MCP_JSON_CACHE_MAX_ENTRIES = oldEntries;
    if (oldBytes === undefined) delete process.env.RENESAS_MCP_JSON_CACHE_MAX_BYTES;
    else process.env.RENESAS_MCP_JSON_CACHE_MAX_BYTES = oldBytes;
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test("ocr health preflight is cached for repeated OCR unavailable checks", async () => {
  clearOcrHealthCache();
  const first = await getOcrHealth();
  const second = await getOcrHealth();
  assert.equal(first.ocr_health_cache_hit, false);
  assert.equal(second.ocr_health_cache_hit, true);
});

test("legacy figure OCR/render tools are hidden compatibility handlers", () => {
  const registry = createRuntimeToolRegistry();
  for (const name of ["render_figure", "ocr_figure", "inspect_figure"]) {
    assert.equal(PUBLIC_TOOL_NAMES.includes(name), false, name);
    assert.equal(registry.has(name), true, name);
  }
  assert.equal(registry.advertisedCount, PUBLIC_TOOL_NAMES.length);
});

test("public figure registry advertises only retrieval-first figure tools", () => {
  for (const name of ["rebuild_figure_manifest", "list_figures", "search_figures", "get_figure_image", "get_figure_context_pack", "ocr_figure_for_search"]) {
    assert.equal(PUBLIC_TOOL_NAMES.includes(name), true, name);
  }
  for (const name of ["build_figures_index", "find_figure", "get_figure_context", "inspect_figure", "render_figure", "render_figure_page", "render_figure_region", "ocr_figure"]) {
    assert.equal(PUBLIC_TOOL_NAMES.includes(name), false, name);
  }
});

test("OCR health reports text structure and VL capability fields", async () => {
  clearOcrHealthCache();
  const health = await getOcrHealth({ force: true });
  assert.equal(typeof health.ocr?.text?.available, "boolean");
  assert.equal(typeof health.ocr?.structure?.available, "boolean");
  assert.equal(typeof health.ocr?.vl?.available, "boolean");
  assert.equal(health.ok, true);
});

test("inspect auto parser does not select VL unless explicitly enabled", () => {
  const timingHealth = {
    ocr: {
      available: true,
      text: { available: true },
      structure: { available: false },
      vl: { available: true },
    },
  };
  assert.equal(selectInspectParser("auto", "timing", timingHealth, {}), "ocr");
  assert.equal(selectInspectParser("auto", "timing", timingHealth, { RENESAS_MCP_AUTO_VL: "0" }), "ocr");
  assert.equal(selectInspectParser("auto", "timing", timingHealth, { RENESAS_MCP_AUTO_VL: "1" }), "vl");
  assert.equal(selectInspectParser("vl", "timing", timingHealth, {}), "vl");
  assert.equal(selectInspectParser("auto", "block_diagram", timingHealth, { RENESAS_MCP_AUTO_VL: "1" }), "ocr");

  const structureHealth = {
    ocr: {
      available: true,
      text: { available: true },
      structure: { available: true },
      vl: { available: true },
    },
  };
  assert.equal(selectInspectParser("auto", "timing", structureHealth, { RENESAS_MCP_AUTO_VL: "1" }), "structure");
});

test("semantic evidence extracts only unverified candidates from explicit text", () => {
  const semantic = buildSemanticEvidence({
    filename: "manual.pdf",
    render: { figure_id: "fig-p1-test", page: 1, bbox: [10, 20, 110, 120], image_path: "indexes/cache/figure-images/test.png" },
    figureType: "block_diagram",
    parser: "structure",
    raw: {
      itemCount: 5,
      items: [
        { text: "DMA Controller" },
        { text: "AXI Bus" },
        { text: "DMA Controller -> AXI Bus" },
      ],
      plainText: "RESET before rising edge of clock",
      markdown: "1. Enable DMA\n2. Wait for IRQ",
    },
  });

  assert.equal(semantic.schemaVersion, 1);
  assert.equal(semantic.parser, "structure");
  assert.equal(semantic.extracted_items.nodes.some((node) => node.label === "DMA Controller" && node.verified === false), true);
  assert.equal(semantic.extracted_items.nodes.some((node) => node.label === "AXI Bus" && node.type === "bus"), true);
  assert.equal(semantic.extracted_items.edges.length, 1);
  assert.deepEqual(
    {
      from: semantic.extracted_items.edges[0].from,
      to: semantic.extracted_items.edges[0].to,
      verified: semantic.extracted_items.edges[0].verified,
      direction: semantic.extracted_items.edges[0].direction,
    },
    { from: "DMA Controller", to: "AXI Bus", verified: false, direction: "candidate" },
  );
  assert.equal(semantic.extracted_items.timing_constraints.length, 1);
  assert.equal(semantic.extracted_items.timing_constraints[0].verified, false);
  assert.equal(semantic.extracted_items.sequence_steps.length, 2);
  assert.match(semantic.uncertainties.join("\n"), /Candidate edges are derived only from explicit OCR\/parser text phrases/);
});

test("semantic evidence does not invent edges from nearby labels", () => {
  const semantic = buildSemanticEvidence({
    filename: "manual.pdf",
    figureType: "block_diagram",
    parser: "ocr",
    ocr: {
      ocr_text: [
        { text: "DMA Controller", confidence: 0.9 },
        { text: "AXI Bus", confidence: 0.9 },
      ],
    },
  });
  assert.equal(semantic.extracted_items.nodes.length >= 2, true);
  assert.deepEqual(semantic.extracted_items.edges, []);
});

test("VL semantic evidence keeps candidate relations unverified", () => {
  const semantic = buildSemanticEvidence({
    filename: "manual.pdf",
    figureType: "timing",
    parser: "vl",
    raw: {
      itemCount: 2,
      plainText: "CLK drives DMA request\nRESET after falling edge of clock",
    },
  });
  assert.equal(semantic.extracted_items.edges.length, 1);
  assert.equal(semantic.extracted_items.edges[0].verified, false);
  assert.equal(semantic.extracted_items.edges[0].source, "vl_text");
  assert.equal(semantic.extracted_items.timing_constraints[0].verified, false);
  assert.match(semantic.uncertainties.join("\n"), /PaddleOCR-VL visual graph edges are treated as unverified/);
});

test("render_figure invalid input returns stable JSON instead of throwing", async () => {
  const registry = createRuntimeToolRegistry();
  const result = await registry.dispatchTool("render_figure", { filename: "unit-invalid.pdf" });
  const payload = parseJsonResult(result);
  assert.equal(payload.ok, false);
  assert.equal(payload.error_code, "INVALID_INPUT");
  assert.match(payload.message, /figure_id|page and bbox/i);
  assert.deepEqual(result.structuredContent, payload);
});

test("render_figure caches a PyMuPDF crop by filename page bbox and scale", async (t) => {
  const registry = createRuntimeToolRegistry();
  const filename = `unit-figure-render-${Date.now()}.pdf`;
  const pdfPath = await createSyntheticPdf(filename);
  if (!pdfPath) {
    t.skip("Python/PyMuPDF unavailable");
    return;
  }
  try {
    const args = { filename, page: 1, bbox: [30, 30, 190, 145], scale: 2.0 };
    const first = parseJsonResult(await registry.dispatchTool("render_figure", { ...args, force: true }));
    assert.equal(first.ok, true);
    assert.equal(first.cache_hit, false);
    assert.match(first.image_path, /figure-images/);
    await fs.access(first.image_path);

    const second = parseJsonResult(await registry.dispatchTool("render_figure", args));
    assert.equal(second.ok, true);
    assert.equal(second.cache_hit, true);
    assert.equal(second.image_path, first.image_path);
  } finally {
    await fs.rm(pdfPath, { force: true }).catch(() => {});
    await removeCacheFor(filename);
  }
});

test("render_figure resolves figure_id through a lazy lookup sidecar", async (t) => {
  const registry = createRuntimeToolRegistry();
  const filename = `unit-figure-lookup-${Date.now()}.pdf`;
  const pdfPath = await createSyntheticPdf(filename);
  if (!pdfPath) {
    t.skip("Python/PyMuPDF unavailable");
    return;
  }
  try {
    const source = await getPdfSourceInfo(filename);
    await atomicWriteJson(safeFiguresIndexPath(filename), {
      schemaVersion: 1,
      filename,
      source,
      sourceFingerprint: `size=${source.size};mtimeMs=${Math.round(source.mtimeMs)}`,
      figureCount: 1,
      figures: [{
        id: "fig-unit-lookup",
        figureUid: "fig-unit-lookup",
        page: 1,
        bbox: [30, 30, 190, 145],
        caption: "Figure Unit Lookup",
        kind: "drawing",
      }],
    });
    await fs.rm(safeFigureLookupIndexPath(filename), { force: true }).catch(() => {});
    const first = parseJsonResult(await registry.dispatchTool("render_figure", {
      filename,
      figure_id: "fig-unit-lookup",
      force: true,
    }));
    assert.equal(first.ok, true);
    assert.equal(first.lookup_cache_hit, false);
    await fs.access(safeFigureLookupIndexPath(filename));

    const second = parseJsonResult(await registry.dispatchTool("render_figure", {
      filename,
      figure_id: "fig-unit-lookup",
      force: true,
    }));
    assert.equal(second.ok, true);
    assert.equal(second.lookup_cache_hit, true);
  } finally {
    await fs.rm(pdfPath, { force: true }).catch(() => {});
    await removeCacheFor(filename);
  }
});

test("build_figures_index writes a lookup sidecar eagerly", async (t) => {
  const registry = createRuntimeToolRegistry();
  const filename = `unit-figure-build-lookup-${Date.now()}.pdf`;
  const pdfPath = await createSyntheticPdf(filename);
  if (!pdfPath) {
    t.skip("Python/PyMuPDF unavailable");
    return;
  }
  try {
    const source = await getPdfSourceInfo(filename);
    await atomicWriteJson(safePagesCachePath(filename), {
      schemaVersion: 1,
      filename,
      source,
      pageCount: 1,
      pages: [{ page: 1, text: "Figure 1. Synthetic block diagram" }],
    });
    await fs.rm(safeFigureLookupIndexPath(filename), { force: true }).catch(() => {});
    const result = await registry.dispatchTool("build_figures_index", { filename });
    assert.match(result.content[0].text, /Built figures\/captions index/);
    const lookup = JSON.parse(await fs.readFile(safeFigureLookupIndexPath(filename), "utf-8"));
    assert.equal(lookup.filename, filename);
    assert.equal(lookup.schemaVersion, 1);
    assert.equal(typeof lookup.byId, "object");
  } finally {
    await fs.rm(pdfPath, { force: true }).catch(() => {});
    await removeCacheFor(filename);
  }
});

test("ocr_figure engine none renders but returns graceful disabled status", async (t) => {
  const registry = createRuntimeToolRegistry();
  const filename = `unit-figure-ocr-none-${Date.now()}.pdf`;
  const pdfPath = await createSyntheticPdf(filename);
  if (!pdfPath) {
    t.skip("Python/PyMuPDF unavailable");
    return;
  }
  try {
    const payload = parseJsonResult(await registry.dispatchTool("ocr_figure", {
      filename,
      page: 1,
      bbox: [30, 30, 190, 145],
      engine: "none",
      force: true,
    }));
    assert.equal(payload.ok, false);
    assert.equal(payload.error_code, "OCR_ENGINE_DISABLED");
    assert.equal(payload.engine, "none");
    assert.equal(payload.mode, "text");
    assert.equal(payload.parser, "ocr");
    assert.equal(Array.isArray(payload.ocr_text), true);
    assert.equal(payload.ocr_text.length, 0);
    assert.equal(payload.semantic_evidence.schemaVersion, 1);
    await fs.access(payload.image_path);
  } finally {
    await fs.rm(pdfPath, { force: true }).catch(() => {});
    await removeCacheFor(filename);
  }
});

test("ocr_figure mode text remains backward-compatible", async (t) => {
  const registry = createRuntimeToolRegistry();
  const filename = `unit-figure-ocr-text-${Date.now()}.pdf`;
  const pdfPath = await createSyntheticPdf(filename);
  if (!pdfPath) {
    t.skip("Python/PyMuPDF unavailable");
    return;
  }
  try {
    const payload = parseJsonResult(await registry.dispatchTool("ocr_figure", {
      filename,
      page: 1,
      bbox: [30, 30, 190, 145],
      mode: "text",
      engine: "none",
      force: true,
    }));
    assert.equal(payload.error_code, "OCR_ENGINE_DISABLED");
    assert.equal(payload.mode, "text");
    assert.equal(payload.semantic_evidence.parser, "ocr");
    assert.equal(payload.semantic_evidence.raw_artifact.kind, "text");
  } finally {
    await fs.rm(pdfPath, { force: true }).catch(() => {});
    await removeCacheFor(filename);
  }
});

test("ocr_figure reports missing PaddleOCR as a graceful unavailable engine", async (t) => {
  clearOcrHealthCache();
  const health = await getOcrHealth({ force: true });
  if (health.ocr?.available) {
    t.skip("PaddleOCR is installed in this environment");
    return;
  }
  const registry = createRuntimeToolRegistry();
  const filename = `unit-figure-ocr-missing-${Date.now()}.pdf`;
  const pdfPath = await createSyntheticPdf(filename);
  if (!pdfPath) {
    t.skip("Python/PyMuPDF unavailable");
    return;
  }
  try {
    const payload = parseJsonResult(await registry.dispatchTool("ocr_figure", {
      filename,
      page: 1,
      bbox: [30, 30, 190, 145],
      engine: "auto",
      force: true,
    }));
    assert.equal(payload.ok, false);
    assert.equal(payload.error_code, "OCR_ENGINE_UNAVAILABLE");
    assert.match(payload.hint, /requirements-ocr\.txt/);
    assert.equal(Array.isArray(payload.ocr_text), true);
    assert.equal(payload.ocr_health_cache_hit, true);
    await fs.access(payload.image_path);
  } finally {
    await fs.rm(pdfPath, { force: true }).catch(() => {});
    await removeCacheFor(filename);
  }
});

test("ocr_figure mode structure returns structured unavailable warning when parser is missing", async (t) => {
  clearOcrHealthCache();
  const health = await getOcrHealth({ force: true });
  if (health.ocr?.structure?.available) {
    t.skip("PP-StructureV3 is installed in this environment");
    return;
  }
  const registry = createRuntimeToolRegistry();
  const filename = `unit-figure-structure-missing-${Date.now()}.pdf`;
  const pdfPath = await createSyntheticPdf(filename);
  if (!pdfPath) {
    t.skip("Python/PyMuPDF unavailable");
    return;
  }
  try {
    const payload = parseJsonResult(await registry.dispatchTool("ocr_figure", {
      filename,
      page: 1,
      bbox: [30, 30, 190, 145],
      mode: "structure",
      force: true,
    }));
    assert.equal(payload.ok, false);
    assert.equal(payload.mode, "structure");
    assert.equal(payload.parser, "structure");
    assert.equal(payload.error_code, "STRUCTURE_PARSER_UNAVAILABLE");
    assert.match(payload.hint || payload.warnings.join("\n"), /requirements-ocr-structure\.txt|PP-Structure/i);
    assert.equal(payload.semantic_evidence.parser, "structure");
    assert.equal(Array.isArray(payload.semantic_evidence.warnings), true);
    await fs.access(payload.image_path);
  } finally {
    await fs.rm(pdfPath, { force: true }).catch(() => {});
    await removeCacheFor(filename);
  }
});

test("inspect_figure returns a stable evidence pack shape", async (t) => {
  const registry = createRuntimeToolRegistry();
  const filename = `unit-figure-inspect-${Date.now()}.pdf`;
  const pdfPath = await createSyntheticPdf(filename);
  if (!pdfPath) {
    t.skip("Python/PyMuPDF unavailable");
    return;
  }
  try {
    const payload = parseJsonResult(await registry.dispatchTool("inspect_figure", {
      filename,
      page: 1,
      bbox: [30, 30, 190, 145],
      mode: "block_diagram",
      include_context: false,
      force: true,
    }));
    assert.equal(payload.ok, true);
    assert.equal(payload.figure_type, "block_diagram");
    assert.equal(payload.parser, "safe");
    assert.equal(Array.isArray(payload.detected_labels), true);
    assert.deepEqual(payload.detected_connectors, []);
    assert.equal(Array.isArray(payload.technical_summary), true);
    assert.equal(typeof payload.ocr.ok, "boolean");
    assert.equal(payload.semantic_evidence.schemaVersion, 1);
    await fs.access(payload.image_path);
  } finally {
    await fs.rm(pdfPath, { force: true }).catch(() => {});
    await removeCacheFor(filename);
  }
});

test("inspect_figure parser structure returns warning instead of crashing when missing", async (t) => {
  clearOcrHealthCache();
  const health = await getOcrHealth({ force: true });
  if (health.ocr?.structure?.available) {
    t.skip("PP-StructureV3 is installed in this environment");
    return;
  }
  const registry = createRuntimeToolRegistry();
  const filename = `unit-figure-inspect-structure-${Date.now()}.pdf`;
  const pdfPath = await createSyntheticPdf(filename);
  if (!pdfPath) {
    t.skip("Python/PyMuPDF unavailable");
    return;
  }
  try {
    const payload = parseJsonResult(await registry.dispatchTool("inspect_figure", {
      filename,
      page: 1,
      bbox: [30, 30, 190, 145],
      mode: "block_diagram",
      parser: "structure",
      include_context: false,
      force: true,
    }));
    assert.equal(payload.ok, true);
    assert.equal(payload.parser, "structure");
    assert.equal(payload.ocr.error_code, "STRUCTURE_PARSER_UNAVAILABLE");
    assert.equal(payload.semantic_evidence.parser, "structure");
    assert.match(payload.warnings.join("\n"), /requirements-ocr-structure\.txt|PP-Structure/i);
  } finally {
    await fs.rm(pdfPath, { force: true }).catch(() => {});
    await removeCacheFor(filename);
  }
});

test("inspect_figure parser vl returns unverified warning when unavailable", async (t) => {
  clearOcrHealthCache();
  const health = await getOcrHealth({ force: true });
  if (health.ocr?.vl?.available) {
    t.skip("PaddleOCR-VL is installed in this environment");
    return;
  }
  const registry = createRuntimeToolRegistry();
  const filename = `unit-figure-inspect-vl-${Date.now()}.pdf`;
  const pdfPath = await createSyntheticPdf(filename);
  if (!pdfPath) {
    t.skip("Python/PyMuPDF unavailable");
    return;
  }
  try {
    const payload = parseJsonResult(await registry.dispatchTool("inspect_figure", {
      filename,
      page: 1,
      bbox: [30, 30, 190, 145],
      mode: "timing",
      parser: "vl",
      include_context: false,
      force: true,
    }));
    assert.equal(payload.ok, true);
    assert.equal(payload.parser, "vl");
    assert.equal(payload.ocr.error_code, "VL_PARSER_UNAVAILABLE");
    assert.equal(payload.semantic_evidence.parser, "vl");
    assert.match(payload.warnings.join("\n"), /requirements-ocr-vl\.txt|PaddleOCR-VL|VL/i);
  } finally {
    await fs.rm(pdfPath, { force: true }).catch(() => {});
    await removeCacheFor(filename);
  }
});

test("inspect_figure caches surrounding page context by page range", async (t) => {
  const registry = createRuntimeToolRegistry();
  const filename = `unit-figure-context-${Date.now()}.pdf`;
  const pdfPath = await createSyntheticPdf(filename);
  if (!pdfPath) {
    t.skip("Python/PyMuPDF unavailable");
    return;
  }
  try {
    const args = {
      filename,
      page: 1,
      bbox: [30, 30, 190, 145],
      include_context: true,
      context_pages: 0,
      force: true,
    };
    const first = parseJsonResult(await registry.dispatchTool("inspect_figure", args));
    assert.equal(first.ok, true);
    assert.equal(first.context_cache_hit, false);
    const second = parseJsonResult(await registry.dispatchTool("inspect_figure", { ...args, force: false }));
    assert.equal(second.ok, true);
    assert.equal(second.context_cache_hit, true);
    assert.equal(Array.isArray(second.surrounding_context), true);
  } finally {
    await fs.rm(pdfPath, { force: true }).catch(() => {});
    await removeCacheFor(filename);
  }
});

test("eval_health_check reports and dry-runs figure cache cleanup", async (t) => {
  const registry = createRuntimeToolRegistry();
  const filename = `unit-figure-cache-${Date.now()}.pdf`;
  const pdfPath = await createSyntheticPdf(filename);
  if (!pdfPath) {
    t.skip("Python/PyMuPDF unavailable");
    return;
  }
  try {
    const render = parseJsonResult(await registry.dispatchTool("render_figure", {
      filename,
      page: 1,
      bbox: [30, 30, 190, 145],
      force: true,
    }));
    assert.equal(render.ok, true);

    const status = parseJsonResult(await registry.dispatchTool("mcp_control", {
      action: "cache_status",
      filename,
      kind: "figure-images",
    }));
    assert.equal(status.ok, true);
    assert.ok(status.kinds["figure-images"].files >= 1);

    const cleanupResult = await registry.dispatchTool("mcp_control", {
      action: "cleanup_cache",
      filename,
      kind: "figure-images",
      max_bytes: 1,
    });
    const dryRun = parseJsonResult(cleanupResult);
    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.dry_run, true);
    assert.ok(dryRun.selected_files >= 1);
    assert.deepEqual(cleanupResult.structuredContent, dryRun);
  } finally {
    await fs.rm(pdfPath, { force: true }).catch(() => {});
    await removeCacheFor(filename);
  }
});

test("cleanup_cache can select stale cache files by PDF source", async (t) => {
  const registry = createRuntimeToolRegistry();
  const filename = `unit-figure-stale-cache-${Date.now()}.pdf`;
  const pdfPath = await createSyntheticPdf(filename);
  if (!pdfPath) {
    t.skip("Python/PyMuPDF unavailable");
    return;
  }
  const stalePath = path.join("indexes", "cache", "figure-ocr", `${filename}-stale.json`);
  try {
    await fs.mkdir(path.dirname(stalePath), { recursive: true });
    await atomicWriteJson(stalePath, {
      schemaVersion: 1,
      filename,
      sourceFingerprint: "size=1;mtimeMs=1",
      figure_id: "stale",
    });
    const dryRun = parseJsonResult(await registry.dispatchTool("mcp_control", {
      action: "cleanup_cache",
      filename,
      kind: "figure-ocr",
      stale_by_source: true,
    }));
    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.selected_files, 1);
    assert.equal(dryRun.files[0].name, `${filename}-stale.json`);

    const confirmed = parseJsonResult(await registry.dispatchTool("mcp_control", {
      action: "cleanup_cache",
      filename,
      kind: "figure-ocr",
      stale_by_source: true,
      confirm: true,
    }));
    assert.equal(confirmed.deleted_files, 1);
    await assert.rejects(fs.access(stalePath));
  } finally {
    await fs.rm(pdfPath, { force: true }).catch(() => {});
    await removeCacheFor(filename);
    await fs.rm(stalePath, { force: true }).catch(() => {});
  }
});
