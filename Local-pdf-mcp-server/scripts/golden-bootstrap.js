import { bootstrapGoldenProfile, DEFAULT_GOLDEN_PROFILE } from "../src/eval/golden.js";

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const profile = argValue("profile", DEFAULT_GOLDEN_PROFILE);
const limitRegisters = Number(argValue("limit-registers", "20"));
const limitBitfields = Number(argValue("limit-bitfields", "60"));

try {
  const result = await bootstrapGoldenProfile({
    root: process.cwd(),
    profile,
    limitRegisters,
    limitBitfields,
  });
  console.log("Golden bootstrap: PASS");
  console.log(`Profile: ${result.profilePath}`);
  console.log(`File: ${result.filename}`);
  console.log(`Added registers: ${result.added.registers}`);
  console.log(`Added bitfields: ${result.added.bitfields}`);
  console.log("Review candidate facts against the original manual, then set status=verified for facts that should gate tests.");
} catch (error) {
  console.error("Golden bootstrap: FAIL");
  console.error(error instanceof Error ? error.message : String(error));
  if (error?.missingArtifacts?.length) {
    console.error("Missing artifacts:");
    for (const item of error.missingArtifacts) console.error(`- ${item}`);
  }
  if (error?.manifestProblems?.length) {
    console.error("Manifest problems:");
    for (const item of error.manifestProblems) console.error(`- ${item}`);
  }
  process.exit(1);
}
