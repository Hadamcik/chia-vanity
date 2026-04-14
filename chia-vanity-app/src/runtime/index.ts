import { browserWorkerRuntime } from './browserWorkerRuntime';
import { sageRuntime } from './sageRuntime';
import { tauriRuntime } from './tauriRuntime';
import { isInsideSage } from './sageHost';

function isInsideTauri(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export const runtime = isInsideSage()
    ? sageRuntime
    : isInsideTauri()
        ? tauriRuntime
        : browserWorkerRuntime;
