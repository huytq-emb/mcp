from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from python_worker.figure_ocr import build_figure_ocr, extract_figures, ocr_health


def _json_stdout(value: dict) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    sys.stdout.flush()


def _pdf_filename(path_value: str) -> str:
    return Path(path_value).name


def main() -> int:
    parser = argparse.ArgumentParser(description="Local PDF worker CLI shim. This is not an MCP server.")
    parser.add_argument("--action", required=True, choices=["ocr_health", "extract_figures", "ocr_figures", "rebuild_figure_ocr"])
    parser.add_argument("--filename", default="")
    parser.add_argument("--figures", default="")
    parser.add_argument("--out", default="")
    parser.add_argument("--dpi", type=int, default=200)
    parser.add_argument("--min-area-ratio", type=float, default=0.03)
    parser.add_argument("--max-figures-per-page", type=int, default=8)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    try:
        if args.action == "ocr_health":
            _json_stdout({"ok": True, **ocr_health()})
            return 0

        if not args.filename:
            raise ValueError("--filename is required")
        if not args.out:
            raise ValueError("--out is required")
        pdf_path = (ROOT / args.filename).resolve() if not Path(args.filename).is_absolute() else Path(args.filename).resolve()
        filename = _pdf_filename(args.filename)
        out_path = (ROOT / args.out).resolve() if not Path(args.out).is_absolute() else Path(args.out).resolve()
        renders_root = ROOT / "renders"
        options = {
            "dpi": args.dpi,
            "minFigureAreaRatio": args.min_area_ratio,
            "maxFiguresPerPage": args.max_figures_per_page,
            "force": args.force,
        }

        if args.action == "extract_figures":
            artifact = extract_figures(pdf_path, filename, out_path, renders_root, options)
            _json_stdout({
                "ok": True,
                "action": args.action,
                "out": str(out_path),
                "schemaVersion": artifact.get("schemaVersion"),
                "figureCount": artifact.get("figureCount", 0),
                "sourceFingerprint": artifact.get("sourceFingerprint", ""),
            })
            return 0

        figures_path = Path(args.figures).resolve() if Path(args.figures).is_absolute() else (ROOT / args.figures).resolve()
        if args.action in {"ocr_figures", "rebuild_figure_ocr"}:
            artifact = build_figure_ocr(pdf_path, filename, figures_path, out_path, renders_root, options)
            if artifact.get("ok") is False:
                _json_stdout({"ok": False, "action": args.action, **artifact})
                return 0
            _json_stdout({
                "ok": True,
                "action": args.action,
                "out": str(out_path),
                "schemaVersion": artifact.get("schemaVersion"),
                "figureCount": artifact.get("figureCount", 0),
                "figureOcrCount": artifact.get("figureOcrCount", 0),
                "sourceFingerprint": artifact.get("sourceFingerprint", ""),
                "cached": bool(artifact.get("cached")),
            })
            return 0

        raise ValueError(f"Unsupported action: {args.action}")
    except Exception as error:  # noqa: BLE001 - CLI boundary reports all failures as JSON.
        sys.stderr.write(traceback.format_exc())
        _json_stdout({"ok": False, "action": args.action, "error": str(error)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
