import {
  canonicalSymbol,
  classifyToken,
  compactText,
  extractHardwareTokens,
  extractValueTokens,
  normalizeConfidence,
  uniqueBy,
} from "./semanticUtils.js";

function cleanupOcrText(text = "") {
  return String(text || "")
    .normalize("NFKC")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[{}]/g, "")
    .replace(/\$/g, "")
    .replace(/\\_/g, "_")
    .replace(/\s*_\s*/g, "_")
    .replace(/\s*\.\s*/g, ".")
    .replace(/\s*\[\s*/g, "[")
    .replace(/\s*\]\s*/g, "]")
    .replace(/\s+/g, " ")
    .trim();
}

function collapseSplitRegisterName(text = "") {
  let value = cleanupOcrText(text);
  value = value.replace(/\b([A-Z]{2,}[A-Z0-9]*)_([A-Z0-9])\b/g, "$1$2");
  value = value.replace(/\b([A-Z]{2,}[A-Z0-9]*)\s+([A-Z])\b/g, (match, left, right) => {
    const joined = `${left}${right}`;
    return joined.length >= 4 ? joined : match;
  });
  return value.trim();
}

function technicalCandidateFromText(text = "") {
  const collapsed = collapseSplitRegisterName(text);
  const compact = canonicalSymbol(collapsed.replace(/\s+/g, ""));
  const phraseTokens = extractHardwareTokens(collapsed).map((item) => item.token);
  if (phraseTokens.length === 1 && compact.toUpperCase() === phraseTokens[0].toUpperCase()) {
    return phraseTokens[0];
  }
  if (/^[A-Za-z][A-Za-z0-9_.:[\]]+$/.test(compact) && compact.length >= 3) {
    return compact;
  }
  return "";
}

function confusionVariants(symbol = "") {
  const variants = new Set();
  const value = String(symbol || "").trim();
  if (!value) return [];
  variants.add(value);
  if (/[O0]/.test(value)) {
    variants.add(value.replace(/O/g, "0"));
    variants.add(value.replace(/0/g, "O"));
  }
  if (/[Il1]/.test(value)) {
    variants.add(value.replace(/[Il]/g, "1"));
    variants.add(value.replace(/1/g, "I"));
  }
  return [...variants].filter(Boolean).slice(0, 6);
}

function tokenTypeForNormalized(normalized = "", original = "") {
  const tokens = extractHardwareTokens(normalized);
  if (tokens.length === 1) return tokens[0].token_type === "counter" ? "register" : tokens[0].token_type;
  if (extractValueTokens(normalized).length && extractValueTokens(normalized).join(" ") === normalized.trim()) return "value";
  const context = `${normalized} ${original}`;
  if (tokens.some((item) => item.token_type === "bitfield")) return "bitfield";
  if (tokens.some((item) => item.token_type === "register" || item.token_type === "counter")) return "register";
  if (tokens.some((item) => item.token_type === "signal")) return "signal";
  const compact = technicalCandidateFromText(normalized);
  if (compact) {
    const type = classifyToken(compact, context);
    return type === "counter" ? "register" : type;
  }
  return normalized ? "normal_text" : "unknown";
}

export function normalizeOcrText(text = "") {
  const original = String(text || "");
  const cleaned = collapseSplitRegisterName(original);
  const compactCandidate = technicalCandidateFromText(cleaned);
  const normalized = compactCandidate && !/\s/.test(cleaned)
    ? compactCandidate
    : cleaned;
  const candidates = uniqueBy([
    ...(compactCandidate ? confusionVariants(compactCandidate) : []),
    ...extractHardwareTokens(cleaned).flatMap((item) => confusionVariants(item.token)),
  ], (item) => item.toUpperCase());
  return {
    text_original: original,
    text_normalized: compactText(normalized, 500),
    candidates: candidates.slice(0, 8),
    token_type: tokenTypeForNormalized(normalized, original),
  };
}

export function normalizeOcrBlock(block = {}) {
  const original = String(block.text_original || block.text || block.label || "");
  const normalized = normalizeOcrText(original);
  const confidence = normalizeConfidence(block.confidence ?? block.score ?? block.confidenceAvg, 0.5);
  const tokens = extractHardwareTokens(normalized.text_normalized).map((item) => ({
    text: item.token,
    token_type: item.token_type === "counter" ? "register" : item.token_type,
    confidence,
  }));
  return {
    text_original: normalized.text_original,
    text_normalized: normalized.text_normalized,
    bbox: Array.isArray(block.bbox) ? block.bbox : [],
    image_bbox: Array.isArray(block.image_bbox) ? block.image_bbox : [],
    confidence,
    token_type: normalized.token_type,
    candidates: normalized.candidates,
    tokens,
  };
}

export function normalizeOcrBlocks(blocks = []) {
  return (Array.isArray(blocks) ? blocks : [])
    .map((block) => normalizeOcrBlock(block))
    .filter((block) => block.text_original || block.text_normalized);
}
