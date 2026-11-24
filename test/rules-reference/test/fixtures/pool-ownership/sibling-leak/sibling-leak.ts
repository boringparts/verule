import {
  Disposable,
  ResourceLabels,
  ResourcePool,
  WorkbenchList,
  type IDisposable,
  type IInstantiationService,
} from "../shared/lifecycle.ts";

interface ISiblingWrapper extends IDisposable {
  list: WorkbenchList;
}

export class SiblingLeakPool extends Disposable {
  private readonly pool: ResourcePool<ISiblingWrapper>;
  private readonly instantiationService: IInstantiationService;

  constructor(instantiationService: IInstantiationService) {
    super();
    this.instantiationService = instantiationService;
    this.pool = this._register(new ResourcePool(() => this.buildItem()));
  }

  private buildItem(): ISiblingWrapper {
    const primaryLabels =
      this.instantiationService.createInstance(ResourceLabels);
    const leakedLabels =
      this.instantiationService.createInstance(ResourceLabels);
    const list = this.instantiationService.createInstance(
      WorkbenchList,
      leakedLabels,
    );
    return {
      list,
      dispose: () => primaryLabels.dispose(),
    };
  }

  borrow(): WorkbenchList {
    return this.pool.get().list;
  }
}
