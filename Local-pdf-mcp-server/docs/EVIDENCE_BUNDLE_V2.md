# EvidenceBundle v2 migration

The compatibility tools remain available and continue to return their existing
human-readable reports. New evidence workflows should use these direct
structured tools first:

- `query_manual` — multi-channel retrieval with rank-fusion reasons.
- `get_manual_entity` — stable graph entity lookup.
- `read_manual_evidence` — provenance for an entity, chunk, or page.
- `collect_manual_evidence` — adaptive task-level evidence collection.

Each returns `structuredContent` as an `EvidenceBundle` with
`schemaVersion: 2`. The structured payload is constructed before the
human-readable summary; it is not parsed from Markdown.

## Contract guarantees

- `facts`, evidence candidates, and engineering `inferences` are separate.
- Each evidence row preserves page, chunk ID, section path, bounding box when
  available, artifact, extraction method, confidence, verification state, and
  related entity IDs.
- Results always include `pagination.total`, `returned`, `truncated`, and
  `nextCursor`; callers must follow `nextCursor` rather than assuming silent
  truncation.
- OCR entries have `extractionMethod: optional-ocr-search-metadata` and are
  locator evidence only. Figure semantics still require opening the canonical
  PNG returned by the figure workflow.
- Conflicting offsets, reset values, and access sizes are preserved under
  `conflicts`; no value is silently selected.

## Artifacts and rebuilds

`index_pdf` now builds `<filename>.evidence-graph.json` after the existing
indexes. For an existing indexed manual, rebuild just that normalized layer
with `mcp_control(action="rebuild_artifact", artifact="evidence-graph",
filename="...")`.

Chunk IDs remain `filename:p<page>:c<index>`. New hierarchical chunks add
`chunkingVersion: 2`, section/path links, adjacent chunk IDs, and structural
chunk hints without creating a second ID namespace.
