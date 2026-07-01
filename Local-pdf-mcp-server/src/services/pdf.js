import { atomicWriteJson, clampInteger, getPdfSourceInfo, isSamePdfSource, normalizeText, pathExists, readJsonCached, safePagesCachePath, safePagesPartialCachePath, safePdfPath } from "../core/runtime-helpers.js";
import { createRuntimePort } from "../core/runtime-ports.js";
import { INDEX_DIR, MAX_TEXT_ITEM_GAP_SPACES, PAGE_CACHE_SCHEMA_VERSION } from "../core/runtime-constants.js";
import fs from "node:fs/promises";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";


// -----------------------------------------------------------------------------
// PDF extraction
// -----------------------------------------------------------------------------

export async function loadPdfDocument(filename) {
  const filePath = safePdfPath(filename);
  const data = await fs.readFile(filePath);

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(data),
    disableWorker: true,
    disableFontFace: true,
    useSystemFonts: true,
    isEvalSupported: false,
    verbosity: 0,
  });

  return loadingTask.promise;
}

export async function getPdfPageCount(filename) {
  const pdf = await loadPdfDocument(filename);
  return pdf.numPages;
}

export async function extractPdfPages(filename, options = {}) {
  const pdf = await loadPdfDocument(filename);
  const pageCount = pdf.numPages;
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;

  const startPage = clampInteger(options.startPage, 1, 1, pageCount);
  const endPage = clampInteger(options.endPage, pageCount, startPage, pageCount);

  const pages = [];

  for (let pageNumber = startPage; pageNumber <= endPage; pageNumber += 1) {
    if (onProgress && (pageNumber === startPage || pageNumber === endPage || pageNumber % 10 === 0)) {
      onProgress({ phase: "extract-pages", current: pageNumber - startPage + 1, total: endPage - startPage + 1, unit: "pages" });
    }
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent({
      normalizeWhitespace: true,
      disableCombineTextItems: false,
    });

    const lines = rebuildLinesFromTextItems(content.items);
    const text = normalizeText(lines.join("\n"));

    pages.push({
      page: pageNumber,
      text,
    });
  }

  return {
    filename,
    pageCount,
    pages,
  };
}

export async function buildPagesCache(filename, options = {}) {
  await fs.mkdir(INDEX_DIR, { recursive: true });

  const source = await getPdfSourceInfo(filename);
  const partialPath = safePagesPartialCachePath(filename);
  const resume = options.resume !== false;
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;

  let partialPages = [];
  let partialPageCount = 0;

  if (resume && await pathExists(partialPath)) {
    try {
      const partial = JSON.parse(await fs.readFile(partialPath, "utf-8"));
      if (partial.schemaVersion === PAGE_CACHE_SCHEMA_VERSION && partial.filename === filename && isSamePdfSource(partial.source, source) && Array.isArray(partial.pages)) {
        partialPages = partial.pages
          .filter((page) => Number.isFinite(Number(page.page)))
          .sort((a, b) => Number(a.page) - Number(b.page));
        partialPageCount = Number(partial.pageCount || 0);
      }
    } catch {
      // Broken partial caches are ignored and overwritten.
    }
  }

  const pdf = await loadPdfDocument(filename);
  const pageCount = pdf.numPages;
  const pages = [];
  const seenPages = new Set();

  for (const page of partialPages) {
    const pageNumber = Number(page.page);
    if (pageNumber >= 1 && pageNumber <= pageCount && !seenPages.has(pageNumber)) {
      pages.push({ page: pageNumber, text: page.text || "" });
      seenPages.add(pageNumber);
    }
  }

  if (onProgress && pages.length) {
    onProgress({ phase: "resume-pages-cache", current: pages.length, total: pageCount || partialPageCount || pages.length, unit: "pages" });
  }

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    if (seenPages.has(pageNumber)) continue;

    if (onProgress && (pageNumber === 1 || pageNumber === pageCount || pageNumber % 10 === 0)) {
      onProgress({ phase: "extract-pages", current: pageNumber, total: pageCount, unit: "pages" });
    }

    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent({
      normalizeWhitespace: true,
      disableCombineTextItems: false,
    });

    const lines = rebuildLinesFromTextItems(content.items);
    const text = normalizeText(lines.join("\n"));
    pages.push({ page: pageNumber, text });
    seenPages.add(pageNumber);

    if (resume && (pageNumber === pageCount || pageNumber % 10 === 0)) {
      pages.sort((a, b) => a.page - b.page);
      await atomicWriteJson(partialPath, {
        schemaVersion: PAGE_CACHE_SCHEMA_VERSION,
        partial: true,
        filename,
        createdAt: new Date().toISOString(),
        source,
        pageCount,
        pages,
      });
    }
  }

  pages.sort((a, b) => a.page - b.page);

  const cacheData = {
    schemaVersion: PAGE_CACHE_SCHEMA_VERSION,
    filename,
    createdAt: new Date().toISOString(),
    source,
    pageCount,
    pages: pages.map((page) => ({ page: page.page, text: page.text || "" })),
  };

  const cachePath = safePagesCachePath(filename);
  await atomicWriteJson(cachePath, cacheData);
  await fs.rm(partialPath, { force: true });

  return cacheData;
}

export async function loadPagesCache(filename) {
  const cachePath = safePagesCachePath(filename);

  if (!(await pathExists(cachePath))) {
    return null;
  }

  try {
    const cacheData = await readJsonCached(cachePath);

    if (cacheData.schemaVersion !== PAGE_CACHE_SCHEMA_VERSION) {
      return null;
    }

    if (cacheData.filename !== filename) {
      return null;
    }

    if (!Array.isArray(cacheData.pages)) {
      return null;
    }

    const currentSource = await getPdfSourceInfo(filename);

    if (!isSamePdfSource(cacheData.source, currentSource)) {
      return null;
    }

    return cacheData;
  } catch {
    return null;
  }
}

export async function getPagesCache(filename, options = {}) {
  const existing = await loadPagesCache(filename);

  if (existing) {
    return existing;
  }

  if (options.buildIfMissing === true) {
    return await buildPagesCache(filename, options);
  }

  throw new Error(`Pages cache not found for ${filename}. Run index_pdf first; use mode="background" for large manuals. For a small page range, use read_pdf_pages which can extract selected pages without building full cache.`);
}

/**
 * Rebuilds PDF text items into rough visual lines.
 * Hardware manuals often contain register tables; preserving row structure is
 * more useful than a plain item join.
 */
export function rebuildLinesFromTextItems(items) {
  const rows = [];

  for (const item of items || []) {
    const str = String(item.str || "").trim();
    if (!str) continue;

    const transform = item.transform || [];
    const x = Number(transform[4] || 0);
    const y = Number(transform[5] || 0);
    const width = Number(item.width || 0);
    const height = Number(item.height || Math.abs(transform[3] || 0) || 10);

    let row = rows.find((candidate) => Math.abs(candidate.y - y) <= Math.max(2, height * 0.35));

    if (!row) {
      row = { y, items: [] };
      rows.push(row);
    }

    row.items.push({ x, width, str });
  }

  rows.sort((a, b) => b.y - a.y);

  return rows.map((row) => {
    row.items.sort((a, b) => a.x - b.x);

    const parts = [];
    let previousEnd = null;

    for (const item of row.items) {
      if (previousEnd !== null) {
        const gap = item.x - previousEnd;
        if (gap > 8) {
          const spaces = Math.min(MAX_TEXT_ITEM_GAP_SPACES, Math.max(1, Math.round(gap / 8)));
          parts.push(" ".repeat(spaces));
        } else {
          parts.push(" ");
        }
      }

      parts.push(item.str);
      previousEnd = item.x + Math.max(item.width, item.str.length * 4);
    }

    return parts.join("").replace(/[ ]{2,}/g, " ").trimEnd();
  });
}
