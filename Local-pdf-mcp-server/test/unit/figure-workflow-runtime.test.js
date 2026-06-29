import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { activateRuntimePortRegistry, bindRuntimePorts, createRuntimePortRegistry } from "../../src/core/runtime-ports.js";
import { atomicWriteJson, getPdfSourceInfo, safeFigureLookupIndexPath, safeFiguresIndexPath, safePdfPath } from "../../src/core/runtime-helpers.js";
import { rebuildFigureManifest, listFigureManifest, searchFigures, getFigureImage, getFigureContextPack } from "../../src/domains/figures.js";

const filename = "unit-figure-workflow.pdf";
process.env.RENESAS_MCP_PYTHON ||= "python";
const pageTexts = {
  1: "Intro section\nFigure 1.1 First block diagram\nThis context describes alpha routing.",
  2: "Timing section\nFigure 2.1\nSecond timing diagram\nThis context describes beta waveform.",
  3: "Register section\nTable 3.1 Register overview\nThis context describes gamma fields.",
};

async function resetArtifacts() {
  await fs.mkdir(path.dirname(safePdfPath(filename)), { recursive: true });
  await fs.writeFile(safePdfPath(filename), "%PDF-1.4\n% synthetic source for manifest-only tests\n", "utf-8");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)(process.env.RENESAS_MCP_PYTHON || "python3", ["-c", `import fitz
doc=fitz.open()
for i in range(3):
    page=doc.new_page(width=300,height=300)
    page.insert_text((36,60), "${filename} page %d" % (i+1))
    page.draw_rect(fitz.Rect(50, 90, 180, 180))
doc.save(r"${safePdfPath(filename)}")`]);
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

test("search uses cached OCR keywords and legacy aliases resolve to canonical context packs", async () => {
  await resetArtifacts();
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
  assert.equal(pack.agent_instruction.includes("Open image_path"), true);
});


test("context pack returns page fallback image when bbox is missing", async () => {
  await resetArtifacts();
  wirePorts();
  const full = await rebuildFigureManifest(filename, { includeManifest: true });
  const manifest = full.manifest;
  manifest.figures[0].bbox = [];
  manifest.figures[0].image_path = "";
  await atomicWriteJson(safeFiguresIndexPath(filename), manifest);

  const pack = await getFigureContextPack(filename, manifest.figures[0].figure_id);
  assert.equal(pack.image_access.exists, true);
  assert.match(pack.image_path, /\.png$/);
  assert.equal(pack.image_access.mime_type, "image/png");
  assert.equal(pack.image_access.agent_should_open_as_image, true);
  assert.equal(pack.render.status, "ready");
  assert.equal(pack.render.mode, "page_fallback");
  assert.match(pack.warnings.join("\n"), /bbox.*unavailable|full page/i);
});

test("figure image crop path still works and reports dimensions", async () => {
  await resetArtifacts();
  wirePorts();
  const full = await rebuildFigureManifest(filename, { includeManifest: true });
  const manifest = full.manifest;
  manifest.figures[0].bbox = [40, 80, 200, 200];
  await atomicWriteJson(safeFiguresIndexPath(filename), manifest);
  await fs.rm(safeFigureLookupIndexPath(filename), { force: true }).catch(() => {});

  const result = await getFigureImage(filename, manifest.figures[0].figure_id);
  assert.equal(result.render.mode, "crop");
  assert.equal(result.image_access.exists, true);
  assert.ok(result.render.width >= 0);
  assert.ok(result.render.height >= 0);
});

test("context pack exposes render, warnings, anchor, and image instruction", async () => {
  await resetArtifacts();
  wirePorts();
  const full = await rebuildFigureManifest(filename, { includeManifest: true });
  const manifest = full.manifest;
  manifest.figures[0].bbox = [];
  await atomicWriteJson(safeFiguresIndexPath(filename), manifest);

  const pack = await getFigureContextPack(filename, manifest.figures[0].figure_id);
  assert.ok(pack.render);
  assert.ok(Array.isArray(pack.warnings));
  assert.ok(pack.context_anchor);
  assert.ok(pack.agent_instruction.includes("Open image_path"));
});
