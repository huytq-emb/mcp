import { jsonResult, textResult } from "../../core/runtime-helpers.js";

export const LEGACY_CONTROL_WARNING = "Deprecated compatibility path. Prefer mcp_control(action=...).";

export function requireStringArg(args, key, action) {
  const value = String(args?.[key] || "").trim();
  if (!value) throw new Error(`${key} is required for mcp_control(action="${action}")`);
  return value;
}

export function legacyTextResult(warning, text) {
  return textResult([warning, "", text].join("\n"));
}

export function legacyJsonResult(warning, payload) {
  const next = payload && typeof payload === "object" && !Array.isArray(payload)
    ? { warning, ...payload, warnings: [warning, ...(Array.isArray(payload.warnings) ? payload.warnings : [])] }
    : { warning, result: payload };
  return jsonResult(next);
}
