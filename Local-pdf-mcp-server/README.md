# Local PDF MCP Server

## Figure retrieval architecture

The MCP server does **not** attempt to fully understand engineering figures. It finds relevant figures in PDF manuals, renders them to cached PNG files, and returns surrounding textual context and searchable metadata.

```text
MCP server = figure retrieval + canonical PNG cache + context pack
AI agent   = visual reasoning / figure understanding
```

Normal figure indexing avoids heavy OCR, vision-language, or semantic figure parsing. Optional OCR is available only to improve search/indexing, and OCR output should be treated as supporting text rather than final semantic truth.

### Figure workflow

1. `search_figures(filename, query)` to locate candidate figures by caption, section title, nearby text, cached OCR keywords, and related metadata.
2. `get_figure_context_pack(filename, figure_id, dpi?)` to get the PNG path, image access metadata, caption, section title, nearby text, and related cached evidence.
3. The AI agent opens `image_path` as an image.
4. The AI agent analyzes the figure visually using its own multimodal model, with caption and nearby text only as supporting evidence.

Canonical figure images are stored under `indexes/cache/figure-images`. Legacy `render/` or `renders/` folders are ignored by the AI-agent figure workflow, and their paths are not returned as AI-usable `image_path` values. AI agents should use `search_figures` followed by `get_figure_context_pack`.

Every image-oriented figure response includes an `image_access` object with a local path, MIME type `image/png`, existence flag, and `agent_should_open_as_image: true`.

### Figure tools

- `list_figures(filename, page?, section?, limit?)` lists records from `<filename>.figures.json` without running heavy OCR/VL.
- `search_figures(filename, query, page?, section?, limit?)` ranks manifest records using exact technical token matches, captions, section titles, nearby text, cached OCR keywords, and related evidence.
- `get_figure_image(filename, figure_id, dpi?)` ensures a PNG exists and returns image metadata.
- `get_figure_context_pack(filename, figure_id, dpi?, include_ocr=false, include_tables=true, include_cautions=true)` is the primary AI-agent handoff API. Optional `dpi` requests figure/page render quality and defaults to 200 when omitted.
- `rebuild_figure_manifest(filename, page?, force=false)` rebuilds `<filename>.figures.json` without heavy OCR/VL by default.
- `ocr_figure_for_search(filename, figure_id, force=false)` optionally runs lightweight OCR for search metadata only.

Render integration tests that exercise real Python/PyMuPDF rendering probe for `python3` on non-Windows platforms (or `python` on Windows, unless `RENESAS_MCP_PYTHON` is set) and skip with a clear reason when `import fitz` is unavailable. The default unit workflow does not require OCR/VL, network access, or external Python dependencies.


### Public figure toolset

The advertised MCP figure tools are limited to:

```text
rebuild_figure_manifest
list_figures
search_figures
get_figure_image
get_figure_context_pack
ocr_figure_for_search
```

The public workflow is:

```text
rebuild_figure_manifest -> search_figures -> get_figure_context_pack -> open image_path visually
```

Legacy figure tools such as `build_figures_index`, `find_figure`, `get_figure_context`, `inspect_figure`, `render_figure`, `render_figure_page`, `render_figure_region`, and `ocr_figure` are not advertised to MCP clients by default.
