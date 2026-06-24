import fs from "node:fs/promises";
import {
  atomicWriteJson,
  getPdfSourceInfo,
  isSamePdfSource,
  normalizeForSearch,
  pathExists,
  readJsonCached,
  safeTablesIndexPath,
  safeTablesPartialIndexPath,
} from "../core/runtime-helpers.js";
import {
  INDEX_DIR,
  INDEX_SCHEMA_VERSION,
  PAGE_CACHE_SCHEMA_VERSION,
  SECTION_INDEX_SCHEMA_VERSION,
  SERVER_VERSION,
  TABLE_INDEX_SCHEMA_VERSION,
} from "../core/runtime-constants.js";
import { createRuntimePort } from "../core/runtime-ports.js";
import { coordinateItemsToRows, extractTablesFromCoordinateRows } from "./manual-intelligence.js";

const loadPdfDocument = createRuntimePort("loadPdfDocument");

const TABLE_PAGE_SIGNALS = [
  /\bRegister\s+Name\b[\s\S]{0,240}\b(?:Offset\s+Address|Initial\s+Value|Access\s+Size)\b/i,
  /\b(?:Bit\s+Name|Bit\s+Field)\b[\s\S]{0,240}\b(?:R\s*\/\s*W|Access|Initial\s+Value|Description)\b/i,
  /\b(?:Pin\s+Name|Pin\s+No\.?|Port\s+Name)\b[\s\S]{0,240}\b(?:Function|Signal|Peripheral|Mux)\b/i,
  /\b(?:Caution|Restriction)\b[\s\S]{0,180}\b(?:Condition|Description|Action|Setting)\b/i,
];

export function isStrongTablePageText(text) {
  const raw = String(text || "");
  return TABLE_PAGE_SIGNALS.some((pattern) => pattern.test(raw));
}

export function selectTableCandidatePages(pageCache, indexData, options = {}) {
  const pageCount = Number(pageCache?.pageCount || indexData?.pageCount || 0);
  const direct = new Set();
  for (const page of pageCache?.pages || []) {
    if (isStrongTablePageText(page.text)) direct.add(Number(page.page));
  }
  for (const chunk of indexData?.chunks || []) {
    const types = new Set([chunk.chunkType, ...(chunk.chunkTypes || [])]);
    if (types.has("register_table") || types.has("bitfield_table") || isStrongTablePageText(chunk.text)) {
      direct.add(Number(chunk.page));
    }
  }

  const radius = Math.max(0, Math.min(2, Number(options.neighborRadius ?? 1)));
  const candidates = new Set();
  for (const page of direct) {
    if (!Number.isFinite(page) || page < 1 || page > pageCount) continue;
    for (let delta = -radius; delta <= radius; delta += 1) {
      const candidate = page + delta;
      if (candidate >= 1 && candidate <= pageCount) candidates.add(candidate);
    }
  }
  return [...candidates].sort((a, b) => a - b);
}

export function tableHeaderSignature(table) {
  const roles = (table.layout?.columnRoles || [])
    .map((column) => column.role)
    .filter((role) => role && role !== "unknown");
  const header = normalizeForSearch(table.headerText || "")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !/^\d+$/.test(token))
    .slice(0, 20);
  return [...new Set([table.kind || "table-candidate", ...roles, ...header])].join("|");
}

function roleSet(table) {
  return new Set((table.layout?.columnRoles || []).map((column) => column.role).filter((role) => role && role !== "unknown"));
}

export function tableColumnsAlign(left, right, tolerance = 24) {
  const a = left.columns || [];
  const b = right.columns || [];
  if (!a.length || !b.length || Math.abs(a.length - b.length) > 1) return false;
  const limit = Math.min(a.length, b.length);
  let aligned = 0;
  for (let index = 0; index < limit; index += 1) {
    if (Math.abs(Number(a[index].x || 0) - Number(b[index].x || 0)) <= tolerance) aligned += 1;
  }
  return aligned / limit >= 0.7;
}

export function canStitchTables(left, right) {
  if (!left || !right) return false;
  const leftEnd = Number(left.pageEnd || left.page || 0);
  const leftStart = Number(left.pageStart || left.page || 0);
  const rightStart = Number(right.pageStart || right.page || 0);
  if (rightStart !== leftEnd + 1 || left.kind !== right.kind) return false;
  const maxSpan = left.kind === "pinmux-table" ? 4 : 2;
  if (leftEnd - leftStart + 1 >= maxSpan) return false;
  if (!tableColumnsAlign(left, right)) return false;
  const leftRoles = roleSet(left);
  const rightRoles = roleSet(right);
  if (!leftRoles.size || !rightRoles.size) return tableHeaderSignature(left) === tableHeaderSignature(right);
  const overlap = [...leftRoles].filter((role) => rightRoles.has(role)).length;
  return overlap / Math.max(leftRoles.size, rightRoles.size) >= 0.6;
}

function normalizeIndexedRow(row, table, rowIndex) {
  const sourcePage = Number(row.sourcePage || table.page || 0);
  const sourceCells = (row.sourceCells || []).map((cell, cellIndex) => ({
    cellIndex,
    text: cell.text || "",
    bbox: {
      x: Number(cell.x || 0),
      y: Number(cell.y ?? row.y ?? 0),
      width: Math.max(0, Number(cell.endX || cell.x || 0) - Number(cell.x || 0)),
      height: Number(cell.height || row.height || 0),
    },
  }));
  return {
    ...row,
    sourcePage,
    rowId: row.rowId || `p${sourcePage}:r${rowIndex}`,
    sourceCells,
    bbox: row.bbox || {
      x: sourceCells.length ? Math.min(...sourceCells.map((cell) => cell.bbox.x)) : 0,
      y: Number(row.y || 0),
      width: sourceCells.length
        ? Math.max(...sourceCells.map((cell) => cell.bbox.x + cell.bbox.width)) - Math.min(...sourceCells.map((cell) => cell.bbox.x))
        : 0,
      height: sourceCells.length ? Math.max(...sourceCells.map((cell) => cell.bbox.height)) : 0,
    },
  };
}

export function normalizeIndexedTable(table, index = 0) {
  const page = Number(table.page || 0);
  const rows = (table.rows || []).map((row, rowIndex) => normalizeIndexedRow(row, table, rowIndex));
  return {
    ...table,
    tableId: table.tableId || `table:${table.kind || "candidate"}:p${page}:${index}`,
    pageStart: Number(table.pageStart || page),
    pageEnd: Number(table.pageEnd || page),
    pages: [...new Set([...(table.pages || []), page].map(Number).filter(Number.isFinite))].sort((a, b) => a - b),
    headerSignature: table.headerSignature || tableHeaderSignature(table),
    rows,
    warnings: [...new Set([...(table.warnings || []), ...(table.layout?.warnings || [])])],
    source: table.source || "pdf-coordinate-table",
  };
}

export function compactTableForArtifact(table) {
  const round = (value) => Math.round(Number(value || 0) * 100) / 100;
  const columnRoles = (table.layout?.columnRoles || []).map((column) => ({
    column: column.column,
    x: round(column.x),
    role: column.role,
    confidence: column.confidence,
    ambiguous: Boolean(column.ambiguous),
    fallback: Boolean(column.fallback),
    header: String(column.header || "").slice(0, 160),
  }));
  const roleMap = {};
  for (const column of columnRoles) {
    if (column.role && column.role !== "unknown" && (!roleMap[column.role] || Number(column.confidence || 0) > Number(roleMap[column.role].confidence || 0))) roleMap[column.role] = column;
  }
  return {
    tableId: table.tableId,
    kind: table.kind,
    page: table.pageStart || table.page,
    pageStart: table.pageStart || table.page,
    pageEnd: table.pageEnd || table.page,
    pages: table.pages || [table.page],
    headerText: String(table.headerText || "").slice(0, 800),
    headerSignature: table.headerSignature || tableHeaderSignature(table),
    columns: (table.columns || []).map((column) => ({ index: column.index, x: round(column.x) })),
    layout: { headerRowIndex: table.layout?.headerRowIndex || 0, columnRoles, roleMap, warnings: table.layout?.warnings || [] },
    confidence: table.confidence,
    warnings: table.warnings || [],
    source: table.source,
    segments: table.segments || [],
    rowCount: table.rows?.length || 0,
    rows: (table.rows || []).map((row) => ({
      rowId: row.rowId,
      sourcePage: row.sourcePage || table.page,
      y: round(row.y),
      text: row.text,
      cells: row.cells || row.rawCells || [],
      isHeaderCandidate: Boolean(row.isHeaderCandidate),
      bbox: row.bbox ? { x: round(row.bbox.x), y: round(row.bbox.y), width: round(row.bbox.width), height: round(row.bbox.height) } : null,
      cellBboxes: (row.cellBboxes || (row.sourceCells || []).map((cell) => ({ x: cell.bbox?.x ?? cell.x ?? 0, y: cell.bbox?.y ?? cell.y ?? row.y ?? 0, width: cell.bbox?.width ?? Math.max(0, Number(cell.endX || cell.x || 0) - Number(cell.x || 0)), height: cell.bbox?.height ?? cell.height ?? 0 }))).map((bbox) => ({ x: round(bbox.x), y: round(bbox.y), width: round(bbox.width), height: round(bbox.height) })),
    })),
  };
}

export function isArtifactTableQuality(table) {
  const rows = table.rows || [];
  if (rows.length < 2) return false;
  const dottedLeaderRows = rows.filter((row) => /\.{4,}\s*\d+\s*$/.test(row.text || "")).length;
  if (dottedLeaderRows / rows.length >= 0.3) return false;
  const roles = new Set((table.layout?.columnRoles || []).map((column) => column.role).filter((role) => role && role !== "unknown"));
  if (table.kind === "register-table") return roles.has("register") || roles.has("abbreviation") || roles.has("offset");
  if (table.kind === "bitfield-table") return roles.has("bit") || roles.has("bitfield");
  if (table.kind === "pinmux-table") return (roles.has("pin") || roles.has("port")) && (roles.has("function") || roles.has("signal") || roles.has("peripheral"));
  if (table.kind === "caution-table") return /\b(Caution|Restriction|Prohibited|Reserved)\b/i.test(table.headerText || "");
  return Number(table.confidence || 0) >= 70 && roles.size >= 2;
}

function isRepeatedHeaderRow(row, target) {
  if (!row) return false;
  if (row.isHeaderCandidate) return true;
  const text = normalizeForSearch(row.text || "");
  if (!text) return false;
  return (target.rows || []).slice(0, 3).some((candidate) => normalizeForSearch(candidate.text || "") === text);
}

export function stitchTablesAcrossPages(tables) {
  const stitched = [];
  const ordered = (tables || [])
    .map((table, index) => normalizeIndexedTable(table, index))
    .sort((a, b) => a.pageStart - b.pageStart || String(a.kind).localeCompare(String(b.kind)));

  for (const table of ordered) {
    const target = [...stitched].reverse().find((candidate) => canStitchTables(candidate, table));
    if (!target) {
      stitched.push(table);
      continue;
    }
    const appendedRows = (table.rows || []).filter((row) => !isRepeatedHeaderRow(row, target));
    target.rows.push(...appendedRows);
    target.pageEnd = table.pageEnd;
    target.pages = [...new Set([...target.pages, ...table.pages])].sort((a, b) => a - b);
    target.confidence = Math.min(100, Math.round((Number(target.confidence || 0) + Number(table.confidence || 0)) / 2 + 4));
    target.warnings = [...new Set([...target.warnings, ...table.warnings])];
    target.segments = [...(target.segments || [{ page: target.pageStart }]), { page: table.pageStart }];
  }

  return stitched.map((table, index) => ({
    ...table,
    tableId: `${table.kind || "table-candidate"}:p${table.pageStart}-${table.pageEnd}:${index}`,
    rowCount: table.rows.length,
  }));
}

async function readPartialTables(filename, source) {
  const partialPath = safeTablesPartialIndexPath(filename);
  if (!(await pathExists(partialPath))) return null;
  try {
    const partial = JSON.parse(await fs.readFile(partialPath, "utf-8"));
    if (partial.schemaVersion !== TABLE_INDEX_SCHEMA_VERSION || partial.filename !== filename) return null;
    if (!isSamePdfSource(partial.source, source)) return null;
    return partial;
  } catch {
    return null;
  }
}

export async function buildTablesIndex(filename, indexData, pageCache, sectionsIndex = null, options = {}) {
  await fs.mkdir(INDEX_DIR, { recursive: true });
  const source = await getPdfSourceInfo(filename);
  const candidates = selectTableCandidatePages(pageCache, indexData, options);
  const partial = options.resume === false ? null : await readPartialTables(filename, source);
  const completed = new Set(partial?.completedPages || []);
  const rawTables = (partial?.tables || []).map(compactTableForArtifact);
  const pdf = await loadPdfDocument(filename);
  const checkpointEvery = Math.max(10, Math.min(250, Number(options.checkpointEvery || 100)));
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;

  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const pageNumber = candidates[candidateIndex];
    if (completed.has(pageNumber)) continue;
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: true });
    const coordinateRows = { filename, pageCount: pdf.numPages, startPage: pageNumber, endPage: pageNumber, pages: [{ page: pageNumber, rows: coordinateItemsToRows(content.items || []) }] };
    rawTables.push(...extractTablesFromCoordinateRows(coordinateRows, { minColumns: 2 }).map((table, index) => compactTableForArtifact(normalizeIndexedTable(table, index))));
    completed.add(pageNumber);
    if (onProgress) onProgress({ phase: "build-tables-index", current: completed.size, total: candidates.length, unit: "candidate pages" });

    if (completed.size % checkpointEvery === 0) {
      await atomicWriteJson(safeTablesPartialIndexPath(filename), {
        schemaVersion: TABLE_INDEX_SCHEMA_VERSION,
        serverVersion: SERVER_VERSION,
        filename,
        updatedAt: new Date().toISOString(),
        source,
        candidatePages: candidates,
        completedPages: [...completed].sort((a, b) => a - b),
        tables: rawTables,
      });
    }
  }

  const stitchedTables = stitchTablesAcrossPages(rawTables);
  const tables = stitchedTables.filter(isArtifactTableQuality).map(compactTableForArtifact);
  const index = {
    schemaVersion: TABLE_INDEX_SCHEMA_VERSION,
    serverVersion: SERVER_VERSION,
    filename,
    createdAt: new Date().toISOString(),
    source,
    dependencyVersions: {
      pages: PAGE_CACHE_SCHEMA_VERSION,
      "chunk-index": INDEX_SCHEMA_VERSION,
      sections: SECTION_INDEX_SCHEMA_VERSION,
    },
    pageCount: Number(pageCache?.pageCount || indexData?.pageCount || pdf.numPages),
    candidatePageCount: candidates.length,
    scannedPageCount: completed.size,
    candidatePages: candidates,
    tableCount: tables.length,
    quality: { accepted: tables.length, rejectedNoise: Math.max(0, stitchedTables.length - tables.length), stitched: tables.filter((table) => table.pageEnd > table.pageStart).length },
    tables,
  };
  await atomicWriteJson(safeTablesIndexPath(filename), index);
  await fs.unlink(safeTablesPartialIndexPath(filename)).catch(() => {});
  return index;
}

export async function loadTablesIndex(filename) {
  const tablesPath = safeTablesIndexPath(filename);
  if (!(await pathExists(tablesPath))) return null;
  try {
    const index = await readJsonCached(tablesPath);
    if (index.schemaVersion !== TABLE_INDEX_SCHEMA_VERSION || index.filename !== filename || !Array.isArray(index.tables)) return null;
    const currentSource = await getPdfSourceInfo(filename);
    if (!isSamePdfSource(index.source, currentSource)) return null;
    return index;
  } catch {
    return null;
  }
}

export function queryTablesIndex(index, options = {}) {
  const startPage = Number(options.startPage || 1);
  const endPage = Number(options.endPage || startPage);
  const minColumns = Number(options.minColumns || 2);
  const kind = String(options.kind || "").trim();
  return (index?.tables || []).filter((table) => {
    if (Number(table.pageEnd || table.page) < startPage || Number(table.pageStart || table.page) > endPage) return false;
    if (kind && table.kind !== kind) return false;
    return Number(table.columns?.length || 0) >= minColumns;
  });
}
