import { DEFAULT_RENDER_DPI, MAX_RENDER_DPI, MIN_RENDER_DPI, RENDERS_DIR, RENDER_COMMAND_TIMEOUT_MS } from "../core/runtime-constants.js";
import { appendEvidenceContract, atomicWriteFile, clampInteger, compactText, ensureInsideRoot, ensurePdfFilename, normalizeForSearch, pathExists, safePdfPath, safeRenderOutputPath, sanitizeRenderStem } from "../core/runtime-helpers.js";
import { getPdfPageCount, loadPdfDocument } from "../services/pdf.js";
import { buildFigureEvidenceContract, getFigureContext } from "./figures.js";
import { execFileAsync } from "../core/process-runner.js";
import fs from "node:fs/promises";
import path from "node:path";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

// -----------------------------------------------------------------------------
// Step 31B: page rendering helpers
// -----------------------------------------------------------------------------

export function normalizeRenderFormat(value) {
  const raw = String(value || "png").trim().toLowerCase();
  if (["png", "jpg", "jpeg", "svg", "text_svg"].includes(raw)) return raw === "jpeg" ? "jpg" : raw;
  return "png";
}

export function normalizeRenderer(value) {
  const raw = String(value || "auto").trim().toLowerCase();
  if (["auto", "pdftoppm", "mutool", "magick", "text_svg"].includes(raw)) return raw;
  return "auto";
}

export function clampRenderDpi(value) {
  return clampInteger(value, DEFAULT_RENDER_DPI, MIN_RENDER_DPI, MAX_RENDER_DPI);
}

export function xmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function commandExists(command) {
  return Boolean(await resolveRendererCommand(command));
}

export async function pathExistsCaseInsensitive(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function firstExistingPath(candidates) {
  for (const candidate of candidates || []) {
    if (!candidate) continue;
    const normalized = path.normalize(String(candidate));
    if (await pathExistsCaseInsensitive(normalized)) return normalized;
  }
  return null;
}

export async function findExecutableUnder(rootDir, executableName, maxDepth = RENDERER_SEARCH_DEPTH) {
  if (!rootDir || !(await pathExistsCaseInsensitive(rootDir))) return null;
  const target = executableName.toLowerCase();
  const queue = [{ dir: rootDir, depth: 0 }];

  while (queue.length) {
    const { dir, depth } = queue.shift();
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === target) return full;
      if (entry.isDirectory() && depth < maxDepth) {
        // Keep the search bounded and biased toward Windows package installs.
        const name = entry.name.toLowerCase();
        if (
          depth <= 1 ||
          name.includes("poppler") ||
          name.includes("mupdf") ||
          name.includes("imagemagick") ||
          name === "library" ||
          name === "bin"
        ) {
          queue.push({ dir: full, depth: depth + 1 });
        }
      }
    }
  }

  return null;
}

export function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

export function rendererEnvCandidates(command) {
  const env = process.env || {};
  if (command === "pdftoppm") {
    return uniqueStrings([
      env.PDF_RENDERER_PDFTOPPM,
      env.PDFTOPPM_PATH,
      env.POPPLER_PDFTOPPM,
      env.POPPLER_PATH ? path.join(env.POPPLER_PATH, process.platform === "win32" ? "pdftoppm.exe" : "pdftoppm") : "",
      env.POPPLER_BIN ? path.join(env.POPPLER_BIN, process.platform === "win32" ? "pdftoppm.exe" : "pdftoppm") : "",
    ]);
  }
  if (command === "mutool") {
    return uniqueStrings([
      env.PDF_RENDERER_MUTOOL,
      env.MUTOOL_PATH,
      env.MUPDF_MUTOOL,
      env.MUPDF_PATH ? path.join(env.MUPDF_PATH, process.platform === "win32" ? "mutool.exe" : "mutool") : "",
      env.MUPDF_BIN ? path.join(env.MUPDF_BIN, process.platform === "win32" ? "mutool.exe" : "mutool") : "",
    ]);
  }
  if (command === "magick") {
    return uniqueStrings([
      env.PDF_RENDERER_MAGICK,
      env.MAGICK_PATH,
      env.IMAGEMAGICK_MAGICK,
      env.IMAGEMAGICK_PATH ? path.join(env.IMAGEMAGICK_PATH, process.platform === "win32" ? "magick.exe" : "magick") : "",
      env.IMAGEMAGICK_BIN ? path.join(env.IMAGEMAGICK_BIN, process.platform === "win32" ? "magick.exe" : "magick") : "",
    ]);
  }
  return [];
}

export async function windowsRendererCandidates(command) {
  if (process.platform !== "win32") return [];
  const env = process.env || {};
  const localAppData = env.LOCALAPPDATA || path.join(env.USERPROFILE || "", "AppData", "Local");
  const wingetPackages = localAppData ? path.join(localAppData, "Microsoft", "WinGet", "Packages") : "";
  const programFiles = env["ProgramFiles"] || "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const exe = `${command}.exe`;
  const direct = [];

  if (command === "pdftoppm") {
    direct.push(
      path.join(wingetPackages, "oschwartz10612.Poppler_Microsoft.Winget.Source_8wekyb3d8bbwe", "poppler-25.07.0", "Library", "bin", exe),
      path.join(programFiles, "poppler", "bin", exe),
      path.join(programFilesX86, "poppler", "bin", exe)
    );
  } else if (command === "mutool") {
    direct.push(
      path.join(wingetPackages, "ArtifexSoftware.mutool_Microsoft.Winget.Source_8wekyb3d8bbwe", "mupdf-1.23.0-windows", exe),
      path.join(programFiles, "MuPDF", exe),
      path.join(programFilesX86, "MuPDF", exe)
    );
  } else if (command === "magick") {
    direct.push(
      path.join(programFiles, "ImageMagick-7.1.2-Q16-HDRI", exe),
      path.join(programFiles, "ImageMagick-7.1.1-Q16-HDRI", exe),
      path.join(programFiles, "ImageMagick-7.1.0-Q16-HDRI", exe),
      path.join(programFilesX86, "ImageMagick-7.1.2-Q16-HDRI", exe)
    );
  }

  const foundDirect = await firstExistingPath(direct);
  if (foundDirect) return [foundDirect];

  const roots = [];
  if (command === "pdftoppm" || command === "mutool") roots.push(wingetPackages);
  if (command === "magick") roots.push(programFiles, programFilesX86, wingetPackages);

  for (const root of uniqueStrings(roots)) {
    const found = await findExecutableUnder(root, exe);
    if (found) return [found];
  }
  return [];
}

export async function resolveRendererCommand(command) {
  const executable = process.platform === "win32" && !String(command).toLowerCase().endsWith(".exe") ? `${command}.exe` : command;
  const envCandidate = await firstExistingPath(rendererEnvCandidates(command));
  if (envCandidate) return envCandidate;

  const probe = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(probe, [command], { timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 });
    const resolved = String(stdout || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (resolved) return resolved;
  } catch {
    // Continue with known Windows install locations.
  }

  const windowsCandidates = await windowsRendererCandidates(command);
  if (windowsCandidates.length) return windowsCandidates[0];

  return null;
}

export async function detectPdfRenderers() {
  const [pdftoppmPath, mutoolPath, magickPath] = await Promise.all([
    resolveRendererCommand("pdftoppm"),
    resolveRendererCommand("mutool"),
    resolveRendererCommand("magick"),
  ]);
  const pdftoppm = Boolean(pdftoppmPath);
  const mutool = Boolean(mutoolPath);
  const magick = Boolean(magickPath);
  return {
    pdftoppm,
    mutool,
    magick,
    pdftoppmPath,
    mutoolPath,
    magickPath,
    text_svg: true,
    recommended: pdftoppm ? "pdftoppm" : mutool ? "mutool" : magick ? "magick" : "text_svg",
    notes: [
      pdftoppm ? `Poppler pdftoppm is available: ${pdftoppmPath}` : "Poppler pdftoppm not found in MCP server PATH or known Windows install locations.",
      mutool ? `MuPDF mutool is available: ${mutoolPath}` : "MuPDF mutool not found in MCP server PATH or known Windows install locations.",
      magick ? `ImageMagick magick is available: ${magickPath}` : "ImageMagick magick not found in MCP server PATH or known Windows install locations.",
      "text_svg fallback is always available but only renders the PDF text layer; it does not render diagrams/images/vector paths.",
      "If PowerShell can find a renderer but MCP cannot, add the renderer bin directory to the MCP server environment PATH or set PDF_RENDERER_PDFTOPPM / PDF_RENDERER_MUTOOL / PDF_RENDERER_MAGICK.",
    ],
  };
}

export async function findFirstExistingRender(prefix, ext) {
  const dir = path.dirname(prefix);
  const base = path.basename(prefix);
  const files = await fs.readdir(dir).catch(() => []);
  const candidates = files
    .filter((file) => file.startsWith(base) && file.toLowerCase().endsWith(`.${ext}`))
    .map((file) => path.join(dir, file));
  return candidates[0] || null;
}

export async function renderWithPdftoppm(commandPath, pdfPath, outPath, page, dpi, format) {
  const ext = format === "jpg" ? "jpg" : "png";
  const prefix = outPath.replace(/\.(png|jpg)$/i, "");
  const args = ["-f", String(page), "-l", String(page), "-r", String(dpi), ext === "jpg" ? "-jpeg" : "-png", pdfPath, prefix];
  await execFileAsync(commandPath || "pdftoppm", args, { timeout: RENDER_COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 * 8 });
  const expected = `${prefix}-${page}.${ext}`;
  const produced = await pathExists(expected) ? expected : await findFirstExistingRender(prefix, ext);
  if (!produced) throw new Error(`pdftoppm completed but output file was not found for prefix ${prefix}`);
  if (produced !== outPath) await fs.rename(produced, outPath);
  return { renderer: "pdftoppm", commandPath: commandPath || "pdftoppm", command: `${commandPath || "pdftoppm"} ${args.join(" ")}` };
}

export async function renderWithMutool(commandPath, pdfPath, outPath, page, dpi) {
  const args = ["draw", "-o", outPath, "-r", String(dpi), pdfPath, String(page)];
  await execFileAsync(commandPath || "mutool", args, { timeout: RENDER_COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 * 8 });
  if (!(await pathExists(outPath))) throw new Error(`mutool completed but output file was not found: ${outPath}`);
  return { renderer: "mutool", commandPath: commandPath || "mutool", command: `${commandPath || "mutool"} ${args.join(" ")}` };
}

export async function renderWithMagick(commandPath, pdfPath, outPath, page, dpi) {
  const pageSelector = `${pdfPath}[${Math.max(0, Number(page) - 1)}]`;
  const args = ["-density", String(dpi), pageSelector, "-background", "white", "-alpha", "remove", outPath];
  await execFileAsync(commandPath || "magick", args, { timeout: RENDER_COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 * 8 });
  if (!(await pathExists(outPath))) throw new Error(`magick completed but output file was not found: ${outPath}`);
  return { renderer: "magick", commandPath: commandPath || "magick", command: `${commandPath || "magick"} ${args.join(" ")}` };
}

export async function renderTextLayerSvg(filename, pageNumber, outPath, options = {}) {
  const pdf = await loadPdfDocument(filename);
  const pageCount = pdf.numPages;
  const pageNum = clampInteger(pageNumber, 1, 1, pageCount);
  const page = await pdf.getPage(pageNum);
  const scale = clampRenderDpi(options.dpi) / 72;
  const viewport = page.getViewport({ scale });
  const content = await page.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
  const lines = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(viewport.width)}" height="${Math.round(viewport.height)}" viewBox="0 0 ${Math.round(viewport.width)} ${Math.round(viewport.height)}">`);
  lines.push(`<rect x="0" y="0" width="100%" height="100%" fill="white"/>`);
  lines.push(`<text x="12" y="18" font-size="12" fill="#666">Text-layer fallback render: ${xmlEscape(filename)} page ${pageNum}. Diagrams/images/vector paths are not rendered.</text>`);

  for (const item of content.items || []) {
    const str = String(item.str || "").trim();
    if (!str) continue;
    const tx = pdfjsLib.Util && item.transform
      ? pdfjsLib.Util.transform(viewport.transform, item.transform)
      : [1, 0, 0, 1, Number(item.transform?.[4] || 0) * scale, Number(item.transform?.[5] || 0) * scale];
    const x = Number(tx[4] || 0);
    const y = Number(tx[5] || 0);
    const fontSize = Math.max(4, Math.min(28, Math.abs(Number(tx[3] || item.height || 10))));
    const rotate = Math.atan2(Number(tx[1] || 0), Number(tx[0] || 1)) * 180 / Math.PI;
    const transform = Math.abs(rotate) > 0.5 ? ` transform="rotate(${rotate.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)})"` : "";
    lines.push(`<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" font-size="${fontSize.toFixed(2)}" fill="black"${transform}>${xmlEscape(str)}</text>`);
  }

  lines.push(`</svg>`);
  await atomicWriteFile(outPath, lines.join("\n"), "utf-8");
  return { renderer: "text_svg", command: "pdfjs text-layer SVG fallback", pageCount };
}

export async function renderPdfPage(filename, options = {}) {
  ensurePdfFilename(filename);
  await fs.mkdir(RENDERS_DIR, { recursive: true });
  const pageCount = await getPdfPageCount(filename);
  const page = clampInteger(options.page, 1, 1, pageCount);
  const dpi = clampRenderDpi(options.dpi);
  const requestedFormat = normalizeRenderFormat(options.format || "png");
  let format = requestedFormat;
  const renderer = normalizeRenderer(options.renderer);
  const fallbackTextSvg = options.fallbackTextSvg !== false;
  const pdfPath = safePdfPath(filename);
  const suffix = `${requestedFormat}-dpi${dpi}`;
  let outPath = safeRenderOutputPath(filename, page, requestedFormat, suffix);
  const availability = await detectPdfRenderers();
  const attempts = [];
  let renderInfo = null;
  let warning = "";

  const tryRenderer = async (name) => {
    attempts.push(name);
    if (name === "pdftoppm") {
      if (!availability.pdftoppm) throw new Error("pdftoppm not available");
      if (!["png", "jpg"].includes(format)) throw new Error("pdftoppm supports png/jpg in this tool");
      return renderWithPdftoppm(availability.pdftoppmPath, pdfPath, outPath, page, dpi, format);
    }
    if (name === "mutool") {
      if (!availability.mutool) throw new Error("mutool not available");
      return renderWithMutool(availability.mutoolPath, pdfPath, outPath, page, dpi);
    }
    if (name === "magick") {
      if (!availability.magick) throw new Error("magick not available");
      if (!["png", "jpg"].includes(format)) throw new Error("magick path is used only for png/jpg in this tool");
      return renderWithMagick(availability.magickPath, pdfPath, outPath, page, dpi);
    }
    if (name === "text_svg") {
      format = "text_svg";
      outPath = safeRenderOutputPath(filename, page, "text_svg", `text-svg-dpi${dpi}`);
      return renderTextLayerSvg(filename, page, outPath, { dpi });
    }
    throw new Error(`Unsupported renderer: ${name}`);
  };

  const plan = [];
  if (renderer !== "auto") plan.push(renderer);
  else if (requestedFormat === "svg") plan.push("mutool", "text_svg");
  else if (requestedFormat === "text_svg") plan.push("text_svg");
  else plan.push("pdftoppm", "mutool", "magick");

  const errors = [];
  for (const candidate of plan) {
    try {
      renderInfo = await tryRenderer(candidate);
      break;
    } catch (error) {
      errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!renderInfo && fallbackTextSvg) {
    warning = `External render failed/unavailable; created text-layer SVG fallback. Errors: ${errors.join(" | ")}`;
    renderInfo = await tryRenderer("text_svg");
  }

  if (!renderInfo) throw new Error(`Unable to render page. Tried: ${attempts.join(", ")}. Errors: ${errors.join(" | ")}`);

  const stat = await fs.stat(outPath);
  return {
    filename,
    page,
    pageCount,
    dpi,
    requestedFormat,
    outputFormat: format === "text_svg" ? "svg" : format,
    renderer: renderInfo.renderer,
    outputPath: outPath,
    sizeBytes: stat.size,
    availability,
    warning,
    attempts,
  };
}

export function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes;
  let unit = "B";
  for (const candidate of units) {
    size /= 1024;
    unit = candidate;
    if (size < 1024) break;
  }
  const decimals = size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(decimals)} ${unit}`;
}

export function formatRenderResult(result) {
  const lines = [];
  lines.push("Rendered PDF Page");
  lines.push(`File: ${result.filename}`);
  lines.push(`Page: ${result.page}/${result.pageCount}`);
  lines.push(`DPI: ${result.dpi}`);
  lines.push(`Renderer: ${result.renderer}`);
  lines.push(`Output format: ${result.outputFormat}`);
  lines.push(`Output path: ${result.outputPath}`);
  lines.push(`Size: ${formatBytes(result.sizeBytes)}`);
  if (result.warning) lines.push(`Warning: ${result.warning}`);
  lines.push(`Renderer availability: ${JSON.stringify(result.availability)}`);
  lines.push("");
  if (result.renderer === "text_svg") {
    lines.push("Important: this is a text-layer SVG fallback. It preserves text positions but does not render actual diagrams/images/vector paths. Install Poppler pdftoppm or MuPDF mutool for real visual rendering.");
  } else {
    lines.push("Debug/compatibility output only. For normal figure/table analysis, prefer search_figures -> get_figure_context_pack -> get_figure_image and inspect the returned actual image content.");
  }
  lines.push("");
  lines.push("Suggested follow-up:");
  lines.push(`- search_figures(filename="${result.filename}", page=${result.page}, limit=5) then get_figure_context_pack(filename="${result.filename}", figure_id="<figure-id>")`);
  lines.push(`- read_pdf_pages(filename="${result.filename}", start_page=${result.page}, end_page=${result.page})`);
  return lines.join("\n");
}

export async function renderFigurePage(filename, options = {}) {
  const context = await getFigureContext(filename, {
    figureId: String(options.figureId || "").trim(),
    page: options.page,
    query: String(options.query || "").trim(),
    includePages: options.includeContext !== false ? 1 : 0,
    includeLayoutTables: false,
  });
  const render = await renderPdfPage(filename, {
    page: context.figure.page,
    dpi: options.dpi,
    format: options.format || "png",
    renderer: options.renderer || "auto",
    fallbackTextSvg: true,
  });
  return { ...render, figure: context.figure, context: options.includeContext === false ? null : context };
}

export function formatRenderFigureResult(result) {
  const lines = [];
  lines.push(formatRenderResult(result));
  lines.push("", "Figure/Table target:");
  lines.push(`- ID: ${result.figure.id}`);
  lines.push(`- Kind: ${result.figure.kind}`);
  lines.push(`- Caption: ${result.figure.caption}`);
  lines.push(`- Confidence: ${result.figure.confidence}`);
  if (result.context) {
    lines.push("", "Caption-near context:");
    for (const line of result.figure.contextLines || []) lines.push(`- ${line}`);
  }
  return appendEvidenceContract(lines.join("\n"), buildFigureEvidenceContract("render_figure_page", result.filename, result.figure.caption, [result.figure]));
}


// -----------------------------------------------------------------------------
// Step 31C: region crop / zoom rendering helpers
// -----------------------------------------------------------------------------

export function normalizeCropUnit(value) {
  const raw = String(value || "percent").trim().toLowerCase();
  return raw === "px" ? "px" : "percent";
}

export function clampZoom(value, defaultValue = 1.0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return defaultValue;
  return Math.max(1.0, Math.min(4.0, n));
}

export function normalizeFigureRegionMode(value) {
  const raw = String(value || "auto").trim().toLowerCase();
  if (["auto", "above_caption", "below_caption", "around_caption", "top_half", "middle", "bottom_half", "full_width"].includes(raw)) return raw;
  return "auto";
}

export function imageMagickArgsForIdentify() {
  return ["identify", "-format", "%w %h"];
}

export async function identifyImageSize(magickPath, imagePath) {
  const args = [...imageMagickArgsForIdentify(), imagePath];
  const { stdout } = await execFileAsync(magickPath || "magick", args, { timeout: RENDER_COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 });
  const [width, height] = String(stdout || "").trim().split(/\s+/).map((v) => Number(v));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`Unable to identify image size for ${imagePath}: ${stdout}`);
  }
  return { width, height };
}

export function clampCropRect(rect, imageSize) {
  const width = Math.max(1, Math.round(Number(imageSize.width || 1)));
  const height = Math.max(1, Math.round(Number(imageSize.height || 1)));
  let x = Math.round(Number(rect.x || 0));
  let y = Math.round(Number(rect.y || 0));
  let w = Math.round(Number(rect.width || width));
  let h = Math.round(Number(rect.height || height));

  x = Math.max(0, Math.min(width - 1, x));
  y = Math.max(0, Math.min(height - 1, y));
  w = Math.max(1, Math.min(width - x, w));
  h = Math.max(1, Math.min(height - y, h));

  return { x, y, width: w, height: h };
}

export function cropRectFromInput(options, imageSize) {
  const unit = normalizeCropUnit(options.unit);
  const defaultWidth = unit === "percent" ? 100 : imageSize.width;
  const defaultHeight = unit === "percent" ? 100 : imageSize.height;
  const margin = Math.max(0, Number(options.margin || 0));

  if (unit === "px") {
    return clampCropRect({
      x: Number(options.x || 0) - margin,
      y: Number(options.y || 0) - margin,
      width: Number(options.width || defaultWidth) + margin * 2,
      height: Number(options.height || defaultHeight) + margin * 2,
    }, imageSize);
  }

  const xPct = Number(options.x ?? 0) - margin;
  const yPct = Number(options.y ?? 0) - margin;
  const wPct = Number(options.width ?? defaultWidth) + margin * 2;
  const hPct = Number(options.height ?? defaultHeight) + margin * 2;

  return clampCropRect({
    x: imageSize.width * xPct / 100,
    y: imageSize.height * yPct / 100,
    width: imageSize.width * wPct / 100,
    height: imageSize.height * hPct / 100,
  }, imageSize);
}

export function safeRenderRegionOutputPath(filename, page, format, suffix = "") {
  ensurePdfFilename(filename);
  const ext = String(format || "png").toLowerCase() === "jpg" ? "jpg" : "png";
  const pageNumber = clampInteger(page, 1, 1, 999999);
  const stem = sanitizeRenderStem(`${filename}-p${pageNumber}-region${suffix ? `-${suffix}` : ""}`);
  return ensureInsideRoot(path.join(RENDERS_DIR, `${stem}.${ext}`), RENDERS_DIR, "render region output");
}

export async function cropRenderedImageWithMagick(magickPath, inputPath, outputPath, rect, zoom = 1.0) {
  const geometry = `${rect.width}x${rect.height}+${rect.x}+${rect.y}`;
  const args = [inputPath, "-crop", geometry, "+repage"];
  if (zoom && zoom > 1.001) args.push("-resize", `${Math.round(zoom * 100)}%`);
  args.push(outputPath);
  await execFileAsync(magickPath || "magick", args, { timeout: RENDER_COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 * 8 });
  if (!(await pathExists(outputPath))) throw new Error(`ImageMagick crop completed but output file was not found: ${outputPath}`);
  return { renderer: "magick-crop", commandPath: magickPath || "magick", command: `${magickPath || "magick"} ${args.join(" ")}`, geometry };
}

export async function renderPdfRegion(filename, options = {}) {
  const page = Number(options.page);
  const dpi = clampRenderDpi(options.dpi);
  const requestedFormat = normalizeRenderFormat(options.format || "png") === "jpg" ? "jpg" : "png";
  const zoom = clampZoom(options.zoom, 1.0);
  const availability = await detectPdfRenderers();
  if (!availability.magick) {
    if (options.fallbackFullPage) {
      const full = await renderPdfPage(filename, { page, dpi, format: requestedFormat, renderer: options.renderer || "auto", fallbackTextSvg: false });
      return { ...full, region: null, cropRenderer: null, cropWarning: "ImageMagick is unavailable; returned full page render because fallback_full_page=true." };
    }
    throw new Error("ImageMagick magick is required for Step 31C crop/zoom. Install ImageMagick or set PDF_RENDERER_MAGICK.");
  }

  const full = await renderPdfPage(filename, {
    page,
    dpi,
    format: requestedFormat,
    renderer: options.renderer || "auto",
    fallbackTextSvg: false,
  });

  const imageSize = await identifyImageSize(availability.magickPath, full.outputPath);
  const rect = cropRectFromInput(options, imageSize);
  const suffix = `${requestedFormat}-dpi${dpi}-x${rect.x}-y${rect.y}-w${rect.width}-h${rect.height}-z${String(zoom).replace(/\./g, "p")}`;
  const outPath = safeRenderRegionOutputPath(filename, full.page, requestedFormat, suffix);
  const cropInfo = await cropRenderedImageWithMagick(availability.magickPath, full.outputPath, outPath, rect, zoom);
  const stat = await fs.stat(outPath);

  return {
    ...full,
    outputPath: outPath,
    sizeBytes: stat.size,
    region: {
      unit: normalizeCropUnit(options.unit),
      input: {
        x: options.x ?? 0,
        y: options.y ?? 0,
        width: options.width ?? (normalizeCropUnit(options.unit) === "px" ? imageSize.width : 100),
        height: options.height ?? (normalizeCropUnit(options.unit) === "px" ? imageSize.height : 100),
        margin: options.margin || 0,
      },
      pixels: rect,
      imageSize,
      zoom,
      fullPagePath: full.outputPath,
    },
    cropRenderer: cropInfo,
    renderer: `${full.renderer}+magick-crop`,
    outputFormat: requestedFormat,
  };
}

export function formatRegionRenderResult(result, title = "Rendered PDF Region") {
  const lines = [];
  lines.push(title);
  lines.push(`File: ${result.filename}`);
  lines.push(`Page: ${result.page}/${result.pageCount}`);
  lines.push(`DPI: ${result.dpi}`);
  lines.push(`Renderer: ${result.renderer}`);
  lines.push(`Output format: ${result.outputFormat}`);
  lines.push(`Output path: ${result.outputPath}`);
  lines.push(`Size: ${formatBytes(result.sizeBytes)}`);
  if (result.region) {
    lines.push(`Full page render: ${result.region.fullPagePath}`);
    lines.push(`Image size: ${result.region.imageSize.width}x${result.region.imageSize.height}px`);
    lines.push(`Crop pixels: x=${result.region.pixels.x}, y=${result.region.pixels.y}, width=${result.region.pixels.width}, height=${result.region.pixels.height}`);
    lines.push(`Input unit: ${result.region.unit}`);
    lines.push(`Zoom: ${result.region.zoom}x`);
  }
  if (result.cropWarning) lines.push(`Warning: ${result.cropWarning}`);
  if (result.warning) lines.push(`Warning: ${result.warning}`);
  lines.push("");
  lines.push("Debug/compatibility crop only. Do not use as normal semantic evidence unless explicitly requested by a human; prefer search_figures -> get_figure_context_pack and canonical indexes/cache/figure-images image_path.");
  lines.push("");
  lines.push("Suggested follow-up:");
  lines.push(`- search_figures(filename="${result.filename}", page=${result.page}, limit=5) then get_figure_context_pack(filename="${result.filename}", figure_id="<figure-id>")`);
  lines.push(`- debug/manual fallback only: render_pdf_page(filename="${result.filename}", page=${result.page}, dpi=${result.dpi}, format="${result.outputFormat}")`);
  return lines.join("\n");
}

export async function getCaptionTextBounds(filename, pageNumber, captionOrQuery, dpi = DEFAULT_RENDER_DPI) {
  const query = normalizeForSearch(captionOrQuery || "");
  if (!query) return null;
  const queryTokens = query.split(/\s+/).filter((token) => token.length >= 3).slice(0, 12);
  if (!queryTokens.length) return null;

  const pdf = await loadPdfDocument(filename);
  const page = await pdf.getPage(pageNumber);
  const scale = clampRenderDpi(dpi) / 72;
  const viewport = page.getViewport({ scale });
  const content = await page.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
  const matches = [];

  for (const item of content.items || []) {
    const str = String(item.str || "").trim();
    if (!str) continue;
    const norm = normalizeForSearch(str);
    const hitCount = queryTokens.filter((token) => norm.includes(token)).length;
    if (!hitCount) continue;
    const tx = pdfjsLib.Util && item.transform
      ? pdfjsLib.Util.transform(viewport.transform, item.transform)
      : [1, 0, 0, 1, Number(item.transform?.[4] || 0) * scale, Number(item.transform?.[5] || 0) * scale];
    const x = Number(tx[4] || 0);
    const y = Number(tx[5] || 0);
    const fontSize = Math.max(4, Math.min(40, Math.abs(Number(tx[3] || item.height || 10))));
    const width = Math.max(4, Number(item.width || str.length * 5) * scale);
    matches.push({ x, y: Math.max(0, y - fontSize), width, height: fontSize * 1.5, score: hitCount, text: str });
  }

  if (!matches.length) return null;
  matches.sort((a, b) => b.score - a.score);
  const topScore = matches[0].score;
  const selected = matches.filter((m) => m.score >= Math.max(1, topScore - 1)).slice(0, 8);
  const minX = Math.min(...selected.map((m) => m.x));
  const minY = Math.min(...selected.map((m) => m.y));
  const maxX = Math.max(...selected.map((m) => m.x + m.width));
  const maxY = Math.max(...selected.map((m) => m.y + m.height));
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    matches: selected,
  };
}

export function figureRegionPercentFromCaptionBounds(bounds, mode = "auto") {
  if (!bounds) {
    const fallback = mode === "bottom_half" ? { x: 0, y: 50, width: 100, height: 50 }
      : mode === "top_half" ? { x: 0, y: 0, width: 100, height: 50 }
      : mode === "middle" ? { x: 0, y: 25, width: 100, height: 50 }
      : { x: 0, y: 0, width: 100, height: 100 };
    return fallback;
  }

  const captionY = (bounds.y / bounds.viewportHeight) * 100;
  const captionH = (bounds.height / bounds.viewportHeight) * 100;
  const normalizedMode = mode === "auto" ? "above_caption" : mode;

  if (normalizedMode === "above_caption") {
    const y = Math.max(0, captionY - 42);
    const h = Math.max(20, Math.min(55, captionY - y + captionH + 4));
    return { x: 3, y, width: 94, height: h };
  }
  if (normalizedMode === "below_caption") {
    const y = Math.min(95, captionY - 2);
    return { x: 3, y, width: 94, height: Math.max(5, 100 - y - 2) };
  }
  if (normalizedMode === "around_caption") {
    const y = Math.max(0, captionY - 20);
    return { x: 3, y, width: 94, height: Math.min(60, 40 + captionH) };
  }
  if (normalizedMode === "top_half") return { x: 0, y: 0, width: 100, height: 50 };
  if (normalizedMode === "middle") return { x: 0, y: 25, width: 100, height: 50 };
  if (normalizedMode === "bottom_half") return { x: 0, y: 50, width: 100, height: 50 };
  if (normalizedMode === "full_width") return { x: 0, y: Math.max(0, captionY - 45), width: 100, height: Math.min(65, captionY + captionH + 8) };
  return { x: 0, y: 0, width: 100, height: 100 };
}

export async function renderFigureRegion(filename, options = {}) {
  const context = await getFigureContext(filename, {
    figureId: String(options.figureId || "").trim(),
    page: options.page,
    query: String(options.query || "").trim(),
    includePages: options.includeContext !== false ? 1 : 0,
    includeLayoutTables: false,
  });

  const explicitCrop = options.x !== undefined && options.y !== undefined && options.width !== undefined && options.height !== undefined;
  let cropOptions = {};
  let captionBounds = null;
  let regionMode = normalizeFigureRegionMode(options.region || "auto");

  if (explicitCrop) {
    cropOptions = {
      x: options.x,
      y: options.y,
      width: options.width,
      height: options.height,
      unit: normalizeCropUnit(options.unit),
      margin: options.margin ?? 0,
    };
  } else {
    captionBounds = await getCaptionTextBounds(filename, context.figure.page, `${context.figure.caption} ${options.query || ""}`, options.dpi || DEFAULT_RENDER_DPI).catch(() => null);
    cropOptions = {
      ...figureRegionPercentFromCaptionBounds(captionBounds, regionMode),
      unit: "percent",
      margin: options.margin ?? 3,
    };
  }

  const render = await renderPdfRegion(filename, {
    page: context.figure.page,
    dpi: options.dpi,
    format: options.format || "png",
    renderer: options.renderer || "auto",
    zoom: options.zoom === undefined ? 1.5 : options.zoom,
    fallbackFullPage: false,
    ...cropOptions,
  });

  return {
    ...render,
    figure: context.figure,
    context: options.includeContext === false ? null : context,
    regionMode,
    captionBounds,
    explicitCrop,
  };
}

export function formatRenderFigureRegionResult(result) {
  const lines = [];
  lines.push(formatRegionRenderResult(result, "Rendered Figure/Page Region"));
  lines.push("", "Figure/Table target:");
  lines.push(`- ID: ${result.figure.id}`);
  lines.push(`- Kind: ${result.figure.kind}`);
  lines.push(`- Caption: ${result.figure.caption}`);
  lines.push(`- Confidence: ${result.figure.confidence}`);
  lines.push(`- Region mode: ${result.explicitCrop ? "explicit" : result.regionMode}`);
  if (result.captionBounds) {
    lines.push(`- Caption bounds: x=${result.captionBounds.x.toFixed(1)}, y=${result.captionBounds.y.toFixed(1)}, width=${result.captionBounds.width.toFixed(1)}, height=${result.captionBounds.height.toFixed(1)}`);
  }
  if (result.context) {
    lines.push("", "Caption-near context:");
    for (const line of result.figure.contextLines || []) lines.push(`- ${line}`);
  }
  return appendEvidenceContract(lines.join("\n"), buildFigureEvidenceContract("render_figure_region", result.filename, result.figure.caption, [result.figure]));
}

export function formatRendererAvailability(availability) {
  const lines = [];
  lines.push("PDF Renderer Availability");
  lines.push(`pdftoppm: ${availability.pdftoppm ? "yes" : "no"}${availability.pdftoppmPath ? ` (${availability.pdftoppmPath})` : ""}`);
  lines.push(`mutool: ${availability.mutool ? "yes" : "no"}${availability.mutoolPath ? ` (${availability.mutoolPath})` : ""}`);
  lines.push(`magick: ${availability.magick ? "yes" : "no"}${availability.magickPath ? ` (${availability.magickPath})` : ""}`);
  lines.push(`text_svg fallback: yes`);
  lines.push(`Recommended: ${availability.recommended}`);
  lines.push(`MCP server PATH: ${compactText(process.env.PATH || "", 500)}`);
  lines.push("");
  for (const note of availability.notes || []) lines.push(`- ${note}`);
  lines.push("");
  lines.push("For real visual diagram/timing/clock-tree review, install Poppler (pdftoppm) or MuPDF (mutool). The text_svg fallback is useful only for coordinate-preserving text inspection.");
  return lines.join("\n");
}
