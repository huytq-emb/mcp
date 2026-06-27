from __future__ import annotations

import importlib.metadata
import importlib.util
import contextlib
import concurrent.futures
import hashlib
import json
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
FIGURE_PARSE_SCHEMA_VERSION = 1
OCR_ENGINE = "paddleocr"
OCR_INSTALL_HINT = r"Run: .\.venv\Scripts\python.exe -m pip install -r requirements-ocr.txt"
OCR_STRUCTURE_INSTALL_HINT = r"Run: .\.venv\Scripts\python.exe -m pip install -r requirements-ocr-structure.txt"
OCR_VL_INSTALL_HINT = r"Run: .\.venv\Scripts\python.exe -m pip install -r requirements-ocr-vl.txt"
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


def _dependency_status(available: bool, reason: str = "", hint: str = "", missing: list[str] | None = None, **extra: Any) -> dict[str, Any]:
    return {
        "available": bool(available),
        "reason": "" if available else (reason or "missing dependency"),
        "hint": "" if available else hint,
        "missing": [] if available else list(missing or []),
        **extra,
    }


def _paddleocr_export_available(name: str) -> tuple[bool, str]:
    # Health checks must be cheap and must not import PaddleOCR, because import
    # can initialize heavyweight runtime state on Windows. The explicit parser
    # operation performs the real import and reports a structured failure if the
    # class is not actually exported by the installed wheel.
    if importlib.util.find_spec("paddlex") is None:
        return False, "paddleocr document parser extras are not installed"
    try:
        from paddlex.utils.deps import is_extra_available
        if not is_extra_available("ocr"):
            return False, "paddlex[ocr] extra is not installed"
    except Exception as error:
        return False, f"unable to verify paddlex[ocr] extra: {error}"
    spec = importlib.util.find_spec("paddleocr")
    if spec is None:
        return False, "paddleocr package is not installed"
    if not _version("paddleocr"):
        return False, "paddleocr package version is unavailable"
    origin = getattr(spec, "origin", None)
    if origin:
        with contextlib.suppress(Exception):
            source = Path(origin).read_text(encoding="utf-8", errors="ignore")
            if name not in source:
                return False, f"paddleocr.{name} is not exported by the installed package"
    return True, ""


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
    text_available = not missing
    structure_available = False
    structure_reason = "PaddleOCR text dependencies are missing"
    vl_available = False
    vl_reason = "PaddleOCR text dependencies are missing"
    if text_available:
        structure_available, structure_reason = _paddleocr_export_available("PPStructureV3")
        vl_available, vl_reason = _paddleocr_export_available("PaddleOCRVL")
    return {
        "ok": True,
        "ocr": {
            "enabled": text_available,
            "engine": OCR_ENGINE,
            "available": text_available,
            "reason": "" if text_available else "missing dependency",
            "missing": missing,
            "hint": "" if text_available else OCR_INSTALL_HINT,
            "text": _dependency_status(
                text_available,
                "missing dependency",
                OCR_INSTALL_HINT,
                missing,
                model=os.environ.get("RENESAS_MCP_PADDLEOCR_VERSION", "PP-OCRv4"),
            ),
            "structure": _dependency_status(
                structure_available,
                structure_reason,
                OCR_STRUCTURE_INSTALL_HINT,
                [] if text_available else missing,
                parser="PP-StructureV3",
            ),
            "vl": _dependency_status(
                vl_available,
                vl_reason,
                OCR_VL_INSTALL_HINT,
                [] if text_available else missing,
                parser="PaddleOCR-VL",
                verification="visual graph edges are unverified until cross-checked",
            ),
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


def _caption_match(lines: list[dict[str, Any]], figure_rect: fitz.Rect) -> tuple[str, float]:
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
    return (candidates[0][1], float(candidates[0][0])) if candidates else ("", 999999.0)


def _caption_near(lines: list[dict[str, Any]], figure_rect: fitz.Rect) -> str:
    return _caption_match(lines, figure_rect)[0]


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


def _rect_distance(a: fitz.Rect, b: fitz.Rect) -> float:
    dx = max(0.0, max(a.x0, b.x0) - min(a.x1, b.x1))
    dy = max(0.0, max(a.y0, b.y0) - min(a.y1, b.y1))
    return (dx * dx + dy * dy) ** 0.5


def _rect_iou(a: fitz.Rect, b: fitz.Rect) -> float:
    overlap = a & b
    if overlap.is_empty:
        return 0.0
    intersection = _rect_area(overlap)
    union = _rect_area(a) + _rect_area(b) - intersection
    return intersection / max(1.0, union)


def _is_full_page_like(rect: fitz.Rect, page_rect: fitz.Rect) -> bool:
    page_area = max(1.0, _rect_area(page_rect))
    area_ratio = _rect_area(rect) / page_area
    return (
        area_ratio >= 0.86 or
        (rect.width >= page_rect.width * 0.96 and rect.height >= page_rect.height * 0.80) or
        (rect.width >= page_rect.width * 0.80 and rect.height >= page_rect.height * 0.96)
    )


def _union_rects(rects: list[fitz.Rect]) -> fitz.Rect:
    union = fitz.Rect(rects[0])
    for rect in rects[1:]:
        union |= rect
    return union


def _drawing_components(rects: list[fitz.Rect], page_rect: fitz.Rect) -> list[list[fitz.Rect]]:
    merge_gap = max(8.0, min(page_rect.width, page_rect.height) * 0.04)
    components: list[list[fitz.Rect]] = []
    for rect in rects:
        placed = False
        for component in components:
            if any(_rect_distance(rect, existing) <= merge_gap or not (rect & existing).is_empty for existing in component):
                component.append(rect)
                placed = True
                break
        if not placed:
            components.append([rect])

    changed = True
    while changed:
        changed = False
        merged: list[list[fitz.Rect]] = []
        for component in components:
            target = None
            component_union = _union_rects(component)
            for candidate in merged:
                candidate_union = _union_rects(candidate)
                if _rect_distance(component_union, candidate_union) <= merge_gap or not (component_union & candidate_union).is_empty:
                    target = candidate
                    break
            if target is None:
                merged.append(component[:])
            else:
                target.extend(component)
                changed = True
        components = merged
    return components


def _dedupe_candidates(candidates: list[tuple[str, fitz.Rect]]) -> list[tuple[str, fitz.Rect]]:
    deduped: list[tuple[str, fitz.Rect]] = []
    for kind, rect in sorted(candidates, key=lambda item: _rect_area(item[1]), reverse=True):
        if any(_rect_iou(rect, existing) > 0.82 for _, existing in deduped):
            continue
        deduped.append((kind, rect))
    return deduped


def _caption_guided_drawing_candidates(lines: list[dict[str, Any]], component_rects: list[fitz.Rect], page_rect: fitz.Rect) -> list[tuple[str, fitz.Rect]]:
    candidates: list[tuple[str, fitz.Rect]] = []
    for line in lines:
        if not CAPTION_RE.search(line["text"]):
            continue
        caption_rect = line["bbox"]
        nearby: list[fitz.Rect] = []
        for rect in component_rects:
            vertical_gap = min(abs(caption_rect.y0 - rect.y1), abs(rect.y0 - caption_rect.y1))
            horizontal_overlap = max(0.0, min(caption_rect.x1, rect.x1) - max(caption_rect.x0, rect.x0))
            overlap_ratio = horizontal_overlap / max(1.0, min(caption_rect.width, rect.width))
            center_distance = abs(((rect.x0 + rect.x1) / 2.0) - ((caption_rect.x0 + caption_rect.x1) / 2.0))
            if vertical_gap <= 180 and (overlap_ratio >= 0.05 or center_distance <= page_rect.width * 0.45):
                nearby.append(rect)
        if len(nearby) < 2:
            continue
        union = _union_rects(nearby)
        if not _is_full_page_like(union, page_rect):
            candidates.append(("drawing", union))
    return candidates


def _drawing_candidates(page: fitz.Page, lines: list[dict[str, Any]] | None = None) -> list[tuple[str, fitz.Rect]]:
    try:
        drawings = page.get_drawings()
    except Exception:
        return []
    page_rect = page.rect
    rects = []
    for draw in drawings:
        raw = draw.get("rect")
        if not raw:
            continue
        rect = fitz.Rect(raw) & page_rect
        if rect.is_empty or _rect_area(rect) <= 50:
            continue
        if _is_full_page_like(rect, page_rect):
            continue
        rects.append(rect)
    if len(rects) < 4:
        return []
    components = _drawing_components(rects, page_rect)
    component_rects = [_union_rects(component) for component in components if len(component) >= 2]
    candidates = [
        ("drawing", rect)
        for rect in component_rects
        if not _is_full_page_like(rect, page_rect)
    ]
    if not candidates:
        union = _union_rects(rects)
        if not _is_full_page_like(union, page_rect):
            candidates.append(("drawing", union))
    if lines:
        candidates.extend(_caption_guided_drawing_candidates(lines, component_rects, page_rect))
    return _dedupe_candidates(candidates)


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
            raw_candidates = _image_candidates(page) + _drawing_candidates(page, lines)
            candidates = []
            for kind, rect in raw_candidates:
                rect &= page_rect
                area_ratio = _rect_area(rect) / page_area
                if area_ratio < min_area_ratio:
                    continue
                caption, caption_distance = _caption_match(lines, rect)
                if opts.get("skipRegisterTables", True) and _looks_register_table(caption, rect, page_rect):
                    continue
                candidates.append((1 if caption else 0, caption_distance, area_ratio, kind, rect, caption))
            candidates.sort(key=lambda item: (-item[0], item[1], -item[2]))
            for ordinal, (_, _, area_ratio, kind, rect, caption) in enumerate(candidates[:max_per_page], start=1):
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


def _load_structure_parser() -> Any:
    health = ocr_health()
    if not health["ocr"]["structure"]["available"]:
        return None
    with contextlib.redirect_stdout(sys.stderr):
        from paddleocr import PPStructureV3
        try:
            return PPStructureV3(
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
            )
        except TypeError:
            return PPStructureV3()


def _load_vl_parser() -> Any:
    health = ocr_health()
    if not health["ocr"]["vl"]["available"]:
        return None
    with contextlib.redirect_stdout(sys.stderr):
        from paddleocr import PaddleOCRVL
        try:
            return PaddleOCRVL(
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
            )
        except TypeError:
            return PaddleOCRVL()


def _jsonable(value: Any, depth: int = 0) -> Any:
    if depth > 8:
        return str(value)
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): _jsonable(item, depth + 1) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(item, depth + 1) for item in value]
    item = getattr(value, "item", None)
    if callable(item):
        with contextlib.suppress(Exception):
            return _jsonable(item(), depth + 1)
    json_value = getattr(value, "json", None)
    if callable(json_value):
        with contextlib.suppress(Exception):
            return _jsonable(json_value(), depth + 1)
    to_dict = getattr(value, "to_dict", None)
    if callable(to_dict):
        with contextlib.suppress(Exception):
            return _jsonable(to_dict(), depth + 1)
    return str(value)


def _collect_text_values(value: Any, texts: list[str], limit: int = 120) -> None:
    if len(texts) >= limit:
        return
    if isinstance(value, str):
        text = re.sub(r"\s+", " ", value).strip()
        if text and len(text) <= 240 and text not in texts:
            texts.append(text)
        return
    if isinstance(value, dict):
        for key in ("text", "content", "label", "rec_text", "markdown"):
            if key in value:
                _collect_text_values(value[key], texts, limit)
        for item in value.values():
            _collect_text_values(item, texts, limit)
        return
    if isinstance(value, list):
        for item in value:
            _collect_text_values(item, texts, limit)


def _extract_parser_markdown(items: list[Any]) -> str:
    chunks: list[str] = []
    for item in items:
        if isinstance(item, dict):
            for key in ("markdown", "md", "markdown_text"):
                text = str(item.get(key) or "").strip()
                if text:
                    chunks.append(text)
    return "\n\n".join(chunks)[:120_000]


def _predict_with_parser(parser: Any, image_path: Path) -> list[Any]:
    with contextlib.redirect_stdout(sys.stderr):
        if hasattr(parser, "predict"):
            try:
                result = parser.predict(input=str(image_path))
            except TypeError:
                result = parser.predict(str(image_path))
        else:
            result = parser(str(image_path))
    if result is None:
        return []
    if isinstance(result, list):
        return result
    try:
        return list(result)
    except TypeError:
        return [result]


def _parser_unavailable(kind: str, capability: dict[str, Any], image_path: Path, filename: str, source: dict[str, Any], options: dict[str, Any] | None = None) -> dict[str, Any]:
    warning = capability.get("hint") or capability.get("reason") or f"{kind} parser unavailable"
    return {
        "schemaVersion": FIGURE_PARSE_SCHEMA_VERSION,
        "filename": filename,
        "generatedBy": f"python_worker.figure.{kind}",
        "createdAt": datetime.now().astimezone().isoformat(),
        "workerVersion": WORKER_VERSION,
        "source": source,
        "sourceFingerprint": source_fingerprint(source),
        "parser": kind,
        "engine": OCR_ENGINE,
        "imagePath": str(image_path),
        "page": int((options or {}).get("page") or 0),
        "bbox": list((options or {}).get("bbox") or []),
        "scale": float((options or {}).get("scale") or 1.0),
        "ok": False,
        "error_code": f"{kind.upper()}_PARSER_UNAVAILABLE",
        "message": capability.get("reason") or f"{kind} parser unavailable",
        "hint": capability.get("hint") or "",
        "itemCount": 0,
        "items": [],
        "plainText": "",
        "markdown": "",
        "warnings": [warning],
    }


def parse_figure_image(
    image_path: Path,
    pdf_path: Path,
    filename: str,
    output_path: Path,
    kind: str,
    options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    source = source_info(pdf_path)
    health = ocr_health()
    capability = health["ocr"].get(kind, {})
    if not capability.get("available"):
        artifact = _parser_unavailable(kind, capability, image_path, filename, source, options)
        atomic_write_json(output_path, artifact)
        return artifact

    try:
        parser = _load_structure_parser() if kind == "structure" else _load_vl_parser()
        if parser is None:
            artifact = _parser_unavailable(kind, capability, image_path, filename, source, options)
            atomic_write_json(output_path, artifact)
            return artifact
        raw_items = _predict_with_parser(parser, image_path)
        items = [_jsonable(item) for item in raw_items]
        texts: list[str] = []
        _collect_text_values(items, texts)
        markdown = _extract_parser_markdown(items)
        artifact = {
            "schemaVersion": FIGURE_PARSE_SCHEMA_VERSION,
            "filename": filename,
            "generatedBy": f"python_worker.figure.{kind}",
            "createdAt": datetime.now().astimezone().isoformat(),
            "workerVersion": WORKER_VERSION,
            "source": source,
            "sourceFingerprint": source_fingerprint(source),
            "parser": kind,
            "engine": OCR_ENGINE,
            "imagePath": str(image_path),
            "page": int((options or {}).get("page") or 0),
            "bbox": list((options or {}).get("bbox") or []),
            "scale": float((options or {}).get("scale") or 1.0),
            "ok": True,
            "itemCount": len(items),
            "items": items,
            "plainText": " ".join(texts[:80]).strip(),
            "markdown": markdown,
            "warnings": ["PaddleOCR-VL graph edges are unverified until cross-checked."] if kind == "vl" else [],
        }
    except Exception as error:
        artifact = {
            "schemaVersion": FIGURE_PARSE_SCHEMA_VERSION,
            "filename": filename,
            "generatedBy": f"python_worker.figure.{kind}",
            "createdAt": datetime.now().astimezone().isoformat(),
            "workerVersion": WORKER_VERSION,
            "source": source,
            "sourceFingerprint": source_fingerprint(source),
            "parser": kind,
            "engine": OCR_ENGINE,
            "imagePath": str(image_path),
            "page": int((options or {}).get("page") or 0),
            "bbox": list((options or {}).get("bbox") or []),
            "scale": float((options or {}).get("scale") or 1.0),
            "ok": False,
            "error_code": f"{kind.upper()}_PARSER_FAILED",
            "message": str(error),
            "hint": capability.get("hint") or "",
            "itemCount": 0,
            "items": [],
            "plainText": "",
            "markdown": "",
            "warnings": [f"{kind} parser failed: {error}"],
        }
    atomic_write_json(output_path, artifact)
    return artifact


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
    checkpoint_path: Path | None = None,
    existing_artifact_path: Path | None = None,
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
    entries = figures_data.get("figures", [])
    total = len(entries)
    dpi = int(opts.get("dpi", 200))
    force = bool(opts.get("force", False))
    concurrency = max(1, min(2, int(opts.get("ocrConcurrency") or opts.get("ocr_concurrency") or 1)))
    source_fp = source_fingerprint(source)

    def load_json(path_value: Path | None) -> dict[str, Any] | None:
        if not path_value or not path_value.exists():
            return None
        try:
            return orjson.loads(path_value.read_bytes())
        except Exception:
            return None

    def figure_uid(figure: dict[str, Any]) -> str:
        return str(figure.get("figureUid") or figure.get("figure_uid") or figure.get("id") or "").strip()

    def normalized_bbox(figure: dict[str, Any]) -> list[float]:
        try:
            return [round(float(value), 2) for value in list(figure.get("bbox") or [])[:4]]
        except Exception:
            return []

    def figure_cache_key(figure: dict[str, Any]) -> str:
        payload = {
            "source": source_fp,
            "engine": OCR_ENGINE,
            "dpi": dpi,
            "id": figure_uid(figure),
            "page": int(figure.get("page") or 0),
            "bbox": normalized_bbox(figure),
            "renderPath": str(figure.get("renderPath") or figure.get("render_path") or ""),
        }
        return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()[:32]

    def rows_by_cache_key(*artifacts: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
        rows: dict[str, dict[str, Any]] = {}
        for artifact in artifacts:
            if not artifact or not isinstance(artifact.get("figures"), list):
                continue
            if artifact.get("engine") and artifact.get("engine") != OCR_ENGINE:
                continue
            if artifact.get("dpi") and int(artifact.get("dpi", 0)) != dpi:
                continue
            if artifact.get("sourceFingerprint") and artifact.get("sourceFingerprint") != source_fp:
                continue
            for row in artifact.get("figures", []):
                if not isinstance(row, dict):
                    continue
                key = str(row.get("cacheKey") or row.get("cache_key") or "").strip()
                if not key:
                    key = figure_cache_key(row)
                rows[key] = row
        return rows

    def artifact_for_rows(rows: list[dict[str, Any]], partial: bool = False, cached: bool = False, cache_stats: dict[str, Any] | None = None) -> dict[str, Any]:
        artifact = {
            "schemaVersion": FIGURE_OCR_SCHEMA_VERSION,
            "schema_version": FIGURE_OCR_SCHEMA_VERSION,
            "filename": filename,
            "generatedBy": "python_worker.figure_ocr.build",
            "generated_by": "python_worker.ocr_figures",
            "createdAt": datetime.now().astimezone().isoformat(),
            "workerVersion": WORKER_VERSION,
            "source": source,
            "sourceFingerprint": source_fp,
            "engine": OCR_ENGINE,
            "mode": "figures_only",
            "dpi": dpi,
            "figureCount": len(entries),
            "figureOcrCount": len(rows),
            "cached": cached,
            "cacheStats": cache_stats or {},
            "figures": rows,
        }
        if partial:
            artifact["partial"] = True
        return artifact

    def write_checkpoint(rows: list[dict[str, Any]], cache_stats: dict[str, Any]) -> None:
        if checkpoint_path:
            atomic_write_json(checkpoint_path, artifact_for_rows(rows, partial=True, cache_stats=cache_stats))

    cached_rows = {} if force else rows_by_cache_key(
        load_json(existing_artifact_path),
        load_json(output_path),
        load_json(checkpoint_path),
    )
    result_by_index: dict[int, dict[str, Any]] = {}
    pending: list[tuple[int, dict[str, Any], str]] = []
    cache_stats = {"reused": 0, "processed": 0, "total": total, "checkpointPath": str(checkpoint_path) if checkpoint_path else ""}
    for index, figure in enumerate(entries, start=1):
        key = figure_cache_key(figure)
        cached_row = cached_rows.get(key)
        if cached_row:
            result_by_index[index] = {**cached_row, "cacheHit": True, "cache_hit": True}
            cache_stats["reused"] += 1
        else:
            pending.append((index, figure, key))

    def process_figure(index: int, figure: dict[str, Any], key: str, shared_ocr: Any = None) -> tuple[int, dict[str, Any]]:
        check_cancel(cancel_path)
        render_path_value = figure.get("renderPath") or figure.get("render_path")
        render_path = Path(render_path_value)
        if not render_path.is_absolute():
            render_path = Path.cwd() / render_path
        if not render_path.exists():
            with fitz.open(pdf_path) as document:
                page = document.load_page(int(figure["page"]) - 1)
                _render_region(page, _rect_from_bbox(figure.get("bbox")), render_path, dpi, force=True)
        ocr_instance = shared_ocr or _load_paddleocr()
        ocr_text, confidence_avg, tokens = _ocr_image(ocr_instance, str(render_path))
        uid = figure_uid(figure)
        return index, {
            "figureUid": uid,
            "figure_uid": uid,
            "id": uid,
            "page": figure.get("page"),
            "caption": figure.get("caption", ""),
            "bbox": figure.get("bbox", []),
            "cacheKey": key,
            "cache_key": key,
            "cacheHit": False,
            "cache_hit": False,
            "ocrText": ocr_text,
            "ocr_text": ocr_text,
            "confidenceAvg": confidence_avg,
            "confidence_avg": confidence_avg,
            "tokens": tokens,
            "sourceType": "figure_ocr",
            "source_type": "figure_ocr",
            "renderPath": figure.get("renderPath") or figure.get("render_path"),
            "render_path": figure.get("renderPath") or figure.get("render_path"),
        }

    completed = len(result_by_index)
    if pending:
        if concurrency == 1:
            ocr = _load_paddleocr()
            for index, figure, key in pending:
                result_index, row = process_figure(index, figure, key, ocr)
                result_by_index[result_index] = row
                cache_stats["processed"] += 1
                completed += 1
                rows = [result_by_index[key] for key in sorted(result_by_index)]
                write_checkpoint(rows, cache_stats)
                if progress and (completed == 1 or completed == total or completed % 5 == 0):
                    progress(completed, total)
        else:
            with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as executor:
                futures = [executor.submit(process_figure, index, figure, key, None) for index, figure, key in pending]
                for future in concurrent.futures.as_completed(futures):
                    check_cancel(cancel_path)
                    result_index, row = future.result()
                    result_by_index[result_index] = row
                    cache_stats["processed"] += 1
                    completed += 1
                    rows = [result_by_index[key] for key in sorted(result_by_index)]
                    write_checkpoint(rows, cache_stats)
                    if progress and (completed == 1 or completed == total or completed % 5 == 0):
                        progress(completed, total)
    elif progress:
        progress(total, total)

    figures = [result_by_index[key] for key in sorted(result_by_index)]
    artifact = artifact_for_rows(figures, cached=(cache_stats["processed"] == 0), cache_stats=cache_stats)
    atomic_write_json(output_path, artifact)
    if checkpoint_path:
        checkpoint_path.unlink(missing_ok=True)
    return artifact
