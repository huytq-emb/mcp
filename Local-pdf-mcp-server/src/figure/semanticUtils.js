export function compactText(value, maxChars = 240) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

export function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[_\-./()[\]{}:;,=+*<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function splitSemanticLines(value) {
  return String(value || "")
    .split(/[\r\n;]+/)
    .map((line) => compactText(line, 500))
    .filter(Boolean);
}

export function uniqueBy(items = [], keyFn = (item) => item) {
  const result = [];
  const seen = new Set();
  for (const item of items) {
    const key = String(keyFn(item) || "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

export function normalizeConfidence(value, fallback = 0.55) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n > 1) return Math.max(0, Math.min(1, n / 100));
  return Math.max(0, Math.min(1, n));
}

export function sourceEvidence({
  source = "text",
  text = "",
  page = null,
  figureId = "",
  bbox = [],
  confidence = 0.55,
} = {}) {
  return {
    source,
    text: compactText(text, 280),
    page: Number.isFinite(Number(page)) ? Number(page) : null,
    figure_id: figureId || "",
    bbox: Array.isArray(bbox) ? bbox.slice(0, 4) : [],
    confidence: normalizeConfidence(confidence),
  };
}

export function ocrBlockText(block = {}) {
  return String(block.text_normalized || block.text || block.text_original || "").trim();
}

export function evidenceTextBundle(input = {}) {
  const parts = [];
  const add = (text, source, confidence = 0.55) => {
    const value = String(text || "").trim();
    if (!value) return;
    parts.push({ text: value, source, confidence });
  };

  add(input.title, "figure_title", 0.72);
  add(input.caption, "figure_caption", 0.72);
  add(input.contextText, "page_context", 0.58);
  add(input.pageText, "page_text", 0.58);
  for (const block of input.ocrBlocks || []) {
    add(ocrBlockText(block), "ocr", normalizeConfidence(block.confidence, 0.65));
  }
  for (const block of input.layoutBlocks || []) {
    add(block.text || block.label || block.caption || "", "layout", normalizeConfidence(block.confidence, 0.5));
  }
  for (const block of input.vlBlocks || []) {
    add(block.text || block.label || block.caption || "", "vl", normalizeConfidence(block.confidence, 0.5));
  }

  return uniqueBy(parts, (item) => normalizeSearchText(item.text));
}

export function bundleText(input = {}) {
  return evidenceTextBundle(input).map((item) => item.text).join("\n");
}

const NON_SYMBOL_WORDS = new Set([
  "A", "AN", "AND", "ARE", "AS", "AT", "BE", "BY", "COUNT", "COUNTER",
  "DESCRIPTION", "EDGES", "EDGE", "EXAMPLE", "FIGURE", "FOR", "FROM", "HIGH",
  "INPUT", "LOW", "MODE", "NAME", "NO", "NOTE", "OF", "ON", "OPERATION",
  "OUTPUT", "PAGE", "PIN", "REGISTER", "REV", "SAW", "SET", "SETTING",
  "SOURCE", "STEP", "TABLE", "THE", "TIME", "TO", "UP", "VALUE", "WAVE",
  "WAVES", "WITH",
]);

export function canonicalSymbol(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^A-Za-z0-9_.:[\]]+/g, "")
    .trim();
}

export function candidateTechnicalTokens(text = "") {
  const tokens = [];
  const re = /\b[A-Za-z][A-Za-z0-9_]*(?:\[[A-Za-z0-9_:.]+\])?(?:\.[A-Za-z][A-Za-z0-9_]*(?:\[[A-Za-z0-9_:.]+\])?)?\b/g;
  for (const match of String(text || "").matchAll(re)) {
    const token = canonicalSymbol(match[0]);
    if (!token || token.length < 2) continue;
    tokens.push(token);
  }
  return uniqueBy(tokens, (token) => token.toUpperCase());
}

export function looksLikeValueToken(token = "") {
  return /^(?:0x[0-9a-f_]+|[01x_]+b|[0-9a-f_]+h)$/i.test(String(token || ""));
}

export function looksLikeBitfieldToken(token = "") {
  const value = String(token || "");
  return /\.[A-Za-z][A-Za-z0-9_]*|\[[0-9A-Za-z_:.]+\]/.test(value);
}

export function looksLikeSignalToken(token = "") {
  const value = String(token || "");
  if (/^GTIOC/i.test(value)) return true;
  if (/\b(?:IRQ|INT|NMI|REQ|ACK|CLK|CLOCK|RST|RESET|RX|TX|SDA|SCL|MISO|MOSI|CTS|RTS)\b/i.test(value)) return true;
  if (/[A-Z]{2,}[A-Za-z0-9_]*n[A-Z0-9]?[A-Za-z0-9_]*$/.test(value)) return true;
  return false;
}

export function looksLikeRegisterToken(token = "") {
  const value = String(token || "");
  const base = value.split(".")[0].replace(/\[[^\]]+\]/g, "");
  if (looksLikeValueToken(base)) return false;
  if (looksLikeSignalToken(base) && !/CNT|COUNT/i.test(base)) return false;
  if (NON_SYMBOL_WORDS.has(base.toUpperCase())) return false;
  if (/^(?:GT|GTP|WDT|DMAC|DMA|USB|GBETH|PFC|GPIO|CAN|IIC|RIIC|SPI|RSPI|PCI|PCIE|INTC|IRQ|ETH|MAC|TCON|POE)[A-Za-z0-9_]*$/i.test(base)) return true;
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(base) && /[A-Z]/.test(base) && /[0-9A-Z]/.test(base)) return true;
  return false;
}

export function classifyToken(token = "", context = "") {
  if (looksLikeValueToken(token)) return "value";
  if (looksLikeBitfieldToken(token)) return "bitfield";
  if (looksLikeRegisterToken(token)) return /CNT/i.test(token) ? "counter" : "register";
  if (looksLikeSignalToken(token)) return "signal";
  if (/\b(?:pin|signal|input|output)\b/i.test(context) && /^[A-Z0-9_]{3,}$/.test(token) && !NON_SYMBOL_WORDS.has(String(token).toUpperCase())) return "signal";
  return "unknown";
}

export function extractHardwareTokens(text = "") {
  return candidateTechnicalTokens(text)
    .map((token) => ({ token, token_type: classifyToken(token, text) }))
    .filter((item) => item.token_type !== "unknown");
}

export function extractRegisterNames(text = "") {
  return uniqueBy(
    extractHardwareTokens(text)
      .filter((item) => item.token_type === "register")
      .map((item) => item.token.split(".")[0].replace(/\[[^\]]+\]/g, "")),
    (name) => name.toUpperCase(),
  );
}

export function extractCounterNames(text = "") {
  const counters = extractHardwareTokens(text)
    .filter((item) => item.token_type === "counter" || /CNT|counter/i.test(item.token))
    .map((item) => item.token.split(".")[0].replace(/\[[^\]]+\]/g, ""));
  if (/\bGTCNT\b/i.test(text)) counters.push("GTCNT");
  return uniqueBy(counters, (name) => name.toUpperCase());
}

export function extractSignalNames(text = "") {
  const signals = extractHardwareTokens(text)
    .filter((item) => item.token_type === "signal")
    .map((item) => item.token.split(".")[0].replace(/\[[^\]]+\]/g, ""));
  return uniqueBy(signals, (name) => name.toUpperCase());
}

export function extractValueTokens(text = "") {
  const values = [];
  for (const match of String(text || "").matchAll(/\b(?:0x[0-9a-f_]+|[01x_]+b|[0-9a-f_]+h)\b/gi)) {
    values.push(match[0]);
  }
  return uniqueBy(values, (value) => value.toLowerCase());
}

export function blockKindFromName(name = "") {
  const text = normalizeSearchText(name);
  if (/\b(?:axi|ahb|apb|bus|crossbar|interconnect)\b/.test(text)) return "bus";
  if (/\b(?:dma|dmac|dma controller)\b/.test(text)) return "dma";
  if (/\b(?:irq|int|interrupt|intc)\b/.test(text)) return "interrupt_controller";
  if (/\b(?:clk|clock|pll|oscillator)\b/.test(text)) return "clock";
  if (/\b(?:rst|reset)\b/.test(text)) return "reset";
  if (/\b(?:register|reg)\b/.test(text) || looksLikeRegisterToken(name)) return "register";
  if (/\b(?:fifo|buffer)\b/.test(text)) return "memory";
  if (/\b(?:memory|ram|rom|sram|dram|flash)\b/.test(text)) return "memory";
  if (/\b(?:cpu|ca55|cortex|processor|core)\b/.test(text)) return "module";
  if (/\b(?:peripheral|timer|gpio|usb|can|spi|i2c|ethernet|uart|pwm)\b/.test(text)) return "peripheral";
  if (/\b(?:module|controller|unit|engine|mux|selector|block)\b/.test(text)) return "module";
  return "unknown";
}

export function edgeKindFromLabel(label = "") {
  const text = normalizeSearchText(label);
  if (/\b(?:axi|ahb|apb|bus)\b/.test(text)) return "bus";
  if (/\b(?:clk|clock)\b/.test(text)) return "clock";
  if (/\b(?:rst|reset)\b/.test(text)) return "reset";
  if (/\b(?:irq|int|interrupt)\b/.test(text)) return "interrupt";
  if (/\b(?:dma|dmac)\b/.test(text)) return "dma";
  if (/\b(?:data|rx|tx)\b/.test(text)) return "data";
  if (/\b(?:ctrl|control|enable|start|stop)\b/.test(text)) return "control";
  if (/\b(?:signal|req|ack)\b/.test(text)) return "signal";
  return "unknown";
}
