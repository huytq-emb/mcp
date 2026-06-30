import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { activateRuntimePortRegistry, bindRuntimePorts, createRuntimePortRegistry } from "../../src/core/runtime-ports.js";
import { atomicWriteJson, getPdfSourceInfo, safeFigureLookupIndexPath, safeFiguresIndexPath, safePdfPath } from "../../src/core/runtime-helpers.js";
import { rebuildFigureManifest, listFigureManifest, searchFigures, getFigureImage, getFigureContextPack, findFigure } from "../../src/domains/figures.js";

const filename = "unit-figure-workflow.pdf";
const execFileAsync = promisify(execFile);

function resolvePythonForTest() {
  return process.env.RENESAS_MCP_PYTHON || (process.platform === "win32" ? "python" : "python3");
}

async function hasPyMuPdf() {
  try {
    await execFileAsync(resolvePythonForTest(), ["-c", "import fitz"]);
    return true;
  } catch {
    return false;
  }
}
const pageTexts = {
  1: "Intro section\nFigure 1.1 First block diagram\nThis context describes alpha routing.",
  2: "Timing section\nFigure 2.1\nSecond timing diagram\nThis context describes beta waveform.",
  3: "Register section\nTable 3.1 Register overview\nThis context describes gamma fields.",
};

async function resetArtifacts({ realPdf = false } = {}) {
  await fs.mkdir(path.dirname(safePdfPath(filename)), { recursive: true });
  await fs.writeFile(safePdfPath(filename), "%PDF-1.4\n% synthetic source for manifest-only tests\n", "utf-8");
  if (realPdf) {
    await execFileAsync(resolvePythonForTest(), ["-c", `import fitz
doc=fitz.open()
for i in range(3):
    page=doc.new_page(width=300,height=300)
    page.insert_text((36,60), "${filename} page %d" % (i+1))
    page.draw_rect(fitz.Rect(50, 90, 180, 180))
doc.save(r"${safePdfPath(filename)}")`]);
  }
  await fs.rm(safeFiguresIndexPath(filename), { force: true }).catch(() => {});
  await fs.rm(safeFigureLookupIndexPath(filename), { force: true }).catch(() => {});
}

function wirePorts() {
  const registry = createRuntimePortRegistry();
  activateRuntimePortRegistry(registry);
  bindRuntimePorts({
    detectHeadings: (text) => [String(text).split(/\n/)[0]].filter(Boolean),
    getPagesCache: async () => ({ filename, pageCount: 3, pages: Object.entries(pageTexts).map(([page, text]) => ({ page: Number(page), text })) }),
    extractPdfPages: async (_filename, { startPage, endPage }) => ({ pages: Array.from({ length: endPage - startPage + 1 }, (_, i) => { const page = startPage + i; return { page, text: pageTexts[page] || "" }; }) }),
    extractTablesFromPages: async () => ({ tables: [] }),
    getPdfPageCount: async () => 3,
    q: (s) => s,
    scoreSimpleText: (text, query) => String(text).toLowerCase().includes(String(query).toLowerCase()) ? 10 : 0,
  }, registry);
}

test("figure workflow builds lightweight canonical manifest and supports page-limited updates", async () => {
  await resetArtifacts();
  wirePorts();

  const full = await rebuildFigureManifest(filename, { includeManifest: true });
  assert.equal(full.mode, "full");
  assert.equal(full.manifest.producer.manifestOnly, true);
  assert.equal(full.manifest.producer.renderImages, false);
  assert.equal(full.manifest.producer.runOcr, false);
  assert.equal(full.manifest.producer.runVl, false);
  assert.equal(full.manifest.producer.runSemantic, false);
  assert.ok(full.manifest.figures.every((fig) => /^p\d+_f\d{3}$/.test(fig.figure_id)));
  assert.ok(full.manifest.figures.every((fig) => fig.render.status === "missing" && !fig.image_path));

  pageTexts[2] = "Timing section\nFigure 2.1 Updated beta-only timing diagram\nNew searchable beta needle.";
  const limited = await rebuildFigureManifest(filename, { page: 2, includeManifest: true });
  assert.equal(limited.mode, "page-limited");
  assert.equal(limited.page, 2);
  assert.equal(limited.updatedPageFigureCount, 1);
  assert.ok(limited.manifest.figures.some((fig) => fig.page === 1 && /First block/.test(fig.caption)));
  assert.ok(limited.manifest.figures.some((fig) => fig.page === 2 && /Updated beta-only/.test(fig.caption)));
});

test("list/search do not build missing manifests unless explicitly requested", async () => {
  await resetArtifacts();
  wirePorts();
  await assert.rejects(() => listFigureManifest(filename), /Run rebuild_figure_manifest/);
  await assert.rejects(() => searchFigures(filename, { query: "beta" }), /Run rebuild_figure_manifest/);
  const built = await listFigureManifest(filename, { buildIfMissing: true });
  assert.ok(built.figureCount > 0);
});

test("manifest normalization ignores legacy render paths and public retrieval does not expose them", async () => {
  await resetArtifacts();
  wirePorts();
  const source = await getPdfSourceInfo(filename);
  await atomicWriteJson(safeFiguresIndexPath(filename), {
    schemaVersion: 1,
    filename,
    source,
    sourceFingerprint: `${Number(source.size || 0)}:${Math.round(Number(source.mtimeMs || 0))}`,
    figureCount: 1,
    figures: [{
      figure_id: "p1_f001",
      page: 1,
      caption: "Figure 1.1 Example",
      section_title: "Intro section",
      nearby_text_preview: "Example context",
      renderPath: "C:\\\\tmp\\renders\\foo.png",
      render_path: "renders/bad-crop.png",
      image_path: "C:\\\\tmp\\renders\\foo.png",
    }],
  });

  const listed = await listFigureManifest(filename, { limit: 5 });
  assert.equal(listed.results[0].image_path, "");
  assert.equal(listed.results[0].render.status, "missing");
  assert.equal(listed.results[0].next_tool, "get_figure_context_pack");
  assert.doesNotMatch(JSON.stringify(listed), /(^|[\\/])renders?[\\/]/i);

  const found = await searchFigures(filename, { query: "Example" });
  assert.equal(found.next_tool, "get_figure_context_pack");
  assert.equal(found.results[0].figure_id, "p1_f001");
  assert.equal(found.results[0].image_path, "");
  assert.equal(found.results[0].render.status, "missing");
  assert.doesNotMatch(JSON.stringify(found), /(^|[\\/])renders?[\\/]/i);

  const pack = await getFigureContextPack(filename, "p1_f001");
  assert.equal(pack.image_path, "");
  assert.match(pack.warnings.join("\n"), /non-canonical figure image path|Canonical figure image_path/);
  assert.doesNotMatch(JSON.stringify({ image_path: pack.image_path, image_access: pack.image_access }), /(^|[\\/])renders?[\\/]/i);
});


test("legacy find_figure can lightweight-build missing manifests when requested", async () => {
  await resetArtifacts();
  wirePorts();
  await assert.rejects(() => findFigure(filename, { query: "beta" }), /Run rebuild_figure_manifest/);
  const built = await findFigure(filename, { query: "beta", buildIfMissing: true });
  assert.ok(built.results.length > 0);
  assert.ok(built.index.producer.manifestOnly);
  assert.equal(built.index.producer.renderImages, false);
  assert.equal(built.index.producer.runOcr, false);
  assert.equal(built.index.producer.runVl, false);
  assert.equal(built.index.producer.runSemantic, false);
});

test("search uses cached OCR keywords and legacy aliases resolve to canonical context packs", async (t) => {
  if (!(await hasPyMuPdf())) {
    t.skip("PyMuPDF/fitz is unavailable; skipping real render integration coverage.");
    return;
  }
  await resetArtifacts({ realPdf: true });
  wirePorts();
  const full = await rebuildFigureManifest(filename, { includeManifest: true });
  const source = await getPdfSourceInfo(filename);
  const manifest = full.manifest;
  manifest.figures[0].legacy_ids = ["fig-p1-legacy"];
  manifest.figures[0].aliases = ["fig-p1-legacy"];
  manifest.figures[0].bbox = [10, 10, 100, 80];
  manifest.figures[0].ocr_keywords = ["rareocrneedle"];
  await atomicWriteJson(safeFiguresIndexPath(filename), { ...manifest, source });

  const found = await searchFigures(filename, { query: "rareocrneedle" });
  assert.equal(found.results[0].figure_id, manifest.figures[0].figure_id);

  const pack = await getFigureContextPack(filename, "fig-p1-legacy");
  assert.equal(pack.figure_id, manifest.figures[0].figure_id);
  assert.equal(pack.caption, manifest.figures[0].caption);
  assert.ok(pack.page_text_after.includes("alpha") || pack.page_text_before.includes("alpha"));
  assert.ok(pack.context_anchor.method);
  assert.equal(pack.visual_contract.requires_visual_open, true);
  assert.equal(pack.visual_contract.semantic_truth_source, "image_pixels");
  assert.equal(pack.visual_contract.image_path_role, "locator_only");
  assert.equal(pack.visual_contract.required_next_tool, "get_figure_image");
  assert.deepEqual(pack.visual_contract.image_transport_modes, ["metadata", "mcp_image"]);
  assert.equal(pack.visual_contract.default_transport, "metadata");
  assert.equal(pack.visual_contract.text_context_role, "locator_support_only");
  assert.equal(pack.visual_contract.must_not_answer_from_text_only, true);
  assert.equal(pack.agent_instruction.includes("image_path is only a locator"), true);
  assert.equal(pack.agent_instruction.includes("get_figure_image"), true);
  assert.equal(pack.agent_instruction.includes("metadata-only"), true);
  assert.equal(pack.agent_instruction.includes("open/attach"), true);
  assert.match(pack.image_path.replace(/\\/g, "/"), /indexes\/cache\/figure-images\//);
  assert.doesNotMatch(pack.image_path.replace(/\\/g, "/"), /(^|\/)renders?\//);
});


test("context pack returns page fallback image when bbox is missing", async (t) => {
  if (!(await hasPyMuPdf())) {
    t.skip("PyMuPDF/fitz is unavailable; skipping real render integration coverage.");
    return;
  }
  await resetArtifacts({ realPdf: true });
  wirePorts();
  const full = await rebuildFigureManifest(filename, { includeManifest: true });
  const manifest = full.manifest;
  manifest.figures[0].bbox = [];
  manifest.figures[0].image_path = "";
  await atomicWriteJson(safeFiguresIndexPath(filename), manifest);

  const pack = await getFigureContextPack(filename, manifest.figures[0].figure_id);
  assert.equal(pack.image_access.exists, true);
  assert.match(pack.image_path, /\.png$/);
  assert.match(pack.image_path.replace(/\\/g, "/"), /indexes\/cache\/figure-images\//);
  assert.doesNotMatch(pack.image_path.replace(/\\/g, "/"), /(^|\/)renders?\//);
  assert.equal(pack.image_access.mime_type, "image/png");
  assert.equal(pack.image_access.agent_should_open_as_image, true);
  assert.equal(pack.render.status, "ready");
  assert.equal(pack.render.mode, "page_fallback");
  assert.match(pack.warnings.join("\n"), /bbox.*unavailable|full page/i);
});

test("figure image crop path still works and reports dimensions", async (t) => {
  if (!(await hasPyMuPdf())) {
    t.skip("PyMuPDF/fitz is unavailable; skipping real render integration coverage.");
    return;
  }
  await resetArtifacts({ realPdf: true });
  wirePorts();
  const full = await rebuildFigureManifest(filename, { includeManifest: true });
  const manifest = full.manifest;
  manifest.figures[0].bbox = [40, 80, 200, 200];
  await atomicWriteJson(safeFiguresIndexPath(filename), manifest);
  await fs.rm(safeFigureLookupIndexPath(filename), { force: true }).catch(() => {});

  const result = await getFigureImage(filename, manifest.figures[0].figure_id);
  assert.equal(result.render.mode, "crop");
  assert.equal(result.image_access.exists, true);
  assert.match(result.image_path.replace(/\\/g, "/"), /indexes\/cache\/figure-images\//);
  assert.doesNotMatch(result.image_path.replace(/\\/g, "/"), /(^|\/)renders?\//);
  assert.ok(result.render.width >= 0);
  assert.ok(result.render.height >= 0);
});

test("context pack exposes render, warnings, anchor, and image instruction", async (t) => {
  if (!(await hasPyMuPdf())) {
    t.skip("PyMuPDF/fitz is unavailable; skipping real render integration coverage.");
    return;
  }
  await resetArtifacts({ realPdf: true });
  wirePorts();
  const full = await rebuildFigureManifest(filename, { includeManifest: true });
  const manifest = full.manifest;
  manifest.figures[0].bbox = [];
  await atomicWriteJson(safeFiguresIndexPath(filename), manifest);

  const pack = await getFigureContextPack(filename, manifest.figures[0].figure_id);
  assert.ok(pack.render);
  assert.ok(Array.isArray(pack.warnings));
  assert.ok(pack.context_anchor);
  assert.ok(pack.agent_instruction.includes("image_path is only a locator"));
  assert.ok(pack.agent_instruction.includes("get_figure_image"));
});

test("cached-or-extracted page text prefers cache and avoids extraction", async () => {
  const { getCachedOrExtractedPageText } = await import("../../src/domains/figures.js");
  let extracts = 0;
  const registry = createRuntimePortRegistry();
  activateRuntimePortRegistry(registry);
  bindRuntimePorts({
    getPagesCache: async () => ({ pages: [{ page: 12, text: "Cached Figure 12.3 DMA Transfer Timing Diagram context" }] }),
    extractPdfPages: async () => { extracts += 1; return { pages: [{ page: 12, text: "extracted" }] }; },
  }, registry);
  const result = await getCachedOrExtractedPageText(filename, 12);
  assert.equal(result.source, "pages-cache");
  assert.match(result.text, /Cached Figure/);
  assert.equal(extracts, 0);
});

test("cached-or-extracted page text falls back to target single-page extraction", async () => {
  const { getCachedOrExtractedPageText } = await import("../../src/domains/figures.js");
  const calls = [];
  const registry = createRuntimePortRegistry();
  activateRuntimePortRegistry(registry);
  bindRuntimePorts({
    getPagesCache: async () => ({ pages: [{ page: 1, text: "wrong page" }] }),
    extractPdfPages: async (_filename, range) => { calls.push(range); return { pages: [{ page: 12, text: "Extracted Figure 12.3 timing context" }] }; },
  }, registry);
  const result = await getCachedOrExtractedPageText(filename, 12);
  assert.equal(result.source, "single-page-extraction");
  assert.deepEqual(calls, [{ startPage: 12, endPage: 12 }]);
});

test("cached-or-extracted page text unavailable is non-fatal", async () => {
  const { getCachedOrExtractedPageText } = await import("../../src/domains/figures.js");
  const registry = createRuntimePortRegistry();
  activateRuntimePortRegistry(registry);
  bindRuntimePorts({
    getPagesCache: async () => { throw new Error("cache failed"); },
    extractPdfPages: async () => { throw new Error("extract failed"); },
  }, registry);
  const result = await getCachedOrExtractedPageText("missing-text.pdf", 12);
  assert.equal(result.source, "unavailable");
  assert.equal(result.text, "");
  assert.equal(result.warning, "page text unavailable");
});


test("getFigureImage rejects non-canonical image_path locators", async () => {
  await assert.rejects(
    () => getFigureImage(filename, "", { image_path: "renders/bad.png" }),
    /non-canonical|indexes\/cache\/figure-images|renders\//i
  );
});
