import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createRuntimeToolRegistry } from "../../src/mcp/runtime-registry.js";
import { PUBLIC_TOOL_NAMES } from "../../src/mcp/tool-definitions.js";
import { clearOcrHealthCache, getOcrHealth } from "../../src/services/ocr.js";
import { resolvePythonInterpreter } from "../../src/services/python-worker.js";
import { atomicWriteJson, clearJsonFileCache, getJsonFileCacheStats, getPdfSourceInfo, readJsonCached, safeFigureLookupIndexPath, safeFiguresIndexPath, safePdfPath } from "../../src/core/runtime-helpers.js";

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
  for (const dir of [path.join("indexes", "cache", "figure-images"), path.join("indexes", "cache", "figure-ocr"), path.join("indexes", "cache", "page-context")]) {
    const entries = await fs.readdir(dir).catch(() => []);
    await Promise.all(entries
      .filter((entry) => entry.startsWith(`${filename}-`))
      .map((entry) => fs.rm(path.join(dir, entry), { force: true }).catch(() => {})));
  }
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

test("figure OCR tools are advertised and handled", () => {
  const registry = createRuntimeToolRegistry();
  for (const name of ["render_figure", "ocr_figure", "inspect_figure"]) {
    assert.equal(PUBLIC_TOOL_NAMES.includes(name), true, name);
    assert.equal(registry.has(name), true, name);
  }
  assert.equal(registry.advertisedCount, 63);
});

test("render_figure invalid input returns stable JSON instead of throwing", async () => {
  const registry = createRuntimeToolRegistry();
  const payload = parseJsonResult(await registry.dispatchTool("render_figure", { filename: "unit-invalid.pdf" }));
  assert.equal(payload.ok, false);
  assert.equal(payload.error_code, "INVALID_INPUT");
  assert.match(payload.message, /figure_id|page and bbox/i);
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
    assert.equal(Array.isArray(payload.ocr_text), true);
    assert.equal(payload.ocr_text.length, 0);
    await fs.access(payload.image_path);
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
    assert.equal(Array.isArray(payload.detected_labels), true);
    assert.deepEqual(payload.detected_connectors, []);
    assert.equal(Array.isArray(payload.technical_summary), true);
    assert.equal(typeof payload.ocr.ok, "boolean");
    await fs.access(payload.image_path);
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

    const status = parseJsonResult(await registry.dispatchTool("eval_health_check", {
      step40_action: "figure_cache_status",
      filename,
    }));
    assert.equal(status.ok, true);
    assert.ok(status.kinds["figure-images"].files >= 1);

    const dryRun = parseJsonResult(await registry.dispatchTool("eval_health_check", {
      step40_action: "cleanup_figure_cache",
      filename,
    }));
    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.dry_run, true);
    assert.ok(dryRun.selected_files >= 1);
  } finally {
    await fs.rm(pdfPath, { force: true }).catch(() => {});
    await removeCacheFor(filename);
  }
});
