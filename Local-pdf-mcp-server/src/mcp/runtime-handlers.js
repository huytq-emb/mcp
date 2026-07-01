export { normalizeFigureImageTransport } from "./handlers/figures.js";

import { createControlHandlers } from "./handlers/control.js";
import { createDriverHandlers } from "./handlers/driver.js";
import { createFigureHandlers } from "./handlers/figures.js";
import { createManualEvidenceHandlers } from "./handlers/manual-evidence.js";

export function createRuntimeHandlers(context = null) {
  return Object.freeze({
    ...createControlHandlers(context),
    ...createManualEvidenceHandlers(context),
    ...createFigureHandlers(context),
    ...createDriverHandlers(context),
  });
}
