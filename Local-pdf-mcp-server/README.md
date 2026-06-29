# Local PDF MCP Server

## Figure retrieval architecture

The MCP server does **not** attempt to fully understand engineering figures. It finds relevant figures in PDF manuals, renders them to cached PNG files, and returns surrounding textual context and searchable metadata.

```text
MCP server = figure retrieval + render cache + context pack
AI agent   = visual reasoning / figure understanding
```

Normal figure indexing avoids heavy OCR, vision-language, or semantic figure parsing. Optional OCR is available only to improve search/indexing, and OCR output should be treated as supporting text rather than final semantic truth.

### Figure workflow

1. `search_figures(filename, query)` to locate candidate figures by caption, section title, nearby text, cached OCR keywords, and related metadata.
2. `get_figure_context_pack(filename, figure_id)` to get the PNG path, image access metadata, caption, section title, nearby text, and related cached evidence.
3. The AI agent opens `image_path` as an image.
4. The AI agent analyzes the figure visually using its own multimodal model, with caption and nearby text only as supporting evidence.

Every image-oriented figure response includes an `image_access` object with a local path, MIME type `image/png`, existence flag, and `agent_should_open_as_image: true`.

### Figure tools

- `list_figures(filename, page?, section?, limit?)` lists records from `<filename>.figures.json` without running heavy OCR/VL.
- `search_figures(filename, query, page?, section?, limit?)` ranks manifest records using exact technical token matches, captions, section titles, nearby text, cached OCR keywords, and related evidence.
- `get_figure_image(filename, figure_id, dpi?)` ensures a PNG exists and returns image metadata.
- `get_figure_context_pack(filename, figure_id, include_ocr=false, include_tables=true, include_cautions=true)` is the primary AI-agent handoff API.
- `render_figure(filename, page?, figure_id?, bbox?, dpi=200, force=false)` renders a figure or explicit bbox without semantic analysis.
- `rebuild_figure_manifest(filename, page?, force=false)` rebuilds `<filename>.figures.json` without heavy OCR/VL by default.
- `ocr_figure_for_search(filename, figure_id, force=false)` optionally runs lightweight OCR for search metadata only.

Legacy `inspect_figure` remains available for compatibility, but new clients should prefer `get_figure_context_pack` and perform visual reasoning in the AI agent.


### Canonical vs compatibility figure tools

The preferred retrieval-first tools are `rebuild_figure_manifest`, `list_figures`, `search_figures`, `get_figure_image`, `get_figure_context_pack`, and optional `ocr_figure_for_search`.

Some older visual-review tools remain available for compatibility:

| Prefer | Compatibility / low-level tool | Use only when |
|---|---|---|
| `rebuild_figure_manifest` | `build_figures_index` | A legacy client still calls the old artifact name. |
| `search_figures` | `find_figure` | A legacy text-formatted search result is required. |
| `get_figure_context_pack` | `get_figure_context`, `inspect_figure` | A legacy text context or experimental parser path is explicitly requested. |
| `get_figure_image` | `render_figure` | An explicit page+bbox render or render-debug call is needed. |
| `get_figure_image` / `get_figure_context_pack` | `render_figure_page`, `render_figure_region` | A full-page image or automatic around-caption crop is needed instead of the manifest crop. |
| `ocr_figure_for_search` | `ocr_figure` | Advanced local OCR/parser modes are explicitly requested for compatibility. |

New AI-agent workflows should avoid legacy semantic-inspection tools unless the user explicitly requests OCR/parser experiments.
