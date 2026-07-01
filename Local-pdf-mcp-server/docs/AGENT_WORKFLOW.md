# AI Agent Workflow

## Scope

- The MCP server provides local hardware-manual retrieval and evidence extraction.
- The MCP server does not read the Linux source tree directly.
- VS Code/Codex/AI agents read Linux source and DTS files separately.
- MCP manual evidence must be combined with source-code inspection by the AI agent.
- Manual evidence, visual observations, engineering inferences, and source-code findings must remain separated.

## Default workflow for driver/manual tasks

1. Discover available manuals: `list_pdfs`.
2. Inspect manual/index state: `pdf_info(filename)`, `doctor(filename)`, or `mcp_control(action="index_status_lite", filename="...")`.
3. If index/artifacts are missing:
   - Small/medium PDFs: `index_pdf(filename)`.
   - Large PDFs or timeout-prone clients: `index_pdf(filename, mode="background")`, then poll with `mcp_control(action="job_status", job_id="...")` and list with `mcp_control(action="list_jobs")`.
4. Ask the workflow router: `plan_manual_workflow(filename, task, module_type?, driver_family?, source_files?)`.
5. Follow the tools suggested by `plan_manual_workflow` unless the user explicitly requests another path.
6. Produce a final response with separated evidence: manual facts, visual observations, source-code findings, engineering inference, and uncertainty/missing evidence.

## Evidence-specific workflows

### Register evidence

- `find_register`
- `list_registers`
- `summarize_register`
- `extract_register_table`
- `verify_register_usage`

### Bitfield evidence

- `find_bitfield`
- `list_bitfields`
- `extract_bitfield_table`
- `summarize_register`

### Operation sequence evidence

- `list_sequences`
- `get_sequence`

### Caution/restriction evidence

- `list_cautions`
- `get_cautions_for_register`

### Table evidence

- `extract_tables_from_pages`
- `extract_register_table`
- `extract_bitfield_table`
- `extract_tables_from_pages` plus `read_pdf_pages` for pinmux/table cross-checks

### Figure evidence

- `rebuild_figure_manifest`
- `search_figures`
- `get_figure_image`
- `get_figure_context_pack`
- `ocr_figure_for_search` only when search quality needs OCR keywords

### Control-plane / job workflow

- `mcp_control(action="ping")`
- `mcp_control(action="index_status_lite", filename="...")`
- `mcp_control(action="rebuild_artifact", filename="...", artifact="...")`
- `mcp_control(action="job_status", job_id="...")`
- `mcp_control(action="list_jobs")`
- `mcp_control(action="cancel_job", job_id="...")`
- `mcp_control(action="cache_status", filename="...")`
- `mcp_control(action="figure_cache_status", filename="...")`

## Figure workflow

Canonical visual-semantic workflow:

```text
rebuild_figure_manifest
-> search_figures
-> get_figure_context_pack
-> get_figure_image transport="metadata"
-> client/agent opens or attaches canonical_image_path as real image input
-> only then perform visual-semantic analysis
```

1. Build/update figure manifest: `rebuild_figure_manifest(filename)`.
2. Search candidate figure/table/diagram: `search_figures(filename, query, kind?, page?, section?)`.
3. Get locator/context pack: `get_figure_context_pack(filename, figure_id, dpi?, include_ocr=false)`.
4. Get stable image metadata: `get_figure_image(filename, figure_id, transport="metadata")`.
5. AI agent/client/user must open or attach `canonical_image_path` / `local_path` as actual model vision input before semantic visual claims.
6. If no actual image input is available, return `NO_IMAGE_INPUT` or state that semantic figure analysis is unavailable.
7. Treat `caption`, `page_text_before`, `page_text_after`, and `ocr_text` as search/context hints only, not visual truth.
8. `mcp_image` and `image_url` are experimental/client-dependent compatibility modes. They are not proof that the model saw the image; RICA/VS Code may reduce MCP image payloads to text-only.
9. If `image_path` is missing or `image_access.exists=false`:
   - report visual evidence unavailable;
   - try `get_figure_image(filename, figure_id)` to regenerate/locate canonical metadata;
   - if still unavailable, do not perform visual-semantic analysis from text/OCR alone.

## Evidence discipline

Direct manual text evidence: facts extracted from `read_pdf_pages`, `read_pdf_chunk`, register, bitfield, sequence, and caution tools.

Direct visual observation: facts the AI agent can see only after the actual canonical PNG has been opened/attached as model vision input.

Engineering inference: driver implication derived from manual, visual evidence, and source inspection.

Source-code finding: fact from Linux source/DTS files read by the AI agent outside MCP.

Rules:

- Do not mix direct observations with inference.
- Mark uncertainty when figure/text/table evidence is incomplete.
- Do not claim a driver bug unless both source evidence and manual evidence are checked.
- Keep manual facts, visual observations, and source-code findings traceable to their source.

## Large PDF policy

- For manuals larger than 350 pages or timeout-prone MCP clients, prefer background indexing.
- Do not run long foreground rebuilds when the MCP client may cancel.
- Use `mcp_control` for job polling and cleanup.
- Use `doctor` and `mcp_control(action="index_status_lite", filename="...")` after rebuild completes.

## Anti-patterns

Avoid or forbid these patterns:

- Guessing driver behavior from search snippets only.
- Using OCR output as final semantic truth.
- Running full OCR/VL over all figures by default.
- Rebuilding all artifacts repeatedly without checking status.
- Calling `eval_health_check` for job control.
- Treating missing optional OCR as fatal.
- Mixing manual evidence and source-code inference in one statement.
- Calling legacy/removed figure tools as part of normal AI-agent workflow.
