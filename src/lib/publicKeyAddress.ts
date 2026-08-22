import * as chiaWalletSdk from 'chia-wallet-sdk-wasm/chia_wallet_sdk_wasm.js';
import chiaWalletSdkWasmUrl from 'chia-wallet-sdk-wasm/chia_wallet_sdk_wasm_bg.wasm?url';

const {
    Address,
    PublicKey,
    fromHex,
    standardPuzzleHash,
} = chiaWalletSdk;

type PublicKeyInstance = InstanceType<typeof chiaWalletSdk.PublicKey>;

let initialized = false;

async function ensureInit() {
    if (initialized) {
        return;
    }

    const mod = chiaWalletSdk as {
        default?: (
            input?: RequestInfo | URL | Response | BufferSource | WebAssembly.Module
        ) => Promise<unknown>;
    };

    if (typeof mod.default === 'function') {
        await mod.default(chiaWalletSdkWasmUrl);
    }

    initialized = true;
}

function normalizePublicKeyHex(value: string): string {
    return value.trim().toLowerCase().replace(/^0x/, '');
}

function publicKeyFromHex(value: string): PublicKeyInstance {
    const normalized = normalizePublicKeyHex(value);

    if (!/^[0-9a-f]{96}$/.test(normalized)) {
        throw new Error('public key must be 96 hex characters');
    }

    const publicKey = PublicKey.fromBytes(fromHex(normalized));

    if (!publicKey.isValid() || publicKey.isInfinity()) {
        throw new Error('public key is invalid');
    }

    return publicKey;
}

export async function addressForPublicKeyHex(
    publicKeyHex: string,
    prefix: 'xch' | 'txch',
): Promise<string> {
    await ensureInit();

    const publicKey = publicKeyFromHex(publicKeyHex);
    const syntheticPk = publicKey.deriveSynthetic();
    const puzzleHash = standardPuzzleHash(syntheticPk);
    const address = new Address(puzzleHash, prefix);

    return address.encode();
}
