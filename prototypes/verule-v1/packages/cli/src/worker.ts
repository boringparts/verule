import { parentPort } from "node:worker_threads";

import { Analysis, type Request } from "./analysis.ts";

const port = parentPort!;
const analysis = new Analysis();
// The parent serializes requests. A fresh worker discards the entire user module cache.
port.on("message", async (request: Request | "close") => {
  if (request === "close") {
    analysis.close();
    port.close();
  } else {
    port.postMessage(await analysis.check(request, true));
  }
});
