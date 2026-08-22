export type Mode = 'hardened' | 'unhardened' | 'both';
export type SearchMode = 'fast' | 'lowest';
export type UiState = 'idle' | 'running' | 'stopping';

export interface SearchProgressPayload {
    checked: number;
    ratePerSec: number;
    elapsedSecs: number;
}

export interface SearchHitPayload {
    index: number;
    mode: string;
    address: string;
}

export interface DeriveAddressRequest {
    mnemonic: string;
    masterSecretKey: string;
    masterPublicKey: string;
    index: number;
    mode: Mode;
    addressPrefix: 'xch' | 'txch';
}

export interface DeriveAddressPayload {
    index: number;
    mode: 'hardened' | 'unhardened';
    address: string;
}

export interface SearchCompletedPayload {
    hit: SearchHitPayload | null;
}

export interface SearchFailedPayload {
    message: string;
}

export interface SearchStatePayload {
    running: boolean;
}

export interface StartSearchRequest {
    mnemonic: string;
    masterSecretKey: string;
    masterPublicKey: string;
    wantedPrefix: string;
    wantedSuffix: string;
    startIndex: number;
    chunkSize: number;
    mode: Mode;
    workerCount: number;
    searchMode: SearchMode;
}

export interface VanityRuntime {
    startSearch(req: StartSearchRequest): Promise<void>;
    stopSearch(): Promise<void>;
    deriveAddresses(req: DeriveAddressRequest): Promise<DeriveAddressPayload[]>;
    getSearchState(): Promise<SearchStatePayload>;
    onSearchProgress(cb: (payload: SearchProgressPayload) => void): Promise<() => void>;
    onSearchCompleted(cb: (payload: SearchCompletedPayload) => void): Promise<() => void>;
    onSearchFailed(cb: (payload: SearchFailedPayload) => void): Promise<() => void>;
    onSearchState(cb: (payload: SearchStatePayload) => void): Promise<() => void>;
}
