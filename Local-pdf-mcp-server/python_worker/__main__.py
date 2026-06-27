from __future__ import annotations

import json
import sys
import time
import traceback
from pathlib import Path
from typing import Any

from . import PROTOCOL_VERSION, WORKER_VERSION
from .extractors import build_structured, extract_pinmux_rows, extract_tables
from .figure_ocr import build_figure_ocr, extract_figures, inspect_figure_basic, ocr_health, ocr_image_file, parse_figure_image, prewarm_ocr_models, render_figure_crop
from .pdf_engine import build_pages_cache, extract_pages, inspect_pdf, library_versions, peak_rss_bytes, source_fingerprint, source_info
from .protocol import WorkerError, artifact_descriptor, atomic_write_json, emit, ensure_inside, log


OPERATIONS = {
    "health", "pdf.inspect", "pages.extract", "pages.build", "tables.extract", "tables.build",
    "structured.build", "registers.build", "bitfields.build", "cautions.build", "pinmux.extract",
    "ocr.health", "ocr.prewarm", "figures.extract", "figure_ocr.build", "figure.render", "ocr.image", "figure.structure", "figure.vl", "figure.inspect_basic",
}


def load_json(path_value: str) -> Any:
    import orjson
    with Path(path_value).open("rb") as stream:
        return orjson.loads(stream.read())


def main() -> int:
    started = time.perf_counter()
    request: dict[str, Any] = {}
    request_id = "unknown"
    try:
        request = json.loads(sys.stdin.read())
        request_id = str(request.get("requestId") or "unknown")
        if int(request.get("protocolVersion", 0)) != PROTOCOL_VERSION:
            raise WorkerError("PROTOCOL_VERSION_MISMATCH", "Unsupported protocol version")
        operation = str(request.get("operation") or "")
        if operation not in OPERATIONS:
            raise WorkerError("OPERATION_NOT_ALLOWED", f"Unsupported operation: {operation}")
        if operation == "health":
            emit("result", request_id, ok=True, operation=operation, result={"versions": library_versions(), "operations": sorted(OPERATIONS)})
            return 0
        if operation == "ocr.health":
            result = {"versions": library_versions(), **ocr_health()}
            emit("result", request_id, ok=True, operation=operation, result=result)
            return 0
        if operation == "ocr.prewarm":
            result = {"versions": library_versions(), **prewarm_ocr_models(request.get("options") or {})}
            emit("result", request_id, ok=True, operation=operation, result=result)
            return 0

        roots = [str(value) for value in request.get("allowedRoots", [])]
        if not roots:
            raise WorkerError("MISSING_ALLOWED_ROOTS", "allowedRoots is required")
        inputs = request.get("inputs") or {}
        outputs = request.get("outputs") or {}
        options = request.get("options") or {}
        pdf_path = ensure_inside(inputs.get("pdfPath", ""), roots, "PDF path")
        cancel_path = outputs.get("cancelPath")

        def progress(current: int, total: int, phase: str = operation) -> None:
            emit("progress", request_id, phase=phase, current=current, total=total, unit="pages")

        if operation == "pdf.inspect":
            result = inspect_pdf(pdf_path)
        elif operation == "pages.extract":
            result = extract_pages(pdf_path, options.get("startPage", 1), options.get("endPage"), lambda c, t: progress(c, t, "extract-pages"), cancel_path)
        elif operation == "pages.build":
            output_path = ensure_inside(outputs["artifactPath"], roots, "artifact path")
            checkpoint_path = ensure_inside(outputs["checkpointPath"], roots, "checkpoint path") if outputs.get("checkpointPath") else None
            artifact = build_pages_cache(pdf_path, inputs["filename"], output_path, checkpoint_path, lambda c, t: progress(c, t, "build-pages-cache"), cancel_path, int(options.get("checkpointEvery", 50)))
            source = artifact["source"]
            descriptor = artifact_descriptor("pages", output_path, 1, artifact["pageCount"])
            emit("artifact", request_id, artifact=descriptor)
            result = {"artifact": descriptor, "sourceFingerprint": source_fingerprint(source)}
        elif operation in {"tables.extract", "pinmux.extract"}:
            extracted = extract_tables(pdf_path, options.get("candidatePages"), lambda c, t: progress(c, t, "extract-tables"), cancel_path, None, inputs.get("filename", ""))
            tables = extracted["tables"]
            if operation == "pinmux.extract":
                tables = [table for table in tables if table.get("kind") == "pinmux-table"]
                result = {**extracted, "tables": tables, "rows": extract_pinmux_rows(tables, str(options.get("filter", "")))}
            else:
                result = {**extracted, "tables": tables}
        elif operation == "figures.extract":
            output_path = ensure_inside(outputs["artifactPath"], roots, "figures artifact path")
            renders_root = ensure_inside(outputs["rendersRoot"], roots, "renders root")
            artifact = extract_figures(pdf_path, inputs["filename"], output_path, renders_root, options, lambda c, t: progress(c, t, "extract-figures"), cancel_path)
            descriptor = artifact_descriptor("figures", output_path, 1, artifact["figureCount"])
            emit("artifact", request_id, artifact=descriptor)
            result = {"artifact": descriptor, "sourceFingerprint": artifact["sourceFingerprint"], "figureCount": artifact["figureCount"]}
        elif operation == "figure.render":
            image_path = ensure_inside(outputs["imagePath"], roots, "figure render image path")
            result = render_figure_crop(
                pdf_path,
                inputs["filename"],
                image_path,
                int(options.get("page", 0)),
                options.get("bbox"),
                float(options.get("scale", 2.0)),
                bool(options.get("force", False)),
            )
        elif operation == "ocr.image":
            image_path = ensure_inside(inputs["imagePath"], roots, "OCR image path")
            result = ocr_image_file(
                image_path,
                str(options.get("engine", "auto")),
                options.get("bbox"),
                float(options.get("scale", 1.0)),
            )
        elif operation in {"figure.structure", "figure.vl"}:
            image_path = ensure_inside(inputs["imagePath"], roots, "figure image path")
            output_path = ensure_inside(outputs["artifactPath"], roots, "figure parser artifact path")
            kind = "structure" if operation == "figure.structure" else "vl"
            artifact = parse_figure_image(image_path, pdf_path, inputs["filename"], output_path, kind, options)
            descriptor = artifact_descriptor(f"figure_{kind}", output_path, 1, artifact["itemCount"])
            emit("artifact", request_id, artifact=descriptor)
            result = {
                "artifact": descriptor,
                "sourceFingerprint": artifact["sourceFingerprint"],
                "itemCount": artifact["itemCount"],
                "ok": bool(artifact.get("ok")),
                "error_code": artifact.get("error_code", ""),
                "message": artifact.get("message", ""),
                "hint": artifact.get("hint", ""),
                "warnings": artifact.get("warnings", []),
            }
        elif operation == "figure.inspect_basic":
            image_path = ensure_inside(outputs["imagePath"], roots, "figure inspect image path")
            result = inspect_figure_basic(
                pdf_path,
                inputs["filename"],
                image_path,
                int(options.get("page", 0)),
                options.get("bbox"),
                float(options.get("scale", 2.0)),
                str(options.get("engine", "auto")),
                bool(options.get("force", False)),
            )
        elif operation == "figure_ocr.build":
            figures_path = ensure_inside(inputs["figuresPath"], roots, "figures artifact path")
            output_path = ensure_inside(outputs["artifactPath"], roots, "figure OCR artifact path")
            renders_root = ensure_inside(outputs["rendersRoot"], roots, "renders root")
            checkpoint_path = ensure_inside(outputs["checkpointPath"], roots, "figure OCR checkpoint path") if outputs.get("checkpointPath") else None
            existing_path = ensure_inside(inputs["existingArtifactPath"], roots, "existing figure OCR artifact path") if inputs.get("existingArtifactPath") else None
            artifact = build_figure_ocr(pdf_path, inputs["filename"], figures_path, output_path, renders_root, options, lambda c, t: progress(c, t, "ocr-figures"), cancel_path, checkpoint_path, existing_path)
            if artifact.get("ok") is False:
                result = artifact
            else:
                descriptor = artifact_descriptor("figure_ocr", output_path, 1, artifact["figureOcrCount"])
                emit("artifact", request_id, artifact=descriptor)
                result = {"artifact": descriptor, "sourceFingerprint": artifact["sourceFingerprint"], "figureOcrCount": artifact["figureOcrCount"], "cached": bool(artifact.get("cached"))}
        else:
            pages_path = ensure_inside(inputs["pagesPath"], roots, "pages artifact")
            pages_data = load_json(str(pages_path))
            checkpoint_path = ensure_inside(outputs["tablesCheckpointPath"], roots, "tables checkpoint path") if outputs.get("tablesCheckpointPath") else None
            structured = build_structured(inputs["filename"], pdf_path, pages_data, options.get("candidatePages"), lambda c, t: progress(c, t, "structured-tables"), cancel_path, checkpoint_path)
            requested = ["tables", "registers", "bitfields", "cautions"] if operation == "structured.build" else [operation.split(".")[0]]
            descriptors = []
            schemas = {"tables": 1, "registers": 1, "bitfields": 3, "cautions": 1}
            count_keys = {"tables": "tableCount", "registers": "registerCount", "bitfields": "bitfieldCount", "cautions": "cautionCount"}
            for kind in requested:
                value = structured[kind]
                output_path = ensure_inside(outputs[f"{kind}Path"], roots, f"{kind} artifact path")
                atomic_write_json(output_path, value)
                descriptor = artifact_descriptor(kind, output_path, schemas[kind], value[count_keys[kind]])
                descriptors.append(descriptor)
                emit("artifact", request_id, artifact=descriptor)
            result = {"artifacts": descriptors, "sourceFingerprint": structured["sourceFingerprint"]}

        emit("result", request_id, ok=True, operation=operation, durationMs=round((time.perf_counter() - started) * 1000), metrics={"peakRssBytes": peak_rss_bytes()}, result=result)
        return 0
    except WorkerError as error:
        emit("error", request_id, ok=False, code=error.code, message=str(error))
        return 2
    except Exception as error:  # noqa: BLE001 - process boundary must report all failures
        log(traceback.format_exc())
        emit("error", request_id, ok=False, code="EXTRACTION_FAILED", message=str(error))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
