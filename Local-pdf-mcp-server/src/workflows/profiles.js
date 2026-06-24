import { appendEvidenceContract, atomicWriteFile, atomicWriteJson, compactText, ensurePdfFilename, makeEvidence, makeEvidenceContract, makeInference, makeNeedsVerification, normalizeForSearch, pathExists, safeDriverProfileFragmentPath, safeDriverProfilePath, safeModuleProfileJsonPath, safeModuleProfileTextPath, sleep } from "../core/runtime-helpers.js";
import { createRuntimePort } from "../core/runtime-ports.js";
import { DRIVER_PROFILES_DIR, DRIVER_PROFILE_FRAGMENTS_DIR, DRIVER_PROFILE_SCHEMA_VERSION, INDEX_DIR, MAX_REGISTER_LIST_TOP_K, MODULE_PROFILE_SCHEMA_VERSION } from "../core/runtime-constants.js";
import fs from "node:fs/promises";
import path from "node:path";
import { driverProfileCandidates, normalizeDriverFamilyHint, normalizeDriverSubsystemHint, normalizeProfileNameArray, sanitizeDriverProfileName, validateDriverProfileFragmentObject, validateDriverProfileObject } from "../driver-profiles/catalog.js";


const collectDriverReviewVisualEvidence = createRuntimePort("collectDriverReviewVisualEvidence");


const formatDriverVisualEvidenceSection = createRuntimePort("formatDriverVisualEvidenceSection");
const formatVisualEvidenceGateSection = createRuntimePort("formatVisualEvidenceGateSection");
const groupRegistersForDriverPack = createRuntimePort("groupRegistersForDriverPack");
const inferModuleType = createRuntimePort("inferModuleType");
const likelyLinuxSubsystem = createRuntimePort("likelyLinuxSubsystem");
const listRegistersFromIndex = createRuntimePort("listRegistersFromIndex");
const loadPdfIndex = createRuntimePort("loadPdfIndex");


const normalizeStringArray = createRuntimePort("normalizeStringArray");

const quoteForPromptCall = createRuntimePort("quoteForPromptCall");


const searchSectionsIndex = createRuntimePort("searchSectionsIndex");
const selectKeyRegistersForDriverPack = createRuntimePort("selectKeyRegistersForDriverPack");

const visualEvidenceDriverWarnings = createRuntimePort("visualEvidenceDriverWarnings");
const visualEvidenceGateNeedsVerification = createRuntimePort("visualEvidenceGateNeedsVerification");
const visualEvidenceGateSuggestedCalls = createRuntimePort("visualEvidenceGateSuggestedCalls");
const visualEvidenceGateWarnings = createRuntimePort("visualEvidenceGateWarnings");
const visualEvidenceToEvidenceContractItems = createRuntimePort("visualEvidenceToEvidenceContractItems");


// -----------------------------------------------------------------------------
// Module profile
// -----------------------------------------------------------------------------

export function modulePurposeForType(moduleType) {
  const type = String(moduleType || "").toLowerCase();
  if (type.includes("dma")) return "Move data between memory/peripherals with channel configuration, transfer descriptors/registers, status, error and interrupt handling.";
  if (type.includes("watchdog")) return "Monitor system liveness and generate reset/interrupt action when refresh does not occur within the configured timeout.";
  if (type.includes("pwm") || type.includes("timer")) return "Generate timer/counter/PWM behavior with period/duty/capture/compare and interrupt/status handling.";
  if (type.includes("gpio")) return "Control pins, direction, input/output state, and optionally interrupt detection.";
  if (type.includes("i2c")) return "Provide an I2C controller with bus timing, transfer state, status, error and interrupt handling.";
  if (type.includes("spi")) return "Provide an SPI controller with clock/mode/chip-select/transfer FIFO or shift-register handling.";
  if (type.includes("uart")) return "Provide serial TX/RX, baud-rate configuration, FIFO/status/error and interrupt handling.";
  if (type.includes("ethernet")) return "Provide network MAC datapath, DMA/status/interrupt, PHY integration and link management.";
  if (type.includes("can")) return "Provide CAN/CAN-FD controller state, bit timing, message buffers/FIFO and interrupt/error handling.";
  if (type.includes("adc")) return "Provide ADC conversion setup, channel selection, trigger, result and interrupt/status handling.";
  if (type.includes("rtc")) return "Provide time/calendar/alarm/counter operation with interrupt/status handling.";
  return "Unknown module purpose. Infer from overview/register groups and the Linux source workspace.";
}

export function driverTopicsForModuleType(moduleType) {
  const type = String(moduleType || "").toLowerCase();
  const common = [
    "probe/init resource mapping",
    "clock/reset enable sequence",
    "start/enable operation",
    "stop/disable operation",
    "interrupt/status handling",
    "status clear semantics",
    "reserved-bit handling",
    "runtime PM or suspend/resume constraints",
  ];

  if (type.includes("dma")) return [
    "channel allocation",
    "transfer setup source/destination/count/config",
    "start transfer / issue pending",
    "terminate/suspend/reset channel",
    "transfer-complete status and error status",
    "interrupt clear semantics",
    "per-channel stride and global status registers",
    ...common,
  ];
  if (type.includes("watchdog")) return [
    "timeout calculation",
    "refresh/ping sequence",
    "start/stop watchdog behavior",
    "reset or interrupt output behavior",
    "panic/restart behavior",
    ...common,
  ];
  if (type.includes("pwm") || type.includes("timer")) return [
    "counter start/stop sequence",
    "period/duty or compare/capture setup",
    "output polarity/mode control",
    "interrupt/status clear",
    "shared-channel restrictions",
    ...common,
  ];
  if (type.includes("i2c") || type.includes("spi") || type.includes("uart")) return [
    "clock/timing configuration",
    "transfer start/stop state machine",
    "TX/RX FIFO or data register handling",
    "error/status interrupt clear",
    ...common,
  ];
  return common;
}

export function riskTopicsForModuleType(moduleType) {
  const type = String(moduleType || "").toLowerCase();
  const common = [
    "reserved bits",
    "write only when stopped",
    "clear status flag",
    "write 1 to clear",
    "write 0 to clear",
    "undefined read write value",
    "clock reset restriction",
  ];

  if (type.includes("dma")) return [
    "clear transfer end",
    "clear error status",
    "channel enable disable restriction",
    "software reset",
    "suspend transfer",
    ...common,
  ];
  if (type.includes("watchdog")) return [
    "refresh sequence",
    "write protect",
    "timeout setting restriction",
    "reset output condition",
    ...common,
  ];
  if (type.includes("pwm") || type.includes("timer")) return [
    "counter stopped setting",
    "compare register update timing",
    "interrupt flag clear",
    "output disable condition",
    ...common,
  ];
  return common;
}

export function profileConfidence(registers, sections, moduleType) {
  let score = 0;
  if (moduleType && moduleType !== "unknown") score += 25;
  if ((registers || []).length >= 4) score += 25;
  if ((registers || []).length >= 12) score += 15;
  if ((sections || []).some((s) => /overview/i.test(s.title || ""))) score += 10;
  if ((sections || []).some((s) => /register/i.test(s.title || ""))) score += 10;
  if ((sections || []).some((s) => /operation|procedure|setting/i.test(s.title || ""))) score += 10;
  if ((sections || []).some((s) => /caution|note|restriction|usage/i.test(s.title || ""))) score += 5;

  if (score >= 80) return { level: "high", score };
  if (score >= 50) return { level: "medium", score };
  return { level: "low", score };
}

export function summarizeRegisterGroupsForProfile(groups) {
  return (groups || []).map((group) => ({
    name: group.name,
    count: (group.registers || []).length,
    registers: (group.registers || []).slice(0, 20).map((reg) => ({
      name: reg.displayName || reg.name,
      description: reg.description || "",
      pages: reg.pages || [],
      offsetAddress: reg.offsetAddress || "",
      initialValue: reg.initialValue || "",
      accessSize: reg.accessSize || "",
      confidence: reg.confidence,
    })),
  }));
}

export function collectProfileSections(sectionResults) {
  const seen = new Set();
  const out = [];
  for (const section of sectionResults.flat()) {
    const key = `${section.title}|${section.page}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: section.id,
      title: section.title,
      page: section.page,
      level: section.level,
      type: section.type,
      score: section.score,
      confidence: section.confidence,
    });
  }
  return out.slice(0, 40);
}

export async function buildModuleProfile(filename, options = {}) {
  const moduleTypeHint = String(options.moduleType || "").trim();
  const focus = String(options.focus || "").trim();

  await loadPdfIndex(filename);

  const { registerIndex, results: registers } = await listRegistersFromIndex(filename, {
    topK: MAX_REGISTER_LIST_TOP_K,
    includeLowConfidence: false,
  });

  const sectionQueries = [
    "overview",
    "register description",
    "register list",
    "operation procedure setting",
    "interrupt status",
    "clock reset",
    "caution note restriction usage notes",
  ];

  const sectionSearches = [];
  for (const query of sectionQueries) {
    const { results } = await searchSectionsIndex(filename, query, 8);
    sectionSearches.push(results);
  }

  const sections = collectProfileSections(sectionSearches);
  const moduleType = inferModuleType(filename, registers, sections, moduleTypeHint);
  const linuxSubsystem = likelyLinuxSubsystem(moduleType);
  const groups = groupRegistersForDriverPack(registers);
  const keyRegisters = selectKeyRegistersForDriverPack(registers, moduleType, Math.min(16, registers.length));
  const confidence = profileConfidence(registers, sections, moduleType);
  const driverTopics = driverTopicsForModuleType(moduleType);
  const riskTopics = riskTopicsForModuleType(moduleType);

  const profile = {
    schemaVersion: MODULE_PROFILE_SCHEMA_VERSION,
    filename,
    createdAt: new Date().toISOString(),
    moduleType,
    moduleTypeHint,
    linuxSubsystem,
    focus,
    purpose: modulePurposeForType(moduleType),
    confidence,
    sourceStats: {
      registerIndexCreatedAt: registerIndex.createdAt,
      registerCount: registerIndex.registerCount || (registerIndex.registers || []).length || 0,
      listedRegisterCount: registers.length,
      sectionCount: sections.length,
    },
    manualStructure: {
      sections,
      sectionQueries,
    },
    registerGroups: summarizeRegisterGroupsForProfile(groups),
    keyRegisters: keyRegisters.map((reg) => ({
      name: reg.displayName || reg.name,
      canonicalName: reg.name,
      description: reg.description || "",
      pages: reg.pages || [],
      offsetAddress: reg.offsetAddress || "",
      initialValue: reg.initialValue || "",
      accessSize: reg.accessSize || "",
      confidence: reg.confidence,
      driverPackScore: reg.driverPackScore,
      suggestedSummaryCall: `summarize_register(filename="${filename}", register="${reg.displayName || reg.name}")`,
    })),
    driverRelevantTopics: driverTopics,
    highRiskTopics: riskTopics,
    recommendedWorkflow: [
      "Use get_module_profile first for module orientation.",
      "Use build_driver_evidence_pack before writing/reviewing driver code.",
      "Use summarize_register for each register used by source code macros.",
      "Use find_bitfield for every bit/mask macro used by the driver.",
      "Use find_sequence for init/start/stop/reset/status-clear flows.",
      "Use find_caution for reserved bits, write timing, and clear semantics.",
      "Use read_pdf_pages/read_pdf_chunk before trusting exact offset, bit range, reset value, access type, or clear semantics.",
    ],
    suggestedMcpCalls: [
      `build_driver_evidence_pack(filename="${filename}"${moduleType !== "unknown" ? `, module_type="${moduleType}"` : ""})`,
      `list_registers(filename="${filename}", top_k=100)`,
      ...keyRegisters.slice(0, 6).map((reg) => `summarize_register(filename="${filename}", register="${reg.displayName || reg.name}")`),
      `find_sequence(filename="${filename}", topic="initialization")`,
      `find_sequence(filename="${filename}", topic="start operation")`,
      `find_caution(filename="${filename}", topic="reserved bits")`,
      `find_caution(filename="${filename}", topic="clear status flag")`,
    ],
    limitations: [
      "This module profile is heuristic and depends on PDF text extraction quality.",
      "It does not prove exact bit positions or clear semantics without page/chunk evidence.",
      "For complex modules, use this profile as orientation, then verify each register write path with focused MCP calls.",
    ],
  };

  return profile;
}

export async function loadModuleProfile(filename) {
  const profilePath = safeModuleProfileJsonPath(filename);
  if (!(await pathExists(profilePath))) return null;

  try {
    const raw = await fs.readFile(profilePath, "utf-8");
    const profile = JSON.parse(raw);
    if (profile.schemaVersion !== MODULE_PROFILE_SCHEMA_VERSION) return null;
    if (profile.filename !== filename) return null;
    return profile;
  } catch {
    return null;
  }
}

export async function getModuleProfile(filename, options = {}) {
  const refresh = Boolean(options.refresh || options.force);
  if (!refresh) {
    const existing = await loadModuleProfile(filename);
    if (existing) return existing;
  }

  const profile = await buildModuleProfile(filename, options);
  await saveModuleProfile(profile);
  return profile;
}

export async function saveModuleProfile(profile) {
  await fs.mkdir(INDEX_DIR, { recursive: true });
  const jsonPath = safeModuleProfileJsonPath(profile.filename);
  const textPath = safeModuleProfileTextPath(profile.filename);
  await atomicWriteJson(jsonPath, profile);
  await atomicWriteFile(textPath, formatModuleProfile(profile), "utf-8");
  return { jsonPath, textPath };
}

export function formatModuleProfile(profile) {
  const lines = [];
  const filename = profile.filename;

  lines.push(`Module Profile`);
  lines.push(`File: ${filename}`);
  lines.push(`Created: ${profile.createdAt}`);
  lines.push("");

  lines.push("1. Module identity");
  lines.push(`- Inferred module type: ${profile.moduleType}`);
  if (profile.moduleTypeHint) lines.push(`- User module type hint: ${profile.moduleTypeHint}`);
  if (profile.focus) lines.push(`- Focus: ${profile.focus}`);
  lines.push(`- Likely Linux subsystem: ${profile.linuxSubsystem}`);
  lines.push(`- Purpose: ${profile.purpose}`);
  lines.push(`- Profile confidence: ${profile.confidence.level} (${profile.confidence.score}/100)`);
  lines.push("");

  lines.push("2. Source/index status");
  lines.push(`- Register index created: ${profile.sourceStats.registerIndexCreatedAt || "unknown"}`);
  lines.push(`- Registers detected: ${profile.sourceStats.registerCount}`);
  lines.push(`- Registers listed in profile: ${profile.sourceStats.listedRegisterCount}`);
  lines.push(`- Relevant sections listed: ${profile.sourceStats.sectionCount}`);
  lines.push("");

  lines.push("3. Manual structure highlights");
  if ((profile.manualStructure.sections || []).length) {
    for (const section of profile.manualStructure.sections.slice(0, 24)) {
      lines.push(`- ${section.title} (page ${section.page}, type: ${section.type || "unknown"}, score: ${section.score || section.confidence || "n/a"})`);
    }
  } else {
    lines.push("- No section highlights found. Use find_section/search_pdf manually.");
  }
  lines.push("");

  lines.push("4. Register groups");
  if ((profile.registerGroups || []).length) {
    for (const group of profile.registerGroups) {
      const regs = (group.registers || []).slice(0, 12).map((r) => r.name).join(", ");
      const suffix = group.count > 12 ? `, ... (+${group.count - 12} more)` : "";
      lines.push(`- ${group.name} (${group.count}): ${regs}${suffix}`);
    }
  } else {
    lines.push("- No register groups detected.");
  }
  lines.push("");

  lines.push("5. Key registers for driver orientation");
  if ((profile.keyRegisters || []).length) {
    for (const [index, reg] of profile.keyRegisters.entries()) {
      const pages = (reg.pages || []).slice(0, 8).join(", ") || "unknown";
      const desc = reg.description ? ` — ${reg.description}` : "";
      const offset = reg.offsetAddress ? `; offset: ${reg.offsetAddress}` : "";
      const initial = reg.initialValue ? `; initial: ${reg.initialValue}` : "";
      const access = reg.accessSize ? `; access size: ${reg.accessSize}` : "";
      lines.push(`${index + 1}. ${reg.name}${desc}`);
      lines.push(`   Pages: ${pages}${offset}${initial}${access}; confidence: ${reg.confidence}; score: ${reg.driverPackScore}`);
      lines.push(`   Suggested: ${reg.suggestedSummaryCall}`);
    }
  } else {
    lines.push("- No key registers selected.");
  }
  lines.push("");

  lines.push("6. Driver-relevant topics");
  for (const topic of profile.driverRelevantTopics || []) lines.push(`- ${topic}`);
  lines.push("");

  lines.push("7. High-risk manual topics to verify");
  for (const topic of profile.highRiskTopics || []) lines.push(`- ${topic}`);
  lines.push("");

  lines.push("8. Recommended workflow for VS Code AI agent");
  for (const item of profile.recommendedWorkflow || []) lines.push(`- ${item}`);
  lines.push("");

  lines.push("9. Suggested MCP calls");
  for (const call of profile.suggestedMcpCalls || []) lines.push(`- ${call}`);
  lines.push("");

  lines.push("10. Limitations");
  for (const item of profile.limitations || []) lines.push(`- ${item}`);

  return lines.join("\n");
}


// -----------------------------------------------------------------------------
// Data-driven driver profiles / completeness checklist
// -----------------------------------------------------------------------------

export function defaultDriverProfiles() {
  return {
    generic: {
      schemaVersion: DRIVER_PROFILE_SCHEMA_VERSION,
      profile: "generic",
      title: "Generic Linux MMIO/platform driver completeness checklist",
      subsystem: "generic",
      driver_family: "generic",
      description: "Fallback checklist for a Linux platform/MMIO driver when no subsystem-specific profile exists.",
      checklist: [
        {
          area: "Probe / platform integration",
          items: [
            "compatible/of_device_id or platform_device_id match",
            "MMIO resource acquisition and devm_ioremap_resource/ioremap",
            "IRQ resource acquisition and request handler if interrupts are used",
            "clock acquisition/enable/disable and rate assumptions",
            "reset control acquire/deassert/assert ordering",
            "runtime PM enable/disable and error unwinding",
            "pinctrl/default state if pins are required",
            "devm-managed resources or correct cleanup path"
          ],
          required_manual_checks: ["base address/register map", "clock/reset requirements", "interrupt sources", "initialization sequence"]
        },
        {
          area: "Register access correctness",
          items: [
            "all register offsets match the manual",
            "all bit masks/shifts match bit-field tables",
            "reserved bits are preserved on writes",
            "read-only/write-only/access-size constraints are respected",
            "write timing restrictions are respected",
            "status clear semantics are verified"
          ],
          required_manual_checks: ["register offsets", "bitfield positions", "access type", "reserved-bit handling", "clear semantics"]
        },
        {
          area: "Operation sequencing",
          items: [
            "probe/init sequence follows manual order",
            "start/enable path follows manual order",
            "stop/disable path follows manual order",
            "software reset/polling path follows manual order",
            "error handling path handles documented flags and recovery steps"
          ],
          required_manual_checks: ["init sequence", "start sequence", "stop sequence", "reset sequence", "error sequence"]
        },
        {
          area: "Interrupt/status handling",
          items: [
            "IRQ mask/unmask ordering is correct",
            "status is read before clear when required",
            "W1C/W0C semantics are verified",
            "handler distinguishes normal completion from error sources",
            "race with enable/disable/remove/suspend is handled"
          ],
          required_manual_checks: ["interrupt source table", "status register", "clear semantics", "error flags"]
        },
        {
          area: "Power management / reset restore",
          items: [
            "runtime suspend/resume saves/restores necessary state",
            "system suspend/resume handles clocks/resets/IRQs",
            "hardware state after reset is consistent with driver state",
            "wake capability is handled only if documented"
          ],
          required_manual_checks: ["reset values", "clock gating restrictions", "standby restrictions"]
        }
      ],
      source_review_steps: [
        "Read source files in the VS Code workspace; MCP does not read source code.",
        "Extract register macros and bit macros used by the driver.",
        "Classify each hardware operation as raw_write/read_modify_write/poll/write_one_to_clear/reset.",
        "Call verify_register_usage for each operation touching hardware registers.",
        "Resolve every needsVerification item before approving code."
      ],
      required_manual_checks: [
        "register offsets",
        "bitfield positions",
        "access type and access size",
        "reserved-bit handling",
        "init/start/stop/reset sequence",
        "interrupt/status clear semantics",
        "cautions/restrictions"
      ],
      recommended_tools: [
        "doctor",
        "prepare_driver_task",
        "build_driver_evidence_pack",
        "verify_register_usage",
        "extract_register_table",
        "extract_bitfield_table",
        "get_sequence",
        "get_cautions_for_register"
      ]
    },
    ethernet: {
      schemaVersion: DRIVER_PROFILE_SCHEMA_VERSION,
      profile: "ethernet",
      title: "Linux Ethernet MAC driver completeness checklist",
      subsystem: "ethernet",
      driver_family: "generic-ethernet",
      description: "Generic Ethernet MAC checklist; use ethernet-stmmac when the driver is STMMAC/DWMAC based.",
      extends: "generic",
      checklist: [
        {
          area: "Netdev / MAC integration",
          items: [
            "net_device allocation/registration path is correct",
            "MAC address setup and validation are implemented",
            "TX/RX enable/disable sequence is verified",
            "speed/duplex/flow-control configuration is handled",
            "multicast/promiscuous/allmulti filters are handled",
            "checksum/TSO/offload capability flags match hardware"
          ],
          required_manual_checks: ["MAC control registers", "TX/RX enable bits", "filter registers", "flow-control registers"]
        },
        {
          area: "PHY / MDIO / link mode",
          items: [
            "phy-mode is parsed from Device Tree",
            "phy-handle/fixed-link is supported as needed",
            "MDIO controller registration and clock/divider are correct",
            "RGMII/RMII/GMII delays and interface mode restrictions are handled",
            "link up/down callbacks program MAC state safely"
          ],
          required_manual_checks: ["MDIO registers", "PHY interface mode", "RGMII delay control", "link speed setting"]
        },
        {
          area: "DMA / descriptor / rings",
          items: [
            "descriptor format matches hardware/manual",
            "RX/TX ring allocation and DMA mapping are correct",
            "descriptor ownership bits and barriers are correct",
            "TX completion and RX refill are handled",
            "DMA reset/start/stop sequence is verified"
          ],
          required_manual_checks: ["DMA registers", "descriptor format", "DMA start/stop sequence", "status/error flags"]
        },
        {
          area: "Interrupt / error recovery",
          items: [
            "normal TX/RX IRQ sources are enabled and acknowledged correctly",
            "DMA/MAC error IRQ sources are handled",
            "status clear semantics are verified",
            "reset/recovery path is available for fatal errors",
            "IRQ masking avoids races with stop/suspend/remove"
          ],
          required_manual_checks: ["interrupt status registers", "interrupt enable/mask registers", "clear semantics", "error recovery sequence"]
        }
      ],
      source_review_steps: [
        "Inspect ndo_open/ndo_stop, IRQ handler, TX/RX path, MDIO/PHY setup, and suspend/resume.",
        "Extract every MAC/DMA/MDIO register operation and call verify_register_usage.",
        "Compare Device Tree nodes against required clocks/resets/interrupts/phy-mode/mdio/fixed-link properties."
      ],
      required_manual_checks: [
        "MAC TX/RX enable sequence",
        "DMA descriptor/ring start-stop sequence",
        "interrupt clear semantics",
        "MDIO clock/divider and PHY interface restrictions",
        "reset and runtime PM restrictions"
      ],
      recommended_tools: ["driver_completeness_checklist", "build_driver_evidence_pack", "verify_register_usage", "get_sequence", "get_cautions_for_register"]
    },
    "ethernet-stmmac": {
      schemaVersion: DRIVER_PROFILE_SCHEMA_VERSION,
      profile: "ethernet-stmmac",
      title: "Linux Ethernet STMMAC/DWMAC glue driver completeness checklist",
      subsystem: "ethernet",
      driver_family: "stmmac",
      extends: "ethernet",
      description: "Checklist for drivers that integrate SoC-specific Ethernet MAC glue with stmmac_platform/stmmac_main.",
      checklist: [
        {
          area: "STMMAC platform/glue integration",
          items: [
            "stmmac_platform or glue probe passes correct plat_stmmacenet_data",
            "compatible string selects correct SoC data",
            "DMA bus mode/axi/config quirks are mapped correctly",
            "MAC version/capability assumptions do not conflict with manual",
            "remove/error unwind calls stmmac_dvr_remove/platform cleanup correctly"
          ],
          required_manual_checks: ["SoC-specific MAC/DMA integration registers", "DMA capability registers", "reset sequence"]
        },
        {
          area: "Device Tree integration for stmmac",
          items: [
            "compatible/reg/interrupts are correct",
            "clocks and clock-names match driver expectations",
            "resets/reset-names match hardware manual sequence",
            "phy-mode/phy-handle/fixed-link/mdio node are correct",
            "RGMII delay properties and pinctrl match board wiring",
            "DMA coherent/cache attributes and AXI settings are reviewed"
          ],
          required_manual_checks: ["clock tree", "reset line", "interrupt lines", "PHY interface mode", "MDIO"]
        },
        {
          area: "STMMAC callbacks and hardware operations",
          items: [
            "init callback programs SoC glue registers before stmmac core starts MAC/DMA",
            "fix_mac_speed or equivalent callback programs speed/duplex related registers",
            "set_tx_clk or clock rate changes are safe",
            "suspend/resume restores glue state before stmmac resumes",
            "reset path waits/polls documented ready bits when required"
          ],
          required_manual_checks: ["speed selection register", "clock/reset sequence", "start/stop sequence", "caution restrictions"]
        }
      ],
      source_review_steps: [
        "Inspect dwmac-renesas-gbeth.c, stmmac_platform.c, stmmac_main.c and related DTS files.",
        "List SoC glue register macros in dwmac-renesas-gbeth.c and call verify_register_usage for each register operation.",
        "Check DTS clocks/resets/interrupts/phy-mode/mdio/fixed-link against the profile checklist.",
        "Do not judge completeness only by stmmac core coverage; verify SoC glue/manual-specific requirements."
      ],
      required_manual_checks: [
        "SoC glue register offsets and bitfields",
        "MAC/DMA reset and start sequence",
        "MDIO/PHY interface configuration",
        "interrupt mapping and clear semantics",
        "clock/reset/runtime PM restrictions"
      ],
      recommended_tools: ["prepare_driver_task", "build_driver_evidence_pack", "verify_register_usage", "hybrid_search_pdf", "get_sequence", "get_cautions_for_register"]
    },
    dmaengine: {
      schemaVersion: DRIVER_PROFILE_SCHEMA_VERSION,
      profile: "dmaengine",
      title: "Linux dmaengine driver completeness checklist",
      subsystem: "dmaengine",
      driver_family: "generic-dmaengine",
      extends: "generic",
      checklist: [
        {
          area: "dma_device / channel model",
          items: ["dma_device capabilities are correct", "channel count/stride matches manual", "slave config fields are mapped", "descriptor allocation/lifetime is correct", "cookie completion is correct"],
          required_manual_checks: ["channel register stride", "transfer configuration registers", "status/end/error registers"]
        },
        {
          area: "Transfer programming",
          items: ["source/destination/count registers are programmed in documented order", "transfer size/alignment limits are enforced", "request IDs and directions are mapped correctly", "start/enable bit sequence is verified"],
          required_manual_checks: ["start sequence", "channel config bitfields", "address/count registers"]
        },
        {
          area: "IRQ / terminate / error",
          items: ["transfer complete interrupt is acknowledged correctly", "error status is handled", "terminate_all stops channel safely", "synchronize waits for in-flight handlers"],
          required_manual_checks: ["clear semantics", "error flags", "stop/suspend/reset sequence"]
        }
      ],
      source_review_steps: ["Inspect prep/issue_pending/IRQ/terminate/synchronize paths.", "Call verify_register_usage for CHCTRL/CHCFG/CHSTAT/status-clear operations."],
      required_manual_checks: ["channel start/stop sequence", "status clear semantics", "reserved-bit handling", "error recovery"],
      recommended_tools: ["prepare_driver_task", "verify_register_usage", "get_sequence", "get_cautions_for_register"]
    },
    watchdog: {
      schemaVersion: DRIVER_PROFILE_SCHEMA_VERSION,
      profile: "watchdog",
      title: "Linux watchdog driver completeness checklist",
      subsystem: "watchdog",
      driver_family: "generic-watchdog",
      extends: "generic",
      checklist: [
        { area: "watchdog core ops", items: ["start/stop/ping/set_timeout/restart implemented as supported", "nowayout behavior is correct", "timeout min/max uses real clock and prescaler limits", "restart priority/path is safe"], required_manual_checks: ["timeout calculation", "refresh sequence", "start/stop sequence", "reset behavior"] },
        { area: "panic/restart behavior", items: ["panic/reboot behavior is verified", "system reset path uses documented reset enable", "clock/reset dependencies are handled"], required_manual_checks: ["reset output behavior", "peri/syscon/reset control", "status flags"] }
      ],
      source_review_steps: ["Inspect watchdog ops and restart/panic path.", "Verify WDTRR/WDTCR/WDTSR/WDTRCR operations with verify_register_usage."],
      required_manual_checks: ["refresh sequence", "timeout formula", "reset output behavior", "reserved-bit handling"],
      recommended_tools: ["verify_register_usage", "get_sequence", "get_cautions_for_register"]
    },
    pwm: {
      schemaVersion: DRIVER_PROFILE_SCHEMA_VERSION,
      profile: "pwm",
      title: "Linux PWM/timer driver completeness checklist",
      subsystem: "pwm",
      driver_family: "generic-pwm",
      extends: "generic",
      checklist: [
        { area: "PWM apply/config", items: ["period/duty conversion uses correct clock and prescaler", "polarity/output mode is correct", "enable/disable sequence is safe", "shared channel constraints are handled"], required_manual_checks: ["counter mode", "output control", "prescaler", "start/stop sequence"] },
        { area: "advanced timer features", items: ["capture/interrupt/dead-time/buffer features are implemented only when supported", "register buffering avoids glitches", "status flags are cleared correctly"], required_manual_checks: ["buffer registers", "interrupt/status clear", "capture sequence"] }
      ],
      source_review_steps: ["Inspect pwm_ops apply/get_state and interrupt/capture paths if present.", "Verify GTCR/GTIOR/GTBER/GTST operations."],
      required_manual_checks: ["period/duty formula", "start/stop sequence", "output polarity", "status clear semantics"],
      recommended_tools: ["verify_register_usage", "extract_bitfield_table", "get_sequence"]
    },
    can: {
      schemaVersion: DRIVER_PROFILE_SCHEMA_VERSION,
      type: "driver-profile",
      profile: "can",
      title: "Linux SocketCAN controller driver completeness checklist",
      subsystem: "can",
      driver_family: "generic-can",
      extends: "generic",
      fragments: ["clock-reset", "irq-status", "runtime-pm", "pinctrl", "socketcan", "can-bit-timing", "fifo-mailbox", "transceiver"],
      checklist: [
        { area: "CAN controller integration", items: ["net_device/can_priv allocation and registration are correct", "CAN mode/start/stop paths follow manual order", "TX/RX object/FIFO/mailbox programming matches hardware", "error state and bus-off recovery are handled"], required_manual_checks: ["CAN mode control registers", "TX/RX FIFO or mailbox registers", "error/status registers", "bus-off recovery sequence"] }
      ],
      source_review_steps: ["Inspect ndo_open/ndo_stop, xmit path, IRQ handler, error/bus-off handling, and bittiming setup.", "Verify controller mode, bit timing, TX/RX, error/status clear, and transceiver/pinctrl operations."],
      required_manual_checks: ["bit timing formula", "TX/RX mailbox or FIFO sequence", "interrupt clear semantics", "error state flags", "clock/reset/runtime PM restrictions"],
      recommended_tools: ["driver_completeness_checklist", "build_driver_evidence_pack", "verify_register_usage", "get_sequence", "get_cautions_for_register"]
    },
    "can-canfd": {
      schemaVersion: DRIVER_PROFILE_SCHEMA_VERSION,
      type: "driver-profile",
      profile: "can-canfd",
      title: "Linux CAN FD controller driver completeness checklist",
      subsystem: "can",
      driver_family: "canfd",
      extends: "can",
      fragments: ["can-bit-timing", "fifo-mailbox"],
      checklist: [
        { area: "CAN FD data phase", items: ["nominal and data bit timing paths are both implemented", "FD enable/BRS/ESI feature flags match hardware", "payload length/DLC mapping handles classic and FD frames", "TX/RX FIFO sizing and timestamp behavior are reviewed"], required_manual_checks: ["CAN FD mode bits", "data phase timing registers", "DLC/payload handling", "FD error/status flags"] }
      ],
      source_review_steps: ["Inspect CAN FD feature enable, data bitrate setup, DLC mapping, and RX/TX buffer sizing."],
      required_manual_checks: ["CAN FD enable sequence", "data bit timing formula", "payload/DLC limits", "FD-specific error flags"],
      recommended_tools: ["verify_register_usage", "extract_bitfield_table", "get_sequence", "get_cautions_for_register"]
    },
    usb: {
      schemaVersion: DRIVER_PROFILE_SCHEMA_VERSION,
      type: "driver-profile",
      profile: "usb",
      title: "Linux USB controller/PHY driver completeness checklist",
      subsystem: "usb",
      driver_family: "generic-usb",
      extends: "generic",
      fragments: ["clock-reset", "irq-status", "runtime-pm", "dma", "phy", "regulator", "pinctrl", "usb-role", "usb-endpoint", "usb-phy-vbus"],
      checklist: [
        { area: "USB controller integration", items: ["host/device/OTG role is identified from source and DT", "PHY, VBUS, clocks, resets, and regulators are sequenced correctly", "controller interrupts and status clear paths are verified", "DMA/cache coherency assumptions are reviewed"], required_manual_checks: ["USB role/host/device registers", "PHY/VBUS sequence", "interrupt/status registers", "DMA/coherency restrictions"] }
      ],
      source_review_steps: ["Inspect probe/remove, role/PHY setup, IRQ handling, runtime PM, and controller core handoff.", "Verify USB clock/reset/PHY/VBUS/status operations with manual evidence."],
      required_manual_checks: ["PHY/VBUS enable sequence", "controller reset/start sequence", "endpoint/FIFO behavior", "interrupt clear semantics", "runtime PM restrictions"],
      recommended_tools: ["driver_completeness_checklist", "build_driver_evidence_pack", "verify_register_usage", "visual_review_handoff_pack"]
    },
    "usb-xhci": {
      schemaVersion: DRIVER_PROFILE_SCHEMA_VERSION,
      type: "driver-profile",
      profile: "usb-xhci",
      title: "Linux xHCI host controller glue driver completeness checklist",
      subsystem: "usb",
      driver_family: "xhci",
      extends: "usb",
      fragments: ["usb-role", "usb-phy-vbus"],
      checklist: [
        { area: "xHCI host glue", items: ["xhci platform glue passes correct resources and quirks", "host reset/PHY initialization happens before xHCI core start", "USB2/USB3 PHY clocks and lanes are configured", "wakeup/suspend/resume restore host state safely"], required_manual_checks: ["xHCI host reset sequence", "USB2/USB3 PHY control", "host interrupt mapping", "wakeup restrictions"] }
      ],
      source_review_steps: ["Inspect xhci-plat/glue probe, hcd creation, PHY init, suspend/resume, and SoC quirks."],
      required_manual_checks: ["host controller reset/start order", "PHY lane setup", "interrupt/wakeup mapping", "runtime PM constraints"],
      recommended_tools: ["verify_register_usage", "get_sequence", "get_cautions_for_register", "visual_review_handoff_pack"]
    },
    pcie: {
      schemaVersion: DRIVER_PROFILE_SCHEMA_VERSION,
      type: "driver-profile",
      profile: "pcie",
      title: "Linux PCIe controller driver completeness checklist",
      subsystem: "pcie",
      driver_family: "generic-pcie",
      extends: "generic",
      fragments: ["clock-reset", "irq-status", "runtime-pm", "phy", "regulator", "pinctrl", "pcie-link-training", "pcie-address-window", "msi", "reset-refclk"],
      checklist: [
        { area: "PCIe controller integration", items: ["host/endpoint role is identified and source path matches it", "PHY/refclk/reset and PERST# sequencing are verified", "link training state and timeout handling are implemented", "address window and interrupt/MSI programming match hardware"], required_manual_checks: ["PCIe role/control registers", "PHY/refclk/reset sequence", "link status registers", "address translation windows", "MSI/interrupt registers"] }
      ],
      source_review_steps: ["Inspect probe, host bridge setup, PHY/reset/refclk sequence, address window programming, MSI/IRQ handling, and suspend/resume."],
      required_manual_checks: ["link training sequence", "PERST/refclk/reset timing", "ATU/address window programming", "MSI/INTx mapping", "error/status clear semantics"],
      recommended_tools: ["driver_completeness_checklist", "build_driver_evidence_pack", "verify_register_usage", "visual_review_handoff_pack"]
    },
    "pcie-host": {
      schemaVersion: DRIVER_PROFILE_SCHEMA_VERSION,
      type: "driver-profile",
      profile: "pcie-host",
      title: "Linux PCIe host bridge/root complex driver completeness checklist",
      subsystem: "pcie",
      driver_family: "pcie-host",
      extends: "pcie",
      fragments: ["pcie-link-training", "pcie-address-window", "msi", "reset-refclk"],
      checklist: [
        { area: "PCIe root complex bring-up", items: ["host bridge resources/ranges are mapped to outbound windows", "link-up polling and failure handling are bounded", "MSI/legacy interrupt domains are wired correctly", "config space access is gated by link/window readiness"], required_manual_checks: ["root complex mode bits", "outbound/inbound window registers", "link status bits", "MSI controller registers", "config access restrictions"] }
      ],
      source_review_steps: ["Inspect pci_host_bridge setup, ranges parsing, link polling, config access, MSI domain setup, and error paths."],
      required_manual_checks: ["root complex mode sequence", "address translation windows", "link-up timeout behavior", "MSI domain setup", "config access restrictions"],
      recommended_tools: ["verify_register_usage", "extract_register_table", "extract_bitfield_table", "get_sequence", "get_cautions_for_register"]
    }
  };
}

export function defaultDriverProfileFragments() {
  const fragment = (name, title, checklist, extra = {}) => ({
    schemaVersion: DRIVER_PROFILE_SCHEMA_VERSION,
    type: "driver-profile-fragment",
    fragment: name,
    title,
    checklist,
    source_review_steps: extra.source_review_steps || [],
    required_manual_checks: extra.required_manual_checks || [],
    recommended_tools: extra.recommended_tools || [],
    sequence_topics: extra.sequence_topics || [],
    caution_topics: extra.caution_topics || [],
    evidence_topics: extra.evidence_topics || [],
  });

  return {
    "clock-reset": fragment("clock-reset", "Clock/reset integration", [
      { area: "Clock/reset resources", items: ["all required clocks are requested/enabled in documented order", "reset controls are asserted/deasserted with documented timing", "error unwind disables clocks and restores reset state"], required_manual_checks: ["clock tree requirements", "reset sequence", "module enable/disable restrictions"] },
    ], { sequence_topics: ["clock enable sequence", "reset deassert sequence"], caution_topics: ["clock gating restriction", "reset timing restriction"], required_manual_checks: ["clock/reset sequence"] }),
    "irq-status": fragment("irq-status", "IRQ/status handling", [
      { area: "Interrupt and status clear", items: ["IRQ sources are enabled only after stale status is cleared", "status flags use documented W1C/W0C/read-clear semantics", "IRQ mask/unmask avoids stop/suspend races"], required_manual_checks: ["interrupt source table", "status clear semantics", "IRQ mask registers"] },
    ], { sequence_topics: ["interrupt handling", "clear interrupt status"], caution_topics: ["write 1 to clear", "write 0 to clear", "interrupt clear restriction"], required_manual_checks: ["interrupt/status clear semantics"] }),
    "runtime-pm": fragment("runtime-pm", "Runtime PM", [
      { area: "Runtime/system PM", items: ["runtime PM usage matches clock/reset dependencies", "suspend saves state that reset/clock gating loses", "wakeup is enabled only when documented"], required_manual_checks: ["standby restrictions", "wakeup support", "state retention after reset"] },
    ], { sequence_topics: ["runtime suspend resume sequence"], caution_topics: ["standby restriction", "wakeup restriction"], required_manual_checks: ["runtime PM restrictions"] }),
    dma: fragment("dma", "DMA integration", [
      { area: "DMA/coherency", items: ["DMA addressing and burst/alignment limits are enforced", "descriptor/ring ownership and barriers are correct when present", "cache coherency attributes match hardware"], required_manual_checks: ["DMA address width", "burst/alignment limits", "descriptor ownership", "coherency restrictions"] },
    ], { sequence_topics: ["DMA start sequence", "DMA stop sequence"], caution_topics: ["DMA alignment restriction", "cache coherency restriction"], required_manual_checks: ["DMA/coherency constraints"] }),
    phy: fragment("phy", "PHY integration", [
      { area: "PHY bring-up", items: ["PHY handle/lookup is correct", "PHY reset/init/calibration follows manual order", "link/ready polling has timeout and error handling"], required_manual_checks: ["PHY control registers", "PHY reset/init sequence", "ready/status bits"] },
    ], { sequence_topics: ["PHY initialization sequence", "PHY reset sequence"], caution_topics: ["PHY ready timeout", "PHY reset restriction"], required_manual_checks: ["PHY sequence"] }),
    regulator: fragment("regulator", "Regulator/power rail integration", [
      { area: "Power rails", items: ["required supplies are enabled before controller/PHY use", "voltage/current assumptions match board binding", "disable/unwind order is safe"], required_manual_checks: ["power supply requirements", "enable/disable ordering"] },
    ], { sequence_topics: ["power enable sequence"], caution_topics: ["power supply restriction"], required_manual_checks: ["power rail requirements"] }),
    pinctrl: fragment("pinctrl", "Pinctrl integration", [
      { area: "Pins and alternate functions", items: ["default/sleep pinctrl states are selected when required", "drive/bias/IO voltage constraints are reviewed", "external pins such as reset/enable/interrupt lines match board wiring"], required_manual_checks: ["pin function table", "drive/bias restrictions", "external signal mapping"] },
    ], { sequence_topics: ["pin function setting"], caution_topics: ["pinmux restriction"], required_manual_checks: ["pinmux/IO constraints"] }),
    socketcan: fragment("socketcan", "SocketCAN integration", [
      { area: "SocketCAN core", items: ["can_priv/net_device setup follows SocketCAN conventions", "open/close/start_xmit paths map to controller state", "echo skb, tx queue stop/wake, and bus-off recovery are correct"], required_manual_checks: ["controller mode bits", "TX/RX status flags", "bus-off recovery"] },
    ], { sequence_topics: ["CAN start operation", "CAN stop operation", "bus off recovery"], caution_topics: ["CAN error status clear"], required_manual_checks: ["SocketCAN state transitions"] }),
    "can-bit-timing": fragment("can-bit-timing", "CAN bit timing", [
      { area: "CAN bit timing", items: ["nominal/data bit timing formulas use actual clock", "prescaler/segment/SJW limits are enforced", "sample point and FD data phase are validated when supported"], required_manual_checks: ["bit timing registers", "clock divisor formula", "segment limits"] },
    ], { sequence_topics: ["CAN bit timing setting"], caution_topics: ["bit timing restriction"], required_manual_checks: ["CAN bit timing formula"] }),
    "fifo-mailbox": fragment("fifo-mailbox", "FIFO/mailbox model", [
      { area: "FIFO/mailbox programming", items: ["TX/RX FIFO or mailbox ownership is handled", "message RAM/object layout matches hardware", "overflow/underrun/error flags are handled"], required_manual_checks: ["FIFO/mailbox registers", "message object layout", "overflow/error flags"] },
    ], { sequence_topics: ["FIFO transmit receive sequence", "mailbox transmit receive sequence"], caution_topics: ["FIFO overflow restriction", "mailbox update restriction"], required_manual_checks: ["FIFO/mailbox sequence"] }),
    transceiver: fragment("transceiver", "External transceiver", [
      { area: "Transceiver and wake", items: ["transceiver/regulator/GPIO dependencies are handled", "standby/wakeup mode matches board design", "termination/IO voltage assumptions are not hardcoded"], required_manual_checks: ["transceiver enable signal", "wakeup restrictions", "external pin requirements"] },
    ], { sequence_topics: ["transceiver enable sequence"], caution_topics: ["wakeup restriction"], required_manual_checks: ["external transceiver wiring"] }),
    "usb-role": fragment("usb-role", "USB role handling", [
      { area: "USB role/OTG", items: ["host/device/OTG role is selected from DT or role switch", "ID/VBUS/session status is handled when present", "role changes are synchronized with PHY/controller state"], required_manual_checks: ["role control registers", "ID/VBUS status", "role switch sequence"] },
    ], { sequence_topics: ["USB role switch sequence", "host device mode setting"], caution_topics: ["role switch restriction"], required_manual_checks: ["USB role mode"] }),
    "usb-endpoint": fragment("usb-endpoint", "USB endpoint/FIFO", [
      { area: "Endpoint/FIFO model", items: ["endpoint/FIFO allocation matches hardware limits", "stall/reset/flush paths follow manual order", "transfer complete/error IRQs are acknowledged correctly"], required_manual_checks: ["endpoint/FIFO registers", "endpoint reset/flush sequence", "transfer status flags"] },
    ], { sequence_topics: ["USB endpoint reset sequence", "FIFO flush sequence"], caution_topics: ["endpoint reset restriction", "FIFO flush restriction"], required_manual_checks: ["USB endpoint/FIFO behavior"] }),
    "usb-phy-vbus": fragment("usb-phy-vbus", "USB PHY/VBUS", [
      { area: "USB PHY and VBUS", items: ["USB2/USB3 PHY clocks/resets are sequenced", "VBUS regulator/valid detection is handled", "PHY ready/link status polling has timeout"], required_manual_checks: ["USB PHY control", "VBUS valid/status", "PHY ready bits"] },
    ], { sequence_topics: ["USB PHY initialization", "VBUS enable sequence"], caution_topics: ["VBUS restriction", "PHY ready timeout"], required_manual_checks: ["USB PHY/VBUS sequence"] }),
    "pcie-link-training": fragment("pcie-link-training", "PCIe link training", [
      { area: "PCIe link training", items: ["LTSSM/link-up sequence is started in documented order", "link polling has timeout and recovery", "speed/width configuration matches hardware and board"], required_manual_checks: ["LTSSM control/status", "link-up bits", "speed/width restrictions"] },
    ], { sequence_topics: ["PCIe link training sequence", "LTSSM enable sequence"], caution_topics: ["link training timeout", "link speed restriction"], required_manual_checks: ["PCIe link training"] }),
    "pcie-address-window": fragment("pcie-address-window", "PCIe address windows", [
      { area: "PCIe address translation", items: ["outbound/inbound windows match DT ranges", "config/I/O/memory windows are non-overlapping", "window programming is complete before config access"], required_manual_checks: ["ATU/address window registers", "ranges mapping", "config access restrictions"] },
    ], { sequence_topics: ["address translation window setting"], caution_topics: ["address window restriction", "config access restriction"], required_manual_checks: ["PCIe address windows"] }),
    msi: fragment("msi", "MSI/interrupt domains", [
      { area: "MSI and interrupt routing", items: ["MSI domain/allocation is wired to hardware", "MSI address/data registers are programmed correctly", "legacy INTx/error IRQ routing is handled"], required_manual_checks: ["MSI registers", "interrupt routing", "error/status flags"] },
    ], { sequence_topics: ["MSI setup sequence"], caution_topics: ["MSI restriction", "interrupt routing restriction"], required_manual_checks: ["MSI/IRQ mapping"] }),
    "reset-refclk": fragment("reset-refclk", "Reset/refclk/PERST", [
      { area: "Reset and reference clock", items: ["reference clock is stable before link training", "PERST#/controller resets satisfy timing", "endpoint reset/wakeup behavior is reviewed"], required_manual_checks: ["refclk requirement", "PERST timing", "reset status bits"] },
    ], { sequence_topics: ["PERST reset sequence", "reference clock enable sequence"], caution_topics: ["PERST timing restriction", "reference clock restriction"], required_manual_checks: ["PCIe reset/refclk timing"] }),
  };
}

export async function ensureDefaultDriverProfiles(createDefault = true) {
  await fs.mkdir(DRIVER_PROFILES_DIR, { recursive: true });
  await fs.mkdir(DRIVER_PROFILE_FRAGMENTS_DIR, { recursive: true });
  if (!createDefault) return;
  const fragments = defaultDriverProfileFragments();
  for (const [name, fragment] of Object.entries(fragments)) {
    const filePath = safeDriverProfileFragmentPath(name);
    if (!(await pathExists(filePath))) {
      await atomicWriteJson(filePath, fragment);
    }
  }
  const profiles = defaultDriverProfiles();
  for (const [name, profile] of Object.entries(profiles)) {
    const filePath = safeDriverProfilePath(name);
    if (!(await pathExists(filePath))) {
      await atomicWriteJson(filePath, profile);
    }
  }
}

export async function listDriverProfiles(options = {}) {
  await ensureDefaultDriverProfiles(options.createDefault !== false);
  const dirents = await fs.readdir(DRIVER_PROFILES_DIR, { withFileTypes: true }).catch(() => []);
  const profiles = [];
  for (const entry of dirents) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
    const name = entry.name.replace(/\.json$/i, "");
    const filePath = safeDriverProfilePath(name);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const data = JSON.parse(raw);
      profiles.push({
        name,
        path: filePath,
        title: data.title || name,
        subsystem: data.subsystem || "unknown",
        driver_family: data.driver_family || "unknown",
        extends: data.extends || "",
        fragments: normalizeProfileNameArray(data.fragments || []),
        checklistAreas: Array.isArray(data.checklist) ? data.checklist.length : 0,
      });
    } catch (error) {
      profiles.push({ name, path: filePath, error: error instanceof Error ? error.message : String(error) });
    }
  }
  profiles.sort((a, b) => a.name.localeCompare(b.name));
  return profiles;
}

export async function validateDriverProfileCatalog(options = {}) {
  await ensureDefaultDriverProfiles(options.createDefault !== false);
  const failures = [];
  const profiles = await listDriverProfiles({ createDefault: false });

  const fragmentDirents = await fs.readdir(DRIVER_PROFILE_FRAGMENTS_DIR, { withFileTypes: true }).catch(() => []);
  for (const entry of fragmentDirents) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
    const name = entry.name.replace(/\.json$/i, "");
    try {
      await loadDriverProfileFragmentByName(name);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  for (const profile of profiles) {
    if (profile.error) {
      failures.push(`Invalid driver profile ${profile.name}: ${profile.error}`);
      continue;
    }
    try {
      await resolveDriverProfile({ profile: profile.name, createDefault: false });
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    ok: failures.length === 0,
    profiles: profiles.length,
    fragments: fragmentDirents.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json")).length,
    failures,
  };
}

export async function loadDriverProfileByName(name) {
  const profileName = sanitizeDriverProfileName(name);
  const filePath = safeDriverProfilePath(profileName);
  if (!(await pathExists(filePath))) return null;
  const raw = await fs.readFile(filePath, "utf-8");
  const profile = JSON.parse(raw);
  if (profile.schemaVersion !== DRIVER_PROFILE_SCHEMA_VERSION) {
    throw new Error(`Unsupported driver profile schemaVersion in ${profileName}: ${profile.schemaVersion}`);
  }
  const validation = validateDriverProfileObject(profile, profileName);
  if (!validation.ok) throw new Error(`Invalid driver profile ${profileName}: ${validation.errors.join("; ")}`);
  return { ...profile, _profileName: profileName, _profilePath: filePath };
}

export async function loadDriverProfileFragmentByName(name) {
  const fragmentName = sanitizeDriverProfileName(name);
  const filePath = safeDriverProfileFragmentPath(fragmentName);
  if (!(await pathExists(filePath))) throw new Error(`Missing driver profile fragment: ${fragmentName}`);
  const raw = await fs.readFile(filePath, "utf-8");
  const fragment = JSON.parse(raw);
  if (fragment.schemaVersion !== DRIVER_PROFILE_SCHEMA_VERSION) {
    throw new Error(`Unsupported driver profile fragment schemaVersion in ${fragmentName}: ${fragment.schemaVersion}`);
  }
  const validation = validateDriverProfileFragmentObject(fragment, fragmentName);
  if (!validation.ok) throw new Error(`Invalid driver profile fragment ${fragmentName}: ${validation.errors.join("; ")}`);
  return { ...fragment, _fragmentName: fragmentName, _fragmentPath: filePath };
}

export function mergeUniqueStrings(...arrays) {
  return [...new Set(arrays.flat().map((item) => String(item || "").trim()).filter(Boolean))];
}

export function mergeDriverProfiles(base, overlay) {
  if (!base) return overlay;
  if (!overlay) return base;
  return {
    ...base,
    ...overlay,
    checklist: [...(base.checklist || []), ...(overlay.checklist || [])],
    source_review_steps: mergeUniqueStrings(base.source_review_steps || [], overlay.source_review_steps || []),
    required_manual_checks: mergeUniqueStrings(base.required_manual_checks || [], overlay.required_manual_checks || []),
    recommended_tools: mergeUniqueStrings(base.recommended_tools || [], overlay.recommended_tools || []),
    sequence_topics: mergeUniqueStrings(base.sequence_topics || [], overlay.sequence_topics || []),
    caution_topics: mergeUniqueStrings(base.caution_topics || [], overlay.caution_topics || []),
    evidence_topics: mergeUniqueStrings(base.evidence_topics || [], overlay.evidence_topics || []),
    fragments: mergeUniqueStrings(base.fragments || [], overlay.fragments || []),
    _fragmentStack: mergeUniqueStrings(base._fragmentStack || [], overlay._fragmentStack || []),
    _fragmentPaths: mergeUniqueStrings(base._fragmentPaths || [], overlay._fragmentPaths || []),
    _profileStack: [...(base._profileStack || [base._profileName || base.profile].filter(Boolean)), overlay._profileName || overlay.profile].filter(Boolean),
    _profilePaths: [...(base._profilePaths || [base._profilePath].filter(Boolean)), overlay._profilePath].filter(Boolean),
  };
}

export function profileShell(profile) {
  return {
    ...profile,
    checklist: [],
    source_review_steps: [],
    required_manual_checks: [],
    recommended_tools: [],
    sequence_topics: [],
    caution_topics: [],
    evidence_topics: [],
    fragments: [],
    _profileStack: [profile._profileName || profile.profile].filter(Boolean),
    _profilePaths: [profile._profilePath].filter(Boolean),
    _fragmentStack: [],
    _fragmentPaths: [],
  };
}

export function mergeDriverProfileFragment(base, fragment) {
  return {
    ...base,
    checklist: [...(base.checklist || []), ...(fragment.checklist || [])],
    source_review_steps: mergeUniqueStrings(base.source_review_steps || [], fragment.source_review_steps || []),
    required_manual_checks: mergeUniqueStrings(base.required_manual_checks || [], fragment.required_manual_checks || []),
    recommended_tools: mergeUniqueStrings(base.recommended_tools || [], fragment.recommended_tools || []),
    sequence_topics: mergeUniqueStrings(base.sequence_topics || [], fragment.sequence_topics || []),
    caution_topics: mergeUniqueStrings(base.caution_topics || [], fragment.caution_topics || []),
    evidence_topics: mergeUniqueStrings(base.evidence_topics || [], fragment.evidence_topics || []),
    _fragmentStack: mergeUniqueStrings(base._fragmentStack || [], [fragment._fragmentName || fragment.fragment]),
    _fragmentPaths: mergeUniqueStrings(base._fragmentPaths || [], [fragment._fragmentPath].filter(Boolean)),
  };
}

export async function mergeDriverProfileFragments(base, fragmentNames, loadFragment) {
  let merged = base;
  for (const fragmentName of normalizeProfileNameArray(fragmentNames)) {
    if ((merged._fragmentStack || []).includes(fragmentName)) continue;
    const fragment = await loadFragment(fragmentName);
    merged = mergeDriverProfileFragment(merged, fragment);
  }
  return merged;
}

export async function resolveDriverProfile(options = {}) {
  await ensureDefaultDriverProfiles(options.createDefault !== false);
  const candidates = driverProfileCandidates(options);
  const warnings = [];
  const loaded = new Map();
  const loadedFragments = new Map();

  async function loadFragment(name) {
    const safeName = sanitizeDriverProfileName(name);
    if (loadedFragments.has(safeName)) return loadedFragments.get(safeName);
    const fragment = await loadDriverProfileFragmentByName(safeName);
    loadedFragments.set(safeName, fragment);
    return fragment;
  }

  async function loadWithExtends(name, stack = []) {
    const safeName = sanitizeDriverProfileName(name);
    if (loaded.has(safeName)) return loaded.get(safeName);
    if (stack.includes(safeName)) throw new Error(`Circular driver profile extends: ${[...stack, safeName].join(" -> ")}`);
    const profile = await loadDriverProfileByName(safeName);
    if (!profile) return null;
    let merged = null;
    if (profile.extends) {
      const parent = await loadWithExtends(profile.extends, [...stack, safeName]);
      if (parent) merged = parent;
      else warnings.push(`Profile ${safeName} extends missing profile ${profile.extends}`);
    }
    if (!merged) {
      merged = profileShell(profile);
    }
    merged = await mergeDriverProfileFragments(merged, profile.fragments || [], loadFragment);
    merged = mergeDriverProfiles(merged, profile);
    if (!profile.extends) {
      merged._profileStack = [profile._profileName || profile.profile].filter(Boolean);
      merged._profilePaths = [profile._profilePath].filter(Boolean);
    } else {
      merged._profileStack = [...new Set([...(merged._profileStack || []), profile._profileName || profile.profile].filter(Boolean))];
      merged._profilePaths = [...new Set([...(merged._profilePaths || []), profile._profilePath].filter(Boolean))];
    }
    loaded.set(safeName, merged);
    return merged;
  }

  for (const candidate of candidates) {
    const profile = await loadWithExtends(candidate);
    if (profile) return { profile, selected: candidate, candidates, warnings };
  }

  throw new Error(`No driver profile found. Tried: ${candidates.join(", ")}`);
}

export function formatDriverProfilesList(profiles) {
  if (!profiles.length) {
    return `No driver profiles found. Directory: ${DRIVER_PROFILES_DIR}`;
  }
  const lines = [
    "Driver profiles",
    `Directory: ${DRIVER_PROFILES_DIR}`,
    "",
  ];
  for (const profile of profiles) {
    lines.push(`- ${profile.name}`);
    lines.push(`  title: ${profile.title || "unknown"}`);
    lines.push(`  subsystem: ${profile.subsystem || "unknown"}`);
    lines.push(`  driver_family: ${profile.driver_family || "unknown"}`);
    if (profile.extends) lines.push(`  extends: ${profile.extends}`);
    if ((profile.fragments || []).length) lines.push(`  fragments: ${profile.fragments.join(", ")}`);
    lines.push(`  checklist areas: ${profile.checklistAreas ?? "unknown"}`);
    if (profile.error) lines.push(`  error: ${profile.error}`);
    lines.push(`  path: ${profile.path}`);
  }
  return lines.join("\n");
}

export async function buildDriverCompletenessChecklist(filename, options = {}) {
  ensurePdfFilename(filename);
  const task = String(options.task || "").trim();
  const subsystemHint = String(options.subsystem || "").trim();
  const driverFamily = String(options.driverFamily || "").trim();
  const explicitProfile = String(options.profile || "").trim();

  let moduleProfile = null;
  try {
    moduleProfile = await getModuleProfile(filename, {
      moduleType: subsystemHint,
      focus: task || "driver completeness checklist",
      refresh: false,
    });
  } catch {
    moduleProfile = null;
  }

  const inferredSubsystem = normalizeDriverSubsystemHint(subsystemHint || moduleProfile?.moduleType || "generic");
  const normalizedDriverFamily = normalizeDriverFamilyHint(driverFamily);
  const resolved = await resolveDriverProfile({
    profile: explicitProfile,
    subsystem: inferredSubsystem,
    driverFamily: normalizedDriverFamily,
    createDefault: options.createDefault !== false,
  });

  const profile = resolved.profile;
  const evidencePackCall = `build_driver_evidence_pack(filename="${filename}", module_type="${inferredSubsystem}", focus="${(task || profile.title || "driver completeness review").replace(/"/g, "'")}", mode="adaptive")`;
  const driverTaskCall = `prepare_driver_task(filename="${filename}", task="${(task || profile.title || "driver completeness review").replace(/"/g, "'")}", module_type="${inferredSubsystem}")`;
  const visualGate = await collectDriverReviewVisualEvidence(filename, {
    include: options.includeVisualEvidence !== false,
    filter: options.visualFilter || task,
    task,
    moduleType: inferredSubsystem,
    topK: 8,
    status: options.visualStatus || "all",
    gate: options.visualGate || "advisory",
    requireVerified: options.visualRequireVerified,
  });
  const visualEvidence = visualGate.entries;

  return {
    filename,
    createdAt: new Date().toISOString(),
    task,
    subsystem: inferredSubsystem,
    driverFamily: normalizedDriverFamily,
    explicitProfile,
    selectedProfile: resolved.selected,
    triedProfiles: resolved.candidates,
    warnings: [...resolved.warnings, ...visualEvidenceGateWarnings(visualGate)],
    profile,
    moduleProfile,
    requiredManualChecks: profile.required_manual_checks || [],
    sourceReviewSteps: profile.source_review_steps || [],
    recommendedTools: profile.recommended_tools || [],
    visualEvidence,
    visualEvidenceGate: visualGate,
    suggestedMcpCalls: [
      `doctor(filename="${filename}")`,
      driverTaskCall,
      evidencePackCall,
      `visual_evidence_report(filename="${filename}", filter="${quoteForPromptCall(options.visualFilter || task || inferredSubsystem)}", include_entries=true)`,
      `driver_completeness_checklist(filename="${filename}", subsystem="${inferredSubsystem}", driver_family="${normalizedDriverFamily || profile.driver_family || ""}")`,
      `verify_register_usage(filename="${filename}", register="<source-register>", operation="<source-operation>", bitfields=[...], access_type="<access-pattern>", intent="<intent>")`,
      `get_sequence(filename="${filename}", topic="<init/start/stop/clear/reset/irq/error topic>")`,
      `get_cautions_for_register(filename="${filename}", register="<source-register>")`,
    ],
  };
}

export function buildDriverCompletenessContract(checklist) {
  const evidence = [];
  evidence.push(makeEvidence({
    source: "driver-profile-json",
    evidenceType: "checklist-profile",
    quote: `${checklist.profile.title || checklist.profile.profile} loaded from ${(checklist.profile._profileStack || []).join(" -> ")}; fragments=${(checklist.profile._fragmentStack || []).join(", ") || "none"}`,
    confidence: "high",
    name: checklist.selectedProfile,
    tool: "driver_completeness_checklist",
  }));
  if (checklist.moduleProfile) {
    evidence.push(makeEvidence({
      source: "module-profile-index",
      evidenceType: "module-profile",
      quote: `moduleType=${checklist.moduleProfile.moduleType}, linuxSubsystem=${checklist.moduleProfile.linuxSubsystem}, confidence=${checklist.moduleProfile.confidence?.level || "unknown"}`,
      confidence: checklist.moduleProfile.confidence?.score || "medium",
      name: checklist.moduleProfile.moduleType,
      tool: "driver_completeness_checklist",
    }));
  }
  evidence.push(...visualEvidenceToEvidenceContractItems(checklist.visualEvidence || [], "driver_completeness_checklist"));

  const inference = [
    makeInference({
      statement: `Selected driver completeness profile: ${checklist.selectedProfile}`,
      basis: `candidates: ${checklist.triedProfiles.join(", ")}`,
      confidence: "medium",
      risk: "Profile selection is a workflow heuristic, not manual evidence.",
    }),
    makeInference({
      statement: `Subsystem under review: ${checklist.subsystem}`,
      basis: checklist.explicitProfile || checklist.subsystem || checklist.moduleProfile?.moduleType || "fallback generic profile",
      confidence: checklist.subsystem === "generic" ? "low" : "medium",
      risk: "The VS Code agent must confirm subsystem from actual source files.",
    }),
  ];

  const needsVerification = [
    makeNeedsVerification({
      item: "Each checklist item against the real source files",
      reason: "The MCP server does not read the source repository; it only supplies the review checklist and manual evidence workflow.",
      suggestedTools: ["verify_register_usage(...) for each register operation", "build_driver_evidence_pack(..., mode=adaptive)", "get_sequence(...)", "get_cautions_for_register(...)"],
    }),
    makeNeedsVerification({
      item: "All register offsets, bit fields, clear semantics, and operation ordering",
      reason: "Completeness checklist identifies review obligations; exact hardware facts must be verified from manual evidence.",
      suggestedTools: ["extract_register_table(...)", "extract_bitfield_table(...)", "verify_register_usage(...)"],
    }),
  ];

  needsVerification.push(...visualEvidenceGateNeedsVerification(checklist.visualEvidenceGate || {}, checklist.filename));

  return makeEvidenceContract({
    tool: "driver_completeness_checklist",
    filename: checklist.filename,
    query: checklist.task || checklist.profile.title || checklist.selectedProfile,
    evidence,
    inference,
    needsVerification,
    warnings: checklist.warnings || [],
    recommendedNextTools: checklist.suggestedMcpCalls || [],
  });
}

export function formatDriverCompletenessChecklist(checklist) {
  const profile = checklist.profile;
  const lines = [];
  lines.push("Driver Completeness Checklist");
  lines.push(`File: ${checklist.filename}`);
  lines.push(`Created: ${checklist.createdAt}`);
  lines.push(`Task: ${checklist.task || "not specified"}`);
  lines.push(`Subsystem: ${checklist.subsystem}`);
  lines.push(`Driver family: ${checklist.driverFamily || profile.driver_family || "not specified"}`);
  lines.push(`Selected profile: ${checklist.selectedProfile}`);
  lines.push(`Profile stack: ${(profile._profileStack || [profile.profile]).join(" -> ")}`);
  if ((profile._fragmentStack || []).length) lines.push(`Profile fragments: ${profile._fragmentStack.join(", ")}`);
  if ((profile._profilePaths || []).length) lines.push(`Profile files: ${(profile._profilePaths || []).join(" | ")}`);
  if ((profile._fragmentPaths || []).length) lines.push(`Fragment files: ${(profile._fragmentPaths || []).join(" | ")}`);
  if ((checklist.triedProfiles || []).length) lines.push(`Profile candidates tried: ${checklist.triedProfiles.join(", ")}`);
  for (const warning of checklist.warnings || []) lines.push(`Warning: ${warning}`);
  lines.push("");

  lines.push("1. Profile description");
  lines.push(`- ${profile.title || profile.profile}`);
  if (profile.description) lines.push(`- ${profile.description}`);
  if (checklist.moduleProfile) {
    lines.push(`- Manual/module profile: ${checklist.moduleProfile.moduleType}; likely subsystem: ${checklist.moduleProfile.linuxSubsystem}; confidence: ${checklist.moduleProfile.confidence?.level || "unknown"}`);
  } else {
    lines.push("- Manual/module profile: unavailable; run get_module_profile if needed.");
  }
  lines.push("");

  lines.push("2. Completeness matrix");
  if ((profile.checklist || []).length) {
    for (const [areaIndex, area] of profile.checklist.entries()) {
      lines.push(`${areaIndex + 1}. ${area.area || "Unnamed area"}`);
      for (const item of area.items || []) lines.push(`   - [ ] ${item}`);
      if ((area.required_manual_checks || []).length) {
        lines.push(`   Manual checks: ${(area.required_manual_checks || []).join("; ")}`);
      }
    }
  } else {
    lines.push("- No checklist items in selected profile.");
  }
  lines.push("");

  lines.push("3. Required manual checks");
  for (const item of checklist.requiredManualChecks || []) lines.push(`- ${item}`);
  lines.push("");

  lines.push("4. Persisted visual evidence relevant to this checklist");
  lines.push(...formatDriverVisualEvidenceSection(checklist.visualEvidence || [], checklist.filename).slice(1));
  lines.push("");

  lines.push("4b. Visual evidence verification gate");
  lines.push(...formatVisualEvidenceGateSection(checklist.visualEvidenceGate || {}, checklist.filename).slice(1));
  lines.push("");

  lines.push("5. Required source-code review steps for VS Code agent");
  for (const item of checklist.sourceReviewSteps || []) lines.push(`- ${item}`);
  lines.push("");

  lines.push("6. Recommended MCP workflow");
  for (const call of checklist.suggestedMcpCalls || []) lines.push(`- ${call}`);
  lines.push("");

  lines.push("8. Approval rule");
  lines.push("- Do not mark a checklist item complete based only on this profile.");
  lines.push("- The VS Code agent must inspect source code and map each hardware operation to manual evidence.");
  lines.push("- Use verify_register_usage for every register write/read/poll/reset/status-clear operation found in source.");
  lines.push("- Resolve needsVerification items before claiming driver completeness.");

  return appendEvidenceContract(lines.join("\n"), buildDriverCompletenessContract(checklist));
}


export function flattenChecklistRequirements(profile) {
  const rows = [];
  for (const [areaIndex, area] of (profile.checklist || []).entries()) {
    for (const [itemIndex, item] of (area.items || []).entries()) {
      const text = String(item || "").trim();
      if (!text) continue;
      rows.push({ id: `A${areaIndex + 1}.${itemIndex + 1}`, area: area.area || "Unnamed area", item: text, requiredManualChecks: area.required_manual_checks || [] });
    }
  }
  return rows;
}

export function tokenizeRequirementText(text) {
  const normalized = normalizeForSearch(text);
  const rawTokens = normalized.split(/\s+/).filter((token) => token.length > 1);
  const stop = new Set(["and", "or", "the", "a", "an", "is", "are", "be", "to", "of", "in", "on", "for", "with", "as", "by", "if", "when", "only", "correct", "handled", "implemented", "support", "supports", "used", "uses", "match", "matches", "driver", "source", "code", "path", "required", "needed", "should", "must"]);
  const aliases = new Map([
    ["irq", ["interrupt", "interrupts", "isr"]], ["interrupt", ["irq", "isr"]],
    ["clk", ["clock", "clocks"]], ["clock", ["clk", "clocks"]],
    ["reset", ["rst", "resets"]], ["pm", ["runtime", "suspend", "resume"]],
    ["phy", ["phylink", "mdio", "link"]], ["mdio", ["phy", "mii"]],
    ["dma", ["descriptor", "ring", "rx", "tx"]], ["rx", ["receive", "receiver"]], ["tx", ["transmit", "transmitter"]],
    ["w1c", ["write", "one", "clear"]], ["w0c", ["write", "zero", "clear"]],
    ["dt", ["device", "tree", "dts"]], ["of", ["device", "tree"]],
    ["mmio", ["ioremap", "resource", "reg"]], ["ioremap", ["mmio", "resource"]],
    ["stmmac", ["dwmac", "plat", "platform"]], ["dwmac", ["stmmac"]],
  ]);
  const out = new Set();
  for (const token of rawTokens) {
    if (stop.has(token)) continue;
    out.add(token);
    if (aliases.has(token)) for (const alias of aliases.get(token)) out.add(alias);
  }
  return [...out];
}

export function scoreRequirementAgainstEvidence(requirement, evidenceText) {
  const reqTokens = tokenizeRequirementText(requirement);
  const evidenceTokens = new Set(tokenizeRequirementText(evidenceText));
  const normalizedReq = normalizeForSearch(requirement);
  const normalizedEvidence = normalizeForSearch(evidenceText);
  if (!reqTokens.length || !normalizedEvidence) return { score: 0, hits: [], coverage: 0 };
  const hits = reqTokens.filter((token) => evidenceTokens.has(token) || normalizedEvidence.includes(token));
  let score = Math.round((hits.length / reqTokens.length) * 100);
  if (normalizedEvidence.includes(normalizedReq)) score += 80;
  for (const phrase of ["runtime pm", "device tree", "phy mode", "fixed link", "mac address", "flow control", "checksum", "interrupt", "reset", "clock", "w1c", "write one to clear", "read modify write", "descriptor", "ring", "mdio", "stmmac", "platform data"]) {
    if (normalizedReq.includes(phrase) && normalizedEvidence.includes(phrase)) score += 18;
  }
  return { score: Math.min(score, 180), hits: hits.slice(0, 20), coverage: Math.round((hits.length / reqTokens.length) * 100) };
}

export function bestRequirementEvidence(requirement, evidenceItems) {
  let best = { score: 0, hits: [], coverage: 0, evidence: "" };
  for (const item of evidenceItems || []) {
    const score = scoreRequirementAgainstEvidence(requirement, item);
    if (score.score > best.score) best = { ...score, evidence: item };
  }
  return best;
}

export function classifyRequirementStatus(requirement, implementedEvidence, missingEvidence = []) {
  const missing = bestRequirementEvidence(requirement.item, missingEvidence);
  if (missing.score >= 70) return { ...requirement, status: "missing", confidence: "high", matchScore: missing.score, matchCoverage: missing.coverage, matchedEvidence: missing.evidence, matchedTokens: missing.hits, reason: "explicitly listed as missing/unsupported by source review input" };
  const best = bestRequirementEvidence(requirement.item, implementedEvidence);
  if (best.score >= 85 || best.coverage >= 60) return { ...requirement, status: "implemented_candidate", confidence: best.score >= 120 || best.coverage >= 75 ? "high" : "medium", matchScore: best.score, matchCoverage: best.coverage, matchedEvidence: best.evidence, matchedTokens: best.hits, reason: "source-review input appears to cover this checklist item" };
  if (best.score >= 45 || best.coverage >= 35) return { ...requirement, status: "unclear", confidence: "medium", matchScore: best.score, matchCoverage: best.coverage, matchedEvidence: best.evidence, matchedTokens: best.hits, reason: "partial token/phrase overlap; source evidence is not specific enough" };
  return { ...requirement, status: "missing_or_not_reported", confidence: "low", matchScore: best.score, matchCoverage: best.coverage, matchedEvidence: best.evidence, matchedTokens: best.hits, reason: "no source-review evidence was provided for this checklist item" };
}

export function normalizeRegisterOperationsForComparison(ops) {
  if (!Array.isArray(ops)) return [];
  return ops.map((op) => {
    if (typeof op === "string") return { register: "", operation: op, bitfields: [], access_type: "auto", intent: "auto", source_snippet: "" };
    return { register: String(op.register || "").trim(), operation: String(op.operation || "").trim(), bitfields: normalizeStringArray(op.bitfields), access_type: String(op.access_type || op.accessType || "auto").trim() || "auto", intent: String(op.intent || "auto").trim() || "auto", source_snippet: String(op.source_snippet || op.sourceSnippet || "").trim() };
  }).filter((op) => op.register || op.operation || op.source_snippet);
}

export function buildRequirementSuggestedTools(filename, requirement) {
  const tools = [];
  const text = normalizeForSearch(`${requirement.area} ${requirement.item}`);
  const item = requirement.item.replace(/"/g, "'");
  const topic = `${requirement.area}: ${requirement.item}`.replace(/"/g, "'");
  if (/register|offset|bit|mask|access|reserved|clear|w1c|w0c|status|read|write/.test(text)) tools.push(`verify_register_usage(filename="${filename}", register="<source-register>", operation="${item}", access_type="auto", intent="auto")`);
  if (/sequence|start|stop|enable|disable|reset|init|initialize|operation|order/.test(text)) tools.push(`get_sequence(filename="${filename}", topic="${topic}")`);
  if (/caution|restriction|reserved|clear|write|only|undefined|prohibited/.test(text)) tools.push(`find_caution(filename="${filename}", topic="${topic}")`);
  if (/interrupt|irq|status|error|clear/.test(text)) tools.push(`hybrid_search_pdf(filename="${filename}", query="${topic}", intent="irq")`);
  if (!tools.length) tools.push(`hybrid_search_pdf(filename="${filename}", query="${topic}", intent="auto")`);
  return tools.slice(0, 4);
}

export async function compareDriverRequirements(filename, options = {}) {
  ensurePdfFilename(filename);
  const implementedFeatures = normalizeStringArray(options.implementedFeatures);
  const sourceObservations = normalizeStringArray(options.sourceObservations);
  const missingFeatures = normalizeStringArray(options.missingFeatures);
  const sourceFiles = normalizeStringArray(options.sourceFiles);
  const sourceSummary = String(options.sourceSummary || "").trim();
  const registerOperations = normalizeRegisterOperationsForComparison(options.registerOperations);
  const checklist = await buildDriverCompletenessChecklist(filename, { subsystem: String(options.subsystem || "").trim(), driverFamily: String(options.driverFamily || "").trim(), profile: String(options.profile || "").trim(), task: String(options.task || "").trim() || "compare source features against driver requirements", createDefault: options.createDefault !== false });
  const requirements = flattenChecklistRequirements(checklist.profile);
  const implementedEvidence = [...implementedFeatures, ...sourceObservations, sourceSummary, ...registerOperations.map((op) => [op.register, op.operation, ...(op.bitfields || []), op.access_type, op.intent, op.source_snippet].join("\n"))].filter(Boolean);
  const compared = requirements.map((req) => classifyRequirementStatus(req, implementedEvidence, missingFeatures));
  for (const req of compared) req.suggestedTools = buildRequirementSuggestedTools(filename, req);
  const implemented = compared.filter((req) => req.status === "implemented_candidate");
  const unclear = compared.filter((req) => req.status === "unclear");
  const missing = compared.filter((req) => req.status === "missing" || req.status === "missing_or_not_reported");
  const manualVerification = new Map();
  for (const req of compared) {
    for (const check of req.requiredManualChecks || []) {
      const key = normalizeForSearch(check);
      if (!manualVerification.has(key)) manualVerification.set(key, { check, requirements: [] });
      manualVerification.get(key).requirements.push(req.id);
    }
  }
  for (const check of checklist.requiredManualChecks || []) {
    const key = normalizeForSearch(check);
    if (!manualVerification.has(key)) manualVerification.set(key, { check, requirements: [] });
  }
  const operationVerificationCalls = registerOperations.map((op) => {
    const bits = (op.bitfields || []).length ? `[${op.bitfields.map((b) => `"${String(b).replace(/"/g, "'")}"`).join(", ")}]` : "[]";
    return { register: op.register, operation: op.operation, call: `verify_register_usage(filename="${filename}", register="${(op.register || "<source-register>").replace(/"/g, "'")}", operation="${(op.operation || "<source-operation>").replace(/"/g, "'")}", bitfields=${bits}, access_type="${op.access_type || "auto"}", intent="${op.intent || "auto"}")` };
  });
  const totals = { requirements: compared.length, implemented: implemented.length, unclear: unclear.length, missing: missing.length, registerOperations: registerOperations.length };
  const completenessPercent = totals.requirements ? Math.round((totals.implemented / totals.requirements) * 100) : 0;
  const reviewStatus = totals.missing === 0 && totals.unclear === 0 ? "complete_candidate_needs_manual_verification" : totals.implemented === 0 ? "insufficient_source_evidence" : "partial_or_unclear";
  const visualGate = await collectDriverReviewVisualEvidence(filename, {
    include: options.includeVisualEvidence !== false,
    filter: options.visualFilter || `${checklist.task || ""} ${sourceSummary}`,
    task: checklist.task,
    moduleType: checklist.subsystem,
    sourceFiles,
    registers: registerOperations.map((op) => op.register).filter(Boolean),
    topK: 8,
    status: options.visualStatus || "all",
    gate: options.visualGate || "advisory",
    requireVerified: options.visualRequireVerified,
  });
  const visualEvidence = visualGate.entries;
  const warnings = [
    ...(checklist.warnings || []),
    ...visualEvidenceDriverWarnings(visualEvidence),
    "This comparison uses source-review input provided by the AI agent; the MCP server does not read the repository.",
    "implemented_candidate means source evidence appears to cover the item; it is not approved until register operations/manual facts are verified.",
  ];
  return { filename, createdAt: new Date().toISOString(), task: checklist.task, subsystem: checklist.subsystem, driverFamily: checklist.driverFamily || checklist.profile.driver_family || "", selectedProfile: checklist.selectedProfile, profile: checklist.profile, profileStack: checklist.profile._profileStack || [], sourceFiles, sourceSummary, implementedFeatures, sourceObservations, missingFeatures, registerOperations, requirements: compared, implemented, unclear, missing, manualVerification: [...manualVerification.values()], operationVerificationCalls, visualEvidence, totals, completenessPercent, reviewStatus, warnings };
}

export function buildCompareDriverRequirementsContract(comparison) {
  const evidence = [makeEvidence({ source: "driver-profile-json", evidenceType: "checklist-profile", quote: `${comparison.selectedProfile}: ${(comparison.profileStack || []).join(" -> ") || comparison.profile?.title || "profile"}`, confidence: "high", name: comparison.selectedProfile, tool: "compare_driver_requirements" })];
  for (const item of (comparison.implemented || []).slice(0, 10)) evidence.push(makeEvidence({ source: "source-review-input", evidenceType: "implemented-feature-candidate", quote: `${item.id} ${item.area}: ${item.item}; matched: ${item.matchedEvidence || "n/a"}`, confidence: item.confidence, name: item.id, tool: "compare_driver_requirements" }));
  const inference = [makeInference({ statement: `Completeness candidate score: ${comparison.completenessPercent}% (${comparison.totals.implemented}/${comparison.totals.requirements})`, basis: "token/phrase matching between profile checklist and source-review input", confidence: "medium", risk: "This is a heuristic coverage estimate, not proof of driver correctness." }), makeInference({ statement: `Review status: ${comparison.reviewStatus}`, basis: `missing=${comparison.totals.missing}, unclear=${comparison.totals.unclear}`, confidence: "medium", risk: "A human/agent must verify source operations against manual evidence before approval." })];
  const needsVerification = [];
  for (const item of [...(comparison.unclear || []), ...(comparison.missing || [])].slice(0, 14)) needsVerification.push(makeNeedsVerification({ item: `${item.id} ${item.area}: ${item.item}`, reason: item.reason, suggestedTools: item.suggestedTools || [] }));
  if ((comparison.operationVerificationCalls || []).length) needsVerification.push(makeNeedsVerification({ item: "All register operations supplied by source review", reason: "Register operations must be verified against register/bitfield/sequence/caution evidence before approving the driver.", suggestedTools: comparison.operationVerificationCalls.slice(0, 8).map((op) => op.call) }));
  needsVerification.push(...visualEvidenceGateNeedsVerification(comparison.visualEvidenceGate || {}, comparison.filename));
  return makeEvidenceContract({ tool: "compare_driver_requirements", filename: comparison.filename, query: comparison.task || comparison.selectedProfile, evidence, inference, needsVerification, warnings: comparison.warnings || [], recommendedNextTools: [`driver_completeness_checklist(filename="${comparison.filename}", subsystem="${comparison.subsystem}", driver_family="${comparison.driverFamily}")`, `build_driver_evidence_pack(filename="${comparison.filename}", module_type="${comparison.subsystem}", focus="${String(comparison.task || "driver completeness review").replace(/"/g, "'")}", mode="adaptive")`, ...visualEvidenceGateSuggestedCalls(comparison.filename, comparison.visualEvidenceGate || {}), ...(comparison.operationVerificationCalls || []).slice(0, 6).map((op) => op.call)] });
}

export function formatRequirementRows(rows, limit = 80) {
  const lines = [];
  if (!rows.length) return ["- none"];
  for (const item of rows.slice(0, limit)) {
    lines.push(`- ${item.id} [${item.status}; ${item.confidence}; score=${item.matchScore}; coverage=${item.matchCoverage}%] ${item.area}: ${item.item}`);
    if (item.matchedEvidence) lines.push(`  matched source evidence: ${item.matchedEvidence}`);
    if ((item.requiredManualChecks || []).length) lines.push(`  manual checks: ${item.requiredManualChecks.join("; ")}`);
    if ((item.suggestedTools || []).length) {
      lines.push("  suggested MCP calls:");
      for (const call of item.suggestedTools.slice(0, 3)) lines.push(`    - ${call}`);
    }
  }
  if (rows.length > limit) lines.push(`- ... ${rows.length - limit} more not shown`);
  return lines;
}

export function formatCompareDriverRequirements(comparison) {
  const lines = [];
  lines.push("Driver Requirements Comparison");
  lines.push(`File: ${comparison.filename}`);
  lines.push(`Created: ${comparison.createdAt}`);
  lines.push(`Task: ${comparison.task || "not specified"}`);
  lines.push(`Subsystem: ${comparison.subsystem}`);
  lines.push(`Driver family: ${comparison.driverFamily || "not specified"}`);
  lines.push(`Selected profile: ${comparison.selectedProfile}`);
  lines.push(`Profile stack: ${(comparison.profileStack || []).join(" -> ") || comparison.selectedProfile}`);
  lines.push(`Review status: ${comparison.reviewStatus}`);
  lines.push(`Completeness candidate score: ${comparison.completenessPercent}%`);
  lines.push(`Summary: implemented=${comparison.totals.implemented}, unclear=${comparison.totals.unclear}, missing/not-reported=${comparison.totals.missing}, total=${comparison.totals.requirements}`);
  if ((comparison.sourceFiles || []).length) lines.push(`Source files inspected: ${comparison.sourceFiles.join(", ")}`);
  for (const warning of comparison.warnings || []) lines.push(`Warning: ${warning}`);
  lines.push("");
  lines.push("1. Source input received");
  lines.push(`- implemented_features: ${(comparison.implementedFeatures || []).length}`);
  lines.push(`- source_observations: ${(comparison.sourceObservations || []).length}`);
  lines.push(`- register_operations: ${(comparison.registerOperations || []).length}`);
  if (comparison.sourceSummary) lines.push(`- source_summary: ${compactText(comparison.sourceSummary, 1000)}`);
  lines.push("");
  lines.push("2. Implemented candidates");
  lines.push(...formatRequirementRows(comparison.implemented || []));
  lines.push("");
  lines.push("3. Unclear / partially covered requirements");
  lines.push(...formatRequirementRows(comparison.unclear || []));
  lines.push("");
  lines.push("4. Missing or not reported requirements");
  lines.push(...formatRequirementRows(comparison.missing || []));
  lines.push("");
  lines.push("5. Relevant persisted visual evidence");
  lines.push(...formatDriverVisualEvidenceSection(comparison.visualEvidence || [], comparison.filename).slice(1));
  lines.push("");

  lines.push("5b. Visual evidence verification gate");
  lines.push(...formatVisualEvidenceGateSection(comparison.visualEvidenceGate || {}, comparison.filename).slice(1));
  lines.push("");

  lines.push("6. Required manual verification topics");
  if ((comparison.manualVerification || []).length) for (const item of comparison.manualVerification) lines.push(`- ${item.check}${(item.requirements || []).length ? ` [requirements: ${item.requirements.slice(0, 12).join(", ")}]` : ""}`); else lines.push("- none");
  lines.push("");
  lines.push("7. Register operation verification calls");
  if ((comparison.operationVerificationCalls || []).length) for (const op of comparison.operationVerificationCalls) lines.push(`- ${op.call}`); else lines.push("- No register_operations were supplied. The VS Code agent should extract writel/readl/regmap/poll operations and rerun this tool.");
  lines.push("");
  lines.push("8. Approval rule");
  lines.push("- implemented_candidate is not final approval; it only means the supplied source review text appears to cover the checklist item.");
  lines.push("- Every hardware operation must be checked with verify_register_usage or an equivalent manual-evidence call.");
  lines.push("- Missing/unclear requirements must be resolved or explicitly justified before claiming driver completeness.");
  lines.push("");
  lines.push("Machine summary JSON:");
  lines.push(JSON.stringify({ filename: comparison.filename, reviewStatus: comparison.reviewStatus, completenessPercent: comparison.completenessPercent, totals: comparison.totals, selectedProfile: comparison.selectedProfile, sourceFiles: comparison.sourceFiles, visualEvidenceCount: (comparison.visualEvidence || []).length, missing: (comparison.missing || []).slice(0, 20).map((item) => ({ id: item.id, area: item.area, item: item.item, status: item.status })), unclear: (comparison.unclear || []).slice(0, 20).map((item) => ({ id: item.id, area: item.area, item: item.item, status: item.status })) }, null, 2));
  return appendEvidenceContract(lines.join("\n"), buildCompareDriverRequirementsContract(comparison));
}
