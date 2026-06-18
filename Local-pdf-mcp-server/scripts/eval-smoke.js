import fs from "fs";
import path from "path";

const root = process.cwd();
const documentsDir = path.join(root, "documents");
const evalDir = path.join(root, "eval");
const profilesDir = path.join(evalDir, "profiles");
const fixturesDir = path.join(evalDir, "fixtures");

const failures = [];

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    return null;
  }
}

const pdfs = fs.existsSync(documentsDir)
  ? fs.readdirSync(documentsDir).filter((file) => file.toLowerCase().endsWith(".pdf"))
  : [];
if (!pdfs.length) failures.push("No PDF fixture found in documents/");

const manualCases = readJson(path.join(evalDir, "manual-cases.json"), "eval/manual-cases.json");
if (manualCases && !Array.isArray(manualCases.cases)) failures.push("eval/manual-cases.json must contain cases[]");

for (const dir of [profilesDir, fixturesDir]) {
  if (!fs.existsSync(dir)) {
    failures.push(`Missing ${path.relative(root, dir)}`);
    continue;
  }
  for (const file of fs.readdirSync(dir).filter((item) => item.endsWith(".json"))) {
    const data = readJson(path.join(dir, file), path.relative(root, path.join(dir, file)));
    if (!data) continue;
    if (!Object.prototype.hasOwnProperty.call(data, "schemaVersion")) failures.push(`${file} missing schemaVersion`);
    if (!Array.isArray(data.cases)) failures.push(`${file} must contain cases[]`);
  }
}

if (failures.length) {
  console.error("Eval smoke: FAIL");
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}

console.log(`Eval smoke: PASS (pdfs=${pdfs.length})`);
