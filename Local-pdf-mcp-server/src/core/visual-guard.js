const REQUIRED_NEXT_TOOLS = ["search_figures", "get_figure_context_pack", "get_figure_image"];

const RULES = [
  ["table-number", /\btable\s+\d+(?:\.\d+)+(?:-\d+)?\b/i],
  ["figure-number", /\bfigure\s+\d+(?:\.\d+)+(?:-\d+)?\b/i],
  ["visual-table", /\b(?:visual|captioned)\s+tables?\b/i],
  ["bit-layout", /\bbit\s+(?:layout|arrangements?|positions?)\b/i],
  ["msb-lsb", /\bMSB\b|\bLSB\b/i],
  ["data-format", /\bdata\s+formats?\b|\bformats?\s+handled\b|\bdata\s+formats?\s+handled\b/i],
  ["frame-format", /\bframe\s+formats?\b/i],
  ["word-format", /\bword\s+formats?\b/i],
  ["sample-format", /\bsample\s+formats?\b/i],
  ["channel-layout", /\bchannel\s+layouts?\b/i],
  ["timing", /\btiming\b|\bclock\s+timing\b/i],
  ["waveform", /\bwaveforms?\b/i],
];

function baseResult(triggered, reasons = []) {
  return {
    triggered,
    reasons,
    artifact_index: ".figures.json",
    required_next_tools: REQUIRED_NEXT_TOOLS,
    text_only_answer_forbidden: true,
    semantic_truth_source: "actual image pixels opened/attached to model vision input after get_figure_image metadata",
    text_context_role: "locator_support_only",
  };
}

export function detectVisualSemanticIntent(text = "") {
  const value = String(text || "");
  if (!value.trim()) return baseResult(false, []);
  const reasons = [];
  for (const [reason, pattern] of RULES) {
    if (pattern.test(value)) reasons.push(reason);
  }
  // Plain words such as "timing" are common in register prose; require a stronger
  // companion unless an explicit figure/table/layout/data-format term is present.
  const strong = reasons.filter((r) => !["timing"].includes(r));
  const triggered = strong.length > 0 || (reasons.includes("timing") && /\b(?:figure|table|diagram|waveform|layout)\b/i.test(value));
  return baseResult(triggered, triggered ? [...new Set(reasons)] : []);
}

export function isVisualSemanticIntent(text = "") {
  return detectVisualSemanticIntent(text).triggered;
}

export function buildVisualSemanticGuard(text = "", options = {}) {
  const detection = options.detection || detectVisualSemanticIntent(text);
  if (!detection.triggered && !options.force) return "";
  const mode = options.mode || "search";
  const filename = options.filename || "...";
  const query = options.query || text || "...";
  const lines = ["VISUAL SEMANTIC GUARD:"];
  if (mode === "read") {
    lines.push(
      "This page/chunk contains a visual table/figure candidate.",
      "The extracted text may collapse rows, columns, bit positions, alignment, arrows, waveforms, and layout.",
      "Use this text only to locate or cross-check the artifact.",
      "Do not provide semantic analysis from this text alone.",
      "For visual semantic analysis, use:",
      "Use get_figure_image transport=\"metadata\" to retrieve canonical_image_path/local_path, then open/attach the actual PNG as model vision input. mcp_image/image_url are experimental/client-dependent and not proof that the model saw pixels. image_path is only a locator. If no actual image input is available, return NO_IMAGE_INPUT.",
      "Visual tables are stored in .figures.json, not .tables.json."
    );
  } else if (mode === "layout-table") {
    lines.push(
      "This is coordinate/text-item extraction, not visual semantic truth.",
      "For captioned visual tables such as bit layout, MSB/LSB arrangement, data format, timing/waveform tables, use search_figures -> get_figure_context_pack -> get_figure_image transport=\"metadata\"; then open/attach the actual PNG as model vision input. image_path is only a locator. If no actual image input is available, return NO_IMAGE_INPUT.",
      "Visual/captioned tables are indexed in .figures.json; structured text/layout tables are indexed in .tables.json."
    );
  } else {
    lines.push(
      "This query appears to target a figure/visual table/bit-layout/data-format/timing artifact.",
      "Search results from text extraction are locator evidence only.",
      "Do not answer semantic visual content from these text snippets.",
      "Visual tables are indexed in .figures.json, not .tables.json.",
      "Required next workflow:",
      `1. search_figures(filename="${filename}", query="${String(query).replace(/"/g, '\\"')}")`,
      "2. get_figure_context_pack(filename=\"...\", figure_id=\"<figure_id_from_search_figures>\")",
      "3. get_figure_image(filename=\"...\", figure_id=\"<figure_id_from_search_figures>\", transport=\"metadata\")",
      "4. Open/attach canonical_image_path as actual model vision input before making visual-semantic claims. mcp_image/image_url are experimental/client-dependent and not proof that the model saw pixels. image_path is only a locator. If no actual image input is available, return NO_IMAGE_INPUT."
    );
  }
  lines.push(`Guard reasons: ${detection.reasons.join(", ") || "forced"}`);
  return lines.join("\n");
}

export function withVisualSemanticGuard(output, text = "", options = {}) {
  if (/VISUAL SEMANTIC GUARD:/i.test(String(output || ""))) return String(output || "");
  const detection = options.detection || detectVisualSemanticIntent(text);
  if (!detection.triggered && !options.force) return String(output || "");
  return [buildVisualSemanticGuard(text, { ...options, detection }), "", String(output || "")].join("\n");
}
