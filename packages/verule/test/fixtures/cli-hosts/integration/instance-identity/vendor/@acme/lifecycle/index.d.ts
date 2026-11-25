export interface IDisposable {
  dispose(): void;
}
export declare class Disposable {
  protected _register<T extends IDisposable>(o: T): T;
}
export interface IMenuService {
  createMenu(id: number): IDisposable;
}
export declare function createUntracked(): IDisposable;
