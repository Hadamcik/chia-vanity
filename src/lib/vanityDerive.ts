import {
    Address,
    Mnemonic,
    SecretKey,
    standardPuzzleHash,
} from "chia-wallet-sdk-wasm";

export type DeriveMode = 'hardened' | 'unhardened' | 'both';

const CHIA_PURPOSE = 12381;
const CHIA_COIN_TYPE = 8444;
const CHIA_ACCOUNT = 2;

function deriveWalletRoot(masterSk: SecretKey): SecretKey {
    return masterSk.deriveHardenedPath([
        CHIA_PURPOSE,
        CHIA_COIN_TYPE,
        CHIA_ACCOUNT,
    ]);
}

function deriveWalletChild(
    walletRoot: SecretKey,
    index: number,
    mode: 'hardened' | 'unhardened',
): SecretKey {
    return mode === 'hardened'
        ? walletRoot.deriveHardened(index)
        : walletRoot.deriveUnhardened(index);
}

function standardAddressForChildSk(childSk: SecretKey, prefix: string): string {
    const syntheticPk = childSk.publicKey().deriveSynthetic();
    const puzzleHash = standardPuzzleHash(syntheticPk);
    const address = new Address(puzzleHash, prefix);
    return address.encode();
}

export function deriveCandidatesForIndex(
    mnemonicPhrase: string,
    index: number,
    mode: DeriveMode,
    prefix: string,
): Array<{ index: number; mode: 'hardened' | 'unhardened'; address: string }> {
    const mnemonic = new Mnemonic(mnemonicPhrase);
    const seed = mnemonic.toSeed('');
    const masterSk = SecretKey.fromSeed(seed);
    const walletRoot = deriveWalletRoot(masterSk);

    const out: Array<{
        index: number;
        mode: 'hardened' | 'unhardened';
        address: string;
    }> = [];

    if (mode === 'unhardened' || mode === 'both') {
        const child = deriveWalletChild(walletRoot, index, 'unhardened');
        out.push({
            index,
            mode: 'unhardened',
            address: standardAddressForChildSk(child, prefix),
        });
    }

    if (mode === 'hardened' || mode === 'both') {
        const child = deriveWalletChild(walletRoot, index, 'hardened');
        out.push({
            index,
            mode: 'hardened',
            address: standardAddressForChildSk(child, prefix),
        });
    }

    return out;
}
