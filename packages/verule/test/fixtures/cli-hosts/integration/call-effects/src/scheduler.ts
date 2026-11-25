import { callWithErrorHandling } from "./errorHandling.js";

const QUEUED = 1;
const ALLOW_RECURSE = 4;

export interface Job {
  (): void;
  flags: number;
}

export function queueJob(job: Job): void {
  job.flags |= QUEUED;
}

export function flushJobBuggy(job: Job): void {
  callWithErrorHandling(() => {
    queueJob(job);
  });
  job.flags &= ~QUEUED;
}

export function flushJobFixed(job: Job): void {
  callWithErrorHandling(() => {
    queueJob(job);
  });
  if (!(job.flags & ALLOW_RECURSE)) {
    job.flags &= ~QUEUED;
  }
}
