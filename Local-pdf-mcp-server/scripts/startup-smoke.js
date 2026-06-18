import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";

const root = process.cwd();
const requiredPackages = [
  "@modelcontextprotocol/sdk/server/index.js",
  "@modelcontextprotocol/sdk/server/stdio.js",
  "pdfjs-dist/legacy/build/pdf.mjs",
  "pdf-parse",
];

const failures = [];

for (const packageName of requiredPackages) {
  try {
    await import(packageName);
  } catch (error) {
    failures.push(`Cannot import ${packageName}: ${error.code || error.message}`);
  }
}

const indexPath = path.join(root, "index.js");
if (!existsSync(indexPath)) failures.push("Missing index.js");

if (failures.length) {
  console.error("Startup smoke: FAIL");
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  console.error("Run npm.cmd ci before starting the MCP server on Windows.");
  process.exit(1);
}

const child = spawn(process.execPath, ["index.js", "--smoke"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

const timeout = setTimeout(() => {
  child.kill();
  console.error("Startup smoke: FAIL");
  console.error("index.js --smoke timed out");
  process.exit(1);
}, 15000);

child.on("exit", (code) => {
  clearTimeout(timeout);
  if (code !== 0) {
    console.error("Startup smoke: FAIL");
    if (stdout.trim()) console.error(stdout.trim());
    if (stderr.trim()) console.error(stderr.trim());
    process.exit(code || 1);
  }
  console.log("Startup smoke: PASS");
  if (stdout.trim()) console.log(stdout.trim());
});
