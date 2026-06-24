from __future__ import annotations

import importlib.metadata
import importlib.util
import contextlib
import os
import sys
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

import fitz

from . import WORKER_VERSION
from .pdf_engine import source_fingerprint, source_info
from .protocol import atomic_write_json, check_cancel


FIGURE_SCHEMA_VERSION = 1
FIGURE_OCR_SCHEMA_VERSION = 1
OCR_ENGINE = "paddleocr"
OCR_INSTALL_HINT = r"Run: .\.venv\Scripts\python.exe -m pip install -r requirements-ocr.txt"
DEFAULT_OCR_OPTIONS = {
    "enabled": True,
    "mode": "figures_only",
    "engine": OCR_ENGINE,
    "dpi": 200,
    "minFigureAreaRatio": 0.03,
    "maxFiguresPerPage": 8,
    "cache": True,
    "skipSmallImages": True,
    "skipRegisterTables": True,
}


def _version(package: str) -> str:
    try:
        return importlib.metadata.version(package)
    except Exception:
        return ""


def ocr_health() -> dict[str, Any]:
    missing = []
    checks = {
        "paddleocr": importlib.util.find_spec("paddleocr") is not None,
        "paddlepaddle": importlib.util.find_spec("paddle") is not None,
        "Pillow": importlib.util.find_spec("PIL") is not None,
    }
    for name, available in checks.items():
        if not available:
            missing.append(name)
    available = not missing
    return {
        "ok": True,
        "ocr": {
            "enabled": available,
            "engine": OCR_ENGINE,
            "available": available,
            "reason": "" if available else "missing dependency",
            "missing": missing,
            "hint": "" if available else OCR_INSTALL_HINT,
            "versions": {
                "paddleocr": _version("paddleocr"),
                "paddlepaddle": _version("paddlepaddle"),
                "Pillow": _version("Pillow"),
            },
        },
    }


def _safe_render_stem(filename: str) -> str:
    value = re.sub(r"[^A-Za-z0-9_.-]+", "-", filename.strip())[:160]
    return value.strip(".-") or "manual"


def _relpath(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except Exception:
        return path.as_posix()


def _bbox_list(rect: fitz.Rect) -> list[float]:
    return [round(rect.x0, 2), round(rect.y0, 2), round(rect.x1, 2), round(rect.y1, 2)]


def _rect_from_bbox(bbox: Any) -> fitz.Rect:
    values = list(bbox or [0, 0, 0, 0])
    return fitz.Rect(float(values[0]), float(values[1]), float(values[2]), float(values[3]))


def _rect_area(rect: fitz.Rect) -> float:
    return max(0.0, float(rect.width)) * max(0.0, float(rect.height))


CAPTION_RE = re.compile(r"^(Figure|Fig\.?|Table)\s+([A-Za-z]?\d+(?:[.\-]\d+)*(?:[A-Za-z])?)\s*[:.\-]?\s*(.{0,220})$", re.I)


def _text_lines(page: fitz.Page) -> list[dict[str, Any]]:
    lines: list[dict[str, Any]] = []
    try:
        data = page.get_text("dict")
    except Exception:
        return lines
    for block in data.get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            text = "".join(span.get("text", "") for span in line.get("spans", [])).strip()
            if not text:
                continue
            bbox = fitz.Rect(line.get("bbox", block.get("bbox", [0, 0, 0, 0])))
            lines.append({"text": re.sub(r"\s+", " ", text), "bbox": bbox})
    return lines


def _caption_near(lines: list[dict[str, Any]], figure_rect: fitz.Rect) -> str:
    candidates = []
    for line in lines:
        text = line["text"]
        if not CAPTION_RE.search(text):
            continue
        rect = line["bbox"]
        vertical_gap = min(abs(rect.y0 - figure_rect.y1), abs(figure_rect.y0 - rect.y1))
        horizontal_overlap = max(0.0, min(rect.x1, figure_rect.x1) - max(rect.x0, figure_rect.x0))
        overlap_ratio = horizontal_overlap / max(1.0, min(rect.width, figure_rect.width))
        if vertical_gap <= 140 and overlap_ratio >= 0.15:
            candidates.append((vertical_gap, text))
    candidates.sort(key=lambda item: item[0])
    return candidates[0][1] if candidates else ""


def _looks_register_table(caption: str, rect: fitz.Rect, page_rect: fitz.Rect) -> bool:
    text = caption.lower()
    if any(term in text for term in ["register", "bit field", "bit-field", "offset address", "access size"]):
        return True
    return rect.width > page_rect.width * 0.85 and rect.height < page_rect.height * 0.28


def _image_candidates(page: fitz.Page) -> list[tuple[str, fitz.Rect]]:
    candidates = []
    try:
        data = page.get_text("dict")
    except Exception:
        return candidates
    for block in data.get("blocks", []):
        if block.get("type") != 1:
            continue
        rect = fitz.Rect(block.get("bbox", [0, 0, 0, 0]))
        candidates.append(("image", rect))
    return candidates


def _drawing_candidate(page: fitz.Page) -> list[tuple[str, fitz.Rect]]:
    try:
        drawings = page.get_drawings()
    except Exception:
        return []
    rects = [draw.get("rect") for draw in drawings if draw.get("rect")]
    rects = [fitz.Rect(rect) for rect in rects if _rect_area(fitz.Rect(rect)) > 50]
    if len(rects) < 8:
        return []
    union = fitz.Rect(rects[0])
    for rect in rects[1:]:
        union |= rect
    return [("drawing", union)]


def _render_region(page: fitz.Page, rect: fitz.Rect, output_path: Path, dpi: int, force: bool = False) -> None:
    if output_path.exists() and not force:
        return
    output_path.parent.mkdir(parents=True, exist_ok=True)
    matrix = fitz.Matrix(float(dpi) / 72.0, float(dpi) / 72.0)
    pixmap = page.get_pixmap(matrix=matrix, clip=rect, alpha=False)
    pixmap.save(str(output_path))


def _render_region_scale(page: fitz.Page, rect: fitz.Rect, output_path: Path, scale: float, force: bool = False) -> dict[str, Any]:
    if output_path.exists() and not force:
        pixmap = fitz.Pixmap(str(output_path))
        try:
            return {"cache_hit": True, "width": pixmap.width, "height": pixmap.height}
        finally:
            pixmap = None
    output_path.parent.mkdir(parents=True, exist_ok=True)
    matrix = fitz.Matrix(float(scale), float(scale))
    pixmap = page.get_pixmap(matrix=matrix, clip=rect, alpha=False)
    pixmap.save(str(output_path))
    return {"cache_hit": False, "width": pixmap.width, "height": pixmap.height}


def render_figure_crop(
    pdf_path: Path,
    filename: str,
    output_path: Path,
    page_number: int,
    bbox: Any,
    scale: float = 2.0,
    force: bool = False,
) -> dict[str, Any]:
    source = source_info(pdf_path)
    rect = _rect_from_bbox(bbox)
    with fitz.open(pdf_path) as document:
        page_count = document.page_count
        page_num = int(page_number)
        if page_num < 1 or page_num > page_count:
            return {
                "ok": False,
                "error_code": "PAGE_OUT_OF_RANGE",
                "message": f"page must be between 1 and {page_count}",
                "pageCount": page_count,
            }
        page = document.load_page(page_num - 1)
        page_rect = page.rect
        clipped = rect & page_rect
        if clipped.is_empty or clipped.width <= 0 or clipped.height <= 0:
            return {
                "ok": False,
                "error_code": "INVALID_BBOX",
                "message": "bbox is outside the PDF page or has no area",
                "page": page_num,
                "pageCount": page_count,
                "page_bbox": _bbox_list(page_rect),
            }
        render = _render_region_scale(page, clipped, output_path, max(0.25, min(6.0, float(scale or 2.0))), force)
    return {
        "ok": True,
        "filename": filename,
        "page": page_num,
        "pageCount": page_count,
        "bbox": _bbox_list(clipped),
        "scale": max(0.25, min(6.0, float(scale or 2.0))),
        "image_path": str(output_path),
        "width": render["width"],
        "height": render["height"],
        "cache_hit": bool(render["cache_hit"]),
        "source": source,
        "sourceFingerprint": source_fingerprint(source),
        "warnings": [] if clipped == rect else ["Input bbox was clipped to the PDF page bounds."],
    }


def extract_figures(
    pdf_path: Path,
    filename: str,
    output_path: Path,
    renders_root: Path,
    options: dict[str, Any] | None = None,
    progress: Callable[[int, int], None] | None = None,
    cancel_path: str | None = None,
) -> dict[str, Any]:
    opts = {**DEFAULT_OCR_OPTIONS, **(options or {})}
    dpi = int(opts.get("dpi") or 200)
    min_area_ratio = float(opts.get("minFigureAreaRatio") or opts.get("min_area_ratio") or 0.03)
    max_per_page = int(opts.get("maxFiguresPerPage") or opts.get("max_figures_per_page") or 8)
    render_regions = bool(opts.get("render", True))
    force = bool(opts.get("force", False))
    source = source_info(pdf_path)
    figure_rows: list[dict[str, Any]] = []
    render_dir = renders_root / _safe_render_stem(filename)
    with fitz.open(pdf_path) as document:
        total = document.page_count
        for page_index in range(total):
            check_cancel(cancel_path)
            page = document.load_page(page_index)
            page_number = page_index + 1
            page_rect = page.rect
            page_area = max(1.0, _rect_area(page_rect))
            lines = _text_lines(page)
            raw_candidates = _image_candidates(page) + _drawing_candidate(page)
            candidates = []
            for kind, rect in raw_candidates:
                rect &= page_rect
                area_ratio = _rect_area(rect) / page_area
                if area_ratio < min_area_ratio:
                    continue
                caption = _caption_near(lines, rect)
                if opts.get("skipRegisterTables", True) and _looks_register_table(caption, rect, page_rect):
                    continue
                candidates.append((area_ratio, kind, rect, caption))
            candidates.sort(key=lambda item: item[0], reverse=True)
            for ordinal, (area_ratio, kind, rect, caption) in enumerate(candidates[:max_per_page], start=1):
                uid = f"p{page_number:04d}_f{ordinal:03d}"
                render_path = render_dir / f"page_{page_number:04d}_figure_{ordinal:03d}.png"
                if render_regions:
                    _render_region(page, rect, render_path, dpi, force=force)
                relative_render = _relpath(render_path, Path.cwd())
                figure_rows.append({
                    "figureUid": uid,
                    "figure_uid": uid,
                    "id": uid,
                    "filename": filename,
                    "page": page_number,
                    "type": "Figure",
                    "number": "",
                    "title": caption,
                    "bbox": _bbox_list(rect),
                    "areaRatio": round(area_ratio, 6),
                    "area_ratio": round(area_ratio, 6),
                    "caption": caption,
                    "kind": kind,
                    "headings": [],
                    "contextLines": [caption] if caption else [],
                    "contextPreview": caption,
                    "searchText": re.sub(r"\s+", " ", f"{caption} {kind} figure diagram image drawing".lower()).strip(),
                    "renderPath": relative_render,
                    "render_path": relative_render,
                    "sourceType": "pdf_figure_region",
                    "source_type": "pdf_figure_region",
                    "source": "python-figure-region",
                    "confidence": 82 if kind == "image" else 65,
                })
            if progress and (page_number == 1 or page_number == total or page_number % 25 == 0):
                progress(page_number, total)
    artifact = {
        "schemaVersion": FIGURE_SCHEMA_VERSION,
        "schema_version": FIGURE_SCHEMA_VERSION,
        "filename": filename,
        "generatedBy": "python_worker.figures.extract",
        "generated_by": "python_worker.extract_figures",
        "createdAt": datetime.now().astimezone().isoformat(),
        "workerVersion": WORKER_VERSION,
        "source": source,
        "sourceFingerprint": source_fingerprint(source),
        "pageCount": total if "total" in locals() else 0,
        "figureCount": len(figure_rows),
        "ocrDefaults": opts,
        "figures": figure_rows,
    }
    atomic_write_json(output_path, artifact)
    return artifact


def _load_paddleocr() -> Any:
    health = ocr_health()
    if not health["ocr"]["available"]:
        return None
    with contextlib.redirect_stdout(sys.stderr):
        from paddleocr import PaddleOCR
        try:
            return PaddleOCR(
                lang="en",
                ocr_version=os.environ.get("RENESAS_MCP_PADDLEOCR_VERSION", "PP-OCRv4"),
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
            )
        except TypeError:
            return PaddleOCR(use_angle_cls=True, lang="en")


def _image_bbox_from_polygon(polygon: Any) -> list[float]:
    try:
        points = [[float(point[0]), float(point[1])] for point in polygon or []]
    except Exception:
        points = []
    if not points:
        return []
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    return [round(min(xs), 2), round(min(ys), 2), round(max(xs), 2), round(max(ys), 2)]


def _pdf_bbox_from_image_bbox(image_bbox: list[float], crop_bbox: Any, scale: float) -> list[float]:
    if len(image_bbox) != 4 or not crop_bbox:
        return []
    crop = list(crop_bbox)
    factor = max(0.0001, float(scale or 1.0))
    return [
        round(float(crop[0]) + float(image_bbox[0]) / factor, 2),
        round(float(crop[1]) + float(image_bbox[1]) / factor, 2),
        round(float(crop[0]) + float(image_bbox[2]) / factor, 2),
        round(float(crop[1]) + float(image_bbox[3]) / factor, 2),
    ]


def _ocr_result_payload(item: Any) -> dict[str, Any]:
    if isinstance(item, dict):
        return item
    json_value = getattr(item, "json", None)
    if callable(json_value):
        with contextlib.suppress(Exception):
            json_value = json_value()
    if isinstance(json_value, dict):
        return json_value
    to_dict = getattr(item, "to_dict", None)
    if callable(to_dict):
        with contextlib.suppress(Exception):
            value = to_dict()
            if isinstance(value, dict):
                return value
    return {}


def _append_ocr_token(
    tokens: list[dict[str, Any]],
    texts: list[str],
    confidences: list[float],
    text: Any,
    confidence: Any,
    image_bbox: list[float],
    crop_bbox: Any,
    scale: float,
) -> None:
    token_text = str(text or "").strip()
    if not token_text:
        return
    try:
        score = float(confidence)
    except Exception:
        score = 0.0
    pdf_bbox = _pdf_bbox_from_image_bbox(image_bbox, crop_bbox, scale)
    tokens.append({
        "text": token_text,
        "bbox": pdf_bbox or image_bbox,
        "image_bbox": image_bbox,
        "confidence": round(score, 4),
    })
    texts.append(token_text)
    confidences.append(score)


def _parse_paddleocr_predict_result(result: Any, crop_bbox: Any, scale: float) -> tuple[list[str], list[float], list[dict[str, Any]]]:
    tokens: list[dict[str, Any]] = []
    texts: list[str] = []
    confidences: list[float] = []
    for page_result in result or []:
        payload = _ocr_result_payload(page_result)
        res = payload.get("res", payload) if isinstance(payload, dict) else {}
        rec_texts = res.get("rec_texts")
        if not isinstance(rec_texts, list):
            continue
        scores = res.get("rec_scores") if isinstance(res.get("rec_scores"), list) else []
        boxes = res.get("rec_boxes") if isinstance(res.get("rec_boxes"), list) else []
        polys = res.get("rec_polys") if isinstance(res.get("rec_polys"), list) else res.get("dt_polys") if isinstance(res.get("dt_polys"), list) else []
        for index, text in enumerate(rec_texts):
            image_bbox: list[float] = []
            if index < len(boxes) and isinstance(boxes[index], (list, tuple)) and len(boxes[index]) == 4:
                with contextlib.suppress(Exception):
                    image_bbox = [round(float(value), 2) for value in boxes[index]]
            if not image_bbox and index < len(polys):
                image_bbox = _image_bbox_from_polygon(polys[index])
            confidence = scores[index] if index < len(scores) else 0.0
            _append_ocr_token(tokens, texts, confidences, text, confidence, image_bbox, crop_bbox, scale)
    return texts, confidences, tokens


def _parse_paddleocr_legacy_result(result: Any, crop_bbox: Any, scale: float) -> tuple[list[str], list[float], list[dict[str, Any]]]:
    tokens: list[dict[str, Any]] = []
    texts: list[str] = []
    confidences: list[float] = []
    for page_result in result or []:
        for item in page_result or []:
            if not item or len(item) < 2:
                continue
            text_info = item[1]
            if not isinstance(text_info, (list, tuple)) or len(text_info) < 2:
                continue
            image_bbox = _image_bbox_from_polygon(item[0] if len(item) >= 1 else None)
            _append_ocr_token(tokens, texts, confidences, text_info[0], text_info[1], image_bbox, crop_bbox, scale)
    return texts, confidences, tokens


def _ocr_image(ocr: Any, image_path: str, crop_bbox: Any = None, scale: float = 1.0) -> tuple[str, float, list[dict[str, Any]]]:
    with contextlib.redirect_stdout(sys.stderr):
        if hasattr(ocr, "predict"):
            result = ocr.predict(
                image_path,
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
            )
            texts, confidences, tokens = _parse_paddleocr_predict_result(result, crop_bbox, scale)
        else:
            result = ocr.ocr(image_path, cls=True)
            texts, confidences, tokens = _parse_paddleocr_legacy_result(result, crop_bbox, scale)
    if not tokens and hasattr(ocr, "ocr"):
        with contextlib.redirect_stdout(sys.stderr):
            try:
                result = ocr.ocr(image_path)
            except TypeError:
                result = ocr.ocr(image_path, cls=True)
        texts, confidences, tokens = _parse_paddleocr_legacy_result(result, crop_bbox, scale)
    confidence_avg = sum(confidences) / len(confidences) if confidences else 0.0
    return " ".join(texts), round(confidence_avg, 4), tokens


def ocr_image_file(
    image_path: Path,
    engine: str = "auto",
    crop_bbox: Any = None,
    scale: float = 1.0,
) -> dict[str, Any]:
    requested_engine = str(engine or "auto").lower()
    if requested_engine == "none":
        return {
            "ok": False,
            "error_code": "OCR_ENGINE_DISABLED",
            "message": "OCR engine was disabled by request",
            "engine": "none",
            "ocr_text": [],
            "plain_text": "",
            "warnings": ["engine=none skips OCR and returns no text."],
        }
    health = ocr_health()
    if not health["ocr"]["available"]:
        return {
            "ok": False,
            "error_code": "OCR_ENGINE_UNAVAILABLE",
            "message": "PaddleOCR is not installed or not importable.",
            "engine": OCR_ENGINE,
            "hint": OCR_INSTALL_HINT,
            "health": health,
            "ocr_text": [],
            "plain_text": "",
            "warnings": [OCR_INSTALL_HINT],
        }
    try:
        ocr = _load_paddleocr()
        plain_text, confidence_avg, tokens = _ocr_image(ocr, str(image_path), crop_bbox, scale)
    except Exception as error:
        return {
            "ok": False,
            "error_code": "OCR_FAILED",
            "message": str(error),
            "engine": OCR_ENGINE,
            "hint": "",
            "ocr_text": [],
            "plain_text": "",
            "warnings": [f"OCR failed: {error}"],
        }
    return {
        "ok": True,
        "engine": OCR_ENGINE,
        "image_path": str(image_path),
        "ocr_text": tokens,
        "plain_text": plain_text,
        "confidence_avg": confidence_avg,
        "warnings": [],
    }


def inspect_figure_basic(
    pdf_path: Path,
    filename: str,
    output_path: Path,
    page_number: int,
    bbox: Any,
    scale: float = 2.0,
    engine: str = "auto",
    force: bool = False,
) -> dict[str, Any]:
    render = render_figure_crop(pdf_path, filename, output_path, page_number, bbox, scale, force)
    if not render.get("ok"):
        return {
            "ok": False,
            "error_code": render.get("error_code", "PDF_RENDER_FAILED"),
            "message": render.get("message", "PDF render failed"),
            "render": render,
            "warnings": render.get("warnings", []),
        }
    ocr = ocr_image_file(output_path, engine, render.get("bbox"), render.get("scale", scale))
    return {
        "ok": True,
        "render": render,
        "ocr": ocr,
        "warnings": [*(render.get("warnings", []) or []), *(ocr.get("warnings", []) or [])],
    }


def build_figure_ocr(
    pdf_path: Path,
    filename: str,
    figures_path: Path,
    output_path: Path,
    renders_root: Path,
    options: dict[str, Any] | None = None,
    progress: Callable[[int, int], None] | None = None,
    cancel_path: str | None = None,
) -> dict[str, Any]:
    opts = {**DEFAULT_OCR_OPTIONS, **(options or {})}
    source = source_info(pdf_path)
    health = ocr_health()
    if not health["ocr"]["available"]:
        return {
            "ok": False,
            "error": "OCR dependency missing",
            "hint": OCR_INSTALL_HINT,
            "health": health,
        }
    import orjson
    figures_data = orjson.loads(figures_path.read_bytes())
    cached = None
    if output_path.exists() and not bool(opts.get("force", False)):
      try:
        cached = orjson.loads(output_path.read_bytes())
      except Exception:
        cached = None
    if cached and cached.get("sourceFingerprint") == source_fingerprint(source) and cached.get("engine") == OCR_ENGINE and int(cached.get("dpi", 0)) == int(opts.get("dpi", 200)):
        return {**cached, "cached": True}
    ocr = _load_paddleocr()
    figures = []
    entries = figures_data.get("figures", [])
    total = len(entries)
    for index, figure in enumerate(entries, start=1):
        check_cancel(cancel_path)
        render_path_value = figure.get("renderPath") or figure.get("render_path")
        render_path = Path(render_path_value)
        if not render_path.is_absolute():
            render_path = Path.cwd() / render_path
        if not render_path.exists():
            with fitz.open(pdf_path) as document:
                page = document.load_page(int(figure["page"]) - 1)
                _render_region(page, _rect_from_bbox(figure.get("bbox")), render_path, int(opts.get("dpi", 200)), force=True)
        ocr_text, confidence_avg, tokens = _ocr_image(ocr, str(render_path))
        uid = figure.get("figureUid") or figure.get("figure_uid") or figure.get("id")
        figures.append({
            "figureUid": uid,
            "figure_uid": uid,
            "page": figure.get("page"),
            "caption": figure.get("caption", ""),
            "bbox": figure.get("bbox", []),
            "ocrText": ocr_text,
            "ocr_text": ocr_text,
            "confidenceAvg": confidence_avg,
            "confidence_avg": confidence_avg,
            "tokens": tokens,
            "sourceType": "figure_ocr",
            "source_type": "figure_ocr",
            "renderPath": figure.get("renderPath") or figure.get("render_path"),
            "render_path": figure.get("renderPath") or figure.get("render_path"),
        })
        if progress and (index == 1 or index == total or index % 5 == 0):
            progress(index, total)
    artifact = {
        "schemaVersion": FIGURE_OCR_SCHEMA_VERSION,
        "schema_version": FIGURE_OCR_SCHEMA_VERSION,
        "filename": filename,
        "generatedBy": "python_worker.figure_ocr.build",
        "generated_by": "python_worker.ocr_figures",
        "createdAt": datetime.now().astimezone().isoformat(),
        "workerVersion": WORKER_VERSION,
        "source": source,
        "sourceFingerprint": source_fingerprint(source),
        "engine": OCR_ENGINE,
        "mode": "figures_only",
        "dpi": int(opts.get("dpi", 200)),
        "figureCount": len(entries),
        "figureOcrCount": len(figures),
        "figures": figures,
    }
    atomic_write_json(output_path, artifact)
    return artifact
