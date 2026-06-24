import fs from "fs/promises";
import path from "path";
import { buildGoldenSeedReport, DEFAULT_GOLDEN_PROFILE, formatGoldenSeedReport } from "../src/eval/golden.js";

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const root = process.cwd();
const profile = argValue("profile", DEFAULT_GOLDEN_PROFILE);
const limitRegisters = Number(argValue("limit-registers", "12"));
const limitBitfields = Number(argValue("limit-bitfields", "20"));
const writeReport = !hasFlag("no-write");

const report = await buildGoldenSeedReport({
  root,
  profile,
  limitRegisters,
  limitBitfields,
});

const text = formatGoldenSeedReport(report);
console.log(text);

if (writeReport) {
  const indexesDir = path.join(root, "indexes");
  await fs.mkdir(indexesDir, { recursive: true });
  const stem = `${profile}.golden-seed-report`;
  const jsonPath = path.join(indexesDir, `${stem}.json`);
  const mdPath = path.join(indexesDir, `${stem}.md`);
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  await fs.writeFile(mdPath, `${text}\n`, "utf-8");
  console.log("");
  console.log(`Golden seed report JSON saved: ${jsonPath}`);
  console.log(`Golden seed report Markdown saved: ${mdPath}`);
}

if (report.health === "fail") process.exit(1);
