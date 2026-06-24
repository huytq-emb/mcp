import { appendEvidenceContract, makeEvidence, makeEvidenceContract, makeInference, makeNeedsVerification } from "../core/runtime-helpers.js";
import { createRuntimePort } from "../core/runtime-ports.js";
import path from "node:path";
import { normalizeDriverFamilyHint, normalizeDriverSubsystemHint } from "../driver-profiles/catalog.js";


const buildDriverCompletenessChecklist = createRuntimePort("buildDriverCompletenessChecklist");
const collectDriverReviewVisualEvidence = createRuntimePort("collectDriverReviewVisualEvidence");
const formatDriverVisualEvidenceSection = createRuntimePort("formatDriverVisualEvidenceSection");
const formatVisualEvidenceGateSection = createRuntimePort("formatVisualEvidenceGateSection");


const normalizeStringArray = createRuntimePort("normalizeStringArray");
const visualEvidenceGateNeedsVerification = createRuntimePort("visualEvidenceGateNeedsVerification");
const visualEvidenceGateWarnings = createRuntimePort("visualEvidenceGateWarnings");
const visualEvidenceToEvidenceContractItems = createRuntimePort("visualEvidenceToEvidenceContractItems");


// -----------------------------------------------------------------------------
// Source review prompt pack
// -----------------------------------------------------------------------------

export function normalizeReviewDepth(value) {
  const raw = String(value || "standard").trim().toLowerCase();
  if (["quick", "standard", "deep"].includes(raw)) return raw;
  return "standard";
}

export function normalizeReviewOutputFormat(value) {
  const raw = String(value || "report").trim().toLowerCase();
  if (["report", "checklist", "patch_plan", "debug_plan"].includes(raw)) return raw;
  return "report";
}

export function quoteForPromptCall(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, "'").replace(/\n/g, " ").trim();
}

export function buildPlaceholderArray(values, fallback = "...") {
  const items = normalizeStringArray(values);
  if (!items.length) return fallback;
  return items.map((item) => `"${quoteForPromptCall(item)}"`).join(", ");
}

export function sourceReviewDepthRules(depth) {
  if (depth === "quick") {
    return [
      "Inspect the specified source files and the main probe/open/stop/IRQ paths only.",
      "Extract high-confidence implemented_features and obvious missing/unclear items.",
      "Verify only hardware operations that are central to the requested task.",
    ];
  }
  if (depth === "deep") {
    return [
      "Inspect all related driver, subsystem glue, Kconfig/Makefile, Device Tree, and binding files reachable from the supplied source files.",
      "Extract every MMIO/regmap/readl/writel/poll/reset/clock/runtime-PM/IRQ/DT operation, not only the obvious ones.",
      "Call verify_register_usage for every hardware register operation before final approval.",
      "Treat unverified bit positions, reserved-bit handling, status clear semantics, and operation order as blockers.",
    ];
  }
  return [
    "Inspect the supplied source files plus directly referenced helper files in the same driver path.",
    "Extract implemented_features, missing_features, source_observations, and register_operations from source code.",
    "Call compare_driver_requirements, then verify all listed register operations.",
  ];
}

export function sourceReviewOutputRules(format) {
  if (format === "patch_plan") {
    return [
      "Final output must be a patch plan, not a vague review.",
      "Group actions by source file and function.",
      "For every proposed hardware-register change, include the verify_register_usage evidence status.",
    ];
  }
  if (format === "debug_plan") {
    return [
      "Final output must be a debug plan with hypotheses, evidence, commands/tests, and expected observations.",
      "Separate source-code bug candidates from manual-evidence gaps.",
      "Do not propose register writes until verify_register_usage has been called for that register operation.",
    ];
  }
  if (format === "checklist") {
    return [
      "Final output must preserve the checklist structure: implemented / missing / unclear / blocked-by-manual-verification.",
      "Each checklist item must cite either source evidence or a missing/unclear reason.",
    ];
  }
  return [
    "Final output must be a structured review report.",
    "Use sections: summary, implemented, missing, unclear, manual evidence, register-operation verification, risks, next actions.",
  ];
}

export async function buildSourceReviewPromptPack(filename, options = {}) {
  const task = String(options.task || "review Linux driver completeness against hardware manual").trim();
  const reviewDepth = normalizeReviewDepth(options.reviewDepth);
  const outputFormat = normalizeReviewOutputFormat(options.outputFormat);
  const sourceFiles = normalizeStringArray(options.sourceFiles);

  const checklist = await buildDriverCompletenessChecklist(filename, {
    subsystem: String(options.subsystem || "").trim(),
    driverFamily: String(options.driverFamily || "").trim(),
    profile: String(options.profile || "").trim(),
    task,
    createDefault: options.createDefault !== false,
  });

  const profile = checklist.profile || {};
  const subsystem = checklist.subsystem || normalizeDriverSubsystemHint(options.subsystem || profile.subsystem || "generic");
  const driverFamily = normalizeDriverFamilyHint(options.driverFamily || profile.driver_family || "");
  const sourceFileText = sourceFiles.length ? sourceFiles : ["<discover relevant driver source files in VS Code workspace>"];

  const requiredFields = {
    source_files: sourceFileText,
    implemented_features: ["<feature/checklist item observed in source>"],
    missing_features: ["<feature/checklist item clearly missing or not supported>"],
    source_observations: ["<specific source observation, uncertainty, TODO, or risk>"],
    register_operations: [
      {
        register: "<register macro or manual register name>",
        operation: "<what the source does or intends to do>",
        bitfields: ["<bit macro/field>"],
        access_type: "raw_write|read_modify_write|set_bits|clear_bits|write_one_to_clear|write_zero_to_clear|poll|reset|read|write",
        intent: "init|start|stop|clear|irq|reset|error|status|configure|read|write",
        source_snippet: "<short relevant snippet>",
      },
    ],
  };

  const compareCall = [
    `compare_driver_requirements(`,
    `  filename="${filename}",`,
    `  subsystem="${quoteForPromptCall(subsystem)}",`,
    driverFamily ? `  driver_family="${quoteForPromptCall(driverFamily)}",` : null,
    checklist.selectedProfile ? `  profile="${quoteForPromptCall(checklist.selectedProfile)}",` : null,
    `  task="${quoteForPromptCall(task)}",`,
    `  source_files=[${buildPlaceholderArray(sourceFiles, '"<source files inspected>"')}],`,
    `  implemented_features=[...],`,
    `  missing_features=[...],`,
    `  source_observations=[...],`,
    `  register_operations=[...]`,
    `)`,
  ].filter(Boolean).join("\n");

  const registerVerifyCall = `verify_register_usage(filename="${filename}", register="<register>", operation="<source operation>", bitfields=[...], access_type="<access pattern>", intent="<intent>", source_snippet="<short snippet>")`;
  const visualGate = await collectDriverReviewVisualEvidence(filename, {
    include: options.includeVisualEvidence !== false,
    filter: options.visualFilter || task,
    task,
    moduleType: subsystem,
    sourceFiles,
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
    subsystem,
    driverFamily,
    selectedProfile: checklist.selectedProfile,
    profileStack: profile._profileStack || [checklist.selectedProfile].filter(Boolean),
    profileFragments: profile._fragmentStack || [],
    profileTitle: profile.title || checklist.selectedProfile,
    profileDescription: profile.description || "",
    sourceFiles: sourceFileText,
    sourceFilesProvided: sourceFiles,
    reviewDepth,
    outputFormat,
    depthRules: sourceReviewDepthRules(reviewDepth),
    outputRules: sourceReviewOutputRules(outputFormat),
    checklistAreas: (profile.checklist || []).map((area) => ({
      area: area.area || "Unnamed area",
      items: normalizeStringArray(area.items),
      requiredManualChecks: normalizeStringArray(area.required_manual_checks),
    })),
    requiredManualChecks: normalizeStringArray(checklist.requiredManualChecks || profile.required_manual_checks),
    sourceReviewSteps: normalizeStringArray(checklist.sourceReviewSteps || profile.source_review_steps),
    recommendedTools: normalizeStringArray(checklist.recommendedTools || profile.recommended_tools),
    visualEvidence,
    visualEvidenceGate: visualGate,
    mandatoryWorkflow: [
      `doctor(filename="${filename}")`,
      `driver_completeness_checklist(filename="${filename}", subsystem="${quoteForPromptCall(subsystem)}", driver_family="${quoteForPromptCall(driverFamily)}", profile="${quoteForPromptCall(checklist.selectedProfile)}", task="${quoteForPromptCall(task)}")`,
      `build_driver_evidence_pack(filename="${filename}", module_type="${quoteForPromptCall(subsystem)}", focus="${quoteForPromptCall(task)}", mode="adaptive")`,
      `visual_evidence_report(filename="${filename}", filter="${quoteForPromptCall(options.visualFilter || task)}", status="${quoteForPromptCall(options.visualStatus || "all")}", include_entries=true)`,
      compareCall,
      registerVerifyCall,
    ],
    requiredExtractionSchema: requiredFields,
    approvalRules: [
      "Do not claim a checklist item is complete unless source evidence exists and manual evidence requirements are either verified or explicitly marked not applicable.",
      "Do not treat MCP inference as hardware fact. Use read_pdf_pages/read_pdf_chunk/extract_bitfield_table/get_sequence/get_cautions_for_register/verify_register_usage for verification.",
      "Every source register operation must be either verified with verify_register_usage or listed as needsVerification/blocker.",
      "For raw writes, reserved-bit and unrelated-bit preservation must be checked before approval.",
      "For IRQ/status paths, clear semantics such as W1C/W0C must be checked before approval.",
      "If visual_gate is verified_only or block_unverified, resolve visual evidence blockers before approval.",
    ],
    warnings: [
      "MCP does not read the source repository. The VS Code agent must read files directly from the workspace and pass extracted source facts back to MCP.",
      "This prompt pack is an execution recipe. It is not itself evidence that the driver is complete.",
      ...(checklist.warnings || []),
      ...visualEvidenceGateWarnings(visualGate),
    ],
  };
}

export function buildSourceReviewPromptPackContract(pack) {
  const evidence = [
    makeEvidence({
      source: "driver-profile-json",
      evidenceType: "source-review-workflow-profile",
      quote: `${pack.selectedProfile}: ${pack.profileTitle}; stack=${(pack.profileStack || []).join(" -> ")}; fragments=${(pack.profileFragments || []).join(", ") || "none"}`,
      confidence: "high",
      name: pack.selectedProfile,
      tool: "source_review_prompt_pack",
    }),
  ];
  evidence.push(...visualEvidenceToEvidenceContractItems(pack.visualEvidence || [], "source_review_prompt_pack"));

  const inference = [
    makeInference({
      statement: `Generated source-review workflow for subsystem=${pack.subsystem}, driverFamily=${pack.driverFamily || "not specified"}`,
      basis: `profile=${pack.selectedProfile}, reviewDepth=${pack.reviewDepth}, outputFormat=${pack.outputFormat}`,
      confidence: pack.subsystem === "generic" ? "low" : "medium",
      risk: "The VS Code agent must confirm the actual subsystem/family from source code.",
    }),
  ];

  const needsVerification = [
    makeNeedsVerification({
      item: "All source-code facts used by compare_driver_requirements",
      reason: "The MCP server does not inspect the source tree; implemented_features/register_operations must be extracted by the VS Code agent.",
      suggestedTools: ["compare_driver_requirements(...) after source extraction"],
    }),
    makeNeedsVerification({
      item: "Every hardware register operation found in source",
      reason: "Prompt pack only tells the agent what to verify; it does not verify register usage itself.",
      suggestedTools: ["verify_register_usage(...) for each readl/writel/regmap/poll/reset/status-clear operation"],
    }),
  ];

  needsVerification.push(...visualEvidenceGateNeedsVerification(pack.visualEvidenceGate || {}, pack.filename));

  return makeEvidenceContract({
    tool: "source_review_prompt_pack",
    filename: pack.filename,
    query: pack.task,
    evidence,
    inference,
    needsVerification,
    warnings: pack.warnings || [],
    recommendedNextTools: pack.mandatoryWorkflow || [],
  });
}

export function formatSourceReviewPromptPack(pack) {
  const lines = [];
  lines.push("Source Review Prompt Pack");
  lines.push(`File: ${pack.filename}`);
  lines.push(`Created: ${pack.createdAt}`);
  lines.push(`Task: ${pack.task}`);
  lines.push(`Subsystem: ${pack.subsystem}`);
  lines.push(`Driver family: ${pack.driverFamily || "not specified"}`);
  lines.push(`Selected profile: ${pack.selectedProfile}`);
  lines.push(`Profile stack: ${(pack.profileStack || []).join(" -> ") || pack.selectedProfile}`);
  if ((pack.profileFragments || []).length) lines.push(`Profile fragments: ${pack.profileFragments.join(", ")}`);
  lines.push(`Review depth: ${pack.reviewDepth}`);
  lines.push(`Output format: ${pack.outputFormat}`);
  for (const warning of pack.warnings || []) lines.push(`Warning: ${warning}`);
  lines.push("");

  lines.push("Prompt to give the VS Code AI agent:");
  lines.push("```");
  lines.push(`You are reviewing Linux driver source code against a hardware manual through the local MCP server.`);
  lines.push(`Manual PDF: ${pack.filename}`);
  lines.push(`Task: ${pack.task}`);
  lines.push(`Subsystem/profile: ${pack.subsystem}${pack.driverFamily ? ` / ${pack.driverFamily}` : ""} / ${pack.selectedProfile}`);
  lines.push("");
  lines.push("Read source code directly from the VS Code workspace. The MCP server cannot read source files for you.");
  lines.push("Start with these files:");
  for (const file of pack.sourceFiles || []) lines.push(`- ${file}`);
  lines.push("");
  lines.push("Mandatory MCP workflow:");
  for (const call of pack.mandatoryWorkflow || []) lines.push(`- ${call}`);
  lines.push("");
  lines.push("Extraction requirements:");
  lines.push("1. Extract implemented_features: concise phrases that match checklist items actually seen in source.");
  lines.push("2. Extract missing_features: items clearly absent or unsupported.");
  lines.push("3. Extract source_observations: uncertainties, TODOs, assumptions, suspicious code paths, and DTS observations.");
  lines.push("4. Extract register_operations for every readl/writel/regmap_update_bits/read_poll_timeout/reset/status-clear operation.");
  lines.push("5. For each register operation, classify access_type and intent, then call verify_register_usage.");
  lines.push("");
  lines.push("Required extraction schema:");
  lines.push(JSON.stringify(pack.requiredExtractionSchema, null, 2));
  lines.push("");
  lines.push("Depth rules:");
  for (const rule of pack.depthRules || []) lines.push(`- ${rule}`);
  lines.push("");
  lines.push("Output rules:");
  for (const rule of pack.outputRules || []) lines.push(`- ${rule}`);
  lines.push("");
  lines.push("Approval rules:");
  for (const rule of pack.approvalRules || []) lines.push(`- ${rule}`);
  lines.push("```");
  lines.push("");

  lines.push("1. Checklist areas from selected profile");
  if ((pack.checklistAreas || []).length) {
    for (const [index, area] of pack.checklistAreas.entries()) {
      lines.push(`${index + 1}. ${area.area}`);
      for (const item of area.items || []) lines.push(`   - ${item}`);
      if ((area.requiredManualChecks || []).length) lines.push(`   manual checks: ${area.requiredManualChecks.join("; ")}`);
    }
  } else {
    lines.push("- No checklist areas found in selected profile.");
  }
  lines.push("");

  lines.push("2. Required manual checks");
  if ((pack.requiredManualChecks || []).length) for (const item of pack.requiredManualChecks) lines.push(`- ${item}`); else lines.push("- none listed by profile");
  lines.push("");

  lines.push("3. Source review steps from profile");
  if ((pack.sourceReviewSteps || []).length) for (const item of pack.sourceReviewSteps) lines.push(`- ${item}`); else lines.push("- Inspect source, extract operations, compare requirements, verify register usage.");
  lines.push("");

  lines.push("4. Persisted visual evidence to consider");
  lines.push(...formatDriverVisualEvidenceSection(pack.visualEvidence || [], pack.filename).slice(1));
  lines.push("");

  lines.push("4b. Visual evidence verification gate");
  lines.push(...formatVisualEvidenceGateSection(pack.visualEvidenceGate || {}, pack.filename).slice(1));
  lines.push("");

  lines.push("5. Mandatory MCP workflow");
  for (const call of pack.mandatoryWorkflow || []) lines.push(`- ${call}`);
  lines.push("");

  lines.push("5. Machine summary JSON:");
  lines.push(JSON.stringify({
    filename: pack.filename,
    task: pack.task,
    subsystem: pack.subsystem,
    driverFamily: pack.driverFamily,
    selectedProfile: pack.selectedProfile,
    profileFragments: pack.profileFragments,
    reviewDepth: pack.reviewDepth,
    outputFormat: pack.outputFormat,
    sourceFiles: pack.sourceFiles,
    mandatoryWorkflow: pack.mandatoryWorkflow,
    visualEvidenceCount: (pack.visualEvidence || []).length,
    extractionSchemaKeys: Object.keys(pack.requiredExtractionSchema || {}),
  }, null, 2));

  return appendEvidenceContract(lines.join("\n"), buildSourceReviewPromptPackContract(pack));
}
