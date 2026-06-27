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
  DEFAULT_RENDER_DPI,
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
  MAX_RENDER_DPI,
  MAX_SEQUENCE_LIST_TOP_K,
  MAX_SEQUENCE_TOP_K,
  MAX_TABLE_PAGE_RANGE,
  MAX_TOP_K,
  MIN_DRIVER_PACK_BUDGET_MS,
} from "../core/runtime-constants.js";
import { DEFAULT_GOLDEN_PROFILE } from "../eval/golden.js";

// Public MCP definitions are intentionally data-only so health checks can import
// the catalog without starting the server or loading a PDF.
export const PUBLIC_TOOL_DEFINITIONS = Object.freeze([
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
        step40_action: {
          type: "string",
          enum: ["health", "ping", "compat_report", "index_status_lite", "ocr_health", "rebuild_artifact", "job_status", "list_jobs", "cancel_job", "cleanup_jobs", "cache_status", "cleanup_cache", "figure_cache_status", "cleanup_figure_cache"],
          description: "Step 40 control-plane action routed through this known-good tool. Use compat_report to see direct-tool compatibility status. Default health preserves the original eval_health_check behavior."
        },
        filename: { type: "string", description: "PDF filename for step40_action=index_status_lite, rebuild_artifact, cache_status, cleanup_cache, figure_cache_status, or cleanup_figure_cache." },
        artifact: { type: "string", description: "Artifact for step40_action=rebuild_artifact, for example pages, tables, registers, bitfields, sequences, cautions, figures, figure_ocr, or chunk-index." },
        job_id: { type: "string", description: "Job ID for step40_action=job_status or cancel_job." },
        reason: { type: "string", description: "Optional cancellation reason for step40_action=cancel_job." },
        statuses: { type: "array", items: { type: "string" }, description: "Statuses for step40_action=cleanup_jobs." },
        kind: { type: "string", description: "Cache kind for step40_action=cache_status or cleanup_cache, for example all, figure-images, figure-ocr, or page-context." },
        older_than_hours: { type: "number", description: "Age filter for step40_action=cleanup_jobs, cleanup_cache, or cleanup_figure_cache." },
        max_bytes: { type: "number", description: "Cache size target for step40_action=cleanup_cache or cleanup_figure_cache; oldest matching files are selected until total cache bytes are under this value." },
        stale_by_source: { type: "boolean", description: "For cleanup_cache/cleanup_figure_cache with filename, select cache files whose stored PDF source fingerprint no longer matches the current PDF." },
        confirm: { type: "boolean", description: "Required true for step40_action=cleanup_cache or cleanup_figure_cache to delete files. Without confirm, cleanup runs as dry-run." },
        include_running: { type: "boolean", description: "Allow cleanup of queued/running jobs when step40_action=cleanup_jobs. Default false." },
        json: { type: "boolean", description: "Return raw JSON for status-oriented step40 actions. Default false." },
        force_lock: { type: "boolean", description: "Remove stale lock before rebuild_artifact. Default false." },
        force: { type: "boolean", description: "Force rebuild for cacheable artifacts such as figure_ocr. Default false." },
        chunk_size: { type: "number", description: "Chunk size for rebuild_artifact." },
        chunk_overlap: { type: "number", description: "Chunk overlap for rebuild_artifact." },
        allow_full_rebuild: { type: "boolean", description: "Allow dependent full rebuild when requested artifact needs missing base artifacts. Default true." },
        cascade_dependents: { type: "boolean", description: "Rebuild stale dependent artifacts after the selected artifact. Default false." }
      },
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
      "Start PDF indexing as a background job. Use this for large manuals (500/800/1000+ pages) to avoid MCP client request timeout. Poll job_status until status is done or failed.",
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
      "Get status/progress for a background job started by start_index_pdf or auto-background index_pdf.",
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
      "List recent background jobs and their status.",
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
      "Search keywords, phrases, register names, bit names, or natural-language questions inside an indexed PDF. Returns page numbers and chunk IDs.",
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
      "Search an indexed PDF without embeddings by combining exact phrase, keyword/BM25-like scoring, fuzzy token matching, intent expansion, and boosts from register/section/sequence/caution indexes. Use this for natural-language questions when Ollama/embedding search is unavailable.",
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
      "Read extractable text from a specific page range in a local PDF. Use after search_pdf/find_register/find_section to inspect relevant pages.",
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
      "Read the full text of a specific indexed chunk by chunk ID, for example GBETH.pdf:p17:c0.",
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
      "Check which optional external PDF page renderers are available for Step 31B visual review. Supported renderers: pdftoppm/Poppler, mutool/MuPDF, magick/ImageMagick. If none are available, render_pdf_page can still create a dependency-free text-layer SVG fallback.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "render_pdf_page",
    description:
      "Step 31B: render one selected PDF page to a local PNG/JPG/SVG file for visual review. Uses optional external renderers when available; can fall back to a text-layer SVG that preserves PDF text coordinates but does not show vector/raster graphics.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename, for example GBETH.pdf." },
        page: { type: "number", description: "1-based page number to render." },
        dpi: { type: "number", description: `Render DPI. Default ${DEFAULT_RENDER_DPI}, max ${MAX_RENDER_DPI}.` },
        format: { type: "string", enum: ["png", "jpg", "svg", "text_svg"], description: "Output format. png/jpg require an external renderer. svg uses mutool when available; text_svg is a dependency-free text-layer fallback." },
        renderer: { type: "string", enum: ["auto", "pdftoppm", "mutool", "magick", "text_svg"], description: "Renderer selection. Default auto." },
        fallback_text_svg: { type: "boolean", description: "If true, create a text-layer SVG fallback when external image rendering is unavailable. Default true." }
      },
      required: ["filename", "page"],
      additionalProperties: false,
    },
  },
  {
    name: "visual_review_handoff_pack",
    description:
      "Step 32: build a workflow/prompt pack for visual manual content such as timing diagrams, clock trees, block diagrams, reset flows, interrupt routing, and pinmux figures. It combines figure search/context, page/render/crop commands, layout-table checks, and an extraction schema so the VS Code/AI agent can perform a disciplined visual review instead of guessing from text-only extraction.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename, for example GBETH.pdf or r01uh1039ej0120-rzt2h_n2h-GPIO.pdf." },
        query: { type: "string", description: "Visual target query, for example clock tree, read timing diagram, Safety I/O port setting flow, interrupt route, reset sequence." },
        figure_id: { type: "string", description: "Optional Figure ID from list_figures/find_figure, for example fig-p113-17.3." },
        page: { type: "number", description: "Optional 1-based page number if the visual target page is already known." },
        kind: { type: "string", description: "Optional figure kind filter, for example timing-diagram, clock-tree, block-diagram, flow-sequence, pinmux, interrupt, reset-power." },
        diagram_type: { type: "string", enum: ["auto", "clock_tree", "timing", "block_diagram", "reset_flow", "interrupt_route", "pinmux", "sequence", "table", "other"], description: "Expected visual content type. Default auto." },
        task: { type: "string", description: "Optional review task, for example verify reset sequence, inspect timing diagram, understand clock tree, or review pinmux flow." },
        source_files: { type: "array", items: { type: "string" }, description: "Optional source/DTS files the VS Code agent should inspect alongside the visual manual evidence." },
        review_depth: { type: "string", enum: ["quick", "standard", "deep"], description: "How strict the visual review workflow should be. Default standard." },
        output_format: { type: "string", enum: ["report", "debug_plan", "patch_plan", "checklist"], description: "Expected final response style from the agent. Default report." },
        top_k: { type: "number", description: "Number of figure candidates to include when searching by query. Default 6." },
        include_layout_tables: { type: "boolean", description: "Include layout-table extraction commands and context when useful. Default true." },
        include_render_commands: { type: "boolean", description: "Include render_pdf_page/render_figure_region commands. Default true." }
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "add_visual_evidence",
    description:
      "Step 33: persist structured observations made from rendered manual figures/diagrams/tables. Use this after visual_review_handoff_pack + render_figure_region/render_pdf_region when the AI agent or user has inspected a PNG/JPG/SVG and wants to store direct visual observations, extracted steps/edges/clocks/pins, uncertainty, and source-code implications as reusable evidence.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename." },
        figure_id: { type: "string", description: "Optional Figure/Table ID from find_figure/list_figures." },
        page: { type: "number", description: "Optional 1-based page number for the visual evidence." },
        query: { type: "string", description: "Optional visual target query/task." },
        diagram_type: { type: "string", enum: ["auto", "clock_tree", "timing", "block_diagram", "reset_flow", "interrupt_route", "pinmux", "sequence", "table", "other"], description: "Visual evidence type. Default auto." },
        rendered_path: { type: "string", description: "Path returned by render_pdf_page/render_figure_region/render_pdf_region." },
        rendered_region: { type: "object", description: "Optional crop/region metadata such as x/y/width/height/unit/zoom/dpi.", additionalProperties: true },
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
    name: "render_pdf_region",
    description:
      "Step 31C: render one PDF page, then crop a selected rectangular region and optionally zoom it. Use this after render_pdf_page/full-page review when a clock tree, timing diagram, block diagram, table, or waveform is too small to inspect on the full page. Coordinates may be percentages of the rendered page or pixels.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename, for example GBETH.pdf." },
        page: { type: "number", description: "1-based page number." },
        x: { type: "number", description: "Left coordinate of crop region. Default 0." },
        y: { type: "number", description: "Top coordinate of crop region. Default 0." },
        width: { type: "number", description: "Crop width. If unit=percent, use 0-100. Default 100 for percent." },
        height: { type: "number", description: "Crop height. If unit=percent, use 0-100. Default 100 for percent." },
        unit: { type: "string", enum: ["percent", "px"], description: "Coordinate unit. percent uses rendered page size; px uses rendered image pixels. Default percent." },
        margin: { type: "number", description: "Extra margin around crop. In percent when unit=percent; in pixels when unit=px. Default 0." },
        zoom: { type: "number", description: "Optional zoom factor after crop. 1.0 means no resize. Default 1.0, max 4.0." },
        dpi: { type: "number", description: `Render DPI before cropping. Default ${DEFAULT_RENDER_DPI}, max ${MAX_RENDER_DPI}.` },
        format: { type: "string", enum: ["png", "jpg"], description: "Output image format for the cropped region. Default png." },
        renderer: { type: "string", enum: ["auto", "pdftoppm", "mutool", "magick"], description: "Renderer used for the initial full-page image. Default auto." },
        fallback_full_page: { type: "boolean", description: "If crop fails because ImageMagick is unavailable, return the full-page render instead of failing. Default false." }
      },
      required: ["filename", "page"],
      additionalProperties: false,
    },
  },
  {
    name: "render_figure_region",
    description:
      "Step 31C: locate a figure/table/diagram by figure_id or page/query, estimate a crop region around/above/below the caption, render the page, crop the region, and optionally zoom it. Use for timing diagrams, clock trees, reset flows, and block diagrams after find_figure/get_figure_context.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename, for example GBETH.pdf." },
        figure_id: { type: "string", description: "Figure ID from list_figures/find_figure, for example fig-p113-17.3." },
        page: { type: "number", description: "Fallback 1-based page number if figure_id is not provided." },
        query: { type: "string", description: "Optional query to select the best figure on the page or in the index." },
        region: { type: "string", enum: ["auto", "above_caption", "below_caption", "around_caption", "top_half", "middle", "bottom_half", "full_width"], description: "Automatic crop strategy. Default auto. For most Renesas figures with captions below the drawing, above_caption is useful." },
        x: { type: "number", description: "Optional explicit left coordinate. If provided with width/height, overrides automatic x." },
        y: { type: "number", description: "Optional explicit top coordinate. If provided with width/height, overrides automatic y." },
        width: { type: "number", description: "Optional explicit crop width. Used with x/y/height." },
        height: { type: "number", description: "Optional explicit crop height. Used with x/y/width." },
        unit: { type: "string", enum: ["percent", "px"], description: "Coordinate unit for explicit x/y/width/height. Default percent." },
        margin: { type: "number", description: "Extra crop margin. Default 3 percent for auto regions." },
        zoom: { type: "number", description: "Optional zoom factor after crop. Default 1.5, max 4.0." },
        dpi: { type: "number", description: `Render DPI before cropping. Default ${DEFAULT_RENDER_DPI}, max ${MAX_RENDER_DPI}.` },
        format: { type: "string", enum: ["png", "jpg"], description: "Output image format. Default png." },
        renderer: { type: "string", enum: ["auto", "pdftoppm", "mutool", "magick"], description: "Renderer used for the initial full-page image. Default auto." },
        include_context: { type: "boolean", description: "Include figure caption/context in output. Default true." }
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "render_figure_page",
    description:
      "Step 31B: locate a figure/table/diagram page using figure_id or page/query, then render that page for visual review. Use after find_figure/list_figures/get_figure_context.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename, for example GBETH.pdf." },
        figure_id: { type: "string", description: "Figure ID from list_figures/find_figure, for example fig-p113-17.3." },
        page: { type: "number", description: "Fallback 1-based page number if figure_id is not provided." },
        query: { type: "string", description: "Optional query to select the best figure on the page or in the index." },
        dpi: { type: "number", description: `Render DPI. Default ${DEFAULT_RENDER_DPI}, max ${MAX_RENDER_DPI}.` },
        format: { type: "string", enum: ["png", "jpg", "svg", "text_svg"], description: "Output format. Default png." },
        renderer: { type: "string", enum: ["auto", "pdftoppm", "mutool", "magick", "text_svg"], description: "Renderer selection. Default auto." },
        include_context: { type: "boolean", description: "Include figure caption/context in the output. Default true." }
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "render_figure",
    description:
      "Render an on-demand PNG crop for a figure or explicit PDF page bbox using PyMuPDF. Use this when an AI agent needs the actual figure image for OCR/visual inspection without rebuilding full-manual OCR.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename, for example GBETH.pdf." },
        figure_id: { type: "string", description: "Optional figure ID from list_figures/find_figure, for example p0113_f001 or fig-p113-1." },
        page: { type: "number", description: "1-based page number. Required when figure_id is not provided." },
        bbox: {
          type: "array",
          items: { type: "number" },
          minItems: 4,
          maxItems: 4,
          description: "PDF point bbox [x0,y0,x1,y1]. Required when figure_id is not provided."
        },
        scale: { type: "number", description: "PyMuPDF render scale. Default 2.0." },
        force: { type: "boolean", description: "If true, bypass the cached PNG render. Default false." }
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "ocr_figure",
    description:
      "Run optional lazy OCR or local figure parsing over an on-demand rendered hardware-manual figure crop. Text mode preserves legacy PaddleOCR label extraction; structure mode uses document-structure parsing when installed; VL mode is optional and returns warnings when unavailable.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename, for example GBETH.pdf." },
        figure_id: { type: "string", description: "Optional figure ID from list_figures/find_figure." },
        page: { type: "number", description: "1-based page number. Required with bbox when figure_id is not provided." },
        bbox: {
          type: "array",
          items: { type: "number" },
          minItems: 4,
          maxItems: 4,
          description: "PDF point bbox [x0,y0,x1,y1]. Required with page when figure_id is not provided."
        },
        mode: {
          type: "string",
          enum: ["text", "structure", "vl", "auto"],
          description: "Figure parsing mode. text is the backward-compatible default for OCR labels; structure uses local document-structure parsing for complex diagrams/tables when installed; vl uses optional local visual-language parsing and treats graph edges as unverified; auto prefers structure when available and otherwise falls back to text."
        },
        engine: { type: "string", enum: ["auto", "paddleocr", "none"], description: "OCR engine. auto uses PaddleOCR when installed; none renders but skips OCR." },
        force: { type: "boolean", description: "If true, bypass render/OCR caches. Default false." }
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "inspect_figure",
    description:
      "Build a hardware-manual figure evidence pack with caption/provenance, OCR or local parser labels, optional surrounding text, normalized semantic evidence, and conservative warnings without inventing arrows/connectors.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename, for example GBETH.pdf." },
        figure_id: { type: "string", description: "Optional figure ID from list_figures/find_figure." },
        page: { type: "number", description: "1-based page number. Required with bbox when figure_id is not provided." },
        bbox: {
          type: "array",
          items: { type: "number" },
          minItems: 4,
          maxItems: 4,
          description: "PDF point bbox [x0,y0,x1,y1]. Required with page when figure_id is not provided."
        },
        mode: { type: "string", enum: ["auto", "block_diagram", "sequence", "timing", "flowchart", "register_diagram"], description: "Expected figure type. Default auto." },
        parser: {
          type: "string",
          enum: ["safe", "ocr", "structure", "vl", "auto"],
          description: "Parser strategy. safe preserves conservative legacy OCR/context behavior; ocr uses text labels only; structure uses local document-structure parsing when installed; vl uses optional local visual-language parsing with unverified edges; auto prefers structure and only considers VL when RENESAS_MCP_AUTO_VL=1."
        },
        include_context: { type: "boolean", description: "If true, include surrounding page text. Default true." },
        context_pages: { type: "number", description: "Number of pages before/after the figure page to include. Default 0, max 2." },
        force: { type: "boolean", description: "If true, bypass render/OCR caches. Default false." }
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "extract_layout_tables_from_pages",
    description:
      "Step 30A/30B: extract layout-aware table candidates from selected PDF pages. Reconstructs rows/columns from PDF text item coordinates, infers semantic column roles such as bit/register/offset/access/reset/description and pin/function/signal/port/peripheral, and marks ambiguous rows. Use this when register, bit-field, or pinmux tables are misread by plain text extraction.",
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
    name: "build_figures_index",
    description:
      "Step 31A: build or rebuild a persistent .figures.json index from page text/captions. This is a lightweight visual-context index for Figure/Table/Clock tree/Timing/Block diagram captions and nearby text. It does not OCR images; it indexes captions and surrounding text so the agent can locate pages that may require visual inspection.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename, for example GPIO.pdf or hardware manual PDF." }
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "list_figures",
    description:
      "Step 31A: list Figure/Table/diagram/caption candidates from the persistent .figures.json index. Use for discovering timing diagrams, clock trees, block diagrams, flowcharts, and key table captions before reading pages visually/textually.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename." },
        filter: { type: "string", description: "Optional substring filter across caption/context, for example clock tree, timing, reset, pin function, interrupt." },
        kind: { type: "string", description: "Optional kind filter: figure, table, clock-tree, timing-diagram, block-diagram, flow-sequence, pinmux, register-table, interrupt, reset, unknown." },
        top_k: { type: "number", description: `Maximum candidates to list. Default ${DEFAULT_FIGURE_TOP_K}, max ${MAX_FIGURE_TOP_K}.` }
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
  {
    name: "find_figure",
    description:
      "Step 31A: search figure/table/diagram captions and nearby context. Use this to locate clock trees, timing diagrams, block diagrams, reset flows, interrupt routes, or pinmux overview figures before calling get_figure_context/read_pdf_pages.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename." },
        query: { type: "string", description: "Search query, for example clock tree, read write timing, reset sequence, block diagram, interrupt route." },
        kind: { type: "string", description: "Optional kind filter, for example timing-diagram, clock-tree, block-diagram, flow-sequence, table." },
        top_k: { type: "number", description: `Maximum candidates. Default ${DEFAULT_FIGURE_TOP_K}, max ${MAX_FIGURE_TOP_K}.` }
      },
      required: ["filename", "query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_figure_context",
    description:
      "Step 31A: return caption, nearby text, headings, candidate layout tables, and suggested follow-up reads for a figure/table/diagram. Use figure_id from list_figures/find_figure or pass a page/query. This is not OCR/vision; it gives the agent the best text/layout context around a visual object.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "PDF filename." },
        figure_id: { type: "string", description: "Figure ID returned by list_figures/find_figure, for example fig-p113-1." },
        page: { type: "number", description: "Optional page number if figure_id is not known." },
        query: { type: "string", description: "Optional query/caption filter if page contains multiple figures/tables." },
        include_pages: { type: "number", description: "Number of surrounding pages to include on each side. Default 0, max 2." },
        include_layout_tables: { type: "boolean", description: "If true, include layout-aware table summaries from the target page range. Default false." }
      },
      required: ["filename"],
      additionalProperties: false,
    },
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
]);

export const PUBLIC_TOOL_NAMES = Object.freeze(PUBLIC_TOOL_DEFINITIONS.map((tool) => tool.name));
