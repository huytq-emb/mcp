import { getHybridRuntimeStatus } from "../src/services/python-worker.js";
import { getOcrHealth } from "../src/services/ocr.js";

const strict = process.argv.includes("--strict");
const status = await getHybridRuntimeStatus({ force: true });
const ocr = await getOcrHealth({ force: true });
console.log(`Python worker health: ${status.pythonReady ? "READY" : strict ? "FAIL" : "ADVISORY"}`);
console.log(JSON.stringify(status, null, 2));
console.log(`OCR health: ${ocr.ocr?.available ? "AVAILABLE" : "OPTIONAL-MISSING"}`);
console.log(JSON.stringify({ ocr: ocr.ocr, python: ocr.python }, null, 2));
if (strict && !status.pythonReady) process.exit(1);
