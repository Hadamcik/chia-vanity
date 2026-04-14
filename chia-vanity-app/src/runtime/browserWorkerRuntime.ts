import type {
    SearchCompletedPayload,
    SearchFailedPayload,
    SearchProgressPayload,
    SearchStatePayload,
    StartSearchRequest,
    VanityRuntime,
} from './types';

type EventPayloads = {
    progress: SearchProgressPayload;
    completed: SearchCompletedPayload;
    failed: SearchFailedPayload;
    state: SearchStatePayload;
};

type ListenerMap = {
    [K in keyof EventPayloads]: Array<(payload: EventPayloads[K]) => void>;
};

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
}

function finish(payload: SearchCompletedPayload) {
    running = false;

    for (const worker of workers) {
        worker.terminate();
    }
    workers = [];

    emit('state', { running: false });
    emit('completed', payload);
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

export const browserWorkerRuntime: VanityRuntime = {
    async startSearch(req: StartSearchRequest) {
        if (running) {
            throw new Error('search is already running');
        }

        running = true;
        resetRunState();
        emit('state', { running: true });

        const workerCount =
            req.workerCount > 0
                ? req.workerCount
                : Math.max(1, navigator.hardwareConcurrency || 1);

        pendingWorkers = workerCount;

        for (let workerId = 0; workerId < workerCount; workerId += 1) {
            const worker = new Worker(
                new URL('../workers/vanityWorker.ts', import.meta.url),
                { type: 'module' },
            );

            worker.onmessage = (event: MessageEvent<any>) => {
                const msg = event.data;

                if (msg.type === 'progress') {
                    totalChecked += Number(msg.payload.checked) || 0;

                    const elapsedSecs = (performance.now() - startedAt) / 1000;
                    const ratePerSec =
                        elapsedSecs > 0 ? totalChecked / elapsedSecs : 0;

                    emit('progress', {
                        checked: totalChecked,
                        ratePerSec,
                        elapsedSecs,
                    });
                    return;
                }

                if (msg.type === 'hit') {
                    const hit = msg.payload as NonNullable<SearchCompletedPayload['hit']>;

                    if (isBetterHit(hit, bestHit)) {
                        bestHit = hit;
                    }

                    for (const w of workers) {
                        w.postMessage({ type: 'stop' });
                    }

                    if (req.searchMode === 'fast') {
                        finish({ hit });
                    } else {
                        finish({ hit: bestHit });
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

                if (msg.type === 'done') {
                    pendingWorkers -= 1;
                    if (pendingWorkers <= 0 && running) {
                        finish({ hit: bestHit });
                    }
                    return;
                }

                if (msg.type === 'error') {
                    running = false;

                    for (const w of workers) {
                        w.terminate();
                    }
                    workers = [];

                    emit('state', { running: false });
                    emit('failed', { message: msg.payload.message });
                }
            };

            worker.onerror = (event) => {
                running = false;

                for (const w of workers) {
                    w.terminate();
                }
                workers = [];

                emit('state', { running: false });
                emit('failed', {
                    message: event.message || 'worker failed',
                });
            };

            workers.push(worker);

            worker.postMessage({
                type: 'start',
                payload: {
                    mnemonic: req.mnemonic,
                    wantedPrefix: req.wantedPrefix,
                    startIndex: req.startIndex + workerId,
                    step: workerCount,
                    mode: req.mode,
                    searchMode: req.searchMode,
                    reportEvery: 1000,
                },
            });
        }
    },

    async stopSearch() {
        if (!running) {
            return;
        }

        for (const worker of workers) {
            worker.postMessage({ type: 'stop' });
        }
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
