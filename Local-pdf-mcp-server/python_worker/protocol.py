from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any

from . import PROTOCOL_VERSION, WORKER_VERSION


class WorkerError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def emit(event_type: str, request_id: str, **payload: Any) -> None:
    event = {
        "protocolVersion": PROTOCOL_VERSION,
        "workerVersion": WORKER_VERSION,
        "requestId": request_id,
        "type": event_type,
        **payload,
    }
    sys.stdout.write(json.dumps(event, ensure_ascii=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def log(message: str) -> None:
    sys.stderr.write(str(message).rstrip() + "\n")
    sys.stderr.flush()


def ensure_inside(path_value: str, roots: list[str], label: str) -> Path:
    candidate = Path(path_value).resolve()
    for root_value in roots:
        root = Path(root_value).resolve()
        try:
            candidate.relative_to(root)
            return candidate
        except ValueError:
            continue
    raise WorkerError("PATH_OUTSIDE_ROOT", f"{label} is outside allowed roots")


def ensure_regular_file_inside(path_value: str, roots: list[str], label: str) -> Path:
    """Reject symlinks/junctions and non-files before a worker reads input bytes."""
    lexical = Path(os.path.abspath(os.fspath(path_value)))
    is_junction = getattr(lexical, "is_junction", lambda: False)
    if lexical.is_symlink() or is_junction():
        raise WorkerError(
            "UNSAFE_INPUT_PATH",
            f"{label}: symbolic links and reparse points are not allowed",
        )
    if not lexical.is_file():
        raise WorkerError("INVALID_INPUT_FILE", f"{label}: expected a regular file")
    return ensure_inside(str(lexical), roots, label)


def check_cancel(cancel_path: str | None) -> None:
    if cancel_path and Path(cancel_path).exists():
        raise WorkerError("WORKER_CANCELLED", "Worker cancellation requested")


def sha256_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_write_json(file_path: Path, value: Any) -> None:
    import orjson

    file_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = file_path.with_name(f"{file_path.name}.tmp-{os.getpid()}")
    data = orjson.dumps(value, option=orjson.OPT_INDENT_2 | orjson.OPT_APPEND_NEWLINE)
    with temp_path.open("wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp_path, file_path)


def artifact_descriptor(kind: str, file_path: Path, schema_version: int, count: int) -> dict[str, Any]:
    return {
        "kind": kind,
        "tempPath": str(file_path),
        "schemaVersion": schema_version,
        "count": int(count),
        "sizeBytes": file_path.stat().st_size,
        "sha256": sha256_file(file_path),
    }
