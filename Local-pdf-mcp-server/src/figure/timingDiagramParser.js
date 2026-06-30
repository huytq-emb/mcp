import {
  bundleText,
  compactText,
  evidenceTextBundle,
  extractCounterNames,
  extractRegisterNames,
  extractSignalNames,
  extractValueTokens,
  normalizeConfidence,
  normalizeSearchText,
  sourceEvidence,
  uniqueBy,
} from "./semanticUtils.js";

function firstEvidenceMatching(bundle, pattern, fallbackText = "", meta = {}) {
  const found = bundle.find((item) => pattern.test(item.text));
  if (found) {
    return sourceEvidence({
      source: found.source,
      text: found.text,
      page: meta.page,
      figureId: meta.figureId,
      bbox: meta.bbox,
      confidence: found.confidence,
    });
  }
  return sourceEvidence({
    source: "semantic_parser",
    text: fallbackText,
    page: meta.page,
    figureId: meta.figureId,
    bbox: meta.bbox,
    confidence: 0.45,
  });
}

function signalKind(name = "", text = "") {
  if (/clk|clock/i.test(name) || /\bclock\b/i.test(text)) return "clock";
  if (/CNT/i.test(name)) return "counter";
  if (/\binput\b/i.test(text)) return "input";
  if (/\boutput\b/i.test(text)) return "output";
  if (/^(?:GT|WDT|DMAC|USB|GBETH|PFC|GPIO|CAN|SPI|IIC|RIIC)[A-Z0-9_]+$/i.test(name)) return "register";
  return "unknown";
}

function inferEdges(text = "") {
  const normalized = normalizeSearchText(text);
  if (/\bboth edges?\b/.test(normalized) || /\brising and falling edges?\b/.test(normalized)) return ["rising", "falling"];
  const edges = [];
  if (/\brising edge\b/.test(normalized)) edges.push("rising");
  if (/\bfalling edge\b/.test(normalized)) edges.push("falling");
  if (/\bboth\b/.test(normalized) && /\bedge\b/.test(normalized)) edges.push("rising", "falling");
  return uniqueBy(edges, (edge) => edge);
}

function addInference(inferences, statement, evidence, confidence = 0.6) {
  if (!statement) return;
  inferences.push({
    statement: compactText(statement, 260),
    confidence: normalizeConfidence(confidence),
    source_evidence: evidence ? [evidence] : [],
  });
}

export function parseTimingDiagram(input = {}) {
  const text = bundleText(input);
  const normalized = normalizeSearchText(text);
  const bundle = evidenceTextBundle(input);
  const meta = { page: input.page, figureId: input.figureId || input.figure_id || "", bbox: input.bbox || [] };
  const registers = extractRegisterNames(text);
  const counters = extractCounterNames(text);
  const values = extractValueTokens(text);
  let signalNames = extractSignalNames(text);
  if (/\bGTIOCnB\b/i.test(text)) signalNames.push("GTIOCnB");
  signalNames = uniqueBy(signalNames, (name) => name.toUpperCase())
    .filter((name) => !registers.some((register) => register.toUpperCase() === name.toUpperCase()));

  const signals = signalNames.map((name) => {
    const evidence = firstEvidenceMatching(bundle, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), name, meta);
    return {
      name,
      kind: signalKind(name, evidence.text || text),
      bbox: [],
      confidence: evidence.confidence,
      source_evidence: [evidence],
    };
  });

  for (const counter of counters) {
    if (!signals.some((signal) => signal.name.toUpperCase() === counter.toUpperCase())) {
      const evidence = firstEvidenceMatching(bundle, new RegExp(counter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), counter, meta);
      signals.push({
        name: counter,
        kind: "counter",
        bbox: [],
        confidence: evidence.confidence,
        source_evidence: [evidence],
      });
    }
  }

  const edgeKinds = inferEdges(text);
  const triggerSignal = signalNames.find((name) => /^GTIOC/i.test(name)) || signalNames[0] || "";
  const events = [];
  const edgeEvidence = firstEvidenceMatching(bundle, /\b(?:both edges?|rising edge|falling edge|input capture|counter cleared)\b/i, text, meta);
  for (const edge of edgeKinds) {
    events.push({
      id: `evt_${events.length + 1}`,
      time_ref: edgeKinds.length > 1 ? `both_edges_${edge}` : `edge_${edge}`,
      trigger: triggerSignal ? `${triggerSignal} ${edge} edge` : `${edge} edge`,
      edge,
      signal: triggerSignal,
      confidence: Math.min(0.78, Math.max(0.52, edgeEvidence.confidence)),
      source_evidence: [edgeEvidence],
    });
  }

  const registerActions = [];
  const counterActions = [];
  const engineeringInferences = [];
  const uncertainties = [];
  const warnings = [];

  const inputCaptureEvidence = firstEvidenceMatching(bundle, /\binput capture\b/i, text, meta);
  if (/\binput capture\b/i.test(text)) {
    const targetRegisters = registers.filter((name) => /^GTCCR/i.test(name));
    const actionRegisters = targetRegisters.length ? targetRegisters : registers.slice(0, 4);
    for (const register of actionRegisters) {
      registerActions.push({
        time_ref: edgeKinds.length > 1 ? "both_edges" : edgeKinds[0] ? `edge_${edgeKinds[0]}` : "unknown",
        register,
        action: "input_capture",
        value: values.find((value) => !/^0+_?0*h$/i.test(value)) || "",
        confidence: 0.64,
        source_evidence: [inputCaptureEvidence],
      });
    }
    addInference(
      engineeringInferences,
      edgeKinds.length > 1 && triggerSignal
        ? `Input capture is associated with both rising and falling edges of ${triggerSignal}.`
        : "Input capture is associated with edge-triggered timing in the figure text.",
      inputCaptureEvidence,
      edgeKinds.length > 1 ? 0.68 : 0.58,
    );
  }

  const bufferEvidence = firstEvidenceMatching(bundle, /\b(?:buffer transfer|buffer operation|double buffer)\b/i, text, meta);
  if (/\b(?:buffer transfer|buffer operation|double buffer)\b/i.test(text)) {
    const bufferRegisters = registers.filter((name) => /^GTCCR/i.test(name));
    for (const register of bufferRegisters.length ? bufferRegisters : registers.slice(0, 4)) {
      registerActions.push({
        time_ref: /input capture/i.test(bufferEvidence.text) ? "input_capture" : "unknown",
        register,
        action: /buffer transfer/i.test(text) ? "buffer_transfer" : "update",
        value: values.find((value) => !/^0+_?0*h$/i.test(value)) || "",
        confidence: 0.62,
        source_evidence: [bufferEvidence],
      });
    }
    addInference(
      engineeringInferences,
      bufferRegisters.length
        ? `${bufferRegisters.join("/")} buffer operation is involved.`
        : "A buffer operation is involved.",
      bufferEvidence,
      0.64,
    );
  }

  const clearEvidence = firstEvidenceMatching(bundle, /\b(?:counter cleared|counter clear|clear source|cleared at both edges)\b/i, text, meta);
  if (/\b(?:counter cleared|counter clear|cleared at both edges|count clear source)\b/i.test(text)) {
    const targetCounters = counters.length ? counters : /\bGTCNT\b/i.test(text) ? ["GTCNT"] : [];
    for (const counter of targetCounters) {
      if (edgeKinds.length) {
        for (const edge of edgeKinds) {
          counterActions.push({
            time_ref: `edge_${edge}`,
            counter,
            action: "clear",
            confidence: 0.65,
            source_evidence: [clearEvidence],
          });
        }
      } else {
        counterActions.push({
          time_ref: "unknown",
          counter,
          action: "clear",
          confidence: 0.54,
          source_evidence: [clearEvidence],
        });
      }
    }
    addInference(
      engineeringInferences,
      edgeKinds.length > 1 && targetCounters[0] && triggerSignal
        ? `${targetCounters[0]} is cleared at both edges of ${triggerSignal}.`
        : "The counter clear behavior is described by nearby/caption text.",
      clearEvidence,
      edgeKinds.length > 1 ? 0.68 : 0.56,
    );
  }

  if (/\bsaw wave|up-counting|up counting|down-counting|down counting\b/i.test(text)) {
    const evidence = firstEvidenceMatching(bundle, /\b(?:saw wave|up-counting|up counting|down-counting|down counting)\b/i, text, meta);
    addInference(engineeringInferences, "The timing example describes saw-wave counting behavior.", evidence, 0.62);
  }

  if (registerActions.length || counterActions.length || events.length) {
    uncertainties.push("Timing relationships are inferred from caption/OCR/page/table text; waveform geometry and exact time positions are not verified.");
  }
  if (!events.length && /\bedge\b/i.test(text)) {
    uncertainties.push("Edge-related text was found, but the parser could not identify a specific edge event.");
  }
  if (!signals.length && normalized) warnings.push("No signal labels were confidently extracted from timing text.");

  const timeline = events.map((event) => ({
    time_ref: event.time_ref,
    event: event.id,
    signal: event.signal,
    edge: event.edge,
    confidence: event.confidence,
  }));

  return {
    signals,
    events,
    register_actions: uniqueBy(registerActions, (item) => `${item.time_ref}|${item.register}|${item.action}|${item.value}`),
    counter_actions: uniqueBy(counterActions, (item) => `${item.time_ref}|${item.counter}|${item.action}`),
    timeline,
    engineering_inferences: uniqueBy(engineeringInferences, (item) => item.statement),
    uncertainties,
    warnings,
  };
}
