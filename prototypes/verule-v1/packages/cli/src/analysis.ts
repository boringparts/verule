import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { openProject, type Config, type AnalysisSession } from "@verule/sdk";

import { errorMessage, type CheckFailure, type CheckReport } from "./report.ts";

export type Round = { report: CheckReport } | { failure: CheckFailure };

export type Inputs = {
  configFiles: string[];
  sources: readonly string[];
  tsconfig?: string;
};
export type AnalysisResult = Inputs & { round: Round };
export type Request = {
  configFile: string;
  version: string;
  changedFiles: string[];
};

export class Analysis {
  private session?: AnalysisSession;
  private config?: Config;
  private tsconfig?: string;
  private readonly configFiles = new Set<string>();
  private hooks?: ReturnType<typeof registerHooks>;

  private async load(file: string) {
    this.configFiles.add(file);
    const sdk = import.meta.resolve("@verule/sdk");
    // Only follow modules imported by the user's config. The SDK owns its own dependencies.
    const entry = pathToFileURL(file).href;
    this.hooks = registerHooks({
      resolve: (specifier, context, next) => {
        const parent = context.parentURL;
        const fromConfig =
          parent?.startsWith("file:") &&
          this.configFiles.has(fileURLToPath(parent));
        if (
          specifier === sdk ||
          specifier === "@verule/sdk" ||
          (specifier !== entry && !fromConfig)
        ) {
          return next(specifier, context);
        }
        // Watch both the requested path and its resolved target (e.g. a symlink).
        // Remember an unresolved import so creating the file can recover a failed round.
        if (
          specifier.startsWith(".") ||
          specifier.startsWith("/") ||
          specifier.startsWith("file:")
        ) {
          this.configFiles.add(fileURLToPath(new URL(specifier, parent)));
        }
        const result = next(specifier, context);
        if (result.url.startsWith("file:") && result.url !== sdk) {
          this.configFiles.add(fileURLToPath(result.url));
        }
        return result;
      },
    });
    const { default: config } = (await import(entry)) as { default?: Config };
    if (
      !config ||
      typeof config.tsconfig !== "string" ||
      !Array.isArray(config.rules) ||
      (config.models !== undefined && !Array.isArray(config.models))
    ) {
      throw new Error(
        "The default export must specify a tsconfig path, a rules array and an optional models array.",
      );
    }
    this.tsconfig = resolve(dirname(file), config.tsconfig);
    this.session = openProject(this.tsconfig);
    this.config = config;
  }

  async check(request: Request, watchInputs = false): Promise<AnalysisResult> {
    let sources: readonly string[] = [];
    let round: Round;
    try {
      if (!this.config) await this.load(request.configFile);
      const report = this.session!.check(this.config!, {
        version: request.version,
        changedFiles: request.changedFiles,
      });
      round = { report };
    } catch (error) {
      round = {
        failure: { version: request.version, message: errorMessage(error) },
      };
    }
    if (watchInputs && this.session) {
      try {
        sources = this.session.filePaths;
      } catch (error) {
        if ("report" in round)
          round = {
            failure: { version: request.version, message: errorMessage(error) },
          };
      }
    }
    return {
      round,
      configFiles: [...this.configFiles],
      sources,
      ...(this.tsconfig === undefined ? {} : { tsconfig: this.tsconfig }),
    };
  }

  close() {
    this.hooks?.deregister();
    this.session?.close();
  }
}
