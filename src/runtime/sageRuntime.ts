import { browserWorkerRuntime } from './browserWorkerRuntime.ts';
import { getSageHost } from './sageHost.ts';

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

        return {
            fingerprint: key.fingerprint,
            name: key.name,
            publicKey: key.public_key,
            hasSecrets: key.has_secrets,
        };
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

    async onSageCapabilitiesChange(cb: (capabilities: string[]) => void) {
        const host = getSageHost();
        if (!host) {
            return () => {};
        }

        return host.onCapabilitiesChange(cb);
    },

    async getSageSecretKey(fingerprint: number) {
        const host = getSageHost();
        if (!host) {
            throw new Error('Sage host bridge is not available');
        }

        const secret = await host.getSecretKey(fingerprint);
        if (!secret) {
            return null;
        }

        return {
            mnemonic: secret.mnemonic,
            secretKey: secret.secret_key,
        };
    },
};
