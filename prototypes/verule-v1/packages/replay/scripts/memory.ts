import { readFileSync, readdirSync } from "node:fs";
import { platform } from "node:os";

export function processMemory(pid: number) {
  if (platform() !== "linux") return null;
  // tsrs can spawn the compiler from a worker thread. Linux associates
  // children with the spawning task, so inspect every thread in this tree.
  try {
    const seen = new Set<number>([pid]);
    const queue = [pid];
    let kib = 0;
    for (const pid of queue) {
      for (const thread of readdirSync(`/proc/${pid}/task`)) {
        const children = readFileSync(
          `/proc/${pid}/task/${thread}/children`,
          "utf8",
        ).trim();
        for (const child of children
          .split(/\s+/u)
          .filter(Boolean)
          .map(Number)) {
          if (seen.has(child)) continue;
          seen.add(child);
          const rss = /^VmRSS:\s+(\d+) kB$/mu.exec(
            readFileSync(`/proc/${child}/status`, "utf8"),
          );
          if (rss?.[1]) kib += Number(rss[1]);
          queue.push(child);
        }
      }
    }
    const root = /^VmRSS:\s+(\d+) kB$/mu.exec(
      readFileSync(`/proc/${pid}/status`, "utf8"),
    );
    if (!root?.[1]) return null;
    return { nodeMiB: Number(root[1]) / 1024, childrenMiB: kib / 1024 };
  } catch (error) {
    // Linux may hide procfs or retire a worker while its thread list is sampled.
    if (
      error instanceof Error &&
      "code" in error &&
      ["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(String(error.code))
    )
      return null;
    throw error;
  }
}
