let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(raw);
  const base = { protocolVersion: request.protocolVersion, workerVersion: "fake", requestId: request.requestId };
  if (request.options?.mode === "malformed") {
    process.stdout.write("not-json\n");
    return;
  }
  if (request.options?.mode === "oversized") {
    process.stdout.write("x".repeat(1024 * 1024 + 10) + "\n");
    return;
  }
  if (request.options?.mode === "delay") {
    setTimeout(() => process.stdout.write(JSON.stringify({ ...base, type: "result", ok: true, result: {} }) + "\n"), 1000);
    return;
  }
  if (request.options?.mode === "crash") {
    process.exitCode = 3;
    return;
  }
  if (request.options?.mode === "stderr") process.stderr.write("debug-only\n");
  process.stdout.write(JSON.stringify({ ...base, type: "progress", phase: "test", current: 1, total: 1 }) + "\n");
  process.stdout.write(JSON.stringify({ ...base, type: "result", ok: true, durationMs: 2, result: { echo: request.operation } }) + "\n");
});
