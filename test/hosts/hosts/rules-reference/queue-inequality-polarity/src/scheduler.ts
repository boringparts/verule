const enum JobFlags {
  QUEUED = 1,
  ALLOW_RECURSE = 2,
}
interface Job {
  (): void;
  flags: number;
}
const queue: Job[] = [];

export function enqueueJob(job: Job): void {
  if (!(job.flags & JobFlags.QUEUED)) {
    queue.push(job);
    job.flags |= JobFlags.QUEUED;
  }
}

export function legalStrictNotZeroContinue(): void {
  for (let i = 0; i < queue.length; i++) {
    const job = queue[i];
    job();
    if ((job.flags & JobFlags.ALLOW_RECURSE) !== 0) continue;
    job.flags &= ~JobFlags.QUEUED;
  }
}

export function illegalStrictNotZeroClearInsideTrue(): void {
  for (let i = 0; i < queue.length; i++) {
    const job = queue[i];
    job();
    if ((job.flags & JobFlags.ALLOW_RECURSE) !== 0) {
      job.flags &= ~JobFlags.QUEUED;
    }
  }
}

export function legalLooseNotZeroContinue(): void {
  for (let i = 0; i < queue.length; i++) {
    const job = queue[i];
    job();
    if ((job.flags & JobFlags.ALLOW_RECURSE) != 0) continue;
    job.flags &= ~JobFlags.QUEUED;
  }
}

export function illegalLooseNotZeroClearInsideTrue(): void {
  for (let i = 0; i < queue.length; i++) {
    const job = queue[i];
    job();
    if ((job.flags & JobFlags.ALLOW_RECURSE) != 0) {
      job.flags &= ~JobFlags.QUEUED;
    }
  }
}

export function legalNotFalseContinue(): void {
  for (let i = 0; i < queue.length; i++) {
    const job = queue[i];
    job();
    if (Boolean(job.flags & JobFlags.ALLOW_RECURSE) !== false) continue;
    job.flags &= ~JobFlags.QUEUED;
  }
}

export function illegalNotFalseClearInsideTrue(): void {
  for (let i = 0; i < queue.length; i++) {
    const job = queue[i];
    job();
    if (Boolean(job.flags & JobFlags.ALLOW_RECURSE) !== false) {
      job.flags &= ~JobFlags.QUEUED;
    }
    if (Boolean(job.flags & JobFlags.ALLOW_RECURSE) != false) {
      job.flags &= ~JobFlags.QUEUED;
    }
  }
}

export function legalZeroLeftAndLooseEqAndGtZero(): void {
  for (let i = 0; i < queue.length; i++) {
    const job = queue[i];
    job();
    if (0 === (job.flags & JobFlags.ALLOW_RECURSE)) {
      job.flags &= ~JobFlags.QUEUED;
    }
    if ((job.flags & JobFlags.ALLOW_RECURSE) == 0) {
      job.flags &= ~JobFlags.QUEUED;
    }
    if (0 !== (job.flags & JobFlags.ALLOW_RECURSE)) continue;
    if ((job.flags & JobFlags.ALLOW_RECURSE) > 0) continue;
    job.flags &= ~JobFlags.QUEUED;
  }
}
