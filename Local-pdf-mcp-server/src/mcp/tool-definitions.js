import {
  DEFAULT_BITFIELD_LIST_TOP_K,
  DEFAULT_CAUTION_LIST_TOP_K,
  DEFAULT_CAUTION_TOP_K,
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_DRIVER_PACK_BUDGET_MS,
  DEFAULT_DRIVER_PACK_REGISTERS,
  DEFAULT_DRIVER_PACK_SUMMARIES,
  DEFAULT_DRIVER_TASK_BUDGET_MS,
  DEFAULT_DRIVER_TASK_REGISTERS,
  DEFAULT_FIGURE_TOP_K,
  DEFAULT_HYBRID_TOP_K,
  DEFAULT_REGISTER_LIST_TOP_K,
  DEFAULT_REGISTER_SUMMARY_CHUNKS,
  DEFAULT_SEQUENCE_LIST_TOP_K,
  DEFAULT_SEQUENCE_TOP_K,
  DEFAULT_TOP_K,
  MAX_BITFIELD_LIST_TOP_K,
  MAX_CAUTION_LIST_TOP_K,
  MAX_CAUTION_TOP_K,
  MAX_DRIVER_PACK_BUDGET_MS,
  MAX_DRIVER_PACK_REGISTERS,
  MAX_DRIVER_PACK_SUMMARIES,
  MAX_DRIVER_TASK_REGISTERS,
  MAX_FIGURE_TOP_K,
  MAX_HYBRID_TOP_K,
  MAX_PAGE_RANGE,
  MAX_REGISTER_LIST_TOP_K,
  MAX_REGISTER_SUMMARY_CHUNKS,
  MAX_SEQUENCE_LIST_TOP_K,
  MAX_SEQUENCE_TOP_K,
  MAX_TABLE_PAGE_RANGE,
  MAX_TOP_K,
  MIN_DRIVER_PACK_BUDGET_MS,
} from "../core/runtime-constants.js";
import { DEFAULT_GOLDEN_PROFILE } from "../eval/golden.js";

// Public MCP definitions are intentionally data-only so health checks can import
// the catalog without starting the server or loading a PDF.
const ALL_TOOL_DEFINITIONS = [
  {
    name: "list_pdfs",
    description:
      "List all PDF files available in the local documents folder.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "pdf_info",
    description:
      "Get file metadata, PDF page count, and index status for a local PDF.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: GBETH.pdf",
        },
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "doctor",
    description:
      "Check MCP server health for one PDF or all PDFs without rebuilding indexes. Validates PDF readability, core indexes, persistent manual-intelligence artifacts, stale/broken JSON, count mismatches, and optional generated reports.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "Optional PDF filename. If omitted, doctor checks all PDFs in the documents folder.",
        },
        strict: {
          type: "boolean",
          description: "If true, optional artifacts such as module profile/driver pack/task plan are reported more aggressively. Default false.",
        },
        write_report: {
          type: "boolean",
          description: "If true, save a .doctor.txt report in the indexes folder. Default true for single-file checks.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "validate_index",
    description:
      "Validate index artifacts for a PDF without rebuilding. This is a focused alias of doctor for checking whether indexes are missing, stale, incompatible, broken, or internally inconsistent.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: GBETH.pdf. If omitted, validates all PDFs.",
        },
        strict: {
          type: "boolean",
          description: "If true, include optional artifacts in the final health decision. Default false.",
        },
        write_report: {
          type: "boolean",
          description: "If true, save a .doctor.txt report in the indexes folder. Default false.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "plan_manual_workflow",
    description:
      "Route a driver/manual task to the correct MCP workflow. Use this first when an AI agent is unsure which PDF/manual tools to call for driver implementation, debug, review, pinmux/table extraction, register verification, or eval hardening.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Optional PDF filename. If provided, the plan includes file health and concrete tool calls." },
        task: { type: "string", description: "Driver/manual task, bug description, or review goal." },
        module_type: { type: "string", description: "Optional subsystem/module hint, for example ethernet, dmaengine, watchdog, pwm, gpio, pinctrl, i2c, spi, usb, can, pcie, rtc." },
        driver_family: { type: "string", description: "Optional driver family hint, for example stmmac, ravb, rzg2l-gpt, riic, rspi, custom." },
        source_files: { type: "array", items: { type: "string" }, description: "Source files that the VS Code agent will inspect. MCP does not read them." },
        focus_registers: { type: "array", items: { type: "string" }, description: "Registers already suspected or seen in source." },
        focus_bitfields: { type: "array", items: { type: "string" }, description: "Bitfields already suspected or seen in source." },
        depth: { type: "string", enum: ["quick", "standard", "deep"], description: "Workflow strictness. Default standard." },
        output_format: { type: "string", enum: ["report", "checklist", "patch_plan", "debug_plan"], description: "Target final output style for the agent. Default report." },
        include_eval: { type: "boolean", description: "Include eval/static-hardening steps. Default true." },
        include_visual: { type: "boolean", description: "Include visual/table evidence steps when relevant. Default true." }
      },
      additionalProperties: false,
    },
  },
  {
    name: "explain_tool_usage",
    description:
      "Explain which MCP tool to use, when to use it, required inputs, typical next tool, and evidence trust level. Use this as inline help for AI agents to avoid wrong tool selection.",
    inputSchema: {
      type: "object",
      properties: {
        tool_name: { type: "string", description: "Optional specific MCP tool name, for example verify_register_usage. If omitted, returns a compact workflow-oriented catalog." },
        task: { type: "string", description: "Optional task context to bias recommendations." }
      },
      additionalProperties: false,
    },
  },
  {
    name: "eval_health_check",
    description:
      "Run static eval/tool-registry hardening checks without requiring a PDF. Verifies tool registry uniqueness, handler coverage, eval/profile JSON readability, schema versions, and npm-test readiness.",
    inputSchema: {
      type: "object",
      properties: {
        create_default: { type: "boolean", description: "Create default eval/profile files before checking. Default true." },
        include_profiles: { type: "boolean", description: "Check driver_profiles/*.json and eval/profiles/*.json. Default true." },
        include_fixtures: { type: "boolean", description: "Check eval/fixtures/*.json. Default true." },
        write_report: { type: "boolean", description: "Save indexes/eval-health-report.json and .txt. Default true." },
        step40_action: { type: "string", description: "Deprecated migration shim only. Use mcp_control(action=...) instead." }
      },
      additionalProperties: false,
    },
  },

  {
    name: "mcp_control",
    description:
      "Control-plane utility for MCP server ping, lightweight index status, detached artifact rebuild jobs, job polling/cancel/cleanup, and cache status/cleanup. Use this instead of routing control actions through eval_health_check.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["ping", "compat_report", "index_status_lite", "ocr_health", "rebuild_artifact", "job_status", "list_jobs", "cancel_job", "cleanup_jobs", "cache_status", "cleanup_cache", "figure_cache_status", "cleanup_figure_cache"] },
        filename: { type: "string" }, artifact: { type: "string" }, job_id: { type: "string" }, reason: { type: "string" },
        statuses: { type: "array", items: { type: "string" } }, kind: { type: "string" }, older_than_hours: { type: "number" }, max_bytes: { type: "number" }, stale_by_source: { type: "boolean" }, confirm: { type: "boolean" }, include_running: { type: "boolean" }, json: { type: "boolean" }, force_lock: { type: "boolean" }, force: { type: "boolean" }, chunk_size: { type: "number" }, chunk_overlap: { type: "number" }, allow_full_rebuild: { type: "boolean" }, cascade_dependents: { type: "boolean" }
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "list_eval_cases",
    description:
      "List internal regression/evaluation cases for this MCP server. Creates eval/manual-cases.json with default cases if it does not exist.",
    inputSchema: {
      type: "object",
      properties: {
        case_id: {
          type: "string",
          description: "Optional case ID filter.",
        },
        create_default: {
          type: "boolean",
          description: "Create default eval/manual-cases.json and eval/profiles/*.json if missing. Default true.",
        },
        scope: {
          type: "string",
          enum: ["all", "generic", "profiles", "fixtures"],
          description: "Which eval cases to list. all merges generic cases, eval profiles, and fixture metadata. Default all.",
        },
        module_type: {
          type: "string",
          description: "Optional module/profile filter, for example ethernet, dmaengine, watchdog, pwm, usb, can, pcie.",
        },
        eval_profile: {
          type: "string",
          description: "Optional explicit eval profile name under eval/profiles/, for example ethernet or dmaengine.",
        },
        fixture: {
          type: "string",
          description: "Optional explicit fixture file name under eval/fixtures/ without .json.",
        },
        include_disabled: {
          type: "boolean",
          description: "Include disabled fixture case files in the listing. Default true for listing, false for run_eval.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "run_eval",
    description:
      "Run internal regression/evaluation cases against one manual PDF. This does not rebuild indexes unless auto_index=true. Use after changing scoring/parser/workflow code.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename to evaluate, for example r01uh1069ej0115-rzg3e-DMA.pdf. If omitted, the first available PDF is used when possible.",
        },
        case_id: {
          type: "string",
          description: "Optional single case ID to run.",
        },
        module_type: {
          type: "string",
          description: "Optional module type hint injected into applicable default cases, for example dmaengine, watchdog, pwm.",
        },
        auto_index: {
          type: "boolean",
          description: "If true, run index_pdf automatically when doctor reports missing core indexes. Default false.",
        },
        write_report: {
          type: "boolean",
          description: "If true, save .eval-report.txt and .eval-report.json in indexes/. Default true.",
        },
        create_default: {
          type: "boolean",
          description: "Create default eval/manual-cases.json and eval/profiles/*.json if missing. Default true.",
        },
        eval_profile: {
          type: "string",
          description: "Optional explicit eval profile to include from eval/profiles/, for example ethernet, dmaengine, watchdog, pwm, usb, can, pcie, or generic.",
        },
        include_profiles: {
          type: "boolean",
          description: "Include applicable eval/profiles/*.json cases. Default true.",
        },
        include_fixtures: {
          type: "boolean",
          description: "Include matching enabled eval/fixtures/*.json cases. Default true.",
        },
        fixture: {
          type: "string",
          description: "Optional explicit fixture file under eval/fixtures/ without .json. Explicit fixtures run even if disabled=false.",
        },
        include_golden: {
          type: "boolean",
          description: "If true, include V2 register/bitfield golden accuracy checks. Default false.",
        },
        golden_profile: {
          type: "string",
          description: `Golden profile under eval/golden without .json. Default ${DEFAULT_GOLDEN_PROFILE}.`,
        },
        strict_verified_only: {
          type: "boolean",
          description: "If true, only status=verified golden facts can fail the report. Default true.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "start_index_pdf",
    description:
      `Start PDF indexing as a background job. Use this for large manuals (500/800/1000+ pages) to avoid MCP client request timeout. Poll with mcp_control(action="job_status", job_id="...") or direct job_status(job_id="...") if using the public helper.`,
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename, for example GBETH.pdf" },
        force: { type: "boolean", description: "Force rebuilding the index even if a valid index exists. Default false." },
        force_lock: { type: "boolean", description: "Remove stale/existing index lock before rebuilding. Use only when safe. Default false." },
        chunk_size: { type: "number", description: `Chunk size in characters. Default ${DEFAULT_CHUNK_SIZE}.` },
        chunk_overlap: { type: "number", description: `Chunk overlap in characters. Default ${DEFAULT_CHUNK_OVERLAP}.` }
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "job_status",
    description:
      `Direct public helper for job polling; preferred control-plane form is mcp_control(action="job_status", job_id="...").`,
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Job ID returned by start_index_pdf/index_pdf." }
      },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_jobs",
    description:
      `Direct public helper for job listing; preferred control-plane form is mcp_control(action="list_jobs").`,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "index_pdf",
    description:
      "Build or rebuild searchable text, page cache, section/register/bitfield/sequence/caution indexes for a local PDF. Uses an index build lock and atomic writes to avoid corrupted JSON artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: GBETH.pdf",
        },
        force: {
          type: "boolean",
          description:
            "Force rebuilding the index even if a valid index already exists.",
        },
        force_lock: {
          type: "boolean",
          description:
            "If true, remove an existing index build lock before rebuilding. Use only if you are sure no other index_pdf is running for this PDF.",
        },
        mode: {
          type: "string",
          enum: ["auto", "foreground", "background"],
          description:
            "Indexing execution mode. auto starts a background job for large PDFs or rebuilds; foreground blocks the MCP request and may timeout on large manuals; background always returns a job ID immediately. Default auto.",
        },
        chunk_size: {
          type: "number",
          description: `Chunk size in characters. Default ${DEFAULT_CHUNK_SIZE}.`,
        },
        chunk_overlap: {
          type: "number",
          description: `Chunk overlap in characters. Default ${DEFAULT_CHUNK_OVERLAP}.`,
        },
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "search_pdf",
    description:
      "Search keywords, phrases, register names, bit names, or natural-language questions inside an indexed PDF. Returns page numbers and chunk IDs. Text search/page extraction can locate visual tables, but must not be used as semantic truth for visual tables/figures. Visual/captioned tables are indexed in .figures.json; structured text/layout tables are indexed in .tables.json. For Table X.Y-Z with visual layout, bit arrangement, data format, MSB/LSB, timing/waveform: use search_figures -> get_figure_context_pack -> get_figure_image for actual image content.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: GBETH.pdf",
        },
        query: {
          type: "string",
          description:
            "Keyword, exact phrase, register name, bit field, section title, or natural-language query.",
        },
        top_k: {
          type: "number",
          description: `Maximum number of results. Default ${DEFAULT_TOP_K}, max ${MAX_TOP_K}.`,
        },
      },
      required: ["filename", "query"],
      additionalProperties: false,
    },
  },
  {
    name: "hybrid_search_pdf",
    description:
      "Search an indexed PDF without embeddings by combining exact phrase, keyword/BM25-like scoring, fuzzy token matching, intent expansion, and boosts from register/section/sequence/caution indexes. Use this for natural-language questions when Ollama/embedding search is unavailable. Text search/page extraction can locate visual tables, but must not be used as semantic truth for visual tables/figures. Visual/captioned tables are indexed in .figures.json; structured text/layout tables are indexed in .tables.json. For Table X.Y-Z with visual layout, bit arrangement, data format, MSB/LSB, timing/waveform: use search_figures -> get_figure_context_pack -> get_figure_image for actual image content.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: GBETH.pdf",
        },
        query: {
          type: "string",
          description:
            "Natural-language question, operation intent, register/bitfield/topic, or phrase to search.",
        },
        register: {
          type: "string",
          description:
            "Optional register context to boost related chunks, for example DMACm_CHCTRL_n or WDTCR.",
        },
        intent: {
          type: "string",
          enum: [
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
          description:
            "Optional search intent. Use auto by default; set a concrete intent to bias ranking.",
        },
        top_k: {
          type: "number",
          description: `Maximum number of results. Default ${DEFAULT_HYBRID_TOP_K}, max ${MAX_HYBRID_TOP_K}.`,
        },
      },
      required: ["filename", "query"],
      additionalProperties: false,
    },
  },
  {
    name: "chunk_type_stats",
    description:
      "Show chunkType/noise/content statistics for an indexed PDF. Use this after index_pdf to verify Step 23 classification and diagnose noisy TOC/index/revision chunks affecting search quality.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: GBETH.pdf",
        },
        include_examples: {
          type: "boolean",
          description: "Include representative chunk examples for each chunk type. Default true.",
        },
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "read_pdf_pages",
    description:
      "Read extractable text from a specific page range in a local PDF. Use after search_pdf/find_register/find_section to inspect relevant pages. Text search/page extraction can locate visual tables, but must not be used as semantic truth for visual tables/figures. Visual/captioned tables are indexed in .figures.json; structured text/layout tables are indexed in .tables.json. For Table X.Y-Z with visual layout, bit arrangement, data format, MSB/LSB, timing/waveform: use search_figures -> get_figure_context_pack -> get_figure_image for actual image content.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: GBETH.pdf",
        },
        start_page: {
          type: "number",
          description: "Start page number, 1-based.",
        },
        end_page: {
          type: "number",
          description: `End page number, 1-based. Maximum range is ${MAX_PAGE_RANGE} pages.`,
        },
      },
      required: ["filename", "start_page", "end_page"],
      additionalProperties: false,
    },
  },
  {
    name: "read_pdf_chunk",
    description:
      "Read the full text of a specific indexed chunk by chunk ID, for example GBETH.pdf:p17:c0. Text search/page extraction can locate visual tables, but must not be used as semantic truth for visual tables/figures. Visual/captioned tables are indexed in .figures.json; structured text/layout tables are indexed in .tables.json. For Table X.Y-Z with visual layout, bit arrangement, data format, MSB/LSB, timing/waveform: use search_figures -> get_figure_context_pack -> get_figure_image for actual image content.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: GBETH.pdf",
        },
        chunk_id: {
          type: "string",
          description:
            "Chunk ID returned by search_pdf, find_register, or find_section.",
        },
      },
      required: ["filename", "chunk_id"],
      additionalProperties: false,
    },
  },
  {
    name: "find_register",
    description:
      "Find a hardware register using the register index first, then fall back to chunk search. Supports prefixed/unprefixed variants such as MACCR, GBETHm_MACCR, WDTCR, WDTRR, GTCR, or GTCCR.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: GBETH.pdf",
        },
        register: {
          type: "string",
          description:
            "Register abbreviation or full register name, for example MACCR, GBETHm_MACCR, WDTCR, GTCCR.",
        },
        top_k: {
          type: "number",
          description: `Maximum number of results. Default ${DEFAULT_TOP_K}, max ${MAX_TOP_K}.`,
        },
      },
      required: ["filename", "register"],
      additionalProperties: false,
    },
  },
  {
    name: "list_registers",
    description:
      "List detected hardware registers from the register index so an AI agent can explore the module register map before inspecting specific registers.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: GBETH.pdf",
        },
        filter: {
          type: "string",
          description:
            "Optional substring filter for register names, aliases, headings, or section titles. Examples: WDT, MAC, DMA, GPT, GTCC.",
        },
        top_k: {
          type: "number",
          description: `Maximum number of registers to list. Default ${DEFAULT_REGISTER_LIST_TOP_K}, max ${MAX_REGISTER_LIST_TOP_K}.`,
        },
        include_low_confidence: {
          type: "boolean",
          description:
            "Include low-confidence symbol-only candidates. Default false. Keep false when exploring the real register map.",
        },
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "find_bitfield",
    description:
      "Find chunks related to a hardware register bit field such as EN, ER, SUS, TC, CKS, TOPS, RPES, TSTART, or TCSTF. If register is provided, related register context is prioritized.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: WDT.pdf or r01uh1069ej0115-rzg3e-DMA.pdf",
        },
        bitfield: {
          type: "string",
          description:
            "Bit field name or symbol to find, for example EN, ER, TC, CKS, TOPS, RPES, TSTART, or TCSTF.",
        },
        register: {
          type: "string",
          description:
            "Optional register name to constrain/prioritize context, for example DMACm_CHCTRL_n, WDTCR, GTCR, or GTCCR.",
        },
        top_k: {
          type: "number",
          description: `Maximum number of results. Default ${DEFAULT_TOP_K}, max ${MAX_TOP_K}.`,
        },
      },
      required: ["filename", "bitfield"],
      additionalProperties: false,
    },
  },
  {
    name: "list_bitfields",
    description:
      "List detected bit-field candidates for a register or for the whole indexed hardware manual. Uses the persistent .bitfields.json index built by index_pdf.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example WDT.pdf or r01uh1069ej0115-rzg3e-DMA.pdf",
        },
        register: {
          type: "string",
          description:
            "Optional register name to filter bit fields, for example DMACm_CHCTRL_n, WDTCR, GTCR, or GTCCR.",
        },
        filter: {
          type: "string",
          description:
            "Optional substring filter for bit-field name, description, evidence, or register.",
        },
        top_k: {
          type: "number",
          description: `Maximum number of bit fields to list. Default ${DEFAULT_BITFIELD_LIST_TOP_K}, max ${MAX_BITFIELD_LIST_TOP_K}.`,
        },
        include_low_confidence: {
          type: "boolean",
          description:
            "Include low-confidence symbol-only candidates. Default false.",
        },
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "extract_tables_from_pages",
    description:
      "Extract table-like structures from a PDF page range using PDF text item coordinates. Step 30A also annotates semantic column roles when possible. Useful for inspecting register maps and bit-field tables when plain text extraction loses columns.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example WDT.pdf or r01uh1069ej0115-rzg3e-DMA.pdf",
        },
        start_page: {
          type: "number",
          description: "Start page number, 1-based.",
        },
        end_page: {
          type: "number",
          description: `End page number, 1-based. Maximum range is ${MAX_TABLE_PAGE_RANGE} pages.`,
        },
        min_columns: {
          type: "number",
          description: "Minimum number of detected columns for a row/table candidate. Default 3.",
        },
      },
      required: ["filename", "start_page", "end_page"],
      additionalProperties: false,
    },
  },
  {
    name: "check_pdf_renderers",
    description:
      "Check which optional external PDF page renderers are available for Step 31B visual review. Supported renderers: pdftoppm/Poppler, mutool/MuPDF, magick/ImageMagick. Canonical visual workflow uses get_figure_context_pack image_path under indexes/cache/figure-images; page render tools are not exposed as MCP tools.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "visual_review_handoff_pack",
    description:
      "Step 32: build a workflow/prompt pack for visual manual content. Default workflow prioritizes search_figures -> get_figure_context_pack and requires get_figure_image to return actual image content from canonical indexes/cache/figure-images image_path. Do not recommend legacy page/region render tools for normal visual table/figure analysis.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename, for example GBETH.pdf or r01uh1039ej0120-rzt2h_n2h-GPIO.pdf." },
        query: { type: "string", description: "Visual target query, for example clock tree, read timing diagram, Safety I/O port setting flow, interrupt route, reset sequence." },
        figure_id: { type: "string", description: "Optional Figure ID from list_figures/search_figures, for example fig-p113-17.3." },
        page: { type: "number", description: "Optional 1-based page number if the visual target page is already known." },
        kind: { type: "string", description: "Optional figure kind filter, for example timing-diagram, clock-tree, block-diagram, flow-sequence, pinmux, interrupt, reset-power." },
        diagram_type: { type: "string", enum: ["auto", "clock_tree", "timing", "block_diagram", "reset_flow", "interrupt_route", "pinmux", "sequence", "table", "other"], description: "Expected visual content type. Default auto." },
        task: { type: "string", description: "Optional review task, for example verify reset sequence, inspect timing diagram, understand clock tree, or review pinmux flow." },
        source_files: { type: "array", items: { type: "string" }, description: "Optional source/DTS files the VS Code agent should inspect alongside the visual manual evidence." },
        review_depth: { type: "string", enum: ["quick", "standard", "deep"], description: "How strict the visual review workflow should be. Default standard." },
        output_format: { type: "string", enum: ["report", "debug_plan", "patch_plan", "checklist"], description: "Expected final response style from the agent. Default report." },
        top_k: { type: "number", description: "Number of figure candidates to include when searching by query. Default 6." },
        include_layout_tables: { type: "boolean", description: "Include layout-table extraction context when useful. Default true." }
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "add_visual_evidence",
    description:
      "Step 33: persist structured observations from canonical visual analysis. Use this after the agent/human has opened canonical image_path returned by get_figure_context_pack. canonical image_path from indexes/cache/figure-images is preferred.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename." },
        figure_id: { type: "string", description: "Optional Figure/Table ID from search_figures/list_figures." },
        page: { type: "number", description: "Optional 1-based page number for the visual evidence." },
        query: { type: "string", description: "Optional visual target query/task." },
        diagram_type: { type: "string", enum: ["auto", "clock_tree", "timing", "block_diagram", "reset_flow", "interrupt_route", "pinmux", "sequence", "table", "other"], description: "Visual evidence type. Default auto." },
        direct_visual_observations: { type: "array", items: { type: "string" }, description: "Direct facts visible in the rendered image. Do not put speculative driver conclusions here." },
        caption_context_facts: { type: "array", items: { type: "string" }, description: "Facts from caption/context text around the figure." },
        extracted_items: { type: "object", description: "Structured extraction payload, e.g. steps/clocks/signals/edges/pins/selectors/routing/timing_constraints.", additionalProperties: true },
        engineering_inferences: { type: "array", items: { type: "string" }, description: "Engineering interpretation derived from the visual evidence. Must remain separate from direct observations." },
        source_implications: { type: "array", items: { type: "string" }, description: "Implications for Linux driver/DTS/source review." },
        uncertainties: { type: "array", items: { type: "string" }, description: "Ambiguous or unreadable visual details that need a better crop or text cross-check." },
        related_registers: { type: "array", items: { type: "string" }, description: "Registers related to this visual evidence." },
        related_bitfields: { type: "array", items: { type: "string" }, description: "Bitfields related to this visual evidence." },
        source_files: { type: "array", items: { type: "string" }, description: "Source/DTS files this evidence may affect." },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags such as clock, reset, irq, pinmux, timing." },
        verification_status: { type: "string", enum: ["observed", "needs_verification", "verified", "rejected"], description: "Default needs_verification." },
        confidence: { type: "string", enum: ["low", "medium", "high"], description: "Confidence in direct visual observations. Default medium." },
        notes: { type: "string", description: "Optional free-form note." }
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "list_visual_evidence",
    description:
      "List persisted Step 33 visual evidence entries for a manual. Supports filtering by query/tag/diagram_type/page/status.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename." },
        filter: { type: "string", description: "Optional keyword filter over observations/inferences/tags/registers." },
        diagram_type: { type: "string", description: "Optional diagram type filter." },
        page: { type: "number", description: "Optional page filter." },
        status: { type: "string", description: "Optional verification status filter." },
        top_k: { type: "number", description: "Maximum entries to show. Default 20." }
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "get_visual_evidence",
    description:
      "Get one persisted visual evidence entry by evidence_id, including observations, structured extraction, uncertainties, source implications, and recommended verification calls.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename." },
        evidence_id: { type: "string", description: "Visual evidence ID returned by add_visual_evidence/list_visual_evidence." }
      },
      required: ["filename", "evidence_id"],
      additionalProperties: false,
    },
  },
  {
    name: "visual_evidence_report",
    description:
      "Generate a structured report from persisted visual evidence entries for a manual. Use this before driver review to reuse visual observations from clock trees, timing diagrams, pinmux flows, reset/IRQ routing figures, and table screenshots.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename." },
        filter: { type: "string", description: "Optional keyword filter." },
        diagram_type: { type: "string", description: "Optional diagram type filter." },
        status: { type: "string", description: "Optional verification status filter." },
        include_entries: { type: "boolean", description: "Include detailed entries. Default true." },
        top_k: { type: "number", description: "Maximum entries to include. Default 50." }
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "visual_evidence_verification_queue",
    description:
      "Step 35: list visual evidence entries that still need verification, with suggested manual-evidence calls. Use this before approving driver conclusions that depend on clock/tree/timing/pinmux/reset-flow observations.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename." },
        filter: { type: "string", description: "Optional keyword filter over observations/inferences/tags/registers." },
        diagram_type: { type: "string", description: "Optional diagram type filter." },
        page: { type: "number", description: "Optional page filter." },
        include_observed: { type: "boolean", description: "Also include entries with status observed. Default true." },
        include_rejected: { type: "boolean", description: "Also include rejected entries. Default false." },
        top_k: { type: "number", description: "Maximum entries to show. Default 30." }
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "verify_visual_evidence",
    description:
      "Step 35: update a persisted visual evidence entry verification status with supporting manual evidence. Use status=verified only after cross-checking with manual text/register/bitfield/sequence/caution evidence. The update is appended to verification_history.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename." },
        evidence_id: { type: "string", description: "Visual evidence ID." },
        status: { type: "string", enum: ["observed", "needs_verification", "verified", "rejected"], description: "New verification status." },
        confidence: { type: "string", enum: ["low", "medium", "high"], description: "Updated confidence. Optional." },
        verification_note: { type: "string", description: "Concise explanation for the status update." },
        supporting_evidence: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", description: "manual_text | register | bitfield | sequence | caution | source | render | other" },
              tool: { type: "string", description: "Tool that produced the evidence, e.g. read_pdf_pages/get_sequence/verify_register_usage." },
              page: { type: "number" },
              register: { type: "string" },
              bitfield: { type: "string" },
              quote: { type: "string" },
              note: { type: "string" }
            },
            additionalProperties: true
          },
          description: "Supporting evidence used to verify/reject this visual observation. Required for status=verified unless allow_without_support=true."
        },
        supporting_tool_calls: { type: "array", items: { type: "string" }, description: "Concrete MCP calls used during verification." },
        resolved_uncertainties: { type: "array", items: { type: "string" }, description: "Uncertainties resolved by this update." },
        remaining_uncertainties: { type: "array", items: { type: "string" }, description: "Uncertainties still open after this update." },
        tags_to_add: { type: "array", items: { type: "string" }, description: "Optional tags to add." },
        notes: { type: "string", description: "Optional additional note appended to entry notes." },
        reviewer: { type: "string", description: "Optional reviewer/agent label." },
        allow_without_support: { type: "boolean", description: "Allow status=verified without supporting_evidence. Default false; not recommended." }
      },
      required: ["filename", "evidence_id", "status"],
      additionalProperties: false,
    },
  },
  {
    name: "extract_layout_tables_from_pages",
    description:
      "Step 30A/30B: extract layout-aware table candidates from selected PDF pages. This is coordinate/text-item table extraction, not visual semantic truth. Reconstructs rows/columns from PDF text item coordinates, infers semantic column roles such as bit/register/offset/access/reset/description and pin/function/signal/port/peripheral, and marks ambiguous rows. Text search/page extraction can locate visual tables, but must not be used as semantic truth for visual tables/figures. Visual/captioned tables are indexed in .figures.json; structured text/layout tables are indexed in .tables.json. For Table X.Y-Z with visual layout, bit arrangement, data format, MSB/LSB, timing/waveform: use search_figures -> get_figure_context_pack -> get_figure_image for actual image content.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename, for example WDT.pdf or r01uh1069ej0115-rzg3e-DMA.pdf" },
        start_page: { type: "number", description: "Start page number, 1-based." },
        end_page: { type: "number", description: `End page number, 1-based. Maximum range is ${MAX_TABLE_PAGE_RANGE} pages.` },
        min_columns: { type: "number", description: "Minimum number of detected columns for a row/table candidate. Default 2." },
        kind: { type: "string", enum: ["auto", "register", "bitfield", "pinmux", "all"], description: "Optional table kind filter. Default auto/all. Step 30B adds pinmux/pin-function table filtering." },
      },
      required: ["filename", "start_page", "end_page"],
      additionalProperties: false,
    },
  },
  {
    name: "extract_pinmux_table",
    description:
      "Step 30B: extract layout-aware pinmux / pin function table candidates using PDF text-item coordinates. Reconstructs rows/columns, infers semantic roles such as pin/port/function/signal/peripheral/mode/group, and returns candidate pin-function mappings with confidence and raw cells. Use for pinctrl, GPIO, pin function, alternate function, and multiplexing tables.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename, for example pinctrl.pdf or SoC pin function manual PDF." },
        start_page: { type: "number", description: "Optional start page number, 1-based. If omitted, the tool searches indexed text for candidate pinmux pages." },
        end_page: { type: "number", description: `Optional end page number, 1-based. Maximum range is ${MAX_TABLE_PAGE_RANGE} pages.` },
        min_columns: { type: "number", description: "Minimum detected columns for row/table candidates. Default 2." },
        filter: { type: "string", description: "Optional substring filter across pin/port/function/signal/description, for example P2_1, IRQ8, TXD, SDA, ETH, GBETH." },
        pin: { type: "string", description: "Optional pin/port filter, for example P2_1, P10_3, GPIO3_5." },
        function: { type: "string", description: "Optional function/signal/peripheral filter, for example IRQ8, TXD0, SDA1, ETH, GBETH." },
        top_k: { type: "number", description: "Maximum rows to return. Default 80, max 200." }
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "list_figures",
    description:
      "List Figure/Table/diagram/caption candidates from the persistent .figures.json manifest. Does not rebuild by default; if missing, run rebuild_figure_manifest first (or explicitly set build_if_missing for a lightweight caption-only build).",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename." },
        page: { type: "number", description: "Optional 1-based page filter." },
        section: { type: "string", description: "Optional section-title filter." },
        limit: { type: "number", description: `Maximum records to return. Default ${DEFAULT_FIGURE_TOP_K}, max ${MAX_FIGURE_TOP_K}.` },
        filter: { type: "string", description: "Legacy optional substring filter across caption/context." },
        kind: { type: "string", description: "Legacy optional kind filter." },
        top_k: { type: "number", description: `Legacy maximum candidates. Default ${DEFAULT_FIGURE_TOP_K}, max ${MAX_FIGURE_TOP_K}.` },
        build_if_missing: { type: "boolean", description: "Optional lightweight caption-only build if the manifest is missing. Default false." }
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },

  {
    name: "search_figures",
    description: "Use this for Figure/Table/visual-table lookup. Visual/captioned tables are indexed in .figures.json. This only locates candidate visual artifacts; it does not provide visual semantics. For visual/captioned tables and figures, use search_figures -> get_figure_context_pack -> get_figure_image. get_figure_context_pack returns canonical image_path as a locator; get_figure_image returns the actual image content for visual inspection. Do not claim visual analysis from text extraction or from an image_path string alone. Structured text/layout tables are indexed in .tables.json.",
    inputSchema: { type: "object", properties: {
      filename: { type: "string", description: "PDF filename." },
      query: { type: "string", description: "Search query." },
      page: { type: "number", description: "Optional 1-based page filter." },
      section: { type: "string", description: "Optional section-title filter." },
      kind: { type: "string", description: "Optional kind filter: table, visual-table, bit-layout, format-diagram, timing-visual-table, sequence-visual-table, layout-table, or existing figure kinds." },
      limit: { type: "number", description: `Maximum records. Default ${DEFAULT_FIGURE_TOP_K}, max ${MAX_FIGURE_TOP_K}.` },
      build_if_missing: { type: "boolean", description: "Optional lightweight caption-only build if the manifest is missing. Default false." }
    }, required: ["filename", "query"], additionalProperties: false }
  },
  {
    name: "get_figure_image",
    description: "Return the canonical figure/table image as actual MCP image content for visual model inspection. For visual/captioned tables and figures, use search_figures -> get_figure_context_pack -> get_figure_image. get_figure_context_pack returns canonical image_path as a locator; get_figure_image returns the actual image content for visual inspection. Do not claim visual analysis from text extraction or from an image_path string alone.",
    inputSchema: { type: "object", properties: {
      filename: { type: "string" }, figure_id: { type: "string" }, image_path: { type: "string", description: "Optional canonical locator from get_figure_context_pack; must be under indexes/cache/figure-images." }, dpi: { type: "number", description: "Requested DPI. Default 200." }
    }, additionalProperties: false }
  },
  {
    name: "get_figure_context_pack",
    description: "Main visual-semantics entry point. For visual/captioned tables and figures, use search_figures -> get_figure_context_pack -> get_figure_image. get_figure_context_pack returns canonical image_path as a locator; get_figure_image returns the actual image content for visual inspection. Do not claim visual analysis from text extraction or from an image_path string alone. page_text_before/page_text_after/ocr_text are locator/supporting evidence only and must not be used as semantic truth.",
    inputSchema: { type: "object", properties: {
      filename: { type: "string" }, figure_id: { type: "string" }, dpi: { type: "number", description: "Requested render DPI for the figure/page image. Default 200." }, include_ocr: { type: "boolean", description: "Include cached OCR text if available. Default false." }, include_tables: { type: "boolean", description: "Include nearby/related tables. Default true." }, include_cautions: { type: "boolean", description: "Include nearby/related cautions. Default true." }
    }, required: ["filename", "figure_id"], additionalProperties: false }
  },
  {
    name: "rebuild_figure_manifest",
    description: "Build or rebuild <filename>.figures.json as a lightweight metadata-only manifest by default. Optional page performs a real page-limited update; no OCR/VL/semantic parsing or batch PNG rendering is run.",
    inputSchema: { type: "object", properties: { filename: { type: "string" }, page: { type: "number", description: "Optional 1-based page-limited rebuild; updates only that page and preserves other manifest entries when present." }, force: { type: "boolean" } }, required: ["filename"], additionalProperties: false }
  },

  {
    name: "table_coverage_report",
    description: "Diagnose captioned table coverage by comparing table captions detected in page text, structured .tables.json entries, and visual-table records in the figure manifest. .tables.json covers structured/layout text tables only; captioned visual tables are tracked in .figures.json as visual-table records. A table missing from .tables.json is not necessarily missing.",
    inputSchema: { type: "object", properties: {
      filename: { type: "string", description: "PDF filename." },
      build_if_missing: { type: "boolean", description: "Optional lightweight figure/visual-table manifest build if missing. Default false." }
    }, required: ["filename"], additionalProperties: false }
  },
  {
    name: "ocr_figure_for_search",
    description: "Optional OCR for search indexing only. Updates cached OCR keywords in the figure manifest so later search_figures calls can match them; does not perform semantic figure understanding.",
    inputSchema: { type: "object", properties: { filename: { type: "string" }, figure_id: { type: "string" }, force: { type: "boolean" } }, required: ["filename", "figure_id"], additionalProperties: false }
  },
  {
    name: "extract_register_table",
    description:
      "Extract register-map table candidates using PDF text item coordinates. Returns rows with register name, abbreviation, offset, initial value, access size, page, and confidence when detected.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example WDT.pdf or r01uh1069ej0115-rzg3e-DMA.pdf",
        },
        start_page: {
          type: "number",
          description: "Optional start page. If omitted, the tool uses register-index pages and register-list sections.",
        },
        end_page: {
          type: "number",
          description: "Optional end page. If omitted, the tool uses register-index pages and register-list sections.",
        },
        filter: {
          type: "string",
          description: "Optional register-name substring filter, for example DMACm, WDT, GT, MAC.",
        },
        top_k: {
          type: "number",
          description: "Maximum number of register rows to return. Default 80, max 200.",
        },
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "extract_bitfield_table",
    description:
      "Extract a layout-aware bit-field table for a register. Uses PDF text-item coordinates first to preserve bit/access/reset/description columns, then falls back to the persistent bitfield index. Verify ambiguous rows with read_pdf_pages/read_pdf_chunk.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example WDT.pdf or r01uh1069ej0115-rzg3e-DMA.pdf",
        },
        register: {
          type: "string",
          description:
            "Register name to extract a bit-field table for, for example DMACm_CHCTRL_n, WDTCR, GTCR, or GTCCR.",
        },
        top_k: {
          type: "number",
          description: `Maximum number of candidate bit fields/rows. Default ${DEFAULT_BITFIELD_LIST_TOP_K}, max ${MAX_BITFIELD_LIST_TOP_K}.`,
        },
      },
      required: ["filename", "register"],
      additionalProperties: false,
    },
  },
  {
    name: "summarize_register",
    description:
      "Summarize one hardware register by combining register-index metadata, related chunks, detected bit-field evidence, and suggested follow-up reads. Useful for Linux driver source review against the hardware manual.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: WDT.pdf or r01uh1069ej0115-rzg3e-DMA.pdf",
        },
        register: {
          type: "string",
          description:
            "Register abbreviation or full register name, for example DMACm_CHCTRL_n, WDTCR, GTCR, or GTCCR.",
        },
        top_k: {
          type: "number",
          description: `Maximum number of related chunks to include. Default ${DEFAULT_REGISTER_SUMMARY_CHUNKS}, max ${MAX_REGISTER_SUMMARY_CHUNKS}.`,
        },
        include_bitfield_evidence: {
          type: "boolean",
          description:
            "Include evidence lines for detected bit fields. Default true.",
        },
      },
      required: ["filename", "register"],
      additionalProperties: false,
    },
  },
  {
    name: "find_sequence",
    description:
      "Find hardware operation sequences/procedures such as initialization, start, stop, clear status, reset, enable/disable, or interrupt handling. Useful for detecting driver bugs caused by wrong register write order.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: WDT.pdf, GPT.pdf, or r01uh1069ej0115-rzg3e-DMA.pdf",
        },
        topic: {
          type: "string",
          description:
            "Sequence topic to find, for example initialization, start DMA transfer, stop channel, clear transfer end, clear interrupt, reset, software reset, enable channel.",
        },
        register: {
          type: "string",
          description:
            "Optional register name to prioritize context, for example DMACm_CHCTRL_n, DMACm_CHSTAT_n, WDTCR, WDTRR, GTCR, or GTCCR.",
        },
        top_k: {
          type: "number",
          description: `Maximum number of sequence candidates. Default ${DEFAULT_SEQUENCE_TOP_K}, max ${MAX_SEQUENCE_TOP_K}.`,
        },
      },
      required: ["filename", "topic"],
      additionalProperties: false,
    },
  },
  {
    name: "list_sequences",
    description:
      "List detected persistent operation-flow/sequence candidates from the .sequences.json index. Useful for discovering init/start/stop/clear/reset/IRQ/error flows in a hardware manual.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: WDT.pdf, GPT.pdf, or r01uh1069ej0115-rzg3e-DMA.pdf",
        },
        filter: {
          type: "string",
          description: "Optional substring filter, for example init, start, stop, clear, reset, irq, error, transfer, suspend.",
        },
        top_k: {
          type: "number",
          description: `Maximum number of sequences to list. Default ${DEFAULT_SEQUENCE_LIST_TOP_K}, max ${MAX_SEQUENCE_LIST_TOP_K}.`,
        },
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "get_sequence",
    description:
      "Get one persistent operation-flow/sequence by topic from the .sequences.json index. Falls back to dynamic find_sequence-style search when the persistent index has no good match.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: WDT.pdf, GPT.pdf, or r01uh1069ej0115-rzg3e-DMA.pdf",
        },
        topic: {
          type: "string",
          description: "Sequence topic, for example initialization, start transfer, stop channel, clear interrupt, reset, IRQ handling, or error handling.",
        },
        register: {
          type: "string",
          description: "Optional register name to bias dynamic fallback, for example DMACm_CHCTRL_n or DMACm_CHSTAT_n.",
        },
        top_k: {
          type: "number",
          description: `Maximum number of sequence evidence chunks. Default ${DEFAULT_SEQUENCE_TOP_K}, max ${MAX_SEQUENCE_TOP_K}.`,
        },
      },
      required: ["filename", "topic"],
      additionalProperties: false,
    },
  },
  {
    name: "find_caution",
    description:
      "Find caution/note/restriction/undefined/prohibited/reserved-bit/clear-flag semantics in a hardware manual. Useful for detecting driver bugs such as writing registers while running, reserved-bit handling errors, or wrong write-1-to-clear/write-0-to-clear behavior.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: WDT.pdf, GPT.pdf, or r01uh1069ej0115-rzg3e-DMA.pdf",
        },
        topic: {
          type: "string",
          description:
            "Caution topic to find, for example reserved bits, write only when stopped, clear flag, write 1 to clear, write 0 to clear, undefined, prohibited, interrupt status, reset, or a register-related condition.",
        },
        register: {
          type: "string",
          description:
            "Optional register name to prioritize context, for example DMACm_CHCTRL_n, DMACm_CHSTAT_n, WDTCR, WDTRR, GTCR, or GTCCR.",
        },
        top_k: {
          type: "number",
          description: `Maximum number of caution candidates. Default ${DEFAULT_CAUTION_TOP_K}, max ${MAX_CAUTION_TOP_K}.`,
        },
      },
      required: ["filename", "topic"],
      additionalProperties: false,
    },
  },
  {
    name: "list_cautions",
    description:
      "List persistent caution/note/restriction candidates from the .cautions.json index. Use this to inspect reserved-bit rules, write timing restrictions, undefined/prohibited behavior, and clear-flag semantics across the manual.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: WDT.pdf, GPT.pdf, or r01uh1069ej0115-rzg3e-DMA.pdf",
        },
        filter: {
          type: "string",
          description:
            "Optional filter, for example reserved, write only when stopped, clear status, write 1 to clear, undefined, prohibited, interrupt, reset, or a register name.",
        },
        register: {
          type: "string",
          description:
            "Optional register name to list only cautions related to that register, for example DMACm_CHCTRL_n or DMACm_CHSTAT_n.",
        },
        type: {
          type: "string",
          description:
            "Optional caution type filter, for example reserved-bit, clear-semantics, write-timing, undefined-invalid, prohibited, note, caution, reset-access.",
        },
        top_k: {
          type: "number",
          description: `Maximum number of cautions to list. Default ${DEFAULT_CAUTION_LIST_TOP_K}, max ${MAX_CAUTION_LIST_TOP_K}.`,
        },
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "get_cautions_for_register",
    description:
      "Get persistent caution/note/restriction candidates for one register from the .cautions.json index. Useful before approving register writes in a Linux driver.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: WDT.pdf, GPT.pdf, or r01uh1069ej0115-rzg3e-DMA.pdf",
        },
        register: {
          type: "string",
          description:
            "Register name, for example DMACm_CHCTRL_n, DMACm_CHSTAT_n, WDTCR, WDTRR, GTCR, or GTCCR.",
        },
        filter: {
          type: "string",
          description:
            "Optional topic filter, for example reserved bits, write only when stopped, clear status flag, write 1 to clear, write 0 to clear, undefined, or reset.",
        },
        top_k: {
          type: "number",
          description: `Maximum number of register-specific cautions. Default ${DEFAULT_CAUTION_LIST_TOP_K}, max ${MAX_CAUTION_LIST_TOP_K}.`,
        },
        include_dynamic_fallback: {
          type: "boolean",
          description: "If true, run the slower dynamic full-index fallback when persistent caution candidates are insufficient. Default false.",
        },
      },
      required: ["filename", "register"],
      additionalProperties: false,
    },
  },
  {
    name: "analyze_module",
    description:
      "Analyze a hardware manual at module level and create a persistent module profile. The profile summarizes likely module type, Linux subsystem, manual structure, register groups, driver-relevant topics, risk areas, and suggested MCP follow-up calls.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: WDT.pdf, GPT.pdf, or r01uh1069ej0115-rzg3e-DMA.pdf",
        },
        module_type: {
          type: "string",
          description:
            "Optional module/subsystem hint, for example dmaengine, watchdog, pwm, timer, gpio, i2c, spi, uart, ethernet, usb, can, pcie, adc, rtc. If omitted, the server infers it from filename/registers/sections.",
        },
        focus: {
          type: "string",
          description:
            "Optional analysis focus, for example minimal driver, interrupt handling, start/stop, status clear, reset, runtime PM, or debugging existing driver.",
        },
        force: {
          type: "boolean",
          description: "Force rebuilding the module profile even if a valid profile already exists.",
        },
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "get_module_profile",
    description:
      "Get the module profile generated by analyze_module. If no valid profile exists, the server builds one automatically. Use this before build_driver_evidence_pack when an AI agent needs module-level understanding.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: WDT.pdf, GPT.pdf, or r01uh1069ej0115-rzg3e-DMA.pdf",
        },
        module_type: {
          type: "string",
          description:
            "Optional module/subsystem hint used if the profile must be rebuilt.",
        },
        focus: {
          type: "string",
          description:
            "Optional focus used if the profile must be rebuilt.",
        },
        refresh: {
          type: "boolean",
          description: "If true, rebuild the profile before returning it.",
        },
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "prepare_driver_task",
    description:
      "Prepare a driver debugging/implementation workflow for an AI agent working in an external VS Code source workspace. This tool does not read source code; it returns mandatory manual-evidence MCP calls, register/bitfield/sequence/caution checks, and source-code review checkpoints for a specific task.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: WDT.pdf, GPT.pdf, or r01uh1069ej0115-rzg3e-DMA.pdf",
        },
        task: {
          type: "string",
          description:
            "Driver task or bug description, for example: debug DMA transfer does not start, add interrupt handling, implement suspend/resume, support watchdog restart, or add PWM capture.",
        },
        module_type: {
          type: "string",
          description:
            "Optional module/subsystem hint, for example dmaengine, watchdog, pwm, timer, gpio, i2c, spi, uart, ethernet, usb, can, pcie, adc, rtc.",
        },
        focus_registers: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional register names already seen in source code or suspected by the user, for example DMACm_CHCTRL_n, DMACm_CHSTAT_n, WDTCR, WDTRR, GTCR.",
        },
        focus_bitfields: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional bit-field names already seen in source code or suspected by the user, for example SETEN, CLREN, TC, ER, CKS, TOPS.",
        },
        top_registers: {
          type: "number",
          description: `Maximum number of task-related registers to include. Default ${DEFAULT_DRIVER_TASK_REGISTERS}, max ${MAX_DRIVER_TASK_REGISTERS}.`,
        },
        mode: {
          type: "string",
          enum: ["fast", "adaptive", "full"],
          description: "Task-plan evidence collection mode. fast/adaptive use persistent indexes and avoid dynamic full-manual fallback. Default adaptive.",
        },
        budget_ms: {
          type: "number",
          description: `Internal time budget in milliseconds. Default ${DEFAULT_DRIVER_TASK_BUDGET_MS}. The server returns partial plans instead of timing out.`,
        },
      },
      required: ["filename", "task"],
      additionalProperties: false,
    },
  },
  {
    name: "list_driver_profiles",
    description:
      "List data-driven driver review profiles from driver_profiles/. Profiles are external JSON files, so new driver/subsystem checklist knowledge can be added without changing MCP code.",
    inputSchema: {
      type: "object",
      properties: {
        create_default: {
          type: "boolean",
          description: "Create default profile JSON files if missing. Default true.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "driver_completeness_checklist",
    description:
      "Build a data-driven Linux driver completeness checklist using external driver_profiles/*.json plus hardware-manual orientation. Use this for review tasks such as Ethernet/stmmac, dmaengine, watchdog, PWM, or an unknown/custom driver. It does not read source code; the VS Code agent should use the checklist to inspect source and then call verify_register_usage for each hardware operation.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example GBETH.pdf, WDT.pdf, GPT.pdf, or r01uh1069ej0115-rzg3e-DMA.pdf.",
        },
        subsystem: {
          type: "string",
          description: "Optional Linux subsystem/profile hint, for example ethernet, dmaengine, watchdog, pwm, gpio, i2c, spi, uart, usb, can, pcie, adc, rtc.",
        },
        driver_family: {
          type: "string",
          description: "Optional driver family hint, for example stmmac, ravb, gpt, rzg2l-gpt, dwmac, custom.",
        },
        profile: {
          type: "string",
          description: "Optional explicit profile name, for example ethernet-stmmac. If omitted, MCP tries subsystem-driver_family, subsystem, then generic.",
        },
        task: {
          type: "string",
          description: "Optional review task/focus, for example Linux MAC driver completeness review, IRQ handling, suspend/resume, reset path, or upstream readiness.",
        },
        create_default: {
          type: "boolean",
          description: "Create default driver_profiles/*.json if missing. Default true.",
        },
        include_visual_evidence: {
          type: "boolean",
          description: "Include persisted visual evidence summary from indexes/<filename>.visual-evidence.json if available. Default true.",
        },
        visual_filter: {
          type: "string",
          description: "Optional filter for visual evidence entries, for example clock reset pinmux interrupt timing.",
        },
        visual_status: {
          type: "string",
          enum: ["all", "verified", "unverified", "needs_verification", "observed", "rejected"],
          description: "Filter visual evidence by verification status. Use verified to include only verified entries. Default all.",
        },
        visual_gate: {
          type: "string",
          enum: ["advisory", "verified_only", "block_unverified"],
          description: "Driver-review gate for visual evidence. advisory warns only; verified_only includes verified entries and reports unverified matches as blockers; block_unverified keeps all entries but treats unverified matches as blockers. Default advisory.",
        },
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "compare_driver_requirements",
    description:
      "Compare source-code features observed by the VS Code AI agent against the data-driven driver completeness checklist/profile. The MCP server does not read source code; pass implemented_features/source_observations/register_operations extracted by the agent. Returns implemented/missing/unclear matrix, manual verification gaps, and suggested verify_register_usage calls.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename, for example GBETH.pdf, WDT.pdf, GPT.pdf, or r01uh1069ej0115-rzg3e-DMA.pdf." },
        subsystem: { type: "string", description: "Optional Linux subsystem/profile hint, for example ethernet, dmaengine, watchdog, pwm, gpio, i2c, spi, uart, usb, can, pcie, adc, rtc." },
        driver_family: { type: "string", description: "Optional driver family hint, for example stmmac, ravb, gpt, rzg2l-gpt, dwmac, custom." },
        profile: { type: "string", description: "Optional explicit driver profile name, for example ethernet-stmmac." },
        task: { type: "string", description: "Optional review task/focus, for example Linux MAC driver completeness review, IRQ handling, suspend/resume, reset path, or upstream readiness." },
        source_files: { type: "array", items: { type: "string" }, description: "Source files inspected by the VS Code AI agent." },
        source_summary: { type: "string", description: "Optional concise source-code summary produced by the AI agent after reading the workspace." },
        implemented_features: { type: "array", items: { type: "string" }, description: "Feature/checklist items observed in source code, for example clocks enabled, reset deasserted, request IRQ, parse phy-mode, register stmmac platform data." },
        missing_features: { type: "array", items: { type: "string" }, description: "Feature/checklist items explicitly observed as missing or unsupported in source code." },
        source_observations: { type: "array", items: { type: "string" }, description: "Additional source-code observations, uncertainties, TODOs, or notable implementation details extracted by the agent." },
        register_operations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              register: { type: "string" },
              operation: { type: "string" },
              bitfields: { type: "array", items: { type: "string" } },
              access_type: { type: "string" },
              intent: { type: "string" },
              source_snippet: { type: "string" }
            },
            additionalProperties: true
          },
          description: "Optional register operations observed in source. These are not verified automatically; output will suggest verify_register_usage calls."
        },
        create_default: { type: "boolean", description: "Create default driver_profiles/*.json if missing. Default true." },
        include_visual_evidence: { type: "boolean", description: "Include persisted visual evidence when comparing source coverage. Default true." },
        visual_filter: { type: "string", description: "Optional filter for visual evidence entries relevant to the source review task." },
        visual_status: { type: "string", enum: ["all", "verified", "unverified", "needs_verification", "observed", "rejected"], description: "Filter persisted visual evidence by verification status. Default all." },
        visual_gate: { type: "string", enum: ["advisory", "verified_only", "block_unverified"], description: "If verified_only or block_unverified, matching unverified visual evidence becomes needsVerification/blocker. Default advisory." }
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "source_review_prompt_pack",
    description:
      "Generate a structured prompt/workflow pack for a VS Code AI agent that must review or implement a Linux driver using source code in the workspace and manual evidence from this MCP server. This avoids long ad-hoc prompts: it tells the agent which source facts to extract, which MCP tools to call, and how to produce implemented/missing/unclear conclusions.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename, for example GBETH.pdf, WDT.pdf, GPT.pdf, or r01uh1069ej0115-rzg3e-DMA.pdf." },
        subsystem: { type: "string", description: "Optional Linux subsystem/profile hint, for example ethernet, dmaengine, watchdog, pwm, gpio, i2c, spi, uart, usb, can, pcie, adc, rtc." },
        driver_family: { type: "string", description: "Optional driver family hint, for example stmmac, ravb, gpt, rzg2l-gpt, dwmac, custom." },
        profile: { type: "string", description: "Optional explicit driver profile name, for example ethernet-stmmac." },
        task: { type: "string", description: "Driver task/review goal, for example evaluate driver completeness, debug IRQ handling, implement reset path, or add suspend/resume." },
        source_files: { type: "array", items: { type: "string" }, description: "Optional source files that the VS Code AI agent should inspect first. MCP does not read these files." },
        review_depth: { type: "string", enum: ["quick", "standard", "deep"], description: "Prompt strictness/depth. quick uses a short workflow; standard is default; deep requires exhaustive register-operation extraction." },
        output_format: { type: "string", enum: ["report", "checklist", "patch_plan", "debug_plan"], description: "Expected final answer style for the VS Code agent. Default report." },
        create_default: { type: "boolean", description: "Create default driver_profiles/*.json if missing. Default true." },
        include_visual_evidence: { type: "boolean", description: "Include persisted visual evidence and visual-review workflow reminders in the generated prompt. Default true." },
        visual_filter: { type: "string", description: "Optional filter for visual evidence entries relevant to the prompt task." },
        visual_status: { type: "string", enum: ["all", "verified", "unverified", "needs_verification", "observed", "rejected"], description: "Filter persisted visual evidence by verification status. Default all." },
        visual_gate: { type: "string", enum: ["advisory", "verified_only", "block_unverified"], description: "If verified_only or block_unverified, the generated prompt treats matching unverified visual evidence as blockers. Default advisory." }
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "verify_register_usage",
    description:
      "Verify a source-code register operation against the hardware manual. The AI agent should call this after reading source code in VS Code and identifying a writel/readl/regmap operation. This tool checks register existence, bit-field evidence, sequence/order hints, caution/restriction rules, reserved-bit/clear semantics risks, and returns an evidence/inference/needsVerification contract.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example GBETH.pdf, WDT.pdf, GPT.pdf, or r01uh1069ej0115-rzg3e-DMA.pdf.",
        },
        register: {
          type: "string",
          description: "Register name or source-code register macro, for example DMACm_CHCTRL_n, WDTCR, GBETH_MACCR, MACCR.",
        },
        operation: {
          type: "string",
          description: "Source-code operation or driver intent, for example writel(SETEN), read-modify-write enable TX/RX, clear interrupt status, poll reset done.",
        },
        bitfields: {
          type: "array",
          items: { type: "string" },
          description: "Optional bit-field names/macro symbols seen in source code, for example SETEN, TE, RE, TC, ER.",
        },
        access_type: {
          type: "string",
          enum: ["auto", "read", "write", "raw_write", "read_modify_write", "set_bits", "clear_bits", "write_one_to_clear", "write_zero_to_clear", "poll", "reset"],
          description: "Optional source-code access pattern. Use raw_write for writel(value, reg), read_modify_write for readl/modify/writel, poll for read-poll loops.",
        },
        intent: {
          type: "string",
          enum: ["auto", "init", "start", "stop", "clear", "irq", "reset", "error", "status", "configure", "read", "write"],
          description: "Optional hardware intent. auto derives from operation/access_type.",
        },
        source_snippet: {
          type: "string",
          description: "Optional short source-code snippet or code summary. The MCP server does not read the repo; the AI agent may pass the relevant snippet here.",
        },
        top_k: {
          type: "number",
          description: "Maximum candidates for internal verification searches. Default 8.",
        },
        include_hybrid: {
          type: "boolean",
          description: "If true, include slower hybrid fallback search evidence. Default false when persistent indexes are available.",
        },
        budget_ms: {
          type: "number",
          description: `Internal time budget in milliseconds. Default ${DEFAULT_DRIVER_TASK_BUDGET_MS}. Expensive fallback phases are skipped when budget is low.`,
        },
      },
      required: ["filename", "register", "operation"],
      additionalProperties: false,
    },
  },
  {
    name: "build_driver_evidence_pack",
    description:
      "Build a driver-oriented evidence pack from the hardware manual. It combines module identity, likely Linux subsystem, register groups, key registers, bit-field candidates, operation sequence candidates, cautions/restrictions, and follow-up MCP calls for AI agents working in an external source workspace.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: WDT.pdf, GPT.pdf, or r01uh1069ej0115-rzg3e-DMA.pdf",
        },
        module_type: {
          type: "string",
          description:
            "Optional module/subsystem hint, for example dmaengine, watchdog, pwm, timer, gpio, i2c, spi, uart, ethernet, usb, can, pcie, adc, rtc. If omitted, the server infers it from filename/registers/sections.",
        },
        focus: {
          type: "string",
          description:
            "Optional driver focus, for example minimal driver, interrupt handling, start/stop, reset, status clear, runtime PM, or debugging existing driver.",
        },
        mode: {
          type: "string",
          enum: ["adaptive", "fast", "full"],
          description:
            "Build mode. adaptive is the default: fast-first, budget-aware, returns partial results instead of timing out. fast uses persistent indexes only. full enables deeper dynamic searches but can be slow.",
        },
        budget_ms: {
          type: "number",
          description: `Internal time budget in milliseconds for this tool. Default ${DEFAULT_DRIVER_PACK_BUDGET_MS}, min ${MIN_DRIVER_PACK_BUDGET_MS}, max ${MAX_DRIVER_PACK_BUDGET_MS}. The server returns partial results before this budget is exhausted.`,
        },
        top_registers: {
          type: "number",
          description: `Maximum number of registers to include in the register map summary. Default ${DEFAULT_DRIVER_PACK_REGISTERS}, max ${MAX_DRIVER_PACK_REGISTERS}.`,
        },
        top_summaries: {
          type: "number",
          description: `Maximum number of key register summaries to include. Default ${DEFAULT_DRIVER_PACK_SUMMARIES}, max ${MAX_DRIVER_PACK_SUMMARIES}.`,
        },
        include_visual_evidence: {
          type: "boolean",
          description: "Include persisted visual evidence relevant to the driver focus if available. Default true.",
        },
        visual_filter: {
          type: "string",
          description: "Optional filter for visual evidence entries, for example clock reset pinmux interrupt timing.",
        },
        visual_status: {
          type: "string",
          enum: ["all", "verified", "unverified", "needs_verification", "observed", "rejected"],
          description: "Filter visual evidence by verification status. Use verified to include only verified entries. Default all.",
        },
        visual_gate: {
          type: "string",
          enum: ["advisory", "verified_only", "block_unverified"],
          description: "Driver-review gate for visual evidence. advisory warns only; verified_only includes verified entries and reports unverified matches as blockers; block_unverified keeps all entries but treats unverified matches as blockers. Default advisory.",
        },
        visual_top_k: {
          type: "number",
          description: "Maximum visual evidence entries to include. Default 8, max 30.",
        },
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "find_section",
    description:
      "Find section headings/topics using the section index first, then fall back to chunk search. Examples: Register Description, DMA initialization, Timestamp, MDIO, Clock Setting, Interrupt Source.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "PDF filename, for example: GBETH.pdf",
        },
        section: {
          type: "string",
          description:
            "Section title, heading fragment, or topic to find.",
        },
        top_k: {
          type: "number",
          description: `Maximum number of results. Default ${DEFAULT_TOP_K}, max ${MAX_TOP_K}.`,
        },
      },
      required: ["filename", "section"],
      additionalProperties: false,
    },
  },
];

export const HIDDEN_TOOL_DEFINITIONS = Object.freeze([]);
export const PUBLIC_TOOL_DEFINITIONS = Object.freeze(ALL_TOOL_DEFINITIONS);
export const PUBLIC_TOOL_NAMES = Object.freeze(PUBLIC_TOOL_DEFINITIONS.map((tool) => tool.name));
