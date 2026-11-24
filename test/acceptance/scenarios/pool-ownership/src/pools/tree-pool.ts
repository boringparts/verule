import {
  createFileIconThemableTreeContainerScope,
  ResourceLabels,
  WorkbenchTree,
  type IInstantiationService,
} from "../platform/instantiation.ts";
import {
  Disposable,
  DisposableStore,
  ResourcePool,
  type IDisposable,
} from "../platform/lifecycle.ts";
import { createWorkbenchContext } from "../services/workbench-context.ts";

export interface IWorkbenchTreePoolItem extends IDisposable {
  readonly tree: WorkbenchTree;
}

export class WorkbenchTreePool extends Disposable {
  private readonly pool: ResourcePool<IWorkbenchTreePoolItem>;
  private readonly instantiationService: IInstantiationService;
  private readonly context = createWorkbenchContext("workbench-tree", "tree");

  constructor(instantiationService: IInstantiationService) {
    super();
    this.instantiationService = instantiationService;
    this.pool = this._register(new ResourcePool(() => this.treeFactory()));
  }

  private treeFactory(): IWorkbenchTreePoolItem {
    const store = new DisposableStore();
    const resourceLabels = store.add(
      this.instantiationService.createInstance(ResourceLabels),
    );
    const containerScope = store.add(
      createFileIconThemableTreeContainerScope(this.context.panelId),
    );
    const tree = this.instantiationService.createInstance(
      WorkbenchTree,
      resourceLabels,
      containerScope,
      this.context.panelId,
    );
    return {
      tree,
      dispose: () => store.dispose(),
    };
  }

  borrow(): WorkbenchTree {
    return this.pool.get().tree;
  }
}
