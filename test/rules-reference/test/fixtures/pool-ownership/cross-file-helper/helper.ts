import type { DisposableStore, IDisposable } from "../shared/lifecycle.ts";

export function registerOnOuterStore(
  outerStore: DisposableStore,
  child: IDisposable,
): void {
  outerStore.add(child);
}

export function registerOnItemStore(
  itemStore: DisposableStore,
  child: IDisposable,
): void {
  itemStore.add(child);
}
