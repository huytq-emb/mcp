import { runCli } from "./src/app/bootstrap.js";

const exitCode = await runCli(process.argv);
if (exitCode) process.exitCode = exitCode;
