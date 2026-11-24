export type PanelDescriptor = {
  readonly id: string;
  readonly activeItems: number;
  readonly pinned: boolean;
};

export type ViewMetrics = {
  readonly totalPanels: number;
  readonly pinnedPanels: number;
  readonly totalActiveItems: number;
};

export interface WorkbenchContext {
  readonly panelId: string;
  readonly kind: "list" | "tree" | "editor";
  formatTag(suffix: string): string;
}

export function createWorkbenchContext(
  panelId: string,
  kind: "list" | "tree" | "editor" = "list",
): WorkbenchContext {
  return {
    panelId,
    kind,
    formatTag(suffix: string): string {
      return `${panelId}:${kind}:${suffix}`;
    },
  };
}

export function summarizePanelMetrics(
  descriptors: readonly PanelDescriptor[],
): ViewMetrics {
  let pinnedPanels = 0;
  let totalActiveItems = 0;
  for (const descriptor of descriptors) {
    if (descriptor.pinned) {
      pinnedPanels += 1;
    }
    totalActiveItems += descriptor.activeItems;
  }
  return {
    totalPanels: descriptors.length,
    pinnedPanels,
    totalActiveItems,
  };
}
