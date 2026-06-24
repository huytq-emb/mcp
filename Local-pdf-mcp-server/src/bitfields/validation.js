import { canonicalSymbol } from "../core/runtime-helpers.js";

export function parseBitRange(value) {
  const raw = String(value || "").trim().replace(/\bto\b/i, ":").replace(/[\[\]\s]/g, "").replace("-", ":");
  if (!raw || raw.toLowerCase() === "unknown") return null;
  const match = raw.match(/^(\d{1,3})(?::(\d{1,3}))?$/);
  if (!match) return null;
  const first = Number(match[1]);
  const second = match[2] === undefined ? first : Number(match[2]);
  return { high: Math.max(first, second), low: Math.min(first, second), width: Math.abs(first - second) + 1 };
}

export function parseRegisterWidth(registerEntry) {
  const values = [registerEntry?.accessSize, ...(registerEntry?.accessSizes || [])];
  for (const value of values) {
    const match = String(value || "").match(/\b(8|16|32|64|128)\b/);
    if (match) return Number(match[1]);
  }
  return null;
}

export function resetFitsWidth(value, width) {
  if (!Number.isFinite(width) || width <= 0) return true;
  const raw = String(value || "").trim().replace(/_/g, "");
  if (!raw || /^(unknown|undefined|reserved|-|—)$/i.test(raw)) return true;
  let parsed = null;
  if (/^0x[0-9a-f]+$/i.test(raw)) parsed = BigInt(raw);
  else if (/^[0-9a-f]+h$/i.test(raw)) parsed = BigInt(`0x${raw.slice(0, -1)}`);
  else if (/^[01]+b$/i.test(raw)) parsed = BigInt(`0b${raw.slice(0, -1)}`);
  else if (/^\d+$/.test(raw)) parsed = BigInt(raw);
  if (parsed === null) return true;
  return parsed < (1n << BigInt(width));
}

export function findRegisterEntry(registerIndex, registerName) {
  const target = canonicalSymbol(registerName);
  if (!target) return null;
  return (registerIndex?.registers || []).find((entry) =>
    [entry.name, entry.displayName, entry.canonicalName, ...(entry.aliases || [])]
      .map(canonicalSymbol)
      .includes(target)
  ) || null;
}

export function distinctKnownValues(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter((value) => value && value.toLowerCase() !== "unknown"))];
}

export function buildBitfieldConflicts(valueCandidates = {}) {
  const conflicts = [];
  for (const field of ["bitPositionRange", "fieldBitRange", "access", "reset", "register"]) {
    const candidates = valueCandidates[field] || [];
    const values = distinctKnownValues(candidates.map((candidate) => candidate.value));
    if (values.length > 1) conflicts.push({ field, values, candidates });
  }
  return conflicts;
}

export function validateBitfieldEntry(entry, registerIndex) {
  const issues = [];
  const registerEntry = findRegisterEntry(registerIndex, entry.register);
  const registerWidth = parseRegisterWidth(registerEntry);
  const physical = parseBitRange(entry.bitPositionRange || entry.bitRange);
  const field = parseBitRange(entry.fieldBitRange);

  if (!physical) issues.push("physical bit position is unknown");
  if (!entry.access || entry.access === "unknown") issues.push("access is unknown");
  if (!entry.reset || entry.reset === "unknown") issues.push("reset is unknown");
  if (entry.mappingStatus === "unresolved") issues.push("register mapping is unresolved");
  if ((entry.conflicts || []).length) issues.push("conflicting source values require verification");
  if (physical && registerWidth && physical.high >= registerWidth) issues.push(`bit position ${physical.high} exceeds ${registerWidth}-bit register width`);
  if (physical && field && physical.width !== field.width) issues.push(`physical width ${physical.width} differs from field-local width ${field.width}`);
  if (physical && !resetFitsWidth(entry.reset, physical.width)) issues.push(`reset value ${entry.reset} does not fit ${physical.width}-bit field`);

  const criticalComplete = Boolean(physical && entry.access && entry.access !== "unknown" && entry.reset && entry.reset !== "unknown");
  const validationStatus = issues.length === 0 && criticalComplete ? "valid" : (entry.conflicts || []).length ? "conflict" : "needs_verification";
  return {
    registerWidth,
    fieldWidth: physical?.width || field?.width || null,
    validationStatus,
    validationIssues: issues,
  };
}

export function findBitfieldOverlaps(entries) {
  const byRegister = new Map();
  for (const entry of entries || []) {
    const parsed = parseBitRange(entry.bitPositionRange || entry.bitRange);
    if (!parsed || /reserved/i.test(entry.bitfield || "")) continue;
    const key = canonicalSymbol(entry.register);
    if (!byRegister.has(key)) byRegister.set(key, []);
    byRegister.get(key).push({ entry, parsed });
  }
  const overlaps = new Map();
  for (const group of byRegister.values()) {
    for (let leftIndex = 0; leftIndex < group.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < group.length; rightIndex += 1) {
        const left = group[leftIndex];
        const right = group[rightIndex];
        if (left.parsed.low > right.parsed.high || right.parsed.low > left.parsed.high) continue;
        if (canonicalSymbol(left.entry.bitfield) === canonicalSymbol(right.entry.bitfield)) continue;
        if (!overlaps.has(left.entry.id)) overlaps.set(left.entry.id, []);
        if (!overlaps.has(right.entry.id)) overlaps.set(right.entry.id, []);
        overlaps.get(left.entry.id).push(right.entry.bitfield);
        overlaps.get(right.entry.id).push(left.entry.bitfield);
      }
    }
  }
  return overlaps;
}
