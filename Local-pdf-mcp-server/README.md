# Local Renesas Manual MCP Server

This MCP server is for Linux BSP driver work against large Renesas hardware manuals. It is not a generic PDF reader: its outputs are register, bitfield, sequence, caution, table, visual-evidence, and driver-review artifacts.

## Windows Setup

Use `npm.cmd` from PowerShell to avoid ExecutionPolicy blocking `npm.ps1`.

```powershell
npm.cmd ci
npm.cmd run health
npm.cmd run smoke
npm.cmd test
```

Start the MCP server:

```powershell
npm.cmd start
```

## Large Manual Workflow

1. Put manuals in `documents/`.
2. Run `doctor(filename="<manual>.pdf")`.
3. For large manuals, run `start_index_pdf(filename="<manual>.pdf")` and poll `job_status(job_id="...")`.
4. Re-run `doctor` or `pdf_info` after indexing.
5. For driver work, use `build_driver_evidence_pack`, `source_review_prompt_pack`, and `verify_register_usage`.

## Golden Accuracy Eval

V2 adds a register/bitfield golden layer for `r01uh1069ej0115-rzg3e.pdf`.
Candidate facts are generated from index artifacts, but only facts marked `"status": "verified"` can fail CI.

```powershell
npm.cmd run golden:eval
npm.cmd run golden:bootstrap
npm.cmd run test:golden
```

Use `run_eval(include_golden=true, golden_profile="rzg3e-core", strict_verified_only=true)` when you want MCP eval output to include the same structured golden checks. Bootstrap requires core index artifacts; if they are missing, run `start_index_pdf(filename="r01uh1069ej0115-rzg3e.pdf")` first and wait for `job_status` to finish.

## Artifact Contract

The server writes legacy text artifacts plus JSON/Markdown companion artifacts where driver-critical output is involved:

- `indexes/<manual>.manifest.json`
- `indexes/<manual>.driver-pack.txt`
- `indexes/<manual>.driver-pack.json`
- `indexes/<manual>.driver-pack.md`
- `indexes/<manual>.driver-task-plan.txt`
- `indexes/<manual>.driver-task-plan.json`
- `indexes/<manual>.driver-task-plan.md`

Driver-facing JSON artifacts include evidence, inferences, verification gaps, warnings, and recommended next tools. Search-only evidence is a lead, not final proof for driver constants or register semantics.
