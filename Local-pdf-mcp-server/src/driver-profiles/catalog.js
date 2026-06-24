export const DRIVER_PROFILE_FRAGMENT_TYPE = "driver-profile-fragment";

export function sanitizeDriverProfileName(value) {
  const name = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!name) return "generic";
  if (name.includes("..") || name.includes("/") || name.includes("\\")) {
    throw new Error("Invalid driver profile name");
  }
  return name;
}

export function normalizeDriverSubsystemHint(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw === "pwm/timer" || raw.includes("pwm") || raw.includes("timer")) return "pwm";
  if (raw.includes("ethernet") || raw.includes("netdev") || raw.includes("stmmac") || raw.includes("dwmac") || raw.includes("gbeth")) return "ethernet";
  if (raw.includes("dma")) return "dmaengine";
  if (raw.includes("watchdog") || raw === "wdt") return "watchdog";
  if (raw.includes("pinctrl") || raw.includes("pfc")) return "pinctrl";
  if (raw.includes("gpio")) return "gpio";
  if (raw.includes("i2c") || raw.includes("iic") || raw.includes("riic")) return "i2c";
  if (raw.includes("spi") || raw.includes("rspi")) return "spi";
  if (raw.includes("uart") || raw.includes("serial")) return "uart";
  if (raw.includes("can")) return "can";
  if (raw.includes("usb") || raw.includes("xhci") || raw.includes("ehci") || raw.includes("ohci") || raw.includes("dwc3")) return "usb";
  if (raw.includes("pcie") || raw.includes("pci express") || raw === "pci" || raw.includes("pci-")) return "pcie";
  if (raw.includes("adc") || raw.includes("iio")) return "adc";
  if (raw.includes("rtc")) return "rtc";
  return sanitizeDriverProfileName(raw);
}

export function normalizeDriverFamilyHint(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.includes("stmmac") || raw.includes("dwmac")) return "stmmac";
  if (raw.includes("xhci") || raw.includes("usb3")) return "xhci";
  if (raw.includes("dwc3")) return "dwc3";
  if (raw.includes("ehci")) return "ehci";
  if (raw.includes("ohci")) return "ohci";
  if (raw.includes("canfd") || raw.includes("can-fd") || raw.includes("can fd")) return "canfd";
  if (raw.includes("pcie-host") || raw.includes("host bridge") || raw.includes("root complex") || raw === "host" || raw === "rc") return "pcie-host";
  if (raw.includes("rspi")) return "rspi";
  if (raw.includes("riic")) return "riic";
  if (raw.includes("pfc")) return "pfc";
  if (raw.includes("irq")) return "irq";
  return sanitizeDriverProfileName(raw);
}

export function normalizeDriverProfileHint(value) {
  return normalizeDriverSubsystemHint(value);
}

export function driverProfileCandidates({ profile = "", subsystem = "", driverFamily = "" } = {}) {
  const candidates = [];
  const explicit = sanitizeDriverProfileName(profile || "");
  const sub = sanitizeDriverProfileName(normalizeDriverSubsystemHint(subsystem || ""));
  const family = sanitizeDriverProfileName(normalizeDriverFamilyHint(driverFamily || ""));

  if (profile) candidates.push(explicit);
  if (sub && family && sub !== "generic" && family !== "generic") {
    candidates.push(family.startsWith(`${sub}-`) ? family : `${sub}-${family}`);
  }
  if (family && family !== "generic") candidates.push(family);
  if (sub && sub !== "generic") candidates.push(sub);
  candidates.push("generic");
  return [...new Set(candidates)];
}

export function normalizeProfileNameArray(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => sanitizeDriverProfileName(item)).filter(Boolean))];
  }
  const text = String(value || "").trim();
  if (!text) return [];
  return [...new Set(text.split(/[,;\n]+/).map((item) => sanitizeDriverProfileName(item)).filter(Boolean))];
}

export function validateDriverProfileObject(data, name = "profile") {
  const errors = [];
  if (!data || typeof data !== "object") errors.push(`${name}: profile must be an object`);
  if (data?.schemaVersion !== 1) errors.push(`${name}: schemaVersion must be 1`);
  if (!data?.profile) errors.push(`${name}: missing profile`);
  if (data?.type && data.type !== "driver-profile") errors.push(`${name}: type must be driver-profile when present`);
  if (data?.checklist !== undefined && !Array.isArray(data.checklist)) errors.push(`${name}: checklist must be an array`);
  if (data?.fragments !== undefined) {
    try {
      normalizeProfileNameArray(data.fragments);
    } catch (error) {
      errors.push(`${name}: invalid fragments: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function validateDriverProfileFragmentObject(data, name = "fragment") {
  const errors = [];
  if (!data || typeof data !== "object") errors.push(`${name}: fragment must be an object`);
  if (data?.schemaVersion !== 1) errors.push(`${name}: schemaVersion must be 1`);
  if (data?.type !== DRIVER_PROFILE_FRAGMENT_TYPE) errors.push(`${name}: type must be ${DRIVER_PROFILE_FRAGMENT_TYPE}`);
  if (!data?.fragment) errors.push(`${name}: missing fragment`);
  if (data?.checklist !== undefined && !Array.isArray(data.checklist)) errors.push(`${name}: checklist must be an array`);
  return { ok: errors.length === 0, errors };
}
