import { browserWorkerRuntime } from './browserWorkerRuntime.ts';
import { sageRuntime } from './sageRuntime.ts';

export const runtime = {
    ...browserWorkerRuntime,
    getHostCapabilities: sageRuntime.getHostCapabilities,
    resetAppStorage: sageRuntime.resetAppStorage,
    getSageKeyMaterial: sageRuntime.getSageKeyMaterial,
    getSageCapabilities: sageRuntime.getSageCapabilities,
    getSageDerivedPublicKeys: sageRuntime.getSageDerivedPublicKeys,
    onSageCapabilitiesChange: sageRuntime.onSageCapabilitiesChange,
    getSageSecretKey: sageRuntime.getSageSecretKey,
};
