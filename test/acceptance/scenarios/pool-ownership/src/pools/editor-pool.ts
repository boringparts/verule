import {
  CodeBlockPart,
  type IInstantiationService,
} from "../platform/instantiation.ts";
import { Disposable, ResourcePool } from "../platform/lifecycle.ts";
import { createWorkbenchContext } from "../services/workbench-context.ts";

export class EditorWidgetPool extends Disposable {
  private readonly pool: ResourcePool<CodeBlockPart>;
  private readonly instantiationService: IInstantiationService;
  private readonly context = createWorkbenchContext("editor-widget", "editor");

  constructor(instantiationService: IInstantiationService) {
    super();
    this.instantiationService = instantiationService;
    this.pool = this._register(
      new ResourcePool(() => this.createEditorWidget()),
    );
  }

  private createEditorWidget(): CodeBlockPart {
    return this.instantiationService.createInstance(
      CodeBlockPart,
      this.context.formatTag("ts"),
    );
  }

  borrow(): CodeBlockPart {
    return this.pool.get();
  }
}
