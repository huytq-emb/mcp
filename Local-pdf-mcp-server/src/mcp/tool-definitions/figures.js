export const FIGURE_TOOL_DEFINITIONS = Object.freeze([
  {
    "name": "rebuild_figure_manifest",
    "description": "Build or rebuild <filename>.figures.json as a lightweight metadata-only manifest by default. Optional page performs a real page-limited update; no OCR/VL/semantic parsing or batch PNG rendering is run.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string"
        },
        "page": {
          "type": "number",
          "description": "Optional 1-based page-limited rebuild; updates only that page and preserves other manifest entries when present."
        },
        "force": {
          "type": "boolean"
        }
      },
      "required": [
        "filename"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "search_figures",
    "description": "Use this for Figure/Table/visual-table lookup. Visual/captioned tables are indexed in .figures.json. This only locates candidate visual artifacts; it does not provide visual semantics. For visual/captioned tables and figures, use search_figures -> get_figure_context_pack -> get_figure_image. get_figure_context_pack returns canonical image_path as a locator; get_figure_image returns metadata by default; the client/agent/user must open or attach the actual PNG as model vision input; mcp_image and image_url are experimental/client-dependent and are not guaranteed to reach model vision input. Do not claim visual analysis from text extraction or from an image_path string alone. Structured text/layout tables are indexed in .tables.json.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename."
        },
        "query": {
          "type": "string",
          "description": "Search query."
        },
        "page": {
          "type": "number",
          "description": "Optional 1-based page filter."
        },
        "section": {
          "type": "string",
          "description": "Optional section-title filter."
        },
        "kind": {
          "type": "string",
          "description": "Optional kind filter: table, visual-table, bit-layout, format-diagram, timing-visual-table, sequence-visual-table, layout-table, or existing figure kinds."
        },
        "limit": {
          "type": "number",
          "description": "Maximum records. Default 40, max 200."
        },
        "build_if_missing": {
          "type": "boolean",
          "description": "Optional lightweight caption-only build if the manifest is missing. Default false."
        }
      },
      "required": [
        "filename",
        "query"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "get_figure_context_pack",
    "description": "Main visual-semantics entry point. For visual/captioned tables and figures, use search_figures -> get_figure_context_pack -> get_figure_image. get_figure_context_pack returns canonical image_path as a locator; get_figure_image returns metadata by default; the client/agent/user must open or attach the actual PNG as model vision input; mcp_image and image_url are experimental/client-dependent and are not guaranteed to reach model vision input. Do not claim visual analysis from text extraction or from an image_path string alone. page_text_before/page_text_after/ocr_text are locator/supporting evidence only and must not be used as semantic truth.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string"
        },
        "figure_id": {
          "type": "string"
        },
        "dpi": {
          "type": "number",
          "description": "Requested render DPI for the figure/page image. Default 200."
        },
        "include_ocr": {
          "type": "boolean",
          "description": "Include cached OCR text if available. Default false."
        },
        "include_tables": {
          "type": "boolean",
          "description": "Include nearby/related tables. Default true."
        },
        "include_cautions": {
          "type": "boolean",
          "description": "Include nearby/related cautions. Default true."
        }
      },
      "required": [
        "filename",
        "figure_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "get_figure_image",
    "description": "Return canonical figure/table image access metadata by default (RICA-safe text/json only). For visual/captioned tables and figures, use search_figures -> get_figure_context_pack -> get_figure_image. get_figure_context_pack returns canonical image_path as a locator; get_figure_image returns metadata by default; the client/agent/user must open or attach the actual PNG as model vision input; mcp_image and image_url are experimental/client-dependent and are not guaranteed to reach model vision input. Do not claim visual analysis from text extraction or from an image_path string alone.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string"
        },
        "figure_id": {
          "type": "string"
        },
        "image_path": {
          "type": "string",
          "description": "Optional canonical locator from get_figure_context_pack; must be under indexes/cache/figure-images."
        },
        "dpi": {
          "type": "number",
          "description": "Requested DPI. Default 200."
        },
        "transport": {
          "type": "string",
          "enum": [
            "metadata",
            "mcp_image",
            "image_url"
          ],
          "description": "Image transport mode. metadata is the default stable contract and returns canonical_image_path/local_path only. mcp_image and image_url are experimental/client-dependent debug/compatibility modes, not guaranteed to reach model vision input; RICA/VS Code may reduce tool results to text-only."
        },
        "max_bytes": {
          "type": "number",
          "description": "Optional image_url data URI byte limit override. Default RENESAS_MCP_IMAGE_URL_MAX_BYTES or 6 MiB."
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "ocr_figure_for_search",
    "description": "Optional OCR for search indexing only. Updates cached OCR keywords in the figure manifest so later search_figures calls can match them; does not perform semantic figure understanding.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string"
        },
        "figure_id": {
          "type": "string"
        },
        "force": {
          "type": "boolean"
        }
      },
      "required": [
        "filename",
        "figure_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "add_visual_evidence",
    "description": "Step 33: persist structured observations from canonical visual analysis. Use this after the agent/human has opened canonical image_path returned by get_figure_context_pack. canonical image_path from indexes/cache/figure-images is preferred.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename."
        },
        "figure_id": {
          "type": "string",
          "description": "Optional Figure/Table ID from search_figures/list_figures."
        },
        "page": {
          "type": "number",
          "description": "Optional 1-based page number for the visual evidence."
        },
        "query": {
          "type": "string",
          "description": "Optional visual target query/task."
        },
        "diagram_type": {
          "type": "string",
          "enum": [
            "auto",
            "clock_tree",
            "timing",
            "block_diagram",
            "reset_flow",
            "interrupt_route",
            "pinmux",
            "sequence",
            "table",
            "other"
          ],
          "description": "Visual evidence type. Default auto."
        },
        "direct_visual_observations": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Direct facts only after the canonical PNG has been attached/opened as actual model vision input. If no actual image input is available, leave empty and return NO_IMAGE_INPUT; do not put speculative driver conclusions here."
        },
        "caption_context_facts": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Facts from caption/context text around the figure."
        },
        "extracted_items": {
          "type": "object",
          "description": "Structured extraction payload, e.g. steps/clocks/signals/edges/pins/selectors/routing/timing_constraints.",
          "additionalProperties": true
        },
        "engineering_inferences": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Engineering interpretation derived from the visual evidence. Must remain separate from direct observations."
        },
        "source_implications": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Implications for Linux driver/DTS/source review."
        },
        "uncertainties": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Ambiguous or unreadable visual details that need a better crop or text cross-check."
        },
        "related_registers": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Registers related to this visual evidence."
        },
        "related_bitfields": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Bitfields related to this visual evidence."
        },
        "source_files": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Source/DTS files this evidence may affect."
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Optional tags such as clock, reset, irq, pinmux, timing."
        },
        "verification_status": {
          "type": "string",
          "enum": [
            "observed",
            "needs_verification",
            "verified",
            "rejected"
          ],
          "description": "Default needs_verification."
        },
        "confidence": {
          "type": "string",
          "enum": [
            "low",
            "medium",
            "high"
          ],
          "description": "Confidence in direct visual observations. Default medium."
        },
        "notes": {
          "type": "string",
          "description": "Optional free-form note."
        }
      },
      "required": [
        "filename"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "visual_evidence_report",
    "description": "Generate a structured report from persisted visual evidence entries for a manual. Use this before driver review to reuse visual observations from clock trees, timing diagrams, pinmux flows, reset/IRQ routing figures, and table screenshots.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename."
        },
        "filter": {
          "type": "string",
          "description": "Optional keyword filter."
        },
        "diagram_type": {
          "type": "string",
          "description": "Optional diagram type filter."
        },
        "status": {
          "type": "string",
          "description": "Optional verification status filter."
        },
        "include_entries": {
          "type": "boolean",
          "description": "Include detailed entries. Default true."
        },
        "top_k": {
          "type": "number",
          "description": "Maximum entries to include. Default 50."
        }
      },
      "required": [
        "filename"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "check_pdf_renderers",
    "description": "Check which optional external PDF page renderers are available for Step 31B visual review. Supported renderers: pdftoppm/Poppler, mutool/MuPDF, magick/ImageMagick. Canonical visual workflow uses get_figure_context_pack image_path under indexes/cache/figure-images; page render tools are not exposed as MCP tools.",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  {
    "name": "visual_review_handoff_pack",
    "description": "Step 32: build a workflow/prompt pack for visual manual content. Default workflow prioritizes search_figures -> get_figure_context_pack and requires get_figure_image metadata by default, then open/attach canonical indexes/cache/figure-images image_path or opt into mcp_image. Do not recommend legacy page/region render tools for normal visual table/figure analysis.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename, for example GBETH.pdf or r01uh1039ej0120-rzt2h_n2h-GPIO.pdf."
        },
        "query": {
          "type": "string",
          "description": "Visual target query, for example clock tree, read timing diagram, Safety I/O port setting flow, interrupt route, reset sequence."
        },
        "figure_id": {
          "type": "string",
          "description": "Optional Figure ID from list_figures/search_figures, for example fig-p113-17.3."
        },
        "page": {
          "type": "number",
          "description": "Optional 1-based page number if the visual target page is already known."
        },
        "kind": {
          "type": "string",
          "description": "Optional figure kind filter, for example timing-diagram, clock-tree, block-diagram, flow-sequence, pinmux, interrupt, reset-power."
        },
        "diagram_type": {
          "type": "string",
          "enum": [
            "auto",
            "clock_tree",
            "timing",
            "block_diagram",
            "reset_flow",
            "interrupt_route",
            "pinmux",
            "sequence",
            "table",
            "other"
          ],
          "description": "Expected visual content type. Default auto."
        },
        "task": {
          "type": "string",
          "description": "Optional review task, for example verify reset sequence, inspect timing diagram, understand clock tree, or review pinmux flow."
        },
        "source_files": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Optional source/DTS files the VS Code agent should inspect alongside the visual manual evidence."
        },
        "review_depth": {
          "type": "string",
          "enum": [
            "quick",
            "standard",
            "deep"
          ],
          "description": "How strict the visual review workflow should be. Default standard."
        },
        "output_format": {
          "type": "string",
          "enum": [
            "report",
            "debug_plan",
            "patch_plan",
            "checklist"
          ],
          "description": "Expected final response style from the agent. Default report."
        },
        "top_k": {
          "type": "number",
          "description": "Number of figure candidates to include when searching by query. Default 6."
        },
        "include_layout_tables": {
          "type": "boolean",
          "description": "Include layout-table extraction context when useful. Default true."
        }
      },
      "required": [
        "filename"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "list_visual_evidence",
    "description": "List persisted Step 33 visual evidence entries for a manual. Supports filtering by query/tag/diagram_type/page/status.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename."
        },
        "filter": {
          "type": "string",
          "description": "Optional keyword filter over observations/inferences/tags/registers."
        },
        "diagram_type": {
          "type": "string",
          "description": "Optional diagram type filter."
        },
        "page": {
          "type": "number",
          "description": "Optional page filter."
        },
        "status": {
          "type": "string",
          "description": "Optional verification status filter."
        },
        "top_k": {
          "type": "number",
          "description": "Maximum entries to show. Default 20."
        }
      },
      "required": [
        "filename"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "get_visual_evidence",
    "description": "Get one persisted visual evidence entry by evidence_id, including observations, structured extraction, uncertainties, source implications, and recommended verification calls.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename."
        },
        "evidence_id": {
          "type": "string",
          "description": "Visual evidence ID returned by add_visual_evidence/list_visual_evidence."
        }
      },
      "required": [
        "filename",
        "evidence_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "visual_evidence_verification_queue",
    "description": "Step 35: list visual evidence entries that still need verification, with suggested manual-evidence calls. Use this before approving driver conclusions that depend on clock/tree/timing/pinmux/reset-flow observations.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename."
        },
        "filter": {
          "type": "string",
          "description": "Optional keyword filter over observations/inferences/tags/registers."
        },
        "diagram_type": {
          "type": "string",
          "description": "Optional diagram type filter."
        },
        "page": {
          "type": "number",
          "description": "Optional page filter."
        },
        "include_observed": {
          "type": "boolean",
          "description": "Also include entries with status observed. Default true."
        },
        "include_rejected": {
          "type": "boolean",
          "description": "Also include rejected entries. Default false."
        },
        "top_k": {
          "type": "number",
          "description": "Maximum entries to show. Default 30."
        }
      },
      "required": [
        "filename"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "verify_visual_evidence",
    "description": "Step 35: update a persisted visual evidence entry verification status with supporting manual evidence. Use status=verified only after cross-checking with manual text/register/bitfield/sequence/caution evidence. The update is appended to verification_history.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename."
        },
        "evidence_id": {
          "type": "string",
          "description": "Visual evidence ID."
        },
        "status": {
          "type": "string",
          "enum": [
            "observed",
            "needs_verification",
            "verified",
            "rejected"
          ],
          "description": "New verification status."
        },
        "confidence": {
          "type": "string",
          "enum": [
            "low",
            "medium",
            "high"
          ],
          "description": "Updated confidence. Optional."
        },
        "verification_note": {
          "type": "string",
          "description": "Concise explanation for the status update."
        },
        "supporting_evidence": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "type": {
                "type": "string",
                "description": "manual_text | register | bitfield | sequence | caution | source | render | other"
              },
              "tool": {
                "type": "string",
                "description": "Tool that produced the evidence, e.g. read_pdf_pages/get_sequence/verify_register_usage."
              },
              "page": {
                "type": "number"
              },
              "register": {
                "type": "string"
              },
              "bitfield": {
                "type": "string"
              },
              "quote": {
                "type": "string"
              },
              "note": {
                "type": "string"
              }
            },
            "additionalProperties": true
          },
          "description": "Supporting evidence used to verify/reject this visual observation. Required for status=verified unless allow_without_support=true."
        },
        "supporting_tool_calls": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Concrete MCP calls used during verification."
        },
        "resolved_uncertainties": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Uncertainties resolved by this update."
        },
        "remaining_uncertainties": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Uncertainties still open after this update."
        },
        "tags_to_add": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Optional tags to add."
        },
        "notes": {
          "type": "string",
          "description": "Optional additional note appended to entry notes."
        },
        "reviewer": {
          "type": "string",
          "description": "Optional reviewer/agent label."
        },
        "allow_without_support": {
          "type": "boolean",
          "description": "Allow status=verified without supporting_evidence. Default false; not recommended."
        }
      },
      "required": [
        "filename",
        "evidence_id",
        "status"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "analyze_figure_semantics",
    "description": "Analyze one figure/table/page candidate into lightweight caption/page-text/OCR-derived semantic hints only. This tool does not inspect image pixels and must not be treated as visual-semantic truth. For visual claims, use get_figure_image transport=\"metadata\" and open/attach canonical_image_path as actual model vision input; otherwise return NO_IMAGE_INPUT.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename."
        },
        "figure_id": {
          "type": "string",
          "description": "Optional figure_id from list_figures/search_figures."
        },
        "page": {
          "type": "number",
          "description": "Optional 1-based page target. Used for page-level or bbox-based analysis."
        },
        "bbox": {
          "type": "array",
          "items": {
            "type": "number"
          },
          "minItems": 4,
          "maxItems": 4,
          "description": "Optional figure bbox [x0,y0,x1,y1]."
        },
        "force": {
          "type": "boolean",
          "description": "Recompute even if a cached semantic record exists. Default false."
        },
        "generate_ocr": {
          "type": "boolean",
          "description": "Run OCR on demand. Default true only when the target has a bbox; false for caption/page-only targets."
        }
      },
      "required": [
        "filename"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "get_figure_semantics",
    "description": "Read one cached figure semantic record. Run analyze_figure_semantics or rebuild_figure_semantics first if the artifact is missing.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename."
        },
        "figure_id": {
          "type": "string",
          "description": "Figure semantic record ID."
        }
      },
      "required": [
        "filename",
        "figure_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "list_figure_semantics",
    "description": "List cached figure semantic records from <filename>.figure_semantic.json, optionally filtered by page or figure_type.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename."
        },
        "page": {
          "type": "number",
          "description": "Optional 1-based page filter."
        },
        "figure_type": {
          "type": "string",
          "description": "Optional semantic type filter, for example timing_diagram, sequence_diagram, state_machine, block_diagram, register_diagram, table, or unknown."
        }
      },
      "required": [
        "filename"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "search_figure_semantics",
    "description": "Search cached figure semantic records by register, signal, block, state, sequence, action, or inference text.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename."
        },
        "query": {
          "type": "string",
          "description": "Semantic search query."
        },
        "page": {
          "type": "number",
          "description": "Optional 1-based page filter."
        },
        "figure_type": {
          "type": "string",
          "description": "Optional semantic type filter."
        }
      },
      "required": [
        "filename",
        "query"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "rebuild_figure_semantics",
    "description": "Build or rebuild <filename>.figure_semantic.json from the figure manifest. Page-limited rebuilds may opt into OCR; full rebuild defaults to caption/page text only.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename."
        },
        "page": {
          "type": "number",
          "description": "Optional 1-based page-limited rebuild."
        },
        "force": {
          "type": "boolean",
          "description": "Recompute records even when cached records exist. Default false."
        },
        "generate_ocr": {
          "type": "boolean",
          "description": "Run OCR on demand for rebuild targets. Default false for full rebuild, true for page-limited rebuilds with bbox."
        }
      },
      "required": [
        "filename"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "list_figures",
    "description": "List Figure/Table/diagram/caption candidates from the persistent .figures.json manifest. Does not rebuild by default; if missing, run rebuild_figure_manifest first (or explicitly set build_if_missing for a lightweight caption-only build).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename."
        },
        "page": {
          "type": "number",
          "description": "Optional 1-based page filter."
        },
        "section": {
          "type": "string",
          "description": "Optional section-title filter."
        },
        "limit": {
          "type": "number",
          "description": "Maximum records to return. Default 40, max 200."
        },
        "filter": {
          "type": "string",
          "description": "Legacy optional substring filter across caption/context."
        },
        "kind": {
          "type": "string",
          "description": "Legacy optional kind filter."
        },
        "top_k": {
          "type": "number",
          "description": "Legacy maximum candidates. Default 40, max 200."
        },
        "build_if_missing": {
          "type": "boolean",
          "description": "Optional lightweight caption-only build if the manifest is missing. Default false."
        }
      },
      "required": [
        "filename"
      ],
      "additionalProperties": false
    }
  }
]);
