import { invokeSafely } from "./helper.js";

export const JobFlags = {
  QUEUED: 1 << 0,
  PRE: 1 << 1,
  ALLOW_RECURSE: 1 << 2,
  DISPOSED: 1 << 3,
} as const;

export interface Task {
  (): void;
  flags?: number;
}

const queue: Task[] = [];
const secondaryQueue: Task[] = [];
let flushIndex = 0;

export function queueJob(job: Task): void {
  if (!(job.flags! & JobFlags.QUEUED)) {
    queue.push(job);
    job.flags! |= JobFlags.QUEUED;
  }
}

export function flushPreFlushCbs(skip: boolean): void {
  for (let i = 0; i < queue.length; i++) {
    const cb = queue[i];
    if (cb && cb.flags! & JobFlags.PRE) {
      if (skip) {
        continue;
      }
      if (cb.flags! & JobFlags.ALLOW_RECURSE) {
        cb.flags! &= ~JobFlags.QUEUED;
      }
      cb();
      cb.flags! &= ~JobFlags.QUEUED;
    }
  }
}

export function flushJobs(): void {
  try {
    for (flushIndex = 0; flushIndex < queue.length; flushIndex++) {
      const job = queue[flushIndex];
      if (job && !(job.flags! & JobFlags.DISPOSED)) {
        if (job.flags! & JobFlags.ALLOW_RECURSE) {
          job.flags! &= ~JobFlags.QUEUED;
        }
        invokeSafely(job);
        job.flags! &= ~JobFlags.QUEUED;
      }
    }
  } finally {
    for (; flushIndex < queue.length; flushIndex++) {
      const job = queue[flushIndex];
      if (job) {
        job.flags! &= ~JobFlags.QUEUED;
      }
    }
    flushIndex = 0;
    queue.length = 0;
  }
}

export function flushSecondaryQueue(): void {
  for (let i = 0; i < secondaryQueue.length; i++) {
    const task = secondaryQueue[i];
    if (task) {
      task();
      task.flags! &= ~JobFlags.QUEUED;
    }
  }
  secondaryQueue.length = 0;
}

export function flushGuardedByContinue(): void {
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    if (item) {
      item();
      if (item.flags! & JobFlags.ALLOW_RECURSE) {
        continue;
      }
      item.flags! &= ~JobFlags.QUEUED;
    }
  }
}
