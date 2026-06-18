# Step 40.7 MCP compatibility hardening

## Decision

Direct Step 40 tool names are no longer advertised in the MCP tool registry because the target VS Code AI-agent client was observed to cancel newly-added direct tools even when the server version, tool registry, and handler coverage were healthy.

The supported Step 40 control interface is now:

```text
eval_health_check(step40_action="...")
```

## Supported control actions

```text
eval_health_check(step40_action="ping")
eval_health_check(step40_action="compat_report")
eval_health_check(step40_action="index_status_lite", filename="<manual>.pdf")
eval_health_check(step40_action="rebuild_artifact", filename="<manual>.pdf", artifact="pages")
eval_health_check(step40_action="job_status", job_id="<job_id>")
eval_health_check(step40_action="list_jobs")
eval_health_check(step40_action="cancel_job", job_id="<job_id>")
eval_health_check(step40_action="cleanup_jobs")
```

## Hidden/deprecated direct tool names

These handlers remain in the source for legacy compatibility, but they are not exposed in `tools/list`:

```text
mcp_server_ping
pdf_index_status_lite
index_status
rebuild_artifact
cancel_job
cleanup_jobs
```

## Expected static health

```text
npm.cmd test
Static health: tools=60, handlers=60
Static health: PASS
Startup smoke: PASS
Eval smoke: PASS
```

## Rationale

Observed behavior on the target client:

```text
list_pdfs()                          OK
eval_health_check                    OK
eval_health_check(step40_action=...)  OK
mcp_server_ping()                     cancelled
pdf_index_status_lite(...)            cancelled
index_status(...)                     cancelled
```

This indicates a client/tool-name compatibility issue rather than a PDF extraction or job-worker issue.
