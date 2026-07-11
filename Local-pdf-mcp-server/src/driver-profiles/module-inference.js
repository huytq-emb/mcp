// Declarative, independently testable module-family evidence profiles. These
// are intentionally broad manual conventions, not figure-specific rules.
export const MODULE_INFERENCE_PROFILES = Object.freeze([
  { module: "dmaengine", symbols: ["dmac", "dma"], phrases: ["direct memory access", "transfer descriptor", "channel control"] },
  { module: "watchdog", symbols: ["wdt", "wdtcr", "wdtrr"], phrases: ["watchdog", "refresh register"] },
  { module: "pwm/timer", symbols: ["gpt", "gtcr", "gtcnt", "gtcc"], phrases: ["pwm", "general pwm timer", "compare match", "capture"] },
  { module: "gpio", symbols: ["gpio", "port", "pfc", "pwpr"], phrases: ["pin function", "multiplexed pin", "port control"] },
  { module: "i2c", symbols: ["i2c", "iic", "riic"], phrases: ["i2c bus", "serial clock", "start condition"] },
  { module: "spi", symbols: ["spi", "rspi"], phrases: ["serial peripheral", "chip select", "spi transfer"] },
  { module: "uart", symbols: ["uart", "scif", "sci"], phrases: ["serial communication", "baud rate", "transmit data"] },
  { module: "ethernet", symbols: ["geth", "gbeth", "gmac", "mdio"], phrases: ["ethernet", "mac controller", "phy interface"] },
  { module: "can", symbols: ["can", "canfd"], phrases: ["can controller", "bit timing", "message buffer"] },
  { module: "usb", symbols: ["usb", "xhci", "ehci", "ohci", "dwc3"], phrases: ["usb host", "usb device", "usb interface"] },
  { module: "pcie", symbols: ["pcie", "pciex"], phrases: ["pci express", "root complex", "host bridge"] },
  { module: "adc", symbols: ["adc", "adcsr"], phrases: ["analog digital", "a d converter", "conversion start"] },
  { module: "rtc", symbols: ["rtc"], phrases: ["real time clock", "calendar"] },
]);

export function normalizeInferenceText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function inferenceTokenSet(value) {
  return new Set(normalizeInferenceText(value).split(" ").filter(Boolean));
}

export function matchModuleInferenceProfile(value, profile) {
  const normalized = ` ${normalizeInferenceText(value)} `;
  const tokens = inferenceTokenSet(value);
  const symbolHits = (profile.symbols || []).filter((symbol) => {
    const normalizedSymbol = normalizeInferenceText(symbol);
    return normalizedSymbol && !normalizedSymbol.includes(" ") && tokens.has(normalizedSymbol);
  });
  const phraseHits = (profile.phrases || []).filter((phrase) => {
    const normalizedPhrase = normalizeInferenceText(phrase);
    return normalizedPhrase && normalized.includes(` ${normalizedPhrase} `);
  });
  return { symbolHits, phraseHits };
}

export function validateModuleInferenceProfiles(profiles = MODULE_INFERENCE_PROFILES) {
  const errors = [];
  const names = new Set();
  for (const [index, profile] of (profiles || []).entries()) {
    if (!profile || typeof profile !== "object") { errors.push(`profile ${index} must be an object`); continue; }
    if (!profile.module || typeof profile.module !== "string") errors.push(`profile ${index} requires module`);
    if (names.has(profile.module)) errors.push(`duplicate module profile: ${profile.module}`);
    names.add(profile.module);
    if (!Array.isArray(profile.symbols) || !profile.symbols.length) errors.push(`${profile.module || index} requires symbols`);
    if (!Array.isArray(profile.phrases) || !profile.phrases.length) errors.push(`${profile.module || index} requires phrases`);
  }
  return { ok: errors.length === 0, errors };
}
