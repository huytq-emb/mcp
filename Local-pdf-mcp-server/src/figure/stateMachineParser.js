import {
  compactText,
  evidenceTextBundle,
  normalizeConfidence,
  normalizeSearchText,
  sourceEvidence,
  splitSemanticLines,
  uniqueBy,
} from "./semanticUtils.js";

const STATE_WORD_RE = /\b(?:reset|idle|run|running|stop|stopped|wait|standby|sleep|suspend|resume|error|fault|enable|disable|disabled|active|inactive|ready|busy|halt|normal|transition|state|mode)\b/i;
const TRANSITION_TRIGGER_RE = /\b(?:reset|enable|disable|error|interrupt|irq|timeout|start|stop|suspend|resume|clear|set|request|complete|done|fail|fault)\b/i;

function stateNameFromLine(line = "") {
  const text = compactText(line, 120)
    .replace(/^(?:state|mode)\s*[:=-]\s*/i, "")
    .replace(/\s+(?:state|mode)$/i, "")
    .trim();
  if (!text || text.length < 2 || text.length > 80) return "";
  if (!STATE_WORD_RE.test(text)) return "";
  if (text.split(/\s+/).length > 6) return "";
  return text;
}

function parseArrowTransition(line = "") {
  const parts = String(line || "").split(/\s*(?:->|=>|-->)\s*/).map((part) => compactText(part, 120)).filter(Boolean);
  if (parts.length < 2) return [];
  const transitions = [];
  for (let index = 0; index < parts.length - 1; index += 1) {
    transitions.push({ from: parts[index], to: parts[index + 1], condition: "", action: "" });
  }
  return transitions;
}

function parseTextTransition(line = "") {
  let match = String(line || "").match(/\bfrom\s+(.{2,80}?)\s+to\s+(.{2,80}?)(?:\s+(?:when|if|after|on)\s+(.{2,160}))?$/i);
  if (match) return [{ from: compactText(match[1], 80), to: compactText(match[2], 80), condition: compactText(match[3] || "", 160), action: "" }];
  match = String(line || "").match(/\b(.{2,80}?)\s+transitions?\s+to\s+(.{2,80}?)(?:\s+(?:when|if|after|on)\s+(.{2,160}))?$/i);
  if (match) return [{ from: compactText(match[1], 80), to: compactText(match[2], 80), condition: compactText(match[3] || "", 160), action: "" }];
  return [];
}

export function parseStateMachine(input = {}) {
  const bundle = evidenceTextBundle(input);
  const meta = { page: input.page, figureId: input.figureId || input.figure_id || "", bbox: input.bbox || [] };
  const states = [];
  const transitions = [];
  const uncertainties = [];
  const warnings = [];

  for (const item of bundle) {
    const evidence = sourceEvidence({ source: item.source, text: item.text, page: meta.page, figureId: meta.figureId, bbox: meta.bbox, confidence: item.confidence });
    for (const line of splitSemanticLines(item.text)) {
      const stateName = stateNameFromLine(line);
      if (stateName) {
        states.push({
          name: stateName,
          bbox: [],
          confidence: normalizeConfidence(item.confidence, 0.55),
          source_evidence: [evidence],
        });
      }
      const candidates = [...parseArrowTransition(line), ...parseTextTransition(line)];
      for (const candidate of candidates) {
        transitions.push({
          from: candidate.from,
          to: candidate.to,
          condition: candidate.condition || (TRANSITION_TRIGGER_RE.test(line) ? compactText(line.match(TRANSITION_TRIGGER_RE)?.[0] || "", 80) : ""),
          action: candidate.action || "",
          confidence: normalizeConfidence(item.confidence, 0.5),
          source_evidence: [evidence],
        });
      }
      if (!candidates.length && STATE_WORD_RE.test(line) && TRANSITION_TRIGGER_RE.test(line) && /\b(?:when|if|after|on)\b/i.test(line)) {
        transitions.push({
          from: "",
          to: "",
          condition: compactText(line, 180),
          action: "",
          confidence: 0.35,
          source_evidence: [evidence],
        });
      }
    }
  }

  const uniqueStates = uniqueBy(states, (state) => normalizeSearchText(state.name)).slice(0, 80);
  const uniqueTransitions = uniqueBy(transitions, (transition) => `${normalizeSearchText(transition.from)}|${normalizeSearchText(transition.to)}|${normalizeSearchText(transition.condition)}`).slice(0, 120);

  if (uniqueTransitions.some((transition) => !transition.from || !transition.to)) {
    uncertainties.push("Some transition-like triggers were found in text, but arrow geometry/endpoints were unavailable.");
  }
  if (!uniqueTransitions.length && uniqueStates.length) {
    uncertainties.push("State labels were extracted from text, but transitions were not verified from arrows or explicit from/to text.");
  }
  if (!uniqueStates.length) warnings.push("No state labels were confidently extracted.");

  return {
    states: uniqueStates,
    transitions: uniqueTransitions,
    uncertainties,
    warnings,
  };
}
