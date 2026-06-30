import {
  compactText,
  evidenceTextBundle,
  extractRegisterNames,
  normalizeConfidence,
  normalizeSearchText,
  sourceEvidence,
  splitSemanticLines,
  uniqueBy,
} from "./semanticUtils.js";

function parseNumberedLine(line = "") {
  let match = String(line || "").match(/^\s*(?:step\s*)?(\d{1,3})[\).:-]\s+(.{3,500})$/i);
  if (match) return { step: Number(match[1]), text: match[2] };
  match = String(line || "").match(/^\s*(\d{1,3})\s+([A-Z][A-Za-z0-9 /_-]{2,80})\s+(.{8,500})$/);
  if (match) return { step: Number(match[1]), text: `${match[2]} ${match[3]}` };
  return null;
}

function actorFromText(text = "") {
  const registers = extractRegisterNames(text);
  if (registers.length) return registers[0];
  const match = String(text || "").match(/\b(?:CPU|DMAC?|DMA Controller|Interrupt Controller|Peripheral|Software|Hardware|Module|Counter|Timer)\b/i);
  return match ? match[0] : "";
}

function targetFromText(text = "") {
  const registers = extractRegisterNames(text);
  if (registers.length > 1) return registers[1];
  if (registers.length === 1) return registers[0];
  const match = String(text || "").match(/\b(?:counter|clock|interrupt|IRQ|DMA|buffer|FIFO|memory|pin|signal)\b/i);
  return match ? match[0] : "";
}

function conditionFromText(text = "") {
  const match = String(text || "").match(/\b(?:if|when|after|before|until|while|only when|in Figure [^,.]+)\b(.{0,160})/i);
  return match ? compactText(match[0], 180) : "";
}

function actionFromText(text = "") {
  const value = compactText(text, 260);
  const match = value.match(/\b(?:set|write|read|poll|wait|select|enable|disable|clear|start|stop|configure|load|reset)\b.{0,180}/i);
  return match ? compactText(match[0], 220) : value;
}

function addArrowEdges(edges, actors, line, evidence, baseConfidence = 0.5) {
  const parts = String(line || "").split(/\s*(?:->|=>|-->)\s*/).map((part) => compactText(part, 80)).filter(Boolean);
  if (parts.length < 2) return;
  for (const part of parts) actors.add(part);
  for (let index = 0; index < parts.length - 1; index += 1) {
    edges.push({
      from: parts[index],
      to: parts[index + 1],
      kind: "sequence",
      label: "",
      confidence: normalizeConfidence(baseConfidence),
      source_evidence: [evidence],
    });
  }
}

export function parseSequenceDiagram(input = {}) {
  const bundle = evidenceTextBundle(input);
  const meta = { page: input.page, figureId: input.figureId || input.figure_id || "", bbox: input.bbox || [] };
  const sequenceSteps = [];
  const edges = [];
  const actors = new Set();
  const uncertainties = [];
  const warnings = [];

  for (const item of bundle) {
    const evidence = sourceEvidence({ source: item.source, text: item.text, page: meta.page, figureId: meta.figureId, bbox: meta.bbox, confidence: item.confidence });
    for (const line of splitSemanticLines(item.text)) {
      const numbered = parseNumberedLine(line);
      if (numbered) {
        const sourceText = compactText(numbered.text, 320);
        const actor = actorFromText(sourceText);
        const target = targetFromText(sourceText);
        if (actor) actors.add(actor);
        if (target) actors.add(target);
        sequenceSteps.push({
          step: numbered.step || sequenceSteps.length + 1,
          actor,
          action: actionFromText(sourceText),
          target,
          condition: conditionFromText(sourceText),
          source_text: sourceText,
          confidence: Math.max(0.55, normalizeConfidence(item.confidence, 0.55)),
          source_evidence: [evidence],
        });
      }
      if (/(?:->|=>|-->)/.test(line)) addArrowEdges(edges, actors, line, evidence, item.confidence);
    }
  }

  const orderedSteps = uniqueBy(sequenceSteps, (step) => `${step.step}|${normalizeSearchText(step.source_text)}`)
    .sort((a, b) => a.step - b.step);
  if (!edges.length && orderedSteps.length > 1) {
    for (let index = 0; index < orderedSteps.length - 1; index += 1) {
      edges.push({
        from: orderedSteps[index].step,
        to: orderedSteps[index + 1].step,
        kind: "ordered_step",
        label: "before",
        confidence: 0.56,
        source_evidence: orderedSteps[index].source_evidence || [],
      });
    }
  }

  if (orderedSteps.length && !edges.some((edge) => edge.kind === "sequence")) {
    uncertainties.push("Sequence ordering is inferred from numbered text/table rows; arrow geometry is not verified.");
  }
  if (!orderedSteps.length) warnings.push("No numbered sequence steps were extracted from OCR/caption/context text.");

  return {
    actors: [...actors].slice(0, 32),
    sequence_steps: orderedSteps.slice(0, 80),
    edges: edges.slice(0, 120),
    uncertainties,
    warnings,
  };
}
