import {
    callSage,
    initSageBridge,
    isSageInjected,
    type SageAppInfo,
    type SageBridgeCapability,
    type SageKeyInfo,
    type SageSecretKeyInfo,
} from './sageBridge.ts';

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
    getAppInfo(): Promise<SageAppInfo>;
    getCapabilities(): Promise<SageBridgeCapability[]>;
    requestCapabilityGrant(capability: SageBridgeCapability): Promise<boolean>;
    getKey(): Promise<SageKeyInfo | null>;
    getSecretKey(fingerprint: number): Promise<SageSecretKeyInfo | null>;
}

interface GetKeyResponse {
    key: SageKeyInfo | null;
}

interface GetSecretKeyResponse {
    secrets: SageSecretKeyInfo | null;
}

interface RequestCapabilityGrantResponse {
    granted: boolean;
    alreadyGranted?: boolean | null;
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

async function ensureCapability(capability: SageBridgeCapability): Promise<boolean> {
    const capabilities = await callSage<SageBridgeCapability[]>('app.getCapabilities');

    if (capabilities.includes(capability)) {
        return true;
    }

    const response = await callSage<RequestCapabilityGrantResponse>(
        'app.requestCapabilityGrant',
        { capability },
    );

    return response.granted || Boolean(response.alreadyGranted);
}

export function getSageHost(): SageHostBridge | null {
    if (!initSageBridge()) {
        return null;
    }

    return {
        async getPermissions() {
            const capabilities = await callSage<SageBridgeCapability[]>('app.getCapabilities');

            return {
                network: true,
                persistent_storage: capabilities.includes('storage.persistent_webview'),
            };
        },

        async getStorageInfo() {
            return await currentStorageInfo();
        },

        async getAppInfo() {
            return await callSage<SageAppInfo>('app.getInfo');
        },

        async getCapabilities() {
            return await callSage<SageBridgeCapability[]>('app.getCapabilities');
        },

        async requestCapabilityGrant(capability) {
            return await ensureCapability(capability);
        },

        async getKey() {
            const allowed = await ensureCapability('wallet.get_key');
            if (!allowed) {
                return null;
            }

            const response = await callSage<GetKeyResponse>('wallet.getKey', {
                fingerprint: null,
            });

            return response.key;
        },

        async getSecretKey(fingerprint) {
            const allowed = await ensureCapability('wallet.get_secret_key');
            if (!allowed) {
                return null;
            }

            const response = await callSage<GetSecretKeyResponse>('wallet.getSecretKey', {
                fingerprint,
            });

            return response.secrets;
        },
    };
}

export function isInsideSage(): boolean {
    return isSageInjected();
}
