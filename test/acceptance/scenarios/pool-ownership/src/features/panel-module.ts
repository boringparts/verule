import { disposeAll, type IDisposable } from "../platform/lifecycle.ts";
import {
  createWorkbenchContext,
  summarizePanelMetrics,
  type PanelDescriptor,
  type ViewMetrics,
} from "../services/workbench-context.ts";

export class PanelFeatureController implements IDisposable {
  private readonly descriptors: PanelDescriptor[] = [];
  private readonly subscriptions: IDisposable[] = [];
  private readonly context = createWorkbenchContext("panel-overview", "list");

  registerPanel(descriptor: PanelDescriptor): void {
    this.descriptors.push(descriptor);
  }

  track(subscription: IDisposable): void {
    this.subscriptions.push(subscription);
  }

  snapshot(): { readonly tag: string; readonly metrics: ViewMetrics } {
    return {
      tag: this.context.formatTag(String(this.descriptors.length)),
      metrics: summarizePanelMetrics(this.descriptors),
    };
  }

  dispose(): void {
    disposeAll(this.subscriptions);
    this.subscriptions.length = 0;
  }
}

export function evaluatePanelDescriptors(
  descriptors: readonly PanelDescriptor[],
): ViewMetrics {
  return summarizePanelMetrics(descriptors);
}
