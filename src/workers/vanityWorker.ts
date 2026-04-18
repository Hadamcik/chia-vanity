/// <reference lib="webworker" />

import * as chiaWalletSdk from 'chia-wallet-sdk-wasm/chia_wallet_sdk_wasm.js';
import chiaWalletSdkWasmUrl from 'chia-wallet-sdk-wasm/chia_wallet_sdk_wasm_bg.wasm?url';

const {
    Address,
    Mnemonic,
    SecretKey,
    standardPuzzleHash,
} = chiaWalletSdk;

type SecretKeyInstance = InstanceType<typeof chiaWalletSdk.SecretKey>;

type Mode = 'hardened' | 'unhardened' | 'both';
type SearchMode = 'fast' | 'lowest';

interface StartPayload {
    mnemonic: string;
    wantedPrefix: string;
    startIndex: number;
    step: number;
    mode: Mode;
    searchMode: SearchMode;
    reportEvery: number;
    cancelBuffer: SharedArrayBuffer | null;
}

type WorkerMessage =
    | { type: 'start'; payload: StartPayload }
    | { type: 'stop' };

type WorkerResponse =
    | { type: 'progress'; payload: { checked: number } }
    | {
    type: 'hit';
    payload: { index: number; mode: 'hardened' | 'unhardened'; address: string };
}
    | { type: 'done' }
    | { type: 'stopped' }
    | { type: 'error'; payload: { message: string } };

const CHIA_PURPOSE = 12381;
const CHIA_COIN_TYPE = 8444;
const CHIA_ACCOUNT = 2;

let initialized = false;
let shouldStop = false;

async function ensureInit() {
    if (!initialized) {
        const mod = chiaWalletSdk as {
            default?: (
                input?: RequestInfo | URL | Response | BufferSource | WebAssembly.Module
            ) => Promise<unknown>;
            initSync?: (input?: BufferSource | WebAssembly.Module) => unknown;
        };

        if (typeof mod.default === 'function') {
            await mod.default(chiaWalletSdkWasmUrl);
        }

        initialized = true;
    }
}

function deriveWalletRoot(masterSk: SecretKeyInstance): SecretKeyInstance {
    return masterSk.deriveHardenedPath([
        CHIA_PURPOSE,
        CHIA_COIN_TYPE,
        CHIA_ACCOUNT,
    ]);
}

function standardAddressForChildSk(childSk: SecretKeyInstance, prefix: string): string {
    const syntheticPk = childSk.publicKey().deriveSynthetic();
    const puzzleHash = standardPuzzleHash(syntheticPk);
    const address = new Address(puzzleHash, prefix);
    return address.encode();
}

function deriveCandidatesForIndex(
    walletRoot: SecretKeyInstance,
    index: number,
    mode: Mode,
    prefix: string,
): Array<{ index: number; mode: 'hardened' | 'unhardened'; address: string }> {
    const out: Array<{
        index: number;
        mode: 'hardened' | 'unhardened';
        address: string;
    }> = [];

    if (mode === 'unhardened' || mode === 'both') {
        const child = walletRoot.deriveUnhardened(index);
        out.push({
            index,
            mode: 'unhardened',
            address: standardAddressForChildSk(child, prefix),
        });
    }

    if (mode === 'hardened' || mode === 'both') {
        const child = walletRoot.deriveHardened(index);
        out.push({
            index,
            mode: 'hardened',
            address: standardAddressForChildSk(child, prefix),
        });
    }

    return out;
}

function isBetterHit(
    nextHit: { index: number; mode: 'hardened' | 'unhardened'; address: string },
    currentHit: { index: number; mode: 'hardened' | 'unhardened'; address: string } | null,
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

async function runSearch(payload: StartPayload) {
    await ensureInit();

    const cancelView = payload.cancelBuffer
        ? new Int32Array(payload.cancelBuffer)
        : null;

    let checkedSinceLastReport = 0;
    let lastReportAt = performance.now();

    function flushProgress(force = false) {
        const now = performance.now();

        if (
            checkedSinceLastReport > 0 &&
            (
                force ||
                checkedSinceLastReport >= payload.reportEvery ||
                now - lastReportAt >= 200
            )
        ) {
            postMessage({
                type: 'progress',
                payload: { checked: checkedSinceLastReport },
            } satisfies WorkerResponse);

            checkedSinceLastReport = 0;
            lastReportAt = now;
        }
    }

    const wantedPrefixLower = payload.wantedPrefix.toLowerCase();
    const prefix = wantedPrefixLower.startsWith('txch1') ? 'txch' : 'xch';

    const mnemonic = new Mnemonic(payload.mnemonic);
    const seed = mnemonic.toSeed('');
    const masterSk = SecretKey.fromSeed(seed);
    const walletRoot = deriveWalletRoot(masterSk);

    let bestHit: { index: number; mode: 'hardened' | 'unhardened'; address: string } | null = null;

    for (let index = payload.startIndex; index <= 0xffffffff; index += payload.step) {
        if (
            shouldStop ||
            (cancelView !== null && Atomics.load(cancelView, 0) === 1)
        ) {
            flushProgress(true);
            postMessage({ type: 'stopped' } satisfies WorkerResponse);
            return;
        }

        const candidates = deriveCandidatesForIndex(walletRoot, index, payload.mode, prefix);
        checkedSinceLastReport += candidates.length;

        for (const candidate of candidates) {
            if (!candidate.address.toLowerCase().startsWith(wantedPrefixLower)) {
                continue;
            }

            if (payload.searchMode === 'fast') {
                flushProgress(true);
                postMessage({ type: 'hit', payload: candidate } satisfies WorkerResponse);
                return;
            }

            if (isBetterHit(candidate, bestHit)) {
                bestHit = candidate;
            }
        }

        flushProgress();

        if (payload.searchMode === 'lowest' && bestHit) {
            flushProgress(true);
            postMessage({ type: 'hit', payload: bestHit } satisfies WorkerResponse);
            return;
        }
    }

    flushProgress(true);
    postMessage({ type: 'done' } satisfies WorkerResponse);
}

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
    const msg = event.data;

    if (msg.type === 'stop') {
        shouldStop = true;
        return;
    }

    if (msg.type === 'start') {
        shouldStop = false;

        void runSearch(msg.payload).catch((error: unknown) => {
            postMessage({
                type: 'error',
                payload: {
                    message: error instanceof Error ? error.message : String(error),
                },
            } satisfies WorkerResponse);
        });
    }
};
