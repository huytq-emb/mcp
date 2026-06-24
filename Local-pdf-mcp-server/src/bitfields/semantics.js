export const BITFIELD_NOISE_WORDS = new Set([
  "ADDRESS",
  "OFFSET",
  "REGISTER",
  "REGISTERS",
  "DESCRIPTION",
  "INITIALVALUE",
  "INITIAL",
  "VALUE",
  "ACCESS",
  "SIZE",
  "BIT",
  "BITS",
  "BITNAME",
  "NAME",
  "READ",
  "WRITE",
  "READONLY",
  "WRITEONLY",
  "RESERVED",
  "UNDEFINED",
  "CAUTION",
  "CAUTIONS",
  "NOTE",
  "NOTES",
  "TABLE",
  "FIGURE",
  "PAGE",
  "CHAPTER",
  "SECTION",
  "MODULE",
  "FUNCTION",
  "OPERATION",
  "PROCEDURE",
  "SETTING",
  "SETTINGS",
  "CONTROL",
  "STATUS",
  "TRANSFER",
  "REQUEST",
  "INTERRUPT",
  "ERROR",
  "CHANNEL",
  "CHANNELS",
  "DMA",
  "DMAC",
  "DMACM",
  "BASE",
  "OFFSETADDRESS",
  "ACCESSSIZE",
  "H",
  "B",
  "RW",
  "RO",
  "WO",
  "R",
  "W",
  "RZ",
  "G3E",
  "CPU",
  "RAM",
  "GLOBAL",
]);

export function canonicalHardwareSymbol(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "");
}

export function normalizeHardwareRange(value) {
  const raw = String(value || "")
    .trim()
    .replace(/[：]/g, ":")
    .replace(/[−–—]/g, "-")
    .replace(/\bto\b/gi, ":")
    .replace(/bits?/gi, "")
    .replace(/[()[\]\s]/g, "");
  if (!raw) return "unknown";
  const match = raw.match(/^([0-9]{1,2})(?::|-)?([0-9]{0,2})$/);
  if (!match) return "unknown";
  if (!match[2]) return String(Number(match[1]));
  return `${Number(match[1])}:${Number(match[2])}`;
}

export function normalizeBitfieldAccess(value) {
  const raw = String(value || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!raw) return "unknown";
  const map = {
    RW: "R/W",
    "R/W": "R/W",
    R: "R",
    W: "W",
    RO: "R/O",
    "R/O": "R/O",
    WO: "W/O",
    "W/O": "W/O",
    W1C: "W1C",
    W0C: "W0C",
    "R/W1C": "R/W1C",
    READONLY: "R/O",
    WRITEONLY: "W/O",
    "READ/WRITE": "R/W",
  };
  return map[raw] || "unknown";
}

export function normalizeBitfieldReset(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "-" || /^undefined$/i.test(raw) || /^reserved$/i.test(raw)) return "unknown";
  const compact = raw.replace(/_/g, "");
  if (/^0+h?$/i.test(compact)) return "0";
  if (/^0+b$/i.test(compact)) return "0";
  if (/^1+b$/i.test(compact)) return "1";
  if (/^[01]$/i.test(compact)) return compact;
  return raw;
}

export function isPseudoRegisterName(value) {
  const canonical = canonicalHardwareSymbol(value);
  return !canonical || canonical === "GLOBAL" || canonical.endsWith("BASE");
}

export function isLikelyBitfieldName(symbol, registerEntry = null) {
  const raw = String(symbol || "").trim();
  const canonical = canonicalHardwareSymbol(raw);
  if (!canonical || canonical.length < 2 || canonical.length > 48) return false;
  if (BITFIELD_NOISE_WORDS.has(canonical)) return false;
  if (/^R01UH\d+/i.test(raw)) return false;
  if (/^B?\d+$/.test(canonical)) return false;
  if (/^[0-9A-F]+H$/.test(canonical)) return false;
  if (/^[01]+B$/.test(canonical)) return false;

  if (registerEntry) {
    const registerNames = [
      registerEntry.name,
      registerEntry.displayName,
      registerEntry.canonicalName,
      ...(registerEntry.aliases || []),
    ].map(canonicalHardwareSymbol).filter(Boolean);
    if (registerNames.includes(canonical)) return false;
  }

  return true;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstMatch(patterns, text) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match;
  }
  return null;
}

export function parseBitfieldSemantics(line, bitfield = "") {
  const text = String(line || "").replace(/[：]/g, ":").replace(/[−–—]/g, "-");
  const rawBitfield = String(bitfield || "").trim();
  const escaped = rawBitfield ? escapeRegExp(rawBitfield) : "[A-Z][A-Z0-9_]{1,31}";
  const namePattern = rawBitfield ? `\\b${escaped}\\b` : `\\b([A-Z][A-Z0-9_]{1,31})\\b`;

  const fieldPatterns = [
    new RegExp(`${namePattern}\\s*\\[\\s*([0-9]{1,2})\\s*:\\s*([0-9]{1,2})\\s*\\]`, "i"),
  ];
  if (!rawBitfield) fieldPatterns.push(/\[\s*([0-9]{1,2})\s*:\s*([0-9]{1,2})\s*\]/);
  const fieldMatch = firstMatch(fieldPatterns, text);
  const fieldBitRange = fieldMatch ? normalizeHardwareRange(`${fieldMatch[fieldMatch.length - 2]}:${fieldMatch[fieldMatch.length - 1]}`) : "unknown";

  const positionMatch = firstMatch([
    new RegExp(`(?:^|[^0-9])([0-9]{1,2})\\s*(?:to|:)\\s*([0-9]{1,2})\\s+.{0,120}${namePattern}`, "i"),
    new RegExp(`(?:^|[^0-9])([0-9]{1,2})\\s*-\\s*([0-9]{1,2})\\s+.{0,120}${namePattern}`, "i"),
    new RegExp(`${namePattern}.{0,80}\\b(?:bits?|b)\\s*([0-9]{1,2})\\s*(?:to|:|-)\\s*([0-9]{1,2})\\b`, "i"),
  ], text);

  let bitPositionRange = "unknown";
  if (positionMatch) {
    bitPositionRange = normalizeHardwareRange(`${positionMatch[positionMatch.length - 2]}:${positionMatch[positionMatch.length - 1]}`);
  } else {
    const singleMatch = firstMatch([
      new RegExp(`(?:^|[^0-9])([0-9]{1,2})\\s+${namePattern}(?:\\s|\\[|$)`, "i"),
      new RegExp(`${namePattern}.{0,80}\\b(?:bit|b)\\s*([0-9]{1,2})\\b`, "i"),
    ], text);
    if (singleMatch) bitPositionRange = normalizeHardwareRange(singleMatch[singleMatch.length - 1]);
  }

  const accessMatch = text.match(/\b(R\s*\/\s*W1C|R\s*\/\s*W|R\s*\/\s*O|W\s*\/\s*O|W1C|W0C|RW|RO|WO|R|W|Read only|Write only|Read\/Write)\b/i);
  const access = accessMatch ? normalizeBitfieldAccess(accessMatch[1]) : "unknown";
  let reset = "unknown";
  if (accessMatch) {
    const beforeAccess = text.slice(0, accessMatch.index).trim();
    const tokens = beforeAccess.split(/\s+/).reverse();
    const resetToken = tokens.find((token) => /^(?:0x[0-9A-Fa-f]+|[0-9A-Fa-f]+(?:_[0-9A-Fa-f]+)*h?|[01](?:_[01]+)*b|[01]|-|undefined|reserved)$/i.test(token));
    reset = normalizeBitfieldReset(resetToken || "");
  }

  return {
    bitPositionRange,
    fieldBitRange,
    bitRange: bitPositionRange !== "unknown" ? bitPositionRange : fieldBitRange,
    access,
    reset,
  };
}

function registerNames(entry = {}) {
  return [entry.name, entry.displayName, entry.canonicalName, ...(entry.aliases || [])]
    .map(String)
    .map((name) => name.trim())
    .filter(Boolean);
}

function concreteRegisterName(entry = {}) {
  return entry.displayName || entry.name || entry.canonicalName || "";
}

function pageSet(entry = {}) {
  return new Set((entry.pages || []).map(Number).filter(Number.isFinite));
}

function chunkIdSet(entry = {}) {
  return new Set((entry.chunks || []).map((chunk) => chunk.id).filter(Boolean));
}

function basePrefix(sourceRegister = "") {
  const canonical = canonicalHardwareSymbol(sourceRegister);
  if (!canonical.endsWith("BASE")) return "";
  return canonical.replace(/BASE$/, "");
}

export function resolveBitfieldRegisterMapping(candidate = {}, registerIndex = {}) {
  const sourceRegister = candidate.sourceRegister || candidate.register || "GLOBAL";
  if (!isPseudoRegisterName(sourceRegister)) {
    return {
      register: sourceRegister,
      sourceRegister,
      mappingStatus: "direct",
      mappingConfidence: 100,
      mappingReasons: ["candidate already names a concrete register"],
    };
  }

  const page = Number(candidate.page);
  const chunkId = candidate.chunk?.id || candidate.chunkId || "";
  const prefix = basePrefix(sourceRegister);
  const headingRaw = (candidate.chunk?.headings || []).filter(Boolean).join("\n");
  const evidenceRaw = [
    candidate.description,
    ...(candidate.evidenceLines || []),
    headingRaw,
    candidate.chunk?.preview,
    candidate.chunk?.text,
  ].filter(Boolean).join("\n");
  const evidenceText = canonicalHardwareSymbol(evidenceRaw);

  const pageLocalRegisters = Number.isFinite(page) && typeof registerIndex.registersByPage?.get === "function"
    ? registerIndex.registersByPage.get(page) || []
    : null;
  const entries = pageLocalRegisters || registerIndex.registers || [];
  const scored = [];
  for (const entry of entries) {
    const name = concreteRegisterName(entry);
    const canonicalName = canonicalHardwareSymbol(name);
    if (isPseudoRegisterName(name)) continue;

    let score = 0;
    const reasons = [];
    const pages = pageSet(entry);
    const chunkIds = chunkIdSet(entry);
    const names = registerNames(entry);
    const canonicalNames = names.map(canonicalHardwareSymbol).filter(Boolean);

    if (Number.isFinite(page) && pages.has(page)) {
      score += 35;
      reasons.push(`same page ${page}`);
    }
    if (chunkId && chunkIds.has(chunkId)) {
      score += 120;
      reasons.push("same register chunk");
    }
    if (prefix && canonicalName.startsWith(prefix)) {
      score += 25;
      reasons.push(`matches ${sourceRegister} prefix`);
    }
    if (entry.isExplicitRegister) {
      score += 20;
      reasons.push("explicit register artifact");
    }
    const rawNameMatches = (candidateName) => {
      const escaped = escapeRegExp(candidateName);
      return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`, "i").test(evidenceRaw);
    };
    const fullNames = [entry.name, entry.displayName, entry.canonicalName].filter(Boolean);
    const fullNameInHeading = fullNames.some((candidateName) => {
      const escaped = escapeRegExp(candidateName);
      return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`, "i").test(headingRaw);
    });
    const fullNameMatch = fullNames.some(rawNameMatches);
    const aliasMatch = !fullNameMatch && names.some(rawNameMatches);
    if (fullNameInHeading) {
      score += 220;
      reasons.push("full register symbol appears in nearest heading context");
    } else if (fullNameMatch) {
      score += 170;
      reasons.push("full register symbol appears exactly in evidence context");
    } else if (aliasMatch) {
      score += 100;
      reasons.push("register alias appears exactly in evidence context");
    } else if (canonicalNames.some((candidateName) => candidateName && evidenceText.includes(candidateName))) {
      score += 70;
      reasons.push("register name appears in evidence context");
    }

    if (score > 0) scored.push({ entry, score, reasons });
  }

  scored.sort((a, b) => b.score - a.score || concreteRegisterName(a.entry).localeCompare(concreteRegisterName(b.entry)));
  const best = scored[0];
  const second = scored[1];
  if (best && best.score >= 70 && (!second || best.score - second.score >= 15)) {
    return {
      register: concreteRegisterName(best.entry),
      sourceRegister,
      mappingStatus: "resolved",
      mappingConfidence: Math.min(100, best.score),
      mappingReasons: best.reasons,
    };
  }

  return {
    register: sourceRegister || "GLOBAL",
    sourceRegister,
    mappingStatus: "unresolved",
    mappingConfidence: best ? Math.min(100, best.score) : 0,
    mappingReasons: best
      ? [`ambiguous mapping; best=${concreteRegisterName(best.entry)} score=${best.score}`, ...(best.reasons || [])]
      : ["no page/chunk/register evidence could map this pseudo-register"],
  };
}
