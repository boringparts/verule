import { defineModel } from "@verule/sdk";

export const modePolicy = defineModel({
  id: "mode-policy",
  version: "1",
  facts: { disallowedMode: "fast" },
});
