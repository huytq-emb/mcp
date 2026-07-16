const coverage = Object.freeze({
  ethernet: [
    ["locator", "Where is the GBETH Ethernet module described?"], ["alias", "Find GBETH, the Gigabit Ethernet block."], ["register", "Which GBETH control registers are listed?"], ["properties", "Give GBETH register offsets and reset values."],
    ["short-symbol", "Find EN in GBETH register context.", "GBETH", false, { type: "runtime-only", reason: "RZ/G3E page 1420 contains TXEN only as the suffix of the ETm_TXCTL_TXEN pin name; pages 1417-1420 declare no standalone GBETH EN register or bitfield." }],
    ["sequence", "What is the GBETH initialization sequence?", "", false, { type: "runtime-only", reason: "The simplified RZ/G3E GBETH section on pages 1417-1420 contains no initialization procedure or register-write sequence and defers additional details to the separate additional document." }],
    ["sequence-stop", "How should GBETH transmission be stopped?", "", false, { type: "runtime-only", reason: "The simplified RZ/G3E GBETH section on pages 1417-1420 contains no transmitter-stop procedure, stop-state register, or ordered stop relationship." }],
    ["caution", "What GBETH reset or clock cautions apply?"], ["figure", "Locate a GBETH block diagram or Ethernet figure.", "", true], ["page", "Which manual page introduces GBETH?"], ["alias-display", "Find the Ethernet MAC named GBETH."], ["irq", "Locate GBETH interrupt status handling."], ["phy", "What GBETH PHY interface details are documented?"], ["descriptor", "Find GBETH DMA descriptor references."], ["clock", "Locate GBETH clock requirements."], ["reset", "Find GBETH reset control information."], ["nl", "I am writing an Ethernet driver; where should I review GBETH setup?"], ["table", "Locate the GBETH register table.", "", true], ["caution2", "Are there restrictions for changing GBETH configuration?"], ["negative", "Find the nonexistent GBETH_ZZZ_NEVER_EXISTS_123 register.", "", false, "negative"],
  ],
  dma: [
    ["dctrl-properties", "What are DMACm_DCTRL offset, reset value, and access size?"], ["dctrl-alias", "Find the DMA DCTRL register."], ["lwca", "What is the LWCA field of DMACm_DCTRL?", "DMACm_DCTRL"], ["short-symbol", "Find EN in DMACm_DCTRL context.", "DMACm_DCTRL"], ["sequence", "What is the DMA channel start sequence?"], ["stop", "How should a DMA channel be stopped safely?"],
    ["caution-reserved-area", "What DMA reserved-bit cautions apply?", "", false, { type: "runtime-only", reason: "RZ/G3E page 819 verifies the reserved-area rule, but the evidence graph has no dedicated entity for caution 1; the nearest retrieved caution is only 'read modify write', so semantic correctness is not claimed." }],
    ["caution-active-transfer", "What DMA write restrictions apply while a transfer is in progress?", "", false, { type: "text", requiredText: "Do not modify the registers by software while DMA transfer is in progress", allowedPages: [819], requiredEntityTypes: ["caution"] }, 20],
    ["figure", "Locate a DMA transfer flow figure.", "", true], ["locator", "Where is the DMAC register chapter?"], ["table", "Locate the DMACm_DCTRL register table.", "", true], ["reset", "Which reset details apply to DMACm_DCTRL?"], ["access", "Is DMACm_DCTRL read/write?"], ["irq", "Find DMA transfer-end interrupt handling."], ["alias2", "Locate DMA control register DCTRL."], ["nl", "I need Linux DMAengine setup evidence for DCTRL."], ["address", "What base-offset information is documented for DMACm_DCTRL?"], ["bitfield", "Find DMACm_DCTRL bit fields."], ["clear", "How are DMA status flags cleared?"], ["sequence2", "List the order of DMA enable writes."], ["negative", "Find the nonexistent DMAC_ZZZ_NEVER_EXISTS_123 register.", "", false, "negative"],
  ],
  "gpio-pinctrl": [
    ["pwpr", "Locate PFC_PWPR write-protection before changing pins."], ["alias", "Find the PFC PWPR register."], ["properties", "What are PFC_PWPR offset, reset, and access details?"], ["short-symbol", "Find B0WI in PFC_PWPR context.", "PFC_PWPR"], ["sequence", "What is the PFC write-protection unlock sequence?"], ["caution", "What cautions apply when changing GPIO multiplexing?"], ["figure", "Locate a PFC or GPIO pin-multiplexing figure.", "", true], ["locator", "Where is the PFC chapter in the manual?"], ["table", "Locate the PFC_PWPR register table.", "", true], ["lock", "How is PFC write protection enabled again?"], ["gpio", "Which register controls GPIO/PFC pin function selection?"], ["alias2", "Find the port function controller PWPR alias."], ["nl", "I need pinctrl evidence before modifying a multiplexed pin."], ["reserved", "Are there reserved PFC_PWPR bits?"], ["reset", "What reset value applies to PFC_PWPR?"], ["access", "Is PFC_PWPR writable?"], ["sequence2", "List PFC protection write order."], ["page", "Which page documents PFC write protection?"], ["caution2", "What must not be changed while PFC is locked?"], ["negative", "Find the nonexistent PFC_ZZZ_NEVER_EXISTS_123 register.", "", false, "negative"],
  ],
  watchdog: [
    ["wdtcr", "What are WDTm_WDTCR offset, reset, and access details?"], ["alias", "Find the watchdog WDTCR control register."], ["short-symbol", "Find TME in WDTm_WDTCR context.", "WDTm_WDTCR"], ["refresh", "How must Linux refresh the watchdog?"], ["sequence", "List the watchdog refresh write sequence."], ["wdtrr", "Find the WDTm_WDTRR refresh register."], ["caution", "What watchdog refresh timing cautions apply?"], ["figure", "Locate a watchdog refresh flow figure.", "", true], ["locator", "Where is the watchdog module chapter?"], ["table", "Locate the WDTm_WDTCR register table.", "", true], ["reset", "What reset behavior is documented for the watchdog?"], ["access", "Is WDTm_WDTCR read/write?"], ["nl", "I need driver evidence for watchdog keepalive handling."], ["sequence2", "Which value is written first to WDTm_WDTRR?"], ["sequence3", "Which value completes a watchdog refresh?"], ["irq", "Find watchdog interrupt or overflow handling."], ["caution2", "What happens if watchdog refresh writes are out of order?"], ["page", "Which pages contain watchdog refresh details?"], ["alias2", "Locate WDTCR by its watchdog control alias."], ["negative", "Find the nonexistent WDT_ZZZ_NEVER_EXISTS_123 register.", "", false, "negative"],
  ],
  "pwm-timer": [
    ["gtcr", "Find GPTm_n_GTCR PWM control register details."], ["alias", "Locate the GPT GTCR control register."], ["properties", "What are GPTm_n_GTCR offset, reset, and access size?"], ["short-symbol", "Find CST in GPTm_n_GTCR context.", "GPTm_n_GTCR"], ["sequence", "What is the GPT PWM start sequence?"], ["stop", "How should a GPT timer be stopped?"], ["caution", "What PWM/timer write restrictions apply?"], ["figure", "Locate a GPT timing or PWM waveform figure.", "", true], ["locator", "Where is the GPT timer chapter?"], ["table", "Locate the GPTm_n_GTCR register table.", "", true], ["reset", "What reset value applies to GPTm_n_GTCR?"], ["access", "Is GPTm_n_GTCR read/write?"], ["nl", "I need Linux PWM driver setup evidence for GPT control."], ["counter", "Find GPT counter start control information."], ["clock", "Locate GPT clock requirements."], ["irq", "Find GPT interrupt status handling."], ["alias2", "Find general PWM timer control register GTCR."], ["sequence2", "List the order of GPT enable writes."], ["page", "Which page documents GPTm_n_GTCR?"], ["negative", "Find the nonexistent GPT_ZZZ_NEVER_EXISTS_123 register.", "", false, "negative"],
  ],
  usb: [
    ["host-spd", "Find USB2m_HOST_SPD_CTRL suspend-control details."], ["alias", "Locate the USB2 host SPD control register."], ["properties", "What are USB2m_HOST_SPD_CTRL offset, reset, and access size?"], ["short-symbol", "Find SPD in USB2m_HOST_SPD_CTRL context.", "USB2m_HOST_SPD_CTRL"], ["sequence", "What is the USB host suspend sequence?"], ["wakeup", "How is USB host wakeup controlled?"], ["caution", "What USB suspend and resume cautions apply?"], ["figure", "Locate a USB2 host block diagram or suspend figure.", "", true], ["locator", "Where is the USB2 host chapter?"], ["table", "Locate the USB2m_HOST_SPD_CTRL register table.", "", true], ["reset", "What reset value applies to USB2m_HOST_SPD_CTRL?"], ["access", "Is USB2m_HOST_SPD_CTRL read/write?"], ["nl", "I need USB host driver evidence for suspend and wakeup."], ["clock", "Locate USB2 host clock requirements."], ["irq", "Find USB host interrupt status handling."], ["alias2", "Find the host suspend-control register by alias."], ["sequence2", "List USB host suspend control write order."], ["page", "Which page documents USB2m_HOST_SPD_CTRL?"], ["caution2", "What must a driver avoid during USB host suspend?"], ["negative", "Find the nonexistent USB_ZZZ_NEVER_EXISTS_123 register.", "", false, "negative"],
  ],
});

function expectationFor(id, query, register, legacyExpectation) {
  if (legacyExpectation && typeof legacyExpectation === "object") return legacyExpectation;
  if (legacyExpectation === "runtime-only") return { type: "runtime-only", reason: "the manual coverage catalog does not declare a verified normalized entity for this probe" };
  if (legacyExpectation === "negative") {
    const symbol = (String(query).match(/[A-Z][A-Z0-9_]*ZZZ_NEVER_EXISTS_123/) || [""])[0];
    return { type: "negative", forbiddenCanonicalNames: symbol ? [symbol] : [], maxAcceptedRrfScore: 0.01, allowGenericCandidateEvidence: false };
  }
  // These broad figure-discovery probes have no manually verified figure
  // identity in the redistributable coverage catalog. Keep them explicitly
  // runtime-only instead of presenting page presence as semantic correctness.
  const idTokens = new Set(String(id).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  if (/figure/.test(id)) return { type: "runtime-only", reason: "figure identity is not manually declared for this coverage probe" };
  if (/table/.test(id)) return { type: "entity", requiredEntityTypes: ["table"] };
  if ([...idTokens].some((token) => /^(?:sequence\d*|refresh|stop|clear|lock)$/.test(token))) return { type: "sequence", requiredEntityTypes: ["sequence"] };
  if (/caution/.test(id)) return { type: "caution", requiredEntityTypes: ["caution"] };
  if (idTokens.has("reserved")) return { type: "entity", requiredEntityTypes: ["bitfield"] };
  if (/locator|page/.test(id)) return { type: "page", requiredEntityTypes: ["section"] };
  if (idTokens.has("nl")) return { type: "entity", requiredEntityTypes: ["register", "section"] };
  if (/bitfield|short-symbol|lwca/.test(id)) return { type: "entity", requiredEntityTypes: ["bitfield"], ...(register ? { relatedCanonicalName: register } : {}) };
  if (/properties|reset|access|address/.test(id)) return { type: "property", requiredEntityTypes: ["register"] };
  return { type: "entity", requiredEntityTypes: ["register"] };
}

export function coverageQueriesFor(subsystem) {
  return (coverage[subsystem] || []).map(([id, query, register = "", includeOcr = false, legacyExpectation = "positive", topK]) => ({
    id,
    query,
    register,
    includeOcr,
    ...(topK ? { topK } : {}),
    expectation: expectationFor(id, query, register, legacyExpectation),
  }));
}
