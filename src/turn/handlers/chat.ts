// Small talk, arithmetic, definitions: no evidence to gather, no searches; the model answers directly.

import type { IntentHandler } from "./index.ts";

export const chatHandler: IntentHandler = {
  web: false,
  async *gather() {},
};
