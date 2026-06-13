export const BECH32_DATA_CHARS = '023456789acdefghjklmnpqrstuvwxyz';

const BECH32_DATA_CHAR_SET = new Set(BECH32_DATA_CHARS);
const CHIA_PREFIXES = ['xch1', 'txch1'];

function isAllowedBech32Data(value: string): boolean {
    return Array.from(value).every((char) => BECH32_DATA_CHAR_SET.has(char));
}

function prefixDataPart(value: string): string | null {
    const lower = value.toLowerCase();
    const matchedPrefix = CHIA_PREFIXES.find((prefix) => lower.startsWith(prefix));

    if (matchedPrefix) {
        return lower.slice(matchedPrefix.length);
    }

    if (CHIA_PREFIXES.some((prefix) => prefix.startsWith(lower))) {
        return '';
    }

    if (lower.includes('1')) {
        return null;
    }

    return lower;
}

export function validateWantedPrefix(value: string): string | null {
    const trimmed = value.trim();

    if (trimmed.length === 0) {
        return null;
    }

    const dataPart = prefixDataPart(trimmed);

    if (dataPart === null) {
        return 'Prefix can only use the xch1 or txch1 separator.';
    }

    if (!isAllowedBech32Data(dataPart)) {
        return `Prefix can only contain Bech32 characters: ${BECH32_DATA_CHARS}`;
    }

    return null;
}

export function validateWantedSuffix(value: string): string | null {
    const trimmed = value.trim().toLowerCase();

    if (trimmed.length === 0) {
        return null;
    }

    if (!isAllowedBech32Data(trimmed)) {
        return `Suffix can only contain Bech32 characters: ${BECH32_DATA_CHARS}`;
    }

    return null;
}

export function validateWantedPatterns(
    wantedPrefix: string,
    wantedSuffix: string,
): string | null {
    const prefixError = validateWantedPrefix(wantedPrefix);

    if (prefixError) {
        return prefixError;
    }

    const suffixError = validateWantedSuffix(wantedSuffix);

    if (suffixError) {
        return suffixError;
    }

    if (wantedPrefix.trim().length === 0 && wantedSuffix.trim().length === 0) {
        return 'Prefix or suffix is required.';
    }

    return null;
}
