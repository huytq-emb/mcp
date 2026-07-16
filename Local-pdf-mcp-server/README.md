# Local PDF MCP Server

Local MCP server for AI agents working from PDF hardware manuals during Linux driver development.

## What this server does

- Provides local PDF hardware-manual retrieval and evidence extraction.
- Produces searchable text/page/register/bitfield/sequence/caution/table/figure evidence.
- Returns local PNG paths for figures so the AI agent can inspect images visually.
- Does not require network access after dependencies are installed.
- Does not require Docker.
- Optional Python/PyMuPDF/OCR can improve rendering and extraction paths, but is not required for the default unit/static workflow.

## Directory layout

```text
Local-pdf-mcp-server/
documents/                         PDF manuals go here
indexes/                           generated indexes/artifacts/cache/job state
indexes/cache/figure-images/       canonical figure PNG cache
src/                               implementation
docs/                              workflow docs
python_worker/                     optional Python worker
.venv/                             optional local Python virtual environment
```

## Windows setup

Validated local baseline:

- Node.js 24.17.x with npm 11.13.x.
- CPython 3.12.x for the optional project `.venv` worker.
- Runtime is offline-first after npm/Python dependencies and optional PaddleX
  OCR model cache have been installed or prewarmed.

```powershell
cd Local-pdf-mcp-server
npm install
npm run check
npm run startup-smoke
npm run health
```

If PowerShell blocks `npm.ps1`, call `npm.cmd` directly:

```powershell
npm.cmd install
npm.cmd run check
npm.cmd run startup-smoke
npm.cmd run health
```

Put PDFs under `documents/`. Generated artifacts, caches, and job state go under `indexes/`. The server should work without network access after dependencies are installed.

## Optional Python/PyMuPDF setup

Python/PyMuPDF is optional. It is useful for high-quality rendering, figure image extraction, and optional Python extraction paths. It is not required for basic unit/static tests. PaddleOCR is not required for normal workflow, and OCR unavailable is not fatal.

Relevant environment variables:

- `RENESAS_MCP_PYTHON`
- `RENESAS_MCP_ROOT`
- `PDF_MANUAL_MCP_ROOT`
- `RENESAS_MCP_EXTRACTION_ENGINE`
- `RENESAS_MCP_PYTHON_OPERATIONS`
- `RENESAS_MCP_OCR_HEALTH_TIMEOUT_MS` (optional OCR health timeout; default
  `30000` on Windows-friendly setups)

OCR/text/structure/VL model files should live in the project-local PaddleX cache
at `indexes/cache/paddlex` when you want offline OCR operation. Run
`npm.cmd run python:health` to confirm Python extraction and optional OCR health.

## MCP client config example

```json
{
  "mcpServers": {
    "local-pdf-mcp-server": {
      "command": "node",
      "args": [
        "<PROJECT_ROOT>\\index.js"
      ],
      "env": {
        "RENESAS_MCP_ROOT": "<PROJECT_ROOT>"
      }
    }
  }
}
```

## AI agent workflow

See [docs/AGENT_WORKFLOW.md](docs/AGENT_WORKFLOW.md) for the canonical AI-agent workflow. In short, keep manual facts, visual observations, source-code findings, and engineering inference separate.

For new agent integrations, use the direct structured EvidenceBundle v2 tools:

```text
query_manual(filename="...", query="DMACm_DCTRL reset and LWCA")
get_manual_entity(filename="...", entity_id="register:...")
read_manual_evidence(filename="...", entity_id="register:...")
collect_manual_evidence(filename="...", task="Review DMA driver IRQ clear handling", module_type="dmaengine", depth="deep")
```

These tools use exact-symbol, graph, page-neighborhood, and—when the graph and
lexical corpus fit safely in one Node heap—lexical retrieval, then return
provenance, conflicts, gaps, verification requirements, and pagination in
`structuredContent`. For very large graphs, the bundle explicitly warns that
in-process lexical fusion was deferred; use `hybrid_search_pdf` as a separate
request for chunk-level corroboration. See [EvidenceBundle v2 migration](docs/EVIDENCE_BUNDLE_V2.md).

Public tools are grouped into primary evidence, advanced/manual inspection,
compatibility, and control generations. Normal agent workflows should start
with the primary EvidenceBundle tools, the canonical figure handoff, and
`mcp_control`; see [tool classification and migration](docs/TOOL_CLASSIFICATION.md).

See [semantic evaluation](docs/SEMANTIC_EVALUATION.md) for verified datasets, metrics, the strict real-manual runner, and measured retrieval improvements.

## First commands after adding a PDF

```text
list_pdfs
pdf_info(filename="...")
doctor(filename="...")
index_pdf(filename="...", mode="background")
mcp_control(action="list_jobs")
mcp_control(action="job_status", job_id="...")
# Direct job_status/list_jobs/start_index_pdf/validate_index helpers are hidden compatibility paths; prefer mcp_control/doctor.
```

## Figure commands

Canonical retrieval-first figure workflow:

```text
rebuild_figure_manifest(filename="...")
search_figures(filename="...", query="timing diagram")
get_figure_context_pack(filename="...", figure_id="...")
get_figure_image(filename="...", figure_id="...", transport="metadata")
# client/agent opens or attaches canonical_image_path as actual model vision input
```

The normal workflow uses `transport="metadata"`; RICA client-side local image bridge can consume `canonical_image_path` and attach the image pixels to the model. The AI agent must open or attach `canonical_image_path` visually. Caption, page text, and OCR text are supporting evidence only. Optional OCR can improve search metadata:

```text
ocr_figure_for_search(filename="...", figure_id="...")
```

OCR is optional and should not be required for normal figure retrieval. OCR/VL/semantic parser output is not final semantic truth.

## Troubleshooting

### Tool call canceled

- Use background mode.
- Use `mcp_control(action="list_jobs")`, then `mcp_control(action="job_status", job_id="...")`.
- Avoid foreground full rebuilds on large manuals.

### Large PDF timeout

- Use `index_pdf(filename="...", mode="background")` or `mcp_control(action="rebuild_artifact", filename="...", artifact="...")`.
- Poll with `mcp_control(action="job_status", job_id="...")`.

### Stale lock

- Run `doctor(filename="...")` or `mcp_control(action="index_status_lite", filename="...")` first.
- Use `force_lock` only if no indexing worker is running.

`index_status_lite` performs bounded artifact-header checks, validates the ready
manifest against the current PDF SHA-256 identity, includes recent jobs, and
reports stale/missing/broken state without parsing large artifacts in full.

## Manual acceptance runner

To exercise every PDF discovered recursively under `documents/` and write the
JSON and Markdown reports under `indexes/`, run:

```powershell
npm.cmd run test:manuals -- --require-manuals --write
```

Large manuals use detached background indexing and bounded job polling. Nested
paths and duplicate basenames are reported as failures because the public MCP
contract accepts direct filenames only; they are never silently skipped.

### Single-manual acceptance

Use `--filename` with a PDF basename to run only one manual:

```powershell
npm.cmd run test:manuals -- `
  --require-manuals `
  --filename=r01uh1069ej0115-rzg3e.pdf `
  --write `
  --trace-memory
```

`--filename` accepts a basename such as `manual.pdf`, not a relative or absolute
path. The runner executes only that exact, case-insensitive basename. It fails
if the manual does not exist or if recursive discovery finds the basename in
more than one directory. It never falls back to running every manual. A selected
large manual still uses background indexing.

### Forced rebuild

Add `--force` to rebuild the selected manual's index and artifacts instead of
reusing a valid ready generation:

```powershell
npm.cmd run test:manuals -- `
  --require-manuals `
  --filename=r01uh1069ej0115-rzg3e.pdf `
  --force `
  --write `
  --trace-memory
```

A forced large-manual rebuild still uses background mode. The runner obtains the
job ID from `index_pdf`, then polls `mcp_control(action="job_status")`. If the
indexing timeout expires, it sends `mcp_control(action="cancel_job")` and starts
a separate, bounded cancellation-confirmation poll. The manual remains an
`INDEX_TIMEOUT` result even if the post-cancellation terminal state is `done`,
`failed`, or `cancelled`; only `cancelled` represents successful cancellation in
the business sense.

### Polling and cancellation options

- `--timeout-ms`: indexing timeout. Default `7200000` ms (two hours); the runner
  enforces a minimum of `60000` ms.
- `--poll-ms`: normal background-job polling interval. Default `2000` ms; the
  runner enforces a minimum of `250` ms.
- `--cancel-confirm-timeout-ms`: separate grace period for observing a terminal
  state after cancellation is requested. Default `30000` ms and minimum `1000`
  ms.
- `--cancel-confirm-poll-ms`: polling interval during the cancellation grace
  period. Default `500` ms and minimum `100` ms; it must not exceed
  `--cancel-confirm-timeout-ms`.

Cancellation confirmation retries `queued`, `running`, and `unknown`, and stops
on `done`, `failed`, or `cancelled`. It never reuses the two-hour indexing timeout
as its grace period and never polls indefinitely. The JSON report records both
cancellation option values and, when cancellation is attempted, the cancel
response status, final observed status, confirmation duration, and poll count.

### Report schema version 2

The JSON report uses `schemaVersion: 2`. Each manual records these latency
arrays:

```text
evidenceQueryLatenciesMs
controlLatenciesMs
advancedToolLatenciesMs
figureLatenciesMs
allToolLatenciesMs
```

Evidence-query latency contains only calls to `query_manual`,
`get_manual_entity`, `read_manual_evidence`, and `collect_manual_evidence`.
All-tool latency contains every tool call made by the runner, including control,
indexing, advanced-inspection, and figure calls. The report summarizes the two
relevant populations with:

```text
evidenceQueryP50Ms
evidenceQueryP95Ms
allToolP50Ms
allToolP95Ms
```

Cold/warm evidence timing is recorded separately as:

```text
coldEvidenceQueryMs
warmEvidenceQueryLatenciesMs
```

The cold measurement and every warm measurement execute `query_manual` with the
same exact filename, query, `top_k`, and other arguments; only cache warmth is
intended to differ.

### Shared-process memory semantics

The report declares:

```text
processIsolation.model = shared-process-sequential
```

Each manual has these process measurements:

```text
processRssBeforeManualMb
processRssAfterManualMb
processPeakRssThroughManualMb
processRssDeltaMb

processHeapBeforeManualMb
processHeapAfterManualMb
processPeakHeapThroughManualMb
processHeapDeltaMb
```

This is one shared runner process, not an isolated process per manual. Retained
cache or other state from a previous manual can affect later manuals. With
`--filename`, the fields describe one manual within that shared process, but
they are still not an OS-level isolated benchmark.

### Report path privacy

Before either output format is written, project-local absolute paths are
converted to forward-slash project-relative paths. External absolute paths are
replaced token by token with `[external-path]`, so runtime messages retain error
codes and other non-sensitive context. Local `file://` URLs follow the same
underlying-path policy; web URLs are preserved. Generated reports are
`indexes/all-manual-integration-report.json` and
`indexes/all-manual-integration-report.md`. The parent `.gitignore` excludes the
entire `indexes/` directory from Git.

### Missing figures manifest

- Run `rebuild_figure_manifest(filename="...")`.

### Canonical figure image workflow

```text
rebuild_figure_manifest
-> search_figures
-> get_figure_context_pack
-> get_figure_image transport="metadata"
-> client/agent opens or attaches canonical_image_path as real image input
-> only then perform visual-semantic analysis
```

Non-goals and trust rules:

```text
`mcp_image` and `image_url` are experimental/debug compatibility only.
Normal workflow uses metadata and a client-side local image bridge.
OCR/caption/page context are optional search metadata, not visual-semantic truth.
```

`get_figure_image` defaults to the stable metadata contract: `canonical_image_path`, `local_path`, file existence/size, and MIME. `mcp_image` and `image_url` remain experimental/debug compatibility modes only; RICA/VS Code may reduce MCP tool results to text-only, so visual-semantic claims require the actual PNG to be opened or attached as model vision input. If no actual image input is available, return `NO_IMAGE_INPUT`.


### `image_path` exists=false

- Run `get_figure_image(filename="...", figure_id="...")`.
- Confirm optional renderer/Python availability.
- Treat visual evidence as unavailable if still missing.

### OCR unavailable

- Not fatal.
- Normal figure workflow still works without OCR.
