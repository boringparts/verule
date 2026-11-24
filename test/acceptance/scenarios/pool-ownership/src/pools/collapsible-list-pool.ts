import {
  ResourceLabels,
  WorkbenchList,
  type IInstantiationService,
} from "../platform/instantiation.ts";
import {
  Disposable,
  ResourcePool,
  type IDisposable,
} from "../platform/lifecycle.ts";
import { createWorkbenchContext } from "../services/workbench-context.ts";

export interface ICollapsibleListPoolItem extends IDisposable {
  readonly list: WorkbenchList;
}

export class CollapsibleListPool extends Disposable {
  private readonly pool: ResourcePool<ICollapsibleListPoolItem>;
  private readonly instantiationService: IInstantiationService;
  private readonly context = createWorkbenchContext("collapsible-list", "list");

  constructor(instantiationService: IInstantiationService) {
    super();
    this.instantiationService = instantiationService;
    this.pool = this._register(new ResourcePool(() => this.listFactory()));
  }

  private listFactory(): ICollapsibleListPoolItem {
    const resourceLabels = this._register(
      this.instantiationService.createInstance(ResourceLabels),
    );
    const list = this.instantiationService.createInstance(
      WorkbenchList,
      resourceLabels,
      this.context.panelId,
    );
    return {
      list,
      dispose: () => list.dispose(),
    };
  }

  borrow(): WorkbenchList {
    return this.pool.get().list;
  }
}
