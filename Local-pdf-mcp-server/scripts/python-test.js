import { spawnSync } from "node:child_process";
import { resolvePythonInterpreter } from "../src/services/python-worker.js";

const strict = process.argv.includes("--strict");
const interpreter = resolvePythonInterpreter({ rootDir: process.cwd() });
const probe = spawnSync(interpreter.command, [...(interpreter.argsPrefix || []), "--version"], { encoding: "utf8", windowsHide: true, shell: false });
if (probe.error || probe.status !== 0) {
  console.log(`Python tests: SKIP (${probe.error?.message || probe.stderr || "interpreter unavailable"})`);
  if (strict) process.exit(1);
  process.exit(0);
}
const result = spawnSync(interpreter.command, [...(interpreter.argsPrefix || []), "-m", "unittest", "discover", "-s", "python_worker/tests", "-p", "test_*.py"], { cwd: process.cwd(), stdio: "inherit", windowsHide: true, shell: false });
process.exit(result.status || 0);
