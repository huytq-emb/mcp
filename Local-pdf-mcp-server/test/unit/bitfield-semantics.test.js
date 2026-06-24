import assert from "node:assert/strict";
import test from "node:test";
import {
  isLikelyBitfieldName,
  parseBitfieldSemantics,
  resolveBitfieldRegisterMapping,
} from "../../src/bitfields/semantics.js";

test("bitfield semantics parse physical and field-local ranges", () => {
  const parsed = parseBitfieldSemantics("31 to 28 LWCA[3:0] 0h RW Link Writeback CACHE", "LWCA");
  assert.equal(parsed.bitPositionRange, "31:28");
  assert.equal(parsed.fieldBitRange, "3:0");
  assert.equal(parsed.bitRange, "31:28");
  assert.equal(parsed.access, "R/W");
  assert.equal(parsed.reset, "0");
});

test("bitfield semantics parse single-bit rows", () => {
  const parsed = parseBitfieldSemantics("7 AVEE 0h RW Average Mode Enable", "AVEE");
  assert.equal(parsed.bitPositionRange, "7");
  assert.equal(parsed.fieldBitRange, "unknown");
  assert.equal(parsed.bitRange, "7");
  assert.equal(parsed.access, "R/W");
  assert.equal(parsed.reset, "0");
});

test("bitfield semantics ignore bracket ranges from other symbols", () => {
  const parsed = parseBitfieldSemantics("7 AVEE 0h RW ADC[2:0]", "AVEE");
  assert.equal(parsed.bitPositionRange, "7");
  assert.equal(parsed.fieldBitRange, "unknown");
  assert.equal(parsed.bitRange, "7");
});

test("bitfield resolver maps base pseudo-registers to page-local concrete registers", () => {
  const registerIndex = {
    registers: [
      { displayName: "DMACm_base", pages: [843], isExplicitRegister: true },
      { displayName: "DMACm_DCTRL", pages: [843], isExplicitRegister: true },
      { displayName: "RSPIm_SPCKD", pages: [2616], isExplicitRegister: true },
      { displayName: "ADCm_ADSTRGR", pages: [3467], isExplicitRegister: true },
    ],
  };
  assert.equal(resolveBitfieldRegisterMapping({ register: "DMACM_BASE", bitfield: "LWCA", page: 843 }, registerIndex).register, "DMACm_DCTRL");
  assert.equal(resolveBitfieldRegisterMapping({ register: "RSPIM_BASE", bitfield: "SCKDL", page: 2616 }, registerIndex).register, "RSPIm_SPCKD");
  assert.equal(resolveBitfieldRegisterMapping({ register: "ADCM_BASE", bitfield: "TRSA", page: 3467 }, registerIndex).register, "ADCm_ADSTRGR");
});

test("bitfield resolver leaves ambiguous page-local mappings unresolved", () => {
  const registerIndex = {
    registers: [
      { displayName: "RSPIm_SPCR", pages: [2630], isExplicitRegister: true },
      { displayName: "RSPIm_SPCR2", pages: [2630], isExplicitRegister: true },
    ],
  };
  const result = resolveBitfieldRegisterMapping({ register: "RSPIM_BASE", bitfield: "SPSCKDL", page: 2630 }, registerIndex);
  assert.equal(result.mappingStatus, "unresolved");
  assert.equal(result.register, "RSPIM_BASE");
});

test("bitfield resolver uses evidence context to break page-local ties", () => {
  const registerIndex = {
    registers: [
      { displayName: "RSPIm_SPCR", pages: [2630], isExplicitRegister: true },
      { displayName: "RSPIm_SPCR2", pages: [2630], isExplicitRegister: true },
    ],
  };
  const result = resolveBitfieldRegisterMapping({
    register: "RSPIM_BASE",
    bitfield: "SPSCKDL",
    page: 2630,
    evidenceLines: ["7.5.2.14 SPI Control Register 2 (RSPIm_SPCR2)", "2 to 0 SPSCKDL[2:0] 0h RW"],
  }, registerIndex);
  assert.equal(result.mappingStatus, "resolved");
  assert.equal(result.register, "RSPIm_SPCR2");
});

test("bitfield noise filter rejects table/header/manual tokens", () => {
  for (const symbol of ["GLOBAL", "RW", "R", "W", "RZ", "G3E", "CPU", "RAM", "R01UH1069"]) {
    assert.equal(isLikelyBitfieldName(symbol), false, symbol);
  }
  assert.equal(isLikelyBitfieldName("SCKDL"), true);
});
