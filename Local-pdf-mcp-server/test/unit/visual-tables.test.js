import test from "node:test";
import assert from "node:assert/strict";
import { classifyVisualTableCaption, extractTableCaptionsFromPageText, figureMatchesFilter, visualTableRecordFromCaption } from "../../src/domains/figures.js";

const synthetic = `
Table 8.2-5 Data Formats Handled in the SCU
24-bit stereo data, multichannel data
31 8 7 0
MSB LSB X X X X
16-bit stereo data, multichannel data
31 16 15 0
MSB LSB MSB LSB
Lch Rch

Table 4.1-2 Transfer Frame Format
31 24 23 16 15 8 7 0
Header ID Length CRC
MSB LSB

Table 12.3-1 Read Cycle Timing
CLK
CS#
RD#
DATA
setup time
hold time

Table 6.5-3 Initialization Sequence
Reset release -> Clock enable -> Register setup -> Start operation

Table A.1:
Short Continuation Title
ordinary text without visual signals
`;

test("caption scanner detects generic formal table captions", () => {
  const captions = extractTableCaptionsFromPageText(synthetic, 7, { filename: "manual.pdf", sourceFingerprint: "1:2", headings: ["Audio"] });
  assert.equal(captions.length, 5);
  assert.deepEqual(captions.map((c) => c.number), ["8.2-5", "4.1-2", "12.3-1", "6.5-3", "A.1"]);
  assert.equal(captions[4].title, "Short Continuation Title");
  for (const caption of captions) {
    assert.ok(caption.table_caption_id.startsWith("tblcap-p7-"));
    assert.equal(caption.source, "table-caption-regex");
    assert.ok(Array.isArray(caption.contextLines));
  }
});

test("classifier marks bit, format, timing, and sequence visual tables conservatively", () => {
  const captions = extractTableCaptionsFromPageText(synthetic, 7, { filename: "manual.pdf", sourceFingerprint: "1:2" });
  const byNumber = Object.fromEntries(captions.map((c) => [c.number, classifyVisualTableCaption(c)]));
  assert.equal(byNumber["8.2-5"].artifact_type, "visual-table");
  assert.match(byNumber["8.2-5"].kind, /bit-layout|format-diagram|layout-table/);
  assert.equal(byNumber["4.1-2"].artifact_type, "visual-table");
  assert.match(byNumber["4.1-2"].kind, /bit-layout|format-diagram/);
  assert.equal(byNumber["12.3-1"].kind, "timing-visual-table");
  assert.equal(byNumber["6.5-3"].kind, "sequence-visual-table");
  const unknown = extractTableCaptionsFromPageText("Table 2.1 Ordinary Values\nPlain scalar list", 1)[0];
  assert.equal(classifyVisualTableCaption(unknown).artifact_type, "table-caption");
});

test("visual table records are figure-manifest compatible and searchable by kind/title", () => {
  const captions = extractTableCaptionsFromPageText(synthetic, 3, { filename: "manual.pdf", sourceFingerprint: "1:2" });
  const records = captions.filter((c) => c.number !== "A.1").map((caption, i) => visualTableRecordFromCaption("manual.pdf", caption, i + 1)).filter(Boolean);
  assert.equal(records.length, 4);
  for (const record of records) {
    assert.equal(record.type, "Table");
    assert.equal(record.artifact_type, "visual-table");
    assert.deepEqual(record.bbox, []);
    assert.equal(record.render.status, "missing");
    assert.equal(record.image_access.agent_should_open_as_image, true);
    assert.equal(figureMatchesFilter(record, { kind: "visual-table" }), true);
    assert.equal(figureMatchesFilter(record, { kind: "table" }), true);
    assert.match(record.searchText, new RegExp(record.title.toLowerCase().split(/\s+/)[0]));
  }
  assert.equal(figureMatchesFilter(records.find((r) => r.kind === "timing-visual-table"), { kind: "timing-visual-table" }), true);
});
