import {
  Disposable,
  DisposableStore,
  ResourceLabels,
  ResourcePool as ItemPool,
  WorkbenchList,
  type IDisposable,
  type IInstantiationService,
} from "../shared/lifecycle.ts";
import { registerOnItemStore, registerOnOuterStore } from "./helper.ts";

interface IItemWrapper extends IDisposable {
  list: WorkbenchList;
}

export class BuggyCrossFilePool extends Disposable {
  private readonly outerStore: DisposableStore = new DisposableStore();
  private readonly pool: ItemPool<WorkbenchList>;
  private readonly instantiationService: IInstantiationService;

  constructor(instantiationService: IInstantiationService) {
    super();
    this.instantiationService = instantiationService;
    this._register(this.outerStore);
    this.pool = this._register(new ItemPool(() => this.createItem()));
  }

  private createItem(): WorkbenchList {
    const labels = this.instantiationService.createInstance(ResourceLabels);
    registerOnOuterStore(this.outerStore, labels);
    return this.instantiationService.createInstance(WorkbenchList, labels);
  }

  borrow(): WorkbenchList {
    return this.pool.get();
  }
}

export class CleanCrossFilePool extends Disposable {
  private readonly pool: ItemPool<IItemWrapper>;
  private readonly instantiationService: IInstantiationService;

  constructor(instantiationService: IInstantiationService) {
    super();
    this.instantiationService = instantiationService;
    this.pool = this._register(new ItemPool(() => this.createItem()));
  }

  private createItem(): IItemWrapper {
    const store = new DisposableStore();
    const labels = this.instantiationService.createInstance(ResourceLabels);
    registerOnItemStore(store, labels);
    const list = this.instantiationService.createInstance(
      WorkbenchList,
      labels,
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
