import { browserWorkerRuntime } from './browserWorkerRuntime.ts';
import { sageRuntime } from './sageRuntime.ts';
import { tauriRuntime } from './tauriRuntime.ts';
import { isInsideSage } from './sageHost.ts';

function isInsideTauri(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export const runtime = isInsideSage()
    ? sageRuntime
    : isInsideTauri()
        ? tauriRuntime
        : browserWorkerRuntime;
