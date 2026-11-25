declare function usePackage(name: string): void;
export function boot(): void {
  usePackage("zod");
}
