import { defineConfig } from "@boringparts/verule";
import { createReentrantQueueFlagRule } from "@verule/rules-reference";

const acceptanceQueueRule = createReentrantQueueFlagRule({
  description:
    "Verify that post-callback QUEUED flag clears on scheduler-queue preserve ALLOW_RECURSE re-enqueues.",
  contracts: [
    {
      id: "scheduler-queue",
      queueName: "scheduler-queue",
      enqueueFunctionName: "queueJob",
      queueIdentifier: "queue",
      flagProperty: "flags",
      queuedFlagName: "QUEUED",
      reentrantFlagName: "ALLOW_RECURSE",
    },
  ],
});

export default defineConfig({
  tsconfig: "tsconfig.json",
  rules: [acceptanceQueueRule],
});
