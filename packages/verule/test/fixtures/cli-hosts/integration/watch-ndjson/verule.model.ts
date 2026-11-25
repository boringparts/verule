import { defineModel } from "@boringparts/verule";

export const modePolicy = defineModel({
  id: "mode-policy",
  version: "1",
  facts: { disallowedMode: "fast" },
});
