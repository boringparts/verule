import { createResource, onDidClose } from "@acme/lifecycle";

import { releaseHelper } from "./helpers.js";

export function closeAWronglyCleansB(): void {
  const resA = createResource("A");
  const resB = createResource("B");
  onDidClose(() => {
    releaseHelper(resB);
  });
  void resA;
}

export function closeACleanly(extraCb?: () => void): void {
  const resA = createResource("A-clean");
  onDidClose(() => {
    releaseHelper(resA);
    extraCb?.();
  });
}
