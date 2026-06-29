import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { activateRuntimePortRegistry, bindRuntimePorts, createRuntimePortRegistry } from "../../src/core/runtime-ports.js";
import { atomicWriteJson, getPdfSourceInfo, safeFigureLookupIndexPath, safeFiguresIndexPath, safePdfPath } from "../../src/core/runtime-helpers.js";
import { rebuildFigureManifest, listFigureManifest, searchFigures, getFigureContextPack } from "../../src/domains/figures.js";

const filename = "unit-figure-workflow.pdf";
const pageTexts = {
  1: "Intro section\nFigure 1.1 First block diagram\nThis context describes alpha routing.",
  2: "Timing section\nFigure 2.1\nSecond timing diagram\nThis context describes beta waveform.",
  3: "Register section\nTable 3.1 Register overview\nThis context describes gamma fields.",
};

async function resetArtifacts() {
  await fs.mkdir(path.dirname(safePdfPath(filename)), { recursive: true });
  await fs.writeFile(safePdfPath(filename), "%PDF-1.4\n% synthetic source for manifest-only tests\n", "utf-8");
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
