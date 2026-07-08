const SUPPORTED_MCP_CONTROL_ACTIONS = new Set([
  "ping",
  "compat_report",
  "index_status_lite",
  "ocr_health",
  "rebuild_artifact",
  "job_status",
  "list_jobs",
  "cancel_job",
  "cleanup_jobs",
  "cache_status",
  "cleanup_cache",
  "figure_cache_status",
  "cleanup_figure_cache",
]);

const REQUIRED_FIELDS_BY_ACTION = {
  index_status_lite: ["filename"],
  rebuild_artifact: ["filename"],
  job_status: ["job_id"],
  cancel_job: ["job_id"],
  cache_status: ["filename"],
  cleanup_cache: ["filename"],
  figure_cache_status: ["filename"],
  cleanup_figure_cache: ["filename"],
};

function hasNonEmptyStringField(args, field) {
  return typeof args?.[field] === "string" && args[field].trim().length > 0;
}

export function validateMcpControlArgs(args = {}) {
  const action = String(args.action || "").trim().toLowerCase();
  if (!action) throw new Error("mcp_control action is required");
  if (!SUPPORTED_MCP_CONTROL_ACTIONS.has(action)) {
    throw new Error(`Unknown mcp_control action: ${args.action}`);
  }

  for (const field of REQUIRED_FIELDS_BY_ACTION[action] || []) {
    if (!hasNonEmptyStringField(args, field)) {
      throw new Error(`${field} is required for mcp_control(action="${action}")`);
    }
  }

  return { action };
}
