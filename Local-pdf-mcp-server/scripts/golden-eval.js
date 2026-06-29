import fs from "fs/promises";
import path from "path";
import { DEFAULT_GOLDEN_PROFILE, evaluateGoldenProfile, formatGoldenReport } from "../src/eval/golden.js";

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
const strictVerifiedOnly = !hasFlag("strict-all");
const writeReport = !hasFlag("no-write");

const report = await evaluateGoldenProfile({
  root,
  profile,
  strictVerifiedOnly,
});

const text = formatGoldenReport(report);
console.log(text);

if (writeReport) {
  const indexesDir = path.join(root, "indexes");
  await fs.mkdir(indexesDir, { recursive: true });
  const stem = `${profile}.golden-report`;
  const jsonPath = path.join(indexesDir, `${stem}.json`);
  const mdPath = path.join(indexesDir, `${stem}.md`);
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  await fs.writeFile(mdPath, `${text}\n`, "utf-8");
  console.log("");
  console.log(`Golden report JSON saved: ${jsonPath}`);
  console.log(`Golden report Markdown saved: ${mdPath}`);
}

if (report.health === "fail") {
  if ((report.missingArtifacts || []).length && !(report.failures || []).length) {
    console.log("Golden eval skipped intentionally: required manual/index artifacts are unavailable in this checkout.");
    process.exit(0);
  }
  process.exit(1);
}
