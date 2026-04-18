export interface SagePermissions {
    network: boolean;
    persistent_storage: boolean;
}

export interface SageStorageInfo {
    bytesUsed: number;
    quotaBytes: number | null;
}

export interface SageHostBridge {
    getPermissions(): Promise<SagePermissions>;
    getStorageInfo(): Promise<SageStorageInfo>;
    resetStorage(): Promise<void>;
}

declare global {
    interface Window {
        __SAGE__?: SageHostBridge;
    }
}

export function getSageHost(): SageHostBridge | null {
    return typeof window !== 'undefined' && window.__SAGE__
        ? window.__SAGE__
        : null;
}

export function isInsideSage(): boolean {
    return getSageHost() !== null;
}
