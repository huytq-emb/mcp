import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const filenameArg = process.argv.find((arg) => arg.startsWith("--filename="));
const filename = filenameArg?.slice("--filename=".length) || "r01uh1069ej0115-rzg3e.pdf";
const profiles = ["usb", "can", "pcie"];
const client = new Client({ name: "profile-eval-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["index.js"],
  cwd: process.cwd(),
  stderr: "pipe",
});

try {
  await client.connect(transport);
  for (const profile of profiles) {
    const result = await client.callTool({
      name: "run_eval",
      arguments: {
        filename,
        eval_profile: profile,
        auto_index: false,
        write_report: false,
        include_golden: false,
      },
    }, undefined, { timeout: 120000, maxTotalTimeout: 120000 });
    const output = (result.content || []).map((item) => item.text || "").join("\n");
    if (!/Health:\s*PASS/i.test(output)) throw new Error(`${profile} eval did not pass:\n${output.slice(0, 3000)}`);
    console.log(`Profile eval: ${profile} PASS`);
  }
} finally {
  await client.close();
}
