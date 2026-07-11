export const EVIDENCE_V2_TOOL_DEFINITIONS = Object.freeze([
  {
    name: "query_manual",
    description: "EvidenceBundle v2 retrieval over exact symbols, lexical/BM25-style search, normalized graph links, and page neighborhoods. Returns retrieval reasons, provenance, conflicts, gaps, and explicit pagination.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename." },
        query: { type: "string", description: "Natural-language evidence question, exact symbol, offset, or operation topic." },
        register: { type: "string", description: "Optional register/module context. Required to strongly match ambiguous short bit symbols such as EN, ER, TC, CR, or SR." },
        top_k: { type: "number", description: "Results per page. Default 10, maximum 40." },
        cursor: { type: "string", description: "Opaque request-bound cursor returned by the same query and options." },
        include_ocr: { type: "boolean", description: "Include supplemental OCR locator matches only for visual/figure discovery. Default false." },
      },
      required: ["filename", "query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_manual_entity",
    description: "Read one stable entity from the normalized manual evidence graph, including typed entities, direct relationships, aliases, provenance, and preserved conflicts. Ambiguous aliases are rejected with canonical IDs to choose from.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename." },
        entity_id: { type: "string", description: "Stable entity ID returned by query_manual or read_manual_evidence." },
        related_entity_types: { type: "array", items: { type: "string" }, description: "Optional related entity types to include." },
        relationship_types: { type: "array", items: { type: "string" }, description: "Optional relationship types to include." },
        top_k: { type: "number", description: "Related relationships per page; default 20, maximum 100." },
        cursor: { type: "string", description: "Request-bound cursor for related relationships." },
        include_page_entities: { type: "boolean", description: "Include page entities; false by default." },
      },
      required: ["filename", "entity_id"],
      additionalProperties: false,
    },
  },
  {
    name: "read_manual_evidence",
    description: "Read normalized provenance for an entity, chunk, or page. This returns EvidenceBundle v2 directly; it does not make visual-semantic claims from OCR or caption text.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename." },
        entity_id: { type: "string", description: "Optional stable manual entity ID." },
        chunk_id: { type: "string", description: "Optional chunk ID." },
        page: { type: "number", description: "Optional one-based page number." },
      },
      required: ["filename"],
      anyOf: [
        { required: ["entity_id"] },
        { required: ["chunk_id"] },
        { required: ["page"] },
      ],
      additionalProperties: false,
    },
  },
  {
    name: "collect_manual_evidence",
    description: "Adaptive high-level evidence collection for a driver/manual task. It checks the normalized graph, decomposes the task, uses exact, lexical, graph, and neighborhood retrieval, deduplicates evidence, reports conflicts/gaps, and returns one EvidenceBundle v2.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename." },
        task: { type: "string", description: "Driver review, implementation, debug, or manual-analysis task." },
        module_type: { type: "string", description: "Optional subsystem hint such as ethernet, dmaengine, gpio, watchdog, pwm, usb, i2c, spi, pcie, or interrupt-controller." },
        depth: { type: "string", enum: ["quick", "standard", "deep"], description: "Evidence collection depth. Default standard." },
        evidence_types: {
          type: "array",
          items: { type: "string", enum: ["register", "bitfield", "sequence", "caution", "table", "figure"] },
          description: "Optional implemented evidence categories to prioritize. Interrupt, clock, and reset are task terms, not graph entity types.",
        },
        top_k: { type: "number", description: "Evidence rows per page. Default 10, maximum 40." },
        cursor: { type: "string", description: "Opaque request-bound cursor returned by the same task and options." },
      },
      required: ["filename", "task"],
      additionalProperties: false,
    },
  },
]);
