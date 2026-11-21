import { execFileSync } from "node:child_process";
import { join } from "node:path";

export const revision = "8698e58b730da0034676362ffbe2f6bd425e8ddc";

/** Keep every mutation in a disposable checkout. A local clone can supply the pinned objects offline. */
export function prepareCheckout(
  checkout: string,
  upstream = process.env.VERULE_BENCH_REPO ??
    "https://github.com/YKDZ/cli-contract.git",
) {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", checkout, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", "--quiet");
  git("fetch", "--quiet", "--depth=1", upstream, revision);
  git("checkout", "--quiet", "--detach", "FETCH_HEAD");
  if (git("rev-parse", "HEAD").trim() !== revision)
    throw new Error("Unexpected benchmark revision.");
  execFileSync("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], {
    cwd: checkout,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return join(checkout, "packages", "lib");
}
