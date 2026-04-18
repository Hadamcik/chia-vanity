import { browserWorkerRuntime } from './browserWorkerRuntime.ts';
import { getSageHost } from './sageHost.ts';

export const sageRuntime = {
    ...browserWorkerRuntime,

    async getHostCapabilities() {
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
    },

    async resetAppStorage() {
        const host = getSageHost();
        if (!host) {
            throw new Error('Sage host bridge is not available');
        }

        await host.resetStorage();
    },
};
