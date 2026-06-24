import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolvePythonInterpreter } from "../src/services/python-worker.js";

const root = process.cwd();
const venvPython = path.join(root, ".venv", "Scripts", "python.exe");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, windowsHide: true, stdio: "inherit", shell: false });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}

if (!fs.existsSync(venvPython)) {
  const interpreter = resolvePythonInterpreter({ rootDir: root });
  if (interpreter.source === "project-venv") {
    // Already created between the initial check and resolution.
  } else {
    const probe = spawnSync(interpreter.command, [...(interpreter.argsPrefix || []), "--version"], { cwd: root, windowsHide: true, encoding: "utf8", shell: false });
    if (probe.error || probe.status !== 0) {
      console.error("CPython 3.12 x64 was not found. Install it, disable Windows Store app aliases if necessary, then rerun npm.cmd run python:setup.");
      process.exit(1);
    }
    run(interpreter.command, [...(interpreter.argsPrefix || []), "-m", "venv", ".venv"]);
  }
}

run(venvPython, ["-m", "pip", "install", "--disable-pip-version-check", "-r", "requirements.txt"]);
run(venvPython, ["-c", "import fitz, orjson; print('Python extraction dependencies: OK')"]);
console.log("Python worker setup: READY");
