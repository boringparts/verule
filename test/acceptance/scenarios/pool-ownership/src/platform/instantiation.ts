import type { IDisposable } from "./lifecycle.ts";

export interface IInstantiationService {
  createInstance<T extends IDisposable, A extends readonly unknown[]>(
    ctor: new (...args: A) => T,
    ...args: A
  ): T;
}

export class InstantiationService implements IInstantiationService {
  private readonly scopeName: string;

  constructor(scopeName = "workbench") {
    this.scopeName = scopeName;
  }

  getScopeName(): string {
    return this.scopeName;
  }

  createInstance<T extends IDisposable, A extends readonly unknown[]>(
    ctor: new (...args: A) => T,
    ...args: A
  ): T {
    return new ctor(...args);
  }
}

export class ResourceLabels implements IDisposable {
  private disposed = false;

  get isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    this.disposed = true;
  }
}

export class WorkbenchList implements IDisposable {
  private readonly labels: ResourceLabels;
  private readonly panelId: string;
  private disposed = false;

  constructor(labels: ResourceLabels, panelId: string) {
    this.labels = labels;
    this.panelId = panelId;
  }

  describe(): string {
    return `${this.panelId}:${String(this.labels.isDisposed)}`;
  }

  dispose(): void {
    this.disposed = true;
  }

  isDisposed(): boolean {
    return this.disposed;
  }
}

export class WorkbenchTree implements IDisposable {
  private readonly labels: ResourceLabels;
  private readonly containerScope: IDisposable;
  private readonly viewId: string;
  private disposed = false;

  constructor(
    labels: ResourceLabels,
    containerScope: IDisposable,
    viewId: string,
  ) {
    this.labels = labels;
    this.containerScope = containerScope;
    this.viewId = viewId;
  }

  describe(): string {
    return `${this.viewId}:${String(this.labels.isDisposed)}:${String(this.disposed)}`;
  }

  dispose(): void {
    this.disposed = true;
    this.containerScope.dispose();
  }
}

export class CodeBlockPart implements IDisposable {
  private readonly languageId: string;
  private disposed = false;

  constructor(languageId: string) {
    this.languageId = languageId;
  }

  getLanguageId(): string {
    return this.languageId;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    this.disposed = true;
  }
}

export function createFileIconThemableTreeContainerScope(
  containerId: string,
): IDisposable {
  let disposed = false;
  return {
    dispose(): void {
      if (!disposed && containerId.length > 0) {
        disposed = true;
      }
    },
  };
}
