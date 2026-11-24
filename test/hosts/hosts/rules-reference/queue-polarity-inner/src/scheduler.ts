const enum JobFlags {
  QUEUED = 1,
  ALLOW_RECURSE = 2,
}
interface Job {
  (): void;
  flags: number;
}
const queue: Job[] = [];
function noop(): void {}

export function enqueueJob(job: Job): void {
  if (!(job.flags & JobFlags.QUEUED)) {
    queue.push(job);
    job.flags |= JobFlags.QUEUED;
  }
}

export function legalZeroEqualityGuard(): void {
  for (let i = 0; i < queue.length; i++) {
    const job = queue[i];
    job();
    if ((job.flags & JobFlags.ALLOW_RECURSE) === 0) {
      job.flags &= ~JobFlags.QUEUED;
    }
  }
}

export function illegalZeroEqualityContinue(): void {
  for (let i = 0; i < queue.length; i++) {
    const job = queue[i];
    job();
    if ((job.flags & JobFlags.ALLOW_RECURSE) === 0) {
      continue;
    }
    job.flags &= ~JobFlags.QUEUED;
  }
}

export function legalInnerContinueInvocation(): void {
  for (let i = 0; i < queue.length; i++) {
    const job = queue[i];
    job();
    if (job.flags & JobFlags.ALLOW_RECURSE) {
      job();
      continue;
    }
    job.flags &= ~JobFlags.QUEUED;
  }
}

export function illegalPreCallGuard(): void {
  for (let i = 0; i < queue.length; i++) {
    const job = queue[i];
    if (!(job.flags & JobFlags.ALLOW_RECURSE)) {
      noop();
    }
    job();
    job.flags &= ~JobFlags.QUEUED;
  }
}

export function illegalInnerFallthroughInvocation(): void {
  for (let i = 0; i < queue.length; i++) {
    const job = queue[i];
    job();
    if (job.flags & JobFlags.ALLOW_RECURSE) {
      job();
    }
    job.flags &= ~JobFlags.QUEUED;
  }
}

export function illegalInsideSafeBranchInvocation(): void {
  for (let i = 0; i < queue.length; i++) {
    const job = queue[i];
    if (!(job.flags & JobFlags.ALLOW_RECURSE)) {
      job();
    } else {
      continue;
    }
    job.flags &= ~JobFlags.QUEUED;
  }
}

export function legalBooleanFalseGuard(): void {
  for (let i = 0; i < queue.length; i++) {
    const job = queue[i];
    job();
    if (Boolean(job.flags & JobFlags.ALLOW_RECURSE) === false) {
      job.flags &= ~JobFlags.QUEUED;
    }
  }
}
