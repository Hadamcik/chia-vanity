/// <reference lib="webworker" />

import * as chiaWalletSdk from 'chia-wallet-sdk-wasm/chia_wallet_sdk_wasm.js';
import chiaWalletSdkWasmUrl from 'chia-wallet-sdk-wasm/chia_wallet_sdk_wasm_bg.wasm?url';
import webGpuVanityWasmUrl from '../../vendor-pkg/webgpu-vanity-wasm/webgpu_vanity_wasm_bg.wasm?url';

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
type RootKeys = {
    accountSk: SecretKeyInstance | null;
    accountPk: PublicKeyInstance | null;
};

type Mode = 'hardened' | 'unhardened' | 'both';
type SearchMode = 'fast' | 'lowest';
type SearchEngine = 'auto' | 'cpu' | 'gpu';

interface StartPayload {
    mnemonic: string;
    masterSecretKey: string;
    masterPublicKey: string;
    addressPrefix: 'xch' | 'txch';
    wantedPrefix: string;
    wantedSuffix: string;
    startIndex: number;
    endIndex: number | null;
    step: number;
    mode: Mode;
    searchMode: SearchMode;
    engine: SearchEngine;
    reportEvery: number;
    cancelBuffer: SharedArrayBuffer | null;
}

interface DerivePayload {
    mnemonic: string;
    masterSecretKey: string;
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

interface GpuBatchResult {
    checked: number;
    elapsedMs: number;
    hitIndex?: number;
    hitAddress?: string;
}

interface GpuSearcher {
    readonly batchCapacity: number;
    searchBatch(
        startIndex: number,
        count: number,
        step: number,
        addressPrefix: string,
        wantedPrefix: string,
        wantedSuffix: string,
    ): Promise<GpuBatchResult>;
    free(): void;
}

const CHIA_PURPOSE = 12381;
const CHIA_COIN_TYPE = 8444;
const CHIA_ACCOUNT = 2;
const CHIA_ACCOUNT_PATH = [
    CHIA_PURPOSE,
    CHIA_COIN_TYPE,
    CHIA_ACCOUNT,
];

let initialized = false;
let shouldStop = false;
let webGpuInitialized = false;
let webGpuModule: typeof import('../../vendor-pkg/webgpu-vanity-wasm/webgpu_vanity_wasm.js') | null = null;

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

async function ensureWebGpuInit() {
    if (!webGpuModule) {
        // Load the generated glue and binary from the same vendored build. A pre-bundled
        // file dependency can otherwise leave old glue paired with a newly rebuilt WASM.
        webGpuModule = await import('../../vendor-pkg/webgpu-vanity-wasm/webgpu_vanity_wasm.js');
    }

    if (!webGpuInitialized) {
        await webGpuModule.default(webGpuVanityWasmUrl);
        webGpuInitialized = true;
    }

    return webGpuModule;
}

function standardAddressForPk(publicKey: PublicKeyInstance, prefix: string): string {
    const syntheticPk = publicKey.deriveSynthetic();

    try {
        const puzzleHash = standardPuzzleHash(syntheticPk);
        const address = new Address(puzzleHash, prefix);

        try {
            return address.encode();
        } finally {
            address.free();
        }
    } finally {
        syntheticPk.free();
    }
}

function standardAddressForSk(secretKey: SecretKeyInstance, prefix: string): string {
    const publicKey = secretKey.publicKey();

    try {
        return standardAddressForPk(publicKey, prefix);
    } finally {
        publicKey.free();
    }
}

function deriveUnhardenedPkForIndex(
    accountPk: PublicKeyInstance,
    index: number,
): PublicKeyInstance {
    return accountPk.deriveUnhardened(index);
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
        publicKey.free();
        throw new Error('master public key is invalid');
    }

    return publicKey;
}

function masterSecretKeyFromMnemonic(mnemonicPhrase: string): SecretKeyInstance {
    const mnemonic = new Mnemonic(mnemonicPhrase);

    try {
        const seed = mnemonic.toSeed('');
        return SecretKey.fromSeed(seed);
    } finally {
        mnemonic.free();
    }
}

function masterSecretKeyFromHex(value: string): SecretKeyInstance {
    const normalized = normalizePublicKeyHex(value);

    if (!/^[0-9a-f]{64}$/.test(normalized)) {
        throw new Error('master secret key must be 64 hex characters');
    }

    return SecretKey.fromBytes(fromHex(normalized));
}

function masterSecretKeyFromPayload(payload: {
    mnemonic: string;
    masterSecretKey: string;
}): SecretKeyInstance {
    const secretKeyHex = normalizePublicKeyHex(payload.masterSecretKey);

    if (secretKeyHex.length > 0) {
        return masterSecretKeyFromHex(secretKeyHex);
    }

    if (payload.mnemonic.trim().length === 0) {
        throw new Error('mnemonic or master secret key is required for hardened mode');
    }

    return masterSecretKeyFromMnemonic(payload.mnemonic);
}

function masterPublicKeyFromPayload(payload: {
    mnemonic: string;
    masterSecretKey: string;
    masterPublicKey: string;
}): PublicKeyInstance {
    const publicKeyHex = normalizePublicKeyHex(payload.masterPublicKey);

    if (publicKeyHex.length > 0) {
        return publicKeyFromHex(publicKeyHex);
    }

    const secretKeyHex = normalizePublicKeyHex(payload.masterSecretKey);

    if (secretKeyHex.length > 0) {
        const secretKey = masterSecretKeyFromHex(secretKeyHex);

        try {
            return secretKey.publicKey();
        } finally {
            secretKey.free();
        }
    }

    if (payload.mnemonic.trim().length === 0) {
        throw new Error('mnemonic, master secret key, or master public key is required for unhardened mode');
    }

    const secretKey = masterSecretKeyFromMnemonic(payload.mnemonic);

    try {
        return secretKey.publicKey();
    } finally {
        secretKey.free();
    }
}

function rootKeysFromPayload(payload: {
    mnemonic: string;
    masterSecretKey: string;
    masterPublicKey: string;
    mode: Mode;
}): RootKeys {
    if (payload.mode === 'unhardened') {
        const masterPk = masterPublicKeyFromPayload(payload);

        try {
            return {
                accountSk: null,
                accountPk: masterPk.deriveUnhardenedPath(CHIA_ACCOUNT_PATH),
            };
        } finally {
            masterPk.free();
        }
    }

    const masterSk = masterSecretKeyFromPayload(payload);

    try {
        const accountSk = masterSk.deriveHardenedPath(CHIA_ACCOUNT_PATH);

        if (payload.mode === 'hardened') {
            return { accountSk, accountPk: null };
        }

        try {
            const masterPk = masterSk.publicKey();

            try {
                return {
                    accountSk,
                    accountPk: masterPk.deriveUnhardenedPath(CHIA_ACCOUNT_PATH),
                };
            } finally {
                masterPk.free();
            }
        } catch (error) {
            accountSk.free();
            throw error;
        }
    } finally {
        masterSk.free();
    }
}

function freeRootKeys(root: RootKeys) {
    root.accountPk?.free();
    root.accountSk?.free();
}

function deriveHardenedSkForIndex(
    accountSk: SecretKeyInstance,
    index: number,
): SecretKeyInstance {
    return accountSk.deriveHardened(index);
}

function deriveCandidatesForIndex(
    root: RootKeys,
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
        if (!root.accountPk) {
            throw new Error('mnemonic or master public key is required for unhardened mode');
        }

        const publicKey = deriveUnhardenedPkForIndex(root.accountPk, index);

        try {
            out.push({
                index,
                mode: 'unhardened',
                address: standardAddressForPk(publicKey, prefix),
            });
        } finally {
            publicKey.free();
        }
    }

    if (mode === 'hardened' || mode === 'both') {
        if (!root.accountSk) {
            throw new Error('mnemonic is required for hardened mode');
        }

        const secretKey = deriveHardenedSkForIndex(root.accountSk, index);

        try {
            out.push({
                index,
                mode: 'hardened',
                address: standardAddressForSk(secretKey, prefix),
            });
        } finally {
            secretKey.free();
        }
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

async function runCpuSearch(payload: StartPayload) {
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
    const prefix = payload.addressPrefix;

    const root = rootKeysFromPayload(payload);

    try {
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
    } finally {
        freeRootKeys(root);
    }
}

async function createGpuSearchContext(payload: StartPayload): Promise<{
    root: RootKeys;
    searcher: GpuSearcher;
}> {
    await ensureInit();
    const gpu = await ensureWebGpuInit();
    const root = rootKeysFromPayload(payload);

    try {
        if (!root.accountPk) {
            throw new Error('GPU search requires an unhardened account public key');
        }

        const searcher = await gpu.WebGpuVanitySearch.create(root.accountPk.toBytes());
        return { root, searcher };
    } catch (error) {
        freeRootKeys(root);
        throw error;
    }
}

async function runGpuSearch(
    payload: StartPayload,
    root: RootKeys,
    searcher: GpuSearcher,
) {
    const cancelView = payload.cancelBuffer
        ? new Int32Array(payload.cancelBuffer)
        : null;
    const endIndex = payload.endIndex ?? 0xffffffff;
    const prefix = payload.addressPrefix;
    const wantedPrefixLower = payload.wantedPrefix.toLowerCase();
    const wantedSuffixLower = payload.wantedSuffix.toLowerCase();
    let index = payload.startIndex;

    try {
        while (index <= endIndex) {
            if (
                shouldStop ||
                (cancelView !== null && Atomics.load(cancelView, 0) === 1)
            ) {
                postMessage({ type: 'stopped' } satisfies WorkerResponse);
                return;
            }

            const remaining = Math.floor((endIndex - index) / payload.step) + 1;
            const count = Math.min(searcher.batchCapacity, remaining);
            const result = await searcher.searchBatch(
                index,
                count,
                payload.step,
                prefix,
                wantedPrefixLower,
                wantedSuffixLower,
            );

            if (
                typeof result.hitIndex === 'number' &&
                typeof result.hitAddress === 'string'
            ) {
                const verified = deriveCandidatesForIndex(
                    root,
                    result.hitIndex,
                    'unhardened',
                    prefix,
                )[0];

                if (
                    !verified ||
                    verified.address.toLowerCase() !== result.hitAddress?.toLowerCase() ||
                    !matchesWantedAddress(
                        verified.address,
                        wantedPrefixLower,
                        wantedSuffixLower,
                    )
                ) {
                    throw new Error(
                        `GPU candidate ${result.hitIndex} failed canonical CPU verification ` +
                        `(GPU ${result.hitAddress ?? 'missing'}, CPU ${verified?.address ?? 'missing'})`,
                    );
                }

                postMessage({
                    type: 'progress',
                    payload: { checked: result.checked },
                } satisfies WorkerResponse);

                if (payload.searchMode === 'fast') {
                    postMessage({ type: 'hit', payload: verified } satisfies WorkerResponse);
                } else {
                    postMessage({
                        type: 'done',
                        payload: { hit: verified },
                    } satisfies WorkerResponse);
                }
                return;
            }

            postMessage({
                type: 'progress',
                payload: { checked: result.checked },
            } satisfies WorkerResponse);

            if (count >= remaining) {
                break;
            }
            index += count * payload.step;
        }

        postMessage({ type: 'done', payload: { hit: null } } satisfies WorkerResponse);
    } finally {
        searcher.free();
        freeRootKeys(root);
    }
}

async function runSearch(payload: StartPayload) {
    if (payload.engine === 'cpu') {
        await runCpuSearch(payload);
        return;
    }

    if (payload.mode !== 'unhardened') {
        if (payload.engine === 'auto') {
            await runCpuSearch(payload);
            return;
        }
        throw new Error('GPU search currently supports unhardened mode only');
    }

    let context: Awaited<ReturnType<typeof createGpuSearchContext>>;
    try {
        context = await createGpuSearchContext(payload);
    } catch (error) {
        if (payload.engine === 'auto') {
            await runCpuSearch(payload);
            return;
        }
        throw error;
    }

    await runGpuSearch(payload, context.root, context.searcher);
}

async function runDerive(payload: DerivePayload) {
    await ensureInit();

    const root = rootKeysFromPayload(payload);

    try {
        const candidates = deriveCandidatesForIndex(
            root,
            payload.index,
            payload.mode,
            payload.addressPrefix,
        );

        postMessage({ type: 'derived', payload: candidates } satisfies WorkerResponse);
    } finally {
        freeRootKeys(root);
    }
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
