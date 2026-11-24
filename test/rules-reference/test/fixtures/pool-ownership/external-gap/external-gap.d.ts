export interface ExternalHandle {
  dispose(): void;
}

export declare function allocateExternalHandle(): ExternalHandle;
export declare function releaseExternalHandle(handle: ExternalHandle): void;
