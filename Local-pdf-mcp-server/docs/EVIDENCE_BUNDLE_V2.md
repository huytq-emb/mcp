# EvidenceBundle v2 migration

The compatibility tools remain available and continue to return their existing
human-readable reports. New evidence workflows should use these direct
structured tools first:

- `query_manual` — rank-fused retrieval over exact symbols, lexical search,
  normalized graph links, and page neighborhoods.
- `get_manual_entity` — stable typed graph entity lookup, including direct
  relationships and related entities.
- `read_manual_evidence` — exact provenance for an entity, chunk, or page.
- `collect_manual_evidence` — adaptive task-level evidence collection.

Each returns `structuredContent` as an `EvidenceBundle` with
`schemaVersion: 2`. The structured payload is constructed before the
human-readable summary; it is not parsed from Markdown.

## Contract guarantees

- Facts, evidence candidates, and engineering inferences are separate.
- Evidence rows preserve page, chunk ID, section path, bounding box when
  available, artifact, extraction method, confidence, verification state, and
  related entity IDs.
- `pagination.total`, `returned`, `truncated`, and `nextCursor` are always
  present. Cursors are opaque and bound to the exact request input, so they
  cannot be reused with a different query or task.
- Evidence, fact, entity, relationship, inference, conflict, gap, and next
  action items are schema-validated. Fact evidence references cannot dangle.
- `get_manual_entity` returns typed `entities` and `relationships`; ambiguous
  aliases are preserved as conflicts and require a canonical entity ID.
- OCR rows are locator evidence only. Figure semantics require opening the
  canonical PNG, and figure actions use a dedicated `figureId`, never a chunk
  ID.
- Conflicting offsets, reset values, access sizes, and aliases are preserved
  under `conflicts`; no value is silently selected.

## Artifacts and rebuilds

`index_pdf` stamps every core artifact with a deterministic generation ID:
source fingerprint, artifact schema, server version, dependency generations,
and content fingerprint. It then builds `<filename>.evidence-graph.json`.
The graph rejects stale, mixed-generation, malformed, and stale-manifest
artifacts. Rebuild the full index with `index_pdf(..., force=true)` when this
occurs; rebuilding only the graph cannot repair stale dependencies.

Chunk IDs remain `filename:p<page>:c<index>`. Hierarchical chunks use
`chunkingVersion: 2` and preserve section/path links, adjacent chunk IDs, and
structural chunk hints without creating a second ID namespace.

## Semantic evaluation

`npm run test:semantic:unit` validates metric, threshold, regression, invalid
dataset, evidence-reference, missing-manual, strict-mode, real-query-dispatch,
latency, RSS, failure-path, and subsystem-coverage logic using synthetic inputs.

`npm run test:semantic:integration` invokes the real local retrieval engine
for every available semantic dataset. It reports `SKIPPED: manual unavailable`
when a proprietary manual is absent. Add `-- --require-manuals` to make missing
manuals fail the command.

## Claim classification

- Manual facts come only from verified or explicitly high-confidence verified
  entities and cite EvidenceBundle evidence IDs.
- Candidate retrieval rows, generated task questions, and alias resolution are
  leads, not manual facts.
- Linux source-code findings are outside this MCP server’s evidence scope and
  must be supplied and verified separately.
