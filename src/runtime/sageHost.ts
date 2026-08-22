import {
    getSageClient,
    hasSageBridge,
    isSageRuntimeAvailable,
    type AppGetInfoResult,
    type GrantedCapabilitiesChangeEvent,
    type KeyInfo,
    type SecretKeyInfo,
    type UserBridgeCapability,
} from 'sage-app-sdk';

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
    getAppInfo(): Promise<AppGetInfoResult>;
    getCapabilities(): Promise<string[]>;
    onCapabilitiesChange(cb: (capabilities: string[]) => void): () => void;
    requestCapabilityGrant(capability: UserBridgeCapability): Promise<boolean>;
    getKey(): Promise<KeyInfo | null>;
    getSecretKey(fingerprint: number): Promise<SecretKeyInfo | null>;
}

async function currentStorageInfo(): Promise<SageStorageInfo> {
    if (!navigator.storage?.estimate) {
        return {
            bytesUsed: 0,
            quotaBytes: null,
        };
    }

    const estimate = await navigator.storage.estimate();

    return {
        bytesUsed: estimate.usage ?? 0,
        quotaBytes: estimate.quota ?? null,
    };
}

async function ensureCapability(capability: UserBridgeCapability): Promise<boolean> {
    const client = await getSageClient();
    const capabilities = await client.app.getCapabilities();

    if (capabilities.includes(capability)) {
        return true;
    }

    const response = await client.app.requestCapabilityGrant({ capability });

    return response.granted || Boolean(response.alreadyGranted);
}

export function getSageHost(): SageHostBridge | null {
    if (!isInsideSage()) {
        return null;
    }

    return {
        async getPermissions() {
            const client = await getSageClient();
            const capabilities = await client.app.getCapabilities();

            return {
                network: true,
                persistent_storage: capabilities.includes('storage.persistent_webview'),
            };
        },

        async getStorageInfo() {
            return await currentStorageInfo();
        },

        async getAppInfo() {
            const client = await getSageClient();
            return await client.app.getInfo();
        },

        async getCapabilities() {
            const client = await getSageClient();
            return await client.app.getCapabilities();
        },

        onCapabilitiesChange(cb) {
            let cancelled = false;
            let unlisten: (() => void) | null = null;

            void getSageClient()
                .then((client) => {
                    if (cancelled) {
                        return;
                    }

                    unlisten = client.app.onGrantedCapabilitiesChange(
                        (event: GrantedCapabilitiesChangeEvent) => cb(event.full),
                    );
                })
                .catch(() => {});

            return () => {
                cancelled = true;
                unlisten?.();
            };
        },

        async requestCapabilityGrant(capability) {
            return await ensureCapability(capability);
        },

        async getKey() {
            const allowed = await ensureCapability('wallet.get_key');
            if (!allowed) {
                return null;
            }

            const client = await getSageClient();
            const response = await client.wallet.getKey({
                fingerprint: null,
            });

            return response.key;
        },

        async getSecretKey(fingerprint) {
            const allowed = await ensureCapability('wallet.get_secret_key');
            if (!allowed) {
                return null;
            }

            const client = await getSageClient();
            const response = await client.wallet.getSecretKey({
                fingerprint,
            });

            return response.secrets;
        },
    };
}

export function isInsideSage(): boolean {
    return isSageRuntimeAvailable() || hasSageBridge();
}
