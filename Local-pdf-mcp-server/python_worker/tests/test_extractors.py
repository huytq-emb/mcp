import unittest
import json
import tempfile
from pathlib import Path
from unittest.mock import patch

import fitz

from python_worker.extractors import build_bitfields, build_cautions, build_registers, extract_pinmux_rows, infer_kind, table_from_rows
from python_worker.figure_ocr import _ocr_image, build_figure_ocr, extract_figures, inspect_figure_basic, ocr_health, ocr_image_file, parse_figure_image, render_figure_crop
from python_worker.pdf_engine import peak_rss_bytes, words_to_rows


class ExtractorTests(unittest.TestCase):
    def test_words_to_rows_keeps_coordinates(self):
        rows = words_to_rows([
            {"text": "Bit", "x0": 10, "y0": 20, "x1": 25, "y1": 30},
            {"text": "Name", "x0": 60, "y0": 20, "x1": 90, "y1": 30},
        ])
        self.assertEqual(len(rows), 1)
        self.assertEqual([cell["text"] for cell in rows[0]["cells"]], ["Bit", "Name"])

    def test_table_kind_detection(self):
        self.assertEqual(infer_kind("Register Name Offset Address Access Size"), "register-table")
        self.assertEqual(infer_kind("Bit Name Initial Value Description"), "bitfield-table")
        self.assertEqual(infer_kind("Pin Name Function Signal"), "pinmux-table")

    def test_peak_rss_metric_is_available(self):
        self.assertGreater(peak_rss_bytes(), 0)

    def test_candidate_semantic_builders_preserve_evidence(self):
        reg_table = table_from_rows("register-table", 10, [
            {"y": 10, "cellObjects": [
                {"text": "Register Name", "x0": 1, "y0": 10, "x1": 20, "y1": 18},
                {"text": "Abbreviation", "x0": 40, "y0": 10, "x1": 60, "y1": 18},
                {"text": "Initial Value", "x0": 80, "y0": 10, "x1": 100, "y1": 18},
                {"text": "Offset Address", "x0": 120, "y0": 10, "x1": 140, "y1": 18},
                {"text": "Access Size", "x0": 160, "y0": 10, "x1": 180, "y1": 18},
            ], "text": "Register Name Abbreviation Initial Value Offset Address Access Size"},
            {"y": 25, "cellObjects": [
                {"text": "Watchdog Refresh Register", "x0": 1, "y0": 25, "x1": 20, "y1": 33},
                {"text": "WDTm_WDTRR", "x0": 40, "y0": 25, "x1": 60, "y1": 33},
                {"text": "00h", "x0": 80, "y0": 25, "x1": 100, "y1": 33},
                {"text": "000h", "x0": 120, "y0": 25, "x1": 140, "y1": 33},
                {"text": "8", "x0": 160, "y0": 25, "x1": 180, "y1": 33},
            ], "text": "Watchdog Refresh Register WDTm_WDTRR 00h 000h 8"},
        ], 0, "unit")
        tables = [reg_table]
        registers = build_registers("manual.pdf", {"size": 1, "mtimeMs": 2}, tables)
        self.assertEqual(registers["registerCount"], 1)
        self.assertEqual(registers["registers"][0]["offsetAddresses"], ["000h"])
        bit_table = table_from_rows("bitfield-table", 11, [
            {"y": 10, "cellObjects": [
                {"text": "Bit", "x0": 1, "y0": 10, "x1": 20, "y1": 18},
                {"text": "Bit Name", "x0": 40, "y0": 10, "x1": 60, "y1": 18},
                {"text": "R/W", "x0": 80, "y0": 10, "x1": 100, "y1": 18},
                {"text": "Initial Value", "x0": 120, "y0": 10, "x1": 140, "y1": 18},
                {"text": "Description", "x0": 160, "y0": 10, "x1": 180, "y1": 18},
            ], "text": "Bit Bit Name R/W Initial Value Description WDTm_WDTRR"},
            {"y": 25, "cellObjects": [
                {"text": "7", "x0": 1, "y0": 25, "x1": 20, "y1": 33},
                {"text": "AVEE", "x0": 40, "y0": 25, "x1": 60, "y1": 33},
                {"text": "R/W", "x0": 80, "y0": 25, "x1": 100, "y1": 33},
                {"text": "0", "x0": 120, "y0": 25, "x1": 140, "y1": 33},
                {"text": "enable", "x0": 160, "y0": 25, "x1": 180, "y1": 33},
            ], "text": "7 AVEE R/W 0 enable"},
            {"y": 40, "cellObjects": [
                {"text": "31 to 28", "x0": 1, "y0": 40, "x1": 20, "y1": 48},
                {"text": "LWCA[3:0]", "x0": 40, "y0": 40, "x1": 60, "y1": 48},
                {"text": "R/W", "x0": 80, "y0": 40, "x1": 100, "y1": 48},
                {"text": "0h", "x0": 120, "y0": 40, "x1": 140, "y1": 48},
                {"text": "word count", "x0": 160, "y0": 40, "x1": 180, "y1": 48},
            ], "text": "31 to 28 LWCA[3:0] R/W 0h word count"},
        ], 0, "unit")
        bit_tables = [bit_table]
        fields = build_bitfields("manual.pdf", {"size": 1, "mtimeMs": 2}, bit_tables, registers)
        by_name = {field["bitfield"]: field for field in fields["bitfields"]}
        self.assertEqual(by_name["AVEE"]["bitPositionRange"], "7")
        self.assertEqual(by_name["LWCA"]["bitPositionRange"], "31:28")
        self.assertEqual(by_name["LWCA"]["fieldBitRange"], "3:0")
        cautions = build_cautions("manual.pdf", {"size": 1, "mtimeMs": 2}, [{"page": 12, "text": "Caution: Do not write reserved bits."}])
        self.assertEqual(cautions["cautionCount"], 1)
        self.assertEqual(cautions["cautions"][0]["type"], "reserved-bits")

    def test_pinmux_rows_preserve_roles(self):
        table = table_from_rows("pinmux-table", 20, [
            {"y": 10, "cellObjects": [
                {"text": "Pin Name", "x0": 1, "y0": 10, "x1": 20, "y1": 18},
                {"text": "Function", "x0": 40, "y0": 10, "x1": 60, "y1": 18},
                {"text": "Peripheral", "x0": 80, "y0": 10, "x1": 100, "y1": 18},
            ], "text": "Pin Name Function Peripheral"},
            {"y": 25, "cellObjects": [
                {"text": "P10_0", "x0": 1, "y0": 25, "x1": 20, "y1": 33},
                {"text": "CANFD0_TX", "x0": 40, "y0": 25, "x1": 60, "y1": 33},
                {"text": "CANFD", "x0": 80, "y0": 25, "x1": 100, "y1": 33},
            ], "text": "P10_0 CANFD0_TX CANFD"},
        ], 0, "unit")
        rows = extract_pinmux_rows([table], "CANFD")
        self.assertEqual(rows[0]["pin"], "P10_0")
        self.assertEqual(rows[0]["function"], "CANFD0_TX")

    def test_ocr_health_is_non_fatal_when_optional_dependency_missing(self):
        health = ocr_health()
        self.assertTrue(health["ok"])
        self.assertIn("ocr", health)
        if not health["ocr"]["available"]:
            self.assertFalse(health["ocr"]["enabled"])
            self.assertIn("requirements-ocr.txt", health["ocr"]["hint"])

    def test_extract_figures_detects_large_vector_region_and_renders_clip(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pdf_path = root / "synthetic-figure.pdf"
            figures_path = root / "figures.json"
            renders_root = root / "renders"
            doc = fitz.open()
            page = doc.new_page(width=400, height=500)
            page.insert_text((80, 360), "Figure 1.1 Synthetic Block Diagram", fontsize=10)
            for index in range(8):
                x0 = 80 + (index % 4) * 55
                y0 = 140 + (index // 4) * 70
                page.draw_rect(fitz.Rect(x0, y0, x0 + 44, y0 + 42), color=(0, 0, 0), width=1)
            page.draw_line((102, 182), (245, 210), color=(0, 0, 0), width=1)
            doc.save(pdf_path)
            doc.close()

            artifact = extract_figures(pdf_path, pdf_path.name, figures_path, renders_root, {
                "minFigureAreaRatio": 0.03,
                "maxFiguresPerPage": 8,
                "dpi": 100,
            })
            self.assertGreaterEqual(artifact["figureCount"], 1)
            first = artifact["figures"][0]
            self.assertEqual(first["sourceType"], "pdf_figure_region")
            self.assertIn("Figure 1.1", first["caption"])
            self.assertTrue(Path(first["renderPath"]).exists())

    def test_extract_figures_rejects_full_page_drawing_and_prefers_caption_near_component(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pdf_path = root / "synthetic-split-figure.pdf"
            figures_path = root / "figures.json"
            renders_root = root / "renders"
            doc = fitz.open()
            page = doc.new_page(width=400, height=500)
            page.draw_rect(fitz.Rect(5, 5, 395, 495), color=(0, 0, 0), width=1)
            for index in range(4):
                x0 = 110 + (index % 2) * 54
                y0 = 170 + (index // 2) * 50
                page.draw_rect(fitz.Rect(x0, y0, x0 + 46, y0 + 42), color=(0, 0, 0), width=1)
            page.insert_text((90, 310), "Figure 2.1 Caption Near Component", fontsize=10)
            doc.save(pdf_path)
            doc.close()

            artifact = extract_figures(pdf_path, pdf_path.name, figures_path, renders_root, {
                "minFigureAreaRatio": 0.01,
                "maxFiguresPerPage": 4,
                "dpi": 80,
            })
            self.assertGreaterEqual(artifact["figureCount"], 1)
            first = artifact["figures"][0]
            x0, y0, x1, y1 = first["bbox"]
            self.assertLess(x1 - x0, 220)
            self.assertLess(y1 - y0, 180)
            self.assertIn("Figure 2.1", first["caption"])

    def test_render_figure_crop_writes_png_and_reports_cache_hit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pdf_path = root / "synthetic-render.pdf"
            output_path = root / "cache" / "figure.png"
            doc = fitz.open()
            page = doc.new_page(width=220, height=180)
            page.draw_rect(fitz.Rect(40, 40, 180, 130), color=(0, 0, 0), width=1)
            page.insert_text((78, 88), "DMA FIFO", fontsize=12)
            doc.save(pdf_path)
            doc.close()

            first = render_figure_crop(pdf_path, pdf_path.name, output_path, 1, [30, 30, 190, 145], 2.0, False)
            self.assertTrue(first["ok"])
            self.assertFalse(first["cache_hit"])
            self.assertEqual(first["width"], 320)
            self.assertTrue(output_path.exists())

            second = render_figure_crop(pdf_path, pdf_path.name, output_path, 1, [30, 30, 190, 145], 2.0, False)
            self.assertTrue(second["ok"])
            self.assertTrue(second["cache_hit"])

    def test_inspect_figure_basic_renders_and_keeps_ocr_soft_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pdf_path = root / "synthetic-inspect.pdf"
            output_path = root / "cache" / "figure.png"
            doc = fitz.open()
            page = doc.new_page(width=220, height=180)
            page.draw_rect(fitz.Rect(40, 40, 180, 130), color=(0, 0, 0), width=1)
            page.insert_text((78, 88), "DMA FIFO", fontsize=12)
            doc.save(pdf_path)
            doc.close()

            result = inspect_figure_basic(pdf_path, pdf_path.name, output_path, 1, [30, 30, 190, 145], 2.0, "none", False)
            self.assertTrue(result["ok"])
            self.assertTrue(result["render"]["ok"])
            self.assertTrue(output_path.exists())
            self.assertFalse(result["ocr"]["ok"])
            self.assertEqual(result["ocr"]["error_code"], "OCR_ENGINE_DISABLED")

    def test_ocr_image_parser_preserves_bbox_and_confidence(self):
        class FakeOcr:
            def ocr(self, image_path, cls=True):
                return [[[
                    [[10, 20], [30, 20], [30, 40], [10, 40]],
                    ("DMA", 0.96),
                ]]]

        plain_text, confidence_avg, tokens = _ocr_image(FakeOcr(), "unused.png", [100, 200, 200, 300], 2.0)
        self.assertEqual(plain_text, "DMA")
        self.assertEqual(confidence_avg, 0.96)
        self.assertEqual(tokens[0]["text"], "DMA")
        self.assertEqual(tokens[0]["image_bbox"], [10, 20, 30, 40])
        self.assertEqual(tokens[0]["bbox"], [105, 210, 115, 220])
        self.assertEqual(tokens[0]["confidence"], 0.96)

    def test_ocr_image_parser_supports_paddleocr_predict_result(self):
        class FakeOcr:
            def predict(self, image_path, **kwargs):
                return [{
                    "res": {
                        "rec_texts": ["DMA", "FIFO"],
                        "rec_scores": [0.96, 0.88],
                        "rec_boxes": [[10, 20, 30, 40], [40, 20, 80, 40]],
                    }
                }]

        plain_text, confidence_avg, tokens = _ocr_image(FakeOcr(), "unused.png", [100, 200, 200, 300], 2.0)
        self.assertEqual(plain_text, "DMA FIFO")
        self.assertEqual(confidence_avg, 0.92)
        self.assertEqual(tokens[0]["text"], "DMA")
        self.assertEqual(tokens[0]["bbox"], [105, 210, 115, 220])
        self.assertEqual(tokens[1]["image_bbox"], [40, 20, 80, 40])

    def test_ocr_image_file_engine_none_is_non_fatal(self):
        result = ocr_image_file(Path("unused.png"), "none")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error_code"], "OCR_ENGINE_DISABLED")
        self.assertEqual(result["engine"], "none")

    def test_figure_ocr_missing_dependency_returns_structured_status(self):
        health = ocr_health()
        if health["ocr"]["available"]:
            self.skipTest("PaddleOCR is installed in this environment")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pdf_path = root / "empty.pdf"
            figures_path = root / "figures.json"
            output_path = root / "figure_ocr.json"
            renders_root = root / "renders"
            doc = fitz.open()
            doc.new_page(width=200, height=200)
            doc.save(pdf_path)
            doc.close()
            figures_path.write_text('{"schemaVersion":1,"filename":"empty.pdf","figures":[]}', encoding="utf-8")
            result = build_figure_ocr(pdf_path, "empty.pdf", figures_path, output_path, renders_root)
            self.assertFalse(result["ok"])
            self.assertEqual(result["error"], "OCR dependency missing")
            self.assertIn("requirements-ocr.txt", result["hint"])
            self.assertFalse(output_path.exists())

    def test_ocr_health_reports_parser_capabilities(self):
        health = ocr_health()
        self.assertIn("text", health["ocr"])
        self.assertIn("structure", health["ocr"])
        self.assertIn("vl", health["ocr"])
        self.assertIn("available", health["ocr"]["text"])
        self.assertIn("available", health["ocr"]["structure"])
        self.assertIn("available", health["ocr"]["vl"])

    def test_structure_parser_unavailable_writes_structured_artifact(self):
        health = ocr_health()
        if health["ocr"]["structure"]["available"]:
            self.skipTest("PP-StructureV3 is installed in this environment")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pdf_path = root / "synthetic-structure.pdf"
            image_path = root / "figure.png"
            output_path = root / "structure.json"
            doc = fitz.open()
            page = doc.new_page(width=220, height=180)
            page.draw_rect(fitz.Rect(40, 40, 180, 130), color=(0, 0, 0), width=1)
            page.insert_text((78, 88), "DMA FIFO", fontsize=12)
            doc.save(pdf_path)
            doc.close()
            render_figure_crop(pdf_path, pdf_path.name, image_path, 1, [30, 30, 190, 145], 2.0, False)
            artifact = parse_figure_image(image_path, pdf_path, pdf_path.name, output_path, "structure", {"page": 1, "bbox": [30, 30, 190, 145], "scale": 2.0})
            self.assertFalse(artifact["ok"])
            self.assertEqual(artifact["schemaVersion"], 1)
            self.assertEqual(artifact["itemCount"], 0)
            self.assertIn("STRUCTURE_PARSER_UNAVAILABLE", artifact["error_code"])
            self.assertTrue(output_path.exists())

    def test_figure_ocr_reuses_unchanged_cached_rows(self):
        class FakeOcr:
            def __init__(self):
                self.calls = 0

            def ocr(self, image_path, cls=True):
                self.calls += 1
                return [[
                    [[[10, 10], [40, 10], [40, 25], [10, 25]], ("DMA", 0.95)],
                ]]

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pdf_path = root / "synthetic-incremental.pdf"
            figures_path = root / "figures.json"
            output_path = root / "figure_ocr.json"
            checkpoint_path = root / "figure_ocr.partial.json"
            renders_root = root / "renders"
            doc = fitz.open()
            page = doc.new_page(width=260, height=220)
            page.draw_rect(fitz.Rect(30, 30, 120, 110), color=(0, 0, 0), width=1)
            page.draw_rect(fitz.Rect(140, 30, 230, 110), color=(0, 0, 0), width=1)
            doc.save(pdf_path)
            doc.close()
            figures = {
                "schemaVersion": 1,
                "filename": pdf_path.name,
                "figures": [
                    {"id": "f1", "figureUid": "f1", "page": 1, "bbox": [25, 25, 125, 115], "caption": "Figure 1", "renderPath": str(renders_root / "f1.png")},
                    {"id": "f2", "figureUid": "f2", "page": 1, "bbox": [135, 25, 235, 115], "caption": "Figure 2", "renderPath": str(renders_root / "f2.png")},
                ],
            }
            figures_path.write_text(json.dumps(figures), encoding="utf-8")
            health = {"ok": True, "ocr": {"available": True, "enabled": True, "engine": "paddleocr"}}
            fake = FakeOcr()
            with patch("python_worker.figure_ocr.ocr_health", return_value=health), patch("python_worker.figure_ocr._load_paddleocr", return_value=fake):
                first = build_figure_ocr(pdf_path, pdf_path.name, figures_path, output_path, renders_root, {}, None, None, checkpoint_path)
                self.assertEqual(first["cacheStats"]["processed"], 2)
                self.assertEqual(first["cacheStats"]["reused"], 0)
                self.assertEqual(fake.calls, 2)
                self.assertFalse(checkpoint_path.exists())

                fake.calls = 0
                second = build_figure_ocr(pdf_path, pdf_path.name, figures_path, output_path, renders_root, {}, None, None, checkpoint_path)
                self.assertTrue(second["cached"])
                self.assertEqual(second["cacheStats"]["processed"], 0)
                self.assertEqual(second["cacheStats"]["reused"], 2)
                self.assertEqual(fake.calls, 0)


if __name__ == "__main__":
    unittest.main()
