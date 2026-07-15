# Semantic evaluation

The semantic gate evaluates evidence correctness rather than response formatting. Six manually verified golden datasets cover Ethernet, DMA, GPIO/PFC, watchdog, PWM/timer, and USB. Their expectations include entity identity, register properties, bitfields, cautions, ordered sequence steps, figure identity/relationships, and evidence pages.

The integration catalog also executes 20 coverage probes per subsystem (120 total). Each probe is either a lightweight correctness case with an explicit expectation or is labeled `runtime-only`. Runtime-only probes are reported only in the runtime/performance summary and are never counted as semantic correctness. The report therefore has three separate summaries: golden correctness, coverage correctness, and runtime/performance.

Run the fast schema/evaluator tests with:

```text
npm run test:semantic:unit
```

Run the real-manual gate with a local copy of the verified RZ/G3E manual with:

```text
npm run test:semantic:integration -- --require-manuals --write
```

The semantic datasets are intentionally verified against their named manual.
For runtime, provenance, pagination, deterministic ordering, advanced-tool,
figure-metadata, latency, cache, and RSS coverage across every locally present
PDF, run the separate recursive matrix:

```text
npm run test:manuals -- --require-manuals --write
```

This matrix does not invent golden semantic expectations for an unverified
manual. Its per-manual semantic result means EvidenceBundle v2 runtime and
contract validation; verified semantic correctness remains the responsibility
of the named golden datasets.

Without `--require-manuals`, unavailable proprietary manuals are explicitly reported as skipped. They are never counted as successful semantic queries. Golden Recall@5, Recall@10, and MRR use retrieval evidence order (`retrieval.rank`) only; verified facts are used only for verification and property checks. Runtime reports record p50/p95 latency, indexing duration, and sampled peak RSS (`rssBeforeMb`, `rssAfterMb`, and `peakRssMb`).

Add `--trace-memory` to `test:manuals` when diagnosing heap growth. It records
and prints per-tool heap/RSS before, after, and sampled peak values; it does not
change indexing or retrieval behavior.

## Measured improvement

The first strict real-manual audit on the same 4,773-page source exposed substantive retrieval failures. After exact-symbol gating, stable RRF, graph/alias hardening, definition-page scoring, and sequence-anchor fixes, the final strict gate produced:

| Measure | Initial audit | Final gate |
| --- | ---: | ---: |
| DMA MRR | 0.225 | 0.75 |
| PWM/timer MRR | 0.333 | 1.0 |
| USB evidence-page correctness | 0 | 1.0 |
| Watchdog Recall@5 | 0.5 | 1.0 |
| Watchdog sequence-step coverage | 0 | 1.0 |
| Watchdog figure-locator accuracy | 0 | 1.0 |
| Full 120-query wall time | 1,001 s | about 4 minutes |

All six final datasets have Recall@5 and Recall@10 of 1.0. Regression thresholds and the checked-in baseline fail the gate if these quality measures decrease or duplicate/unsupported evidence increases.
