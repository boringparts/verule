import type { IDisposable } from "@acme/lifecycle";

export function releaseHelper(item: IDisposable): void {
  item.dispose();
}
