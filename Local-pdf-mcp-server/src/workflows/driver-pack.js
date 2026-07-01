import { appendEvidenceContract, canonicalSymbol, clampInteger, clampTopK, compactText, confidenceLevel, evidenceFromChunk, getPdfSourceInfo, makeEvidence, makeEvidenceContract, makeInference, makeNeedsVerification, normalizeForSearch } from "../core/runtime-helpers.js";
import { createRuntimePort } from "../core/runtime-ports.js";
import { DEFAULT_DRIVER_PACK_BUDGET_MS, DEFAULT_DRIVER_PACK_CAUTION_TOPICS, DEFAULT_DRIVER_PACK_MODE, DEFAULT_DRIVER_PACK_REGISTERS, DEFAULT_DRIVER_PACK_SEQUENCE_TOPICS, DEFAULT_DRIVER_TASK_BUDGET_MS, DEFAULT_PAGE_RANGE, DRIVER_PACK_BUDGET_SAFETY_MS, DRIVER_PACK_FAST_CAUTION_LIMIT, DRIVER_PACK_FAST_SEQUENCE_LIMIT, DRIVER_PACK_FULL_MIN_BUDGET_MS, MAX_CAUTION_EVIDENCE_LINES, MAX_DRIVER_PACK_BUDGET_MS, MAX_DRIVER_TASK_HINTS, MAX_REGISTER_SUMMARY_CHUNKS, MAX_SEQUENCE_EVIDENCE_LINES, MIN_DRIVER_PACK_BUDGET_MS } from "../core/runtime-constants.js";
import path from "node:path";
import { sourceFingerprint } from "../artifacts/manifest.js";
import { normalizeDriverFamilyHint, normalizeDriverSubsystemHint } from "../driver-profiles/catalog.js";


const cautionMatchesFilter = createRuntimePort("cautionMatchesFilter");
const clampDriverPackRegisters = createRuntimePort("clampDriverPackRegisters");
const clampDriverPackSummaries = createRuntimePort("clampDriverPackSummaries");
const clampDriverTaskRegisters = createRuntimePort("clampDriverTaskRegisters");


const collectDriverReviewVisualEvidence = createRuntimePort("collectDriverReviewVisualEvidence");


const extractBitfieldTable = createRuntimePort("extractBitfieldTable");
const findCautionInIndex = createRuntimePort("findCautionInIndex");
const findSequenceInIndex = createRuntimePort("findSequenceInIndex");
const flattenChecklistRequirements = createRuntimePort("flattenChecklistRequirements");
const formatDriverVisualEvidenceSection = createRuntimePort("formatDriverVisualEvidenceSection");
const formatVisualEvidenceGateSection = createRuntimePort("formatVisualEvidenceGateSection");
const getCautionsForRegister = createRuntimePort("getCautionsForRegister");
const getModuleProfile = createRuntimePort("getModuleProfile");

const getSequenceFromIndex = createRuntimePort("getSequenceFromIndex");
const hybridSearchPdf = createRuntimePort("hybridSearchPdf");
const listRegistersFromIndex = createRuntimePort("listRegistersFromIndex");
const loadCautionsIndex = createRuntimePort("loadCautionsIndex");
const loadPdfIndex = createRuntimePort("loadPdfIndex");
const loadSequencesIndex = createRuntimePort("loadSequencesIndex");


const mergeUniqueStrings = createRuntimePort("mergeUniqueStrings");

const normalizeRegisterName = createRuntimePort("normalizeRegisterName");
const resolveDriverProfile = createRuntimePort("resolveDriverProfile");
const scoreSequenceEntry = createRuntimePort("scoreSequenceEntry");
const scoreSimpleText = createRuntimePort("scoreSimpleText");
const searchPdfIndex = createRuntimePort("searchPdfIndex");
const searchRegistersIndex = createRuntimePort("searchRegistersIndex");
const searchSectionsIndex = createRuntimePort("searchSectionsIndex");
const summarizeRegister = createRuntimePort("summarizeRegister");
const summarizeRegisterEntryFast = createRuntimePort("summarizeRegisterEntryFast");
const visualEvidenceGateWarnings = createRuntimePort("visualEvidenceGateWarnings");


// -----------------------------------------------------------------------------
// Driver evidence pack
// -----------------------------------------------------------------------------

export function inferModuleType(filename, registers = [], sections = [], providedType = "") {
  const provided = String(providedType || "").trim().toLowerCase();
  if (provided) return provided;

  const haystack = normalizeForSearch([
    filename,
    ...registers.slice(0, 80).map((r) => `${r.name || ""} ${r.description || ""} ${(r.sections || []).map((s) => s.title).join(" ")}`),
    ...sections.slice(0, 40).map((s) => s.title || ""),
  ].join("\n"));

  const rules = [
    { type: "dmaengine", patterns: ["dma", "dmac", "direct memory access"] },
    { type: "watchdog", patterns: ["watchdog", "wdt"] },
    { type: "pwm/timer", patterns: ["pwm", "gpt", "general pwm timer", "timer"] },
    { type: "gpio", patterns: ["gpio", "port", "pin"] },
    { type: "i2c", patterns: ["i2c", "iic", "riic"] },
    { type: "spi", patterns: ["spi", "rsci", "serial peripheral"] },
    { type: "uart", patterns: ["uart", "scif", "sci", "serial communication"] },
    { type: "ethernet", patterns: ["ethernet", "geth", "gbeth", "mac", "phy"] },
    { type: "can", patterns: ["can", "canfd"] },
    { type: "usb", patterns: ["usb", "xhci", "ehci", "ohci", "dwc3"] },
    { type: "pcie", patterns: ["pcie", "pci express", "root complex", "host bridge"] },
    { type: "adc", patterns: ["adc", "analog digital", "a d converter"] },
    { type: "rtc", patterns: ["rtc", "real time clock"] },
  ];

  for (const rule of rules) {
    if (rule.patterns.some((pattern) => haystack.includes(pattern))) return rule.type;
  }

  return "unknown";
}

export function likelyLinuxSubsystem(moduleType) {
  const type = String(moduleType || "").toLowerCase();
  const mapping = new Map([
    ["dmaengine", "Linux dmaengine framework"],
    ["watchdog", "Linux watchdog framework"],
    ["pwm/timer", "Linux PWM framework and/or clocksource/clockevent/timer subsystem"],
    ["gpio", "Linux GPIO/pinctrl/IRQ subsystem"],
    ["i2c", "Linux I2C adapter framework"],
    ["spi", "Linux SPI controller framework"],
    ["uart", "Linux serial/TTY framework"],
    ["ethernet", "Linux netdev + phylink/PHY framework"],
    ["can", "Linux SocketCAN framework"],
    ["usb", "Linux USB host/device/gadget/PHY framework"],
    ["pcie", "Linux PCI/PCIe host bridge and endpoint framework"],
    ["adc", "Linux IIO ADC framework"],
    ["rtc", "Linux RTC framework"],
  ]);
  return mapping.get(type) || "Unknown; infer from Linux source tree and module purpose.";
}

export function classifyRegisterGroup(register) {
  const name = String(register.name || register.displayName || "");
  const desc = String(register.description || "");
  const text = `${name} ${desc}`.toUpperCase();

  if (/(_N[01]SA|_N[01]DA|_CRSA|_CRDA|SOURCE ADDRESS|DESTINATION ADDRESS)/.test(text)) return "Address registers";
  if (/(_N[01]TB|_CRTB|TRANSFER BYTE|TRANSFER COUNT|COUNT)/.test(text)) return "Transfer size/count registers";
  if (/(CHCTRL|CTRL|CONTROL|DCTRL|CR\b|WDTCR|GTCR)/.test(text)) return "Control registers";
  if (/(CHCFG|CFG|CONFIG|MODE|SETTING)/.test(text)) return "Configuration registers";
  if (/(CHSTAT|STATUS|STAT|_SR\b|DST_|ERROR|END|SUS|TC)/.test(text)) return "Status/error registers";
  if (/(INT|IRQ|IEN|IER|ISR|FLAG)/.test(text)) return "Interrupt registers";
  if (/(RESET|RST|SWRST)/.test(text)) return "Reset registers";
  if (/(COMPARE|CAPTURE|COUNTER|COUNT|PERIOD|GTCC|GTCNT)/.test(text)) return "Counter/compare/capture registers";
  if (/(DATA|FIFO|BUFFER|TX|RX)/.test(text)) return "Data/FIFO registers";
  if (/_N\b|_N$|_N\d|_N[01]|_CH|CHANNEL/.test(text)) return "Per-channel registers";
  return "Other registers";
}

export function groupRegistersForDriverPack(registers) {
  const groups = new Map();
  for (const reg of registers) {
    const group = classifyRegisterGroup(reg);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(reg);
  }

  const preferred = [
    "Control registers",
    "Configuration registers",
    "Status/error registers",
    "Interrupt registers",
    "Address registers",
    "Transfer size/count registers",
    "Counter/compare/capture registers",
    "Reset registers",
    "Data/FIFO registers",
    "Per-channel registers",
    "Other registers",
  ];

  return preferred
    .filter((name) => groups.has(name))
    .map((name) => ({ name, registers: groups.get(name) }));
}

export function scoreKeyRegisterForDriverPack(register, moduleType) {
  const name = String(register.name || register.displayName || "");
  const desc = String(register.description || "");
  const text = `${name} ${desc}`.toUpperCase();
  let score = 0;

  score += Math.min(Number(register.confidence || 0), 100) / 4;
  if (register.isExplicitRegister) score += 20;
  if ((register.chunks || []).length) score += 10;
  if ((register.pages || []).length) score += 6;
  if (/(CTRL|CONTROL|DCTRL|CHCTRL|CR\b|WDTCR|GTCR)/.test(text)) score += 45;
  if (/(CFG|CONFIG|MODE|SETTING|CHCFG)/.test(text)) score += 38;
  if (/(STAT|STATUS|CHSTAT|DST_|ERROR|ER\b|END|TC|SUS|SR\b)/.test(text)) score += 36;
  if (/(INT|IRQ|IEN|IER|ISR|FLAG)/.test(text)) score += 28;
  if (/(RESET|SWRST|RST)/.test(text)) score += 26;
  if (/(_SA|_DA|SOURCE ADDRESS|DESTINATION ADDRESS|_TB|TRANSFER BYTE|TRANSFER COUNT)/.test(text)) score += 22;

  const type = String(moduleType || "").toLowerCase();
  if (type.includes("dma")) {
    if (/(CHCTRL|CHSTAT|CHCFG|DCTRL|DST_|N0SA|N0DA|N0TB)/.test(text)) score += 25;
  } else if (type.includes("watchdog")) {
    if (/(WDTCR|WDTRR|WDTSR|WDTRCR)/.test(text)) score += 35;
  } else if (type.includes("pwm") || type.includes("timer")) {
    if (/(GTCR|GTCCR|GTST|GTINTAD|GTCNT|GTPR|GTBER)/.test(text)) score += 30;
  }

  return Math.round(score);
}

export function selectKeyRegistersForDriverPack(registers, moduleType, topK) {
  return registers
    .map((reg) => ({ ...reg, driverPackScore: scoreKeyRegisterForDriverPack(reg, moduleType) }))
    .sort((a, b) => {
      if (b.driverPackScore !== a.driverPackScore) return b.driverPackScore - a.driverPackScore;
      const aPage = (a.pages || [Number.MAX_SAFE_INTEGER])[0];
      const bPage = (b.pages || [Number.MAX_SAFE_INTEGER])[0];
      if (aPage !== bPage) return aPage - bPage;
      return String(a.name || "").localeCompare(String(b.name || ""));
    })
    .slice(0, topK);
}

export function sequenceTopicsForDriverPack(moduleType, focus = "", workflowProfile = null) {
  const type = String(moduleType || "").toLowerCase();
  const topics = new Set([
    "initialization",
    "start operation",
    "stop operation",
    "reset",
    "software reset",
    "clear interrupt status",
    "clear status flag",
    "error handling",
  ]);

  if (focus) topics.add(focus);
  for (const topic of normalizeStringArray(workflowProfile?.sequence_topics || [])) topics.add(topic);
  for (const topic of normalizeStringArray(workflowProfile?.evidence_topics || [])) topics.add(topic);

  if (type.includes("dma")) {
    ["configure transfer", "start DMA transfer", "stop DMA transfer", "suspend channel", "clear transfer end", "clear error status", "interrupt handling"].forEach((t) => topics.add(t));
  } else if (type.includes("watchdog")) {
    ["start watchdog", "refresh watchdog", "restart watchdog", "timeout setting", "reset output"].forEach((t) => topics.add(t));
  } else if (type.includes("pwm") || type.includes("timer")) {
    ["start counter", "stop counter", "set period", "clear interrupt status", "output compare", "input capture"].forEach((t) => topics.add(t));
  } else if (type.includes("i2c")) {
    ["start condition", "stop condition", "transfer sequence", "interrupt handling", "bus reset"].forEach((t) => topics.add(t));
  } else if (type.includes("spi")) {
    ["transfer start", "transfer end", "FIFO operation", "interrupt handling", "reset"].forEach((t) => topics.add(t));
  }

  return [...topics].slice(0, DEFAULT_DRIVER_PACK_SEQUENCE_TOPICS + 6);
}

export function cautionTopicsForDriverPack(moduleType, focus = "", workflowProfile = null) {
  const type = String(moduleType || "").toLowerCase();
  const topics = new Set([
    "reserved bits",
    "write only when stopped",
    "write prohibited",
    "undefined",
    "invalid",
    "clear status flag",
    "write 1 to clear",
    "write 0 to clear",
    "interrupt status clear",
    "read modify write",
  ]);

  if (focus) topics.add(focus);
  for (const topic of normalizeStringArray(workflowProfile?.caution_topics || [])) topics.add(topic);
  for (const topic of normalizeStringArray(workflowProfile?.evidence_topics || [])) topics.add(topic);

  if (type.includes("dma")) {
    ["channel enable", "channel stop", "transfer end clear", "error status", "suspend", "software reset"].forEach((t) => topics.add(t));
  } else if (type.includes("watchdog")) {
    ["refresh sequence", "write sequence", "timeout", "stop watchdog", "reset"].forEach((t) => topics.add(t));
  } else if (type.includes("pwm") || type.includes("timer")) {
    ["write while counting", "counter stopped", "interrupt clear", "buffer transfer", "output setting"].forEach((t) => topics.add(t));
  }

  return [...topics].slice(0, DEFAULT_DRIVER_PACK_CAUTION_TOPICS + 6);
}

export function collectDriverPackBitfields(registerSummaries, limit = 80) {
  const map = new Map();
  for (const summary of registerSummaries) {
    const register = summary.registerEntry && (summary.registerEntry.displayName || summary.registerEntry.name || summary.register);
    for (const field of summary.bitfields || []) {
      const name = String(field.name || "").trim();
      if (!name) continue;
      const key = `${register || "unknown"}:${canonicalSymbol(name)}`;
      if (!map.has(key)) {
        map.set(key, {
          register,
          name,
          pages: new Set(),
          chunks: new Set(),
          evidence: [],
        });
      }
      const entry = map.get(key);
      for (const page of field.pages || []) entry.pages.add(page);
      for (const chunkId of field.chunks || []) entry.chunks.add(chunkId);
      for (const line of field.evidence || []) {
        if (entry.evidence.length < 3) entry.evidence.push(line);
      }
    }
  }

  return [...map.values()].slice(0, limit).map((entry) => ({
    ...entry,
    pages: [...entry.pages].sort((a, b) => a - b),
    chunks: [...entry.chunks].slice(0, 6),
  }));
}

export function normalizeDriverPackMode(value) {
  const mode = String(value || DEFAULT_DRIVER_PACK_MODE).trim().toLowerCase();
  if (mode === "full") return "full";
  if (mode === "fast") return "fast";
  return "adaptive";
}

export function clampDriverPackBudgetMs(value) {
  return clampInteger(value, DEFAULT_DRIVER_PACK_BUDGET_MS, MIN_DRIVER_PACK_BUDGET_MS, MAX_DRIVER_PACK_BUDGET_MS);
}

export function createDriverPackBudget(budgetMs) {
  const startMs = Date.now();
  const maxMs = clampDriverPackBudgetMs(budgetMs);
  return {
    startMs,
    maxMs,
    deadlineMs: startMs + maxMs,
    elapsedMs() {
      return Date.now() - startMs;
    },
    remainingMs() {
      return Math.max(0, startMs + maxMs - Date.now());
    },
    hasTime(requiredMs = DRIVER_PACK_BUDGET_SAFETY_MS) {
      return this.remainingMs() > requiredMs;
    },
    snapshot() {
      return {
        timeBudgetMs: maxMs,
        elapsedMs: this.elapsedMs(),
        remainingMs: this.remainingMs(),
      };
    },
  };
}

export function driverPackPerformanceNote(mode, requestedMode, partial, fallbackReason) {
  if (mode === "adaptive") {
    return "Adaptive mode is fast-first and budget-aware. It returns partial evidence plus targeted follow-up calls instead of switching to a full manual scan automatically.";
  }
  if (mode === "fast") {
    return "Fast mode uses persistent register/sequence/caution indexes and avoids expensive dynamic scans. Use targeted follow-up tools for details.";
  }
  if (mode === "full" && fallbackReason) {
    return `Full mode was requested, but the pack used timeout-safe fallback: ${fallbackReason}`;
  }
  if (mode === "full") {
    return "Full mode performs dynamic sequence/caution searches and can be slow on large manuals.";
  }
  return partial ? "Partial evidence pack returned due to tool budget." : "Driver evidence pack generated.";
}

export function sequenceToDriverPackItem(sequence, topic, contextRegisters = []) {
  const firstChunk = (sequence.chunks || [])[0] || {};
  const firstPage = (sequence.pages || [firstChunk.page || 1])[0] || firstChunk.page || 1;
  const relatedRegisterSet = new Set((sequence.relatedRegisters || []).map(normalizeRegisterName));
  const register = contextRegisters.find((name) => relatedRegisterSet.has(normalizeRegisterName(name))) || "";

  return {
    topic,
    register,
    result: {
      id: firstChunk.id || sequence.id,
      page: firstPage,
      chunkIndex: firstChunk.chunkIndex || 0,
      score: sequence.matchScore || sequence.filterScore || sequence.score || 0,
      sequenceEvidence: (sequence.evidenceLines || firstChunk.evidenceLines || []).slice(0, MAX_SEQUENCE_EVIDENCE_LINES),
      headings: firstChunk.headings || [],
      registers: sequence.relatedRegisters || [],
      text: firstChunk.preview || "",
    },
    source: "persistent-sequence-index",
  };
}

export function cautionToDriverPackItem(caution, topic, contextRegisters = []) {
  const firstChunk = (caution.chunks || [])[0] || {};
  const firstPage = (caution.pages || [firstChunk.page || 1])[0] || firstChunk.page || 1;
  const relatedRegisterSet = new Set((caution.relatedRegisters || []).map(normalizeRegisterName));
  const register = contextRegisters.find((name) => relatedRegisterSet.has(normalizeRegisterName(name))) || "";

  return {
    topic,
    register,
    result: {
      id: firstChunk.id || caution.id,
      page: firstPage,
      chunkIndex: firstChunk.chunkIndex || 0,
      score: caution.matchScore || caution.score || 0,
      cautionEvidence: (caution.evidenceLines || firstChunk.evidenceLines || []).slice(0, MAX_CAUTION_EVIDENCE_LINES),
      type: caution.type || "general",
      riskForDriver: caution.riskForDriver || "review required",
      registers: caution.relatedRegisters || [],
      text: firstChunk.preview || "",
    },
    source: "persistent-caution-index",
  };
}

export async function collectDriverPackSequencesFast(filename, moduleType, focus, keyRegisters, workflowProfile = null) {
  const topics = sequenceTopicsForDriverPack(moduleType, focus, workflowProfile);
  const contextRegisters = keyRegisters.slice(0, 6).map((r) => r.displayName || r.name).filter(Boolean);
  let sequencesIndex;

  try {
    sequencesIndex = await loadSequencesIndex(filename);
    if (!sequencesIndex) return [];
  } catch {
    return [];
  }

  const selected = [];
  const selectedIds = new Set();

  for (const topic of topics) {
    const candidates = (sequencesIndex.sequences || [])
      .map((sequence) => {
        let score = scoreSequenceEntry(sequence, topic, "");
        const related = new Set((sequence.relatedRegisters || []).map(normalizeRegisterName));
        for (const reg of contextRegisters) {
          if (related.has(normalizeRegisterName(reg))) score += 45;
        }
        return { ...sequence, matchScore: score };
      })
      .filter((sequence) => sequence.matchScore > 0)
      .sort((a, b) => {
        if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
        return Number(b.score || 0) - Number(a.score || 0);
      });

    const best = candidates[0];
    if (!best) continue;
    const key = best.id || `${best.topic}:${(best.pages || []).join(",")}`;
    if (selectedIds.has(key)) continue;
    selectedIds.add(key);
    selected.push(sequenceToDriverPackItem(best, topic, contextRegisters));
    if (selected.length >= DRIVER_PACK_FAST_SEQUENCE_LIMIT) break;
  }

  return selected;
}

export async function collectDriverPackCautionsFast(filename, moduleType, focus, keyRegisters, workflowProfile = null) {
  const topics = cautionTopicsForDriverPack(moduleType, focus, workflowProfile);
  const contextRegisters = keyRegisters.slice(0, 6).map((r) => r.displayName || r.name).filter(Boolean);
  let cautionsIndex;

  try {
    cautionsIndex = await loadCautionsIndex(filename);
    if (!cautionsIndex) return [];
  } catch {
    return [];
  }

  const selected = [];
  const selectedIds = new Set();

  for (const topic of topics) {
    const candidates = (cautionsIndex.cautions || [])
      .map((caution) => {
        const matches = cautionMatchesFilter(caution, topic, "", "");
        const text = [
          caution.topic,
          caution.type,
          caution.riskForDriver,
          ...(caution.evidenceLines || []),
          ...(caution.relatedRegisters || []),
        ].join("\n");
        let score = (matches ? 70 : 0) + scoreSimpleText(text, topic) + Math.round(Number(caution.score || 0) / 6);
        const related = new Set((caution.relatedRegisters || []).map(normalizeRegisterName));
        for (const reg of contextRegisters) {
          if (related.has(normalizeRegisterName(reg))) score += 45;
        }
        return { ...caution, matchScore: score };
      })
      .filter((caution) => caution.matchScore > 0)
      .sort((a, b) => {
        if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
        return Number(b.score || 0) - Number(a.score || 0);
      });

    const best = candidates[0];
    if (!best) continue;
    const key = best.id || `${best.topic}:${(best.pages || []).join(",")}`;
    if (selectedIds.has(key)) continue;
    selectedIds.add(key);
    selected.push(cautionToDriverPackItem(best, topic, contextRegisters));
    if (selected.length >= DRIVER_PACK_FAST_CAUTION_LIMIT) break;
  }

  return selected;
}

export async function collectDriverPackSequences(filename, moduleType, focus, keyRegisters, workflowProfile = null) {
  const topics = sequenceTopicsForDriverPack(moduleType, focus, workflowProfile);
  const results = [];
  const contextRegisters = keyRegisters.slice(0, 4).map((r) => r.displayName || r.name).filter(Boolean);

  for (const topic of topics) {
    let best = null;
    const generic = await findSequenceInIndex(filename, topic, { topK: 3 });
    if (generic.results && generic.results.length) {
      best = { topic, register: "", result: generic.results[0] };
    }

    for (const register of contextRegisters) {
      const scoped = await findSequenceInIndex(filename, topic, { register, topK: 2 });
      if (scoped.results && scoped.results.length) {
        const candidate = scoped.results[0];
        if (!best || Number(candidate.score || 0) > Number(best.result.score || 0)) {
          best = { topic, register, result: candidate };
        }
      }
    }

    if (best) results.push(best);
  }

  return results;
}

export async function collectDriverPackCautions(filename, moduleType, focus, keyRegisters, workflowProfile = null) {
  const topics = cautionTopicsForDriverPack(moduleType, focus, workflowProfile);
  const results = [];
  const contextRegisters = keyRegisters.slice(0, 4).map((r) => r.displayName || r.name).filter(Boolean);

  for (const topic of topics) {
    let best = null;
    const generic = await findCautionInIndex(filename, topic, { topK: 3 });
    if (generic.results && generic.results.length) {
      best = { topic, register: "", result: generic.results[0] };
    }

    for (const register of contextRegisters) {
      const scoped = await findCautionInIndex(filename, topic, { register, topK: 2 });
      if (scoped.results && scoped.results.length) {
        const candidate = scoped.results[0];
        if (!best || Number(candidate.score || 0) > Number(best.result.score || 0)) {
          best = { topic, register, result: candidate };
        }
      }
    }

    if (best) results.push(best);
  }

  return results;
}

export function driverImplementationChecklist(moduleType) {
  const type = String(moduleType || "").toLowerCase();
  const common = [
    "Map MMIO resource and validate register offsets against manual evidence.",
    "Enable required clocks and deassert reset using the source tree's clock/reset data.",
    "Preserve reserved bits unless the manual explicitly says a raw write is allowed.",
    "Verify status clear semantics before writing interrupt/status registers.",
    "Implement probe error unwind and remove/shutdown paths.",
  ];

  if (type.includes("dma")) {
    return [
      "Use Linux dmaengine framework conventions: dma_device, virt-dma or appropriate channel model.",
      "Identify per-channel register stride and global register base offsets.",
      "Implement transfer preparation by programming source/destination/count/config registers from manual evidence.",
      "Implement issue_pending/start using the manual start/enable sequence.",
      "Implement terminate/suspend/reset using manual stop/reset restrictions.",
      "Handle transfer-end/error interrupts and clear status exactly as specified.",
      ...common,
    ];
  } else if (type.includes("can")) {
    return [
      "Use Linux SocketCAN conventions: can_priv, bittiming_const, netdev open/stop/start_xmit, and bus-off recovery.",
      "Verify nominal/data bit timing formulas, FIFO/mailbox ownership, TX/RX status, and error state flags.",
      "Check transceiver, pinctrl, clocks, resets, and runtime PM against Device Tree and manual evidence.",
      ...common,
    ];
  } else if (type.includes("usb")) {
    return [
      "Identify whether the source is host, gadget/device, OTG/role-switch, PHY, or glue code before judging completeness.",
      "Verify PHY/VBUS/clocks/resets/regulators and controller reset/start sequence before USB core handoff.",
      "Check endpoint/FIFO/status/interrupt handling and runtime PM/wakeup behavior against manual evidence.",
      ...common,
    ];
  } else if (type.includes("pcie") || type.includes("pci")) {
    return [
      "Identify whether the source is host bridge/root complex, endpoint, PHY, or glue code before judging completeness.",
      "Verify refclk/PERST/reset/PHY sequence, link training/polling, address windows, config access, and MSI/IRQ routing.",
      "Check DT ranges, interrupts, clocks/resets, regulators, and suspend/resume against manual evidence.",
      ...common,
    ];
  }

  if (type.includes("watchdog")) {
    return [
      "Use Linux watchdog framework conventions: watchdog_device and watchdog_ops.",
      "Derive min/max timeout from clock and prescaler/top settings.",
      "Implement start/stop/ping using the manual refresh/write sequence.",
      "Verify reset behavior and panic/restart behavior against manual cautions.",
      ...common,
    ];
  }

  if (type.includes("pwm") || type.includes("timer")) {
    return [
      "Use Linux PWM framework or timer subsystem according to driver goal.",
      "Verify counter start/stop restrictions before programming period/duty registers.",
      "Map output polarity/mode bits and status clear behavior from manual evidence.",
      "Handle shared-channel or paired-output constraints if present.",
      ...common,
    ];
  }

  return [
    "Select the Linux subsystem from the current source tree and module function.",
    "Identify the minimum register set for probe/init/start/stop/IRQ paths.",
    "Map each driver macro to manual register/bit-field evidence.",
    "Use get_sequence/list_cautions/get_cautions_for_register for every register write involved in state changes.",
    ...common,
  ];
}

export async function buildDriverEvidencePack(filename, options = {}) {
  const topRegisters = clampDriverPackRegisters(options.topRegisters);
  const topSummaries = clampDriverPackSummaries(options.topSummaries);
  const requestedMode = normalizeDriverPackMode(options.mode);
  const budget = createDriverPackBudget(options.budgetMs);
  const moduleTypeHint = String(options.moduleType || "").trim();
  const focus = String(options.focus || "").trim();
  const partialWarnings = [];
  const skippedPhases = [];
  const completedPhases = [];
  let effectiveMode = requestedMode;
  let fullFallbackReason = "";
  const fingerprint = sourceFingerprint(await getPdfSourceInfo(filename));

  const markPhase = (name) => completedPhases.push({ name, ...budget.snapshot() });
  const skipPhase = (name, reason) => {
    skippedPhases.push({ name, reason, ...budget.snapshot() });
    partialWarnings.push(`${name}: ${reason}`);
  };

  const indexData = await loadPdfIndex(filename);
  markPhase("load-pdf-index");

  const { registerIndex, results: registers } = await listRegistersFromIndex(filename, {
    topK: topRegisters,
    includeLowConfidence: false,
  });
  markPhase("list-registers");

  let overviewSections = [];
  let registerSections = [];
  let operationSections = [];
  let cautionSections = [];

  if (budget.hasTime(2500)) {
    const [overview, regDesc, operation, caution] = await Promise.all([
      searchSectionsIndex(filename, "overview", 5).catch(() => ({ results: [] })),
      searchSectionsIndex(filename, "register description", 6).catch(() => ({ results: [] })),
      searchSectionsIndex(filename, "operation procedure setting", 8).catch(() => ({ results: [] })),
      searchSectionsIndex(filename, "caution note restriction usage notes", 8).catch(() => ({ results: [] })),
    ]);
    overviewSections = overview.results || [];
    registerSections = regDesc.results || [];
    operationSections = operation.results || [];
    cautionSections = caution.results || [];
    markPhase("section-hints");
  } else {
    skipPhase("section-hints", "insufficient time budget");
  }

  const allSections = [...overviewSections, ...registerSections, ...operationSections, ...cautionSections];
  const moduleType = inferModuleType(filename, registers, allSections, moduleTypeHint);
  const workflowSubsystem = normalizeDriverSubsystemHint(moduleType);
  const workflowFamily = normalizeDriverFamilyHint(moduleTypeHint);
  let workflowProfile = null;
  let workflowProfileWarnings = [];
  try {
    const resolvedWorkflowProfile = await resolveDriverProfile({
      subsystem: workflowSubsystem,
      driverFamily: workflowFamily,
      createDefault: true,
    });
    workflowProfile = resolvedWorkflowProfile.profile;
    workflowProfileWarnings = resolvedWorkflowProfile.warnings || [];
  } catch (error) {
    workflowProfileWarnings = [`driver profile unavailable: ${error instanceof Error ? error.message : String(error)}`];
  }
  const keyRegisters = selectKeyRegistersForDriverPack(registers, moduleType, topSummaries);
  const registerSummaries = [];

  if (requestedMode === "full" && budget.maxMs < DRIVER_PACK_FULL_MIN_BUDGET_MS) {
    effectiveMode = "adaptive";
    fullFallbackReason = `budget_ms=${budget.maxMs} is below ${DRIVER_PACK_FULL_MIN_BUDGET_MS} ms required for full mode`;
    partialWarnings.push(fullFallbackReason);
  }

  const useFastSummaries = effectiveMode !== "full";
  for (const reg of keyRegisters) {
    const regName = reg.displayName || reg.name;
    if (!budget.hasTime(useFastSummaries ? 1200 : 6000)) {
      skipPhase(`summary:${regName}`, "time budget nearly exhausted; return partial pack and use summarize_register as follow-up");
      break;
    }
    try {
      if (useFastSummaries) {
        registerSummaries.push(summarizeRegisterEntryFast(filename, registerIndex, reg, indexData, Math.min(4, MAX_REGISTER_SUMMARY_CHUNKS)));
      } else {
        registerSummaries.push(await summarizeRegister(filename, regName, {
          topK: Math.min(8, MAX_REGISTER_SUMMARY_CHUNKS),
          includeBitfieldEvidence: true,
        }));
      }
    } catch (error) {
      registerSummaries.push({
        filename,
        register: regName,
        registerEntry: reg,
        relatedChunks: [],
        bitfields: [],
        reliability: `Failed to summarize register: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  markPhase("register-summaries");

  const bitfields = collectDriverPackBitfields(registerSummaries);
  let sequences = [];
  let cautions = [];

  if (budget.hasTime(effectiveMode === "full" ? 12000 : 1800)) {
    sequences = effectiveMode === "full"
      ? await collectDriverPackSequences(filename, moduleType, focus, keyRegisters, workflowProfile)
      : await collectDriverPackSequencesFast(filename, moduleType, focus, keyRegisters, workflowProfile);
    markPhase("sequence-candidates");
  } else {
    skipPhase("sequence-candidates", "time budget nearly exhausted; use list_sequences/get_sequence as follow-up");
  }

  if (budget.hasTime(effectiveMode === "full" ? 12000 : 1800)) {
    cautions = effectiveMode === "full"
      ? await collectDriverPackCautions(filename, moduleType, focus, keyRegisters, workflowProfile)
      : await collectDriverPackCautionsFast(filename, moduleType, focus, keyRegisters, workflowProfile);
    markPhase("caution-candidates");
  } else {
    skipPhase("caution-candidates", "time budget nearly exhausted; use list_cautions/get_cautions_for_register as follow-up");
  }

  let visualEvidence = [];
  let visualEvidenceGate = { enabled: options.includeVisualEvidence !== false, statusFilter: options.visualStatus || "all", gate: options.visualGate || "advisory", requireVerified: false, entries: [], allEntries: [], verifiedEntries: [], unverifiedEntries: [], rejectedEntries: [], blockers: [], warnings: [] };
  if (budget.hasTime(700)) {
    visualEvidenceGate = await collectDriverReviewVisualEvidence(filename, {
      include: options.includeVisualEvidence !== false,
      filter: options.visualFilter || focus,
      focus,
      task: focus,
      moduleType,
      registers: keyRegisters.map((reg) => reg.displayName || reg.name).filter(Boolean),
      topK: clampInteger(options.visualTopK, 8, 1, 30),
      status: options.visualStatus || "all",
      gate: options.visualGate || "advisory",
      requireVerified: options.visualRequireVerified,
    });
    visualEvidence = visualEvidenceGate.entries;
    partialWarnings.push(...visualEvidenceGateWarnings(visualEvidenceGate));
    markPhase("visual-evidence");
  } else {
    skipPhase("visual-evidence", "time budget nearly exhausted; use visual_evidence_report as follow-up");
  }

  const groups = groupRegistersForDriverPack(registers);
  markPhase("finalize");

  const partial = skippedPhases.length > 0;
  const budgetSnapshot = budget.snapshot();

  return {
    filename,
    sourceFingerprint: fingerprint,
    createdAt: new Date().toISOString(),
    mode: effectiveMode,
    requestedMode,
    partial,
    partialWarnings,
    skippedPhases,
    completedPhases,
    budget: budgetSnapshot,
    performanceNote: driverPackPerformanceNote(effectiveMode, requestedMode, partial, fullFallbackReason),
    moduleType,
    moduleTypeHint,
    linuxSubsystem: likelyLinuxSubsystem(workflowSubsystem || moduleType),
    workflowProfile,
    workflowProfileWarnings,
    focus,
    registerIndex,
    registers,
    groups,
    keyRegisters,
    registerSummaries,
    bitfields,
    sequences,
    cautions,
    visualEvidence,
    visualEvidenceGate,
    sections: {
      overview: overviewSections,
      registerDescription: registerSections,
      operation: operationSections,
      caution: cautionSections,
    },
    checklist: mergeUniqueStrings(
      driverImplementationChecklist(moduleType),
      workflowProfile?.source_review_steps || [],
      flattenChecklistRequirements(workflowProfile || {}).slice(0, MAX_DRIVER_TASK_HINTS).map((row) => `${row.area}: ${row.item}`),
    ),
  };
}

export function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
  }

  const text = String(value || "").trim();
  if (!text) return [];

  return [...new Set(text.split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean))];
}

export function inferDriverTaskIntents(task, moduleType = "") {
  const normalized = normalizeForSearch(`${task} ${moduleType}`);
  const intents = new Set();

  if (/debug|bug|fail|failure|not|hang|timeout|does not|wrong|issue|problem|error|broken|regression/.test(normalized)) intents.add("debug");
  if (/implement|add|support|write|new feature|feature|enable/.test(normalized)) intents.add("implement");
  if (/probe|init|initialize|initial|clock|reset deassert|setup|configuration|configure/.test(normalized)) intents.add("init");
  if (/start|enable|run|kick|trigger|issue pending|transfer start|counter start/.test(normalized)) intents.add("start");
  if (/stop|disable|terminate|suspend|pause|halt|shutdown/.test(normalized)) intents.add("stop");
  if (/clear|status|flag|ack|acknowledge|complete|done|tc|end/.test(normalized)) intents.add("clear");
  if (/irq|interrupt|isr|handler|complete|completion|error interrupt/.test(normalized)) intents.add("irq");
  if (/reset|software reset|swrst|rst/.test(normalized)) intents.add("reset");
  if (/error|err|fault|bus error|overflow|underflow/.test(normalized)) intents.add("error");
  if (/reserved|prohibit|forbid|undefined|invalid|caution|restriction|note|write only|read only|write 1|write 0/.test(normalized)) intents.add("caution");
  if (/bit|field|mask|macro|define|position|shift|bitfield/.test(normalized)) intents.add("bitfield");
  if (/offset|address|register map|stride|base/.test(normalized)) intents.add("register-map");

  if (!intents.size) intents.add("general");
  return [...intents];
}

export function sequenceTopicsForDriverTask(task, moduleType, intents, workflowProfile = null) {
  const topics = new Set();
  const taskText = String(task || "").trim();
  if (taskText) topics.add(taskText);
  for (const topic of normalizeStringArray(workflowProfile?.sequence_topics || [])) topics.add(topic);
  for (const topic of normalizeStringArray(workflowProfile?.evidence_topics || [])) topics.add(topic);

  if (intents.includes("init")) {
    topics.add("initialization procedure");
    topics.add("initial setting procedure");
    topics.add("clock reset setting procedure");
  }
  if (intents.includes("start")) {
    topics.add("start operation");
    topics.add("enable operation sequence");
    topics.add("start transfer");
    topics.add("counter start");
  }
  if (intents.includes("stop")) {
    topics.add("stop operation");
    topics.add("disable operation sequence");
    topics.add("terminate suspend operation");
  }
  if (intents.includes("clear")) {
    topics.add("clear status flag");
    topics.add("clear interrupt status");
    topics.add("transfer complete clear");
  }
  if (intents.includes("irq")) {
    topics.add("interrupt handling");
    topics.add("interrupt source status clear");
    topics.add("error interrupt handling");
  }
  if (intents.includes("reset")) {
    topics.add("software reset procedure");
    topics.add("module reset sequence");
  }
  if (intents.includes("error")) {
    topics.add("error handling");
    topics.add("error status clear");
  }

  const type = String(moduleType || "").toLowerCase();
  if (type.includes("dma")) {
    topics.add("DMA transfer start procedure");
    topics.add("DMA transfer stop procedure");
    topics.add("DMA transfer end interrupt clear");
  } else if (type.includes("watchdog")) {
    topics.add("watchdog refresh sequence");
    topics.add("watchdog start operation");
  } else if (type.includes("pwm") || type.includes("timer")) {
    topics.add("counter start operation");
    topics.add("counter stop operation");
    topics.add("interrupt flag clear");
  }

  return [...topics].slice(0, 14);
}

export function cautionTopicsForDriverTask(task, moduleType, intents, workflowProfile = null) {
  const topics = new Set();
  const taskText = String(task || "").trim();

  topics.add("reserved bits");
  topics.add("write only when stopped");
  topics.add("write 1 to clear");
  topics.add("write 0 to clear");
  topics.add("undefined invalid prohibited");

  if (taskText) topics.add(taskText);
  for (const topic of normalizeStringArray(workflowProfile?.caution_topics || [])) topics.add(topic);
  for (const topic of normalizeStringArray(workflowProfile?.evidence_topics || [])) topics.add(topic);
  if (intents.includes("clear")) {
    topics.add("clear status flag");
    topics.add("cleared by writing");
    topics.add("status flag clear semantics");
  }
  if (intents.includes("start") || intents.includes("stop")) {
    topics.add("write timing restriction");
    topics.add("operation order restriction");
    topics.add("must be set while stopped");
  }
  if (intents.includes("irq")) {
    topics.add("interrupt status clear");
    topics.add("interrupt enable restriction");
  }
  if (intents.includes("reset")) {
    topics.add("reset value restriction");
    topics.add("software reset caution");
  }

  const type = String(moduleType || "").toLowerCase();
  if (type.includes("dma")) {
    topics.add("channel enable disable restriction");
    topics.add("transfer end status clear");
  }

  return [...topics].slice(0, 14);
}

export function sourceReviewChecklistForDriverTask(moduleType, intents) {
  const checklist = [
    "Read the relevant source files directly from the VS Code workspace; this MCP server intentionally does not read source code.",
    "Identify every register offset macro touched by the task and verify it against manual evidence.",
    "Identify every bit macro/mask/shift touched by the task and verify it with extract_bitfield_table/read_pdf_pages evidence.",
    "For each writel/readl/regmap_update_bits path, check sequence evidence and caution evidence before approving code.",
    "For every uncertain hardware detail, mark it explicitly instead of inventing a value.",
  ];

  if (intents.includes("irq") || intents.includes("clear")) {
    checklist.push("Inspect IRQ handler/status-clear path in source and verify write-1-to-clear/write-0-to-clear semantics from manual evidence.");
  }
  if (intents.includes("start")) {
    checklist.push("Inspect start/enable path and verify required ordering: configure registers, clear stale status, enable/start bit, interrupt enable.");
  }
  if (intents.includes("stop")) {
    checklist.push("Inspect terminate/stop/suspend path and verify whether the manual requires disable, wait, clear, or reset steps.");
  }
  if (intents.includes("init")) {
    checklist.push("Inspect probe/init path for MMIO, clocks, reset, IRQ request, runtime PM, and initial register programming.");
  }
  if (intents.includes("reset")) {
    checklist.push("Inspect reset paths and verify software-reset/self-clearing behavior and required wait/poll conditions.");
  }

  const type = String(moduleType || "").toLowerCase();
  if (type.includes("dma")) {
    checklist.push("For dmaengine code, inspect prep/issue_pending/terminate/IRQ/cookie-completion paths and channel stride calculations.");
  } else if (type.includes("watchdog")) {
    checklist.push("For watchdog code, inspect start/stop/ping/set_timeout/restart paths and timeout calculation from clock/prescaler/top fields.");
  } else if (type.includes("pwm") || type.includes("timer")) {
    checklist.push("For PWM/timer code, inspect apply/config/start/stop paths and paired-channel/shared-period constraints.");
  }

  return checklist;
}

export async function resolveTaskRegisters(filename, focusRegisters, task, moduleType, topRegisters) {
  const selected = new Map();

  for (const reg of focusRegisters) {
    const { results } = await searchRegistersIndex(filename, reg, 5);
    for (const result of results) {
      const key = canonicalSymbol(result.name || result.displayName || reg);
      if (!selected.has(key)) selected.set(key, result);
    }
  }

  const { results: allRegisters } = await listRegistersFromIndex(filename, {
    topK: Math.max(topRegisters * 3, DEFAULT_DRIVER_PACK_REGISTERS),
    includeLowConfidence: false,
  });

  const normalizedTask = normalizeForSearch(task);
  const taskTokens = normalizedTask.split(/\s+/).filter((t) => t.length > 2);
  const type = String(moduleType || "").toLowerCase();

  const scored = allRegisters.map((reg) => {
    const name = reg.displayName || reg.name || "";
    const haystack = normalizeForSearch([
      name,
      reg.description || "",
      ...(reg.aliases || []),
      ...(reg.sections || []).map((s) => s.title || ""),
      ...(reg.headings || []),
    ].join("\n"));

    let score = Number(reg.driverPackScore || reg.confidence || 0);
    for (const token of taskTokens) if (haystack.includes(token)) score += 18;

    if (/start|enable|transfer|issue pending/.test(normalizedTask) && /ctrl|control|cfg|config|stat|status|en|enable/.test(haystack)) score += 36;
    if (/stop|disable|terminate|suspend/.test(normalizedTask) && /ctrl|control|stat|status|sus|suspend/.test(haystack)) score += 36;
    if (/clear|irq|interrupt|status|complete|error/.test(normalizedTask) && /stat|status|int|irq|er|err|tc|end|clear/.test(haystack)) score += 42;
    if (/reset|swrst/.test(normalizedTask) && /ctrl|control|reset|rst|swrst/.test(haystack)) score += 35;
    if (/offset|address|stride|map/.test(normalizedTask) && /address|offset|cfg|ctrl|stat|status/.test(haystack)) score += 20;

    if (type.includes("dma")) {
      if (/chctrl|chstat|chcfg|dctrl|dst|n0sa|n0da|n0tb|crsa|crda|crtb/i.test(name)) score += 26;
    } else if (type.includes("watchdog")) {
      if (/wdt|wdtrr|wdtcr|wdtsr|wdtrcr/i.test(name)) score += 30;
    }

    return { ...reg, taskScore: score };
  }).sort((a, b) => Number(b.taskScore || 0) - Number(a.taskScore || 0));

  for (const reg of scored) {
    const key = canonicalSymbol(reg.name || reg.displayName || "");
    if (!key || selected.has(key)) continue;
    selected.set(key, reg);
    if (selected.size >= topRegisters) break;
  }

  return [...selected.values()].slice(0, topRegisters);
}

export async function collectTaskSequenceHints(filename, topics, registers) {
  const hints = [];
  const contextRegisters = registers.slice(0, 5).map((r) => r.displayName || r.name).filter(Boolean);
  let sequencesIndex = null;

  try {
    sequencesIndex = await loadSequencesIndex(filename);
  } catch {}

  if (sequencesIndex?.sequences?.length) {
    const selectedIds = new Set();
    for (const topic of topics) {
      let best = null;
      for (const sequence of sequencesIndex.sequences || []) {
        let matchScore = scoreSequenceEntry(sequence, topic, "");
        const related = new Set((sequence.relatedRegisters || []).map(normalizeRegisterName));
        let matchedRegister = "";
        for (const register of contextRegisters) {
          const regScore = scoreSequenceEntry(sequence, topic, register);
          if (regScore > matchScore) {
            matchScore = regScore;
            matchedRegister = register;
          } else if (!matchedRegister && related.has(normalizeRegisterName(register))) {
            matchedRegister = register;
          }
        }
        if (matchScore <= 0) continue;
        const candidate = { ...sequence, matchScore };
        if (!best || Number(candidate.matchScore || 0) > Number(best.result.matchScore || best.result.score || 0)) {
          best = sequenceToDriverPackItem(candidate, topic, matchedRegister ? [matchedRegister] : contextRegisters);
          best.register = matchedRegister || best.register || "";
        }
      }
      if (best) {
        const key = best.result?.id || `${best.topic}:${best.register}`;
        if (!selectedIds.has(key)) {
          selectedIds.add(key);
          hints.push(best);
        }
      }
      if (hints.length >= MAX_DRIVER_TASK_HINTS) break;
    }
    return hints;
  }

  return hints;
}

export async function collectTaskCautionHints(filename, topics, registers) {
  const hints = [];
  const contextRegisters = registers.slice(0, 6).map((r) => r.displayName || r.name).filter(Boolean);
  let cautionsIndex = null;

  try {
    cautionsIndex = await loadCautionsIndex(filename);
  } catch {}

  if (cautionsIndex?.cautions?.length) {
    const selectedIds = new Set();
    for (const topic of topics) {
      let best = null;
      for (const caution of cautionsIndex.cautions || []) {
        const text = [
          caution.topic,
          caution.type,
          caution.riskForDriver,
          ...(caution.evidenceLines || []),
          ...(caution.relatedRegisters || []),
        ].join("\n");
        let matchScore = (cautionMatchesFilter(caution, topic, "", "") ? 70 : 0) + scoreSimpleText(text, topic) + Math.round(Number(caution.score || 0) / 6);
        const related = new Set((caution.relatedRegisters || []).map(normalizeRegisterName));
        let matchedRegister = "";
        for (const register of contextRegisters) {
          if (related.has(normalizeRegisterName(register))) {
            matchScore += 45;
            matchedRegister ||= register;
          }
        }
        if (matchScore <= 0) continue;
        const candidate = { ...caution, matchScore };
        if (!best || Number(candidate.matchScore || 0) > Number(best.result.matchScore || best.result.score || 0)) {
          best = cautionToDriverPackItem(candidate, topic, matchedRegister ? [matchedRegister] : contextRegisters);
          best.register = matchedRegister || best.register || "";
        }
      }
      if (best) {
        const key = best.result?.id || `${best.topic}:${best.register}`;
        if (!selectedIds.has(key)) {
          selectedIds.add(key);
          hints.push(best);
        }
      }
      if (hints.length >= MAX_DRIVER_TASK_HINTS) break;
    }
    return hints;
  }

  return hints;
}

export async function buildDriverTaskPlan(filename, options = {}) {
  const task = String(options.task || "").trim();
  if (!task) throw new Error("task is required");

  const moduleTypeHint = String(options.moduleType || "").trim();
  const focusRegisters = normalizeStringArray(options.focusRegisters);
  const focusBitfields = normalizeStringArray(options.focusBitfields);
  const topRegisters = clampDriverTaskRegisters(options.topRegisters);
  const mode = normalizeDriverPackMode(options.mode || "adaptive");
  const budget = createDriverPackBudget(options.budgetMs || DEFAULT_DRIVER_TASK_BUDGET_MS);
  const skippedPhases = [];
  const fingerprint = sourceFingerprint(await getPdfSourceInfo(filename));

  await loadPdfIndex(filename);
  const profile = await getModuleProfile(filename, {
    moduleType: moduleTypeHint,
    focus: task,
    refresh: false,
  });
  const moduleType = moduleTypeHint || profile.moduleType || inferModuleType(filename, [], [], moduleTypeHint);
  const workflowSubsystem = normalizeDriverSubsystemHint(moduleType);
  const workflowFamily = normalizeDriverFamilyHint(moduleTypeHint);
  let workflowProfile = null;
  let workflowProfileWarnings = [];
  try {
    const resolvedWorkflowProfile = await resolveDriverProfile({
      subsystem: workflowSubsystem,
      driverFamily: workflowFamily,
      createDefault: true,
    });
    workflowProfile = resolvedWorkflowProfile.profile;
    workflowProfileWarnings = resolvedWorkflowProfile.warnings || [];
  } catch (error) {
    workflowProfileWarnings = [`driver profile unavailable: ${error instanceof Error ? error.message : String(error)}`];
  }
  const intents = inferDriverTaskIntents(task, moduleType);
  const taskRegisters = await resolveTaskRegisters(filename, focusRegisters, task, moduleType, topRegisters);
  const sequenceTopics = sequenceTopicsForDriverTask(task, moduleType, intents, workflowProfile);
  const cautionTopics = cautionTopicsForDriverTask(task, moduleType, intents, workflowProfile);
  const sequenceHints = budget.hasTime(2500)
    ? await collectTaskSequenceHints(filename, sequenceTopics, taskRegisters)
    : [];
  if (!sequenceHints.length && !budget.hasTime(2500)) skippedPhases.push("sequence hints skipped: budget exhausted");
  const cautionHints = budget.hasTime(2500)
    ? await collectTaskCautionHints(filename, cautionTopics, taskRegisters)
    : [];
  if (!cautionHints.length && !budget.hasTime(2500)) skippedPhases.push("caution hints skipped: budget exhausted");

  return {
    filename,
    sourceFingerprint: fingerprint,
    createdAt: new Date().toISOString(),
    task,
    mode,
    budget: budget.snapshot(),
    skippedPhases,
    performanceNote: "Task plan uses persistent register/sequence/caution indexes first and avoids full-manual dynamic fallback by default.",
    moduleType,
    moduleTypeHint,
    linuxSubsystem: likelyLinuxSubsystem(workflowSubsystem || moduleType),
    intents,
    focusRegisters,
    focusBitfields,
    taskRegisters,
    sequenceTopics,
    cautionTopics,
    sequenceHints,
    cautionHints,
    profile,
    workflowProfile,
    workflowProfileWarnings,
    sourceChecklist: mergeUniqueStrings(
      sourceReviewChecklistForDriverTask(moduleType, intents),
      workflowProfile?.source_review_steps || [],
      flattenChecklistRequirements(workflowProfile || {}).slice(0, MAX_DRIVER_TASK_HINTS).map((row) => `${row.area}: ${row.item}`),
    ),
  };
}


export function normalizeRegisterUsageAccessType(value, operation = "") {
  const raw = String(value || "auto").trim().toLowerCase();
  if (raw && raw !== "auto") return raw;

  const text = normalizeForSearch(operation);
  if (/read\s*modify\s*write|rmw|update_bits|regmap_update_bits|set_bits|clear_bits/.test(text)) return "read_modify_write";
  if (/write[_\s-]?1|write\s+one|w1c/.test(text)) return "write_one_to_clear";
  if (/write[_\s-]?0|write\s+zero|w0c/.test(text)) return "write_zero_to_clear";
  if (/poll|wait|readl_poll|read_poll/.test(text)) return "poll";
  if (/readl|ioread|regmap_read|read register/.test(text) && !/writel|iowrite|write/.test(text)) return "read";
  if (/writel|iowrite|regmap_write|write register|raw write/.test(text)) return "raw_write";
  if (/reset|swrst/.test(text)) return "reset";
  if (/clear/.test(text)) return "clear_bits";
  return "write";
}

export function inferRegisterUsageIntent(operation, accessType = "auto", explicitIntent = "auto") {
  const forced = String(explicitIntent || "auto").trim().toLowerCase();
  if (forced && forced !== "auto") return forced;

  const text = normalizeForSearch(`${operation} ${accessType}`);
  if (/init|initial|setup|configure|configuration|clock|reset release/.test(text)) return "init";
  if (/start|enable|run|activate|tx enable|rx enable|transmit|receive|seten/.test(text)) return "start";
  if (/stop|disable|halt|terminate|suspend|abort/.test(text)) return "stop";
  if (/clear|ack|acknowledge|w1c|w0c|write one|write zero|status flag/.test(text)) return "clear";
  if (/irq|interrupt|isr/.test(text)) return "irq";
  if (/reset|swrst|software reset/.test(text)) return "reset";
  if (/error|fault|err|abnormal/.test(text)) return "error";
  if (/status|poll|wait|read/.test(text)) return "status";
  if (/write/.test(text)) return "write";
  return "configure";
}

export function registerUsageOperationTopic(operation, register, intent) {
  const op = String(operation || "").trim();
  const reg = String(register || "").trim();
  const intentText = String(intent || "").trim();
  return [op, reg, intentText].filter(Boolean).join(" ");
}

export function bitfieldMatchesRequested(row, requested) {
  const canonicalRequested = canonicalSymbol(requested);
  const canonicalName = canonicalSymbol(row.bitfield || row.name || "");
  if (!canonicalRequested || !canonicalName) return false;
  return canonicalRequested === canonicalName || canonicalName.includes(canonicalRequested) || canonicalRequested.includes(canonicalName);
}

export function exactRegisterContextMatches(registerResults, rawRegister) {
  const target = normalizeRegisterName(rawRegister);
  if (!target) return registerResults || [];
  const matches = (registerResults || []).filter((entry) => {
    const names = [entry.name, entry.displayName, entry.canonicalName]
      .map(normalizeRegisterName)
      .filter(Boolean);
    return names.some((name) => name === target || name.endsWith(target) || target.endsWith(name) && name.length >= Math.max(4, target.length - 2));
  });
  return matches.length ? matches : (registerResults || []);
}

export function assessBitfieldEvidence(requestedBitfields, bitfieldRows) {
  const rows = bitfieldRows || [];
  return (requestedBitfields || []).map((name) => {
    const match = rows.find((row) => bitfieldMatchesRequested(row, name));
    if (!match) {
      return {
        name,
        status: "not_found",
        confidence: "low",
        needsVerification: makeNeedsVerification({
          item: `${name} bit-field evidence`,
          reason: "Requested/source bit-field was not found in extracted bitfield table candidates.",
          suggestedTools: ["find_bitfield(...)", "read_pdf_pages(...)"],
        }),
      };
    }

    const missing = [];
    if (!match.bitRange || match.bitRange === "unknown") missing.push("bit/range");
    if (!match.access || match.access === "unknown") missing.push("access");
    if (!match.reset || match.reset === "unknown") missing.push("reset");

    return {
      name,
      status: missing.length ? "partial" : "found",
      confidence: confidenceLevel(match.confidence || 0),
      row: match,
      missing,
      needsVerification: missing.length ? makeNeedsVerification({
        item: `${name} ${missing.join("/")}`,
        reason: `Bit-field row was found but missing ${missing.join(", ")}.`,
        suggestedTools: ["extract_bitfield_table(...)", "read_pdf_pages(...)", "read_pdf_chunk(...)"],
      }) : null,
    };
  });
}

export function cautionEvidenceIndicates(cautions, patterns) {
  const text = (cautions || []).map((c) => [
    c.topic,
    c.type,
    c.riskForDriver,
    ...(c.evidenceLines || []),
  ].join("\n")).join("\n");
  return patterns.some((pattern) => pattern.test(text));
}

export function buildRegisterUsageAssessment(input, parts) {
  const accessType = input.accessType;
  const intent = input.intent;
  const cautions = parts.cautions?.results || [];
  const bitfieldAssessment = parts.bitfieldAssessment || [];
  const sequenceResult = parts.sequence;
  const needsVerification = [];
  const warnings = [];
  const recommendations = [];

  if (!parts.registerSummary?.registerEntry) {
    needsVerification.push(makeNeedsVerification({
      item: `${input.register} register identity`,
      reason: "Register was not strongly matched in the register index.",
      suggestedTools: [`find_register(filename="${input.filename}", register="${input.register}")`, `hybrid_search_pdf(filename="${input.filename}", query="${input.register} register offset", intent="register")`],
    }));
  }

  for (const item of bitfieldAssessment) {
    if (item.needsVerification) needsVerification.push(item.needsVerification);
  }

  const hasReservedWarning = cautionEvidenceIndicates(cautions, [/reserved/i, /do\s+not\s+write/i, /write\s+0/i, /write\s+1/i]);
  const hasClearSemantics = cautionEvidenceIndicates(cautions, [/write\s*-?1/i, /write\s+one/i, /w1c/i, /write\s*-?0/i, /write\s+zero/i, /w0c/i, /clear/i]);
  const hasTimingRestriction = cautionEvidenceIndicates(cautions, [/only\s+when/i, /while\s+stopped/i, /must\s+be\s+stopped/i, /before/i, /after/i]);

  if (["raw_write", "write", "set_bits", "clear_bits"].includes(accessType) && !hasReservedWarning) {
    needsVerification.push(makeNeedsVerification({
      item: "reserved-bit preservation",
      reason: "No explicit reserved-bit/RMW caution was found for this register operation. Raw writes may still be unsafe for hardware registers.",
      suggestedTools: [`get_cautions_for_register(filename="${input.filename}", register="${input.register}", filter="reserved bits")`, `read_pdf_pages(...)`],
    }));
  }

  if (["raw_write", "write"].includes(accessType) && input.bitfields.length) {
    warnings.push("Raw write with bitfield intent: verify whether read-modify-write is required to preserve unrelated/reserved bits.");
    recommendations.push("Prefer read-modify-write/update_bits if manual requires preserving reserved or unrelated bits.");
  }

  if ((intent === "clear" || accessType === "write_one_to_clear" || accessType === "write_zero_to_clear") && !hasClearSemantics) {
    needsVerification.push(makeNeedsVerification({
      item: "status clear semantics",
      reason: "Operation appears to clear status/IRQ flags, but W1C/W0C/clear semantics were not proven from caution/sequence evidence.",
      suggestedTools: [`get_sequence(filename="${input.filename}", topic="clear status", register="${input.register}")`, `get_cautions_for_register(filename="${input.filename}", register="${input.register}", filter="clear status")`],
    }));
  }

  if (["start", "stop", "reset", "init", "irq", "error"].includes(intent) && !sequenceResult?.persistentMatches?.length && !sequenceResult?.fallback?.results?.length) {
    needsVerification.push(makeNeedsVerification({
      item: `${intent} operation ordering`,
      reason: "No strong sequence evidence was found for the requested operation/register context.",
      suggestedTools: [`get_sequence(filename="${input.filename}", topic="${intent} operation", register="${input.register}")`, `hybrid_search_pdf(filename="${input.filename}", query="${input.operation}", register="${input.register}", intent="${intent}")`],
    }));
  }

  if (hasTimingRestriction) warnings.push("Timing/order restriction evidence exists. Verify source-code ordering around this register write.");

  const severity = needsVerification.length ? "needs_verification" : warnings.length ? "review_required" : "likely_ok";
  return { severity, warnings, recommendations, needsVerification };
}

export async function verifyRegisterUsage(filename, options = {}) {
  const register = String(options.register || "").trim();
  const operation = String(options.operation || "").trim();
  if (!register) throw new Error("register is required");
  if (!operation) throw new Error("operation is required");

  const bitfields = normalizeStringArray(options.bitfields);
  const accessType = normalizeRegisterUsageAccessType(options.accessType, `${operation}\n${options.sourceSnippet || ""}`);
  const intent = inferRegisterUsageIntent(`${operation}\n${options.sourceSnippet || ""}`, accessType, options.intent || "auto");
  const topK = clampTopK(options.topK);
  const topic = registerUsageOperationTopic(operation, register, intent);
  const includeHybrid = Boolean(options.includeHybrid);
  const budget = createDriverPackBudget(options.budgetMs || DEFAULT_DRIVER_TASK_BUDGET_MS);
  const skippedPhases = [];

  const result = {
    filename,
    register,
    operation,
    accessType,
    intent,
    bitfields,
    sourceSnippet: String(options.sourceSnippet || "").slice(0, 2000),
    includeHybrid,
    budget: null,
    skippedPhases,
    parts: {},
    assessment: null,
  };

  try {
    result.parts.registerSummary = await summarizeRegister(filename, register, {
      topK: Math.min(4, topK),
      includeBitfieldEvidence: true,
    });
  } catch (error) {
    result.parts.registerSummaryError = error instanceof Error ? error.message : String(error);
  }

  try {
    result.parts.bitfieldTable = await extractBitfieldTable(filename, register, {
      topK: Math.min(24, Math.max(topK, bitfields.length * 4 || topK)),
    });
    result.parts.bitfieldAssessment = assessBitfieldEvidence(bitfields, result.parts.bitfieldTable.rows || []);
  } catch (error) {
    result.parts.bitfieldTableError = error instanceof Error ? error.message : String(error);
    result.parts.bitfieldAssessment = bitfields.map((name) => ({
      name,
      status: "error",
      confidence: "low",
      needsVerification: makeNeedsVerification({
        item: `${name} bit-field evidence`,
        reason: result.parts.bitfieldTableError,
        suggestedTools: ["find_bitfield(...)", "read_pdf_pages(...)"],
      }),
    }));
  }

  try {
    result.parts.cautions = await getCautionsForRegister(filename, register, {
      filter: `${operation} ${intent} reserved bits clear status write timing`,
      topK: Math.min(8, topK),
      allowFallback: false,
    });
  } catch (error) {
    result.parts.cautionsError = error instanceof Error ? error.message : String(error);
  }

  try {
    result.parts.sequence = await getSequenceFromIndex(filename, topic, {
      register,
      topK: Math.min(5, topK),
      allowFallback: false,
    });
  } catch (error) {
    result.parts.sequenceError = error instanceof Error ? error.message : String(error);
  }

  if (includeHybrid && budget.hasTime(8000)) {
    try {
      result.parts.hybrid = await hybridSearchPdf(filename, topic, {
        register,
        intent,
        topK: Math.min(5, topK),
      });
    } catch (error) {
      result.parts.hybridError = error instanceof Error ? error.message : String(error);
    }
  } else {
    skippedPhases.push(includeHybrid ? "hybrid search skipped: budget exhausted" : "hybrid search skipped: include_hybrid=false");
  }

  result.assessment = buildRegisterUsageAssessment({
    filename,
    register,
    operation,
    accessType,
    intent,
    bitfields,
  }, {
    registerSummary: result.parts.registerSummary,
    bitfieldAssessment: result.parts.bitfieldAssessment,
    cautions: result.parts.cautions,
    sequence: result.parts.sequence,
  });
  result.budget = budget.snapshot();

  return result;
}

export function buildRegisterUsageEvidenceContract(result) {
  const evidence = [];
  const inference = [];
  const needsVerification = [...(result.assessment?.needsVerification || [])];
  const warnings = [...(result.assessment?.warnings || [])];

  const entry = result.parts.registerSummary?.registerEntry;
  if (entry) {
    evidence.push(makeEvidence({
      source: "register-index",
      evidenceType: "register-table",
      page: (entry.pages || [])[0],
      chunkId: (entry.chunks || [])[0]?.id || null,
      quote: `${entry.displayName || entry.name}: offset=${(entry.offsetAddresses || []).join(" | ") || "unknown"}, initial=${(entry.initialValues || []).join(" | ") || "unknown"}, accessSize=${(entry.accessSizes || []).join(" | ") || "unknown"}`,
      confidence: entry.confidence || "medium",
      name: entry.displayName || entry.name,
      field: "register",
      tool: "verify_register_usage",
    }));
  }

  for (const item of result.parts.bitfieldAssessment || []) {
    if (item.row) {
      evidence.push(makeEvidence({
        source: "bitfield-table",
        evidenceType: "bitfield-table",
        page: (item.row.pages || [])[0],
        chunkId: (item.row.chunks || [])[0] || null,
        quote: (item.row.evidenceLines || [])[0] || `${item.name}: bit=${item.row.bitRange || "unknown"}, access=${item.row.access || "unknown"}, reset=${item.row.reset || "unknown"}`,
        confidence: item.row.confidence || item.confidence,
        name: item.name,
        field: "bitfield",
        tool: "verify_register_usage",
      }));
    }
  }

  for (const caution of (result.parts.cautions?.results || []).slice(0, 6)) {
    evidence.push(makeEvidence({
      source: "caution-index",
      evidenceType: "caution",
      page: (caution.pages || [])[0],
      chunkId: (caution.chunks || [])[0]?.id || null,
      quote: (caution.evidenceLines || [])[0] || caution.riskForDriver || caution.topic,
      confidence: caution.confidence || caution.score || "medium",
      name: caution.topic,
      field: caution.type,
      tool: "verify_register_usage",
    }));
  }

  for (const sequence of (result.parts.sequence?.persistentMatches || []).slice(0, 4)) {
    evidence.push(makeEvidence({
      source: "sequence-index",
      evidenceType: "procedure",
      page: (sequence.pages || [])[0],
      chunkId: (sequence.chunks || [])[0]?.id || null,
      quote: (sequence.evidenceLines || [])[0] || sequence.topic,
      confidence: sequence.matchScore || sequence.score || "medium",
      name: sequence.topic,
      tool: "verify_register_usage",
    }));
  }

  for (const chunk of (result.parts.hybrid?.results || []).slice(0, 3)) {
    evidence.push(evidenceFromChunk(chunk, (chunk.hybridEvidenceLines || [])[0] || chunk.text || "", {
      tool: "verify_register_usage",
      confidence: chunk.score || "medium",
      name: result.register,
    }));
  }

  inference.push(makeInference({
    statement: `Operation classified as intent=${result.intent}, accessType=${result.accessType}, assessment=${result.assessment?.severity || "unknown"}`,
    basis: result.operation,
    confidence: "medium",
    risk: "Intent/access classification is heuristic from the source-code operation summary.",
  }));

  return makeEvidenceContract({
    tool: "verify_register_usage",
    filename: result.filename,
    query: `${result.register}: ${result.operation}`,
    evidence,
    inference,
    needsVerification,
    warnings,
    recommendedNextTools: [
      `summarize_register(filename="${result.filename}", register="${result.register}")`,
      `extract_bitfield_table(filename="${result.filename}", register="${result.register}")`,
      `get_cautions_for_register(filename="${result.filename}", register="${result.register}")`,
      `get_sequence(filename="${result.filename}", topic="${result.intent} operation", register="${result.register}")`,
    ],
  });
}

export function formatVerifyRegisterUsage(result) {
  const lines = [];
  const summary = result.parts.registerSummary;
  const entry = summary?.registerEntry;
  const assessment = result.assessment || {};

  lines.push("Register Usage Verification");
  lines.push(`File: ${result.filename}`);
  lines.push(`Register: ${result.register}`);
  lines.push(`Operation: ${result.operation}`);
  lines.push(`Access type: ${result.accessType}`);
  lines.push(`Intent: ${result.intent}`);
  lines.push(`Hybrid fallback: ${result.includeHybrid ? "enabled" : "disabled"}`);
  if (result.budget) lines.push(`Budget: ${result.budget.elapsedMs} ms elapsed / ${result.budget.timeBudgetMs} ms budget / ${result.budget.remainingMs} ms remaining`);
  if ((result.skippedPhases || []).length) lines.push(`Skipped phases: ${result.skippedPhases.join("; ")}`);
  if (result.sourceSnippet) lines.push(`Source snippet: ${compactText(result.sourceSnippet, 500)}`);
  lines.push(`Assessment: ${assessment.severity || "unknown"}`);
  lines.push("");

  lines.push("1. Register evidence");
  if (entry) {
    lines.push(`- Match: ${entry.displayName || entry.name}`);
    lines.push(`- Description: ${(entry.descriptions || []).join(" | ") || "unknown"}`);
    lines.push(`- Offset: ${(entry.offsetAddresses || []).join(" | ") || "unknown"}`);
    lines.push(`- Initial/reset: ${(entry.initialValues || []).join(" | ") || "unknown"}`);
    lines.push(`- Access size: ${(entry.accessSizes || []).join(" | ") || "unknown"}`);
    lines.push(`- Pages: ${(entry.pages || []).join(", ") || "unknown"}`);
    lines.push(`- Reliability: ${summary.reliability || "unknown"}`);
  } else {
    lines.push("- Register index match: none or uncertain");
    if (result.parts.registerSummaryError) lines.push(`- Error: ${result.parts.registerSummaryError}`);
  }
  lines.push("");

  lines.push("2. Requested/source bit-field checks");
  if (result.bitfields.length) {
    for (const item of result.parts.bitfieldAssessment || []) {
      lines.push(`- ${item.name}: ${item.status}, confidence=${item.confidence}${item.missing?.length ? `, missing=${item.missing.join(", ")}` : ""}`);
      if (item.row) {
        lines.push(`  bit/range=${item.row.bitRange || "unknown"}, access=${item.row.access || "unknown"}, reset=${item.row.reset || "unknown"}, pages=${(item.row.pages || []).join(", ") || "unknown"}`);
      }
    }
  } else {
    lines.push("- No bitfields were provided by the source-code agent. Suggested: pass source macro names in bitfields=[...].");
  }
  if (result.parts.bitfieldTableError) lines.push(`- Bitfield table error: ${result.parts.bitfieldTableError}`);
  lines.push("");

  lines.push("3. Sequence / operation-order evidence");
  if (result.parts.sequence?.persistentMatches?.length) {
    for (const seq of result.parts.sequence.persistentMatches.slice(0, 4)) {
      lines.push(`- ${seq.topic}: pages ${(seq.pages || []).join(", ") || "unknown"}, score=${seq.matchScore || seq.score || "unknown"}`);
      for (const ev of (seq.evidenceLines || []).slice(0, 2)) lines.push(`  evidence: ${ev}`);
    }
  } else if (result.parts.sequence?.fallback) {
    lines.push("- No strong persistent sequence match; dynamic fallback exists. Inspect get_sequence output if needed.");
  } else {
    lines.push("- No strong sequence evidence found.");
    if (result.parts.sequenceError) lines.push(`- Error: ${result.parts.sequenceError}`);
  }
  lines.push("");

  lines.push("4. Caution / restriction evidence");
  if (result.parts.cautions?.results?.length) {
    for (const caution of result.parts.cautions.results.slice(0, 6)) {
      lines.push(`- ${caution.topic} [${caution.type || "general"}]: pages ${(caution.pages || []).join(", ") || "unknown"}, confidence=${caution.confidence}`);
      lines.push(`  risk: ${caution.riskForDriver || "review required"}`);
      for (const ev of (caution.evidenceLines || []).slice(0, 2)) lines.push(`  evidence: ${ev}`);
    }
  } else {
    lines.push("- No persistent caution evidence found for this register/operation.");
    if (result.parts.cautionsError) lines.push(`- Error: ${result.parts.cautionsError}`);
  }
  lines.push("");

  lines.push("5. Risks / warnings");
  if (assessment.warnings?.length) {
    for (const warning of assessment.warnings) lines.push(`- ${warning}`);
  } else {
    lines.push("- No explicit warnings from heuristic assessment.");
  }
  if (assessment.recommendations?.length) {
    lines.push("Recommendations:");
    for (const rec of assessment.recommendations) lines.push(`- ${rec}`);
  }
  lines.push("");

  lines.push("6. Needs verification before patch approval");
  if (assessment.needsVerification?.length) {
    for (const item of assessment.needsVerification) {
      lines.push(`- ${item.item}: ${item.reason}`);
      for (const tool of item.suggestedTools || []) lines.push(`  suggested: ${tool}`);
    }
  } else {
    lines.push("- None from heuristic assessment. Still verify exact source-code context before merging.");
  }

  return appendEvidenceContract(lines.join("\n"), buildRegisterUsageEvidenceContract(result));
}

export function buildDriverTaskPlanEvidenceContract(plan) {
  const evidence = [];
  for (const item of (plan.sequenceHints || []).slice(0, 8)) {
    const r = item.result || {};
    const quote = (r.sequenceEvidence || r.evidenceLines || [])[0] || r.preview || "";
    evidence.push(makeEvidence({ source: "sequence-index", evidenceType: "procedure", page: r.page, chunkId: r.id || null, quote, confidence: r.score || r.matchScore || "medium", name: item.topic, tool: "prepare_driver_task" }));
  }
  for (const item of (plan.cautionHints || []).slice(0, 8)) {
    const r = item.result || {};
    const quote = (r.cautionEvidence || r.evidenceLines || [])[0] || r.riskForDriver || "";
    evidence.push(makeEvidence({ source: "caution-index", evidenceType: "caution", page: r.page || (r.pages || [])[0], chunkId: (r.chunks || [])[0]?.id || null, quote, confidence: r.score || r.matchScore || r.confidence || "medium", name: item.topic, tool: "prepare_driver_task" }));
  }
  const inference = [
    makeInference({ statement: `Task intents inferred as: ${(plan.intents || []).join(", ")}`, basis: plan.task, confidence: "medium", risk: "Intent classification drives workflow only; it is not manual evidence." }),
    makeInference({ statement: `Task-related registers selected: ${(plan.taskRegisters || []).slice(0, 12).map((r) => r.displayName || r.name).join(", ") || "none"}`, basis: "register index + task keyword scoring", confidence: "medium", risk: "Selected registers are candidates; verify source usage and manual summaries." }),
  ];
  const needsVerification = [makeNeedsVerification({
    item: "All source-code register writes related to this task",
    reason: "prepare_driver_task does not read source code; the VS Code agent must inspect source and map each writel/readl/regmap operation to manual evidence.",
    suggestedTools: ["summarize_register(...) for each source register macro", "extract_bitfield_table(...) for each bit/mask macro", "get_sequence(...) for operation order", "get_cautions_for_register(...) for write restrictions"],
  })];
  return makeEvidenceContract({
    tool: "prepare_driver_task",
    filename: plan.filename,
    sourceFingerprint: plan.sourceFingerprint,
    query: plan.task,
    evidence,
    inference,
    needsVerification,
    warnings: ["This is a workflow plan, not proof that source code is correct."],
    recommendedNextTools: [`build_driver_evidence_pack(filename="${plan.filename}", module_type="${plan.moduleType}", focus="${plan.task.replace(/"/g, "'")}")`, `hybrid_search_pdf(filename="${plan.filename}", query="${plan.task.replace(/"/g, "'")}", intent="auto")`],
  });
}

export function formatDriverTaskPlan(plan) {
  const lines = [];
  const filename = plan.filename;

  lines.push("Driver Task Preparation Plan");
  lines.push(`File: ${filename}`);
  lines.push(`Created: ${plan.createdAt}`);
  lines.push(`Task: ${plan.task}`);
  lines.push("");

  lines.push("1. Module context");
  lines.push(`- Inferred module type: ${plan.moduleType}`);
  if (plan.moduleTypeHint) lines.push(`- User module type hint: ${plan.moduleTypeHint}`);
  lines.push(`- Likely Linux subsystem: ${plan.linuxSubsystem}`);
  if (plan.workflowProfile) {
    lines.push(`- Selected driver workflow profile: ${plan.workflowProfile.profile || "unknown"}`);
    lines.push(`- Driver profile stack: ${(plan.workflowProfile._profileStack || []).join(" -> ") || plan.workflowProfile.profile || "unknown"}`);
    if ((plan.workflowProfile._fragmentStack || []).length) lines.push(`- Driver profile fragments: ${plan.workflowProfile._fragmentStack.join(", ")}`);
  }
  for (const warning of plan.workflowProfileWarnings || []) lines.push(`- Driver profile warning: ${warning}`);
  lines.push(`- Detected task intents: ${plan.intents.join(", ")}`);
  lines.push(`- Evidence collection mode: ${plan.mode || "adaptive"}`);
  if (plan.budget) lines.push(`- Budget: ${plan.budget.elapsedMs} ms elapsed / ${plan.budget.timeBudgetMs} ms budget / ${plan.budget.remainingMs} ms remaining`);
  if (plan.performanceNote) lines.push(`- Performance note: ${plan.performanceNote}`);
  if ((plan.skippedPhases || []).length) lines.push(`- Skipped phases: ${plan.skippedPhases.join("; ")}`);
  lines.push(`- Source-code context: read directly from VS Code workspace; this MCP server is manual-only.`);
  lines.push("");

  lines.push("2. Mandatory MCP call sequence before editing source");
  lines.push(`- get_module_profile(filename="${filename}"${plan.moduleTypeHint ? `, module_type="${plan.moduleTypeHint}"` : ""})`);
  if (plan.workflowProfile) lines.push(`- source_review_prompt_pack(filename="${filename}", subsystem="${normalizeDriverSubsystemHint(plan.moduleType)}", driver_family="${normalizeDriverFamilyHint(plan.moduleTypeHint)}", profile="${plan.workflowProfile.profile || ""}", task="${plan.task.replace(/"/g, "'")}")`);
  lines.push(`- build_driver_evidence_pack(filename="${filename}"${plan.moduleTypeHint ? `, module_type="${plan.moduleTypeHint}"` : ""}, focus="${plan.task.replace(/"/g, "'")}")`);
  lines.push(`- hybrid_search_pdf(filename="${filename}", query="${plan.task.replace(/"/g, "'")}", intent="auto")`);
  if (plan.intents.includes("register-map")) lines.push(`- extract_register_table(filename="${filename}")`);
  lines.push("");

  lines.push("3. Task-related registers to verify");
  if ((plan.taskRegisters || []).length) {
    for (const [index, reg] of plan.taskRegisters.entries()) {
      const name = reg.displayName || reg.name;
      const pages = (reg.pages || []).slice(0, 8).join(", ") || "unknown";
      const desc = reg.description ? ` — ${reg.description}` : "";
      lines.push(`${index + 1}. ${name}${desc}`);
      lines.push(`   Pages: ${pages}; confidence: ${reg.confidence || "unknown"}; task score: ${reg.taskScore || "n/a"}`);
      lines.push(`   Required calls:`);
      lines.push(`   - summarize_register(filename="${filename}", register="${name}")`);
      lines.push(`   - extract_bitfield_table(filename="${filename}", register="${name}")`);
      lines.push(`   - get_cautions_for_register(filename="${filename}", register="${name}")`);
    }
  } else {
    lines.push("- No task-related registers selected. Use list_registers and hybrid_search_pdf to discover candidates.");
  }
  lines.push("");

  lines.push("4. Focus bit fields to verify");
  if ((plan.focusBitfields || []).length) {
    const regs = (plan.taskRegisters || []).slice(0, 6).map((r) => r.displayName || r.name).filter(Boolean);
    for (const field of plan.focusBitfields) {
      if (regs.length) {
        for (const reg of regs.slice(0, 4)) lines.push(`- find_bitfield(filename="${filename}", register="${reg}", bitfield="${field}")`);
      } else {
        lines.push(`- find_bitfield(filename="${filename}", bitfield="${field}")`);
      }
    }
  } else {
    lines.push("- No explicit focus bit fields provided. Extract bitfield tables for task-related registers and verify source macros from the VS Code workspace.");
  }
  lines.push("");

  lines.push("5. Operation/sequence evidence to collect");
  for (const topic of plan.sequenceTopics) lines.push(`- get_sequence(filename="${filename}", topic="${topic}")`);
  if ((plan.sequenceHints || []).length) {
    lines.push("\nBest current sequence hints:");
    for (const item of plan.sequenceHints.slice(0, 8)) {
      const r = item.result || {};
      lines.push(`- ${item.topic}${item.register ? ` [${item.register}]` : ""}: page ${r.page || "?"}, score ${r.score || r.matchScore || "?"}`);
      for (const ev of (r.sequenceEvidence || r.evidenceLines || []).slice(0, 2)) lines.push(`  evidence: ${ev}`);
    }
  }
  lines.push("");

  lines.push("6. Caution/restriction evidence to collect");
  for (const topic of plan.cautionTopics) lines.push(`- list_cautions(filename="${filename}", filter="${topic}")`);
  if ((plan.taskRegisters || []).length) {
    for (const reg of plan.taskRegisters.slice(0, 6)) {
      const name = reg.displayName || reg.name;
      lines.push(`- get_cautions_for_register(filename="${filename}", register="${name}")`);
    }
  }
  if ((plan.cautionHints || []).length) {
    lines.push("\nBest current caution hints:");
    for (const item of plan.cautionHints.slice(0, 10)) {
      const r = item.result || {};
      lines.push(`- ${item.topic}${item.register ? ` [${item.register}]` : ""}: page ${r.page || "?"}, type ${r.type || "unknown"}, score ${r.score || r.matchScore || "?"}`);
      for (const ev of (r.cautionEvidence || r.evidenceLines || []).slice(0, 2)) lines.push(`  evidence: ${ev}`);
    }
  }
  lines.push("");

  lines.push("7. Required source-code checks for the VS Code agent");
  for (const item of plan.sourceChecklist || []) lines.push(`- ${item}`);
  lines.push("");

  lines.push("8. Approval rule before producing a patch");
  lines.push("- Do not approve or generate register/bit macros unless offsets and bit positions are backed by extract_register_table/extract_bitfield_table/read_pdf_pages evidence.");
  lines.push("- Do not approve status clear or interrupt code unless clear semantics are backed by get_sequence/get_cautions_for_register/read_pdf_pages evidence.");
  lines.push("- Do not approve start/stop/reset paths unless operation ordering is backed by list_sequences/get_sequence evidence.");
  lines.push("- If evidence is incomplete, mark the item as uncertain and ask the developer to verify the exact manual page/table.");

  const text = lines.join("\n");
  return appendEvidenceContract(text, buildDriverTaskPlanEvidenceContract(plan));
}

export function buildDriverEvidencePackContract(pack) {
  const evidence = [];
  for (const reg of (pack.keyRegisters || []).slice(0, 8)) {
    evidence.push(makeEvidence({
      source: "register-index",
      evidenceType: "register-summary",
      page: (reg.pages || [])[0],
      quote: [reg.displayName || reg.name, reg.description || "", reg.offsetAddress || "", reg.accessSize || ""].filter(Boolean).join(" "),
      confidence: reg.confidence || reg.driverPackScore || "medium",
      name: reg.displayName || reg.name,
      tool: "build_driver_evidence_pack",
    }));
  }
  for (const field of (pack.bitfields || []).slice(0, 8)) {
    evidence.push(makeEvidence({
      source: "bitfield-index",
      evidenceType: "bitfield-table",
      page: (field.pages || [])[0],
      chunkId: (field.chunks || [])[0] || null,
      quote: (field.evidence || [])[0] || `${field.register || "unknown"}.${field.name}`,
      confidence: field.confidence || "medium",
      name: field.name,
      field: field.register || "",
      tool: "build_driver_evidence_pack",
    }));
  }
  for (const item of (pack.sequences || []).slice(0, 6)) {
    const r = item.result || {};
    evidence.push(makeEvidence({
      source: "sequence-index",
      evidenceType: "procedure",
      page: r.page,
      chunkId: r.id,
      quote: (r.sequenceEvidence || [])[0] || item.topic,
      confidence: r.score || "medium",
      name: item.topic,
      tool: "build_driver_evidence_pack",
    }));
  }
  for (const item of (pack.cautions || []).slice(0, 6)) {
    const r = item.result || {};
    evidence.push(makeEvidence({
      source: "caution-index",
      evidenceType: "caution",
      page: r.page,
      chunkId: r.id,
      quote: (r.cautionEvidence || [])[0] || item.topic,
      confidence: r.score || "medium",
      name: item.topic,
      tool: "build_driver_evidence_pack",
    }));
  }

  const inference = [
    makeInference({
      statement: `Module type inferred as ${pack.moduleType}`,
      basis: `register groups, section matches, user hint, selected profile=${pack.workflowProfile?.profile || "none"}`,
      confidence: pack.moduleTypeHint ? "medium" : "low",
      risk: "Module identity drives workflow suggestions only; verify against source and manual chapter title.",
    }),
  ];

  const needsVerification = [
    makeNeedsVerification({
      item: "All register offsets, bit positions, and write semantics used in source code",
      reason: "The driver evidence pack collects candidates; final source changes require exact page/table verification.",
      suggestedTools: ["summarize_register(...)", "extract_bitfield_table(...)", "get_sequence(...)", "get_cautions_for_register(...)", "verify_register_usage(...)"],
    }),
  ];

  return makeEvidenceContract({
    tool: "build_driver_evidence_pack",
    filename: pack.filename,
    sourceFingerprint: pack.sourceFingerprint,
    query: pack.focus || pack.moduleType || "driver evidence pack",
    evidence,
    inference,
    needsVerification,
    warnings: [
      "Search-ranked and index-derived evidence is not final proof for driver-critical constants.",
      ...(pack.partialWarnings || []),
    ],
    recommendedNextTools: [
      `source_review_prompt_pack(filename="${pack.filename}", subsystem="${pack.moduleType}")`,
      `verify_register_usage(filename="${pack.filename}", register="<source register>", operation="<source operation>")`,
      `read_pdf_pages(filename="${pack.filename}", start_page=<page>, end_page=<page>)`,
    ],
  });
}

export function formatDriverEvidencePack(pack) {
  const lines = [];
  const filename = pack.filename;

  lines.push(`Driver Evidence Pack`);
  lines.push(`File: ${filename}`);
  lines.push(`Created: ${pack.createdAt}`);
  lines.push(`Build mode: ${pack.mode || "adaptive"}`);
  if (pack.requestedMode && pack.requestedMode !== pack.mode) lines.push(`Requested mode: ${pack.requestedMode}`);
  if (pack.budget) lines.push(`Budget: ${pack.budget.elapsedMs} ms elapsed / ${pack.budget.timeBudgetMs} ms budget / ${pack.budget.remainingMs} ms remaining`);
  lines.push(`Partial result: ${pack.partial ? "yes" : "no"}`);
  if (pack.performanceNote) lines.push(`Performance note: ${pack.performanceNote}`);
  if (pack.partialWarnings && pack.partialWarnings.length) {
    lines.push("Partial warnings:");
    for (const warning of pack.partialWarnings.slice(0, 8)) lines.push(`- ${warning}`);
  }
  lines.push("");

  lines.push("1. Module identity");
  lines.push(`- Inferred module type: ${pack.moduleType}`);
  if (pack.moduleTypeHint) lines.push(`- User module type hint: ${pack.moduleTypeHint}`);
  if (pack.focus) lines.push(`- Focus: ${pack.focus}`);
  lines.push(`- Likely Linux subsystem: ${pack.linuxSubsystem}`);
  if (pack.workflowProfile) {
    lines.push(`- Selected driver workflow profile: ${pack.workflowProfile.profile || "unknown"}`);
    lines.push(`- Driver profile stack: ${(pack.workflowProfile._profileStack || []).join(" -> ") || pack.workflowProfile.profile || "unknown"}`);
    if ((pack.workflowProfile._fragmentStack || []).length) lines.push(`- Driver profile fragments: ${pack.workflowProfile._fragmentStack.join(", ")}`);
  }
  for (const warning of pack.workflowProfileWarnings || []) lines.push(`- Driver profile warning: ${warning}`);
  lines.push(`- Register index created: ${pack.registerIndex.createdAt}`);
  lines.push(`- Registers considered: ${(pack.registers || []).length} of ${pack.registerIndex.registerCount || (pack.registerIndex.registers || []).length || 0}`);
  lines.push("");

  lines.push("2. Relevant manual sections");
  const sectionGroups = [
    ["Overview", pack.sections.overview],
    ["Register description", pack.sections.registerDescription],
    ["Operation/setting", pack.sections.operation],
    ["Caution/usage notes", pack.sections.caution],
  ];
  for (const [label, sections] of sectionGroups) {
    const text = (sections || []).slice(0, 5).map((s) => `${s.title} (page ${s.page})`).join(" | ") || "not found";
    lines.push(`- ${label}: ${text}`);
  }
  lines.push("");

  lines.push("3. Register groups");
  if ((pack.groups || []).length) {
    for (const group of pack.groups) {
      const regs = group.registers.slice(0, 16).map((r) => r.displayName || r.name).join(", ");
      const suffix = group.registers.length > 16 ? `, ... (+${group.registers.length - 16} more)` : "";
      lines.push(`- ${group.name}: ${regs}${suffix}`);
    }
  } else {
    lines.push("- No register groups detected. Rebuild index or inspect list_registers output.");
  }
  lines.push("");

  lines.push("4. Key registers for driver work");
  if ((pack.keyRegisters || []).length) {
    for (const [index, reg] of pack.keyRegisters.entries()) {
      const name = reg.displayName || reg.name;
      const pages = (reg.pages || []).slice(0, 8).join(", ") || "unknown";
      const description = reg.description ? ` — ${reg.description}` : "";
      const offset = reg.offsetAddress ? `, offset: ${reg.offsetAddress}` : "";
      const initial = reg.initialValue ? `, initial: ${reg.initialValue}` : "";
      const access = reg.accessSize ? `, access size: ${reg.accessSize}` : "";
      lines.push(`${index + 1}. ${name}${description}`);
      lines.push(`   Pages: ${pages}${offset}${initial}${access}`);
      lines.push(`   Confidence: ${reg.confidence}; driver-pack score: ${reg.driverPackScore}`);
      lines.push(`   Suggested summary: summarize_register(filename="${filename}", register="${name}")`);
    }
  } else {
    lines.push("- No key registers selected.");
  }
  lines.push("");

  lines.push("5. Candidate bit fields from key register summaries");
  if ((pack.bitfields || []).length) {
    for (const field of pack.bitfields.slice(0, 40)) {
      const pages = field.pages.join(", ") || "unknown";
      lines.push(`- ${field.register || "unknown"}.${field.name} — pages: ${pages}; chunks: ${field.chunks.slice(0, 3).join(", ") || "none"}`);
      if (field.evidence && field.evidence.length) {
        for (const evidence of field.evidence.slice(0, 2)) lines.push(`  evidence: ${evidence}`);
      }
      if (field.register) lines.push(`  Suggested find: find_bitfield(filename="${filename}", register="${field.register}", bitfield="${field.name}")`);
    }
  } else {
    lines.push("- No bit-field candidates found from key register summaries. Use find_bitfield or read_pdf_pages around register pages.");
  }
  lines.push("");

  lines.push("6. Operation sequence candidates");
  if ((pack.sequences || []).length) {
    for (const item of pack.sequences.slice(0, 16)) {
      const r = item.result;
      const evidence = (r.sequenceEvidence || []).slice(0, 3);
      lines.push(`- ${item.topic}${item.register ? ` [register context: ${item.register}]` : ""}: page ${r.page}, chunk ${r.id}, score ${r.score}${item.source ? `, source=${item.source}` : ""}`);
      for (const line of evidence) lines.push(`  evidence: ${line}`);
      lines.push(`  Suggested read: read_pdf_pages(filename="${filename}", start_page=${r.page}, end_page=${Math.max(Number(r.page), Number(r.page) + DEFAULT_PAGE_RANGE - 1)})`);
    }
  } else {
    lines.push("- No sequence candidates found. Use list_sequences with a filter or get_sequence with a specific topic/register.");
  }
  lines.push("");

  lines.push("7. Caution / restriction candidates");
  if ((pack.cautions || []).length) {
    for (const item of pack.cautions.slice(0, 16)) {
      const r = item.result;
      const evidence = (r.cautionEvidence || []).slice(0, 3);
      lines.push(`- ${item.topic}${item.register ? ` [register context: ${item.register}]` : ""}: page ${r.page}, chunk ${r.id}, score ${r.score}${item.source ? `, source=${item.source}` : ""}`);
      for (const line of evidence) lines.push(`  evidence: ${line}`);
      lines.push(`  Suggested read: read_pdf_pages(filename="${filename}", start_page=${r.page}, end_page=${Math.max(Number(r.page), Number(r.page) + DEFAULT_PAGE_RANGE - 1)})`);
    }
  } else {
    lines.push("- No caution candidates found. Use list_cautions with specific topics such as reserved bits or clear status flag.");
  }
  lines.push("");

  lines.push("8. Persisted visual evidence for driver review");
  lines.push(...formatDriverVisualEvidenceSection(pack.visualEvidence || [], filename).slice(1));
  lines.push("");

  lines.push("8b. Visual evidence verification gate");
  lines.push(...formatVisualEvidenceGateSection(pack.visualEvidenceGate || {}, filename).slice(1));
  lines.push("");

  lines.push("9. Driver implementation checklist for the VS Code agent");
  for (const item of pack.checklist || []) lines.push(`- ${item}`);
  lines.push("");

  lines.push("10. Unknowns and required verification");
  lines.push("- This evidence pack is heuristic. It does not prove exact bit positions unless the underlying page/chunk evidence clearly shows the bit table.");
  lines.push("- Verify offsets, bit ranges, reset values, access types, and clear semantics with read_pdf_pages/read_pdf_chunk before committing driver macros.");
  lines.push("- Use the VS Code workspace for Linux source, DTS, Kconfig, Makefile, binding YAML, and build/test logs. This MCP server is intentionally manual-only.");
  lines.push("");

  if (pack.skippedPhases && pack.skippedPhases.length) {
    lines.push("Skipped phases due to budget:");
    for (const phase of pack.skippedPhases.slice(0, 12)) lines.push(`- ${phase.name}: ${phase.reason} (elapsed=${phase.elapsedMs}ms, remaining=${phase.remainingMs}ms)`);
    lines.push("");
  }

  lines.push("11. Recommended next MCP calls");
  lines.push(`- list_registers(filename="${filename}", top_k=100)`);
  for (const reg of (pack.keyRegisters || []).slice(0, 6)) {
    const name = reg.displayName || reg.name;
    lines.push(`- summarize_register(filename="${filename}", register="${name}")`);
  }
  lines.push(`- get_sequence(filename="${filename}", topic="start operation")`);
  lines.push(`- list_cautions(filename="${filename}", filter="reserved bits")`);
  lines.push(`- list_cautions(filename="${filename}", filter="clear status flag")`);
  if (pack.workflowProfile) lines.push(`- source_review_prompt_pack(filename="${filename}", subsystem="${normalizeDriverSubsystemHint(pack.moduleType)}", driver_family="${normalizeDriverFamilyHint(pack.moduleTypeHint)}", profile="${pack.workflowProfile.profile || ""}")`);
  lines.push(`- visual_evidence_report(filename="${filename}", include_entries=true)`);
  lines.push(`- search_figures(filename="${filename}", query="<clock/timing/reset/pinmux/interrupt visual topic>", build_if_missing=true)`);
  lines.push(`- get_figure_context_pack(filename="${filename}", figure_id="<figure_id_from_search_figures>")`);
  lines.push(`- get_figure_image(filename="${filename}", figure_id="<figure_id_from_search_figures>", transport="metadata")`);

  return appendEvidenceContract(lines.join("\n"), buildDriverEvidencePackContract(pack));
}

export function buildSectionQueries(section) {
  const raw = String(section || "").trim();
  const queries = new Set();

  queries.add(raw);
  queries.add(`${raw} section`);
  queries.add(`${raw} description`);
  queries.add(`${raw} operation`);
  queries.add(`${raw} setting`);

  return [...queries].filter(Boolean);
}

export async function multiQuerySearch(filename, queries, topK) {
  const combined = new Map();

  for (const query of queries) {
    const { results } = await searchPdfIndex(filename, query, topK);

    for (const result of results) {
      const previous = combined.get(result.id);
      const merged = previous
        ? {
            ...previous,
            score: Math.max(previous.score, result.score) + Math.floor(Math.min(previous.score, result.score) * 0.1),
          }
        : result;

      combined.set(result.id, merged);
    }
  }

  return [...combined.values()]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.page !== b.page) return a.page - b.page;
      return a.chunkIndex - b.chunkIndex;
    })
    .slice(0, clampTopK(topK));
}
