# Tool classification and migration

## Primary evidence tools

Use these for normal AI-agent evidence workflows:

- `query_manual`
- `get_manual_entity`
- `read_manual_evidence`
- `collect_manual_evidence`
- `search_figures`
- `get_figure_context_pack`
- `get_figure_image`

The figure tools remain metadata-first. The client or agent must open or
attach the canonical PNG before making visual-semantic claims.

## Advanced/manual inspection tools

The existing page, chunk, section, register, bitfield, table, sequence,
caution, profile, driver-pack, and visual-evidence tools remain public. Use
them for targeted inspection, verification, and compatibility workflows when
the primary tools identify a gap or conflict.

`ocr_figure_for_search` is optional locator enrichment. OCR is never required
and is not visual-semantic truth.

## Control tools

Use `list_pdfs`, `pdf_info`, `doctor`, `index_pdf`, `plan_manual_workflow`, and
`mcp_control`. Detached indexing and artifact jobs remain supported. Prefer
`mcp_control` over direct legacy job helpers.

## Compatibility tools

Hidden compatibility handlers preserve older clients and workflows. They are
not the recommended surface for new integrations and are not removed by the
7.2 hardening release.

## Future reduction plan

No public tools are removed in this release. A later, separately reviewed
migration may reduce the advertised low-level surface only after real-manual
integration reports are stable across Windows and Linux. That migration must
retain compatibility handlers, publish replacement calls, and use a major
version only if public behavior is intentionally broken.
