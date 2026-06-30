import { evidenceTextBundle, normalizeConfidence, normalizeSearchText, sourceEvidence } from "./semanticUtils.js";

export const FIGURE_SEMANTIC_TYPES = Object.freeze([
  "timing_diagram",
  "sequence_diagram",
  "state_machine",
  "block_diagram",
  "register_diagram",
  "table",
  "unknown",
]);

function addScore(scores, type, points, reason, evidence) {
  scores[type] = scores[type] || { score: 0, reasons: [], evidence: [] };
  scores[type].score += points;
  if (reason) scores[type].reasons.push(reason);
  if (evidence) scores[type].evidence.push(evidence);
}

function scoreTextSource(scores, item, meta = {}) {
  const text = normalizeSearchText(item.text);
  if (!text) return;
  const evidence = sourceEvidence({
    source: item.source || "text",
    text: item.text,
    page: meta.page,
    figureId: meta.figureId,
    confidence: item.confidence,
  });

  if (/\b(?:timing|waveform|wave form|clock|counter|edge|rising edge|falling edge|both edges|saw wave|up counting|down counting|input capture|gtio|gtcnt|gtccr)\b/.test(text)) {
    addScore(scores, "timing_diagram", 4, "timing/waveform/counter/edge vocabulary", evidence);
  }
  if (/\b(?:sequence|flow|operation sequence|setting flow|procedure|step name|initialization flow|reset flow|dma flow|interrupt flow)\b/.test(text)) {
    addScore(scores, "sequence_diagram", 4, "sequence/flow/procedure vocabulary", evidence);
  }
  if (/\b(?:state machine|state diagram|state transition|mode transition|fsm|transition state)\b/.test(text)) {
    addScore(scores, "state_machine", 5, "state-machine vocabulary", evidence);
  } else if (/\bstate\b/.test(text) && /\b(?:transition|reset|enable|disable|start|stop|suspend|resume|timeout|error)\b/.test(text)) {
    addScore(scores, "state_machine", 3, "state plus transition trigger vocabulary", evidence);
  }
  if (/\b(?:block diagram|functional block|module configuration|system diagram|configuration diagram|overview diagram)\b/.test(text)) {
    addScore(scores, "block_diagram", 5, "block-diagram vocabulary", evidence);
  } else if (/\b(?:axi|ahb|apb|bus|dma|irq|interrupt|clock|reset|fifo|memory|cpu|module|peripheral|mux)\b/.test(text)) {
    addScore(scores, "block_diagram", 2, "hardware module/bus label vocabulary", evidence);
  }
  if (/\b(?:register diagram|register layout|bit field|bitfield|bit\s+name|offset address|access size|initial value|reset value)\b/.test(text)) {
    addScore(scores, "register_diagram", 4, "register/bitfield layout vocabulary", evidence);
  }
  if (/^table\b/.test(text) || /\b(?:table|columns|rows|no step name description)\b/.test(text)) {
    addScore(scores, "table", 2, "table vocabulary", evidence);
  }
}

export function classifyFigureType(input = {}) {
  const scores = {};
  const bundle = evidenceTextBundle(input);
  for (const item of bundle) scoreTextSource(scores, item, { page: input.page, figureId: input.figureId || input.figure_id || "" });

  const oldKind = normalizeSearchText(input.kind || input.figureKind || "");
  if (oldKind) {
    const evidence = sourceEvidence({ source: "figures_index", text: input.kind || input.figureKind, page: input.page, figureId: input.figureId || input.figure_id || "", confidence: 0.65 });
    if (/timing/.test(oldKind)) addScore(scores, "timing_diagram", 3, "existing figure index kind", evidence);
    if (/flow|sequence/.test(oldKind)) addScore(scores, "sequence_diagram", 3, "existing figure index kind", evidence);
    if (/block/.test(oldKind)) addScore(scores, "block_diagram", 3, "existing figure index kind", evidence);
    if (/register/.test(oldKind)) addScore(scores, "register_diagram", 3, "existing figure index kind", evidence);
    if (/table/.test(oldKind)) addScore(scores, "table", 3, "existing figure index kind", evidence);
  }

  const layoutBlocks = Array.isArray(input.layoutBlocks) ? input.layoutBlocks : [];
  const rectangularCount = layoutBlocks.filter((block) => Array.isArray(block.bbox) || /box|rect|image|figure/i.test(String(block.type || block.label || ""))).length;
  const arrowCount = layoutBlocks.filter((block) => /arrow|connector|line/i.test(String(block.type || block.label || ""))).length;
  if (rectangularCount >= 4) {
    addScore(scores, "block_diagram", 2, "multiple rectangular/layout regions", sourceEvidence({ source: "layout", text: `${rectangularCount} rectangular/layout regions`, page: input.page, figureId: input.figureId || input.figure_id || "", confidence: 0.45 }));
  }
  if (arrowCount >= 2) {
    addScore(scores, "sequence_diagram", 1, "arrow/connector layout hints", sourceEvidence({ source: "layout", text: `${arrowCount} arrow/connector regions`, page: input.page, figureId: input.figureId || input.figure_id || "", confidence: 0.42 }));
    addScore(scores, "block_diagram", 1, "arrow/connector layout hints", sourceEvidence({ source: "layout", text: `${arrowCount} arrow/connector regions`, page: input.page, figureId: input.figureId || input.figure_id || "", confidence: 0.42 }));
  }

  const ranked = Object.entries(scores)
    .map(([figure_type, data]) => ({ figure_type, ...data }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score < 2) {
    return {
      figure_type: "unknown",
      confidence: 0.2,
      reasons: [],
      evidence: [],
      candidates: ranked,
    };
  }

  const runnerUp = ranked[1]?.score || 0;
  const margin = Math.max(0, best.score - runnerUp);
  const confidence = normalizeConfidence(Math.min(0.92, 0.35 + best.score * 0.055 + margin * 0.04), 0.55);
  return {
    figure_type: best.figure_type,
    confidence,
    reasons: [...new Set(best.reasons)].slice(0, 8),
    evidence: best.evidence.slice(0, 8),
    candidates: ranked.slice(0, 6).map((item) => ({
      figure_type: item.figure_type,
      score: item.score,
      reasons: [...new Set(item.reasons)].slice(0, 4),
    })),
  };
}
