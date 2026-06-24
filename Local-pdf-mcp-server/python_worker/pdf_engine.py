from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Callable

import fitz

from .protocol import atomic_write_json, check_cancel


def library_versions() -> dict[str, str]:
    import orjson

    return {"python": __import__("platform").python_version(), "pymupdf": fitz.VersionBind, "orjson": orjson.__version__}


def peak_rss_bytes() -> int:
    import os
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes

            class ProcessMemoryCounters(ctypes.Structure):
                _fields_ = [
                    ("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD),
                    ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t),
                ]
            counters = ProcessMemoryCounters()
            counters.cb = ctypes.sizeof(counters)
            get_current_process = ctypes.windll.kernel32.GetCurrentProcess
            get_current_process.restype = wintypes.HANDLE
            get_process_memory_info = ctypes.windll.psapi.GetProcessMemoryInfo
            get_process_memory_info.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessMemoryCounters), wintypes.DWORD]
            get_process_memory_info.restype = wintypes.BOOL
            process = get_current_process()
            if get_process_memory_info(process, ctypes.byref(counters), counters.cb):
                return int(counters.PeakWorkingSetSize)
        except Exception:
            return 0
    try:
        import resource
        value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return int(value * (1024 if __import__("sys").platform != "darwin" else 1))
    except Exception:
        return 0


def source_info(pdf_path: Path) -> dict[str, Any]:
    stat = pdf_path.stat()
    return {
        "size": stat.st_size,
        "mtimeMs": round(stat.st_mtime * 1000),
        "mtime": __import__("datetime").datetime.fromtimestamp(stat.st_mtime).astimezone().isoformat(),
    }


def source_fingerprint(source: dict[str, Any]) -> str:
    return f"size={int(source.get('size', 0))};mtimeMs={round(float(source.get('mtimeMs', 0)))}"


def normalize_text(value: str) -> str:
    return "\n".join(line.rstrip() for line in str(value or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")).strip()


def inspect_pdf(pdf_path: Path) -> dict[str, Any]:
    with fitz.open(pdf_path) as document:
        return {"pageCount": document.page_count, "metadata": document.metadata or {}, "source": source_info(pdf_path)}


def extract_pages(
    pdf_path: Path,
    start_page: int = 1,
    end_page: int | None = None,
    progress: Callable[[int, int], None] | None = None,
    cancel_path: str | None = None,
) -> dict[str, Any]:
    pages: list[dict[str, Any]] = []
    with fitz.open(pdf_path) as document:
        total_pages = document.page_count
        start = max(1, min(int(start_page or 1), total_pages))
        end = max(start, min(int(end_page or total_pages), total_pages))
        total = end - start + 1
        for offset, page_number in enumerate(range(start, end + 1), start=1):
            check_cancel(cancel_path)
            page = document.load_page(page_number - 1)
            pages.append({"page": page_number, "text": normalize_text(page.get_text("text", sort=True))})
            if progress and (offset == 1 or offset == total or offset % 10 == 0):
                progress(offset, total)
    return {"pageCount": total_pages, "startPage": start, "endPage": end, "pages": pages}


def build_pages_cache(
    pdf_path: Path,
    filename: str,
    artifact_path: Path,
    checkpoint_path: Path | None,
    progress: Callable[[int, int], None] | None = None,
    cancel_path: str | None = None,
    checkpoint_every: int = 50,
) -> dict[str, Any]:
    import orjson

    source = source_info(pdf_path)
    existing: dict[int, dict[str, Any]] = {}
    if checkpoint_path and checkpoint_path.exists():
        try:
            partial = orjson.loads(checkpoint_path.read_bytes())
            if partial.get("schemaVersion") == 1 and partial.get("filename") == filename and partial.get("source") == source:
                existing = {int(page["page"]): page for page in partial.get("pages", []) if page.get("page")}
        except Exception:
            existing = {}

    with fitz.open(pdf_path) as document:
        total = document.page_count
        for page_number in range(1, total + 1):
            check_cancel(cancel_path)
            if page_number not in existing:
                page = document.load_page(page_number - 1)
                existing[page_number] = {"page": page_number, "text": normalize_text(page.get_text("text", sort=True))}
            if progress and (page_number == 1 or page_number == total or page_number % 10 == 0):
                progress(page_number, total)
            if checkpoint_path and (page_number == total or page_number % max(10, checkpoint_every) == 0):
                atomic_write_json(checkpoint_path, {
                    "schemaVersion": 1, "partial": True, "filename": filename, "source": source,
                    "pageCount": total, "pages": [existing[key] for key in sorted(existing)],
                })
    artifact = {
        "schemaVersion": 1, "filename": filename,
        "createdAt": __import__("datetime").datetime.now().astimezone().isoformat(),
        "source": source, "pageCount": len(existing), "pages": [existing[key] for key in sorted(existing)],
    }
    atomic_write_json(artifact_path, artifact)
    if checkpoint_path:
        checkpoint_path.unlink(missing_ok=True)
    return artifact


def page_words(page: fitz.Page) -> list[dict[str, Any]]:
    words = []
    for raw in page.get_text("words", sort=True):
        x0, y0, x1, y1, text, block_no, line_no, word_no = raw[:8]
        words.append({
            "text": str(text), "x0": round(float(x0), 2), "y0": round(float(y0), 2),
            "x1": round(float(x1), 2), "y1": round(float(y1), 2),
            "block": int(block_no), "line": int(line_no), "word": int(word_no),
        })
    return words


def words_to_rows(words: list[dict[str, Any]], tolerance: float = 2.5) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for word in words:
        row = next((item for item in rows if abs(item["y"] - word["y0"]) <= tolerance), None)
        if row is None:
            row = {"y": word["y0"], "words": []}
            rows.append(row)
        row["words"].append(word)
    rows.sort(key=lambda item: item["y"])
    normalized = []
    for row in rows:
        ordered = sorted(row["words"], key=lambda item: item["x0"])
        cells: list[dict[str, Any]] = []
        current: dict[str, Any] | None = None
        for word in ordered:
            if current is None or word["x0"] - current["x1"] > 14:
                if current:
                    cells.append(current)
                current = {"text": word["text"], "x0": word["x0"], "y0": word["y0"], "x1": word["x1"], "y1": word["y1"]}
            else:
                current["text"] += " " + word["text"]
                current["x1"] = max(current["x1"], word["x1"])
                current["y1"] = max(current["y1"], word["y1"])
        if current:
            cells.append(current)
        normalized.append({"y": row["y"], "cells": cells, "text": " | ".join(cell["text"] for cell in cells)})
    return normalized


TABLE_SIGNAL = re.compile(r"\b(register|offset|initial value|access size|bit name|description|pin name|function|restriction|caution)\b", re.I)


def table_like_rows(page: fitz.Page) -> list[dict[str, Any]]:
    return [row for row in words_to_rows(page_words(page)) if len(row["cells"]) >= 3 or TABLE_SIGNAL.search(row["text"])]
