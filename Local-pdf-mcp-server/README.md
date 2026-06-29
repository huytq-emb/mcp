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

## MCP client config example

```json
{
  "mcpServers": {
    "local-pdf-mcp-server": {
      "command": "node",
      "args": [
        "C:\\path\\to\\mcp\\Local-pdf-mcp-server\\index.js"
      ],
      "env": {
        "RENESAS_MCP_ROOT": "C:\\path\\to\\mcp\\Local-pdf-mcp-server"
      }
    }
  }
}
```

## AI agent workflow

See [docs/AGENT_WORKFLOW.md](docs/AGENT_WORKFLOW.md) for the canonical AI-agent workflow. In short, keep manual facts, visual observations, source-code findings, and engineering inference separate.

## First commands after adding a PDF

```text
list_pdfs
pdf_info(filename="...")
doctor(filename="...")
index_pdf(filename="...", mode="background")
mcp_control(action="list_jobs")
mcp_control(action="job_status", job_id="...")
validate_index(filename="...")
```

## Figure commands

Canonical retrieval-first figure workflow:

```text
rebuild_figure_manifest(filename="...")
search_figures(filename="...", query="timing diagram")
get_figure_context_pack(filename="...", figure_id="...")
```

The AI agent must open `image_path` visually. Caption, page text, and OCR text are supporting evidence only. Optional OCR can improve search metadata:

```text
ocr_figure_for_search(filename="...", figure_id="...")
```

OCR is optional and should not be required for normal figure retrieval. OCR/VL/semantic parser output is not final semantic truth.

## Troubleshooting

### Tool call canceled

- Use background mode.
- Use `mcp_control(action="job_status")`.
- Avoid foreground full rebuilds on large manuals.

### Large PDF timeout

- Use `index_pdf(filename="...", mode="background")` or `mcp_control(action="rebuild_artifact", filename="...", artifact="...")`.
- Poll with `mcp_control(action="job_status", job_id="...")`.

### Stale lock

- Run `doctor(filename="...")` and `validate_index(filename="...")` first.
- Use `force_lock` only if no indexing worker is running.

### Missing figures manifest

- Run `rebuild_figure_manifest(filename="...")`.

### `image_path` exists=false

- Run `get_figure_image(filename="...", figure_id="...")`.
- Confirm optional renderer/Python availability.
- Treat visual evidence as unavailable if still missing.

### OCR unavailable

- Not fatal.
- Normal figure workflow still works without OCR.
