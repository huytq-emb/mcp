export const CONTROL_TOOL_DEFINITIONS = Object.freeze([
  {
    "name": "list_pdfs",
    "description": "List all PDF files available in the local documents folder.",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  {
    "name": "pdf_info",
    "description": "Get file metadata, PDF page count, and index status for a local PDF.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename, for example: GBETH.pdf"
        }
      },
      "required": [
        "filename"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "doctor",
    "description": "Check MCP server health for one PDF or all PDFs without rebuilding indexes. Validates PDF readability, core indexes, persistent manual-intelligence artifacts, stale/broken JSON, count mismatches, and optional generated reports.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "Optional PDF filename. If omitted, doctor checks all PDFs in the documents folder."
        },
        "strict": {
          "type": "boolean",
          "description": "If true, optional artifacts such as module profile/driver pack/task plan are reported more aggressively. Default false."
        },
        "write_report": {
          "type": "boolean",
          "description": "If true, save a .doctor.txt report in the indexes folder. Default true for single-file checks."
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "index_pdf",
    "description": "Build or rebuild searchable text, page cache, section/register/bitfield/sequence/caution indexes for a local PDF. Uses an index build lock and atomic writes to avoid corrupted JSON artifacts.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename, for example: GBETH.pdf"
        },
        "force": {
          "type": "boolean",
          "description": "Force rebuilding the index even if a valid index already exists."
        },
        "force_lock": {
          "type": "boolean",
          "description": "If true, remove an existing index build lock before rebuilding. Use only if you are sure no other index_pdf is running for this PDF."
        },
        "mode": {
          "type": "string",
          "enum": [
            "auto",
            "foreground",
            "background"
          ],
          "description": "Indexing execution mode. auto starts a background job for large PDFs or rebuilds; foreground blocks the MCP request and may timeout on large manuals; background always returns a job ID immediately. Default auto."
        },
        "chunk_size": {
          "type": "number",
          "description": "Chunk size in characters. Default 2600."
        },
        "chunk_overlap": {
          "type": "number",
          "description": "Chunk overlap in characters. Default 450."
        }
      },
      "required": [
        "filename"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "mcp_control",
    "description": "Control-plane utility for MCP server ping, lightweight index status, detached artifact rebuild jobs, job polling/cancel/cleanup, and cache status/cleanup. Use this instead of routing control actions through eval_health_check.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "enum": [
            "ping",
            "compat_report",
            "index_status_lite",
            "ocr_health",
            "rebuild_artifact",
            "job_status",
            "list_jobs",
            "cancel_job",
            "cleanup_jobs",
            "cache_status",
            "cleanup_cache",
            "figure_cache_status",
            "cleanup_figure_cache"
          ]
        },
        "filename": {
          "type": "string"
        },
        "artifact": {
          "type": "string"
        },
        "job_id": {
          "type": "string"
        },
        "reason": {
          "type": "string"
        },
        "statuses": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "kind": {
          "type": "string"
        },
        "older_than_hours": {
          "type": "number"
        },
        "max_bytes": {
          "type": "number"
        },
        "stale_by_source": {
          "type": "boolean"
        },
        "confirm": {
          "type": "boolean"
        },
        "include_running": {
          "type": "boolean"
        },
        "json": {
          "type": "boolean"
        },
        "force_lock": {
          "type": "boolean"
        },
        "force": {
          "type": "boolean"
        },
        "chunk_size": {
          "type": "number"
        },
        "chunk_overlap": {
          "type": "number"
        },
        "allow_full_rebuild": {
          "type": "boolean"
        },
        "cascade_dependents": {
          "type": "boolean"
        }
      },
      "required": [
        "action"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "plan_manual_workflow",
    "description": "Route a driver/manual task to the correct MCP workflow. Use this first when an AI agent is unsure which PDF/manual tools to call for driver implementation, debug, review, pinmux/table extraction, register verification, or eval hardening.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "Optional PDF filename. If provided, the plan includes file health and concrete tool calls."
        },
        "task": {
          "type": "string",
          "description": "Driver/manual task, bug description, or review goal."
        },
        "module_type": {
          "type": "string",
          "description": "Optional subsystem/module hint, for example ethernet, dmaengine, watchdog, pwm, gpio, pinctrl, i2c, spi, usb, can, pcie, rtc."
        },
        "driver_family": {
          "type": "string",
          "description": "Optional driver family hint, for example stmmac, ravb, rzg2l-gpt, riic, rspi, custom."
        },
        "source_files": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Source files that the VS Code agent will inspect. MCP does not read them."
        },
        "focus_registers": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Registers already suspected or seen in source."
        },
        "focus_bitfields": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Bitfields already suspected or seen in source."
        },
        "depth": {
          "type": "string",
          "enum": [
            "quick",
            "standard",
            "deep"
          ],
          "description": "Workflow strictness. Default standard."
        },
        "output_format": {
          "type": "string",
          "enum": [
            "report",
            "checklist",
            "patch_plan",
            "debug_plan"
          ],
          "description": "Target final output style for the agent. Default report."
        },
        "include_eval": {
          "type": "boolean",
          "description": "Include eval/static-hardening steps. Default true."
        },
        "include_visual": {
          "type": "boolean",
          "description": "Include visual/table evidence steps when relevant. Default true."
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "validate_index",
    "description": "Validate index artifacts for a PDF without rebuilding. This is a focused alias of doctor for checking whether indexes are missing, stale, incompatible, broken, or internally inconsistent.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename, for example: GBETH.pdf. If omitted, validates all PDFs."
        },
        "strict": {
          "type": "boolean",
          "description": "If true, include optional artifacts in the final health decision. Default false."
        },
        "write_report": {
          "type": "boolean",
          "description": "If true, save a .doctor.txt report in the indexes folder. Default false."
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "start_index_pdf",
    "description": "Hidden compatibility helper for background PDF indexing. Prefer index_pdf(filename=\"...\", mode=\"background\") and poll with mcp_control(action=\"job_status\", job_id=\"...\").",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename, for example GBETH.pdf"
        },
        "force": {
          "type": "boolean",
          "description": "Force rebuilding the index even if a valid index exists. Default false."
        },
        "force_lock": {
          "type": "boolean",
          "description": "Remove stale/existing index lock before rebuilding. Use only when safe. Default false."
        },
        "chunk_size": {
          "type": "number",
          "description": "Chunk size in characters. Default 2600."
        },
        "chunk_overlap": {
          "type": "number",
          "description": "Chunk overlap in characters. Default 450."
        }
      },
      "required": [
        "filename"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "job_status",
    "description": "Hidden compatibility helper for job polling; preferred control-plane form is mcp_control(action=\"job_status\", job_id=\"...\").",
    "inputSchema": {
      "type": "object",
      "properties": {
        "job_id": {
          "type": "string",
          "description": "Job ID returned by index_pdf(mode=\"background\") or hidden compatibility background helpers."
        }
      },
      "required": [
        "job_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "list_jobs",
    "description": "Hidden compatibility helper for job listing; preferred control-plane form is mcp_control(action=\"list_jobs\").",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  {
    "name": "list_eval_cases",
    "description": "List internal regression/evaluation cases for this MCP server. Creates eval/manual-cases.json with default cases if it does not exist.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "case_id": {
          "type": "string",
          "description": "Optional case ID filter."
        },
        "create_default": {
          "type": "boolean",
          "description": "Create default eval/manual-cases.json and eval/profiles/*.json if missing. Default true."
        },
        "scope": {
          "type": "string",
          "enum": [
            "all",
            "generic",
            "profiles",
            "fixtures"
          ],
          "description": "Which eval cases to list. all merges generic cases, eval profiles, and fixture metadata. Default all."
        },
        "module_type": {
          "type": "string",
          "description": "Optional module/profile filter, for example ethernet, dmaengine, watchdog, pwm, usb, can, pcie."
        },
        "eval_profile": {
          "type": "string",
          "description": "Optional explicit eval profile name under eval/profiles/, for example ethernet or dmaengine."
        },
        "fixture": {
          "type": "string",
          "description": "Optional explicit fixture file name under eval/fixtures/ without .json."
        },
        "include_disabled": {
          "type": "boolean",
          "description": "Include disabled fixture case files in the listing. Default true for listing, false for run_eval."
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "run_eval",
    "description": "Run internal regression/evaluation cases against one manual PDF. This does not rebuild indexes unless auto_index=true. Use after changing scoring/parser/workflow code.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename to evaluate, for example r01uh1069ej0115-rzg3e-DMA.pdf. If omitted, the first available PDF is used when possible."
        },
        "case_id": {
          "type": "string",
          "description": "Optional single case ID to run."
        },
        "module_type": {
          "type": "string",
          "description": "Optional module type hint injected into applicable default cases, for example dmaengine, watchdog, pwm."
        },
        "auto_index": {
          "type": "boolean",
          "description": "If true, run index_pdf automatically when doctor reports missing core indexes. Default false."
        },
        "write_report": {
          "type": "boolean",
          "description": "If true, save .eval-report.txt and .eval-report.json in indexes/. Default true."
        },
        "create_default": {
          "type": "boolean",
          "description": "Create default eval/manual-cases.json and eval/profiles/*.json if missing. Default true."
        },
        "eval_profile": {
          "type": "string",
          "description": "Optional explicit eval profile to include from eval/profiles/, for example ethernet, dmaengine, watchdog, pwm, usb, can, pcie, or generic."
        },
        "include_profiles": {
          "type": "boolean",
          "description": "Include applicable eval/profiles/*.json cases. Default true."
        },
        "include_fixtures": {
          "type": "boolean",
          "description": "Include matching enabled eval/fixtures/*.json cases. Default true."
        },
        "fixture": {
          "type": "string",
          "description": "Optional explicit fixture file under eval/fixtures/ without .json. Explicit fixtures run even if disabled=false."
        },
        "include_golden": {
          "type": "boolean",
          "description": "If true, include V2 register/bitfield golden accuracy checks. Default false."
        },
        "golden_profile": {
          "type": "string",
          "description": "Golden profile under eval/golden without .json. Default rzg3e-core."
        },
        "strict_verified_only": {
          "type": "boolean",
          "description": "If true, only status=verified golden facts can fail the report. Default true."
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "eval_health_check",
    "description": "Run static eval/tool-registry hardening checks without requiring a PDF. Verifies tool registry uniqueness, handler coverage, eval/profile JSON readability, schema versions, and npm-test readiness.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "create_default": {
          "type": "boolean",
          "description": "Create default eval/profile files before checking. Default true."
        },
        "include_profiles": {
          "type": "boolean",
          "description": "Check driver_profiles/*.json and eval/profiles/*.json. Default true."
        },
        "include_fixtures": {
          "type": "boolean",
          "description": "Check eval/fixtures/*.json. Default true."
        },
        "write_report": {
          "type": "boolean",
          "description": "Save indexes/eval-health-report.json and .txt. Default true."
        },
        "step40_action": {
          "type": "string",
          "description": "Deprecated migration shim only. Use mcp_control(action=...) instead."
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "chunk_type_stats",
    "description": "Show chunkType/noise/content statistics for an indexed PDF. Use this after index_pdf to verify Step 23 classification and diagnose noisy TOC/index/revision chunks affecting search quality.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string",
          "description": "PDF filename, for example: GBETH.pdf"
        },
        "include_examples": {
          "type": "boolean",
          "description": "Include representative chunk examples for each chunk type. Default true."
        }
      },
      "required": [
        "filename"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "mcp_server_ping",
    "description": "Deprecated hidden compatibility ping; prefer mcp_control(action=\"ping\").",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  {
    "name": "pdf_index_status_lite",
    "description": "Deprecated hidden compatibility index status; prefer mcp_control(action=\"index_status_lite\", filename=\"...\").",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string"
        },
        "json": {
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
    "name": "index_status",
    "description": "Deprecated hidden compatibility index status; prefer mcp_control(action=\"index_status_lite\", filename=\"...\").",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string"
        },
        "details": {
          "type": "boolean"
        },
        "probe_pdf": {
          "type": "boolean"
        },
        "json": {
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
    "name": "rebuild_artifact",
    "description": "Deprecated hidden compatibility artifact rebuild; prefer mcp_control(action=\"rebuild_artifact\", filename=\"...\").",
    "inputSchema": {
      "type": "object",
      "properties": {
        "filename": {
          "type": "string"
        },
        "artifact": {
          "type": "string"
        },
        "force_lock": {
          "type": "boolean"
        },
        "force": {
          "type": "boolean"
        },
        "chunk_size": {
          "type": "number"
        },
        "chunk_overlap": {
          "type": "number"
        },
        "allow_full_rebuild": {
          "type": "boolean"
        },
        "cascade_dependents": {
          "type": "boolean"
        },
        "background": {
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
    "name": "cancel_job",
    "description": "Deprecated hidden compatibility job cancellation; prefer mcp_control(action=\"cancel_job\", job_id=\"...\").",
    "inputSchema": {
      "type": "object",
      "properties": {
        "job_id": {
          "type": "string"
        },
        "reason": {
          "type": "string"
        }
      },
      "required": [
        "job_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "cleanup_jobs",
    "description": "Deprecated hidden compatibility job cleanup; prefer mcp_control(action=\"cleanup_jobs\").",
    "inputSchema": {
      "type": "object",
      "properties": {
        "statuses": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "older_than_hours": {
          "type": "number"
        },
        "include_running": {
          "type": "boolean"
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "explain_tool_usage",
    "description": "Explain which MCP tool to use, when to use it, required inputs, typical next tool, and evidence trust level. Use this as inline help for AI agents to avoid wrong tool selection.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "tool_name": {
          "type": "string",
          "description": "Optional specific MCP tool name, for example verify_register_usage. If omitted, returns a compact workflow-oriented catalog."
        },
        "task": {
          "type": "string",
          "description": "Optional task context to bias recommendations."
        }
      },
      "additionalProperties": false
    }
  }
]);
