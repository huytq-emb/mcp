import { CONTROL_TOOL_DEFINITIONS } from "./control.js";
import { DRIVER_TOOL_DEFINITIONS } from "./driver.js";
import { FIGURE_TOOL_DEFINITIONS } from "./figures.js";
import { MANUAL_EVIDENCE_TOOL_DEFINITIONS } from "./manual-evidence.js";

export const ALL_TOOL_DEFINITIONS = Object.freeze([
  ...CONTROL_TOOL_DEFINITIONS,
  ...MANUAL_EVIDENCE_TOOL_DEFINITIONS,
  ...FIGURE_TOOL_DEFINITIONS,
  ...DRIVER_TOOL_DEFINITIONS,
]);

export const PRIMARY_PUBLIC_TOOL_NAMES = Object.freeze([
  "list_pdfs",
  "pdf_info",
  "doctor",
  "index_pdf",
  "mcp_control",
  "search_pdf",
  "hybrid_search_pdf",
  "read_pdf_pages",
  "read_pdf_chunk",
  "find_section",
  "list_registers",
  "find_register",
  "summarize_register",
  "extract_register_table",
  "list_bitfields",
  "find_bitfield",
  "extract_bitfield_table",
  "extract_tables_from_pages",
  "list_sequences",
  "get_sequence",
  "list_cautions",
  "get_cautions_for_register",
  "rebuild_figure_manifest",
  "search_figures",
  "get_figure_context_pack",
  "get_figure_image",
  "ocr_figure_for_search",
  "plan_manual_workflow",
  "get_module_profile",
  "build_driver_evidence_pack",
  "source_review_prompt_pack",
  "compare_driver_requirements",
  "verify_register_usage",
  "add_visual_evidence",
  "visual_evidence_report"
]);
export const HIDDEN_TOOL_NAMES = Object.freeze([
  "mcp_server_ping",
  "pdf_index_status_lite",
  "index_status",
  "rebuild_artifact",
  "cancel_job",
  "cleanup_jobs",
  "validate_index",
  "start_index_pdf",
  "job_status",
  "list_jobs",
  "list_eval_cases",
  "run_eval",
  "eval_health_check",
  "chunk_type_stats",
  "check_pdf_renderers",
  "visual_review_handoff_pack",
  "table_coverage_report",
  "find_sequence",
  "find_caution",
  "analyze_module",
  "list_driver_profiles",
  "driver_completeness_checklist",
  "list_visual_evidence",
  "get_visual_evidence",
  "visual_evidence_verification_queue",
  "verify_visual_evidence",
  "analyze_figure_semantics",
  "get_figure_semantics",
  "list_figure_semantics",
  "search_figure_semantics",
  "rebuild_figure_semantics",
  "explain_tool_usage",
  "extract_layout_tables_from_pages",
  "extract_pinmux_table",
  "list_figures",
  "prepare_driver_task"
]);
export const HIDDEN_COMPATIBILITY_TOOL_NAMES = HIDDEN_TOOL_NAMES;

const INTERNAL_ONLY_TOOL_NAMES = Object.freeze([]);
const TOOL_DEFINITION_BY_NAME = new Map(ALL_TOOL_DEFINITIONS.map((definition) => [definition.name, definition]));

function mustGetDefinition(name) {
  const definition = TOOL_DEFINITION_BY_NAME.get(name);
  if (!definition) throw new Error(`Missing tool definition for ${name}`);
  return definition;
}

const categorizedNames = new Set([...PRIMARY_PUBLIC_TOOL_NAMES, ...HIDDEN_TOOL_NAMES, ...INTERNAL_ONLY_TOOL_NAMES]);
const overlap = PRIMARY_PUBLIC_TOOL_NAMES.filter((name) => HIDDEN_TOOL_NAMES.includes(name));
if (overlap.length) throw new Error(`Tools cannot be both public and hidden: ${overlap.join(", " )}`);
for (const name of PRIMARY_PUBLIC_TOOL_NAMES) mustGetDefinition(name);
for (const name of HIDDEN_TOOL_NAMES) mustGetDefinition(name);
const uncategorized = ALL_TOOL_DEFINITIONS.map((definition) => definition.name).filter((name) => !categorizedNames.has(name));
if (uncategorized.length) throw new Error(`Uncategorized tool definitions: ${uncategorized.join(", " )}`);

export const HIDDEN_TOOL_DEFINITIONS = Object.freeze(HIDDEN_TOOL_NAMES.map((name) => mustGetDefinition(name)));
export const PUBLIC_TOOL_DEFINITIONS = Object.freeze(PRIMARY_PUBLIC_TOOL_NAMES.map((name) => mustGetDefinition(name)));
export const PUBLIC_TOOL_NAMES = Object.freeze(PUBLIC_TOOL_DEFINITIONS.map((tool) => tool.name));
