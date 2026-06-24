import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import {
  driverProfileCandidates,
  normalizeDriverFamilyHint,
  normalizeDriverSubsystemHint,
  validateDriverProfileFragmentObject,
  validateDriverProfileObject,
} from "../../src/driver-profiles/catalog.js";

const execFileAsync = promisify(execFile);

async function resolveProfile(args = []) {
  const { stdout } = await execFileAsync(process.execPath, ["index.js", "--profile-resolve-smoke", ...args], {
    cwd: new URL("../..", import.meta.url),
    timeout: 30000,
  });
  return JSON.parse(stdout);
}

test("driver profile normalizers separate subsystem and family hints", () => {
  assert.equal(normalizeDriverSubsystemHint("USB xHCI host"), "usb");
  assert.equal(normalizeDriverFamilyHint("USB xHCI host"), "xhci");
  assert.equal(normalizeDriverSubsystemHint("CAN FD controller"), "can");
  assert.equal(normalizeDriverFamilyHint("CAN FD controller"), "canfd");
  assert.equal(normalizeDriverSubsystemHint("PCIe root complex"), "pcie");
  assert.equal(normalizeDriverFamilyHint("host bridge"), "pcie-host");
});

test("driver profile candidates prefer subsystem-family before generic fallback", () => {
  assert.deepEqual(driverProfileCandidates({ subsystem: "usb", driverFamily: "xhci" }).slice(0, 4), ["usb-xhci", "xhci", "usb", "generic"]);
  assert.deepEqual(driverProfileCandidates({ subsystem: "can", driverFamily: "canfd" }).slice(0, 4), ["can-canfd", "canfd", "can", "generic"]);
  assert.deepEqual(driverProfileCandidates({ subsystem: "pcie", driverFamily: "host" }).slice(0, 4), ["pcie-host", "pcie", "generic"]);
});

test("driver profile and fragment schema validation catches bad fragment refs", () => {
  assert.equal(validateDriverProfileObject({ schemaVersion: 1, type: "driver-profile", profile: "usb", fragments: ["clock-reset"] }).ok, true);
  const bad = validateDriverProfileFragmentObject({ schemaVersion: 1, type: "driver-profile", fragment: "clock-reset" }, "bad-fragment");
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join("\n"), /type must be driver-profile-fragment/);
});

test("resolver selects usb-xhci and merges profile fragments", async () => {
  const resolved = await resolveProfile(["--subsystem=usb", "--driver-family=xhci"]);
  assert.equal(resolved.selected, "usb-xhci");
  assert.equal(resolved.profile, "usb-xhci");
  assert.ok(resolved.profileStack.includes("generic"));
  assert.ok(resolved.profileStack.includes("usb"));
  assert.ok(resolved.profileStack.includes("usb-xhci"));
  assert.ok(resolved.fragments.includes("usb-phy-vbus"));
  assert.ok(resolved.checklistAreas.includes("xHCI host glue"));
});

test("resolver selects can-canfd and pcie-host profiles", async () => {
  const can = await resolveProfile(["--subsystem=can", "--driver-family=canfd"]);
  assert.equal(can.selected, "can-canfd");
  assert.ok(can.fragments.includes("socketcan"));
  assert.ok(can.checklistAreas.includes("CAN FD data phase"));

  const pcie = await resolveProfile(["--subsystem=pcie", "--driver-family=host"]);
  assert.equal(pcie.selected, "pcie-host");
  assert.ok(pcie.fragments.includes("pcie-link-training"));
  assert.ok(pcie.fragments.includes("msi"));
  assert.ok(pcie.checklistAreas.includes("PCIe root complex bring-up"));
});

test("fragment merge order keeps parent checklist before fragment and profile overlays", async () => {
  const resolved = await resolveProfile(["--subsystem=pcie", "--driver-family=host"]);
  const areas = resolved.checklistAreas;
  assert.ok(areas.indexOf("Probe / platform integration") < areas.indexOf("Clock/reset resources"));
  assert.ok(areas.indexOf("Clock/reset resources") < areas.indexOf("PCIe controller integration"));
  assert.ok(areas.indexOf("PCIe controller integration") < areas.indexOf("PCIe root complex bring-up"));
});
