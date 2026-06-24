import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { evidenceContractMissingFields } from "../../src/evidence/contract.js";
import { classifyToolResult, extractMachineSummary } from "../../scripts/tool-smoke-rzg3e.js";

const filename = "r01uh1069ej0115-rzg3e.pdf";
const root = process.cwd();

function textFromResult(result) {
  return (result.content || []).map((item) => item.text || "").join("\n");
}

function parseEvidenceContract(text) {
  const match = String(text || "").match(/Machine-readable evidence contract:\s*```json\s*([\s\S]*?)```/);
  assert.ok(match, "expected machine-readable evidence contract block");
  return JSON.parse(match[1]);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
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
  if (snapshot.exists) await fs.writeFile(filePath, snapshot.data);
  else await fs.rm(filePath, { force: true });
}

test("tool smoke classifier trusts machine summary JSON", () => {
  const output = [
    "MCP Manual Server Doctor",
    "Overall health: OK",
    "Machine summary JSON:",
    JSON.stringify({ health: "ok", summary: { fail: 0 }, reports: [] }, null, 2),
  ].join("\n");

  assert.deepEqual(extractMachineSummary(output).health, "ok");
  assert.equal(classifyToolResult({ name: "doctor", output }), "pass");
});

test("tool smoke classifier separates expected missing-resource warnings", () => {
  assert.equal(
    classifyToolResult({
      name: "job_status",
      output: "Job not found.",
      expectedWarning: true,
    }),
    "expected_warn",
  );
});

test("add_visual_evidence output includes filename and complete evidence contract", async (t) => {
  const pdfPath = path.join(root, "documents", filename);
  const manifestPath = path.join(root, "indexes", `${filename}.manifest.json`);
  if (!(await pathExists(pdfPath)) || !(await pathExists(manifestPath))) {
    t.skip("RZ/G3E PDF/index artifacts are not available");
    return;
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
  if (manifest.artifacts?.tables?.schemaVersion !== 1 || manifest.artifacts?.bitfields?.schemaVersion !== 3 || manifest.artifacts?.sequences?.schemaVersion !== 2) {
    t.skip("V6 accuracy artifacts have not been rebuilt yet");
    return;
  }

  const visualPath = path.join(root, "indexes", `${filename}.visual-evidence.json`);
  const snapshot = await snapshotFile(visualPath);
  const client = new Client({ name: "hardening-unit", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["index.js"],
    cwd: root,
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "add_visual_evidence",
      arguments: {
        filename,
        page: 1,
        query: "tool smoke hardening",
        direct_visual_observations: ["unit-test observation"],
        tags: ["unit-hardening"],
      },
    }, undefined, { timeout: 45000, maxTotalTimeout: 45000 });
    const text = textFromResult(result);
    assert.match(text, new RegExp(`File: ${filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.doesNotMatch(text, /File: undefined/);
    const contract = parseEvidenceContract(text);
    assert.deepEqual(evidenceContractMissingFields(contract), []);

    const doctorResult = await client.callTool({
      name: "doctor",
      arguments: { filename, write_report: false },
    }, undefined, { timeout: 45000, maxTotalTimeout: 45000 });
    const doctorSummary = extractMachineSummary(textFromResult(doctorResult));
    assert.equal(doctorSummary.health, "ok");
    assert.equal(doctorSummary.coreHealth, "ok");
  } finally {
    try {
      await client.close();
    } finally {
      await restoreFile(visualPath, snapshot);
    }
  }
});
