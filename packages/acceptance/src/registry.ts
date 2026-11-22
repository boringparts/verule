import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { basename } from "node:path";

import type { PackedArtifact } from "./artifacts.ts";

export type ScopedRegistryServer = {
  readonly url: string;
  readonly port: number;
  readonly scopes: readonly string[];
  close(): Promise<void>;
};

const syntheticReleaseTimestamp = "2020-01-01T00:00:00.000Z";
const tarballRoutePrefix = "/-/tarball/";

function extractScope(packageName: string): string | undefined {
  if (!packageName.startsWith("@")) {
    return undefined;
  }
  const slashIndex = packageName.indexOf("/");
  return slashIndex > 1 ? packageName.slice(0, slashIndex) : undefined;
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Starts an in-process loopback HTTP npm registry serving packuments and
 * `.tgz` tarballs for the given local artifacts so host package managers
 * resolve transitive workspace dependencies without touching the dev workspace.
 */
export async function startArtifactRegistry(
  artifacts: readonly PackedArtifact[],
): Promise<ScopedRegistryServer> {
  const byName = new Map<string, PackedArtifact>();
  const byTarball = new Map<string, PackedArtifact>();
  const scopeSet = new Set<string>();

  for (const artifact of artifacts) {
    byName.set(artifact.name, artifact);
    byTarball.set(basename(artifact.filename), artifact);
    const scope = extractScope(artifact.name);
    if (scope !== undefined) {
      scopeSet.add(scope);
    }
  }

  let port = 0;

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const rawUrl = req.url ?? "/";
    const pathname = rawUrl.split("?")[0] ?? "/";
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    if (pathname.startsWith(tarballRoutePrefix)) {
      const encodedName = pathname.slice(tarballRoutePrefix.length);
      const tarballName = decodeURIComponent(encodedName);
      const artifact = byTarball.get(tarballName);
      if (artifact === undefined) {
        sendJson(res, 404, { error: "tarball_not_found" });
        return;
      }
      const bytes = readFileSync(artifact.filename);
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": bytes.length,
      });
      res.end(req.method === "HEAD" ? undefined : bytes);
      return;
    }

    const packageName = decodeURIComponent(pathname.slice(1));
    const artifact = byName.get(packageName);
    if (artifact === undefined) {
      sendJson(res, 404, { error: "package_not_found" });
      return;
    }

    const tarballUrl = `http://127.0.0.1:${String(port)}${tarballRoutePrefix}${encodeURIComponent(basename(artifact.filename))}`;
    sendJson(res, 200, {
      name: artifact.name,
      "dist-tags": { latest: artifact.version },
      time: { [artifact.version]: syntheticReleaseTimestamp },
      versions: {
        [artifact.version]: {
          ...artifact.manifest,
          dist: {
            shasum: artifact.sha1,
            integrity: artifact.integrity,
            tarball: tarballUrl,
          },
        },
      },
    });
  }

  const server = createServer(handleRequest);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolveClose) =>
      server.close(() => resolveClose()),
    );
    throw new Error("Expected TCP address for loopback artifact registry");
  }
  port = address.port;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    port,
    scopes: [...scopeSet],
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error !== undefined && error !== null) {
            rejectClose(error);
            return;
          }
          resolveClose();
        });
      });
    },
  };
}
