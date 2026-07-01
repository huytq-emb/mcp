export const ARTIFACT_MANIFEST_SCHEMA_VERSION = 1;

export const ARTIFACT_DEPENDENCIES = {
  pages: [],
  "chunk-index": ["pages"],
  sections: ["pages"],
  tables: ["pages", "chunk-index", "sections"],
  registers: ["chunk-index", "sections", "tables"],
  bitfields: ["registers", "tables"],
  sequences: ["chunk-index", "sections", "tables", "registers", "bitfields", "cautions"],
  cautions: ["chunk-index", "sections", "registers"],
  figures: ["pages"],
  figure_ocr: ["figures"],
  "visual-evidence": ["figures"],
  "module-profile": ["registers", "sections"],
  "driver-pack": ["registers", "bitfields", "sequences", "cautions"],
  "driver-task-plan": ["registers", "bitfields", "sequences", "cautions"],
};

export const CORE_ARTIFACT_KEYS = [
  "pages",
  "chunk-index",
  "sections",
  "tables",
  "registers",
  "bitfields",
  "sequences",
  "cautions",
];

export function artifactDescendants(keys) {
  const seeds = new Set(Array.isArray(keys) ? keys : [keys]);
  const descendants = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [artifact, dependencies] of Object.entries(ARTIFACT_DEPENDENCIES)) {
      if (seeds.has(artifact) || descendants.has(artifact)) continue;
      if (dependencies.some((dependency) => seeds.has(dependency) || descendants.has(dependency))) {
        descendants.add(artifact);
        changed = true;
      }
    }
  }
  return [...descendants];
}

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
    staleReason: entry.staleReason || "",
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
  staleArtifacts = [],
  producer = null,
} = {}) {
  const stale = new Set(staleArtifacts || []);
  const normalizedArtifacts = artifacts.map((entry) => normalizeArtifact(stale.has(entry.key) && entry.exists
    ? { ...entry, ok: false, status: "stale", error: entry.error || "dependency rebuilt after this artifact", staleReason: "dependency rebuild" }
    : entry));
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
    producer: producer || null,
    health: summarizeArtifactHealth(normalizedArtifacts),
    counts: Object.fromEntries(normalizedArtifacts.filter((artifact) => artifact.count !== null).map((artifact) => [artifact.key, artifact.count])),
    missingRequired,
    staleArtifacts: normalizedArtifacts.filter((artifact) => artifact.status === "stale").map((artifact) => artifact.key),
    dependencyGraph: ARTIFACT_DEPENDENCIES,
    artifacts: byKey,
    nextActions: missingRequired.length
      ? [`index_pdf(filename="${filename}", mode="background")`, `doctor(filename="${filename}")`]
      : [`build_driver_evidence_pack(filename="${filename}")`, `source_review_prompt_pack(filename="${filename}", task="<driver task>")`],
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
    `- Producer: ${manifest.producer?.engine || "unknown"}${manifest.producer?.operation ? ` (${manifest.producer.operation})` : ""}`,
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
