import { browserWorkerRuntime } from './browserWorkerRuntime.ts';
import { getSageHost } from './sageHost.ts';

type SageKeyWire = {
    fingerprint?: number;
    name?: string;
    public_key?: string;
    publicKey?: string;
    has_secrets?: boolean;
    hasSecrets?: boolean;
};

type SageSecretWire = {
    mnemonic?: string | null;
    secret_key?: string;
    secretKey?: string;
};

function normalizeSageKey(key: SageKeyWire) {
    const publicKey = key.public_key ?? key.publicKey;

    if (typeof key.fingerprint !== 'number' || !publicKey) {
        throw new Error('Sage did not return a usable public key.');
    }

    return {
        fingerprint: key.fingerprint,
        name: key.name ?? 'Sage key',
        publicKey,
        hasSecrets: key.has_secrets ?? key.hasSecrets ?? false,
    };
}

function normalizeSageSecret(secret: SageSecretWire) {
    const secretKey = secret.secret_key ?? secret.secretKey;

    if (!secretKey) {
        throw new Error('Sage did not return a usable private key.');
    }

    return {
        mnemonic: secret.mnemonic ?? null,
        secretKey,
    };
}

export const sageRuntime = {
    ...browserWorkerRuntime,

    async getHostCapabilities() {
        try {
            const host = getSageHost();
            if (!host) {
                return null;
            }

            const [permissions, storage] = await Promise.all([
                host.getPermissions(),
                host.getStorageInfo(),
            ]);

            return {
                permissions,
                storage,
            };
        } catch {
            return null;
        }
    },

    async resetAppStorage() {
        const host = getSageHost();
        if (!host) {
            throw new Error('Sage host bridge is not available');
        }

        throw new Error('Sage storage reset is not supported by this bridge');
    },

    async getSageKeyMaterial() {
        const host = getSageHost();
        if (!host) {
            throw new Error('Sage host bridge is not available');
        }

        const key = await host.getKey();
        if (!key) {
            return null;
        }

        return normalizeSageKey(key);
    },

    async getSageCapabilities() {
        try {
            const host = getSageHost();
            if (!host) {
                return [];
            }

            return await host.getCapabilities();
        } catch {
            return [];
        }
    },

    async getSageDerivedPublicKeys(offset: number, limit: number, hardened = false) {
        const host = getSageHost();
        if (!host) {
            throw new Error('Sage host bridge is not available');
        }

        return await host.getPublicKeys(offset, limit, hardened);
    },

    async onSageCapabilitiesChange(cb: (capabilities: string[]) => void) {
        const host = getSageHost();
        if (!host) {
            return () => {};
        }

        return host.onCapabilitiesChange(cb);
    },

    async getSageSecretKey() {
        const host = getSageHost();
        if (!host) {
            throw new Error('Sage host bridge is not available');
        }

        const secret = await host.getSecretKey();
        if (!secret) {
            return null;
        }

        return normalizeSageSecret(secret);
    },
};
