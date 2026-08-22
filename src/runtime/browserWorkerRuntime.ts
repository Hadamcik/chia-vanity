import type {
    DeriveAddressPayload,
    DeriveAddressRequest,
    SearchCompletedPayload,
    SearchFailedPayload,
    SearchHitPayload,
    SearchProgressPayload,
    SearchStatePayload,
    StartSearchRequest,
    VanityRuntime,
} from './types.ts';
import { validateWantedPatterns } from '../lib/vanityValidation.ts';

type EventPayloads = {
    progress: SearchProgressPayload;
    completed: SearchCompletedPayload;
    failed: SearchFailedPayload;
    state: SearchStatePayload;
};

type ListenerMap = {
    [K in keyof EventPayloads]: Array<(payload: EventPayloads[K]) => void>;
};

type WorkerDonePayload = {
    hit: SearchHitPayload | null;
};

const MAX_INDEX = 0xffffffff;

const listeners: ListenerMap = {
    progress: [],
    completed: [],
    failed: [],
    state: [],
};

let running = false;
let startedAt = 0;
let totalChecked = 0;
let workers: Worker[] = [];
let pendingWorkers = 0;
let bestHit: SearchCompletedPayload['hit'] = null;
let cancelView: Int32Array | null = null;
let activeRunId = 0;

function emit<K extends keyof EventPayloads>(
    kind: K,
    payload: EventPayloads[K],
) {
    for (const listener of listeners[kind]) {
        listener(payload);
    }
}

function subscribe<K extends keyof EventPayloads>(
    kind: K,
    cb: (payload: EventPayloads[K]) => void,
): Promise<() => void> {
    const bucket = listeners[kind] as Array<(payload: EventPayloads[K]) => void>;
    bucket.push(cb);

    return Promise.resolve(() => {
        const idx = bucket.indexOf(cb);
        if (idx >= 0) {
            bucket.splice(idx, 1);
        }
    });
}

function resetRunState() {
    totalChecked = 0;
    startedAt = performance.now();
    pendingWorkers = 0;
    bestHit = null;
    cancelView = null;
}

function createWorker(): Worker {
    return new Worker(
        new URL('../workers/vanityWorker.ts', import.meta.url),
        { type: 'module' },
    );
}

function cleanupWorkers(clearCancelView = true) {
    for (const worker of workers) {
        worker.terminate();
    }
    workers = [];

    if (clearCancelView) {
        cancelView = null;
    }
}

function finish(payload: SearchCompletedPayload) {
    running = false;
    cleanupWorkers();
    emit('state', { running: false });
    emit('completed', payload);
}

function fail(message: string) {
    running = false;
    cleanupWorkers();
    emit('state', { running: false });
    emit('failed', { message });
}

function isBetterHit(
    nextHit: NonNullable<SearchCompletedPayload['hit']>,
    currentHit: SearchCompletedPayload['hit'],
): boolean {
    if (!currentHit) {
        return true;
    }

    if (nextHit.index < currentHit.index) {
        return true;
    }

    if (nextHit.index > currentHit.index) {
        return false;
    }

    return nextHit.mode === 'unhardened' && currentHit.mode === 'hardened';
}

function emitProgress(checked: number) {
    totalChecked += checked;

    const elapsedSecs = (performance.now() - startedAt) / 1000;
    const ratePerSec = elapsedSecs > 0 ? totalChecked / elapsedSecs : 0;

    emit('progress', {
        checked: totalChecked,
        ratePerSec,
        elapsedSecs,
    });
}

function normalWorkerCount(requested: number): number {
    return requested > 0
        ? requested
        : Math.max(1, navigator.hardwareConcurrency || 1);
}

function normalChunkSize(requested: number): number {
    if (!Number.isFinite(requested) || requested <= 0) {
        return 10000;
    }

    return Math.max(1, Math.floor(requested));
}

function normalizePublicKeyHex(value: string): string {
    return value.trim().toLowerCase().replace(/^0x/, '');
}

function validateKeyMaterial(req: { mnemonic: string; masterPublicKey: string; mode: string }) {
    const mnemonic = req.mnemonic.trim();
    const masterPublicKey = normalizePublicKeyHex(req.masterPublicKey);

    if (masterPublicKey && !/^[0-9a-f]{96}$/.test(masterPublicKey)) {
        throw new Error('master public key must be 96 hex characters');
    }

    if (req.mode === 'unhardened') {
        if (!mnemonic && !masterPublicKey) {
            throw new Error('mnemonic or master public key is required for unhardened mode');
        }
        return;
    }

    if (!mnemonic) {
        throw new Error('mnemonic is required for hardened mode');
    }
}

function ensureCancelView() {
    if (typeof SharedArrayBuffer !== 'undefined') {
        const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
        cancelView = new Int32Array(buffer);
        Atomics.store(cancelView, 0, 0);
    }
}

function postStartToWorker(
    worker: Worker,
    req: StartSearchRequest,
    startIndex: number,
    endIndex: number | null,
    step: number,
) {
    worker.postMessage({
        type: 'start',
        payload: {
            mnemonic: req.mnemonic,
            masterPublicKey: req.masterPublicKey,
            wantedPrefix: req.wantedPrefix,
            wantedSuffix: req.wantedSuffix,
            startIndex,
            endIndex,
            step,
            mode: req.mode,
            searchMode: req.searchMode,
            reportEvery: 1000,
            cancelBuffer: cancelView?.buffer ?? null,
        },
    });
}

function startFastSearch(req: StartSearchRequest, workerCount: number, runId: number) {
    pendingWorkers = workerCount;

    for (let workerId = 0; workerId < workerCount; workerId += 1) {
        const worker = createWorker();

        worker.onmessage = (event: MessageEvent<any>) => {
            if (!running || runId !== activeRunId) {
                return;
            }

            const msg = event.data;

            if (msg.type === 'progress') {
                emitProgress(Number(msg.payload.checked) || 0);
                return;
            }

            if (msg.type === 'hit') {
                if (cancelView) {
                    Atomics.store(cancelView, 0, 1);
                }

                finish({ hit: msg.payload });
                return;
            }

            if (msg.type === 'stopped' || msg.type === 'done') {
                pendingWorkers -= 1;
                if (pendingWorkers <= 0 && running) {
                    finish({ hit: null });
                }
                return;
            }

            if (msg.type === 'error') {
                fail(msg.payload.message);
            }
        };

        worker.onerror = (event) => {
            if (running && runId === activeRunId) {
                fail(event.message || 'worker failed');
            }
        };

        workers.push(worker);
        postStartToWorker(worker, req, req.startIndex + workerId, null, workerCount);
    }
}

function startLowestSearch(req: StartSearchRequest, workerCount: number, runId: number) {
    const chunkSize = normalChunkSize(req.chunkSize);
    let chunkStart = Math.max(0, Math.floor(req.startIndex));

    const startChunk = () => {
        if (!running || runId !== activeRunId) {
            return;
        }

        cleanupWorkers(false);

        if (chunkStart > MAX_INDEX) {
            finish({ hit: null });
            return;
        }

        const chunkEnd = Math.min(MAX_INDEX, chunkStart + chunkSize - 1);
        pendingWorkers = workerCount;
        bestHit = null;

        for (let workerId = 0; workerId < workerCount; workerId += 1) {
            const worker = createWorker();

            worker.onmessage = (event: MessageEvent<any>) => {
                if (!running || runId !== activeRunId) {
                    return;
                }

                const msg = event.data;

                if (msg.type === 'progress') {
                    emitProgress(Number(msg.payload.checked) || 0);
                    return;
                }

                if (msg.type === 'hit') {
                    const hit = msg.payload as NonNullable<SearchCompletedPayload['hit']>;

                    if (isBetterHit(hit, bestHit)) {
                        bestHit = hit;
                    }
                    return;
                }

                if (msg.type === 'done') {
                    const done = msg.payload as WorkerDonePayload;

                    if (done.hit && isBetterHit(done.hit, bestHit)) {
                        bestHit = done.hit;
                    }

                    pendingWorkers -= 1;
                    if (pendingWorkers <= 0 && running) {
                        if (bestHit) {
                            finish({ hit: bestHit });
                        } else if (chunkEnd >= MAX_INDEX) {
                            finish({ hit: null });
                        } else {
                            chunkStart = chunkEnd + 1;
                            startChunk();
                        }
                    }
                    return;
                }

                if (msg.type === 'stopped') {
                    pendingWorkers -= 1;
                    if (pendingWorkers <= 0 && running) {
                        finish({ hit: bestHit });
                    }
                    return;
                }

                if (msg.type === 'error') {
                    fail(msg.payload.message);
                }
            };

            worker.onerror = (event) => {
                if (running && runId === activeRunId) {
                    fail(event.message || 'worker failed');
                }
            };

            workers.push(worker);
            postStartToWorker(
                worker,
                req,
                chunkStart + workerId,
                chunkEnd,
                workerCount,
            );
        }
    };

    startChunk();
}

function deriveInWorker(req: DeriveAddressRequest): Promise<DeriveAddressPayload[]> {
    return new Promise((resolve, reject) => {
        const worker = createWorker();

        worker.onmessage = (event: MessageEvent<any>) => {
            const msg = event.data;

            if (msg.type === 'derived') {
                worker.terminate();
                resolve(msg.payload as DeriveAddressPayload[]);
                return;
            }

            if (msg.type === 'error') {
                worker.terminate();
                reject(new Error(msg.payload.message));
            }
        };

        worker.onerror = (event) => {
            worker.terminate();
            reject(new Error(event.message || 'worker failed'));
        };

        worker.postMessage({ type: 'derive', payload: req });
    });
}

export const browserWorkerRuntime: VanityRuntime = {
    async startSearch(req: StartSearchRequest) {
        if (running) {
            throw new Error('search is already running');
        }

        const validationError = validateWantedPatterns(req.wantedPrefix, req.wantedSuffix);

        if (validationError) {
            throw new Error(validationError);
        }

        validateKeyMaterial(req);

        running = true;
        activeRunId += 1;
        resetRunState();
        ensureCancelView();
        emit('state', { running: true });

        const workerCount = normalWorkerCount(req.workerCount);

        if (req.searchMode === 'lowest') {
            startLowestSearch(req, workerCount, activeRunId);
        } else {
            startFastSearch(req, workerCount, activeRunId);
        }
    },

    async stopSearch() {
        if (!running) {
            return;
        }

        if (cancelView) {
            Atomics.store(cancelView, 0, 1);
            return;
        }

        finish({ hit: bestHit });
    },

    async deriveAddresses(req: DeriveAddressRequest) {
        validateKeyMaterial(req);
        return deriveInWorker(req);
    },

    async getSearchState() {
        return { running };
    },

    async onSearchProgress(cb) {
        return subscribe('progress', cb);
    },

    async onSearchCompleted(cb) {
        return subscribe('completed', cb);
    },

    async onSearchFailed(cb) {
        return subscribe('failed', cb);
    },

    async onSearchState(cb) {
        return subscribe('state', cb);
    },
};
