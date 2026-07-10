export { normalizeFigureImageTransport } from "./handlers/figures.js";

import { createControlHandlers } from "./handlers/control.js";
import { createDriverHandlers } from "./handlers/driver.js";
import { createFigureHandlers } from "./handlers/figures.js";
import { createManualEvidenceHandlers } from "./handlers/manual-evidence.js";
import { createEvidenceV2Handlers } from "./handlers/evidence-v2.js";

export function createRuntimeHandlers(context = null) {
  return Object.freeze({
    ...createControlHandlers(context),
    ...createManualEvidenceHandlers(context),
    ...createEvidenceV2Handlers(context),
    ...createFigureHandlers(context),
    ...createDriverHandlers(context),
  });
}
