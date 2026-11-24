import {
  Disposable,
  ResourcePool,
  type IDisposable,
} from "../shared/lifecycle.ts";
import {
  allocateExternalHandle,
  releaseExternalHandle,
  type ExternalHandle,
} from "./external-gap.ts";

interface IExternalWrapper extends IDisposable {
  handle: ExternalHandle;
}

export class UnmodeledExternalPool extends Disposable {
  private readonly pool: ResourcePool<IExternalWrapper>;

  constructor() {
    super();
    this.pool = this._register(new ResourcePool(() => this.createEntry()));
  }

  private createEntry(): IExternalWrapper {
    const handle = allocateExternalHandle();
    const secondary = allocateExternalHandle();
    return {
      handle,
      dispose: () => releaseExternalHandle(secondary),
    };
  }

  borrow(): ExternalHandle {
    return this.pool.get().handle;
  }
}
