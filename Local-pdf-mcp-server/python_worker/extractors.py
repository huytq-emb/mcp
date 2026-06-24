from __future__ import annotations

import re
import contextlib
import io
from pathlib import Path
from typing import Any, Callable

import fitz

from .pdf_engine import source_fingerprint, source_info, table_like_rows
from .protocol import atomic_write_json, check_cancel


REGISTER_RE = re.compile(r"\b[A-Z][A-Za-z0-9]*m?_[A-Za-z0-9_]+(?:_n)?\b")
OFFSET_RE = re.compile(r"(?:\+\s*)?(?:0x[0-9A-Fa-f]+|[0-9A-Fa-f_]{2,12}h)\b")
BIT_RANGE_RE = re.compile(r"\b(\d{1,2})(?:\s*(?:to|:|-)\s*(\d{1,2}))?\b", re.I)
FIELD_RE = re.compile(r"\b([A-Z][A-Z0-9_]{1,31})(?:\[(\d{1,2}(?::\d{1,2})?)\])?(?=\W|$)")
ACCESS_RE = re.compile(r"\b(R\s*/\s*W|R\s*/\s*O|W\s*/\s*O|RW|RO|WO|R|W)\b", re.I)
RESET_RE = re.compile(r"\b(0x[0-9A-Fa-f]+|[0-9A-Fa-f_]+h|[01]+b|[01])\b")
ACCESS_SIZE_RE = re.compile(r"\b(8|16|32|64|128)\s*(?:bits?|bytes?)?\b", re.I)

NOISE_SYMBOLS = {
    "ACCESS", "ADDRESS", "BIT", "BITS", "BITFIELD", "BITNAME", "CAUTION", "CPU",
    "DESCRIPTION", "FIELD", "FIGURE", "FUNCTION", "G3E", "GLOBAL", "INITIAL",
    "NAME", "NOTE", "OFFSET", "PAGE", "RAM", "READ", "REGISTER", "RESERVED",
    "RESET", "RO", "RW", "R", "RZ", "TABLE", "UNDEFINED", "VALUE", "WO",
    "WRITE", "W",
}


def clean_cell(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").replace("\u00a0", " ")).strip()


def canonical(value: str) -> str:
    return re.sub(r"[^A-Z0-9]+", "", str(value or "").upper())


def infer_kind(text: str) -> str:
    lower = text.lower()
    if "bit name" in lower or ("bit" in lower and ("initial value" in lower or "r/w" in lower or "description" in lower)):
        return "bitfield-table"
    if "register" in lower and ("offset" in lower or "access size" in lower or "initial value" in lower):
        return "register-table"
    if ("pin" in lower or "port" in lower or "pfc" in lower) and ("function" in lower or "signal" in lower or "peripheral" in lower):
        return "pinmux-table"
    if "caution" in lower or "restriction" in lower:
        return "caution-table"
    return "table-candidate"


def row_bbox(cells: list[dict[str, Any]]) -> dict[str, float]:
    if not cells:
        return {"x": 0, "y": 0, "width": 0, "height": 0}
    x0 = min(float(cell.get("x0", 0)) for cell in cells)
    y0 = min(float(cell.get("y0", 0)) for cell in cells)
    x1 = max(float(cell.get("x1", 0)) for cell in cells)
    y1 = max(float(cell.get("y1", 0)) for cell in cells)
    return {"x": round(x0, 2), "y": round(y0, 2), "width": round(x1 - x0, 2), "height": round(y1 - y0, 2)}


def score_role(text: str, role: str) -> int:
    raw = str(text or "")
    lower = raw.lower()
    rules = {
        "bit": [r"\bbit\s*(?:position|number|no\.?)?\b", r"\bb\d+\b", r"^\s*\d{1,2}(?:\s*(?:to|:|-)\s*\d{1,2})?\s*$"],
        "bitfield": [r"\b(bit\s*name|field\s*name|bit\s*field)\b", r"\b[A-Z][A-Z0-9_]+\[\d"],
        "access": [r"\b(access|r\s*/\s*w|r\s*/\s*o|w\s*/\s*o|rw|ro|wo)\b"],
        "reset": [r"\b(initial\s*value|reset|default|value)\b", r"\b[0-9a-f_]+h\b", r"\b[01]+b?\b"],
        "description": [r"\b(description|function|operation|setting|meaning|remarks|note)\b"],
        "register": [r"\b(register\s*name|register|name)\b"],
        "abbreviation": [r"\b(abbreviation|symbol|short\s*name)\b", r"\b[A-Z][A-Za-z0-9]*m?_[A-Za-z0-9_]+"],
        "offset": [r"\b(offset\s*address|offset|address|base\s*\+)\b", r"\b[0-9a-f_]{3,12}h\b"],
        "accessSize": [r"\b(access\s*size|access\s*width|size|width|bits?)\b"],
        "pin": [r"\b(pin\s*name|pin\s*no|pin\s*number|pin|terminal)\b"],
        "port": [r"\b(port\s*name|port|gpio)\b"],
        "function": [r"\b(pin\s*function|alternate\s*function|function|selectable\s*function)\b"],
        "signal": [r"\b(signal\s*name|signal|peripheral\s*signal)\b"],
        "peripheral": [r"\b(peripheral|module|interface)\b"],
        "mode": [r"\b(mode|mux|select|sel|setting\s*value)\b"],
        "group": [r"\b(group|bank)\b"],
    }
    score = 0
    for pattern in rules.get(role, []):
        if re.search(pattern, lower if pattern.islower() else raw, re.I):
            score += 55
    if role == "description" and len(raw) > 28:
        score += 12
    return score


def infer_layout(rows: list[dict[str, Any]], columns: list[dict[str, Any]]) -> dict[str, Any]:
    roles = ["bit", "bitfield", "access", "reset", "description", "register", "abbreviation", "offset", "accessSize", "pin", "port", "function", "signal", "peripheral", "mode", "group"]
    header_candidates = []
    for index, row in enumerate(rows[:8]):
        joined = " ".join(clean_cell(cell) for cell in row.get("cells", []))
        score = sum(min(75, score_role(joined, role)) for role in roles)
        if len(row.get("cells", [])) >= 2:
            header_candidates.append({"rowIndex": index, "score": score, "text": joined})
    header = sorted(header_candidates, key=lambda item: item["score"], reverse=True)[0] if header_candidates else {"rowIndex": 0, "score": 0, "text": ""}
    header_index = int(header["rowIndex"])
    header_text = " ".join([header.get("text", ""), *[row.get("text", "") for row in rows[:6]]])
    kind_hint = infer_kind(header_text)

    column_roles = []
    column_count = max(len(columns), max((len(row.get("cells", [])) for row in rows), default=0))
    for col in range(column_count):
        samples = []
        for row in rows[max(0, header_index - 1): min(len(rows), header_index + 7)]:
            cells = row.get("cells", [])
            if col < len(cells) and clean_cell(cells[col]):
                samples.append(clean_cell(cells[col]))
        combined = " / ".join(samples[:8])
        scores = sorted(((role, score_role(combined, role)) for role in roles), key=lambda item: item[1], reverse=True)
        best_role, best_score = scores[0] if scores else ("unknown", 0)
        role = best_role if best_score >= 35 else "unknown"
        column_roles.append({
            "column": col,
            "x": columns[col]["x"] if col < len(columns) else 0,
            "role": role,
            "confidence": min(100, best_score),
            "ambiguous": best_score < 50,
            "header": samples[0] if samples else "",
            "samples": samples[:5],
        })

    fallback_by_kind = {
        "bitfield-table": ["bit", "bitfield", "access", "reset", "description"],
        "register-table": ["register", "abbreviation", "reset", "offset", "accessSize", "description"],
        "pinmux-table": ["pin", "function", "signal", "peripheral", "mode", "description"],
    }
    fallback = fallback_by_kind.get(kind_hint, [])
    for index, role in enumerate(fallback[:len(column_roles)]):
        if column_roles[index]["role"] == "unknown" or column_roles[index]["confidence"] < 60:
            column_roles[index]["role"] = role
            column_roles[index]["confidence"] = max(column_roles[index]["confidence"], 42)
            column_roles[index]["fallback"] = True

    role_map: dict[str, dict[str, Any]] = {}
    for column in column_roles:
        role = column["role"]
        if role == "unknown":
            continue
        if role not in role_map or column["confidence"] > role_map[role]["confidence"]:
            role_map[role] = column
    warnings = [f"column {col['column']} role {col['role']} is ambiguous" for col in column_roles if col.get("ambiguous")][:8]
    return {"headerRowIndex": header_index, "headerScore": header["score"], "columnRoles": column_roles, "roleMap": role_map, "kindHint": kind_hint, "warnings": warnings}


def cells_by_role(row: dict[str, Any], layout: dict[str, Any]) -> dict[str, str]:
    result: dict[str, str] = {}
    cells = row.get("cells", [])
    for column in layout.get("columnRoles", []):
        role = column.get("role")
        index = int(column.get("column", -1))
        if role == "unknown" or index < 0 or index >= len(cells):
            continue
        value = clean_cell(cells[index])
        if value:
            result[role] = clean_cell(" ".join([result.get(role, ""), value]))
    return result


def cell_by_role(row: dict[str, Any], layout: dict[str, Any], roles: str | list[str]) -> str:
    wanted = [roles] if isinstance(roles, str) else roles
    by_role = row.get("cellsByRole") or cells_by_role(row, layout)
    for role in wanted:
        value = by_role.get(role)
        if value:
            return value
    return ""


def table_from_rows(kind_seed: str, page_number: int, rows: list[dict[str, Any]], table_index: int, source: str) -> dict[str, Any]:
    header = " ".join(row.get("text", "") for row in rows[:3])
    anchors = sorted({round(float(cell.get("x0", 0)), 1) for row in rows for cell in row.get("cellObjects", [])})[:16]
    columns = [{"index": index, "x": anchor} for index, anchor in enumerate(anchors)]
    normalized_rows = []
    for row_index, row in enumerate(rows):
        cell_objects = row.get("cellObjects", [])
        cells = [clean_cell(cell.get("text", "")) for cell in cell_objects] if cell_objects else [clean_cell(cell) for cell in row.get("cells", [])]
        normalized_rows.append({
            "rowId": f"p{page_number}:t{table_index}:r{row_index}",
            "sourcePage": page_number,
            "y": row.get("y", 0),
            "text": clean_cell(row.get("text") or " | ".join(cells)),
            "cells": cells,
            "rawCells": cells,
            "isHeaderCandidate": row_index == 0,
            "bbox": row_bbox(cell_objects),
            "cellBboxes": [row_bbox([cell]) for cell in cell_objects] if cell_objects else [],
        })
    layout = infer_layout(normalized_rows, columns)
    for row in normalized_rows:
        row["cellsByRole"] = cells_by_role(row, layout)
    kind = layout.get("kindHint") if layout.get("kindHint") != "table-candidate" else kind_seed
    confidence = 78 if source == "pymupdf-native-table" else 62
    if kind == "table-candidate":
        confidence -= 18
    confidence += min(12, len(layout.get("roleMap", {})) * 2)
    warnings = list(layout.get("warnings", []))
    if source != "pymupdf-native-table":
        warnings.append("coordinate clustering fallback")
    return {
        "tableId": f"{kind}:p{page_number}-{page_number}:{table_index}",
        "kind": kind,
        "page": page_number,
        "pageStart": page_number,
        "pageEnd": page_number,
        "pages": [page_number],
        "headerText": header[:800],
        "headerSignature": re.sub(r"\W+", "|", header.lower())[:300],
        "columns": columns,
        "layout": layout,
        "confidence": max(1, min(98, confidence - len(warnings))),
        "warnings": warnings,
        "source": source,
        "segments": [{"page": page_number}],
        "rowCount": len(normalized_rows),
        "rows": normalized_rows,
    }


def native_tables_from_page(page: fitz.Page, page_number: int, start_index: int) -> list[dict[str, Any]]:
    if not hasattr(page, "find_tables"):
        return []
    try:
        chatter = io.StringIO()
        with contextlib.redirect_stdout(chatter):
            found = page.find_tables()
        native_tables = list(getattr(found, "tables", []) or [])
    except Exception:
        return []
    tables = []
    for table in native_tables:
        try:
            matrix = table.extract()
        except Exception:
            continue
        matrix = [[clean_cell(cell) for cell in row] for row in matrix or []]
        if len(matrix) < 2 or max((len(row) for row in matrix), default=0) < 2:
            continue
        bbox = tuple(getattr(table, "bbox", (0, 0, 0, 0)) or (0, 0, 0, 0))
        x0, y0, x1, y1 = [float(value) for value in bbox]
        row_height = (y1 - y0) / max(1, len(matrix)) if y1 > y0 else 12
        max_cols = max(len(row) for row in matrix)
        col_width = (x1 - x0) / max(1, max_cols) if x1 > x0 else 80
        rows = []
        for row_index, row in enumerate(matrix):
            cell_objects = []
            for col_index in range(max_cols):
                text = clean_cell(row[col_index] if col_index < len(row) else "")
                cell_objects.append({
                    "text": text,
                    "x0": round(x0 + col_index * col_width, 2),
                    "y0": round(y0 + row_index * row_height, 2),
                    "x1": round(x0 + (col_index + 1) * col_width, 2),
                    "y1": round(y0 + (row_index + 1) * row_height, 2),
                })
            rows.append({"y": round(y0 + row_index * row_height, 2), "cellObjects": cell_objects, "text": " | ".join(cell["text"] for cell in cell_objects)})
        tables.append(table_from_rows(infer_kind(" ".join(" ".join(row) for row in matrix[:3])), page_number, rows, start_index + len(tables), "pymupdf-native-table"))
    return tables


def coordinate_tables_from_page(page: fitz.Page, page_number: int, start_index: int) -> list[dict[str, Any]]:
    rows = table_like_rows(page)
    tables: list[dict[str, Any]] = []
    block: list[dict[str, Any]] = []

    def flush() -> None:
        if len(block) < 2:
            block.clear()
            return
        normalized = []
        for row in block:
            normalized.append({
                "y": row.get("y", 0),
                "cellObjects": [{**cell, "text": clean_cell(cell.get("text", ""))} for cell in row.get("cells", [])],
                "text": clean_cell(row.get("text", "")),
            })
        header = " ".join(row["text"] for row in normalized[:3])
        tables.append(table_from_rows(infer_kind(header), page_number, normalized, start_index + len(tables), "pymupdf-coordinate-table"))
        block.clear()

    previous_y: float | None = None
    for row in rows:
        if previous_y is not None and row["y"] - previous_y > 28:
            flush()
        block.append(row)
        previous_y = row["y"]
    flush()
    return tables


def extract_tables(
    pdf_path: Path,
    candidate_pages: list[int] | None = None,
    progress: Callable[[int, int], None] | None = None,
    cancel_path: str | None = None,
    checkpoint_path: Path | None = None,
    filename: str = "",
    checkpoint_every: int = 100,
) -> dict[str, Any]:
    tables: list[dict[str, Any]] = []
    completed: set[int] = set()
    source = source_info(pdf_path)
    if checkpoint_path and checkpoint_path.exists():
        try:
            import orjson
            partial = orjson.loads(checkpoint_path.read_bytes())
            if partial.get("schemaVersion") == 1 and partial.get("filename") == filename and partial.get("source") == source:
                tables = list(partial.get("tables", []))
                completed = {int(page) for page in partial.get("completedPages", [])}
        except Exception:
            tables = []
            completed = set()
    with fitz.open(pdf_path) as document:
        total_page_count = document.page_count
        pages = candidate_pages or list(range(1, document.page_count + 1))
        pages = sorted({int(page) for page in pages if 1 <= int(page) <= document.page_count})
        for offset, page_number in enumerate(pages, start=1):
            if page_number in completed:
                continue
            check_cancel(cancel_path)
            page = document.load_page(page_number - 1)
            page_tables = native_tables_from_page(page, page_number, len(tables))
            if not page_tables:
                page_tables = coordinate_tables_from_page(page, page_number, len(tables))
            tables.extend(page_tables)
            completed.add(page_number)
            if progress and (offset == 1 or offset == len(pages) or offset % 10 == 0):
                progress(offset, len(pages))
            if checkpoint_path and (len(completed) % max(10, checkpoint_every) == 0 or len(completed) == len(pages)):
                atomic_write_json(checkpoint_path, {
                    "schemaVersion": 1, "partial": True, "filename": filename, "source": source,
                    "candidatePages": pages, "completedPages": sorted(completed), "tables": tables,
                })
    if checkpoint_path:
        checkpoint_path.unlink(missing_ok=True)
    return {"pageCount": total_page_count, "candidatePages": pages, "tables": tables}


def _first_match(pattern: re.Pattern[str], text: str) -> str:
    match = pattern.search(text or "")
    return clean_cell(match.group(0)) if match else ""


def _first_non_unknown(values: list[str]) -> str:
    for value in values:
        cleaned = clean_cell(value)
        if cleaned and cleaned.lower() not in {"unknown", "n/a", "-"}:
            return cleaned
    return "unknown"


def build_registers(filename: str, source: dict[str, Any], tables: list[dict[str, Any]]) -> dict[str, Any]:
    entries: dict[str, dict[str, Any]] = {}
    for table in tables:
        if table.get("kind") != "register-table":
            continue
        layout = table.get("layout", {})
        header_index = int(layout.get("headerRowIndex", 0))
        for row in table.get("rows", [])[header_index + 1:]:
            text = clean_cell(row.get("text", ""))
            register_cell = cell_by_role(row, layout, ["abbreviation", "register"])
            register_match = REGISTER_RE.search(register_cell) or REGISTER_RE.search(text)
            if not register_match:
                continue
            name = clean_cell(register_match.group(0))
            page = int(row.get("sourcePage") or table.get("page") or 0)
            offset = _first_non_unknown([cell_by_role(row, layout, "offset"), _first_match(OFFSET_RE, text)])
            initial = _first_non_unknown([cell_by_role(row, layout, "reset"), _first_match(RESET_RE, text)])
            access_size = _first_non_unknown([cell_by_role(row, layout, "accessSize"), _first_match(ACCESS_SIZE_RE, text)])
            description = clean_cell(cell_by_role(row, layout, "description") or text.replace(name, ""))
            key = canonical(name)
            entry = entries.setdefault(key, {
                "name": key,
                "displayName": name,
                "filename": filename,
                "aliases": set([name, key]),
                "pages": set(),
                "chunks": [],
                "sections": [],
                "headings": set(),
                "descriptions": set(),
                "offsetAddresses": set(),
                "initialValues": set(),
                "accessSizes": set(),
                "sourceKinds": set(["python-tables-index"]),
                "occurrenceCount": 0,
                "confidence": 50,
                "evidence": [],
            })
            if page:
                entry["pages"].add(page)
            if description:
                entry["descriptions"].add(description)
            if offset != "unknown":
                entry["offsetAddresses"].add(offset)
            if initial != "unknown":
                entry["initialValues"].add(initial)
            if access_size != "unknown":
                entry["accessSizes"].add(access_size)
            entry["occurrenceCount"] += 1
            entry["confidence"] = min(98, max(entry["confidence"], 70 if offset != "unknown" else 58))
            entry["evidence"].append({"page": page, "quote": text[:500], "tableId": table.get("tableId"), "rowId": row.get("rowId")})

    registers = []
    for entry in entries.values():
        pages = sorted(entry["pages"])
        offsets = sorted(entry["offsetAddresses"])
        initials = sorted(entry["initialValues"])
        sizes = sorted(entry["accessSizes"])
        registers.append({
            "name": entry["name"],
            "displayName": entry["displayName"],
            "filename": filename,
            "aliases": sorted(entry["aliases"])[:32],
            "pages": pages,
            "page": pages[0] if pages else None,
            "chunks": entry["chunks"],
            "sections": entry["sections"],
            "headings": sorted(entry["headings"])[:12],
            "descriptions": sorted(entry["descriptions"])[:6],
            "offsetAddresses": offsets[:6],
            "initialValues": initials[:6],
            "accessSizes": sizes[:6],
            "offset": offsets[0] if offsets else "unknown",
            "reset": initials[0] if initials else "unknown",
            "accessSize": sizes[0] if sizes else "unknown",
            "sourceKinds": sorted(entry["sourceKinds"]),
            "isExplicitRegister": True,
            "occurrenceCount": entry["occurrenceCount"],
            "confidence": entry["confidence"],
            "canonicalName": entry["name"],
            "evidence": entry["evidence"][:8],
        })
    registers.sort(key=lambda item: (-item["confidence"], item["pages"][0] if item["pages"] else 999999, item["name"]))
    return {"schemaVersion": 1, "filename": filename, "source": source, "registerCount": len(registers), "registers": registers}


def parse_bit_semantics(row_text: str, bit_cell: str = "", field_cell: str = "") -> dict[str, str]:
    source = clean_cell(" ".join([bit_cell, field_cell, row_text]))
    bit_match = BIT_RANGE_RE.search(bit_cell) or BIT_RANGE_RE.search(row_text)
    if bit_match:
        high, low = bit_match.group(1), bit_match.group(2)
        bit_position = high if low is None else f"{high}:{low}"
    else:
        bit_position = "unknown"
    field_match = FIELD_RE.search(field_cell) or FIELD_RE.search(row_text)
    field_bits = field_match.group(2) if field_match and field_match.group(2) else "unknown"
    access = _first_match(ACCESS_RE, source).replace(" ", "").upper() or "unknown"
    reset = _first_match(RESET_RE, source) or "unknown"
    return {"bitPositionRange": bit_position, "fieldBitRange": field_bits, "bitRange": bit_position, "access": access, "reset": reset}


def concrete_register_from_text(text: str, known: list[str], fallback: str) -> str:
    canon_text = canonical(text)
    for name in known:
        if canonical(name) and canonical(name) in canon_text:
            return name
    return fallback


def bitfield_name_from_row(row_text: str, field_cell: str, register: str) -> str:
    candidates = [field_cell, row_text]
    for source in candidates:
        for match in FIELD_RE.finditer(source or ""):
            name = clean_cell(match.group(1))
            canon = canonical(name)
            if canon and canon not in NOISE_SYMBOLS and canon != canonical(register):
                return name
    return ""


def build_bitfields(filename: str, source: dict[str, Any], tables: list[dict[str, Any]], registers: dict[str, Any]) -> dict[str, Any]:
    fields_by_key: dict[str, dict[str, Any]] = {}
    current_register = "GLOBAL"
    known = [entry.get("displayName") or entry.get("name", "") for entry in registers.get("registers", [])]
    for table in tables:
        if table.get("kind") != "bitfield-table":
            continue
        layout = table.get("layout", {})
        header = clean_cell(table.get("headerText", ""))
        current_register = concrete_register_from_text(header, known, current_register)
        header_index = int(layout.get("headerRowIndex", 0))
        for row in table.get("rows", [])[header_index + 1:]:
            text = clean_cell(row.get("text", ""))
            register = concrete_register_from_text(text, known, current_register)
            bit_cell = cell_by_role(row, layout, "bit")
            field_cell = cell_by_role(row, layout, "bitfield")
            bitfield = bitfield_name_from_row(text, field_cell, register)
            semantics = parse_bit_semantics(text, bit_cell, field_cell)
            if not bitfield or semantics["bitPositionRange"] == "unknown":
                continue
            page = int(row.get("sourcePage") or table.get("page") or 0)
            key = f"{canonical(register)}:{canonical(bitfield)}:{semantics['bitPositionRange']}"
            mapping_status = "resolved" if register and register != "GLOBAL" else "unresolved"
            validation_issues = []
            if mapping_status != "resolved":
                validation_issues.append("register mapping unresolved")
            if semantics["access"] == "unknown":
                validation_issues.append("access unknown")
            if semantics["reset"] == "unknown":
                validation_issues.append("reset unknown")
            validation_status = "valid" if not validation_issues else "needs_verification"
            entry = fields_by_key.setdefault(key, {
                "id": f"{filename}:pybf{len(fields_by_key)}",
                "register": register or "GLOBAL",
                "sourceRegister": register or "GLOBAL",
                "canonicalRegister": canonical(register),
                "bitfield": bitfield,
                "canonicalBitfield": canonical(bitfield),
                "aliases": [],
                "bitPositionRange": semantics["bitPositionRange"],
                "fieldBitRange": semantics["fieldBitRange"],
                "bitRange": semantics["bitRange"],
                "access": semantics["access"],
                "reset": semantics["reset"],
                "pages": [],
                "page": page or None,
                "mappingStatus": mapping_status,
                "mappingConfidence": 70 if mapping_status == "resolved" else 35,
                "mappingReasons": ["python layout table context"],
                "validationStatus": validation_status,
                "validationIssues": validation_issues,
                "conflicts": [],
                "evidence": [],
                "evidenceLines": [],
                "chunks": [],
                "description": clean_cell(cell_by_role(row, layout, "description") or text),
                "confidence": 70 if validation_status == "valid" else 52,
                "score": 70 if validation_status == "valid" else 52,
                "source": "python-tables-index",
            })
            if page and page not in entry["pages"]:
                entry["pages"].append(page)
            entry["evidence"].append({"page": page, "quote": text[:500], "tableId": table.get("tableId"), "rowId": row.get("rowId")})
            entry["evidenceLines"].append(text[:500])
    fields = sorted(fields_by_key.values(), key=lambda item: (item["canonicalRegister"], item["bitPositionRange"], item["canonicalBitfield"]))
    quality = {
        "valid": sum(1 for field in fields if field["validationStatus"] == "valid"),
        "needsVerification": sum(1 for field in fields if field["validationStatus"] != "valid"),
        "conflict": 0,
        "unresolvedMapping": sum(1 for field in fields if field["mappingStatus"] != "resolved"),
        "rejectedNoise": 0,
    }
    return {"schemaVersion": 3, "filename": filename, "source": source, "bitfieldCount": len(fields), "quality": quality, "bitfields": fields}


def classify_caution(line: str) -> str:
    lower = line.lower()
    if "reserved" in lower:
        return "reserved-bits"
    if "clear" in lower and ("flag" in lower or "status" in lower):
        return "write-clear-status"
    if "clock" in lower or "pclk" in lower:
        return "clock"
    if "reset" in lower:
        return "reset"
    if "interrupt" in lower or "irq" in lower:
        return "irq"
    if "dma" in lower:
        return "dma"
    if "bus" in lower:
        return "bus"
    if "timing" in lower or "before" in lower or "after" in lower:
        return "timing"
    if "restriction" in lower or "prohibited" in lower or "must not" in lower or "do not" in lower:
        return "restriction"
    return "caution"


def build_cautions(filename: str, source: dict[str, Any], pages: list[dict[str, Any]]) -> dict[str, Any]:
    entries = []
    pattern = re.compile(r"\b(caution|restriction|prohibited|must not|do not|shall not|reserved|undefined|only when|before|after)\b", re.I)
    for page in pages:
        page_number = page.get("page")
        for line_index, line in enumerate(str(page.get("text", "")).splitlines()):
            text = clean_cell(line)
            if pattern.search(text) and 20 <= len(text) <= 1000:
                registers = REGISTER_RE.findall(text)
                category = classify_caution(text)
                entries.append({
                    "id": f"caution:p{page_number}:l{line_index}",
                    "page": page_number,
                    "text": text,
                    "kind": category,
                    "type": category,
                    "registers": registers[:8],
                    "confidence": 62 if registers else 55,
                    "evidence": [{"page": page_number, "quote": text}],
                    "source": "python-text-candidate",
                })
    return {"schemaVersion": 1, "filename": filename, "source": source, "cautionCount": len(entries), "cautions": entries}


def extract_pinmux_rows(tables: list[dict[str, Any]], filter_text: str = "") -> list[dict[str, Any]]:
    rows = []
    needle = canonical(filter_text)
    for table in tables:
        if table.get("kind") != "pinmux-table":
            continue
        layout = table.get("layout", {})
        header_index = int(layout.get("headerRowIndex", 0))
        for row in table.get("rows", [])[header_index + 1:]:
            pin = cell_by_role(row, layout, ["pin", "port"]) or "unknown"
            function = cell_by_role(row, layout, ["function", "signal", "peripheral", "mode"])
            signal = cell_by_role(row, layout, "signal")
            peripheral = cell_by_role(row, layout, "peripheral")
            mode = cell_by_role(row, layout, "mode")
            text = clean_cell(row.get("text", ""))
            haystack = canonical(" ".join([pin, function, signal, peripheral, mode, text]))
            if needle and needle not in haystack:
                continue
            if not function:
                continue
            rows.append({
                "pin": pin,
                "port": cell_by_role(row, layout, "port") or pin,
                "function": function,
                "signal": signal,
                "peripheral": peripheral,
                "mode": mode,
                "page": row.get("sourcePage") or table.get("page"),
                "confidence": 70,
                "evidence": text,
                "tableId": table.get("tableId"),
                "rowId": row.get("rowId"),
                "rawCells": row.get("rawCells") or row.get("cells", []),
                "cellsByRole": row.get("cellsByRole", {}),
            })
    return rows


def build_structured(filename: str, pdf_path: Path, pages_data: dict[str, Any], candidate_pages: list[int] | None, progress=None, cancel_path=None, checkpoint_path: Path | None = None) -> dict[str, Any]:
    source = source_info(pdf_path)
    extracted = extract_tables(pdf_path, candidate_pages, progress, cancel_path, checkpoint_path, filename, 100)
    tables = {
        "schemaVersion": 1, "filename": filename, "source": source,
        "pageCount": extracted["pageCount"], "candidatePageCount": len(extracted["candidatePages"]),
        "scannedPageCount": len(extracted["candidatePages"]), "candidatePages": extracted["candidatePages"],
        "tableCount": len(extracted["tables"]), "quality": {"accepted": len(extracted["tables"]), "rejectedNoise": 0, "stitched": 0},
        "tables": extracted["tables"],
    }
    registers = build_registers(filename, source, tables["tables"])
    bitfields = build_bitfields(filename, source, tables["tables"], registers)
    cautions = build_cautions(filename, source, pages_data.get("pages", []))
    pinmux = {"rows": extract_pinmux_rows(tables["tables"])}
    return {"sourceFingerprint": source_fingerprint(source), "tables": tables, "registers": registers, "bitfields": bitfields, "cautions": cautions, "pinmux": pinmux}
