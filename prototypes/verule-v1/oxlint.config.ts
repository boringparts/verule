import lintConfiguration from "@verule-v1/tooling-config/oxlint";
import { defineConfig } from "oxlint";

export default defineConfig({
  extends: [lintConfiguration],
  options: { typeAware: true },
});
