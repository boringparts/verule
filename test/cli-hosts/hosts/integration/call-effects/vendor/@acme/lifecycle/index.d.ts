export interface IDisposable {
  dispose(): void;
}
export declare function createResource(label: string): IDisposable;
export declare function onDidClose(cb: () => void): IDisposable;
