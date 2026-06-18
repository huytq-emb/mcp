export const ARTIFACT_MANIFEST_SCHEMA_VERSION = 1;

export const ARTIFACT_DEPENDENCIES = {
  pages: [],
  "chunk-index": ["pages"],
  sections: ["pages"],
  registers: ["chunk-index", "sections"],
  bitfields: ["registers"],
  sequences: ["chunk-index", "sections", "registers"],
  cautions: ["chunk-index", "sections", "registers"],
  figures: ["pages"],
  "visual-evidence": ["figures"],
  "module-profile": ["registers", "sections"],
  "driver-pack": ["registers", "bitfields", "sequences", "cautions"],
  "driver-task-plan": ["registers", "bitfields", "sequences", "cautions"],
};

export const CORE_ARTIFACT_KEYS = [
  "pages",
  "chunk-index",
  "sections",
  "registers",
  "bitfields",
  "sequences",
  "cautions",
];

export function sourceFingerprint(source = {}) {
  const size = Number(source.size || source.sourceSize || 0);
  const mtimeMs = Number(source.mtimeMs || source.sourceModifiedMs || 0);
  return `size=${size};mtimeMs=${Number.isFinite(mtimeMs) ? Math.round(mtimeMs) : 0}`;
}

function normalizeArtifact(entry = {}) {
  const key = String(entry.key || entry.artifact || entry.name || "unknown");
  const status = String(entry.status || (entry.ok ? "ok" : entry.exists ? "broken" : entry.optional ? "missing_optional" : "missing"));
  return {
    key,
    label: entry.label || key,
    status,
    ok: Boolean(entry.ok) || status === "ok",
    optional: Boolean(entry.optional),
    path: entry.path || "",
    schemaVersion: entry.schemaVersion ?? null,
    count: entry.count ?? null,
    countKey: entry.countKey || "",
    error: entry.error || "",
    dependencies: ARTIFACT_DEPENDENCIES[key] || [],
  };
}

export function summarizeArtifactHealth(artifacts = []) {
  const required = artifacts.filter((artifact) => !artifact.optional);
  const missing = required.filter((artifact) => ["missing", "broken", "stale", "incompatible", "error"].includes(artifact.status));
  const warnings = required.filter((artifact) => ["warning", "missing_optional"].includes(artifact.status));
  if (missing.length) return "fail";
  if (warnings.length) return "warn";
  return "ok";
}

export function createArtifactManifest({
  filename,
  serverVersion,
  source = {},
  artifacts = [],
  buildStatus = "ready",
  generatedAt = new Date().toISOString(),
  notes = [],
} = {}) {
  const normalizedArtifacts = artifacts.map(normalizeArtifact);
  const byKey = Object.fromEntries(normalizedArtifacts.map((artifact) => [artifact.key, artifact]));
  const missingRequired = normalizedArtifacts
    .filter((artifact) => !artifact.optional && !artifact.ok)
    .map((artifact) => artifact.key);

  return {
    schemaVersion: ARTIFACT_MANIFEST_SCHEMA_VERSION,
    serverVersion,
    generatedAt,
    filename,
    source: {
      size: Number(source.size || source.sourceSize || 0),
      mtimeMs: Number(source.mtimeMs || source.sourceModifiedMs || 0),
      mtime: source.mtime || source.modified || "",
      fingerprint: sourceFingerprint(source),
    },
    buildStatus,
    health: summarizeArtifactHealth(normalizedArtifacts),
    counts: Object.fromEntries(normalizedArtifacts.filter((artifact) => artifact.count !== null).map((artifact) => [artifact.key, artifact.count])),
    missingRequired,
    dependencyGraph: ARTIFACT_DEPENDENCIES,
    artifacts: byKey,
    nextActions: missingRequired.length
      ? [`start_index_pdf(filename="${filename}")`, `doctor(filename="${filename}")`]
      : [`build_driver_evidence_pack(filename="${filename}")`, `prepare_driver_task(filename="${filename}", task="<driver task>")`],
    notes: notes.filter(Boolean),
  };
}

export function formatManifestSummary(manifest) {
  if (!manifest) return "Artifact manifest: missing";
  const lines = [
    "Artifact manifest:",
    `- Health: ${manifest.health}`,
    `- Build status: ${manifest.buildStatus}`,
    `- Source fingerprint: ${manifest.source?.fingerprint || "unknown"}`,
    `- Missing required: ${(manifest.missingRequired || []).join(", ") || "none"}`,
  ];

  for (const artifact of Object.values(manifest.artifacts || {})) {
    lines.push(`- ${artifact.key}: ${artifact.status}${artifact.count !== null ? ` (${artifact.count})` : ""}`);
  }

  if ((manifest.nextActions || []).length) {
    lines.push("Next actions:");
    for (const action of manifest.nextActions) lines.push(`- ${action}`);
  }

  return lines.join("\n");
}
