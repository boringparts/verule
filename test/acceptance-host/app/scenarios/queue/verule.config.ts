import { defineConfig } from "@boringparts/verule";
import {
  defineReentrantQueueModel,
  reentrantQueueFlagRule,
} from "@verule/rules-reference";

export const schedulerQueueModel = defineReentrantQueueModel({
  id: "acceptance-scheduler-queue",
  description:
    "Scheduler queue model requiring post-callback QUEUED flag clears to preserve ALLOW_RECURSE re-enqueues.",
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
  models: [schedulerQueueModel],
  rules: [reentrantQueueFlagRule],
});
