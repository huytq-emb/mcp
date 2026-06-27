# Hybrid Node.js + Python Extraction

Node.js remains the only MCP server. The Python package is a local compute
worker: it reads one JSON request from stdin, emits JSON Lines protocol events
on stdout, and writes logs or tracebacks to stderr. It does not import or run an
MCP SDK.

## Windows setup

Install CPython 3.12 x64 first. The Windows Store `python.exe` alias is not a
real interpreter; disable the alias if it shadows the installed Python.

```powershell
npm.cmd ci
npm.cmd run python:setup
npm.cmd run python:health -- --strict
npm.cmd run test:hybrid
```

The setup command creates `.venv` and installs `PyMuPDF` plus `orjson` from
`requirements.txt`. It never installs Python itself.

Optional figure OCR dependencies are intentionally separate because PaddleOCR is
large and not required for core PDF/manual extraction:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-ocr.txt
```

If these packages are missing, the MCP server still starts and all native
register/bitfield/table extraction continues to work. OCR health reports
`available=false` with the install hint above.

Interpreter resolution order:

1. `RENESAS_MCP_PYTHON`
2. `PDF_TOOL_PYTHON`
3. `.venv\Scripts\python.exe`
4. `python.exe` on `PATH`

## Runtime modes

- `RENESAS_MCP_EXTRACTION_ENGINE=auto` prefers parity-approved Python
  operations and falls back to Node for retryable infrastructure failures.
- `RENESAS_MCP_EXTRACTION_ENGINE=node` forces the existing Node extractors.
- `RENESAS_MCP_EXTRACTION_ENGINE=python` enables every implemented Python
  operation and treats worker failures as job failures.
- `RENESAS_MCP_PYTHON_OPERATIONS=pdf,pages,tables,structured` changes the
  parity-approved operation families used by `auto` mode.

The default parity gate enables `pdf,pages`. Tables and structured semantic
artifacts remain on Node until RZ/G3E golden parity is verified.

Structured Python migration is shadow-first:

- Python writes candidate artifacts under `indexes/.workers/<requestId>/`.
- Node validates schema, source fingerprint, counts, semantic shape and verified
  golden facts before promotion.
- Passing candidates are atomically promoted.
- Rejected candidates do not replace good Node artifacts. A report is written to
  `indexes/<pdf>.hybrid-quality.json` and `indexes/<pdf>.hybrid-quality.md`.
- In `auto` mode a rejected shadow build records the report and continues with
  the Node structured builders. In `python` mode it fails clearly.

## Worker protocol

Node spawns `.venv\Scripts\python.exe -m python_worker` with `shell:false` and
sends a bounded request through stdin. Every stdout line is one JSON event:

- `progress` reports phase and counters.
- `artifact` reports only path, schema, count, size and SHA-256.
- `result` completes a successful request.
- `error` contains a stable error code and short message.

The worker must not write human text to stdout. Third-party library chatter is
captured inside the worker; debug text and tracebacks belong on stderr only.

Large artifacts are written below `indexes/.workers/<requestId>/`. Node checks
path containment, source fingerprint, schema, count, size and SHA-256 before an
atomic promotion. Existing artifacts survive failed validation. Worker temp
directories are removed after success or failure; resumable page/table
checkpoints keep their existing public paths.

## Figure-only OCR

OCR is supplemental evidence for figure and diagram regions only. It is not used
to build canonical `pages`, `chunks`, `registers`, `bitfields`, or `pinmux`
artifacts.

OCR remains lazy and optional. Normal `index_pdf` / `start_index_pdf` runs do
not OCR every figure in a large manual. Install PaddleOCR only when you want
OCR text from rendered diagrams:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-ocr.txt
```

Document-structure parsing and PaddleOCR-VL are separate optional layers:

```powershell
# Text OCR only: labels and short text from rendered figure crops.
.\.venv\Scripts\python.exe -m pip install -r requirements-ocr.txt

# Structure parsing: layout/table/document-structure output for complex figures.
.\.venv\Scripts\python.exe -m pip install -r requirements-ocr-structure.txt

# Optional local PaddleOCR-VL parsing. This is never required for server health.
.\.venv\Scripts\python.exe -m pip install -r requirements-ocr-vl.txt
```

If PaddleOCR or PaddlePaddle is missing, the MCP server still starts. The
on-demand OCR tools return `error_code="OCR_ENGINE_UNAVAILABLE"` with the
install hint instead of crashing the server.

`python:health` and `eval_health_check(step40_action="ocr_health")` report
capability-level status for text OCR, structure parsing, and VL parsing. Missing
structure/VL dependencies are advisory unless an explicit structure/VL call is
made, and those calls return structured warnings with install hints.

The JSON-line worker sets `PADDLE_PDX_CACHE_HOME` to
`indexes/cache/paddlex` by default so PaddleX model files stay in the project
workspace on Windows. Set `PADDLE_PDX_CACHE_HOME` yourself before starting the
server if you want to use a shared pre-downloaded PaddleX model cache.

After installing the OCR packages, prewarm the local model cache before judging
OCR quality on real manuals:

```powershell
# Downloads or initializes text OCR and PP-Structure models into indexes/cache/paddlex.
npm.cmd run ocr:prewarm -- --mode=text,structure

# Optional and much heavier: include PaddleOCR-VL.
npm.cmd run ocr:prewarm -- --mode=vl
```

`ocr:prewarm` is an explicit setup command, not a server startup dependency. It
sets `PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True` for the prewarm process so
PaddleX attempts the selected model source instead of failing early when hoster
HEAD checks are blocked. Use `--check-source` if you want PaddleX's default
connectivity check, `--model-source=bos|huggingface|modelscope|aistudio` to
prefer a source, or `--cache=D:\path\to\paddlex-cache` to populate a shared
cache. If the machine has no network, copy a populated `official_models`
directory into `indexes/cache/paddlex` or point `PADDLE_PDX_CACHE_HOME` at it.

The default OCR flow is:

1. `figures.extract` detects image/vector regions with PyMuPDF, filters small
   icons/logos, captures nearby native captions, and renders only the clipped
   figure region to `renders/<pdf>/page_0001_figure_001.png`.
2. `figure_ocr.build` runs PaddleOCR only over entries in
   `indexes/<pdf>.figures.json`.
3. OCR text is stored separately in `indexes/<pdf>.figure_ocr.json` with
   `sourceType="figure_ocr"`.
4. `search_pdf` and `hybrid_search_pdf` read the OCR artifact when it exists,
   rank it below native text by default, and label results as OCR-derived so an
   agent can verify against the rendered figure/manual page.

Useful Windows commands:

```powershell
.\.venv\Scripts\python.exe workers\pdf_worker.py --action ocr_health

.\.venv\Scripts\python.exe workers\pdf_worker.py `
  --action extract_figures `
  --filename documents\r01uh1069ej0115-rzg3e.pdf `
  --out indexes\r01uh1069ej0115-rzg3e.pdf.figures.json

.\.venv\Scripts\python.exe workers\pdf_worker.py `
  --action ocr_figures `
  --filename documents\r01uh1069ej0115-rzg3e.pdf `
  --figures indexes\r01uh1069ej0115-rzg3e.pdf.figures.json `
  --out indexes\r01uh1069ej0115-rzg3e.pdf.figure_ocr.json
```

MCP compatibility route:

```text
eval_health_check(step40_action="ocr_health")
eval_health_check(step40_action="rebuild_artifact", filename="r01uh1069ej0115-rzg3e.pdf", artifact="figures")
eval_health_check(step40_action="rebuild_artifact", filename="r01uh1069ej0115-rzg3e.pdf", artifact="figure_ocr")
```

On-demand MCP tools:

```json
{
  "tool": "render_figure",
  "arguments": {
    "filename": "r01uh1069ej0115-rzg3e.pdf",
    "page": 123,
    "bbox": [72, 120, 520, 690],
    "scale": 2.0
  }
}
```

```json
{
  "tool": "ocr_figure",
  "arguments": {
    "filename": "r01uh1069ej0115-rzg3e.pdf",
    "figure_id": "p0123_f002",
    "mode": "text",
    "engine": "auto"
  }
}
```

`ocr_figure.mode` values:

- `text`: backward-compatible PaddleOCR text labels and confidence values.
- `structure`: local document-structure parsing for tables, register diagrams,
  block diagrams, and dense figure crops when the optional dependency is
  installed.
- `vl`: optional local PaddleOCR-VL parsing for visually complex diagrams. Any
  edge/topology output is unverified until cross-checked.
- `auto`: prefer structure when available, otherwise fall back to text.

```json
{
  "tool": "inspect_figure",
  "arguments": {
    "filename": "r01uh1069ej0115-rzg3e.pdf",
    "figure_id": "p0123_f002",
    "mode": "block_diagram",
    "parser": "structure",
    "include_context": true,
    "context_pages": 1
  }
}
```

`inspect_figure.parser` values:

- `safe`: default legacy behavior; caption, OCR labels when available, context,
  and conservative warnings.
- `ocr`: text OCR only.
- `structure`: local structure/document parser output normalized into hardware
  evidence.
- `vl`: optional PaddleOCR-VL output normalized into hardware evidence; visual
  graph edges are not trusted as verified facts.
- `auto`: choose a local parser from the requested figure type and installed
  capabilities.

`render_figure` and `ocr_figure` cache results under `indexes/cache/` using the
PDF filename, page, bbox, scale, engine, and source PDF size/mtime. Pass
`force=true` to bypass the cache. `inspect_figure` returns an evidence pack with
caption/provenance, rendered image path, OCR labels with bbox/confidence,
optional surrounding text, conservative summary, and explicit warnings when
connector/arrow detection is not available.

Parser responses include `semantic_evidence`, a normalized hardware-manual
evidence object. Raw PaddleOCR/PP-Structure/VL output is kept in cache artifacts
under `indexes/cache/figure-ocr/`, `figure-structure/`, or `figure-vl/`, while
the MCP response stays concise. Direct observations, engineering inferences,
source implications, uncertainties, and warnings are separated deliberately.
Visual parsing is supplemental: verify clocks, resets, interrupt routes,
register/bitfield names, sequences, timing edges, and cautions against the
manual text/register/bitfield/sequence/caution tools before trusting them in a
driver implementation.

Performance caches are incremental and on-demand:

- `figure_id` resolution may create `indexes/<manual>.figures.lookup.json` lazily
  from the existing figures artifact.
- OCR availability is cached briefly so missing PaddleOCR does not trigger a
  Python OCR worker import attempt on every call.
- Structure, VL, and normalized semantic evidence caches are separate from the
  legacy figure OCR cache, so old `indexes/<manual>.figure_ocr.json` artifacts
  remain readable.
- Surrounding figure context is cached under `indexes/cache/page-context/`.
- Cache status and cleanup are routed through the existing compatibility tool:

```text
eval_health_check(step40_action="figure_cache_status", filename="r01uh1069ej0115-rzg3e.pdf")
eval_health_check(step40_action="cleanup_figure_cache", filename="r01uh1069ej0115-rzg3e.pdf")
eval_health_check(step40_action="cleanup_figure_cache", filename="r01uh1069ej0115-rzg3e.pdf", confirm=true)
```

`cleanup_figure_cache` is a dry-run unless `confirm=true` is supplied.

## Verification and benchmark

```powershell
npm.cmd run health
npm.cmd run test:python
npm.cmd run benchmark:extraction -- --filename=r01uh1069ej0115-rzg3e.pdf --pages=200
```

Use `--strict` with the benchmark to require the 2x pages extraction target.
`doctor`, `pdf_info`, and `eval_health_check` report the configured mode,
selected engine, interpreter versions, fallback reason, and the latest hybrid
quality report status when one exists.
