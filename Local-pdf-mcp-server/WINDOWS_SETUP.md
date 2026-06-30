# Windows 10/11 MCP Setup

This guide sets up the local Renesas hardware-manual MCP server on another
Windows 10/11 machine. The Node.js MCP server remains the control plane and the
Python worker is launched locally with `python.exe -m python_worker`.

No Docker or cloud API is required.

## 1. Install Prerequisites

Install these first:

- Git for Windows.
- Node.js LTS 20 or newer.
- CPython 3.12 x64 from python.org.

On Windows, disable the Microsoft Store Python aliases if they shadow the real
Python install:

```powershell
start ms-settings:appsfeatures-app
```

Then open **App execution aliases** and turn off `python.exe` / `python3.exe`
Store aliases if needed.

Verify:

```powershell
node --version
npm.cmd --version
python --version
```

Use `npm.cmd`, not `npm`, in PowerShell.

## 2. Get The Project

Clone or copy the repository, then enter the MCP project directory:

```powershell
cd C:\Users\<YOU>\Desktop
git clone <repo-url> linux-driver-developer-ai-agent
cd C:\Users\<YOU>\Desktop\linux-driver-developer-ai-agent\Local-pdf-mcp-server
```

If the repo was copied instead of cloned, the important point is that commands
must run from:

```text
...\linux-driver-developer-ai-agent\Local-pdf-mcp-server
```

Running `npm.cmd run ...` from the parent directory will fail because
`package.json` is inside `Local-pdf-mcp-server`.

## 3. Install Node Dependencies

```powershell
npm.cmd ci
```

If there is no `package-lock.json` on the copied machine, use:

```powershell
npm.cmd install
```

## 4. Set Up The Python Worker

Create `.venv` and install the base Python worker dependencies:

```powershell
npm.cmd run python:setup
npm.cmd run python:health
```

Base setup installs only:

- PyMuPDF
- orjson

This is enough for normal PDF/manual indexing and native text/table/register
extraction.

## 5. Add Manuals

Create or use the existing `documents` folder:

```powershell
New-Item -ItemType Directory -Force .\documents
```

Copy Renesas hardware-manual PDFs into:

```text
Local-pdf-mcp-server\documents\
```

Example:

```text
Local-pdf-mcp-server\documents\r01uh1069ej0115-rzg3e.pdf
```

PDFs and generated indexes are intentionally ignored by Git.

## 6. Optional OCR Setup

OCR is optional. The MCP server still starts if OCR packages or models are
missing. Missing OCR/VL capability should return structured warnings rather
than crash the server.

Install text OCR:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-ocr.txt
```

Install PP-Structure/document parser support:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-ocr-structure.txt
```

Install optional PaddleOCR-VL support:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-ocr-vl.txt
```

VL is heavier and is not required for server health or normal OCR tests.

## 7. Prewarm PaddleOCR Models

PaddleOCR/PaddleX packages do not include every model at install time. Prewarm
downloads or initializes model files into the local project cache:

```text
Local-pdf-mcp-server\indexes\cache\paddlex
```

Recommended text OCR + PP-Structure prewarm:

```powershell
npm.cmd run ocr:prewarm -- --mode=text --model-source=bos --timeout=600000
npm.cmd run ocr:prewarm -- --mode=structure --model-source=bos --timeout=900000
```

Optional VL prewarm:

```powershell
npm.cmd run ocr:prewarm -- --mode=vl --model-source=bos --timeout=1200000
```

Useful options:

```powershell
# Prefer a model source.
npm.cmd run ocr:prewarm -- --mode=text,structure --model-source=bos

# Use PaddleX's default model-source connectivity checks.
npm.cmd run ocr:prewarm -- --mode=text,structure --check-source

# Populate or use a shared cache.
npm.cmd run ocr:prewarm -- --mode=text,structure --cache=D:\paddlex-cache
```

If the machine has no internet, copy a populated PaddleX cache from another
machine, especially:

```text
indexes\cache\paddlex\official_models
```

Or set `PADDLE_PDX_CACHE_HOME` before starting the server:

```powershell
$env:PADDLE_PDX_CACHE_HOME = "D:\paddlex-cache"
npm.cmd run python:health
```

## 8. Verify The Install

Run the baseline checks:

```powershell
npm.cmd run check
npm.cmd run static-health
npm.cmd run architecture-health
npm.cmd run python:health
npm.cmd run startup-smoke
```

Optional test suites:

```powershell
npm.cmd run test:unit
npm.cmd run test:python
```

If local PDFs are present and you want a tool smoke test:

```powershell
npm.cmd run test:tools
```

`test:tools` expects a suitable manual in `documents`; adjust the script or run
individual MCP tools if your PDF filename differs.

## 9. Start The MCP Server

From `Local-pdf-mcp-server`:

```powershell
npm.cmd start
```

The MCP server communicates over stdio. A client configuration should point to
Node and this server's `index.js`.

Example MCP client entry:

```json
{
  "mcpServers": {
    "local-renesas-manuals": {
      "command": "node",
      "args": [
        "C:\\Users\\<YOU>\\Desktop\\linux-driver-developer-ai-agent\\Local-pdf-mcp-server\\index.js"
      ],
      "cwd": "C:\\Users\\<YOU>\\Desktop\\linux-driver-developer-ai-agent\\Local-pdf-mcp-server"
    }
  }
}
```

If your client supports environment variables, you may pin Python/cache paths:

```json
{
  "env": {
    "RENESAS_MCP_PYTHON": "C:\\Users\\<YOU>\\Desktop\\linux-driver-developer-ai-agent\\Local-pdf-mcp-server\\.venv\\Scripts\\python.exe",
    "PADDLE_PDX_CACHE_HOME": "C:\\Users\\<YOU>\\Desktop\\linux-driver-developer-ai-agent\\Local-pdf-mcp-server\\indexes\\cache\\paddlex"
  }
}
```

## 10. First MCP Checks

After connecting the client, try:

```text
list_pdfs()
```

Then:

```text
eval_health_check(step40_action="ocr_health", json=true)
```

Expected OCR health shape includes:

```text
{
  "ocr": {
    "text": { "available": true },
    "structure": { "available": true_or_false },
    "vl": { "available": true_or_false },
    "modelCache": {
      "path": "...\\indexes\\cache\\paddlex",
      "modelCount": 0
    }
  }
}
```

`available=true` means the package/export check passed. It does not guarantee
that model inference has already succeeded. Run `ocr:prewarm` or a real
`ocr_figure_for_search` and canonical figure-image tests to verify model availability.
Actual responses use normal JSON booleans (`true` or `false`).

`modelCount` may be `0` until you run `ocr:prewarm` or copy model files.

By default, the canonical figure workflow avoids selecting PaddleOCR-VL
because VL can be slow or model-cache sensitive on Windows. To allow auto mode
to select VL for timing/sequence/flowchart figures when PP-Structure is not
available, set:

```powershell
$env:RENESAS_MCP_AUTO_VL = "1"
```

## 11. Common Problems

### npm cannot find package.json

You are probably in the parent folder. Run:

```powershell
cd C:\Users\<YOU>\Desktop\linux-driver-developer-ai-agent\Local-pdf-mcp-server
npm.cmd run python:health
```

Or use:

```powershell
npm.cmd --prefix .\Local-pdf-mcp-server run python:health
```

### PowerShell blocks npm.ps1

Use:

```powershell
npm.cmd run <script>
```

### Python worker not found

Run:

```powershell
npm.cmd run python:setup
```

If needed, set:

```powershell
$env:RENESAS_MCP_PYTHON = "$PWD\.venv\Scripts\python.exe"
```

### OCR says model hosting unavailable

Run prewarm from the project directory:

```powershell
npm.cmd run ocr:prewarm -- --mode=text --model-source=bos --timeout=600000
npm.cmd run ocr:prewarm -- --mode=structure --model-source=bos --timeout=900000
```

If the machine is offline, copy a populated `indexes\cache\paddlex` directory
from another machine.

### OCR health says VL is available but VL inference fails

`vl.available=true` can mean the package/class is importable. VL still needs its
model cache. Run:

```powershell
npm.cmd run ocr:prewarm -- --mode=vl --model-source=bos --timeout=1200000
```

VL output must be treated as unverified visual evidence until cross-checked
against manual text, registers, bitfields, sequences, and cautions.

## 12. What To Copy For An Offline Machine

For a second machine without internet, copy:

- The repository.
- `Local-pdf-mcp-server\documents\*.pdf`
- Optional generated indexes under `Local-pdf-mcp-server\indexes\`
- Optional OCR model cache under
  `Local-pdf-mcp-server\indexes\cache\paddlex\official_models`

Still run:

```powershell
npm.cmd ci
npm.cmd run python:setup
npm.cmd run python:health
```

If copying `.venv` between machines fails, recreate it with `python:setup`.
