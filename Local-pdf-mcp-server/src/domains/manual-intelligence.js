import { appendEvidenceContract, atomicWriteJson, canonicalSymbol, clampBitfieldListTopK, clampInteger, clampRegisterListTopK, clampTopK, escapeRegExp, getPdfSourceInfo, isSamePdfSource, makeEvidence, makeEvidenceContract, makeInference, makeNeedsVerification, normalizeForSearch, normalizeText, pathExists, readJsonCached, safeSequencesIndexPath } from "../core/runtime-helpers.js";
import { withVisualSemanticGuard } from "../core/visual-guard.js";
import { createRuntimePort } from "../core/runtime-ports.js";
import { DEFAULT_CAUTION_TOP_K, DEFAULT_DRIVER_PACK_REGISTERS, DEFAULT_DRIVER_PACK_SUMMARIES, DEFAULT_DRIVER_TASK_REGISTERS, DEFAULT_PAGE_RANGE, DEFAULT_REGISTER_SUMMARY_CHUNKS, DEFAULT_SEQUENCE_INDEX_TOPICS, DEFAULT_SEQUENCE_LIST_TOP_K, DEFAULT_SEQUENCE_TOP_K, DEFAULT_TABLE_PAGE_RANGE, DEFAULT_TOP_K, INDEX_DIR, MAX_BITFIELD_TABLE_ROWS, MAX_CAUTION_EVIDENCE_LINES, MAX_CAUTION_TOP_K, MAX_DRIVER_PACK_REGISTERS, MAX_DRIVER_PACK_SUMMARIES, MAX_DRIVER_TASK_REGISTERS, MAX_EXTRACTED_TABLES, MAX_PREVIEW_CHARS, MAX_REGISTER_SUMMARY_BITFIELDS, MAX_REGISTER_SUMMARY_CHUNKS, MAX_SEQUENCE_EVIDENCE_LINES, MAX_SEQUENCE_INDEX_RESULTS_PER_TOPIC, MAX_SEQUENCE_LIST_TOP_K, MAX_SEQUENCE_TOP_K, MAX_TABLE_COLUMNS, MAX_TABLE_PAGE_RANGE, MAX_TABLE_ROWS_PER_TABLE, MAX_TOP_K, SEQUENCE_INDEX_SCHEMA_VERSION } from "../core/runtime-constants.js";
import fs from "node:fs/promises";
import { BITFIELD_NOISE_WORDS, normalizeBitfieldReset, normalizeHardwareRange, parseBitfieldSemantics } from "../bitfields/semantics.js";


const buildBitFieldQueries = createRuntimePort("buildBitFieldQueries");
const buildRegisterQueries = createRuntimePort("buildRegisterQueries");
const buildSearchText = createRuntimePort("buildSearchText");


const collectRegisterContext = createRuntimePort("collectRegisterContext");
const countWordOccurrences = createRuntimePort("countWordOccurrences");

const exactRegisterContextMatches = createRuntimePort("exactRegisterContextMatches");
const extractBitfieldTableFromIndex = createRuntimePort("extractBitfieldTableFromIndex");
const extractTablesFromPagesEngine = createRuntimePort("extractTablesFromPagesEngine");
const formatSearchResults = createRuntimePort("formatSearchResults");
const getPdfPageCount = createRuntimePort("getPdfPageCount");

const getRegistersIndex = createRuntimePort("getRegistersIndex");
const getSectionsIndex = createRuntimePort("getSectionsIndex");
const isNonRegisterSignal = createRuntimePort("isNonRegisterSignal");

const loadPdfDocument = createRuntimePort("loadPdfDocument");
const loadPdfIndex = createRuntimePort("loadPdfIndex");
const loadTablesIndex = createRuntimePort("loadTablesIndex");
const loadRegistersIndex = createRuntimePort("loadRegistersIndex");
const loadSectionsIndex = createRuntimePort("loadSectionsIndex");
const looksLikeRegisterSymbol = createRuntimePort("looksLikeRegisterSymbol");


const multiQuerySearch = createRuntimePort("multiQuerySearch");
const normalizeBitFieldName = createRuntimePort("normalizeBitFieldName");

const normalizeRegisterName = createRuntimePort("normalizeRegisterName");


const q = createRuntimePort("q");


const searchPdfIndex = createRuntimePort("searchPdfIndex");
const searchRegistersIndex = createRuntimePort("searchRegistersIndex");
const searchSectionsIndex = createRuntimePort("searchSectionsIndex");

// -----------------------------------------------------------------------------
// Coordinate-based table extraction
// -----------------------------------------------------------------------------

export async function extractPdfCoordinateRows(filename, startPage, endPage) {
  const pdf = await loadPdfDocument(filename);
  const pageCount = pdf.numPages;
  const start = clampInteger(startPage, 1, 1, pageCount);
  const end = clampInteger(endPage, start, start, Math.min(pageCount, start + MAX_TABLE_PAGE_RANGE - 1));
  const pages = [];

  for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent({
      normalizeWhitespace: true,
      disableCombineTextItems: true,
    });

    const rows = coordinateItemsToRows(content.items || []);
    pages.push({ page: pageNumber, rows });
  }

  return { filename, pageCount, startPage: start, endPage: end, pages };
}

export function coordinateItemsToRows(items) {
  const rows = [];

  for (const item of items || []) {
    const str = String(item.str || "").trim();
    if (!str) continue;

    const transform = item.transform || [];
    const x = Number(transform[4] || 0);
    const y = Number(transform[5] || 0);
    const width = Number(item.width || Math.max(str.length * 4, 4));
    const height = Number(item.height || Math.abs(transform[3] || 0) || 10);

    let row = rows.find((candidate) => Math.abs(candidate.y - y) <= Math.max(2.2, height * 0.4));
    if (!row) {
      row = { y, items: [] };
      rows.push(row);
    }
    row.items.push({ x, y, width, height, text: str });
  }

  rows.sort((a, b) => b.y - a.y);

  return rows.map((row, index) => {
    row.items.sort((a, b) => a.x - b.x);
    const cells = splitRowItemsIntoCells(row.items);
    const minX = cells.length ? Math.min(...cells.map((cell) => cell.x)) : 0;
    const maxX = cells.length ? Math.max(...cells.map((cell) => cell.endX)) : 0;
    return {
      rowIndex: index,
      y: row.y,
      cells,
      cellCount: cells.length,
      text: cells.map((cell) => cell.text).join(" | "),
      bbox: { x: minX, y: row.y, width: Math.max(0, maxX - minX), height: Math.max(0, ...row.items.map((item) => item.height || 0)) },
    };
  });
}

export function splitRowItemsIntoCells(items) {
  const cells = [];
  let current = null;

  for (const item of items || []) {
    if (!current) {
      current = {
        x: item.x,
        endX: item.x + item.width,
        y: item.y,
        parts: [item.text],
      };
      continue;
    }

    const gap = item.x - current.endX;
    const looksLikeSameCell = gap <= 10 || (gap <= 18 && /^[,.;:)\]]+$/.test(item.text));

    if (looksLikeSameCell) {
      current.parts.push(item.text);
      current.endX = Math.max(current.endX, item.x + item.width);
    } else {
      cells.push({
        x: current.x,
        endX: current.endX,
        y: current.y,
        height: Math.max(...items.filter((item) => item.x >= current.x && item.x <= current.endX).map((item) => item.height || 0), 0),
        text: current.parts.join(" ").replace(/\s+/g, " ").trim(),
      });
      current = {
        x: item.x,
        endX: item.x + item.width,
        y: item.y,
        parts: [item.text],
      };
    }
  }

  if (current) {
    cells.push({
      x: current.x,
      endX: current.endX,
      y: current.y,
      height: Math.max(...items.filter((item) => item.x >= current.x && item.x <= current.endX).map((item) => item.height || 0), 0),
      text: current.parts.join(" ").replace(/\s+/g, " ").trim(),
    });
  }

  return cells.filter((cell) => cell.text);
}

export function isTableLikeRow(row, minColumns = 3) {
  if (!row) return false;
  const text = row.text || "";
  if ((row.cellCount || 0) >= minColumns) return true;
  if (/\b(Register|Abbreviation|Offset|Address|Initial|Access|Bit|Bit Name|Description|R\/W|Read|Write|Pin|Port|GPIO|Pinmux|Pin\s*Mux|Function|Signal|Peripheral|PFC|IOPORT|Alternate)\b/i.test(text)) return true;
  if (/\b[0-9A-F]{2,4}h\b/i.test(text) && /\b[A-Z0-9_]+\b/.test(text)) return true;
  return false;
}

export function extractTablesFromCoordinateRows(pageRows, options = {}) {
  const minColumns = clampInteger(options.minColumns, 3, 2, MAX_TABLE_COLUMNS);
  const tables = [];

  for (const page of pageRows.pages || []) {
    let block = [];

    const flush = () => {
      if (block.length >= 2) {
        const table = normalizeTableBlock(page.page, block, minColumns);
        if (table.rows.length >= 2) tables.push(table);
      }
      block = [];
    };

    for (const row of page.rows || []) {
      if (isTableLikeRow(row, minColumns)) {
        block.push(row);
      } else {
        flush();
      }
    }
    flush();
  }

  return tables.slice(0, MAX_EXTRACTED_TABLES);
}

export function normalizeTableBlock(page, rows, minColumns = 3) {
  const xAnchors = [];

  for (const row of rows) {
    for (const cell of row.cells || []) {
      const existing = xAnchors.find((anchor) => Math.abs(anchor.x - cell.x) <= 16);
      if (existing) {
        existing.x = (existing.x * existing.count + cell.x) / (existing.count + 1);
        existing.count += 1;
      } else {
        xAnchors.push({ x: cell.x, count: 1 });
      }
    }
  }

  const columns = xAnchors
    .filter((anchor) => anchor.count >= 2 || xAnchors.length <= minColumns)
    .sort((a, b) => a.x - b.x)
    .slice(0, MAX_TABLE_COLUMNS)
    .map((anchor, index) => ({ index, x: Math.round(anchor.x), count: anchor.count }));

  const normalizedRows = rows.slice(0, MAX_TABLE_ROWS_PER_TABLE).map((row) => {
    const cells = Array(columns.length).fill("");
    for (const cell of row.cells || []) {
      let bestIndex = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      columns.forEach((column, index) => {
        const distance = Math.abs(column.x - cell.x);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      });
      cells[bestIndex] = [cells[bestIndex], cell.text].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    }
    return {
      y: Math.round(row.y * 10) / 10,
      text: row.text,
      cells,
      sourceCells: (row.cells || []).map((cell) => ({ ...cell })),
      bbox: row.bbox,
    };
  });

  const headerText = normalizedRows.slice(0, 3).map((row) => row.text).join(" / ");
  const table = {
    page,
    kind: classifyCoordinateTable(headerText, normalizedRows),
    columns,
    rows: normalizedRows,
    headerText,
    confidence: scoreCoordinateTable(headerText, normalizedRows),
  };
  return enrichCoordinateTableLayout(table);
}

export function classifyCoordinateTable(headerText, rows) {
  const text = `${headerText} ${(rows || []).slice(0, 5).map((row) => row.text).join(" ")}`;
  if (/\b(Register Name|Abbreviation|Offset Address|Initial Value|Access Size)\b/i.test(text)) return "register-table";
  if (/\b(Pin\s*Name|Pin\s*No|Pin\s*Number|Pin\s*Function|Alternate\s*Function|Alt\s*Function|Function\s*Assignment|Function\s*Select|Selectable\s*Function|Port\s*Name|GPIO\s*Port|I\/O\s*Port|Peripheral\s*Signal|Signal\s*Name|Mux\s*Mode|Pinmux|Pin\s*Mux|PFC|IOPORT|PMC|PMm|PFCm)\b/i.test(text)) return "pinmux-table";
  if (/\b(Bit|Bit Name|Field|R\/W|Access|Description|Initial Value)\b/i.test(text)) return "bitfield-table";
  if (/\b(Caution|Note|Restriction|Prohibited|Undefined|Reserved)\b/i.test(text)) return "caution-table";
  return "table-candidate";
}

export function scoreCoordinateTable(headerText, rows) {
  let score = 40;
  const text = `${headerText} ${(rows || []).slice(0, 6).map((row) => row.text).join(" ")}`;
  if (/\b(Register Name|Abbreviation)\b/i.test(text)) score += 25;
  if (/\b(Offset Address|Address|Initial Value|Access Size)\b/i.test(text)) score += 20;
  if (/\b(Bit Name|Bit|R\/W|Access|Description)\b/i.test(text)) score += 20;
  if (/\b(Pin\s*Name|Pin\s*No|Pin\s*Function|Alternate\s*Function|Alt\s*Function|Function\s*Assignment|Function\s*Select|Port\s*Name|GPIO\s*Port|I\/O\s*Port|Signal\s*Name|Peripheral\s*Signal|Pinmux|Pin\s*Mux|PFC|IOPORT|PMC|PMm|PFCm)\b/i.test(text)) score += 25;
  if ((rows || []).length >= 4) score += 10;
  return Math.min(100, score);
}

export function normalizeLayoutHeaderText(text) {
  return String(text || "").replace(/\s+/g, " ").replace(/[＿_]+/g, "_").trim();
}

export function scoreColumnRole(text, role) {
  const raw = normalizeLayoutHeaderText(text);
  const lower = raw.toLowerCase();
  const canonical = normalizeForSearch(raw);
  let score = 0;
  const add = (pattern, value) => {
    if (pattern.test(raw) || pattern.test(lower) || pattern.test(canonical)) score += value;
  };
  if (role === "bit") {
    add(/^\s*(bit|bits|b\d+|bit\s*position|bit\s*no\.?|no\.?|position)\s*$/i, 70);
    add(/\b(bit|bits|b\d+|bit\s*position|bit\s*no)\b/i, 35);
    add(/^\s*\[?\d{1,2}(?::\d{1,2})?\]?\s*$/i, 42);
  } else if (role === "bitfield") {
    add(/\b(bit\s*name|field\s*name|bit\s*field|symbol|name|mnemonic|abbreviation)\b/i, 65);
    add(/^\s*(name|symbol|field)\s*$/i, 38);
    add(/^\s*[A-Z][A-Z0-9_]{1,31}\s*$/i, 22);
  } else if (role === "access") {
    add(/\b(access|r\s*\/\s*w|read\s*\/\s*write|read|write|r\/o|w\/o|r\s*only|w\s*only)\b/i, 70);
    add(/^\s*(r|w|rw|ro|wo|r\/w|r\/o|w\/o|read only|write only)\s*$/i, 55);
  } else if (role === "reset") {
    add(/\b(initial\s*value|reset\s*value|default\s*value|initial|reset|default)\b/i, 70);
    add(/^\s*(0x[0-9a-f]+|[0-9a-f]+h|[01]b|0|1|−|-|undefined)\s*$/i, 25);
  } else if (role === "description") {
    add(/\b(description|function|operation|setting|settings|contents|meaning|remarks|note)\b/i, 70);
    if (raw.length > 28) score += 18;
  } else if (role === "register") {
    add(/\b(register\s*name|register|name)\b/i, 65);
    add(/^\s*[A-Z][A-Z0-9_]{2,}\s*$/i, 18);
  } else if (role === "abbreviation") {
    add(/\b(abbreviation|abbrev\.?|symbol|register\s*symbol|short\s*name)\b/i, 70);
    add(/^\s*[A-Z0-9]+m?_[A-Za-z0-9_]+(?:_n)?\s*$/i, 35);
  } else if (role === "offset") {
    add(/\b(offset\s*address|address\s*offset|offset|address|addr\.?|base\s*\+)\b/i, 70);
    add(/(?:\+\s*)?[0-9A-Fa-f]{3,8}h\b/i, 45);
  } else if (role === "accessSize") {
    add(/\b(access\s*size|access\s*width|size|width|bits?|byte)\b/i, 60);
    add(/^\s*(8|16|32|64|128)\s*(bit|bits|byte|bytes)?\s*$/i, 35);
  } else if (role === "pin") {
    add(/\b(pin\s*name|pin\s*no\.?|pin\s*number|pin|pad|ball|terminal)\b/i, 72);
    add(/^\s*(P[A-Z0-9]*\d+[_\-]\d+|P\d+[_\-]\d+|GPIO\d+[_\-]\d+|[A-Z]{1,3}\d{1,3})\s*$/i, 55);
  } else if (role === "port") {
    add(/\b(port\s*name|port|gpio\s*port|i\/o\s*port)\b/i, 70);
    add(/^\s*(P[A-Z0-9]*\d+|PORT\d+|GPIO\d+)\s*$/i, 42);
  } else if (role === "function") {
    add(/\b(pin\s*function|function\s*name|function|alternate\s*function|alt\s*function|function\s*select|selectable\s*function)\b/i, 75);
    add(/\b(ALT\d+|AF\d+|FUNC\d+|function\s*\d+)\b/i, 40);
  } else if (role === "signal") {
    add(/\b(signal\s*name|signal|multiplexed\s*signal|peripheral\s*signal)\b/i, 72);
    add(/^\s*[A-Z][A-Z0-9_]{1,31}(?:[0-9])?\s*$/i, 18);
  } else if (role === "peripheral") {
    add(/\b(peripheral|module|ip\s*block|function\s*group|interface)\b/i, 68);
    add(/\b(ETH|GBETH|I2C|IIC|SPI|SCI|UART|CAN|PWM|GPT|ADC|USB|SDHI|MMC|IRQ|INTC|DMAC)\b/i, 38);
  } else if (role === "mode") {
    add(/\b(mode|mux\s*mode|function\s*mode|pin\s*mode|select\s*code|setting\s*value|sel|mux)\b/i, 66);
    add(/^\s*(mode\s*)?[0-9A-Fa-f]+h?\s*$/i, 28);
  } else if (role === "group") {
    add(/\b(group|pin\s*group|function\s*group|bank)\b/i, 60);
  }
  return score;
}

export function inferLayoutColumnRoles(rows, columns) {
  const roleNames = ["bit", "bitfield", "access", "reset", "description", "register", "abbreviation", "offset", "accessSize", "pin", "port", "function", "signal", "peripheral", "mode", "group"];
  const columnRoles = [];
  const headerCandidates = [];
  for (const [rowIndex, row] of (rows || []).slice(0, 8).entries()) {
    const joined = (row.cells || []).join(" ");
    let score = 0;
    for (const role of roleNames) score += Math.min(80, scoreColumnRole(joined, role));
    if ((row.cells || []).filter(Boolean).length >= 2) headerCandidates.push({ rowIndex, score, text: joined });
  }
  const header = headerCandidates.sort((a, b) => b.score - a.score)[0] || { rowIndex: 0, score: 0, text: "" };
  const headerRows = (rows || []).slice(Math.max(0, header.rowIndex - 1), Math.min((rows || []).length, header.rowIndex + 2));
  for (let colIndex = 0; colIndex < (columns || []).length; colIndex += 1) {
    const samples = [];
    for (const row of headerRows) if ((row.cells || [])[colIndex]) samples.push(row.cells[colIndex]);
    for (const row of (rows || []).slice(header.rowIndex + 1, header.rowIndex + 6)) if ((row.cells || [])[colIndex]) samples.push(row.cells[colIndex]);
    const combined = samples.join(" / ");
    const roleScores = roleNames
      .map((role) => ({ role, score: scoreColumnRole(combined, role) + scoreColumnRole((rows[header.rowIndex]?.cells || [])[colIndex] || "", role) }))
      .sort((a, b) => b.score - a.score);
    const best = roleScores[0] || { role: "unknown", score: 0 };
    const second = roleScores[1] || { role: "unknown", score: 0 };
    columnRoles.push({
      column: colIndex,
      x: columns[colIndex]?.x ?? 0,
      role: best.score >= 35 ? best.role : "unknown",
      confidence: Math.min(100, best.score),
      ambiguous: best.score < 50 || (second.score > 0 && best.score - second.score < 15),
      alternatives: roleScores.slice(0, 3),
      header: (rows[header.rowIndex]?.cells || [])[colIndex] || "",
      samples: samples.slice(0, 5),
    });
  }
  const knownRoles = new Set(columnRoles.filter((c) => c.role !== "unknown").map((c) => c.role));
  const headerText = header.text || "";
  const headerAndSamples = [
    headerText,
    ...(rows || []).slice(0, 8).map((row) => row.text || (row.cells || []).join(" ")),
  ].join(" ");
  const looksBitfield = /\b(Bit|Bit Name|Field|R\/W|Access|Description|Initial Value)\b/i.test(headerAndSamples) || knownRoles.has("bit") || knownRoles.has("bitfield");
  const looksRegister = /\b(Register Name|Abbreviation|Offset Address|Initial Value|Access Size)\b/i.test(headerAndSamples) || knownRoles.has("offset") || knownRoles.has("register") || knownRoles.has("abbreviation");
  const looksPinmux = /\b(Pin\s*Name|Pin\s*No\.?|Pin\s*Number|Pin\s*Function|Alternate\s*Function|Alt\s*Function|Function\s*Assignment|Function\s*Select|Selectable\s*Function|Port\s*Name|GPIO\s*Port|I\/O\s*Port|Peripheral\s*Signal|Signal\s*Name|Mux\s*Mode|Pinmux|Pin\s*Mux|PFC|IOPORT|PMC|PMm|PFCm)\b/i.test(headerAndSamples) || knownRoles.has("pin") || knownRoles.has("port") || knownRoles.has("function") || knownRoles.has("signal") || knownRoles.has("peripheral");
  if (looksBitfield && !looksPinmux && (columns || []).length >= 4) {
    const fallback = ["bit", "bitfield", "access", "reset", "description"];
    for (let i = 0; i < Math.min(fallback.length, columnRoles.length); i += 1) {
      if (columnRoles[i].role === "unknown" || columnRoles[i].confidence < 45) {
        columnRoles[i].role = fallback[i]; columnRoles[i].confidence = Math.max(columnRoles[i].confidence, 42); columnRoles[i].fallback = true;
      }
    }
  } else if (looksRegister && !looksPinmux && (columns || []).length >= 4) {
    const fallback = ["register", "abbreviation", "offset", "reset", "accessSize", "description"];
    for (let i = 0; i < Math.min(fallback.length, columnRoles.length); i += 1) {
      if (columnRoles[i].role === "unknown" || columnRoles[i].confidence < 45) {
        columnRoles[i].role = fallback[i]; columnRoles[i].confidence = Math.max(columnRoles[i].confidence, 42); columnRoles[i].fallback = true;
      }
    }
  } else if (looksPinmux && (columns || []).length >= 2) {
    const fallback = ["pin", "function", "signal", "peripheral", "mode", "description"];
    for (let i = 0; i < Math.min(fallback.length, columnRoles.length); i += 1) {
      if (columnRoles[i].role === "unknown" || columnRoles[i].confidence < 45) {
        columnRoles[i].role = fallback[i]; columnRoles[i].confidence = Math.max(columnRoles[i].confidence, 42); columnRoles[i].fallback = true;
      }
    }
  }
  const roleMap = {};
  for (const column of columnRoles) if (column.role !== "unknown" && (!roleMap[column.role] || column.confidence > roleMap[column.role].confidence)) roleMap[column.role] = column;
  const warnings = columnRoles.filter((c) => c.ambiguous).map((c) => `column ${c.column} role ${c.role} is ambiguous`).slice(0, 8);
  return { headerRowIndex: header.rowIndex, headerScore: header.score, columnRoles, roleMap, kindHint: looksPinmux ? "pinmux-table" : looksBitfield ? "bitfield-table" : looksRegister ? "register-table" : "table-candidate", warnings };
}

export function cellByRole(row, layout, roles) {
  for (const role of Array.isArray(roles) ? roles : [roles]) {
    const column = layout?.roleMap?.[role];
    if (!column) continue;
    const value = (row.cells || [])[column.column];
    if (value) return normalizeRegisterCell(value);
  }
  return "";
}

export function rowCellsByRole(row, layout) {
  const cellsByRole = {};
  for (const column of layout?.columnRoles || []) {
    if (column.role === "unknown") continue;
    const value = (row.cells || [])[column.column];
    if (value) cellsByRole[column.role] = [cellsByRole[column.role], normalizeRegisterCell(value)].filter(Boolean).join(" ").trim();
  }
  return cellsByRole;
}

export function enrichCoordinateTableLayout(table) {
  const layout = inferLayoutColumnRoles(table.rows || [], table.columns || []);
  const rows = (table.rows || []).map((row, index) => ({ ...row, rawCells: row.cells || [], cellsByRole: rowCellsByRole(row, layout), isHeaderCandidate: index <= layout.headerRowIndex }));
  const roleNames = new Set((layout.columnRoles || []).map((c) => c.role));
  let kind = table.kind;
  if (layout.kindHint === "bitfield-table" && (roleNames.has("bit") || roleNames.has("bitfield"))) kind = "bitfield-table";
  if (layout.kindHint === "register-table" && (roleNames.has("register") || roleNames.has("abbreviation") || roleNames.has("offset"))) kind = "register-table";
  if (layout.kindHint === "pinmux-table" && (roleNames.has("pin") || roleNames.has("port") || roleNames.has("function") || roleNames.has("signal") || roleNames.has("peripheral"))) kind = "pinmux-table";
  const roleScore = [...roleNames].filter((role) => role !== "unknown").length * 4;
  const confidence = Math.min(100, Math.max(table.confidence || 0, scoreCoordinateTable(table.headerText, rows)) + roleScore - (layout.warnings || []).length * 2);
  return { ...table, kind, rows, layout, confidence };
}

export const COMMON_NON_BITFIELD_WORDS = new Set([
  "ADDRESS", "OFFSET", "REGISTER", "REGISTERS", "DESCRIPTION", "INITIALVALUE",
  "INITIAL", "VALUE", "ACCESS", "SIZE", "BITS", "BIT", "BITNAME", "NAME",
  "READ", "WRITE", "READONLY", "WRITEONLY", "RESERVED", "UNDEFINED",
  "CAUTION", "CAUTIONS", "NOTE", "NOTES", "TABLE", "FIGURE", "PAGE", "CHAPTER",
  "SECTION", "MODULE", "FUNCTION", "OPERATION", "PROCEDURE", "SETTING", "SETTINGS",
  "CONTROL", "STATUS", "TRANSFER", "REQUEST", "INTERRUPT", "ERROR", "CHANNEL",
  "CHANNELS", "DMA", "DMAC", "DMACM", "BASE", "OFFSETADDRESS", "ACCESSSIZE",
  "H", "B", "RW", "RO", "WO", "R", "W"
]);
for (const word of BITFIELD_NOISE_WORDS) COMMON_NON_BITFIELD_WORDS.add(word);

export function isLikelyRegisterName(value) {
  const raw = String(value || "").trim();
  const canonical = canonicalSymbol(raw);
  if (!canonical) return false;

  // Prefer the existing register-symbol heuristic where available.
  if (typeof looksLikeRegisterSymbol === "function" && looksLikeRegisterSymbol(raw)) return true;

  return (
    /(?:^|_)(REG|REGISTER)$/.test(canonical) ||
    /(CR|SR|DR|MR|ER|FR|RR|TR|BR|AR|LR|PR|CSR|ISR|IER|ICR|CTRL|STAT|CFG|DCTRL|CHCTRL|CHSTAT)$/.test(canonical) ||
    /^(DMAC|DMA|GBETH|ETH|GMAC|MAC|MTL|WDT|GPT|POEG|ICU|I3C|I2C|SPI|UART|CAN|ADC)[A-Z0-9_]*$/.test(canonical)
  );
}

export function extractBitRangeFromValue(value) {
  const match = String(value || "").match(/\b(?:[0-9]{1,2}\s*[:：]\s*[0-9]{1,2}|[0-9]{1,2}|\[[0-9]{1,2}\s*[:：]?\s*[0-9]{0,2}\])\b/);
  return match ? match[0].replace(/[\[\]\s]/g, "").replace("：", ":") : "unknown";
}

export function normalizeAccessValue(value) {
  const match = String(value || "").trim().match(/\b(R\s*\/\s*W|R\s*\/\s*O|W\s*\/\s*O|R\s*W|RO|WO|RW|R|W|Read only|Write only|Read\/Write)\b/i);
  return match ? match[0].replace(/\s+/g, "").toUpperCase() : "unknown";
}

export function extractResetValue(value) {
  const match = String(value || "").trim().match(/\b(?:0x[0-9A-Fa-f]+|[0-9A-Fa-f]+h|[01]+b|[01]|undefined|reserved|−|-)\b/);
  return match ? match[0] : "unknown";
}

export function parseCoordinateBitfieldSemantics(rowText, bitfield, bitCell = "", fieldCell = "") {
  const parsed = parseBitfieldSemantics([bitCell, fieldCell, rowText].filter(Boolean).join(" "), bitfield);
  const fallbackPosition = normalizeHardwareRange(bitCell || extractBitRangeFromValue(rowText));
  const fieldText = String(fieldCell || "").trim();
  const parsedFieldCell = parseBitfieldSemantics(fieldText || rowText, bitfield).fieldBitRange;
  const fallbackField = parsedFieldCell !== "unknown"
    ? parsedFieldCell
    : (/^\[?\s*[0-9]{1,2}\s*[:\-]\s*[0-9]{1,2}\s*\]?$/.test(fieldText) ? normalizeHardwareRange(fieldText) : "unknown");
  const bitPositionRange = parsed.bitPositionRange !== "unknown"
    ? parsed.bitPositionRange
    : fallbackPosition;
  const fieldBitRange = parsed.fieldBitRange !== "unknown"
    ? parsed.fieldBitRange
    : fallbackField;
  return {
    ...parsed,
    bitPositionRange,
    fieldBitRange,
    bitRange: bitPositionRange !== "unknown" ? bitPositionRange : fieldBitRange,
    access: parsed.access !== "unknown" ? parsed.access : normalizeAccessValue(rowText),
    reset: parsed.reset !== "unknown" ? parsed.reset : normalizeBitfieldReset(extractResetValue(rowText)),
  };
}

export function likelyDescriptionFromCells(row, layout, usedRoles = []) {
  const used = new Set(usedRoles);
  const parts = [];
  for (const column of layout?.columnRoles || []) {
    if (used.has(column.role)) continue;
    const value = (row.cells || [])[column.column];
    if (value) parts.push(value);
  }
  if (!parts.length) parts.push(cellByRole(row, layout, "description"));
  return normalizeRegisterCell(parts.join(" "));
}

export async function extractTablesFromPagesNode(filename, options = {}) {
  const pageCount = await getPdfPageCount(filename);
  let start = Math.floor(Number(options.startPage));
  let end = Math.floor(Number(options.endPage));
  if (!Number.isFinite(start)) start = 1;
  if (!Number.isFinite(end)) end = start + DEFAULT_TABLE_PAGE_RANGE - 1;
  start = clampInteger(start, 1, 1, pageCount);
  end = clampInteger(end, start, start, Math.min(pageCount, start + MAX_TABLE_PAGE_RANGE - 1));

  if (options.preferArtifact !== false) {
    const tablesIndex = await loadTablesIndex(filename).catch(() => null);
    if (tablesIndex) {
      const indexedTables = (tablesIndex.tables || []).filter((table) =>
        Number(table.pageEnd || table.page) >= start &&
        Number(table.pageStart || table.page) <= end &&
        Number(table.columns?.length || 0) >= Number(options.minColumns || 3)
      );
      if (indexedTables.length) {
        return { filename, pageCount, startPage: start, endPage: end, tables: indexedTables.slice(0, MAX_EXTRACTED_TABLES), source: "tables-index" };
      }
    }
  }

  const coordinateRows = await extractPdfCoordinateRows(filename, start, end);
  const tables = extractTablesFromCoordinateRows(coordinateRows, {
    minColumns: options.minColumns || 3,
  });

  return {
    filename,
    pageCount,
    startPage: start,
    endPage: end,
    tables,
  };
}

export async function extractTablesFromPages(filename, options = {}) {
  return extractTablesFromPagesEngine(filename, options);
}

export function formatExtractedTables(result) {
  const tables = result.tables || [];
  if (!tables.length) {
    return [
      `No coordinate table candidates found in ${result.filename} from page ${result.startPage} to ${result.endPage}.`,
      "",
      "Suggested next steps:",
      `- read_pdf_pages(filename="${result.filename}", start_page=${result.startPage}, end_page=${result.endPage})`,
      "- Try a smaller/larger page range around the register list or bit-field description.",
    ].join("\n");
  }

  const lines = [
    `Coordinate table extraction for ${result.filename}`,
    `Pages: ${result.startPage}-${result.endPage}`,
    `Tables detected: ${tables.length}`,
    "Reliability: coordinate-based heuristic. Verify original PDF pages before writing driver macros.",
  ];

  tables.forEach((table, tableIndex) => {
    lines.push("", `Table ${tableIndex + 1}`, table.tableId ? `Table ID: ${table.tableId}` : null, `Pages: ${table.pageStart || table.page}${Number(table.pageEnd || table.page) !== Number(table.pageStart || table.page) ? `-${table.pageEnd}` : ""}`, `Kind: ${table.kind}`, `Confidence: ${table.confidence}`, `Columns: ${table.columns.map((c) => `${c.index}@x${c.x}`).join(", ")}`);
    lines.push("Rows:");
    for (const row of (table.rows || []).slice(0, 20)) {
      lines.push(`- ${row.cells.map((cell) => cell || ".").join(" | ")}`);
    }
    if ((table.rows || []).length > 20) lines.push(`... ${table.rows.length - 20} more rows omitted`);
  });

  lines.push("", "Machine summary JSON:", JSON.stringify({ schemaVersion: 1, filename: result.filename, source: result.source || "coordinate-extraction", startPage: result.startPage, endPage: result.endPage, tableCount: tables.length, tables: tables.map((table) => ({ tableId: table.tableId || null, kind: table.kind, pageStart: table.pageStart || table.page, pageEnd: table.pageEnd || table.page, rowCount: table.rowCount || table.rows?.length || 0, confidence: table.confidence, warnings: table.warnings || table.layout?.warnings || [] })) }, null, 2));
  return lines.join("\n");
}

export function formatLayoutExtractedTables(result, kindFilter = "auto") {
  const wanted = String(kindFilter || "auto").toLowerCase();
  let tables = result.tables || [];
  if (wanted === "register") tables = tables.filter((table) => table.kind === "register-table");
  if (wanted === "bitfield") tables = tables.filter((table) => table.kind === "bitfield-table");
  if (wanted === "pinmux") tables = tables.filter((table) => table.kind === "pinmux-table");
  if (!tables.length) {
    return withVisualSemanticGuard([`No layout-aware table candidates found in ${result.filename} from page ${result.startPage} to ${result.endPage}.`, `Kind filter: ${wanted}`, "", "Suggested next steps:", `- read_pdf_pages(filename="${result.filename}", start_page=${result.startPage}, end_page=${result.endPage})`, "- Try a smaller page range around the exact register/bit-field/pin-function description pages."].join("\n"), `${result.filename} ${result.startPage}-${result.endPage}`, { filename: result.filename, mode: "layout-table", force: true });
  }
  const lines = [`Step 30A/30B layout-aware table extraction for ${result.filename}`, `Pages: ${result.startPage}-${result.endPage}`, `Kind filter: ${wanted}`, `Tables shown: ${tables.length}`, "Reliability: coordinate/text-item extraction, not visual semantic truth. Use it to preserve row/column structure, but for captioned visual tables (bit layout, MSB/LSB arrangement, data format, timing/waveform) use search_figures -> get_figure_context_pack -> get_figure_image and open/attach the canonical PNG as actual model vision input."];
  tables.forEach((table, index) => {
    lines.push("", `Table ${index + 1}`, table.tableId ? `Table ID: ${table.tableId}` : null, `Pages: ${table.pageStart || table.page}${Number(table.pageEnd || table.page) !== Number(table.pageStart || table.page) ? `-${table.pageEnd}` : ""}`, `Kind: ${table.kind}`, `Confidence: ${table.confidence}`);
    const roles = (table.layout?.columnRoles || []).map((col) => `${col.column}@x${Math.round(col.x)}=${col.role}${col.ambiguous ? "?" : ""}${col.fallback ? "*" : ""}`).join(", ");
    lines.push(`Columns: ${roles || table.columns.map((c) => `${c.index}@x${c.x}`).join(", ")}`);
    if ((table.layout?.warnings || []).length) lines.push(`Layout warnings: ${table.layout.warnings.join("; ")}`);
    lines.push("Rows:");
    for (const row of (table.rows || []).slice(0, 24)) {
      const roleText = Object.keys(row.cellsByRole || {}).length ? ` {${Object.entries(row.cellsByRole).map(([k, v]) => `${k}: ${v}`).join("; ")}}` : "";
      lines.push(`- ${row.rawCells ? row.rawCells.join(" | ") : (row.cells || []).join(" | ")}${roleText}`);
    }
    if ((table.rows || []).length > 24) lines.push(`... ${table.rows.length - 24} more rows omitted`);
  });
  lines.push("", "Machine summary JSON:", JSON.stringify({ schemaVersion: 1, filename: result.filename, source: result.source || "coordinate-extraction", kindFilter: wanted, tableCount: tables.length, tables: tables.map((table) => ({ tableId: table.tableId || null, kind: table.kind, pageStart: table.pageStart || table.page, pageEnd: table.pageEnd || table.page, rowCount: table.rowCount || table.rows?.length || 0, confidence: table.confidence, warnings: table.warnings || table.layout?.warnings || [] })) }, null, 2));
  return withVisualSemanticGuard(lines.join("\n"), lines.join("\n"), { filename: result.filename, mode: "layout-table" });
}

export function normalizeRegisterCell(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function extractRegisterRowsFromCoordinateTable(table) {
  const rows = [];
  const allRows = table.rows || [];
  const layout = table.layout || inferLayoutColumnRoles(allRows, table.columns || []);
  const headerIndex = Number.isFinite(layout.headerRowIndex) ? layout.headerRowIndex : allRows.findIndex((row) => /\b(Register Name|Abbreviation|Offset Address|Initial Value|Access Size)\b/i.test(row.text));
  const startIndex = headerIndex >= 0 ? headerIndex + 1 : 0;
  let previous = null;
  for (const row of allRows.slice(startIndex)) {
    const rowText = normalizeRegisterCell(row.text);
    if (!rowText || /\b(Register Name|Abbreviation|Offset Address|Initial Value|Access Size)\b/i.test(rowText)) continue;
    const registerCell = cellByRole(row, layout, ["abbreviation", "register"]);
    const symbolMatch = registerCell.match(/\b[A-Z0-9]+m?_[A-Za-z0-9_]+(?:_n)?\b|\b[A-Z][A-Z0-9_]{2,}\b/) || rowText.match(/\b[A-Z0-9]+m?_[A-Za-z0-9_]+(?:_n)?\b|\b[A-Z][A-Z0-9_]{2,}\b/);
    if (!symbolMatch) {
      if (previous && rowText.length > 8 && !/(?:\+\s*)?[0-9A-F]{3,8}h/i.test(rowText)) {
        previous.description = normalizeRegisterCell([previous.description, rowText].filter(Boolean).join(" "));
        previous.evidence = normalizeRegisterCell([previous.evidence, rowText].filter(Boolean).join(" / "));
        previous.continuationRows = (previous.continuationRows || 0) + 1;
      }
      continue;
    }
    const register = normalizeRegisterCell(symbolMatch[0]);
    if (isNonRegisterSignal(register)) continue;
    const offsetCell = cellByRole(row, layout, "offset");
    const resetCell = cellByRole(row, layout, "reset");
    const accessSizeCell = cellByRole(row, layout, "accessSize");
    const descriptionCell = cellByRole(row, layout, "description");
    const offsetMatch = (offsetCell || rowText).match(/(?:\+\s*)?[0-9A-F]{3,8}h(?:\s*\+\s*[A-Za-z0-9_ ]+)?/i);
    const initialMatch = resetCell ? [resetCell] : rowText.match(/\b(?:0x[0-9A-Fa-f]+|[0-9A-Fa-f]{1,8}h|[01]+b|0|1)\b/i);
    const accessSizeMatch = (accessSizeCell || rowText).match(/\b(8|16|32|64|128)\b(?:\s*bits?)?/i);
    const description = descriptionCell || likelyDescriptionFromCells(row, layout, ["register", "abbreviation", "offset", "reset", "accessSize"]);
    let confidence = table.kind === "register-table" ? 72 : 54;
    if (offsetMatch) confidence += 12;
    if (initialMatch) confidence += 6;
    if (accessSizeMatch) confidence += 5;
    if (layout.roleMap?.offset || layout.roleMap?.abbreviation || layout.roleMap?.register) confidence += 8;
    if ((layout.warnings || []).length) confidence -= Math.min(10, layout.warnings.length * 2);
    previous = { register, offsetAddress: offsetMatch ? offsetMatch[0].replace(/\s+/g, "") : "unknown", initialValue: initialMatch ? initialMatch[0] : "unknown", accessSize: accessSizeMatch ? accessSizeMatch[0] : "unknown", description: description || "candidate register-map row", page: row.sourcePage || table.page, tableId: table.tableId || null, rowId: row.rowId || null, confidence: Math.max(1, Math.min(98, confidence)), evidence: rowText, source: table.tableId ? "tables-index" : "layout-aware-coordinate-table", layoutRoles: layout.columnRoles, layoutWarnings: layout.warnings || [], rawCells: row.rawCells || row.cells || [], cellsByRole: row.cellsByRole || rowCellsByRole(row, layout) };
    rows.push(previous);
  }
  return rows;
}

export async function extractRegisterTable(filename, options = {}) {
  const filter = String(options.filter || "").trim();
  const topK = clampRegisterListTopK(options.topK);
  const pageCount = await getPdfPageCount(filename);

  let ranges = [];
  if (Number.isFinite(Number(options.startPage)) && Number.isFinite(Number(options.endPage))) {
    const start = clampInteger(options.startPage, 1, 1, pageCount);
    const end = clampInteger(options.endPage, start, start, Math.min(pageCount, start + MAX_TABLE_PAGE_RANGE - 1));
    ranges = [{ start, end }];
  } else {
    const sections = await loadSectionsIndex(filename).catch(() => null);
    const pages = new Set();
    for (const section of (sections && sections.sections) || []) {
      if (/register|address|map|list/i.test(section.title || "")) pages.add(section.page);
    }
    const registers = await loadRegistersIndex(filename).catch(() => null);
    for (const reg of (registers && registers.registers || []).slice(0, 12)) {
      for (const page of reg.pages || []) pages.add(page);
    }
    if (!pages.size) pages.add(1);
    ranges = [...pages].sort((a, b) => a - b).slice(0, 8).map((page) => ({
      start: clampInteger(page, 1, 1, pageCount),
      end: Math.min(pageCount, page + DEFAULT_TABLE_PAGE_RANGE - 1),
    }));
  }

  const seen = new Map();
  for (const range of ranges) {
    const extracted = await extractTablesFromPages(filename, {
      startPage: range.start,
      endPage: range.end,
      minColumns: 3,
    });
    for (const table of extracted.tables || []) {
      if (table.kind !== "register-table" && !/register/i.test(table.headerText || "")) continue;
      for (const row of extractRegisterRowsFromCoordinateTable(table)) {
        if (filter && !normalizeForSearch(`${row.register} ${row.description}`).includes(normalizeForSearch(filter))) continue;
        const key = canonicalSymbol(row.register);
        const prev = seen.get(key);
        if (!prev || row.confidence > prev.confidence) seen.set(key, row);
      }
    }
  }

  const rows = [...seen.values()]
    .sort((a, b) => b.confidence - a.confidence || a.page - b.page || a.register.localeCompare(b.register))
    .slice(0, topK);

  return { filename, filter, rows };
}


export function buildRegisterTableEvidenceContract(result) {
  const rows = (result.rows || []).slice(0, 20);
  const evidence = rows.map((row) => makeEvidence({
    source: "layout-aware-register-table",
    evidenceType: "register-table",
    page: row.page,
    quote: row.evidence || `${row.register} ${row.offsetAddress || "unknown"}`,
    confidence: row.confidence || "medium",
    name: row.register,
    field: "register",
    tool: "extract_register_table",
  }));
  const inference = rows.map((row) => makeInference({
    statement: `${row.register}: offset=${row.offsetAddress || "unknown"}, initial=${row.initialValue || "unknown"}, accessSize=${row.accessSize || "unknown"}`,
    basis: row.evidence || row.description || "coordinate-table row",
    confidence: row.confidence || "medium",
    risk: "Do not use offset/reset/access-size in driver macros until verified against original manual table.",
  }));
  const needsVerification = [];
  for (const row of rows) {
    if (!row.offsetAddress || row.offsetAddress === "unknown") needsVerification.push(makeNeedsVerification({ item: `${row.register} offset address`, reason: "Offset address was not explicit in coordinate extraction output.", suggestedTools: [`find_register(filename="${result.filename}", register="${row.register}")`, `read_pdf_pages(filename="${result.filename}", start_page=${row.page}, end_page=${row.page + 2})`] }));
    if (!row.initialValue || row.initialValue === "unknown") needsVerification.push(makeNeedsVerification({ item: `${row.register} initial/reset value`, reason: "Initial/reset value was not explicit in coordinate extraction output.", suggestedTools: [`read_pdf_pages(filename="${result.filename}", start_page=${row.page}, end_page=${row.page + 2})`] }));
    if (!row.accessSize || row.accessSize === "unknown") needsVerification.push(makeNeedsVerification({ item: `${row.register} access size`, reason: "Access size was not explicit in coordinate extraction output.", suggestedTools: [`read_pdf_pages(filename="${result.filename}", start_page=${row.page}, end_page=${row.page + 2})`] }));
  }
  return makeEvidenceContract({
    tool: "extract_register_table",
    filename: result.filename,
    query: result.filter || "register table",
    evidence,
    inference,
    needsVerification,
    warnings: ["Layout-aware register-table extraction is heuristic; verify original manual table before driver macro updates."],
    recommendedNextTools: [`list_registers(filename="${result.filename}", top_k=100)`, `read_pdf_pages(filename="${result.filename}", start_page=<page>, end_page=<page+2>)`],
  });
}

export function formatExtractedRegisterTable(result) {
  const rows = result.rows || [];
  if (!rows.length) {
    return [
      `No coordinate register table rows found in ${result.filename}.`,
      result.filter ? `Filter: ${result.filter}` : "Filter: none",
      "",
      "Suggested next steps:",
      `- list_registers(filename="${result.filename}", top_k=100)`,
      "- Use extract_tables_from_pages around the register-list pages.",
      "- Use read_pdf_pages to inspect the register map manually if the table layout is complex.",
    ].join("\n");
  }

  const lines = [
    `Step 30A layout-aware register table extraction for ${result.filename}`,
    result.filter ? `Filter: ${result.filter}` : "Filter: none",
    `Rows: ${rows.length}`,
    "Reliability: coordinate-based heuristic. Verify offset/reset/access against the original PDF before writing macros.",
    "",
    "| # | Register | Offset | Initial | Access Size | Page | Confidence | Description / Evidence |",
    "|---:|---|---|---|---|---:|---:|---|",
  ];

  rows.forEach((row, index) => {
    lines.push(`| ${index + 1} | ${row.register} | ${row.offsetAddress || "unknown"} | ${row.initialValue || "unknown"} | ${row.accessSize || "unknown"} | ${row.page} | ${row.confidence} | ${String(row.description || row.evidence || "").replace(/\|/g, "/").slice(0, 180)} |`);
  });

  const text = lines.join("\n");
  return appendEvidenceContract(text, buildRegisterTableEvidenceContract(result));
}


export function normalizePinmuxFilterText(value) {
  return normalizeForSearch(String(value || "").replace(/[()\[\]{}]/g, " "));
}

export function extractPinNameFromText(text) {
  const source = String(text || "");
  const match = source.match(/\b(?:P[A-Z0-9]*\d+[_\-]\d+|P\d+[_\-]\d+|GPIO\d+[_\-]\d+|P[A-Z]?\d{1,3}|PORT\d+)\b/i);
  return match ? match[0].replace("-", "_") : "";
}

export function isPinmuxHeaderOrNoise(text) {
  const value = normalizeForSearch(text);
  if (!value) return true;
  if (/^(pin|pins|port|ports|function|functions|signal|signals|peripheral|peripherals|mode|mux|group|description|remarks|note|table)$/.test(value)) return true;
  if (/\b(pin name|pin no|pin number|pin function|alternate function|port name|signal name|peripheral signal|function select)\b/.test(value)) return true;
  return false;
}

export function pinmuxFunctionCellsForRow(row, layout) {
  const cells = [];
  const usedRoles = new Set(["pin", "port", "group", "description"]);
  for (const column of layout?.columnRoles || []) {
    const value = normalizeRegisterCell((row.cells || [])[column.column]);
    if (!value || isPinmuxHeaderOrNoise(value)) continue;
    const header = normalizeRegisterCell(column.header || "");
    const role = column.role || "unknown";
    if (["function", "signal", "peripheral", "mode", "mux"].includes(role)) {
      cells.push({ role, header, value, column: column.column });
      continue;
    }
    if (!usedRoles.has(role) && /\b(function|signal|peripheral|alt|af\d+|mode|mux|sel|select)\b/i.test(header)) {
      cells.push({ role: role === "unknown" ? "function" : role, header, value, column: column.column });
    }
  }
  return cells;
}

export function extractPinmuxRowsFromCoordinateTable(table, options = {}) {
  const rows = [];
  const allRows = table.rows || [];
  const layout = table.layout || inferLayoutColumnRoles(allRows, table.columns || []);
  const headerIndex = Number.isFinite(layout.headerRowIndex)
    ? layout.headerRowIndex
    : allRows.findIndex((row) => /\b(Pin\s*Name|Pin\s*No|Pin\s*Number|Pin\s*Function|Alternate\s*Function|Function\s*Select|Port\s*Name|GPIO\s*Port|Peripheral\s*Signal|Signal\s*Name|Mux\s*Mode|Pinmux|Pin\s*Mux|PFC|IOPORT)\b/i.test(row.text));
  const startIndex = headerIndex >= 0 ? headerIndex + 1 : 0;
  const filter = normalizePinmuxFilterText(options.filter || "");
  const pinFilter = normalizePinmuxFilterText(options.pin || "");
  const functionFilter = normalizePinmuxFilterText(options.functionName || options.function || "");

  for (const row of allRows.slice(startIndex)) {
    const rowText = normalizeRegisterCell(row.text);
    if (!rowText || isPinmuxHeaderOrNoise(rowText)) continue;
    const cellsByRole = row.cellsByRole || rowCellsByRole(row, layout);
    const pinCell = cellByRole(row, layout, ["pin", "port"]) || extractPinNameFromText(rowText);
    const portCell = cellByRole(row, layout, "port");
    const groupCell = cellByRole(row, layout, "group");
    const descCell = cellByRole(row, layout, "description");
    const functionCells = pinmuxFunctionCellsForRow(row, layout);
    let pin = normalizeRegisterCell(pinCell);
    let port = normalizeRegisterCell(portCell);
    if (!pin && port) pin = port;
    if (!port && pin && /^P[A-Z0-9]*\d+$/i.test(pin)) port = pin;
    const fallbackFunction = normalizeRegisterCell(cellByRole(row, layout, ["function", "signal", "peripheral", "mode"]) || likelyDescriptionFromCells(row, layout, ["pin", "port", "group", "description"]));
    const candidates = functionCells.length ? functionCells : (fallbackFunction ? [{ role: "function", header: "", value: fallbackFunction, column: -1 }] : []);
    for (const candidate of candidates) {
      const functionName = normalizeRegisterCell(candidate.value);
      if (!functionName || functionName === pin || functionName === port || isPinmuxHeaderOrNoise(functionName)) continue;
      const signal = candidate.role === "signal" ? functionName : (cellByRole(row, layout, "signal") || "");
      const peripheral = candidate.role === "peripheral" ? functionName : (cellByRole(row, layout, "peripheral") || "");
      const mode = candidate.role === "mode" ? functionName : (cellByRole(row, layout, "mode") || candidate.header || "");
      const description = normalizeRegisterCell([descCell, candidate.header && candidate.header !== functionName ? `column=${candidate.header}` : "", rowText].filter(Boolean).join(" / "));
      const haystack = normalizePinmuxFilterText([pin, port, groupCell, functionName, signal, peripheral, mode, description, rowText].join(" "));
      if (filter && !haystack.includes(filter)) continue;
      if (pinFilter && !normalizePinmuxFilterText([pin, port, rowText].join(" ")).includes(pinFilter)) continue;
      if (functionFilter && !normalizePinmuxFilterText([functionName, signal, peripheral, mode, rowText].join(" ")).includes(functionFilter)) continue;
      let confidence = table.kind === "pinmux-table" ? 72 : 50;
      if (pin) confidence += 12;
      if (functionName) confidence += 12;
      if (layout.roleMap?.pin || layout.roleMap?.port) confidence += 6;
      if (layout.roleMap?.function || layout.roleMap?.signal || layout.roleMap?.peripheral) confidence += 6;
      if ((layout.warnings || []).length) confidence -= Math.min(12, layout.warnings.length * 2);
      rows.push({ pin: pin || "unknown", port: port || "unknown", function: functionName, signal: signal || "", peripheral: peripheral || "", mode: mode || "", group: normalizeRegisterCell(groupCell || ""), description: description || "candidate pin function row", page: table.page, confidence: Math.max(1, Math.min(98, confidence)), evidence: rowText, source: "layout-aware-pinmux-table", layoutRoles: layout.columnRoles, layoutWarnings: layout.warnings || [], rawCells: row.rawCells || row.cells || [], cellsByRole });
    }
  }
  return rows;
}

export async function findPinmuxCandidatePages(filename, options = {}) {
  if (options.startPage !== undefined && options.endPage !== undefined) return [];
  const query = [options.filter, options.pin, options.functionName || options.function, "pin function pinmux pin mux port gpio peripheral signal alternate function pfc i/o port"].filter(Boolean).join(" ");
  const pages = new Set();
  try {
    const search = await searchPdfIndex(filename, query, 12);
    for (const result of search.results || []) if (result.page) pages.add(result.page);
  } catch {}
  return [...pages].sort((a, b) => a - b).slice(0, 8);
}

export async function extractPinmuxTable(filename, options = {}) {
  const topK = clampRegisterListTopK(options.topK);
  const minColumns = clampInteger(options.minColumns, 2, 2, MAX_TABLE_COLUMNS);
  const pageCount = await getPdfPageCount(filename);
  const rows = [];
  let startPage = options.startPage === undefined ? undefined : Number(options.startPage);
  let endPage = options.endPage === undefined ? undefined : Number(options.endPage);
  const searchedPages = [];
  if (Number.isFinite(startPage)) {
    if (!Number.isFinite(endPage)) endPage = startPage + DEFAULT_TABLE_PAGE_RANGE - 1;
    startPage = clampInteger(startPage, 1, 1, pageCount);
    endPage = clampInteger(endPage, startPage, startPage, Math.min(pageCount, startPage + MAX_TABLE_PAGE_RANGE - 1));
    const extracted = await extractTablesFromPages(filename, { startPage, endPage, minColumns });
    for (const table of extracted.tables || []) {
      if (table.kind !== "pinmux-table" && !/pin|port|gpio|function|signal|peripheral|pinmux|pin\s*mux|pfc|ioport/i.test(table.headerText || "")) continue;
      rows.push(...extractPinmuxRowsFromCoordinateTable(table, options));
    }
  } else {
    const candidatePages = await findPinmuxCandidatePages(filename, options);
    for (const page of candidatePages) {
      searchedPages.push(page);
      const extracted = await extractTablesFromPages(filename, { startPage: page, endPage: Math.min(pageCount, page + 1), minColumns });
      for (const table of extracted.tables || []) {
        if (table.kind !== "pinmux-table" && !/pin|port|gpio|function|signal|peripheral|pinmux|pin\s*mux|pfc|ioport/i.test(table.headerText || "")) continue;
        rows.push(...extractPinmuxRowsFromCoordinateTable(table, options));
      }
    }
  }
  const seen = new Map();
  for (const row of rows) {
    const key = [canonicalSymbol(row.pin), canonicalSymbol(row.function), canonicalSymbol(row.mode), row.page].join(":");
    const prev = seen.get(key);
    if (!prev || row.confidence > prev.confidence) seen.set(key, row);
  }
  const finalRows = [...seen.values()].sort((a, b) => b.confidence - a.confidence || a.page - b.page || String(a.pin).localeCompare(String(b.pin))).slice(0, topK);
  return { filename, startPage: startPage || null, endPage: endPage || null, searchedPages, filter: options.filter || "", pin: options.pin || "", functionName: options.functionName || options.function || "", rows: finalRows };
}

export function buildPinmuxTableEvidenceContract(result) {
  const rows = (result.rows || []).slice(0, 20);
  const evidence = rows.map((row) => makeEvidence({ source: "layout-aware-pinmux-table", evidenceType: "pin-function-table", page: row.page, quote: row.evidence || `${row.pin} ${row.function}`, confidence: row.confidence || "medium", name: row.pin, field: row.function, tool: "extract_pinmux_table" }));
  const inference = rows.map((row) => makeInference({ statement: `${row.pin}: function=${row.function}${row.mode ? `, mode=${row.mode}` : ""}${row.peripheral ? `, peripheral=${row.peripheral}` : ""}`, basis: row.evidence || row.description || "layout-aware pinmux table row", confidence: row.confidence || "medium", risk: "Pinmux extraction is heuristic. Verify pin/function/mode against the original PDF table and the SoC pinctrl binding before editing DTS or pinctrl code." }));
  const needsVerification = [];
  for (const row of rows) {
    if (!row.pin || row.pin === "unknown") needsVerification.push(makeNeedsVerification({ item: "pin name", reason: "Pin/port column was not confidently identified.", suggestedTools: [`read_pdf_pages(filename="${result.filename}", start_page=${row.page}, end_page=${row.page})`] }));
    if (!row.function) needsVerification.push(makeNeedsVerification({ item: `${row.pin} function`, reason: "Function/signal column was not confidently identified.", suggestedTools: [`read_pdf_pages(filename="${result.filename}", start_page=${row.page}, end_page=${row.page})`] }));
  }
  return makeEvidenceContract({ tool: "extract_pinmux_table", filename: result.filename, query: [result.filter, result.pin, result.functionName].filter(Boolean).join(" ") || "pinmux table", evidence, inference, needsVerification, warnings: ["Layout-aware pinmux extraction is heuristic; verify original PDF tables before DTS/pinctrl changes."], recommendedNextTools: [`read_pdf_pages(filename="${result.filename}", start_page=<page>, end_page=<page+1>)`, `extract_tables_from_pages(filename="${result.filename}", start_page=<page>, end_page=<page+1>)`] });
}

export function formatExtractedPinmuxTable(result) {
  const rows = result.rows || [];
  if (!rows.length) {
    return [`No layout-aware pinmux/pin-function rows found in ${result.filename}.`, result.startPage ? `Pages: ${result.startPage}-${result.endPage}` : `Searched pages from index: ${(result.searchedPages || []).join(", ") || "none"}`, result.filter ? `Filter: ${result.filter}` : "Filter: none", result.pin ? `Pin filter: ${result.pin}` : "Pin filter: none", result.functionName ? `Function filter: ${result.functionName}` : "Function filter: none", "", "Suggested next steps:", `- search_pdf(filename="${result.filename}", query="pin function pinmux port gpio peripheral signal")`, `- extract_tables_from_pages(filename="${result.filename}", start_page=<page>, end_page=<page+1>)`, `- read_pdf_pages(filename="${result.filename}", start_page=<page>, end_page=<page+1>)`].join("\n");
  }
  const lines = [`Step 30B layout-aware pinmux / pin function extraction for ${result.filename}`, result.startPage ? `Pages: ${result.startPage}-${result.endPage}` : `Searched pages: ${(result.searchedPages || []).join(", ") || "none"}`, result.filter ? `Filter: ${result.filter}` : "Filter: none", result.pin ? `Pin filter: ${result.pin}` : "Pin filter: none", result.functionName ? `Function filter: ${result.functionName}` : "Function filter: none", `Rows: ${rows.length}`, "Reliability: layout-aware coordinate heuristic. Verify pin/function/mode against the original PDF before DTS/pinctrl changes.", "", "| # | Pin/Port | Function / Signal | Peripheral | Mode/Select | Page | Confidence | Evidence |", "|---:|---|---|---|---|---:|---:|---|"];
  rows.forEach((row, index) => {
    const fn = [row.function, row.signal && row.signal !== row.function ? row.signal : ""].filter(Boolean).join(" / ");
    lines.push(`| ${index + 1} | ${String(row.pin || row.port || "unknown").replace(/\|/g, "/")} | ${String(fn || "unknown").replace(/\|/g, "/")} | ${String(row.peripheral || "").replace(/\|/g, "/")} | ${String(row.mode || "").replace(/\|/g, "/")} | ${row.page} | ${row.confidence} | ${String(row.description || row.evidence || "").replace(/\|/g, "/").slice(0, 180)} |`);
  });
  return appendEvidenceContract(lines.join("\n"), buildPinmuxTableEvidenceContract(result));
}

export function extractBitfieldRowsFromCoordinateTable(table, register = "") {
  const rows = [];
  const allRows = table.rows || [];
  const layout = table.layout || inferLayoutColumnRoles(allRows, table.columns || []);
  const headerIndex = Number.isFinite(layout.headerRowIndex) ? layout.headerRowIndex : allRows.findIndex((row) => /\b(Bit|Bit Name|Field|Access|R\/W|Description|Initial Value)\b/i.test(row.text));
  const startIndex = headerIndex >= 0 ? headerIndex + 1 : 0;
  let previous = null;
  for (const row of allRows.slice(startIndex)) {
    const rowText = normalizeRegisterCell(row.text);
    if (!rowText || /\b(Bit Name|Description|Access|Initial Value)\b/i.test(rowText)) continue;
    if (register && canonicalSymbol(rowText).includes(canonicalSymbol(register)) && rowText.length < register.length + 10) continue;
    const bitCell = cellByRole(row, layout, "bit");
    const fieldCell = cellByRole(row, layout, "bitfield");
    const accessCell = cellByRole(row, layout, "access");
    const resetCell = cellByRole(row, layout, "reset");
    const descCell = cellByRole(row, layout, "description");
    let bitfield = normalizeRegisterCell(fieldCell);
    if (!bitfield || /^(bit|bits|reserved|description)$/i.test(bitfield)) {
      const symbolCandidates = rowText.match(/\b[A-Z][A-Z0-9_]{1,31}\b/g) || [];
      bitfield = symbolCandidates.find((symbol) => !COMMON_NON_BITFIELD_WORDS.has(symbol) && !isLikelyRegisterName(symbol) && canonicalSymbol(symbol) !== canonicalSymbol(register)) || "";
    }
    const semantics = parseCoordinateBitfieldSemantics(rowText, bitfield, bitCell, fieldCell);
    const bitRange = semantics.bitRange;
    if ((!bitfield || bitRange === "unknown") && previous && !fieldCell && !bitCell) {
      const continuation = descCell || rowText;
      if (continuation && continuation.length > 4) {
        previous.description = normalizeRegisterCell([previous.description, continuation].filter(Boolean).join(" "));
        previous.evidenceLines = [...(previous.evidenceLines || []), rowText].slice(0, 4);
        previous.continuationRows = (previous.continuationRows || 0) + 1;
      }
      continue;
    }
    if (!bitfield) continue;
    const access = semantics.access !== "unknown" ? semantics.access : normalizeAccessValue(accessCell || rowText);
    const reset = semantics.reset !== "unknown" ? semantics.reset : extractResetValue(resetCell || rowText);
    let description = descCell || likelyDescriptionFromCells(row, layout, ["bit", "bitfield", "access", "reset"]);
    description = description.replace(bitfield, "").replace(bitRange !== "unknown" ? bitRange : "", "").replace(access !== "unknown" ? access : "", "").replace(reset !== "unknown" ? reset : "", "").trim() || "candidate bit-field row";
    let confidence = table.kind === "bitfield-table" ? 74 : 56;
    if (bitRange !== "unknown") confidence += 12;
    if (access !== "unknown") confidence += 6;
    if (reset !== "unknown") confidence += 5;
    if (layout.roleMap?.bit && layout.roleMap?.bitfield) confidence += 8;
    if ((layout.warnings || []).length) confidence -= Math.min(10, layout.warnings.length * 2);
    previous = { bitRange, bitPositionRange: semantics.bitPositionRange, fieldBitRange: semantics.fieldBitRange, bitfield, access, reset, description, pages: [row.sourcePage || table.page], chunks: [], tableId: table.tableId || null, rowId: row.rowId || null, confidence: Math.max(1, Math.min(98, confidence)), evidenceLines: [rowText], source: table.tableId ? "tables-index" : "layout-aware-coordinate-table", layoutRoles: layout.columnRoles, layoutWarnings: layout.warnings || [], rawCells: row.rawCells || row.cells || [], cellsByRole: row.cellsByRole || rowCellsByRole(row, layout) };
    rows.push(previous);
  }
  return rows;
}

export async function extractBitfieldTable(filename, register, options = {}) {
  const topK = clampBitfieldListTopK(options.topK);
  const registerMatches = await searchRegistersIndex(filename, register, { topK: 3 }).catch(() => ({ results: [] }));
  const pages = new Set();

  for (const match of registerMatches.results || []) {
    for (const page of match.pages || []) pages.add(page);
    for (const chunk of match.chunks || []) if (chunk.page) pages.add(chunk.page);
  }

  if (!pages.size) {
    const indexRows = await extractBitfieldTableFromIndex(filename, register, options);
    return { ...indexRows, source: "bitfield-index-fallback" };
  }

  const rows = [];
  const pageCount = await getPdfPageCount(filename);
  for (const page of [...pages].sort((a, b) => a - b).slice(0, 6)) {
    const extracted = await extractTablesFromPages(filename, {
      startPage: Math.max(1, page - 1),
      endPage: Math.min(pageCount, page + 2),
      minColumns: 2,
    });
    for (const table of extracted.tables || []) {
      if (table.kind !== "bitfield-table" && !/bit|field|description|access|r\/w/i.test(table.headerText || "")) continue;
      rows.push(...extractBitfieldRowsFromCoordinateTable(table, register));
    }
  }

  const seen = new Map();
  for (const row of rows) {
    const key = `${canonicalSymbol(row.bitfield)}:${row.bitRange}`;
    const prev = seen.get(key);
    if (!prev || row.confidence > prev.confidence) seen.set(key, row);
  }

  const coordinateRows = [...seen.values()]
    .sort((a, b) => b.confidence - a.confidence || String(a.bitfield).localeCompare(String(b.bitfield)))
    .slice(0, Math.min(topK, MAX_BITFIELD_TABLE_ROWS));

  if (coordinateRows.length >= 2) {
    return {
      filename,
      register,
      source: "layout-aware-coordinate-table",
      rows: coordinateRows,
    };
  }

  const indexRows = await extractBitfieldTableFromIndex(filename, register, options);
  return {
    ...indexRows,
    source: coordinateRows.length ? "mixed-coordinate-and-index-fallback" : "bitfield-index-fallback",
    rows: coordinateRows.concat(indexRows.rows || []).slice(0, Math.min(topK, MAX_BITFIELD_TABLE_ROWS)),
  };
}

export function lineContainsBitfield(line, canonicalBitfield, rawBitfield) {
  const canonicalLine = canonicalSymbol(line);
  if (canonicalBitfield && canonicalLine.includes(canonicalBitfield)) return true;

  const raw = String(rawBitfield || "").trim();
  if (!raw) return false;

  return new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(raw)}([^A-Za-z0-9_]|$)`, "i").test(line);
}

export function extractBitfieldEvidenceLines(text, bitfield, maxLines = 8) {
  const lines = String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const canonicalBitfield = normalizeBitFieldName(bitfield);
  const evidence = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!lineContainsBitfield(line, canonicalBitfield, bitfield)) continue;

    const previous = index > 0 ? lines[index - 1] : "";
    const next = index + 1 < lines.length ? lines[index + 1] : "";
    const context = [previous, line, next].filter(Boolean).join(" / ");
    evidence.push(context.slice(0, 500));

    if (evidence.length >= maxLines) break;
  }

  return evidence;
}

export function scoreBitfieldChunk(chunk, bitfield, register = "", registerContext = null) {
  const rawBitfield = String(bitfield || "").trim();
  const rawRegister = String(register || "").trim();
  const canonicalBitfield = normalizeBitFieldName(rawBitfield);
  const canonicalRegister = normalizeRegisterName(rawRegister);

  if (!rawBitfield || !canonicalBitfield) return 0;

  const rawText = buildSearchText(chunk);
  const text = chunk.searchText || normalizeForSearch(rawText);
  const symbols = new Set((chunk.symbols || []).map(canonicalSymbol));
  const bitFields = new Set((chunk.bitFields || []).map(canonicalSymbol));
  const registers = new Set((chunk.registers || []).map(normalizeRegisterName));
  const headings = normalizeForSearch((chunk.headings || []).join("\n"));
  const normalizedBitfield = normalizeForSearch(rawBitfield);
  const normalizedRegister = normalizeForSearch(rawRegister);
  const evidenceLines = extractBitfieldEvidenceLines(rawText, rawBitfield, 12);

  let score = 0;

  if (bitFields.has(canonicalBitfield)) score += 150;
  if (symbols.has(canonicalBitfield)) score += 120;

  if (normalizedBitfield && text.includes(normalizedBitfield)) score += 45;

  const exactRegex = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(rawBitfield)}([^A-Za-z0-9_]|$)`, "gi");
  const exactMatches = rawText.match(exactRegex) || [];
  score += exactMatches.length * 20;

  for (const line of evidenceLines) {
    score += 18;
    if (/\b(Bit\s+Name|Bit|Bits?|Description|Setting|Value|Initial\s+Value|R\/W|Access|b[0-9]+|\[[0-9]+(?::[0-9]+)?\])\b/i.test(line)) {
      score += 28;
    }
    if (/\b(0|1|Set|Cleared|Enable|Disable|Transfer|Interrupt|Status|Error|Request)\b/i.test(line)) {
      score += 8;
    }
  }

  if (/\bBit\s+Name\b/i.test(rawText)) score += 20;
  if (/\bDescription\b/i.test(rawText)) score += 8;
  if (/\bInitial\s+Value\b/i.test(rawText)) score += 8;
  if (/\bAccess\s+Size\b/i.test(rawText)) score += 6;

  if (rawRegister) {
    if (canonicalRegister && registers.has(canonicalRegister)) score += 70;
    if (canonicalRegister && symbols.has(canonicalRegister)) score += 70;
    if (canonicalRegister && canonicalSymbol(rawText).includes(canonicalRegister)) score += 35;
    if (normalizedRegister && text.includes(normalizedRegister)) score += 25;
    if (normalizedRegister && headings.includes(normalizedRegister)) score += 30;

    if (registerContext) {
      if (registerContext.chunkIds && registerContext.chunkIds.has(chunk.id)) score += 120;
      if (registerContext.pages && registerContext.pages.has(Number(chunk.page))) score += 45;
      if (registerContext.names) {
        for (const name of registerContext.names) {
          if (registers.has(name) || symbols.has(name)) {
            score += 30;
            break;
          }
        }
      }
    }
  }

  // Avoid ranking pure register-map entries too high when they mention a bit-like symbol only incidentally.
  if (/\bRegister\s+Name\b/i.test(rawText) && !/\bBit\s+Name\b/i.test(rawText)) score -= 20;

  return Math.max(0, Math.round(score));
}

export async function findBitfieldInIndex(filename, bitfield, options = {}) {
  const rawBitfield = String(bitfield || "").trim();
  const rawRegister = String(options.register || "").trim();
  const topK = clampTopK(options.topK);

  if (!rawBitfield) throw new Error("bitfield is required");

  let registerResults = [];
  let registerContext = null;

  if (rawRegister) {
    const registerSearch = await searchRegistersIndex(filename, rawRegister, Math.max(topK, 8));
    registerResults = registerSearch.results;
    registerContext = collectRegisterContext(exactRegisterContextMatches(registerResults, rawRegister));
  }

  if (rawRegister && registerResults.length) {
    const indexData = await loadPdfIndex(filename);
    const scopedCandidates = new Map();
    const relatedChunkIds = new Set();
    const relatedPages = new Set();
    const scopedRegisterResults = exactRegisterContextMatches(registerResults, rawRegister);

    for (const entry of scopedRegisterResults) {
      for (const chunk of entry.chunks || []) {
        if (chunk.id) relatedChunkIds.add(chunk.id);
        if (Number.isFinite(Number(chunk.page))) relatedPages.add(Number(chunk.page));
      }
      for (const page of entry.pages || []) {
        if (Number.isFinite(Number(page))) relatedPages.add(Number(page));
      }
    }

    for (const chunk of indexData.chunks || []) {
      const nearPage = relatedPages.has(Number(chunk.page));
      const directChunk = relatedChunkIds.has(chunk.id);
      if (nearPage || directChunk) scopedCandidates.set(chunk.id, chunk);
    }

    const scopedResults = [...scopedCandidates.values()]
      .map((chunk) => ({
        ...chunk,
        score: scoreBitfieldChunk(chunk, rawBitfield, rawRegister, registerContext),
        bitfieldEvidence: extractBitfieldEvidenceLines(chunk.text || "", rawBitfield, 5),
      }))
      .filter((chunk) => chunk.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.page !== b.page) return a.page - b.page;
        return a.chunkIndex - b.chunkIndex;
      })
      .slice(0, topK);

    if (scopedResults.length && Number(scopedResults[0].score || 0) >= 45) {
      return {
        bitfield: rawBitfield,
        register: rawRegister,
        registerResults,
        results: scopedResults,
        mode: "register-scoped-fast",
      };
    }
  }

  const queries = buildBitFieldQueries(rawBitfield, rawRegister);
  const searchTopK = Math.min(MAX_TOP_K, Math.max(topK * 3, DEFAULT_TOP_K));
  const candidates = new Map();

  for (const query of queries) {
    const { results } = await searchPdfIndex(filename, query, searchTopK);

    for (const result of results) {
      const previous = candidates.get(result.id);
      const merged = previous
        ? {
            ...previous,
            score: Math.max(previous.score, result.score),
          }
        : result;
      candidates.set(result.id, merged);
    }
  }

  // If a register is provided, force related register chunks into the candidate set even if the
  // generic text search ranked them low. This is useful for tables where PDF extraction splits
  // bit names from descriptions across adjacent lines.
  if (rawRegister && registerResults.length) {
    const indexData = await loadPdfIndex(filename);
    const relatedChunkIds = new Set();
    const relatedPages = new Set();

    for (const entry of registerResults) {
      for (const chunk of entry.chunks || []) {
        if (chunk.id) relatedChunkIds.add(chunk.id);
        if (Number.isFinite(Number(chunk.page))) relatedPages.add(Number(chunk.page));
      }
      for (const page of entry.pages || []) {
        if (Number.isFinite(Number(page))) relatedPages.add(Number(page));
      }
    }

    for (const chunk of indexData.chunks || []) {
      const nearPage = relatedPages.has(Number(chunk.page));
      const directChunk = relatedChunkIds.has(chunk.id);
      if (nearPage || directChunk) {
        candidates.set(chunk.id, candidates.get(chunk.id) || chunk);
      }
    }
  }

  const results = [...candidates.values()]
    .map((chunk) => ({
      ...chunk,
      score: scoreBitfieldChunk(chunk, rawBitfield, rawRegister, registerContext),
      bitfieldEvidence: extractBitfieldEvidenceLines(chunk.text || "", rawBitfield, 5),
    }))
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.page !== b.page) return a.page - b.page;
      return a.chunkIndex - b.chunkIndex;
    })
    .slice(0, topK);

  return {
    bitfield: rawBitfield,
    register: rawRegister,
    registerResults,
    results,
  };
}

export function formatBitfieldResults(searchResult) {
  const bitfield = searchResult.bitfield;
  const register = searchResult.register;
  const results = searchResult.results || [];
  const registerResults = searchResult.registerResults || [];

  if (!results.length) {
    return [
      register
        ? `No bit-field results found for "${bitfield}" in register context "${register}".`
        : `No bit-field results found for "${bitfield}".`,
      "",
      "Suggested next steps:",
      "- Verify the bit-field spelling from the manual.",
      "- Try passing a related register, for example find_bitfield(filename=\"...\", register=\"DMACm_CHCTRL_n\", bitfield=\"EN\").",
      "- Try search_pdf with the bit-field plus 'Bit Name' or 'Description'.",
    ].join("\n");
  }

  const header = [
    register
      ? `Bit-field results for "${bitfield}" within register context "${register}"`
      : `Bit-field results for "${bitfield}"`,
  ];
  if (searchResult.mode) header.push(`Search mode: ${searchResult.mode}`);

  if (register) {
    header.push(
      registerResults.length
        ? `Register context matches: ${registerResults.slice(0, 5).map((entry) => entry.displayName || entry.name).join(", ")}`
        : `Register context matches: none; used generic bit-field search fallback.`
    );
  }

  return [
    ...header,
    "",
    ...results.map((result, index) => {
      const preview = normalizeText(result.text || "").slice(0, MAX_PREVIEW_CHARS);
      const truncated = (result.text || "").length > MAX_PREVIEW_CHARS ? "..." : "";
      const evidence = (result.bitfieldEvidence || []).length
        ? result.bitfieldEvidence.map((line) => `   - ${line}`).join("\n")
        : "   - none";

      return [
        `Result ${index + 1}`,
        `ID: ${result.id}`,
        `File: ${result.filename}`,
        `Page: ${result.page}`,
        `Chunk: ${result.chunkIndex}`,
        `Score: ${result.score}`,
        `Headings: ${
          result.headings && result.headings.length
            ? result.headings.join(" | ")
            : "none"
        }`,
        `Registers: ${
          result.registers && result.registers.length
            ? result.registers.join(", ")
            : "none"
        }`,
        `Bit fields / symbols: ${
          result.bitFields && result.bitFields.length
            ? result.bitFields.slice(0, 40).join(", ")
            : "none"
        }`,
        "Evidence lines:",
        evidence,
        `Suggested chunk read: read_pdf_chunk(filename="${result.filename}", chunk_id="${result.id}")`,
        `Suggested page read: read_pdf_pages(filename="${result.filename}", start_page=${result.page}, end_page=${Math.min(result.page + DEFAULT_PAGE_RANGE - 1, result.pageCount || result.page + DEFAULT_PAGE_RANGE - 1)})`,
        "Preview:",
        `${preview}${truncated}`,
      ].join("\n");
    }),
  ].join("\n\n---\n\n");
}


export function clampRegisterSummaryTopK(value) {
  const n = Number(value || DEFAULT_REGISTER_SUMMARY_CHUNKS);
  if (!Number.isFinite(n)) return DEFAULT_REGISTER_SUMMARY_CHUNKS;
  return Math.max(1, Math.min(MAX_REGISTER_SUMMARY_CHUNKS, Math.floor(n)));
}

export function isLikelySummaryBitfield(symbol, registerEntry = null) {
  const raw = String(symbol || "").trim();
  const canonical = canonicalSymbol(raw);
  if (!canonical || canonical.length < 1 || canonical.length > 32) return false;

  const registerNames = new Set();
  if (registerEntry) {
    for (const name of [registerEntry.name, registerEntry.displayName, ...(registerEntry.aliases || [])]) {
      const normalized = normalizeRegisterName(name);
      if (normalized) registerNames.add(normalized);
    }
  }

  if (registerNames.has(normalizeRegisterName(raw))) return false;
  if (looksLikeRegisterSymbol(raw)) return false;
  if (/^[0-9]+$/.test(canonical)) return false;
  if (/^[0-9A-F]+H$/.test(canonical)) return false;

  const noisyWords = new Set([
    "REGISTER", "REGISTERS", "DESCRIPTION", "INITIAL", "VALUE", "VALUES",
    "OFFSET", "ADDRESS", "ACCESS", "SIZE", "PAGE", "PAGES", "TABLE",
    "FIGURE", "RESERVED", "RESERVE", "SETTING", "SETTINGS", "BIT", "BITS",
    "NAME", "NOTES", "NOTE", "CAUTION", "SECTION", "CHAPTER", "READ", "WRITE",
    "WHEN", "THIS", "THAT", "THE", "AND", "OR", "FOR", "FROM", "WITH",
  ]);

  return !noisyWords.has(canonical);
}

export function scoreRegisterSummaryChunk(chunk, registerEntry, registerQuery) {
  const rawText = buildSearchText(chunk);
  const normalizedText = chunk.searchText || normalizeForSearch(rawText);
  const canonicalText = canonicalSymbol(rawText);
  const chunkRegisters = new Set((chunk.registers || []).map(normalizeRegisterName));
  const chunkSymbols = new Set((chunk.symbols || []).map(canonicalSymbol));
  const registerNames = new Set();

  for (const name of [registerEntry.name, registerEntry.displayName, ...(registerEntry.aliases || []), registerQuery]) {
    const normalized = normalizeRegisterName(name);
    if (normalized) registerNames.add(normalized);
  }

  const directChunkIds = new Set((registerEntry.chunks || []).map((item) => item.id).filter(Boolean));
  const pages = new Set((registerEntry.pages || []).map(Number).filter(Number.isFinite));
  let score = 0;

  if (directChunkIds.has(chunk.id)) score += 140;
  if (pages.has(Number(chunk.page))) score += 45;

  for (const name of registerNames) {
    if (chunkRegisters.has(name) || chunkSymbols.has(name)) score += 90;
    if (canonicalText.includes(name)) score += 55;
  }

  const normalizedRegister = normalizeForSearch(registerQuery || registerEntry.displayName || registerEntry.name);
  if (normalizedRegister && normalizedText.includes(normalizedRegister)) score += 35;

  if (/\bRegister\s+Name\b/i.test(rawText)) score += 18;
  if (/\b(Bit\s+Name|Bit|Bits?)\b/i.test(rawText)) score += 42;
  if (/\b(Description|Setting|Operation|Function)\b/i.test(rawText)) score += 16;
  if (/\b(Initial\s+Value|Reset\s+Value|Default\s+Value)\b/i.test(rawText)) score += 18;
  if (/\b(Offset\s+Address|Address|Access\s+Size|R\/W|Read|Write)\b/i.test(rawText)) score += 18;
  if (/\b(Caution|Note|Prohibit|Must|Do\s+not|Reserved|Undefined)\b/i.test(rawText)) score += 12;

  return Math.max(0, Math.round(score));
}

export async function collectRegisterSummaryChunks(filename, registerEntry, registerQuery, topK) {
  const indexData = await loadPdfIndex(filename);
  const scored = [];

  for (const chunk of indexData.chunks || []) {
    const score = scoreRegisterSummaryChunk(chunk, registerEntry, registerQuery);
    if (score <= 0) continue;
    scored.push({
      ...chunk,
      summaryScore: score,
      registerEvidence: extractRegisterEvidenceLines(chunk.text || "", registerEntry, registerQuery, 4),
    });
  }

  scored.sort((a, b) => {
    if (b.summaryScore !== a.summaryScore) return b.summaryScore - a.summaryScore;
    if (a.page !== b.page) return a.page - b.page;
    return a.chunkIndex - b.chunkIndex;
  });

  return scored.slice(0, topK);
}

export function extractRegisterEvidenceLines(text, registerEntry, registerQuery, maxLines = 8) {
  const names = [registerQuery, registerEntry.name, registerEntry.displayName, ...(registerEntry.aliases || [])]
    .map(String)
    .map((item) => item.trim())
    .filter(Boolean);
  const canonicalNames = [...new Set(names.map(normalizeRegisterName).filter(Boolean))];

  const lines = String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const evidence = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const canonicalLine = canonicalSymbol(line);
    const matched = canonicalNames.some((name) => canonicalLine.includes(name));
    if (!matched) continue;

    const previous = index > 0 ? lines[index - 1] : "";
    const next = index + 1 < lines.length ? lines[index + 1] : "";
    evidence.push([previous, line, next].filter(Boolean).join(" / ").slice(0, 650));
    if (evidence.length >= maxLines) break;
  }

  return evidence;
}

export function collectSummaryBitfields(chunks, registerEntry, maxBitfields = MAX_REGISTER_SUMMARY_BITFIELDS) {
  const byName = new Map();

  for (const chunk of chunks || []) {
    const symbols = new Set([...(chunk.bitFields || []), ...(chunk.symbols || [])]);

    for (const symbol of symbols) {
      if (!isLikelySummaryBitfield(symbol, registerEntry)) continue;
      const canonical = canonicalSymbol(symbol);
      if (!canonical) continue;

      const entry = byName.get(canonical) || {
        name: symbol,
        canonical,
        pages: new Set(),
        chunks: new Set(),
        evidence: [],
        score: 0,
      };

      entry.pages.add(chunk.page);
      entry.chunks.add(chunk.id);
      entry.score += Number(chunk.summaryScore || 0) > 0 ? 2 : 1;

      const evidence = extractBitfieldEvidenceLines(chunk.text || "", symbol, 2);
      for (const line of evidence) {
        if (entry.evidence.length < 4 && !entry.evidence.includes(line)) {
          entry.evidence.push(line);
          entry.score += 5;
        }
      }

      if ((chunk.bitFields || []).some((field) => canonicalSymbol(field) === canonical)) entry.score += 3;
      byName.set(canonical, entry);
    }
  }

  return [...byName.values()]
    .map((entry) => ({
      name: entry.name,
      canonical: entry.canonical,
      pages: [...entry.pages].sort((a, b) => a - b),
      chunks: [...entry.chunks].slice(0, 8),
      evidence: entry.evidence.slice(0, 4),
      score: entry.score,
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.name.localeCompare(b.name);
    })
    .slice(0, maxBitfields);
}

export function reliabilityForRegisterSummary(registerEntry, chunks, bitfields) {
  const sources = new Set(registerEntry.sourceKinds || []);
  const hasExplicitRegister = sources.has("register-list-table") || sources.has("register-description-heading");
  const hasBitfieldEvidence = (bitfields || []).some((field) => (field.evidence || []).length > 0);
  const hasRegisterChunks = (chunks || []).length > 0;

  if (hasExplicitRegister && hasBitfieldEvidence && hasRegisterChunks) {
    return "High for locating the register and candidate bit-field context; verify exact bit positions against the original PDF table.";
  }
  if (hasExplicitRegister && hasRegisterChunks) {
    return "Medium-high for locating the register; bit-field extraction may be incomplete.";
  }
  if (hasRegisterChunks) {
    return "Medium. Register was found through heuristic context; verify with read_pdf_pages.";
  }
  return "Low. Register metadata was found, but related chunks were not confidently identified.";
}

export function summarizeRegisterEntryFast(filename, registerIndex, registerEntry, indexData, topK = 4) {
  const chunksById = new Map((indexData.chunks || []).map((chunk) => [chunk.id, chunk]));
  const pages = new Set((registerEntry.pages || []).map(Number).filter(Number.isFinite));
  const candidateMap = new Map();

  for (const ref of registerEntry.chunks || []) {
    const chunk = chunksById.get(ref.id);
    if (chunk) candidateMap.set(chunk.id, chunk);
  }

  // Add nearby/page-local chunks only. This avoids scanning the full manual once per register.
  for (const chunk of indexData.chunks || []) {
    if (!pages.has(Number(chunk.page))) continue;
    if (candidateMap.size >= Math.max(topK * 6, 18)) break;
    candidateMap.set(chunk.id, chunk);
  }

  const relatedChunks = [...candidateMap.values()]
    .map((chunk) => {
      const score = scoreRegisterSummaryChunk(chunk, registerEntry, registerEntry.displayName || registerEntry.name);
      return {
        ...chunk,
        summaryScore: score,
        registerEvidence: extractRegisterEvidenceLines(chunk.text || "", registerEntry, registerEntry.displayName || registerEntry.name, 4),
      };
    })
    .filter((chunk) => Number(chunk.summaryScore || 0) > 0)
    .sort((a, b) => {
      if (b.summaryScore !== a.summaryScore) return b.summaryScore - a.summaryScore;
      if (a.page !== b.page) return a.page - b.page;
      return a.chunkIndex - b.chunkIndex;
    })
    .slice(0, topK);

  const bitfields = collectSummaryBitfields(relatedChunks, registerEntry, MAX_REGISTER_SUMMARY_BITFIELDS);

  return {
    filename,
    register: registerEntry.displayName || registerEntry.name,
    registerIndex,
    registerEntry,
    registerResults: [registerEntry],
    relatedChunks,
    bitfields,
    reliability: `${reliabilityForRegisterSummary(registerEntry, relatedChunks, bitfields)} Fast summary: used direct/page-local register chunks only to avoid MCP timeout.`,
  };
}

export async function summarizeRegister(filename, register, options = {}) {
  const rawRegister = String(register || "").trim();
  if (!rawRegister) throw new Error("register is required");

  const topK = clampRegisterSummaryTopK(options.topK);
  const includeBitfieldEvidence = options.includeBitfieldEvidence !== false;

  const { registerIndex, results: registerResults } = await searchRegistersIndex(filename, rawRegister, Math.max(5, Math.min(MAX_TOP_K, topK)));

  if (!registerResults.length) {
    const fallback = await multiQuerySearch(filename, buildRegisterQueries(rawRegister), Math.min(topK, MAX_TOP_K));
    return {
      filename,
      register: rawRegister,
      registerIndex,
      registerEntry: null,
      registerResults: [],
      relatedChunks: fallback,
      bitfields: [],
      reliability: "Low. No direct register-index match; fallback chunk search only.",
    };
  }

  const registerEntry = registerResults[0];
  const relatedChunks = await collectRegisterSummaryChunks(filename, registerEntry, rawRegister, topK);
  const bitfields = collectSummaryBitfields(relatedChunks, registerEntry, MAX_REGISTER_SUMMARY_BITFIELDS);

  return {
    filename,
    register: rawRegister,
    registerIndex,
    registerEntry,
    registerResults,
    relatedChunks,
    bitfields: includeBitfieldEvidence ? bitfields : bitfields.map((field) => ({ ...field, evidence: [] })),
    reliability: reliabilityForRegisterSummary(registerEntry, relatedChunks, bitfields),
  };
}

export function formatRegisterSummary(summary) {
  const filename = summary.filename;
  const queryRegister = summary.register;
  const entry = summary.registerEntry;
  const chunks = summary.relatedChunks || [];
  const bitfields = summary.bitfields || [];

  if (!entry) {
    return [
      `Register summary for "${queryRegister}"`,
      `File: ${filename}`,
      "",
      "Register index match: none",
      `Reliability: ${summary.reliability}`,
      "",
      "Fallback related chunks:",
      chunks.length ? formatSearchResults(chunks, queryRegister) : "none",
      "",
      "Suggested next steps:",
      `- Try list_registers(filename="${filename}", filter="${queryRegister}").`,
      `- Try find_register(filename="${filename}", register="${queryRegister}").`,
      `- Try search_pdf(filename="${filename}", query="${queryRegister} Register Bit Name").`,
    ].join("\n");
  }

  const pages = (entry.pages || []).join(", ") || "unknown";
  const sections = (entry.sections || [])
    .slice(0, 5)
    .map((section) => `${section.title} (page ${section.page})`)
    .join(" | ") || "none";
  const headings = (entry.headings || []).slice(0, 6).join(" | ") || "none";
  const descriptions = (entry.descriptions || []).join(" | ") || "unknown";
  const offsets = (entry.offsetAddresses || []).join(" | ") || "unknown";
  const initialValues = (entry.initialValues || []).join(" | ") || "unknown";
  const accessSizes = (entry.accessSizes || []).join(" | ") || "unknown";
  const sourceKinds = (entry.sourceKinds || []).join(", ") || "unknown";
  const aliases = (entry.aliases || []).slice(0, 16).join(", ") || "none";

  const firstPage = (entry.pages || [])[0];
  const suggestedPageRead = firstPage
    ? `read_pdf_pages(filename="${filename}", start_page=${firstPage}, end_page=${Math.min(firstPage + DEFAULT_PAGE_RANGE - 1, summary.registerIndex.pageCount || firstPage)})`
    : "none";

  const bitfieldLines = bitfields.length
    ? bitfields.slice(0, MAX_REGISTER_SUMMARY_BITFIELDS).map((field, index) => {
        const evidence = (field.evidence || []).length
          ? field.evidence.slice(0, 2).map((line) => `      evidence: ${line}`).join("\n")
          : "      evidence: none";
        const findCall = `find_bitfield(filename="${filename}", register="${entry.displayName || entry.name}", bitfield="${field.name}")`;
        return [
          `${index + 1}. ${field.name}`,
          `   Pages: ${field.pages.join(", ") || "unknown"}`,
          `   Chunks: ${field.chunks.slice(0, 4).join(", ") || "none"}`,
          `   Suggested find: ${findCall}`,
          evidence,
        ].join("\n");
      }).join("\n")
    : "none detected from related chunks";

  const chunkLines = chunks.length
    ? chunks.map((chunk, index) => {
        const preview = normalizeText(chunk.text || "").slice(0, 700);
        const evidence = (chunk.registerEvidence || []).length
          ? chunk.registerEvidence.map((line) => `   - ${line}`).join("\n")
          : "   - none";
        return [
          `Chunk ${index + 1}`,
          `ID: ${chunk.id}`,
          `Page: ${chunk.page}`,
          `Score: ${chunk.summaryScore}`,
          `Headings: ${(chunk.headings || []).join(" | ") || "none"}`,
          `Registers: ${(chunk.registers || []).join(", ") || "none"}`,
          `Bit fields / symbols: ${(chunk.bitFields || []).slice(0, 40).join(", ") || "none"}`,
          "Register evidence lines:",
          evidence,
          `Suggested chunk read: read_pdf_chunk(filename="${filename}", chunk_id="${chunk.id}")`,
          `Preview:\n${preview}${(chunk.text || "").length > 700 ? "..." : ""}`,
        ].join("\n");
      }).join("\n\n---\n\n")
    : "none";

  return [
    `Register summary for "${queryRegister}"`,
    `File: ${filename}`,
    "",
    "Register identity",
    `- Matched register: ${entry.displayName || entry.name}`,
    `- Canonical name: ${entry.name}`,
    `- Aliases: ${aliases}`,
    `- Confidence: ${entry.confidence}`,
    `- Source: ${sourceKinds}`,
    `- Pages: ${pages}`,
    `- Nearest sections: ${sections}`,
    `- Headings: ${headings}`,
    "",
    "Register metadata detected",
    `- Description: ${descriptions}`,
    `- Offset address: ${offsets}`,
    `- Initial value: ${initialValues}`,
    `- Access size: ${accessSizes}`,
    "",
    "Reliability",
    `- ${summary.reliability}`,
    "",
    "Suggested next calls",
    `- ${suggestedPageRead}`,
    `- find_register(filename="${filename}", register="${entry.displayName || entry.name}")`,
    "",
    "Detected bit-field candidates from related chunks",
    bitfieldLines,
    "",
    "Related chunks / evidence",
    chunkLines,
  ].join("\n");
}
