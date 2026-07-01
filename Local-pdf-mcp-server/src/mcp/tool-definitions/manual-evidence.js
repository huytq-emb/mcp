export const MANUAL_EVIDENCE_TOOL_DEFINITIONS = Object.freeze([
  {
    "name": "search_pdf",
    "description": "Search keywords, phrases, register names, bit names, or natural-language questions inside an indexed PDF. Returns page numbers and chunk IDs. Text search/page extraction can locate visual tables, but must not be used as semantic truth for visual tables/figures. Visual/captioned tables are indexed in .figures.json; structured text/layout tables are indexed in .tables.json. For Table X.Y-Z with visual layout, bit arrangement, data format, MSB/LSB, timing/waveform: use search_figures -> get_figure_context_pack -> get_figure_image transport=metadata for canonical image path metadata.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename, for example: GBETH.pdf"
        },
        "query": {
          "type": "string",
          "description": "Keyword, exact phrase, register name, bit field, section title, or natural-language query."
        },
        "top_k": {
          "type": "number",
          "description": "Maximum number of results. Default 8, max 30."
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
    "name": "hybrid_search_pdf",
    "description": "Search an indexed PDF without embeddings by combining exact phrase, keyword/BM25-like scoring, fuzzy token matching, intent expansion, and boosts from register/section/sequence/caution indexes. Use this for natural-language questions when Ollama/embedding search is unavailable. Text search/page extraction can locate visual tables, but must not be used as semantic truth for visual tables/figures. Visual/captioned tables are indexed in .figures.json; structured text/layout tables are indexed in .tables.json. For Table X.Y-Z with visual layout, bit arrangement, data format, MSB/LSB, timing/waveform: use search_figures -> get_figure_context_pack -> get_figure_image transport=metadata for canonical image path metadata.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename, for example: GBETH.pdf"
        },
        "query": {
          "type": "string",
          "description": "Natural-language question, operation intent, register/bitfield/topic, or phrase to search."
        },
        "register": {
          "type": "string",
          "description": "Optional register context to boost related chunks, for example DMACm_CHCTRL_n or WDTCR."
        },
        "intent": {
          "type": "string",
          "enum": [
            "auto",
            "register",
            "bitfield",
            "sequence",
            "caution",
            "section",
            "table",
            "irq",
            "clear",
            "reset",
            "start",
            "stop",
            "init",
            "error"
          ],
          "description": "Optional search intent. Use auto by default; set a concrete intent to bias ranking."
        },
        "top_k": {
          "type": "number",
          "description": "Maximum number of results. Default 12, max 40."
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
    "name": "read_pdf_pages",
    "description": "Read extractable text from a specific page range in a local PDF. Use after search_pdf/find_register/find_section to inspect relevant pages. Text search/page extraction can locate visual tables, but must not be used as semantic truth for visual tables/figures. Visual/captioned tables are indexed in .figures.json; structured text/layout tables are indexed in .tables.json. For Table X.Y-Z with visual layout, bit arrangement, data format, MSB/LSB, timing/waveform: use search_figures -> get_figure_context_pack -> get_figure_image transport=metadata for canonical image path metadata.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename, for example: GBETH.pdf"
        },
        "start_page": {
          "type": "number",
          "description": "Start page number, 1-based."
        },
        "end_page": {
          "type": "number",
          "description": "End page number, 1-based. Maximum range is 20 pages."
        }
      },
      "required": [
        "filename",
        "start_page",
        "end_page"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "read_pdf_chunk",
    "description": "Read the full text of a specific indexed chunk by chunk ID, for example GBETH.pdf:p17:c0. Text search/page extraction can locate visual tables, but must not be used as semantic truth for visual tables/figures. Visual/captioned tables are indexed in .figures.json; structured text/layout tables are indexed in .tables.json. For Table X.Y-Z with visual layout, bit arrangement, data format, MSB/LSB, timing/waveform: use search_figures -> get_figure_context_pack -> get_figure_image transport=metadata for canonical image path metadata.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename, for example: GBETH.pdf"
        },
        "chunk_id": {
          "type": "string",
          "description": "Chunk ID returned by search_pdf, find_register, or find_section."
        }
      },
      "required": [
        "filename",
        "chunk_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "find_section",
    "description": "Find section headings/topics using the section index first, then fall back to chunk search. Examples: Register Description, DMA initialization, Timestamp, MDIO, Clock Setting, Interrupt Source.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename, for example: GBETH.pdf"
        },
        "section": {
          "type": "string",
          "description": "Section title, heading fragment, or topic to find."
        },
        "top_k": {
          "type": "number",
          "description": "Maximum number of results. Default 8, max 30."
        }
      },
      "required": [
        "filename",
        "section"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "list_registers",
    "description": "List detected hardware registers from the register index so an AI agent can explore the module register map before inspecting specific registers.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename, for example: GBETH.pdf"
        },
        "filter": {
          "type": "string",
          "description": "Optional substring filter for register names, aliases, headings, or section titles. Examples: WDT, MAC, DMA, GPT, GTCC."
        },
        "top_k": {
          "type": "number",
          "description": "Maximum number of registers to list. Default 80, max 200."
        },
        "include_low_confidence": {
          "type": "boolean",
          "description": "Include low-confidence symbol-only candidates. Default false. Keep false when exploring the real register map."
        }
      },
      "required": [
        "filename"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "find_register",
    "description": "Find a hardware register using the register index first, then fall back to chunk search. Supports prefixed/unprefixed variants such as MACCR, GBETHm_MACCR, WDTCR, WDTRR, GTCR, or GTCCR.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename, for example: GBETH.pdf"
        },
        "register": {
          "type": "string",
          "description": "Register abbreviation or full register name, for example MACCR, GBETHm_MACCR, WDTCR, GTCCR."
        },
        "top_k": {
          "type": "number",
          "description": "Maximum number of results. Default 8, max 30."
        }
      },
      "required": [
        "filename",
        "register"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "summarize_register",
    "description": "Summarize one hardware register by combining register-index metadata, related chunks, detected bit-field evidence, and suggested follow-up reads. Useful for Linux driver source review against the hardware manual.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename, for example: WDT.pdf or r01uh1069ej0115-rzg3e-DMA.pdf"
        },
        "register": {
          "type": "string",
          "description": "Register abbreviation or full register name, for example DMACm_CHCTRL_n, WDTCR, GTCR, or GTCCR."
        },
        "top_k": {
          "type": "number",
          "description": "Maximum number of related chunks to include. Default 10, max 24."
        },
        "include_bitfield_evidence": {
          "type": "boolean",
          "description": "Include evidence lines for detected bit fields. Default true."
        }
      },
      "required": [
        "filename",
        "register"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "extract_register_table",
    "description": "Extract register-map table candidates using PDF text item coordinates. Returns rows with register name, abbreviation, offset, initial value, access size, page, and confidence when detected.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename, for example WDT.pdf or r01uh1069ej0115-rzg3e-DMA.pdf"
        },
        "start_page": {
          "type": "number",
          "description": "Optional start page. If omitted, the tool uses register-index pages and register-list sections."
        },
        "end_page": {
          "type": "number",
          "description": "Optional end page. If omitted, the tool uses register-index pages and register-list sections."
        },
        "filter": {
          "type": "string",
          "description": "Optional register-name substring filter, for example DMACm, WDT, GT, MAC."
        },
        "top_k": {
          "type": "number",
          "description": "Maximum number of register rows to return. Default 80, max 200."
        }
      },
      "required": [
        "filename"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "list_bitfields",
    "description": "List detected bit-field candidates for a register or for the whole indexed hardware manual. Uses the persistent .bitfields.json index built by index_pdf.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename, for example WDT.pdf or r01uh1069ej0115-rzg3e-DMA.pdf"
        },
        "register": {
          "type": "string",
          "description": "Optional register name to filter bit fields, for example DMACm_CHCTRL_n, WDTCR, GTCR, or GTCCR."
        },
        "filter": {
          "type": "string",
          "description": "Optional substring filter for bit-field name, description, evidence, or register."
        },
        "top_k": {
          "type": "number",
          "description": "Maximum number of bit fields to list. Default 80, max 240."
        },
        "include_low_confidence": {
          "type": "boolean",
          "description": "Include low-confidence symbol-only candidates. Default false."
        }
      },
      "required": [
        "filename"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "find_bitfield",
    "description": "Find chunks related to a hardware register bit field such as EN, ER, SUS, TC, CKS, TOPS, RPES, TSTART, or TCSTF. If register is provided, related register context is prioritized.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename, for example: WDT.pdf or r01uh1069ej0115-rzg3e-DMA.pdf"
        },
        "bitfield": {
          "type": "string",
          "description": "Bit field name or symbol to find, for example EN, ER, TC, CKS, TOPS, RPES, TSTART, or TCSTF."
        },
        "register": {
          "type": "string",
          "description": "Optional register name to constrain/prioritize context, for example DMACm_CHCTRL_n, WDTCR, GTCR, or GTCCR."
        },
        "top_k": {
          "type": "number",
          "description": "Maximum number of results. Default 8, max 30."
        }
      },
      "required": [
        "filename",
        "bitfield"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "extract_bitfield_table",
    "description": "Extract a layout-aware bit-field table for a register. Uses PDF text-item coordinates first to preserve bit/access/reset/description columns, then falls back to the persistent bitfield index. Verify ambiguous rows with read_pdf_pages/read_pdf_chunk.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename, for example WDT.pdf or r01uh1069ej0115-rzg3e-DMA.pdf"
        },
        "register": {
          "type": "string",
          "description": "Register name to extract a bit-field table for, for example DMACm_CHCTRL_n, WDTCR, GTCR, or GTCCR."
        },
        "top_k": {
          "type": "number",
          "description": "Maximum number of candidate bit fields/rows. Default 80, max 240."
        }
      },
      "required": [
        "filename",
        "register"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "extract_tables_from_pages",
    "description": "Extract table-like structures from a PDF page range using PDF text item coordinates. Step 30A also annotates semantic column roles when possible. Useful for inspecting register maps and bit-field tables when plain text extraction loses columns.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename, for example WDT.pdf or r01uh1069ej0115-rzg3e-DMA.pdf"
        },
        "start_page": {
          "type": "number",
          "description": "Start page number, 1-based."
        },
        "end_page": {
          "type": "number",
          "description": "End page number, 1-based. Maximum range is 8 pages."
        },
        "min_columns": {
          "type": "number",
          "description": "Minimum number of detected columns for a row/table candidate. Default 3."
        }
      },
      "required": [
        "filename",
        "start_page",
        "end_page"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "list_sequences",
    "description": "List detected persistent operation-flow/sequence candidates from the .sequences.json index. Useful for discovering init/start/stop/clear/reset/IRQ/error flows in a hardware manual.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename, for example: WDT.pdf, GPT.pdf, or r01uh1069ej0115-rzg3e-DMA.pdf"
        },
        "filter": {
          "type": "string",
          "description": "Optional substring filter, for example init, start, stop, clear, reset, irq, error, transfer, suspend."
        },
        "top_k": {
          "type": "number",
          "description": "Maximum number of sequences to list. Default 80, max 200."
        }
      },
      "required": [
        "filename"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "get_sequence",
    "description": "Get one persistent operation-flow/sequence by topic from the .sequences.json index. Falls back to dynamic find_sequence-style search when the persistent index has no good match.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename, for example: WDT.pdf, GPT.pdf, or r01uh1069ej0115-rzg3e-DMA.pdf"
        },
        "topic": {
          "type": "string",
          "description": "Sequence topic, for example initialization, start transfer, stop channel, clear interrupt, reset, IRQ handling, or error handling."
        },
        "register": {
          "type": "string",
          "description": "Optional register name to bias dynamic fallback, for example DMACm_CHCTRL_n or DMACm_CHSTAT_n."
        },
        "top_k": {
          "type": "number",
          "description": "Maximum number of sequence evidence chunks. Default 10, max 30."
        }
      },
      "required": [
        "filename",
        "topic"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "list_cautions",
    "description": "List persistent caution/note/restriction candidates from the .cautions.json index. Use this to inspect reserved-bit rules, write timing restrictions, undefined/prohibited behavior, and clear-flag semantics across the manual.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename, for example: WDT.pdf, GPT.pdf, or r01uh1069ej0115-rzg3e-DMA.pdf"
        },
        "filter": {
          "type": "string",
          "description": "Optional filter, for example reserved, write only when stopped, clear status, write 1 to clear, undefined, prohibited, interrupt, reset, or a register name."
        },
        "register": {
          "type": "string",
          "description": "Optional register name to list only cautions related to that register, for example DMACm_CHCTRL_n or DMACm_CHSTAT_n."
        },
        "type": {
          "type": "string",
          "description": "Optional caution type filter, for example reserved-bit, clear-semantics, write-timing, undefined-invalid, prohibited, note, caution, reset-access."
        },
        "top_k": {
          "type": "number",
          "description": "Maximum number of cautions to list. Default 80, max 200."
        }
      },
      "required": [
        "filename"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "get_cautions_for_register",
    "description": "Get persistent caution/note/restriction candidates for one register from the .cautions.json index. Useful before approving register writes in a Linux driver.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename, for example: WDT.pdf, GPT.pdf, or r01uh1069ej0115-rzg3e-DMA.pdf"
        },
        "register": {
          "type": "string",
          "description": "Register name, for example DMACm_CHCTRL_n, DMACm_CHSTAT_n, WDTCR, WDTRR, GTCR, or GTCCR."
        },
        "filter": {
          "type": "string",
          "description": "Optional topic filter, for example reserved bits, write only when stopped, clear status flag, write 1 to clear, write 0 to clear, undefined, or reset."
        },
        "top_k": {
          "type": "number",
          "description": "Maximum number of register-specific cautions. Default 80, max 200."
        },
        "include_dynamic_fallback": {
          "type": "boolean",
          "description": "If true, run the slower dynamic full-index fallback when persistent caution candidates are insufficient. Default false."
        }
      },
      "required": [
        "filename",
        "register"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "table_coverage_report",
    "description": "Diagnose captioned table coverage by comparing table captions detected in page text, structured .tables.json entries, and visual-table records in the figure manifest. .tables.json covers structured/layout text tables only; captioned visual tables are tracked in .figures.json as visual-table records. A table missing from .tables.json is not necessarily missing.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename."
        },
        "build_if_missing": {
          "type": "boolean",
          "description": "Optional lightweight figure/visual-table manifest build if missing. Default false."
        }
      },
      "required": [
        "filename"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "find_sequence",
    "description": "Find hardware operation sequences/procedures such as initialization, start, stop, clear status, reset, enable/disable, or interrupt handling. Useful for detecting driver bugs caused by wrong register write order.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename, for example: WDT.pdf, GPT.pdf, or r01uh1069ej0115-rzg3e-DMA.pdf"
        },
        "topic": {
          "type": "string",
          "description": "Sequence topic to find, for example initialization, start DMA transfer, stop channel, clear transfer end, clear interrupt, reset, software reset, enable channel."
        },
        "register": {
          "type": "string",
          "description": "Optional register name to prioritize context, for example DMACm_CHCTRL_n, DMACm_CHSTAT_n, WDTCR, WDTRR, GTCR, or GTCCR."
        },
        "top_k": {
          "type": "number",
          "description": "Maximum number of sequence candidates. Default 10, max 30."
        }
      },
      "required": [
        "filename",
        "topic"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "find_caution",
    "description": "Find caution/note/restriction/undefined/prohibited/reserved-bit/clear-flag semantics in a hardware manual. Useful for detecting driver bugs such as writing registers while running, reserved-bit handling errors, or wrong write-1-to-clear/write-0-to-clear behavior.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename, for example: WDT.pdf, GPT.pdf, or r01uh1069ej0115-rzg3e-DMA.pdf"
        },
        "topic": {
          "type": "string",
          "description": "Caution topic to find, for example reserved bits, write only when stopped, clear flag, write 1 to clear, write 0 to clear, undefined, prohibited, interrupt status, reset, or a register-related condition."
        },
        "register": {
          "type": "string",
          "description": "Optional register name to prioritize context, for example DMACm_CHCTRL_n, DMACm_CHSTAT_n, WDTCR, WDTRR, GTCR, or GTCCR."
        },
        "top_k": {
          "type": "number",
          "description": "Maximum number of caution candidates. Default 10, max 30."
        }
      },
      "required": [
        "filename",
        "topic"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "extract_layout_tables_from_pages",
    "description": "Step 30A/30B: extract layout-aware table candidates from selected PDF pages. This is coordinate/text-item table extraction, not visual semantic truth. Reconstructs rows/columns from PDF text item coordinates, infers semantic column roles such as bit/register/offset/access/reset/description and pin/function/signal/port/peripheral, and marks ambiguous rows. Text search/page extraction can locate visual tables, but must not be used as semantic truth for visual tables/figures. Visual/captioned tables are indexed in .figures.json; structured text/layout tables are indexed in .tables.json. For Table X.Y-Z with visual layout, bit arrangement, data format, MSB/LSB, timing/waveform: use search_figures -> get_figure_context_pack -> get_figure_image transport=metadata for canonical image path metadata.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename, for example WDT.pdf or r01uh1069ej0115-rzg3e-DMA.pdf"
        },
        "start_page": {
          "type": "number",
          "description": "Start page number, 1-based."
        },
        "end_page": {
          "type": "number",
          "description": "End page number, 1-based. Maximum range is 8 pages."
        },
        "min_columns": {
          "type": "number",
          "description": "Minimum number of detected columns for a row/table candidate. Default 2."
        },
        "kind": {
          "type": "string",
          "enum": [
            "auto",
            "register",
            "bitfield",
            "pinmux",
            "all"
          ],
          "description": "Optional table kind filter. Default auto/all. Step 30B adds pinmux/pin-function table filtering."
        }
      },
      "required": [
        "filename",
        "start_page",
        "end_page"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "extract_pinmux_table",
    "description": "Step 30B: extract layout-aware pinmux / pin function table candidates using PDF text-item coordinates. Reconstructs rows/columns, infers semantic roles such as pin/port/function/signal/peripheral/mode/group, and returns candidate pin-function mappings with confidence and raw cells. Use for pinctrl, GPIO, pin function, alternate function, and multiplexing tables.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename, for example pinctrl.pdf or SoC pin function manual PDF."
        },
        "start_page": {
          "type": "number",
          "description": "Optional start page number, 1-based. If omitted, the tool searches indexed text for candidate pinmux pages."
        },
        "end_page": {
          "type": "number",
          "description": "Optional end page number, 1-based. Maximum range is 8 pages."
        },
        "min_columns": {
          "type": "number",
          "description": "Minimum detected columns for row/table candidates. Default 2."
        },
        "filter": {
          "type": "string",
          "description": "Optional substring filter across pin/port/function/signal/description, for example P2_1, IRQ8, TXD, SDA, ETH, GBETH."
        },
        "pin": {
          "type": "string",
          "description": "Optional pin/port filter, for example P2_1, P10_3, GPIO3_5."
        },
        "function": {
          "type": "string",
          "description": "Optional function/signal/peripheral filter, for example IRQ8, TXD0, SDA1, ETH, GBETH."
        },
        "top_k": {
          "type": "number",
          "description": "Maximum rows to return. Default 80, max 200."
        }
      },
      "required": [
        "filename"
      ],
      "additionalProperties": false
    }
  }
]);
