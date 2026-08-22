/// <reference lib="webworker" />

import * as chiaWalletSdk from 'chia-wallet-sdk-wasm/chia_wallet_sdk_wasm.js';
import chiaWalletSdkWasmUrl from 'chia-wallet-sdk-wasm/chia_wallet_sdk_wasm_bg.wasm?url';

const {
    Address,
    Mnemonic,
    PublicKey,
    SecretKey,
    fromHex,
    standardPuzzleHash,
} = chiaWalletSdk;

type SecretKeyInstance = InstanceType<typeof chiaWalletSdk.SecretKey>;
type PublicKeyInstance = InstanceType<typeof chiaWalletSdk.PublicKey>;

type Mode = 'hardened' | 'unhardened' | 'both';
type SearchMode = 'fast' | 'lowest';

interface StartPayload {
    mnemonic: string;
    masterPublicKey: string;
    wantedPrefix: string;
    wantedSuffix: string;
    startIndex: number;
    endIndex: number | null;
    step: number;
    mode: Mode;
    searchMode: SearchMode;
    reportEvery: number;
    cancelBuffer: SharedArrayBuffer | null;
}

interface DerivePayload {
    mnemonic: string;
    masterPublicKey: string;
    index: number;
    mode: Mode;
    addressPrefix: 'xch' | 'txch';
}

type WorkerMessage =
    | { type: 'start'; payload: StartPayload }
    | { type: 'derive'; payload: DerivePayload }
    | { type: 'stop' };

type WorkerResponse =
    | { type: 'progress'; payload: { checked: number } }
    | {
    type: 'hit';
    payload: { index: number; mode: 'hardened' | 'unhardened'; address: string };
}
    | {
    type: 'derived';
    payload: Array<{ index: number; mode: 'hardened' | 'unhardened'; address: string }>;
}
    | {
    type: 'done';
    payload: { hit: { index: number; mode: 'hardened' | 'unhardened'; address: string } | null };
}
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

function standardAddressForPk(publicKey: PublicKeyInstance, prefix: string): string {
    const syntheticPk = publicKey.deriveSynthetic();
    const puzzleHash = standardPuzzleHash(syntheticPk);
    const address = new Address(puzzleHash, prefix);
    return address.encode();
}

function standardAddressForSk(secretKey: SecretKeyInstance, prefix: string): string {
    return standardAddressForPk(secretKey.publicKey(), prefix);
}

function deriveUnhardenedPkForIndex(
    masterPk: PublicKeyInstance,
    index: number,
): PublicKeyInstance {
    return masterPk.deriveUnhardenedPath([
        CHIA_PURPOSE,
        CHIA_COIN_TYPE,
        CHIA_ACCOUNT,
        index,
    ]);
}

function normalizePublicKeyHex(value: string): string {
    return value.trim().toLowerCase().replace(/^0x/, '');
}

function publicKeyFromHex(value: string): PublicKeyInstance {
    const normalized = normalizePublicKeyHex(value);

    if (!/^[0-9a-f]{96}$/.test(normalized)) {
        throw new Error('master public key must be 96 hex characters');
    }

    const publicKey = PublicKey.fromBytes(fromHex(normalized));

    if (!publicKey.isValid() || publicKey.isInfinity()) {
        throw new Error('master public key is invalid');
    }

    return publicKey;
}

function masterSecretKeyFromMnemonic(mnemonicPhrase: string): SecretKeyInstance {
    const mnemonic = new Mnemonic(mnemonicPhrase);
    const seed = mnemonic.toSeed('');
    return SecretKey.fromSeed(seed);
}

function masterPublicKeyFromPayload(payload: {
    mnemonic: string;
    masterPublicKey: string;
}): PublicKeyInstance {
    const publicKeyHex = normalizePublicKeyHex(payload.masterPublicKey);

    if (publicKeyHex.length > 0) {
        return publicKeyFromHex(publicKeyHex);
    }

    if (payload.mnemonic.trim().length === 0) {
        throw new Error('mnemonic or master public key is required for unhardened mode');
    }

    return masterSecretKeyFromMnemonic(payload.mnemonic).publicKey();
}

function deriveHardenedSkForIndex(
    masterSk: SecretKeyInstance,
    index: number,
): SecretKeyInstance {
    return masterSk.deriveHardenedPath([
        CHIA_PURPOSE,
        CHIA_COIN_TYPE,
        CHIA_ACCOUNT,
        index,
    ]);
}

function deriveCandidatesForIndex(
    root: {
        masterSk: SecretKeyInstance | null;
        masterPk: PublicKeyInstance | null;
    },
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
        const masterPk = root.masterPk ?? root.masterSk?.publicKey();

        if (!masterPk) {
            throw new Error('mnemonic or master public key is required for unhardened mode');
        }

        const publicKey = deriveUnhardenedPkForIndex(masterPk, index);
        out.push({
            index,
            mode: 'unhardened',
            address: standardAddressForPk(publicKey, prefix),
        });
    }

    if (mode === 'hardened' || mode === 'both') {
        if (!root.masterSk) {
            throw new Error('mnemonic is required for hardened mode');
        }

        const secretKey = deriveHardenedSkForIndex(root.masterSk, index);
        out.push({
            index,
            mode: 'hardened',
            address: standardAddressForSk(secretKey, prefix),
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

function matchesWantedAddress(
    address: string,
    wantedPrefixLower: string,
    wantedSuffixLower: string,
): boolean {
    const addressLower = address.toLowerCase();

    if (
        wantedPrefixLower.length > 0 &&
        !addressLower.startsWith(wantedPrefixLower)
    ) {
        return false;
    }

    if (
        wantedSuffixLower.length > 0 &&
        !addressLower.endsWith(wantedSuffixLower)
    ) {
        return false;
    }

    return true;
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
    const wantedSuffixLower = payload.wantedSuffix.toLowerCase();
    const prefix = wantedPrefixLower.startsWith('txch1') ? 'txch' : 'xch';

    const root = payload.mode === 'unhardened'
        ? {
            masterSk: null,
            masterPk: masterPublicKeyFromPayload(payload),
        }
        : {
            masterSk: masterSecretKeyFromMnemonic(payload.mnemonic),
            masterPk: null,
        };

    let bestHit: { index: number; mode: 'hardened' | 'unhardened'; address: string } | null = null;

    const endIndex = payload.endIndex ?? 0xffffffff;

    for (let index = payload.startIndex; index <= endIndex; index += payload.step) {
        if (
            shouldStop ||
            (cancelView !== null && Atomics.load(cancelView, 0) === 1)
        ) {
            flushProgress(true);
            postMessage({ type: 'stopped' } satisfies WorkerResponse);
            return;
        }

        const candidates = deriveCandidatesForIndex(root, index, payload.mode, prefix);
        checkedSinceLastReport += candidates.length;

        for (const candidate of candidates) {
            if (!matchesWantedAddress(candidate.address, wantedPrefixLower, wantedSuffixLower)) {
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
    }

    flushProgress(true);
    postMessage({ type: 'done', payload: { hit: bestHit } } satisfies WorkerResponse);
}

async function runDerive(payload: DerivePayload) {
    await ensureInit();

    const root = payload.mode === 'unhardened'
        ? {
            masterSk: null,
            masterPk: masterPublicKeyFromPayload(payload),
        }
        : {
            masterSk: masterSecretKeyFromMnemonic(payload.mnemonic),
            masterPk: null,
        };

    const candidates = deriveCandidatesForIndex(
        root,
        payload.index,
        payload.mode,
        payload.addressPrefix,
    );

    postMessage({ type: 'derived', payload: candidates } satisfies WorkerResponse);
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

    if (msg.type === 'derive') {
        shouldStop = false;

        void runDerive(msg.payload).catch((error: unknown) => {
            postMessage({
                type: 'error',
                payload: {
                    message: error instanceof Error ? error.message : String(error),
                },
            } satisfies WorkerResponse);
        });
    }
};
