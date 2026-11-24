import { invokeSafely } from "./customHandling.js";

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
const pendingPostCbs: Task[] = [];
let activePostCbs: Task[] | null = null;
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

export function flushPostFlushCbs(): void {
  activePostCbs = [...pendingPostCbs];
  pendingPostCbs.length = 0;
  for (let i = 0; i < activePostCbs.length; i++) {
    const cb = activePostCbs[i];
    if (cb.flags! & JobFlags.ALLOW_RECURSE) {
      cb.flags! &= ~JobFlags.QUEUED;
    }
    cb();
    cb.flags! &= ~JobFlags.QUEUED;
  }
  activePostCbs = null;
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
