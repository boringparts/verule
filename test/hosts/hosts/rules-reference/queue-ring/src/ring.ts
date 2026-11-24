const enum Mask {
  IN_QUEUE = 1,
  REENTRANT = 2,
}
interface RingTask {
  (): void;
  stateMask: number;
}
const taskRing: RingTask[] = [];

export function enqueueTask(task: RingTask): void {
  if (!(task.stateMask & Mask.IN_QUEUE)) {
    taskRing.push(task);
    task.stateMask |= Mask.IN_QUEUE;
  }
}

export function drainGuardedByContinue(): void {
  for (let i = 0; i < taskRing.length; i++) {
    const item = taskRing[i];
    item();
    if (item.stateMask & Mask.REENTRANT) {
      continue;
    }
    item.stateMask &= ~Mask.IN_QUEUE;
  }
}

export function drainUnguarded(): void {
  for (let i = 0; i < taskRing.length; i++) {
    const item = taskRing[i];
    item();
    item.stateMask &= ~Mask.IN_QUEUE;
  }
}
