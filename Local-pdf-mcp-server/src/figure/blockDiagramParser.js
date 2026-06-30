import {
  blockKindFromName,
  compactText,
  edgeKindFromLabel,
  evidenceTextBundle,
  extractHardwareTokens,
  normalizeConfidence,
  normalizeSearchText,
  sourceEvidence,
  splitSemanticLines,
  uniqueBy,
} from "./semanticUtils.js";

function candidateBlockLabels(text = "") {
  const labels = [];
  for (const line of splitSemanticLines(text)) {
    const trimmed = compactText(line, 100);
    if (!trimmed || trimmed.length < 2 || trimmed.length > 100) continue;
    if (/(?:->|=>|-->|connected to|feeds|drives|input to|output to)/i.test(trimmed)) continue;
    if (blockKindFromName(trimmed) !== "unknown") labels.push(trimmed);
  }
  for (const item of extractHardwareTokens(text)) {
    if (["register", "signal", "counter"].includes(item.token_type) || blockKindFromName(item.token) !== "unknown") labels.push(item.token);
  }
  return uniqueBy(labels, (label) => normalizeSearchText(label)).slice(0, 64);
}

function endpoint(value = "") {
  const text = compactText(value, 80)
    .replace(/^[\s"'`([{]+|[\s"'`)\]}]+$/g, "")
    .replace(/[,:.]+$/g, "")
    .trim();
  if (!text || text.length < 2 || text.length > 80) return "";
  if (/^(and|or|then|before|after|when|while|with|without|input|output|connected|connects|feeds|drives)$/i.test(text)) return "";
  return text;
}

function parseEdgesFromLine(line = "", evidence, confidence = 0.5) {
  const edges = [];
  const add = (fromRaw, toRaw, label = "", conf = confidence) => {
    const from = endpoint(fromRaw);
    const to = endpoint(toRaw);
    if (!from || !to || normalizeSearchText(from) === normalizeSearchText(to)) return;
    edges.push({
      from,
      to,
      kind: edgeKindFromLabel(label || line),
      label: compactText(label, 80),
      confidence: normalizeConfidence(conf),
      source_evidence: [evidence],
    });
  };

  if (/(?:->|=>|-->)/.test(line)) {
    const parts = String(line).split(/\s*(?:->|=>|-->)\s*/).map(endpoint).filter(Boolean);
    for (let index = 0; index < parts.length - 1; index += 1) add(parts[index], parts[index + 1], "", confidence);
  }
  let match = String(line).match(/^(.+?)\s+(?:is\s+)?(?:connected\s+to|connects\s+to)\s+(.+)$/i);
  if (match) add(match[1], match[2], "connects_to", Math.min(0.55, confidence));
  match = String(line).match(/^(.+?)\s+(feeds|drives)\s+(.+)$/i);
  if (match) add(match[1], match[3], match[2].toLowerCase(), Math.min(0.55, confidence));
  match = String(line).match(/^(.+?)\s+(?:is\s+)?input\s+to\s+(.+)$/i);
  if (match) add(match[1], match[2], "input_to", Math.min(0.5, confidence));
  match = String(line).match(/^output\s+from\s+(.+?)\s+to\s+(.+)$/i);
  if (match) add(match[1], match[2], "output_to", Math.min(0.5, confidence));
  return edges;
}

export function parseBlockDiagram(input = {}) {
  const bundle = evidenceTextBundle(input);
  const meta = { page: input.page, figureId: input.figureId || input.figure_id || "", bbox: input.bbox || [] };
  const blocks = [];
  const ports = [];
  const edges = [];
  const uncertainties = [];
  const warnings = [];

  for (const item of bundle) {
    const evidence = sourceEvidence({ source: item.source, text: item.text, page: meta.page, figureId: meta.figureId, bbox: meta.bbox, confidence: item.confidence });
    for (const label of candidateBlockLabels(item.text)) {
      blocks.push({
        name: label,
        kind: blockKindFromName(label),
        bbox: [],
        confidence: normalizeConfidence(item.confidence, 0.52),
        source_evidence: [evidence],
      });
    }
    for (const line of splitSemanticLines(item.text)) {
      edges.push(...parseEdgesFromLine(line, evidence, item.confidence));
    }
  }

  for (const block of blocks) {
    if (/\b(?:clk|clock|rst|reset|irq|int|req|ack|rx|tx|sda|scl)\b/i.test(block.name)) {
      ports.push({
        name: block.name,
        block: "",
        kind: edgeKindFromLabel(block.name),
        bbox: block.bbox || [],
        confidence: Math.min(0.7, block.confidence),
        source_evidence: block.source_evidence || [],
      });
    }
  }

  const uniqueBlocks = uniqueBy(blocks, (block) => normalizeSearchText(block.name)).slice(0, 100);
  const uniqueEdges = uniqueBy(edges, (edge) => `${normalizeSearchText(edge.from)}|${normalizeSearchText(edge.to)}|${normalizeSearchText(edge.label)}`).slice(0, 160);

  if (uniqueBlocks.length && !uniqueEdges.length) {
    uncertainties.push("Block labels are derived from OCR/text; rectangular containment and connector topology were not verified.");
  }
  if (uniqueEdges.length) {
    uncertainties.push("Edges are candidates from explicit text/arrows only; visual connector geometry and arrowheads are not verified.");
  }
  if (!uniqueBlocks.length) warnings.push("No block labels were confidently extracted.");

  return {
    blocks: uniqueBlocks,
    ports: uniqueBy(ports, (port) => normalizeSearchText(port.name)).slice(0, 100),
    edges: uniqueEdges,
    uncertainties,
    warnings,
  };
}
