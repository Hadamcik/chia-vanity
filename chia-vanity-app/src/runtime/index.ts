import { browserWorkerRuntime } from './browserWorkerRuntime';
import type { VanityRuntime } from './types';

export const runtime: VanityRuntime = browserWorkerRuntime;
