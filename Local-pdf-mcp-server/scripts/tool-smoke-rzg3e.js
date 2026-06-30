import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const DEFAULT_FILENAME = "r01uh1069ej0115-rzg3e.pdf";
const EXPECTED_WARNING_TOOLS = new Set(["job_status", "cancel_job"]);
const OPTIONAL_RENDER_TOOLS = new Set();

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || fallback;
}

function textFromResult(result) {
  return (result.content || [])
    .map((item) => item.type === "text" ? item.text : `[${item.type}]`)
    .join("\n");
}

function preview(text, max = 900) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function parseFirstJsonObject(text) {
  const source = String(text || "").trim();
  const start = source.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function extractMachineSummary(text) {
  const marker = "Machine summary JSON:";
  const idx = String(text || "").lastIndexOf(marker);
  if (idx < 0) return null;
  return parseFirstJsonObject(String(text).slice(idx + marker.length));
}

function hasRendererWarning(text) {
  return /renderer.*not available|cannot render|no pdf renderer|poppler|mutool|imagemagick/i.test(String(text || ""));
}

function hasExpectedMissingResource(text) {
  return /job not found|visual evidence entry not found|figure\/table context not found|chunk not found/i.test(String(text || ""));
}

export function classifyToolResult({ name, output = "", error = "", expectedWarning = false } = {}) {
  const text = `${error || ""}\n${output || ""}`;
  if (error) {
    if (expectedWarning || OPTIONAL_RENDER_TOOLS.has(name) && hasRendererWarning(text)) return "expected_warn";
    return "fail";
  }

  if (/^SKIP:|requires .* in eval case/i.test(String(output).trim())) return "skip";

  const machine = extractMachineSummary(output);
  if (machine) {
    const health = String(machine.health || "").toLowerCase();
    const failCount = Number(machine.summary?.fail || 0);
    if (health === "fail" || failCount > 0) return "fail";
    return "pass";
  }

  if (expectedWarning && hasExpectedMissingResource(text)) return "expected_warn";
  if (OPTIONAL_RENDER_TOOLS.has(name) && hasRendererWarning(text)) return "expected_warn";
  if (/Unhandled|TypeError|ReferenceError/i.test(text)) return "fail";
  return "pass";
}

function extractEvidenceId(text) {
  return String(text || "").match(/Evidence ID:\s*([A-Za-z0-9_.:-]+)/)?.[1] || "";
}

function extractFigureId(text) {
  return String(text || "").match(/\bfig-p\d+-[A-Za-z0-9_.:-]+/)?.[0] || "";
}

async function snapshotFile(filePath) {
  try {
    return { exists: true, data: await fs.readFile(filePath) };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, data: null };
    throw error;
  }
}

async function restoreFile(filePath, snapshot) {
  if (snapshot.exists) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, snapshot.data);
  } else {
    await fs.rm(filePath, { force: true });
  }
}

function buildArgs(name, filename, state) {
  const baseArgs = {
    list_pdfs: {},
    pdf_info: { filename },
    doctor: { filename, write_report: false },
    validate_index: { filename, strict: false, write_report: false },
    list_eval_cases: { filename, include_disabled: true },
    run_eval: { filename, auto_index: false, write_report: false, include_golden: true, strict_verified_only: true },
    start_index_pdf: { filename },
    index_pdf: { filename, force: false },
    search_pdf: { filename, query: "WDTCR register", top_k: 3 },
    hybrid_search_pdf: { filename, query: "WDTCR register", intent: "register", top_k: 3 },
    chunk_type_stats: { filename, include_examples: false },
    read_pdf_pages: { filename, start_page: 1, end_page: 1 },
    read_pdf_chunk: { filename, chunk_id: `${filename}:chunk:0` },
    find_register: { filename, register: "WDTCR", top_k: 3 },
    list_registers: { filename, top_k: 5, include_low_confidence: true },
    find_bitfield: { filename, register: "WDTCR", bitfield: "CKS", top_k: 3 },
    list_bitfields: { filename, register: "WDTCR", top_k: 5 },
    extract_tables_from_pages: { filename, start_page: 1, end_page: 1 },
    extract_layout_tables_from_pages: { filename, start_page: 1, end_page: 1 },
    extract_register_table: { filename, start_page: 1, end_page: 3, top_k: 10 },
    extract_bitfield_table: { filename, register: "WDTCR", top_k: 10 },
    summarize_register: { filename, register: "WDTCR", top_k: 4 },
    find_sequence: { filename, topic: "WDTCR enable sequence", top_k: 3 },
    list_sequences: { filename, filter: "watchdog", top_k: 5 },
    get_sequence: { filename, topic: "watchdog", top_k: 3 },
    find_caution: { filename, topic: "WDTCR", top_k: 3 },
    list_cautions: { filename, filter: "WDTCR", top_k: 5 },
    get_cautions_for_register: { filename, register: "WDTCR", top_k: 5 },
    build_driver_evidence_pack: { filename, module_type: "usb-xhci", focus: "USB xHCI PHY VBUS reset review", mode: "fast", budget_ms: 8000 },
    verify_register_usage: { filename, register: "WDTCR", operation: "verify watchdog control register usage", bitfields: ["CKS"], top_k: 4 },
    compare_driver_requirements: { filename, subsystem: "pcie", driver_family: "host", task: "PCIe host probe/init", implemented_features: ["probe"], source_summary: "smoke test only" },
    source_review_prompt_pack: { filename, subsystem: "pcie", driver_family: "host", task: "review PCIe host driver", source_files: ["drivers/pci/controller/example.c"], review_depth: "standard" },
    analyze_module: { filename, module_type: "watchdog", focus: "WDTCR" },
    get_module_profile: { filename, module_type: "watchdog", focus: "WDTCR", refresh: false },
    prepare_driver_task: { filename, task: "implement CAN FD driver init", module_type: "can-canfd", top_registers: 5 },
    find_section: { filename, section: "watchdog", top_k: 3 },
    plan_manual_workflow: { filename, task: "implement USB xHCI host driver init", module_type: "usb-xhci", include_eval: true },
    explain_tool_usage: { tool: "find_register" },
    eval_health_check: { write_report: false },
    mcp_server_ping: {},
    pdf_index_status_lite: { filename, json: false },
    index_status: { filename, details: false, json: false },
    rebuild_artifact: { filename, artifact: "registers", background: true },
    job_status: { job_id: "missing-job-id" },
    list_jobs: {},
    cancel_job: { job_id: "missing-job-id" },
    cleanup_jobs: { statuses: ["done", "failed", "cancelled"], older_than_hours: 0 },
    list_driver_profiles: {},
    driver_completeness_checklist: { filename, subsystem: "usb", driver_family: "xhci", task: "USB xHCI host driver init" },
    list_figures: { filename, top_k: 5 },
    add_visual_evidence: {
      filename,
      figure_id: state.figureId || undefined,
      title: "smoke visual evidence",
      page: state.figurePage || 1,
      query: "watchdog block diagram",
      direct_visual_observations: ["tool smoke observation; restored after test"],
      notes: "tool smoke test",
      tags: ["tool-smoke"],
    },
    list_visual_evidence: { filename, filter: "tool-smoke" },
    get_visual_evidence: { filename, evidence_id: state.evidenceId || "missing-visual-evidence-id" },
    visual_evidence_report: { filename, filter: "tool-smoke", include_entries: true },
    visual_evidence_verification_queue: { filename, filter: "tool-smoke" },
    verify_visual_evidence: {
      filename,
      evidence_id: state.evidenceId || "missing-visual-evidence-id",
      status: "needs_verification",
      notes: "tool smoke verification update; restored after test",
    },
    visual_review_handoff_pack: { filename, query: "watchdog", top_k: 3 },
    check_pdf_renderers: {},
    extract_pinmux_table: { filename, start_page: 1, end_page: 1, filter: "GPIO" },
  };
  return baseArgs[name] || { filename };
}

function updateStateFromOutput(name, output, state) {
  if (["search_figures", "list_figures", "visual_review_handoff_pack"].includes(name)) {
    const figureId = extractFigureId(output);
    if (figureId) state.figureId = figureId;
  }
  if (name === "add_visual_evidence") {
    const evidenceId = extractEvidenceId(output);
    if (evidenceId) state.evidenceId = evidenceId;
  }
}

async function main() {
  const root = process.cwd();
  const filename = argValue("filename", DEFAULT_FILENAME);
  const timeoutMs = Number(argValue("timeout", "45000"));
  const writeReport = !process.argv.includes("--no-write");
  const visualEvidencePath = path.join(root, "indexes", `${filename}.visual-evidence.json`);
  const visualSnapshot = await snapshotFile(visualEvidencePath);
  const state = { figureId: "", evidenceId: "" };
  const results = [];

  const client = new Client({ name: "rzg3e-tool-smoke", version: "1.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["index.js"],
    cwd: root,
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    const listed = await client.listTools({}, { timeout: timeoutMs });
    const tools = listed.tools || [];
    const toolNames = tools.map((tool) => tool.name);

    for (const name of toolNames) {
      const args = buildArgs(name, filename, state);
      const started = Date.now();
      let output = "";
      let error = "";
      try {
        const result = await client.callTool({ name, arguments: args }, undefined, {
          timeout: timeoutMs,
          maxTotalTimeout: timeoutMs,
        });
        output = textFromResult(result);
        updateStateFromOutput(name, output, state);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      const expectedWarning = EXPECTED_WARNING_TOOLS.has(name) || (!state.evidenceId && ["get_visual_evidence", "verify_visual_evidence"].includes(name));
      const status = classifyToolResult({ name, output, error, expectedWarning });
      results.push({
        name,
        status,
        durationMs: Date.now() - started,
        args,
        error,
        preview: preview(error || output),
      });
      console.log(`${status.toUpperCase().padEnd(13)} ${name} (${results.at(-1).durationMs} ms)`);
    }

    await client.close();

    const summary = {
      total: results.length,
      pass: results.filter((item) => item.status === "pass").length,
      expected_warn: results.filter((item) => item.status === "expected_warn").length,
      warn: results.filter((item) => item.status === "warn").length,
      skip: results.filter((item) => item.status === "skip").length,
      fail: results.filter((item) => item.status === "fail").length,
    };
    const report = {
      schemaVersion: 2,
      createdAt: new Date().toISOString(),
      filename,
      timeoutMs,
      toolCountAdvertised: tools.length,
      summary,
      results,
    };

    const lines = [
      "# RZ/G3E MCP Tool Smoke Report",
      "",
      `- Created: ${report.createdAt}`,
      `- File: ${filename}`,
      `- Tools advertised: ${tools.length}`,
      `- Summary: total=${summary.total}, pass=${summary.pass}, expected_warn=${summary.expected_warn}, warn=${summary.warn}, skip=${summary.skip}, fail=${summary.fail}`,
      "",
      "| Status | Tool | Duration | Notes |",
      "| --- | --- | ---: | --- |",
      ...results.map((item) => `| ${item.status} | ${item.name} | ${item.durationMs} ms | ${String(item.error || item.preview).replace(/\|/g, "/").slice(0, 180)} |`),
      "",
    ];

    if (writeReport) {
      const outDir = path.join(root, "indexes");
      await fs.mkdir(outDir, { recursive: true });
      const jsonPath = path.join(outDir, `${filename}.tool-smoke-report.json`);
      const mdPath = path.join(outDir, `${filename}.tool-smoke-report.md`);
      await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
      await fs.writeFile(mdPath, `${lines.join("\n")}\n`, "utf-8");
      console.log(`Report JSON: ${jsonPath}`);
      console.log(`Report Markdown: ${mdPath}`);
    }

    console.log(JSON.stringify({ summary, reportWritten: writeReport }, null, 2));
    if (summary.fail || summary.warn) process.exitCode = 1;
  } finally {
    try {
      await restoreFile(visualEvidencePath, visualSnapshot);
    } catch (error) {
      console.error(`Failed to restore visual evidence snapshot: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  await main();
}
