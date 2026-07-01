import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createRuntimeToolRegistry } from "../../src/mcp/runtime-registry.js";
import { PUBLIC_TOOL_NAMES } from "../../src/mcp/tool-definitions.js";
import { buildSemanticEvidence, clearOcrHealthCache, getOcrHealth, renderFigureOnDemand, selectInspectParser } from "../../src/services/ocr.js";
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

test("removed legacy figure OCR/render tools are unknown", () => {
  const registry = createRuntimeToolRegistry();
  for (const name of ["render_figure", "ocr_figure", "inspect_figure"]) {
    assert.equal(PUBLIC_TOOL_NAMES.includes(name), false, name);
    assert.equal(registry.has(name), false, name);
  }
  assert.equal(registry.advertisedCount, PUBLIC_TOOL_NAMES.length);
});

test("public figure registry advertises only retrieval-first figure tools", () => {
  for (const name of ["rebuild_figure_manifest", "search_figures", "get_figure_image", "get_figure_context_pack", "ocr_figure_for_search"]) {
    assert.equal(PUBLIC_TOOL_NAMES.includes(name), true, name);
  }
  for (const name of ["build_figures_index", "find_figure", "get_figure_context", "inspect_figure", "render_figure", "render_figure_page", "render_figure_region", "ocr_figure", "list_figures"]) {
    assert.equal(PUBLIC_TOOL_NAMES.includes(name), false, name);
  }
  assert.equal(PUBLIC_TOOL_NAMES.includes("list_figures"), false, "list_figures");
  assert.equal(createRuntimeToolRegistry().has("list_figures"), true, "list_figures remains hidden-callable for compatibility");
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

test("eval_health_check reports and dry-runs figure cache cleanup", async (t) => {
  const registry = createRuntimeToolRegistry();
  const filename = `unit-figure-cache-${Date.now()}.pdf`;
  const pdfPath = await createSyntheticPdf(filename);
  if (!pdfPath) {
    t.skip("Python/PyMuPDF unavailable");
    return;
  }
  try {
    const render = await renderFigureOnDemand({
      filename,
      page: 1,
      bbox: [30, 30, 190, 145],
      force: true,
    });
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
