import type {
    CpuTuningPayload,
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

type WorkerSearchEngine = 'cpu' | 'gpu';

type SearchWorkerPlan = {
    engine: WorkerSearchEngine;
    offset: number;
    allowCpuFallback: boolean;
};

type SearchRange = {
    start: number;
    end: number;
};

type AdaptiveWorkerSlot = {
    worker: Worker;
    engine: WorkerSearchEngine;
    retiring: boolean;
    range: SearchRange | null;
    checkedInRange: number;
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
let reportedCpuWorkers: number | undefined;
let reportedCpuTuning: CpuTuningPayload | undefined;
let tuningTimer: ReturnType<typeof setTimeout> | null = null;

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
    reportedCpuWorkers = undefined;
    reportedCpuTuning = undefined;
}

function createWorker(): Worker {
    return new Worker(
        new URL('../workers/vanityWorker.ts', import.meta.url),
        { type: 'module' },
    );
}

function cleanupWorkers(clearCancelView = true) {
    if (tuningTimer !== null) {
        clearTimeout(tuningTimer);
        tuningTimer = null;
    }

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
        cpuWorkers: reportedCpuWorkers,
        cpuTuning: reportedCpuTuning,
    });
}

function normalWorkerCount(requested: number): number {
    return requested > 0
        ? requested
        : Math.max(1, navigator.hardwareConcurrency || 1);
}

function hybridCpuWorkerCount(requested: number): number {
    if (requested > 0) {
        return requested;
    }

    const logicalThreads = normalWorkerCount(0);

    // Hybrid search needs CPU time for WebGPU submission, readback, point
    // compression, hashing, and address encoding. Keep the default proportional
    // so it scales across small and large CPUs without assuming a fixed SMT layout.
    return Math.max(1, Math.round(logicalThreads * 0.47));
}

function normalChunkSize(requested: number): number {
    if (!Number.isFinite(requested) || requested <= 0) {
        return 10000;
    }

    return Math.max(1, Math.floor(requested));
}

function hasWebGpu(): boolean {
    return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

function cpuWorkerPlans(workerCount: number): SearchWorkerPlan[] {
    return Array.from({ length: workerCount }, (_, offset) => ({
        engine: 'cpu',
        offset,
        allowCpuFallback: false,
    }));
}

function buildWorkerPlans(req: StartSearchRequest): SearchWorkerPlan[] {
    if (req.engine === 'cpu') {
        return cpuWorkerPlans(normalWorkerCount(req.workerCount));
    }

    if (req.engine === 'gpu') {
        if (req.mode !== 'unhardened') {
            throw new Error('GPU search currently supports unhardened mode only');
        }
        if (!hasWebGpu()) {
            throw new Error('WebGPU is not available in this browser');
        }
        return [{ engine: 'gpu', offset: 0, allowCpuFallback: false }];
    }

    const gpuAvailable = req.mode === 'unhardened' && hasWebGpu();

    if (req.engine === 'hybrid') {
        if (!gpuAvailable) {
            return cpuWorkerPlans(normalWorkerCount(req.workerCount));
        }

        const cpuCount = hybridCpuWorkerCount(req.workerCount);
        return [
            { engine: 'gpu', offset: 0, allowCpuFallback: true },
            ...Array.from({ length: cpuCount }, (_, index) => ({
                engine: 'cpu' as const,
                offset: index + 1,
                allowCpuFallback: false,
            })),
        ];
    }

    if (gpuAvailable) {
        return [{ engine: 'gpu', offset: 0, allowCpuFallback: false }];
    }

    return cpuWorkerPlans(normalWorkerCount(req.workerCount));
}

function normalizePublicKeyHex(value: string): string {
    return value.trim().toLowerCase().replace(/^0x/, '');
}

function validateKeyMaterial(req: {
    mnemonic: string;
    masterSecretKey: string;
    masterPublicKey: string;
    mode: string;
}) {
    const mnemonic = req.mnemonic.trim();
    const masterSecretKey = normalizePublicKeyHex(req.masterSecretKey);
    const masterPublicKey = normalizePublicKeyHex(req.masterPublicKey);

    if (masterSecretKey && !/^[0-9a-f]{64}$/.test(masterSecretKey)) {
        throw new Error('master secret key must be 64 hex characters');
    }

    if (masterPublicKey && !/^[0-9a-f]{96}$/.test(masterPublicKey)) {
        throw new Error('master public key must be 96 hex characters');
    }

    if (req.mode === 'unhardened') {
        if (!mnemonic && !masterSecretKey && !masterPublicKey) {
            throw new Error('mnemonic, master secret key, or master public key is required for unhardened mode');
        }
        return;
    }

    if (!mnemonic && !masterSecretKey) {
        throw new Error('mnemonic or master secret key is required for hardened mode');
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
    engine: WorkerSearchEngine,
    keepAlive = false,
) {
    worker.postMessage({
        type: 'start',
        payload: {
            mnemonic: req.mnemonic,
            masterSecretKey: req.masterSecretKey,
            masterPublicKey: req.masterPublicKey,
            addressPrefix: req.addressPrefix,
            wantedPrefix: req.wantedPrefix,
            wantedSuffix: req.wantedSuffix,
            startIndex,
            endIndex,
            step,
            mode: req.mode,
            searchMode: req.searchMode,
            engine,
            keepAlive,
            reportEvery: 1000,
            cancelBuffer: cancelView?.buffer ?? null,
        },
    });
}

function removeWorker(worker: Worker) {
    const index = workers.indexOf(worker);
    if (index >= 0) {
        workers.splice(index, 1);
    }
}

const ADAPTIVE_CPU_RANGE_SIZE = 1024;
const ADAPTIVE_GPU_RANGE_SIZE = 65536;
const TUNING_SAMPLE_MS = 5000;
const TUNING_STABLE_DELTA = 0.005;
const TUNING_REQUIRED_SAMPLES = 4;
const TUNING_MAX_SAMPLES = 6;
const TUNING_MIN_IMPROVEMENT = 0.0025;

function startAdaptiveHybridFastSearch(req: StartSearchRequest, runId: number) {
    const logicalThreads = normalWorkerCount(0);
    const maxCpuWorkers = Math.max(1, logicalThreads - 1);
    const initialCpuWorkers = Math.min(
        maxCpuWorkers,
        hybridCpuWorkerCount(0),
    );
    const slots: AdaptiveWorkerSlot[] = [];
    const queuedRanges: SearchRange[] = [];
    let nextIndex = Math.max(0, Math.floor(req.startIndex));
    let gpuAvailable = true;
    let tuningActive = true;
    let targetCpuWorkers = initialCpuWorkers;
    let targetReady: (() => void) | null = null;
    let bestCpuWorkers = initialCpuWorkers;
    let bestRate = 0;

    const cpuSlots = () => slots.filter((slot) => slot.engine === 'cpu');

    const updateReportedCpuWorkers = () => {
        reportedCpuWorkers = cpuSlots().length;
        if (reportedCpuTuning) {
            reportedCpuTuning = {
                ...reportedCpuTuning,
                workers: reportedCpuWorkers,
            };
        }
    };

    const updateTuningProgress = (
        phase: CpuTuningPayload['phase'],
        sample = 0,
    ) => {
        reportedCpuTuning = {
            phase,
            workers: cpuSlots().length,
            sample,
            maxSamples: TUNING_MAX_SAMPLES,
            ...(bestRate > 0
                ? {
                    bestWorkers: bestCpuWorkers,
                    bestRatePerSec: bestRate,
                }
                : null),
        };
    };

    const takeRange = (requestedSize: number): SearchRange | null => {
        const queued = queuedRanges[0];
        if (queued) {
            const end = Math.min(queued.end, queued.start + requestedSize - 1);
            const range = { start: queued.start, end };

            if (end >= queued.end) {
                queuedRanges.shift();
            } else {
                queued.start = end + 1;
            }
            return range;
        }

        if (nextIndex > MAX_INDEX) {
            return null;
        }

        const end = Math.min(MAX_INDEX, nextIndex + requestedSize - 1);
        const range = { start: nextIndex, end };
        nextIndex = end >= MAX_INDEX ? MAX_INDEX + 1 : end + 1;
        return range;
    };

    const requeueRange = (range: SearchRange | null, checked: number) => {
        if (!range) {
            return;
        }

        const start = Math.min(range.end + 1, range.start + Math.max(0, checked));
        if (start <= range.end) {
            queuedRanges.unshift({ start, end: range.end });
        }
    };

    const allWorkFinished = () => (
        nextIndex > MAX_INDEX &&
        queuedRanges.length === 0 &&
        slots.every((slot) => slot.range === null)
    );

    const maybeFinish = () => {
        if (running && runId === activeRunId && allWorkFinished()) {
            finish({ hit: null });
        }
    };

    const stopTuning = () => {
        tuningActive = false;
        targetReady = null;
        if (tuningTimer !== null) {
            clearTimeout(tuningTimer);
            tuningTimer = null;
        }
    };

    const maybeTargetReady = () => {
        if (
            !tuningActive ||
            cpuSlots().length !== targetCpuWorkers ||
            cpuSlots().some((slot) => slot.retiring)
        ) {
            return;
        }

        const ready = targetReady;
        targetReady = null;
        ready?.();
    };

    const retireSlot = (slot: AdaptiveWorkerSlot) => {
        slot.worker.terminate();
        removeWorker(slot.worker);
        const index = slots.indexOf(slot);
        if (index >= 0) {
            slots.splice(index, 1);
        }
        updateReportedCpuWorkers();
        maybeTargetReady();
        maybeFinish();
    };

    const assignRange = (slot: AdaptiveWorkerSlot) => {
        if (!running || runId !== activeRunId) {
            return;
        }

        if (slot.retiring) {
            retireSlot(slot);
            return;
        }

        const range = takeRange(
            slot.engine === 'gpu' ? ADAPTIVE_GPU_RANGE_SIZE : ADAPTIVE_CPU_RANGE_SIZE,
        );
        if (!range) {
            slot.range = null;
            maybeFinish();
            return;
        }

        slot.range = range;
        slot.checkedInRange = 0;
        postStartToWorker(
            slot.worker,
            req,
            range.start,
            range.end,
            1,
            slot.engine,
            true,
        );
    };

    const createSlot = (engine: WorkerSearchEngine): AdaptiveWorkerSlot => {
        const worker = createWorker();
        const slot: AdaptiveWorkerSlot = {
            worker,
            engine,
            retiring: false,
            range: null,
            checkedInRange: 0,
        };

        const handleFailure = (message: string) => {
            if (!running || runId !== activeRunId || !slots.includes(slot)) {
                return;
            }

            if (slot.engine === 'gpu') {
                requeueRange(slot.range, slot.checkedInRange);
                slot.range = null;
                gpuAvailable = false;
                stopTuning();
                updateTuningProgress('gpu-fallback');
                retireSlot(slot);
                for (const cpuSlot of cpuSlots()) {
                    if (cpuSlot.range === null) {
                        assignRange(cpuSlot);
                    }
                }
                return;
            }

            fail(message);
        };

        worker.onmessage = (event: MessageEvent<any>) => {
            if (!running || runId !== activeRunId || !slots.includes(slot)) {
                return;
            }

            const msg = event.data;

            if (msg.type === 'progress') {
                const checked = Number(msg.payload.checked) || 0;
                slot.checkedInRange += checked;
                emitProgress(checked);
                return;
            }

            if (msg.type === 'hit') {
                if (cancelView) {
                    Atomics.store(cancelView, 0, 1);
                }
                finish({ hit: msg.payload });
                return;
            }

            if (msg.type === 'done') {
                slot.range = null;
                slot.checkedInRange = 0;
                assignRange(slot);
                return;
            }

            if (msg.type === 'stopped') {
                slot.range = null;
                retireSlot(slot);
                if (slots.length === 0 && running) {
                    finish({ hit: null });
                }
                return;
            }

            if (msg.type === 'error') {
                handleFailure(msg.payload.message);
            }
        };

        worker.onerror = (event) => {
            handleFailure(event.message || 'worker failed');
        };

        slots.push(slot);
        workers.push(worker);
        return slot;
    };

    const addCpuSlot = () => {
        const slot = createSlot('cpu');
        updateReportedCpuWorkers();
        assignRange(slot);
    };

    const setCpuTarget = (requested: number, onReady: () => void) => {
        if (!tuningActive || !running || runId !== activeRunId || !gpuAvailable) {
            return;
        }

        targetCpuWorkers = Math.max(1, Math.min(maxCpuWorkers, requested));
        targetReady = onReady;
        const current = cpuSlots().filter((slot) => !slot.retiring);

        try {
            for (let index = current.length; index < targetCpuWorkers; index += 1) {
                addCpuSlot();
            }
        } catch {
            updateTuningProgress('optimized');
            stopTuning();
            return;
        }

        const updated = cpuSlots().filter((slot) => !slot.retiring);
        for (let index = targetCpuWorkers; index < updated.length; index += 1) {
            updated[index].retiring = true;
            if (updated[index].range === null) {
                retireSlot(updated[index]);
            }
        }

        maybeTargetReady();
    };

    const measureStableRate = (
        phase: CpuTuningPayload['phase'],
        onMeasured: (rate: number) => void,
    ) => {
        const samples: number[] = [];
        let previousChecked = totalChecked;
        let previousAt = performance.now();
        updateTuningProgress(phase);

        const sample = () => {
            if (!tuningActive || !running || runId !== activeRunId || !gpuAvailable) {
                return;
            }

            const now = performance.now();
            const checked = totalChecked;
            const elapsed = (now - previousAt) / 1000;
            const rate = elapsed > 0 ? (checked - previousChecked) / elapsed : 0;
            samples.push(rate);
            updateTuningProgress(phase, samples.length);
            previousChecked = checked;
            previousAt = now;

            const recent = samples.slice(-2);
            const previous = samples.slice(-4, -2);
            const recentRate = recent.reduce((sum, value) => sum + value, 0) / recent.length;
            const previousRate = previous.length > 0
                ? previous.reduce((sum, value) => sum + value, 0) / previous.length
                : 0;
            const stable = samples.length >= TUNING_REQUIRED_SAMPLES &&
                Math.abs(recentRate - previousRate) /
                Math.max(1, recentRate, previousRate) <= TUNING_STABLE_DELTA;

            if (stable || samples.length >= TUNING_MAX_SAMPLES) {
                tuningTimer = null;
                const measured = samples.slice(-4);
                onMeasured(measured.reduce((sum, value) => sum + value, 0) / measured.length);
                return;
            }

            tuningTimer = setTimeout(sample, TUNING_SAMPLE_MS);
        };

        tuningTimer = setTimeout(sample, TUNING_SAMPLE_MS);
    };

    const settleAtBest = () => {
        setCpuTarget(bestCpuWorkers, () => {
            updateTuningProgress('optimized', TUNING_MAX_SAMPLES);
            stopTuning();
        });
    };

    const testDown = () => {
        const candidate = bestCpuWorkers - 1;
        if (candidate < 1) {
            settleAtBest();
            return;
        }

        setCpuTarget(candidate, () => {
            measureStableRate('testing-fewer', (rate) => {
                if (rate > bestRate * (1 + TUNING_MIN_IMPROVEMENT)) {
                    bestRate = rate;
                    bestCpuWorkers = candidate;
                    testDown();
                } else {
                    settleAtBest();
                }
            });
        });
    };

    const testUp = () => {
        const candidate = bestCpuWorkers + 1;
        if (candidate > maxCpuWorkers) {
            testDown();
            return;
        }

        setCpuTarget(candidate, () => {
            measureStableRate('testing-more', (rate) => {
                if (rate > bestRate * (1 + TUNING_MIN_IMPROVEMENT)) {
                    bestRate = rate;
                    bestCpuWorkers = candidate;
                    testUp();
                } else {
                    testDown();
                }
            });
        });
    };

    const gpuSlot = createSlot('gpu');
    assignRange(gpuSlot);
    for (let index = 0; index < initialCpuWorkers; index += 1) {
        addCpuSlot();
    }
    updateReportedCpuWorkers();

    measureStableRate('stabilizing', (rate) => {
        bestRate = rate;
        bestCpuWorkers = initialCpuWorkers;
        testUp();
    });
}

function startFastSearch(
    req: StartSearchRequest,
    workerPlans: SearchWorkerPlan[],
    runId: number,
) {
    const step = workerPlans.length;
    pendingWorkers = step;

    const startWorker = (plan: SearchWorkerPlan, startIndex: number) => {
        const worker = createWorker();
        let checkedByWorker = 0;
        let settled = false;

        const handleFailure = (message: string) => {
            if (settled || !running || runId !== activeRunId) {
                return;
            }

            if (plan.engine === 'gpu' && plan.allowCpuFallback) {
                settled = true;
                worker.terminate();
                removeWorker(worker);
                try {
                    startWorker(
                        { ...plan, engine: 'cpu', allowCpuFallback: false },
                        startIndex + checkedByWorker * step,
                    );
                } catch (error) {
                    fail(error instanceof Error ? error.message : String(error));
                }
                return;
            }

            fail(message);
        };

        worker.onmessage = (event: MessageEvent<any>) => {
            if (settled || !running || runId !== activeRunId) {
                return;
            }

            const msg = event.data;

            if (msg.type === 'progress') {
                const checked = Number(msg.payload.checked) || 0;
                checkedByWorker += checked;
                emitProgress(checked);
                return;
            }

            if (msg.type === 'hit') {
                settled = true;
                if (cancelView) {
                    Atomics.store(cancelView, 0, 1);
                }

                finish({ hit: msg.payload });
                return;
            }

            if (msg.type === 'stopped' || msg.type === 'done') {
                settled = true;
                pendingWorkers -= 1;
                if (pendingWorkers <= 0 && running) {
                    finish({ hit: null });
                }
                return;
            }

            if (msg.type === 'error') {
                handleFailure(msg.payload.message);
            }
        };

        worker.onerror = (event) => {
            handleFailure(event.message || 'worker failed');
        };

        workers.push(worker);
        postStartToWorker(worker, req, startIndex, null, step, plan.engine);
    };

    for (const plan of workerPlans) {
        startWorker(plan, req.startIndex + plan.offset);
    }
}

function startLowestSearch(
    req: StartSearchRequest,
    workerPlans: SearchWorkerPlan[],
    runId: number,
) {
    const chunkSize = normalChunkSize(req.chunkSize);
    const step = workerPlans.length;
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
        pendingWorkers = step;
        bestHit = null;

        const startWorker = (plan: SearchWorkerPlan, startIndex: number) => {
            const worker = createWorker();
            let checkedByWorker = 0;
            let settled = false;

            const handleFailure = (message: string) => {
                if (settled || !running || runId !== activeRunId) {
                    return;
                }

                if (plan.engine === 'gpu' && plan.allowCpuFallback) {
                    settled = true;
                    worker.terminate();
                    removeWorker(worker);
                    try {
                        startWorker(
                            { ...plan, engine: 'cpu', allowCpuFallback: false },
                            startIndex + checkedByWorker * step,
                        );
                    } catch (error) {
                        fail(error instanceof Error ? error.message : String(error));
                    }
                    return;
                }

                fail(message);
            };

            worker.onmessage = (event: MessageEvent<any>) => {
                if (settled || !running || runId !== activeRunId) {
                    return;
                }

                const msg = event.data;

                if (msg.type === 'progress') {
                    const checked = Number(msg.payload.checked) || 0;
                    checkedByWorker += checked;
                    emitProgress(checked);
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
                    settled = true;
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
                    settled = true;
                    pendingWorkers -= 1;
                    if (pendingWorkers <= 0 && running) {
                        finish({ hit: bestHit });
                    }
                    return;
                }

                if (msg.type === 'error') {
                    handleFailure(msg.payload.message);
                }
            };

            worker.onerror = (event) => {
                handleFailure(event.message || 'worker failed');
            };

            workers.push(worker);
            postStartToWorker(
                worker,
                req,
                startIndex,
                chunkEnd,
                step,
                plan.engine,
            );
        };

        for (const plan of workerPlans) {
            startWorker(plan, chunkStart + plan.offset);
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
        const workerPlans = buildWorkerPlans(req);
        const useAdaptiveHybrid = req.engine === 'hybrid' &&
            req.searchMode === 'fast' &&
            req.workerCount === 0 &&
            workerPlans.some((plan) => plan.engine === 'gpu');

        running = true;
        activeRunId += 1;
        resetRunState();
        ensureCancelView();
        emit('state', { running: true });

        try {
            if (useAdaptiveHybrid) {
                startAdaptiveHybridFastSearch(req, activeRunId);
            } else if (req.searchMode === 'lowest') {
                reportedCpuWorkers = workerPlans.filter((plan) => plan.engine === 'cpu').length;
                startLowestSearch(req, workerPlans, activeRunId);
            } else {
                reportedCpuWorkers = workerPlans.filter((plan) => plan.engine === 'cpu').length;
                startFastSearch(req, workerPlans, activeRunId);
            }
        } catch (error) {
            running = false;
            cleanupWorkers();
            emit('state', { running: false });
            throw error;
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
