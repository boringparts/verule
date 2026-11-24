export interface IDisposable {
  dispose(): void;
}

export class DisposableStore implements IDisposable {
  private readonly items = new Set<IDisposable>();

  add<T extends IDisposable>(item: T): T {
    this.items.add(item);
    return item;
  }

  delete(item: IDisposable): void {
    this.items.delete(item);
  }

  deleteAndLeak(item: IDisposable): void {
    this.items.delete(item);
  }

  dispose(): void {
    for (const item of this.items) {
      item.dispose();
    }
    this.items.clear();
  }
}

export class Disposable implements IDisposable {
  protected readonly _store: DisposableStore = new DisposableStore();

  protected _register<T extends IDisposable>(item: T): T {
    return this._store.add(item);
  }

  dispose(): void {
    this._store.dispose();
  }
}

export class ResourcePool<T extends IDisposable> implements IDisposable {
  private readonly pool: T[] = [];
  private readonly factory: () => T;

  constructor(itemFactory: () => T) {
    this.factory = itemFactory;
  }

  get(): T {
    return this.pool.pop() ?? this.factory();
  }

  release(item: T): void {
    this.pool.push(item);
  }

  dispose(): void {
    for (const item of this.pool) {
      item.dispose();
    }
    this.pool.length = 0;
  }
}

export interface IInstantiationService {
  createInstance<T extends IDisposable>(
    ctor: new (...args: never[]) => T,
    ...args: unknown[]
  ): T;
}

export class ResourceLabels implements IDisposable {
  dispose(): void {}
}

export class WorkbenchList implements IDisposable {
  constructor(_labels: ResourceLabels) {}
  dispose(): void {}
}

export class CodeBlockPart implements IDisposable {
  dispose(): void {}
}

export function createFileIconThemableTreeContainerScope(): IDisposable {
  return {
    dispose(): void {},
  };
}
