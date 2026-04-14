/// <reference lib="webworker" />
import * as chiaWalletSdk from "chia-wallet-sdk-wasm/chia_wallet_sdk_wasm.js";

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
        const maybeInit =
            (chiaWalletSdk as { default?: () => Promise<unknown> }).default;

        if (typeof maybeInit === "function") {
            await maybeInit();
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

    const prefix = payload.wantedPrefix.toLowerCase().startsWith('txch1')
        ? 'txch'
        : 'xch';

    const mnemonic = new Mnemonic(payload.mnemonic);
    const seed = mnemonic.toSeed('');
    const masterSk = SecretKey.fromSeed(seed);
    const walletRoot = deriveWalletRoot(masterSk);

    let checked = 0;
    let bestHit: { index: number; mode: 'hardened' | 'unhardened'; address: string } | null = null;

    for (let index = payload.startIndex; index <= 0xffffffff; index += payload.step) {
        if (shouldStop) {
            postMessage({ type: 'stopped' } satisfies WorkerResponse);
            return;
        }

        const candidates = deriveCandidatesForIndex(walletRoot, index, payload.mode, prefix);
        checked += candidates.length;

        for (const candidate of candidates) {
            if (!candidate.address.toLowerCase().startsWith(payload.wantedPrefix.toLowerCase())) {
                continue;
            }

            if (payload.searchMode === 'fast') {
                postMessage({ type: 'hit', payload: candidate } satisfies WorkerResponse);
                return;
            }

            if (isBetterHit(candidate, bestHit)) {
                bestHit = candidate;
            }
        }

        if (checked >= payload.reportEvery) {
            postMessage({
                type: 'progress',
                payload: { checked },
            } satisfies WorkerResponse);
            checked = 0;
        }

        if (payload.searchMode === 'lowest' && bestHit) {
            postMessage({ type: 'hit', payload: bestHit } satisfies WorkerResponse);
            return;
        }
    }

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
