import { sageRuntime } from './sageRuntime';
import { tauriRuntime } from './tauriRuntime';
import type { VanityRuntime } from './types';

function isInsideSage(): boolean {
    return window.parent !== window && !('__TAURI_INTERNALS__' in window);
}

export const runtime: VanityRuntime = isInsideSage()
    ? sageRuntime
    : tauriRuntime;
