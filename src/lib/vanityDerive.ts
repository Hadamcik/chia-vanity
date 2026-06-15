import {
    Address,
    Mnemonic,
    PublicKey,
    SecretKey,
    standardPuzzleHash,
} from "chia-wallet-sdk-wasm";

export type DeriveMode = 'hardened' | 'unhardened' | 'both';

const CHIA_PURPOSE = 12381;
const CHIA_COIN_TYPE = 8444;
const CHIA_ACCOUNT = 2;

function standardAddressForPk(publicKey: PublicKey, prefix: string): string {
    const syntheticPk = publicKey.deriveSynthetic();
    const puzzleHash = standardPuzzleHash(syntheticPk);
    const address = new Address(puzzleHash, prefix);
    return address.encode();
}

function standardAddressForSk(secretKey: SecretKey, prefix: string): string {
    return standardAddressForPk(secretKey.publicKey(), prefix);
}

function deriveUnhardenedPkForIndex(masterSk: SecretKey, index: number): PublicKey {
    return masterSk.publicKey().deriveUnhardenedPath([
        CHIA_PURPOSE,
        CHIA_COIN_TYPE,
        CHIA_ACCOUNT,
        index,
    ]);
}

function deriveHardenedSkForIndex(
    masterSk: SecretKey,
    index: number,
): SecretKey {
    return masterSk.deriveHardenedPath([
        CHIA_PURPOSE,
        CHIA_COIN_TYPE,
        CHIA_ACCOUNT,
        index,
    ]);
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

    const out: Array<{
        index: number;
        mode: 'hardened' | 'unhardened';
        address: string;
    }> = [];

    if (mode === 'unhardened' || mode === 'both') {
        const publicKey = deriveUnhardenedPkForIndex(masterSk, index);
        out.push({
            index,
            mode: 'unhardened',
            address: standardAddressForPk(publicKey, prefix),
        });
    }

    if (mode === 'hardened' || mode === 'both') {
        const secretKey = deriveHardenedSkForIndex(masterSk, index);
        out.push({
            index,
            mode: 'hardened',
            address: standardAddressForSk(secretKey, prefix),
        });
    }

    return out;
}
