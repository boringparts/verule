import type { IDisposable } from "@acme/lifecycle";

export class Resource implements IDisposable {
  dispose(): void {}
}

export function createResource(): Resource {
  return new Resource();
}

export function passthrough<T>(value: T): T {
  return value;
}
