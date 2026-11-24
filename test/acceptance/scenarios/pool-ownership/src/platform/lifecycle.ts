export interface IDisposable {
  dispose(): void;
}

export class DisposableStore implements IDisposable {
  private readonly items = new Set<IDisposable>();
  private disposed = false;

  get isDisposed(): boolean {
    return this.disposed;
  }

  add<T extends IDisposable>(item: T): T {
    if (this.disposed) {
      item.dispose();
      return item;
    }
    this.items.add(item);
    return item;
  }

  delete(item: IDisposable): void {
    this.items.delete(item);
  }

  deleteAndLeak(item: IDisposable): void {
    this.items.delete(item);
  }

  clear(): void {
    for (const item of this.items) {
      item.dispose();
    }
    this.items.clear();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clear();
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

  clear(): void {
    for (const item of this.pool) {
      item.dispose();
    }
    this.pool.length = 0;
  }

  dispose(): void {
    this.clear();
  }
}

export function disposeAll(items: readonly IDisposable[]): void {
  for (const item of items) {
    item.dispose();
  }
}
