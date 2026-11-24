import {
  CodeBlockPart,
  Disposable,
  DisposableStore,
  ResourceLabels,
  ResourcePool,
  WorkbenchList,
  createFileIconThemableTreeContainerScope,
  type IDisposable,
  type IInstantiationService,
} from "../shared/lifecycle.ts";

interface IListWrapper extends IDisposable {
  list: WorkbenchList;
}

export class BuggyCollapsibleListPool extends Disposable {
  private readonly pool: ResourcePool<WorkbenchList>;
  private readonly instantiationService: IInstantiationService;

  constructor(instantiationService: IInstantiationService) {
    super();
    this.instantiationService = instantiationService;
    this.pool = this._register(new ResourcePool(() => this.listFactory()));
  }

  private listFactory(): WorkbenchList {
    const resourceLabels = this._register(
      this.instantiationService.createInstance(ResourceLabels),
    );
    this._register(createFileIconThemableTreeContainerScope());
    return this.instantiationService.createInstance(
      WorkbenchList,
      resourceLabels,
    );
  }

  borrow(): WorkbenchList {
    return this.pool.get();
  }
}

export class FixedCollapsibleListPool extends Disposable {
  private readonly pool: ResourcePool<IListWrapper>;
  private readonly instantiationService: IInstantiationService;

  constructor(instantiationService: IInstantiationService) {
    super();
    this.instantiationService = instantiationService;
    this.pool = this._register(new ResourcePool(() => this.listFactory()));
  }

  private listFactory(): IListWrapper {
    const store = new DisposableStore();
    const resourceLabels = store.add(
      this.instantiationService.createInstance(ResourceLabels),
    );
    store.add(createFileIconThemableTreeContainerScope());
    const list = this.instantiationService.createInstance(
      WorkbenchList,
      resourceLabels,
    );
    return {
      list,
      dispose: () => store.dispose(),
    };
  }

  borrow(): WorkbenchList {
    return this.pool.get().list;
  }
}

export class DirectEditorPool extends Disposable {
  private readonly pool: ResourcePool<CodeBlockPart>;

  constructor(instantiationService: IInstantiationService) {
    super();
    this.pool = this._register(
      new ResourcePool(() => {
        return instantiationService.createInstance(CodeBlockPart);
      }),
    );
  }

  borrow(): CodeBlockPart {
    return this.pool.get();
  }
}
