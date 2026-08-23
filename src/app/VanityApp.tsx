import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { runtime } from '../runtime';
import type {
    DeriveAddressPayload,
    Mode,
    SearchHitPayload,
    SearchMode,
    StartSearchRequest,
    UiState,
} from '../runtime/types';
import {
    validateWantedPatterns,
    validateWantedPrefix,
    validateWantedSuffix,
} from '../lib/vanityValidation';
import { addressForPublicKeyHex } from '../lib/publicKeyAddress';

type WorkMode = 'search' | 'derive';
type AddressPrefix = 'xch' | 'txch';
type CredentialKind = 'public' | 'private';
type CredentialSource = 'sage' | 'manual';
type ThemeMode = 'auto' | 'light' | 'dark';

const MAX_INDEX = 0xffffffff;
const WALLET_KEY_CAPABILITY = 'wallet.get_key';
const WALLET_PUBLIC_KEYS_CAPABILITY = 'wallet.get_public_keys';
const WALLET_SECRET_CAPABILITY = 'wallet.get_secret_key';
const SAGE_PUBLIC_KEY_CHUNK_LIMIT = 1000;
interface SageKeyMaterial {
    fingerprint: number;
    name: string;
    publicKey: string;
    hasSecrets: boolean;
}

export default function VanityApp() {
    const [hostInfo, setHostInfo] = useState<null | {
        permissions: { network: boolean; persistent_storage: boolean };
        storage: { bytesUsed: number; quotaBytes: number | null };
    }>(null);

    const [workMode, setWorkMode] = useState<WorkMode>('search');
    const [credentialKind, setCredentialKind] = useState<CredentialKind>('public');
    const [credentialSource, setCredentialSource] = useState<CredentialSource>('sage');
    const [mnemonic, setMnemonic] = useState('');
    const [masterSecretKey, setMasterSecretKey] = useState('');
    const [masterPublicKey, setMasterPublicKey] = useState('');
    const [wantedAddressPrefix, setWantedAddressPrefix] = useState<AddressPrefix>('xch');
    const [wantedPrefix, setWantedPrefix] = useState('ace');
    const [wantedSuffix, setWantedSuffix] = useState('');
    const [startIndex, setStartIndex] = useState(0);
    const [chunkSize, setChunkSize] = useState(10000);
    const [mode, setMode] = useState<Mode>('unhardened');
    const [workerCount, setWorkerCount] = useState(0);
    const [searchMode, setSearchMode] = useState<SearchMode>('fast');
    const [deriveIndex, setDeriveIndex] = useState(0);
    const [derivePrefix, setDerivePrefix] = useState<AddressPrefix>('xch');
    const [deriving, setDeriving] = useState(false);

    const [uiState, setUiState] = useState<UiState>('idle');
    const [checked, setChecked] = useState(0);
    const [ratePerSec, setRatePerSec] = useState(0);
    const [elapsedSecs, setElapsedSecs] = useState(0);
    const [results, setResults] = useState<Array<SearchHitPayload | DeriveAddressPayload>>([]);
    const [resultLabel, setResultLabel] = useState('No result yet');
    const [error, setError] = useState('');
    const [, setStatus] = useState('Idle');
    const [sageKey, setSageKey] = useState<SageKeyMaterial | null>(null);
    const [sagePublicKeysReady, setSagePublicKeysReady] = useState(false);
    const [sageCapabilities, setSageCapabilities] = useState<string[]>([]);
    const [loadingSageKey, setLoadingSageKey] = useState(false);
    const [loadingSageSecret, setLoadingSageSecret] = useState(false);
    const [allowUnsafeMnemonicPaste, setAllowUnsafeMnemonicPaste] = useState(false);
    const [themeMode, setThemeMode] = useState<ThemeMode>('auto');
    const sageSearchCancelRef = useRef(false);
    const searchStartedAtRef = useRef<number | null>(null);
    const manualStopRequestedRef = useRef(false);

    useLayoutEffect(() => {
        if (themeMode === 'auto') {
            document.documentElement.removeAttribute('data-theme');
        } else {
            document.documentElement.dataset.theme = themeMode;
        }

    }, [themeMode]);

    useEffect(() => {
        let cancelled = false;
        let timeoutId: number | undefined;
        let attempts = 0;

        const maybeLoadHostInfo = async () => {
            const candidate = runtime as {
                getHostCapabilities?: () => Promise<null | {
                    permissions: { network: boolean; persistent_storage: boolean };
                    storage: { bytesUsed: number; quotaBytes: number | null };
                }>;
                getSageCapabilities?: () => Promise<string[]>;
            };

            attempts += 1;
            let foundHost = false;

            if (typeof candidate.getHostCapabilities === 'function') {
                const info = await candidate.getHostCapabilities();
                if (!cancelled) {
                    setHostInfo(info);
                }
                foundHost = info !== null;
            }

            if (typeof candidate.getSageCapabilities === 'function') {
                const capabilities = await candidate.getSageCapabilities();
                if (!cancelled) {
                    setSageCapabilities(capabilities);
                }
            }

            if (!cancelled && !foundHost && attempts < 10) {
                timeoutId = window.setTimeout(() => void maybeLoadHostInfo(), 250);
            }
        };

        void maybeLoadHostInfo();

        return () => {
            cancelled = true;
            if (timeoutId !== undefined) {
                window.clearTimeout(timeoutId);
            }
        };
    }, []);

    useEffect(() => {
        const candidate = runtime as {
            onSageCapabilitiesChange?: (cb: (capabilities: string[]) => void) => Promise<() => void>;
        };
        let unsubscribe: (() => void) | undefined;

        const setup = async () => {
            if (typeof candidate.onSageCapabilitiesChange !== 'function') {
                return;
            }

            unsubscribe = await candidate.onSageCapabilitiesChange((capabilities) => {
                setSageCapabilities(capabilities);

                if (!capabilities.includes(WALLET_PUBLIC_KEYS_CAPABILITY)) {
                    setSagePublicKeysReady(false);
                    setMasterPublicKey('');
                }

                if (!capabilities.includes(WALLET_KEY_CAPABILITY)) {
                    setSageKey(null);
                }

                if (!capabilities.includes(WALLET_SECRET_CAPABILITY)) {
                    setMasterSecretKey('');
                }
            });
        };

        void setup();

        return () => unsubscribe?.();
    }, []);

    useEffect(() => {
        let unlistenProgress: (() => void) | undefined;
        let unlistenCompleted: (() => void) | undefined;
        let unlistenFailed: (() => void) | undefined;
        let unlistenState: (() => void) | undefined;

        const setup = async () => {
            unlistenProgress = await runtime.onSearchProgress((event) => {
                setChecked(event.checked);
                setRatePerSec(event.ratePerSec);
                setElapsedSecs(event.elapsedSecs);
                setStatus('Searching');
                setUiState((prev) => (prev === 'stopping' ? prev : 'running'));
            });

            unlistenCompleted = await runtime.onSearchCompleted((event) => {
                finishSearchElapsed();

                if (manualStopRequestedRef.current) {
                    manualStopRequestedRef.current = false;
                    setResults([]);
                    setResultLabel('No result yet');
                    setStatus('Stopped');
                    setUiState('idle');
                    return;
                }

                setResults(event.hit ? [event.hit] : []);
                setResultLabel(event.hit ? 'Search match' : 'No match found');
                setStatus(event.hit ? 'Match found' : 'No match found');
                setUiState('idle');
            });

            unlistenFailed = await runtime.onSearchFailed((event) => {
                finishSearchElapsed();
                manualStopRequestedRef.current = false;
                setError(event.message);
                setResultLabel('Search failed');
                setStatus('Search failed');
                setUiState('idle');
            });

            unlistenState = await runtime.onSearchState((event) => {
                if (event.running) {
                    setUiState((prev) => (prev === 'stopping' ? 'stopping' : 'running'));
                } else {
                    setUiState('idle');
                }
            });

            const state = await runtime.getSearchState();
            setUiState(state.running ? 'running' : 'idle');
        };

        void setup();

        return () => {
            unlistenProgress?.();
            unlistenCompleted?.();
            unlistenFailed?.();
            unlistenState?.();
        };
    }, []);

    useEffect(() => {
        if (mode !== 'unhardened' && credentialKind === 'public') {
            setCredentialKind('private');
        }
    }, [credentialKind, mode]);

    const unhardenedSelected = mode === 'unhardened' || mode === 'both';
    const hardenedSelected = mode === 'hardened' || mode === 'both';
    const inputsDisabled = uiState !== 'idle' || deriving;
    const isSage = hostInfo !== null;
    const activeCredentialSource: CredentialSource = isSage ? credentialSource : 'manual';
    const isSagePublicSource =
        isSage && activeCredentialSource === 'sage' && credentialKind === 'public';
    const canUsePublicCredential = mode === 'unhardened';
    const hasSageKeyPermission = sageCapabilities.includes(WALLET_PUBLIC_KEYS_CAPABILITY);
    const hasSageSecretPermission = sageCapabilities.includes(WALLET_SECRET_CAPABILITY);
    const prefixValidationError = validateWantedPrefix(wantedPrefix);
    const suffixValidationError = validateWantedSuffix(wantedSuffix);
    const patternValidationError = validateWantedPatterns(wantedPrefix, wantedSuffix);
    const publicKeyValidationError =
        credentialKind === 'public' && mode === 'unhardened' && !isSagePublicSource
            ? validateMasterPublicKey(masterPublicKey)
            : null;
    const hasMnemonic = mnemonic.trim().length > 0;
    const hasSecretKey = masterSecretKey.trim().length > 0;
    const hasValidPublicKey =
        masterPublicKey.trim().length > 0 && !publicKeyValidationError;
    const hasRequiredKeyMaterial =
        credentialKind === 'public'
            ? canUsePublicCredential && (isSagePublicSource ? sagePublicKeysReady : hasValidPublicKey)
            : hasMnemonic || hasSecretKey;
    const canStart = useMemo(() => (
        hasRequiredKeyMaterial &&
        !patternValidationError &&
        !publicKeyValidationError &&
        uiState === 'idle' &&
        !deriving
    ), [deriving, hasRequiredKeyMaterial, patternValidationError, publicKeyValidationError, uiState]);

    const canDerive = useMemo(() => (
        hasRequiredKeyMaterial &&
        !publicKeyValidationError &&
        uiState === 'idle' &&
        !deriving
    ), [deriving, hasRequiredKeyMaterial, publicKeyValidationError, uiState]);

    const canStop = uiState === 'running';
    const searchInProgress = workMode === 'search' && (uiState === 'running' || uiState === 'stopping');
    const searchFinished = workMode === 'search' && uiState === 'idle' && (
        results.length > 0 ||
        resultLabel === 'No match found' ||
        resultLabel === 'Search failed'
    );
    const derivationFinished = workMode === 'derive' && !deriving && (
        results.length > 0 ||
        resultLabel === 'Derive failed'
    );
    const showResultPanel = !searchInProgress && (searchFinished || derivationFinished);
    const resultMetaLine = workMode === 'search' && elapsedSecs > 0
        ? `${resultLabel} · elapsed ${elapsedSecs.toFixed(1)} s`
        : resultLabel;

    function finishSearchElapsed() {
        if (searchStartedAtRef.current === null) {
            return;
        }

        setElapsedSecs((performance.now() - searchStartedAtRef.current) / 1000);
        searchStartedAtRef.current = null;
    }

    async function handleStart() {
        if (patternValidationError) {
            setError(patternValidationError);
            setStatus('Invalid input');
            return;
        }

        setWorkMode('search');
        setError('');
        setResults([]);
        setResultLabel('Search running');
        setChecked(0);
        setRatePerSec(0);
        setElapsedSecs(0);
        setStatus('Starting');
        setUiState('running');
        sageSearchCancelRef.current = false;
        manualStopRequestedRef.current = false;
        searchStartedAtRef.current = performance.now();

        const req: StartSearchRequest = {
            mnemonic: credentialKind === 'private' ? mnemonic.trim() : '',
            masterSecretKey: credentialKind === 'private' ? normalizeSecretKeyInput(masterSecretKey) : '',
            masterPublicKey: credentialKind === 'public' ? normalizePublicKeyInput(masterPublicKey) : '',
            addressPrefix: wantedAddressPrefix,
            wantedPrefix: wantedPrefixForSearch(wantedPrefix, wantedAddressPrefix),
            wantedSuffix: wantedSuffix.trim(),
            startIndex: clampU32(startIndex),
            chunkSize: Math.max(1, Math.floor(chunkSize) || 10000),
            mode,
            workerCount: Math.max(0, Math.floor(workerCount) || 0),
            searchMode,
        };

        try {
            if (isSagePublicSource) {
                await runSagePublicSearch(req);
            } else {
                await runtime.startSearch(req);
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            searchStartedAtRef.current = null;
            manualStopRequestedRef.current = false;
            setError(message);
            setResultLabel('Search failed');
            setStatus('Failed to start');
            setUiState('idle');
        }
    }

    async function handleStop() {
        try {
            sageSearchCancelRef.current = true;
            manualStopRequestedRef.current = true;
            setUiState('stopping');
            setStatus('Stopping');
            await runtime.stopSearch();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            manualStopRequestedRef.current = false;
            setError(message);
            setStatus('Failed to stop');
            setUiState('running');
        }
    }

    function handleKeyModeChange(kind: 'unhardened' | 'hardened', checked: boolean) {
        let nextUnhardened = unhardenedSelected;
        let nextHardened = hardenedSelected;

        if (kind === 'unhardened') {
            nextUnhardened = checked;
        } else {
            nextHardened = checked;
        }

        if (!nextUnhardened && !nextHardened) {
            nextUnhardened = kind === 'hardened';
            nextHardened = kind === 'unhardened';
        }

        const nextMode: Mode = nextUnhardened && nextHardened
            ? 'both'
            : nextUnhardened
                ? 'unhardened'
                : 'hardened';

        setMode(nextMode);
        setCredentialKind((previous) => {
            if (nextMode === 'unhardened') {
                return 'public';
            }

            return previous === 'public' ? 'private' : previous;
        });
    }

    async function handleDerive() {
        setWorkMode('derive');
        setError('');
        setResults([]);
        setResultLabel('Deriving');
        setStatus('Deriving');
        setDeriving(true);

        try {
            const derived = isSagePublicSource
                ? await deriveSagePublicAddress(clampU32(deriveIndex), derivePrefix)
                : await runtime.deriveAddresses({
                    mnemonic: credentialKind === 'private' ? mnemonic.trim() : '',
                    masterSecretKey: credentialKind === 'private' ? normalizeSecretKeyInput(masterSecretKey) : '',
                    masterPublicKey: credentialKind === 'public' ? normalizePublicKeyInput(masterPublicKey) : '',
                    index: clampU32(deriveIndex),
                    mode,
                    addressPrefix: derivePrefix,
                });
            setResults(derived);
            setResultLabel('Derived address');
            setStatus('Derived');
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
            setResultLabel('No result yet');
            setStatus('Derive failed');
        } finally {
            setDeriving(false);
        }
    }

    async function copyAddress(address: string) {
        try {
            await navigator.clipboard.writeText(address);
            setStatus('Address copied');
        } catch {
            setError('Clipboard is not available in this host.');
            setStatus('Copy failed');
        }
    }

    async function refreshSageCapabilities() {
        const candidate = runtime as {
            getSageCapabilities?: () => Promise<string[]>;
        };

        if (typeof candidate.getSageCapabilities === 'function') {
            setSageCapabilities(await candidate.getSageCapabilities());
        }
    }

    async function getSageDerivedPublicKeys(offset: number, limit: number): Promise<string[]> {
        const candidate = runtime as {
            getSageDerivedPublicKeys?: (
                offset: number,
                limit: number,
                hardened?: boolean,
            ) => Promise<string[]>;
        };

        if (typeof candidate.getSageDerivedPublicKeys !== 'function') {
            throw new Error('Sage public-key bridge is not available.');
        }

        return await candidate.getSageDerivedPublicKeys(offset, limit, false);
    }

    async function deriveSagePublicAddress(
        index: number,
        addressPrefix: AddressPrefix,
    ): Promise<DeriveAddressPayload[]> {
        const keys = await getSageDerivedPublicKeys(index, 1);
        const publicKey = keys[0];

        if (!publicKey) {
            throw new Error(`Sage did not return a public key for derivation ${index}.`);
        }

        return [{
            index,
            mode: 'unhardened',
            address: await addressForPublicKeyHex(publicKey, addressPrefix),
        }];
    }

    async function runSagePublicSearch(req: StartSearchRequest) {
        let nextIndex = clampU32(req.startIndex);
        let checkedCount = 0;
        const started = performance.now();
        const wantedPrefixLower = req.wantedPrefix.toLowerCase();
        const wantedSuffixLower = req.wantedSuffix.toLowerCase();
        const addressPrefix = req.addressPrefix;
        const limit = Math.max(
            1,
            Math.min(SAGE_PUBLIC_KEY_CHUNK_LIMIT, Math.floor(req.chunkSize) || SAGE_PUBLIC_KEY_CHUNK_LIMIT),
        );

        while (!sageSearchCancelRef.current && nextIndex <= MAX_INDEX) {
            const keys = await getSageDerivedPublicKeys(nextIndex, limit);

            if (keys.length === 0) {
                finishSearchElapsed();
                setResults([]);
                setResultLabel('No match found');
                setStatus('No match found');
                setUiState('idle');
                return;
            }

            for (let i = 0; i < keys.length; i += 1) {
                if (sageSearchCancelRef.current) {
                    finishSearchElapsed();
                    manualStopRequestedRef.current = false;
                    setResultLabel('Search stopped');
                    setStatus('Stopped');
                    setUiState('idle');
                    return;
                }

                const index = nextIndex + i;
                const address = await addressForPublicKeyHex(keys[i], addressPrefix);
                checkedCount += 1;

                const elapsed = (performance.now() - started) / 1000;
                setChecked(checkedCount);
                setRatePerSec(elapsed > 0 ? checkedCount / elapsed : 0);
                setElapsedSecs(elapsed);
                setStatus('Searching');

                if (!matchesWantedAddress(address, wantedPrefixLower, wantedSuffixLower)) {
                    continue;
                }

                const hit = {
                    index,
                    mode: 'unhardened' as const,
                    address,
                };

                setResults([hit]);
                finishSearchElapsed();
                setResultLabel('Search match');
                setStatus('Match found');
                setUiState('idle');
                return;
            }

            nextIndex += keys.length;
        }

        finishSearchElapsed();
        manualStopRequestedRef.current = false;
        setResultLabel('Search stopped');
        setStatus('Stopped');
        setUiState('idle');
    }

    async function handleLoadSageKey() {
        setLoadingSageKey(true);
        setError('');
        setStatus('Checking Sage public keys');

        try {
            const keys = await getSageDerivedPublicKeys(0, 1);
            if (keys.length === 0) {
                setStatus('No Sage public keys');
                return;
            }

            setSagePublicKeysReady(true);
            setMasterPublicKey('');
            await refreshSageCapabilities();
            setStatus('Sage public keys ready');
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setStatus('Could not use Sage public keys');
        } finally {
            setLoadingSageKey(false);
        }
    }

    async function handleLoadSageSecret() {
        const candidate = runtime as {
            getSageSecretKey?: (fingerprint: number) => Promise<{
                mnemonic: string | null;
                secretKey: string;
            } | null>;
        };

        setLoadingSageSecret(true);
        setError('');
        setStatus('Checking Sage wallet key');

        let activeKey = sageKey;

        try {
            if (!activeKey) {
                const keyCandidate = runtime as {
                    getSageKeyMaterial?: () => Promise<SageKeyMaterial | null>;
                };

                if (typeof keyCandidate.getSageKeyMaterial !== 'function') {
                    setError('Sage bridge is not available.');
                    setStatus('Sage unavailable');
                    setLoadingSageSecret(false);
                    return;
                }

                activeKey = await keyCandidate.getSageKeyMaterial();
                if (activeKey) {
                    setSageKey(activeKey);
                    await refreshSageCapabilities();
                }
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setStatus('Sage wallet key unavailable');
            setLoadingSageSecret(false);
            return;
        }

        if (!activeKey) {
            setError('Sage did not return a wallet fingerprint for secret-key approval.');
            setStatus('Sage key needed');
            setLoadingSageSecret(false);
            return;
        }

        if (typeof candidate.getSageSecretKey !== 'function') {
            setError('Sage secret-key bridge is not available.');
            setStatus('Sage unavailable');
            setLoadingSageSecret(false);
            return;
        }

        setStatus('Requesting Sage secret');

        try {
            const secret = await candidate.getSageSecretKey(activeKey.fingerprint);
            if (!secret) {
                setStatus('Secret not granted');
                return;
            }

            if (secret.mnemonic) {
                setMnemonic(secret.mnemonic);
            }

            setMasterSecretKey(normalizeSecretKeyInput(secret.secretKey));
            await refreshSageCapabilities();
            setStatus(secret.mnemonic ? 'Sage mnemonic loaded' : 'Sage private key loaded');
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setStatus('Could not import private key');
        } finally {
            setLoadingSageSecret(false);
        }
    }

    return (
        <main style={styles.page}>
            <div style={styles.shell}>
                <header style={styles.header}>
                    <div style={styles.brandBlock}>
                        <img style={styles.brandMark} src="/icon.svg" alt="" aria-hidden="true" />
                        <div style={styles.titleRow}>
                            <h1 style={styles.title}>Vanity address</h1>
                            <span style={styles.titleDivider}>|</span>
                            <a
                                style={styles.authorMark}
                                href="https://fancybudgie.com"
                                target="_blank"
                                rel="noreferrer"
                                aria-label="by fancy budgie"
                            >
                                <span>by Fancy Budgie</span>
                                <img
                                    style={styles.authorAvatar}
                                    src="/fancy-budgie-avatar.png"
                                    alt=""
                                    aria-hidden="true"
                                />
                            </a>
                        </div>
                    </div>

                    <div style={styles.headerMeta}>
                        <ThemeControl value={themeMode} onChange={setThemeMode} />
                    </div>
                </header>

                <div style={styles.flowStack}>
                    <section style={styles.panel}>
                        <div style={styles.panelHeader}>
                            <div>
                                <h2 style={styles.sectionTitle}>Generate from</h2>
                            </div>
                        </div>

                        <div style={styles.sourceLayout}>
                            <div style={styles.choiceGrid}>
                                <button
                                    style={{
                                        ...styles.choiceButton,
                                        ...(credentialKind === 'public' ? styles.choiceButtonActive : null),
                                        ...(!canUsePublicCredential ? styles.disabledButton : null),
                                    }}
                                    onClick={() => setCredentialKind('public')}
                                    disabled={inputsDisabled || !canUsePublicCredential}
                                >
                                    <span style={styles.choiceTitle}>Public key</span>
                                    <span style={styles.choiceText}>Unhardened only</span>
                                </button>
                                <button
                                    style={{
                                        ...styles.choiceButton,
                                        ...(credentialKind === 'private' ? styles.choiceButtonActive : null),
                                    }}
                                    onClick={() => setCredentialKind('private')}
                                    disabled={inputsDisabled}
                                >
                                    <span style={styles.choiceTitle}>Mnemonic</span>
                                    <span style={styles.choiceText}>Unhardened and hardened</span>
                                </button>
                            </div>

                            <div style={styles.field}>
                                <span style={styles.labelText}>Derivation mode</span>
                                <div style={styles.checkboxRow}>
                                    <label style={styles.checkboxOption}>
                                        <input
                                            style={styles.checkboxInput}
                                            type="checkbox"
                                            checked={unhardenedSelected}
                                            onChange={(e) => handleKeyModeChange('unhardened', e.target.checked)}
                                            disabled={inputsDisabled}
                                        />
                                        <span>Unhardened</span>
                                    </label>
                                    <label style={styles.checkboxOption}>
                                        <input
                                            style={styles.checkboxInput}
                                            type="checkbox"
                                            checked={hardenedSelected}
                                            onChange={(e) => handleKeyModeChange('hardened', e.target.checked)}
                                            disabled={inputsDisabled}
                                        />
                                        <span>Hardened</span>
                                    </label>
                                </div>
                            </div>
                        </div>

                        {isSage ? (
                            <div style={styles.sourceSwitch}>
                                <button
                                    style={{
                                        ...styles.sourceButton,
                                        ...(activeCredentialSource === 'sage' ? styles.sourceButtonActive : null),
                                    }}
                                    onClick={() => setCredentialSource('sage')}
                                    disabled={inputsDisabled}
                                >
                                    Import from Sage
                                </button>
                                <button
                                    style={{
                                        ...styles.sourceButton,
                                        ...(activeCredentialSource === 'manual' ? styles.sourceButtonActive : null),
                                    }}
                                    onClick={() => setCredentialSource('manual')}
                                    disabled={inputsDisabled}
                                >
                                    Paste manually
                                </button>
                            </div>
                        ) : null}

                        {activeCredentialSource === 'sage' && credentialKind === 'public' ? (
                            <div style={styles.sageActions}>
                                <button
                                    style={{
                                        ...styles.secondaryButton,
                                        ...(loadingSageKey ? styles.disabledButton : null),
                                    }}
                                    onClick={handleLoadSageKey}
                                    disabled={inputsDisabled || loadingSageKey}
                                >
                                    {loadingSageKey
                                        ? 'Checking'
                                        : hasSageKeyPermission
                                            ? 'Use Sage public keys'
                                            : 'Grant and use Sage public keys'}
                                </button>
                                {sagePublicKeysReady ? (
                                    <div style={styles.sageKeyLabel}>
                                        Sage wallet · derived public keys
                                    </div>
                                ) : null}
                            </div>
                        ) : null}

                        {activeCredentialSource === 'sage' && credentialKind === 'private' ? (
                            <div style={styles.sageActions}>
                                <button
                                    style={{
                                        ...styles.secondaryButton,
                                        ...(loadingSageSecret ? styles.disabledButton : null),
                                    }}
                                    onClick={handleLoadSageSecret}
                                    disabled={inputsDisabled || loadingSageSecret}
                                >
                                    {loadingSageSecret
                                        ? 'Requesting'
                                        : hasSageSecretPermission
                                            ? 'Import private key'
                                            : 'Grant and import private key'}
                                </button>
                                {sageKey ? (
                                    <div style={styles.sageKeyLabel}>
                                        {sageKey.name} · {sageKey.fingerprint}
                                    </div>
                                ) : null}
                            </div>
                        ) : null}

                        {activeCredentialSource === 'manual' && credentialKind === 'public' ? (
                            <label style={styles.fieldFull}>
                                <span style={styles.labelText}>Master public key</span>
                                <input
                                    style={{
                                        ...styles.input,
                                        ...(publicKeyValidationError ? styles.invalidInput : null),
                                    }}
                                    value={masterPublicKey}
                                    onChange={(e) => setMasterPublicKey(e.target.value)}
                                    placeholder="96 hex characters"
                                    aria-invalid={Boolean(publicKeyValidationError)}
                                    disabled={inputsDisabled}
                                />
                                <FieldError message={publicKeyValidationError} />
                            </label>
                        ) : null}

                        {activeCredentialSource === 'manual' && credentialKind === 'private' && !isSage && !allowUnsafeMnemonicPaste ? (
                            <div style={styles.warningBox}>
                                <strong>Mnemonic safety</strong>
                                <span>
                                    This app does not send your mnemonic anywhere, but pasting a mnemonic into websites is still risky. Other sites may be dishonest, and browser extensions can read page contents. Installing this app into Sage is safer because Sage provides stronger sandboxing and key access through permission prompts.
                                </span>
                                <button
                                    style={styles.warningButton}
                                    onClick={() => setAllowUnsafeMnemonicPaste(true)}
                                    disabled={inputsDisabled}
                                >
                                    Allow mnemonic paste
                                </button>
                            </div>
                        ) : null}

                        {activeCredentialSource === 'manual' && credentialKind === 'private' && (isSage || allowUnsafeMnemonicPaste) ? (
                            <label style={styles.fieldFull}>
                                <span style={styles.labelText}>Mnemonic</span>
                                <textarea
                                    style={styles.textarea}
                                    rows={4}
                                    value={mnemonic}
                                    onChange={(e) => setMnemonic(e.target.value)}
                                    placeholder="word word word ..."
                                    disabled={inputsDisabled}
                                />
                            </label>
                        ) : null}
                    </section>

                    <section style={styles.panel}>
                        <div style={styles.panelHeader}>
                            <div>
                                <h2 style={styles.sectionTitle}>
                                    {workMode === 'search' ? 'Search settings' : 'Derivation settings'}
                                </h2>
                            </div>
                            <SegmentedControl
                                value={workMode}
                                onChange={setWorkMode}
                                disabled={inputsDisabled}
                            />
                        </div>

                        {workMode === 'search' ? (
                            <div style={styles.formStack}>
                                <div style={styles.targetGrid}>
                                    <label style={styles.targetField} htmlFor="wanted-prefix">
                                        <span style={styles.labelText}>Prefix</span>
                                        <div
                                            style={{
                                                ...styles.prefixedInputWrap,
                                                ...(prefixValidationError ? styles.invalidInput : null),
                                            }}
                                        >
                                            <select
                                                style={styles.prefixSelect}
                                                value={wantedAddressPrefix}
                                                onChange={(e) => setWantedAddressPrefix(e.target.value as AddressPrefix)}
                                                aria-label="Address prefix"
                                                disabled={inputsDisabled}
                                            >
                                                <option value="xch">xch1</option>
                                                <option value="txch">txch1</option>
                                            </select>
                                            <input
                                                id="wanted-prefix"
                                                style={styles.prefixedInput}
                                                value={wantedPrefix}
                                                onChange={(e) => {
                                                    const pastedAddressPrefix = addressPrefixFromWantedInput(e.target.value);
                                                    if (pastedAddressPrefix) {
                                                        setWantedAddressPrefix(pastedAddressPrefix);
                                                    }

                                                    setWantedPrefix(stripWantedPrefixInput(e.target.value));
                                                }}
                                                placeholder="ace"
                                                aria-invalid={Boolean(prefixValidationError)}
                                                disabled={inputsDisabled}
                                            />
                                        </div>
                                        <FieldError message={prefixValidationError} />
                                    </label>

                                    <label style={styles.targetField}>
                                        <span style={styles.labelText}>Suffix</span>
                                        <input
                                            style={{
                                                ...styles.targetInput,
                                                ...(suffixValidationError ? styles.invalidInput : null),
                                            }}
                                            value={wantedSuffix}
                                            onChange={(e) => setWantedSuffix(e.target.value)}
                                            placeholder="ace"
                                            aria-invalid={Boolean(suffixValidationError)}
                                            disabled={inputsDisabled}
                                        />
                                        <FieldError message={suffixValidationError} />
                                    </label>
                                </div>

                                <details style={styles.advancedDetails}>
                                    <summary style={styles.advancedSummary}>Advanced</summary>
                                    <div style={styles.advancedGrid}>
                                        <label style={styles.field}>
                                            <span style={styles.labelText}>Search strategy</span>
                                            <select
                                                style={styles.input}
                                                value={searchMode}
                                                onChange={(e) => setSearchMode(e.target.value as SearchMode)}
                                                disabled={inputsDisabled}
                                            >
                                                <option value="fast">fast</option>
                                                <option value="lowest">lowest derivation</option>
                                            </select>
                                        </label>

                                        <NumberField
                                            label="Start derivation"
                                            value={startIndex}
                                            onChange={setStartIndex}
                                            disabled={inputsDisabled}
                                        />

                                        <NumberField
                                            label="Workers"
                                            value={workerCount}
                                            onChange={setWorkerCount}
                                            disabled={inputsDisabled}
                                        />

                                        <NumberField
                                            label="Chunk size"
                                            value={chunkSize}
                                            onChange={setChunkSize}
                                            disabled={inputsDisabled || searchMode !== 'lowest'}
                                        />
                                    </div>
                                </details>

                                {patternValidationError ? (
                                    <div style={styles.formError}>{patternValidationError}</div>
                                ) : null}
                                <div style={styles.actions}>
                                    <button
                                        style={{
                                            ...styles.primaryButton,
                                            ...(!canStart ? styles.disabledButton : null),
                                        }}
                                        onClick={handleStart}
                                        disabled={!canStart}
                                    >
                                        Start
                                    </button>
                                    <button
                                        style={{
                                            ...styles.secondaryButton,
                                            ...(!canStop ? styles.disabledButton : null),
                                        }}
                                        onClick={handleStop}
                                        disabled={!canStop}
                                    >
                                        Stop
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div style={styles.formStack}>
                                <div style={styles.formGrid}>
                                    <NumberField
                                        label="Derivation"
                                        value={deriveIndex}
                                        onChange={setDeriveIndex}
                                        disabled={inputsDisabled}
                                    />

                                    <label style={styles.field}>
                                        <span style={styles.labelText}>Address prefix</span>
                                        <select
                                            style={styles.input}
                                            value={derivePrefix}
                                            onChange={(e) => setDerivePrefix(e.target.value as AddressPrefix)}
                                            disabled={inputsDisabled}
                                        >
                                            <option value="xch">xch</option>
                                            <option value="txch">txch</option>
                                        </select>
                                    </label>

                                </div>

                                <div style={styles.actions}>
                                    <button
                                        style={{
                                            ...styles.primaryButton,
                                            ...(!canDerive ? styles.disabledButton : null),
                                        }}
                                        onClick={handleDerive}
                                        disabled={!canDerive}
                                    >
                                        Derive
                                    </button>
                                </div>
                            </div>
                        )}
                    </section>

                    {searchInProgress ? (
                        <section style={styles.panel}>
                            <div style={styles.panelHeader}>
                                <h2 style={styles.sectionTitle}>Progress</h2>
                            </div>

                            <div style={styles.metricGrid}>
                                <Metric label="Checked" value={checked.toLocaleString()} />
                                <Metric label="Rate" value={`${formatNumber(ratePerSec)}/s`} />
                                <Metric label="Elapsed" value={`${elapsedSecs.toFixed(1)} s`} />
                            </div>
                        </section>
                    ) : null}

                    {showResultPanel ? (
                        <aside style={styles.panel}>
                            <div style={styles.panelHeader}>
                                <div>
                                    <h2 style={styles.sectionTitle}>Result</h2>
                                    <div style={styles.subtleLine}>{resultMetaLine}</div>
                                </div>
                            </div>

                            {results.length > 0 ? (
                                <div style={styles.resultList}>
                                    {results.map((item) => (
                                        <ResultRow
                                            key={`${item.mode}-${item.index}-${item.address}`}
                                            item={item}
                                            onCopy={copyAddress}
                                        />
                                    ))}
                                </div>
                            ) : !error ? (
                                <div style={styles.emptyState}>{resultLabel}</div>
                            ) : null}

                            {error ? (
                                <div style={styles.errorBox}>
                                    <strong>Error</strong>
                                    <span>{error}</span>
                                </div>
                            ) : null}
                        </aside>
                    ) : null}
                </div>
            </div>
        </main>
    );
}

function ThemeControl({
    value,
    onChange,
}: {
    value: ThemeMode;
    onChange: (value: ThemeMode) => void;
}) {
    const options: Array<{ value: ThemeMode; label: string }> = [
        { value: 'auto', label: 'Auto theme' },
        { value: 'light', label: 'Light theme' },
        { value: 'dark', label: 'Dark theme' },
    ];

    return (
        <div style={styles.themeControl} aria-label="Theme">
            {options.map((item) => (
                <button
                    key={item.value}
                    style={{
                        ...styles.themeButton,
                        ...(value === item.value ? styles.themeButtonActive : null),
                    }}
                    onClick={() => onChange(item.value)}
                    aria-label={item.label}
                    title={item.label}
                    aria-pressed={value === item.value}
                    type="button"
                >
                    {item.value === 'auto' ? 'Auto' : <ThemeIcon value={item.value} />}
                </button>
            ))}
        </div>
    );
}

function ThemeIcon({ value }: { value: ThemeMode }) {
    const common = {
        width: 16,
        height: 16,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round' as const,
        strokeLinejoin: 'round' as const,
        'aria-hidden': true,
        focusable: false,
    };

    if (value === 'light') {
        return (
            <svg {...common}>
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2" />
                <path d="M12 20v2" />
                <path d="m4.93 4.93 1.41 1.41" />
                <path d="m17.66 17.66 1.41 1.41" />
                <path d="M2 12h2" />
                <path d="M20 12h2" />
                <path d="m6.34 17.66-1.41 1.41" />
                <path d="m19.07 4.93-1.41 1.41" />
            </svg>
        );
    }

    if (value === 'dark') {
        return (
            <svg {...common}>
                <path d="M20.3 14.7A8 8 0 0 1 9.3 3.7a7 7 0 1 0 11 11Z" />
            </svg>
        );
    }

    return null;
}

function SegmentedControl({
    value,
    onChange,
    disabled,
}: {
    value: WorkMode;
    onChange: (value: WorkMode) => void;
    disabled: boolean;
}) {
    return (
        <div style={styles.segmented}>
            {(['search', 'derive'] as WorkMode[]).map((item) => (
                <button
                    key={item}
                    style={{
                        ...styles.segmentButton,
                        ...(value === item ? styles.segmentButtonActive : null),
                    }}
                    onClick={() => onChange(item)}
                    disabled={disabled}
                >
                    {item === 'search' ? 'Search' : 'Derivation'}
                </button>
            ))}
        </div>
    );
}

function NumberField({
    label,
    value,
    onChange,
    disabled,
}: {
    label: string;
    value: number;
    onChange: (value: number) => void;
    disabled: boolean;
}) {
    return (
        <label style={styles.field}>
            <span style={styles.labelText}>{label}</span>
            <input
                style={styles.input}
                type="number"
                min={0}
                max={MAX_INDEX}
                step={1}
                value={value}
                onChange={(e) => onChange(clampU32(Number(e.target.value)))}
                disabled={disabled}
            />
        </label>
    );
}

function FieldError({ message }: { message: string | null }) {
    if (!message) {
        return null;
    }

    return <span style={styles.fieldError}>{message}</span>;
}

function Metric({ label, value }: { label: string; value: string }) {
    return (
        <div style={styles.metric}>
            <span style={styles.metricLabel}>{label}</span>
            <span style={styles.metricValue}>{value}</span>
        </div>
    );
}

function ResultRow({
    item,
    onCopy,
}: {
    item: SearchHitPayload | DeriveAddressPayload;
    onCopy: (address: string) => void;
}) {
    return (
        <div style={styles.resultItem}>
            <div style={styles.resultMeta}>
                <span>Derivation {item.index}</span>
                <span>{item.mode}</span>
            </div>
            <div style={styles.addressLine}>{item.address}</div>
            <button style={styles.copyButton} onClick={() => void onCopy(item.address)}>
                Copy
            </button>
        </div>
    );
}

function clampU32(value: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }

    return Math.max(0, Math.min(MAX_INDEX, Math.floor(value)));
}

function normalizePublicKeyInput(value: string): string {
    return value.trim().toLowerCase().replace(/^0x/, '');
}

function normalizeSecretKeyInput(value: string): string {
    return value.trim().toLowerCase().replace(/^0x/, '');
}

function matchesWantedAddress(
    address: string,
    wantedPrefixLower: string,
    wantedSuffixLower: string,
): boolean {
    const addressLower = address.toLowerCase();

    if (wantedPrefixLower.length > 0 && !addressLower.startsWith(wantedPrefixLower)) {
        return false;
    }

    if (wantedSuffixLower.length > 0 && !addressLower.endsWith(wantedSuffixLower)) {
        return false;
    }

    return true;
}

function wantedPrefixForSearch(value: string, addressPrefix: AddressPrefix): string {
    const trimmed = value.trim().toLowerCase();

    if (trimmed.length === 0) {
        return '';
    }

    return `${addressPrefix}1${trimmed}`;
}

function addressPrefixFromWantedInput(value: string): AddressPrefix | null {
    const trimmed = value.trim().toLowerCase();

    if (trimmed.startsWith('txch1')) {
        return 'txch';
    }

    if (trimmed.startsWith('xch1')) {
        return 'xch';
    }

    return null;
}

function stripWantedPrefixInput(value: string): string {
    const trimmed = value.trim().toLowerCase();

    if (trimmed.startsWith('txch1')) {
        return trimmed.slice('txch1'.length);
    }

    if (trimmed.startsWith('xch1')) {
        return trimmed.slice('xch1'.length);
    }

    return value;
}

function validateMasterPublicKey(value: string): string | null {
    const normalized = normalizePublicKeyInput(value);

    if (normalized.length === 0) {
        return null;
    }

    if (!/^[0-9a-f]{96}$/.test(normalized)) {
        return 'Master public key must be 96 hex characters.';
    }

    return null;
}

function formatNumber(value: number): string {
    if (value >= 1000000) {
        return `${(value / 1000000).toFixed(1)}m`;
    }

    if (value >= 1000) {
        return `${(value / 1000).toFixed(1)}k`;
    }

    return value.toFixed(0);
}

const monoStack =
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace';

const styles: Record<string, React.CSSProperties> = {
    page: {
        minHeight: '100vh',
        margin: 0,
        background: 'var(--page-bg)',
        color: 'var(--text)',
        fontFamily:
            'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
    },
    shell: {
        width: 'min(1180px, calc(100vw - 32px))',
        margin: '0 auto',
        padding: '24px 0',
    },
    header: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        marginBottom: 16,
        flexWrap: 'wrap',
    },
    brandBlock: {
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        minWidth: 0,
    },
    brandMark: {
        width: 40,
        height: 40,
        borderRadius: 8,
        display: 'block',
        objectFit: 'cover',
        boxShadow: '0 0 0 1px var(--panel-border)',
    },
    title: {
        margin: 0,
        fontSize: 25,
        lineHeight: 1,
        fontWeight: 760,
        letterSpacing: 0,
    },
    titleRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        minWidth: 0,
        flexWrap: 'wrap',
    },
    titleDivider: {
        color: 'var(--text-faint)',
        fontSize: 18,
        fontWeight: 700,
        lineHeight: 1,
    },
    headerMeta: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
        justifyContent: 'flex-end',
    },
    authorMark: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        minHeight: 28,
        color: 'var(--text-soft)',
        fontSize: 13,
        fontWeight: 700,
        whiteSpace: 'nowrap',
        textDecoration: 'none',
    },
    authorAvatar: {
        width: 24,
        height: 24,
        borderRadius: 6,
        display: 'block',
        objectFit: 'cover',
        imageRendering: 'pixelated',
        boxShadow: '0 0 0 1px var(--control-border)',
    },
    subtleLine: {
        marginTop: 5,
        color: 'var(--text-muted)',
        fontSize: 12,
        lineHeight: 1.35,
    },
    themeControl: {
        display: 'inline-grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        padding: 3,
        borderRadius: 8,
        background: 'var(--control-bg-muted)',
        border: '1px solid var(--divider)',
    },
    themeButton: {
        display: 'grid',
        placeItems: 'center',
        height: 30,
        minWidth: 42,
        padding: '0 8px',
        border: 0,
        borderRadius: 6,
        background: 'transparent',
        color: 'var(--text-muted)',
        fontSize: 12,
        fontWeight: 750,
        cursor: 'pointer',
    },
    themeButtonActive: {
        background: 'var(--control-text)',
        color: 'var(--panel-bg)',
    },
    flowStack: {
        display: 'grid',
        gap: 16,
    },
    metricGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap: 1,
        overflow: 'hidden',
        borderRadius: 8,
        border: '1px solid var(--divider)',
        background: 'var(--metric-grid-bg)',
    },
    metric: {
        display: 'grid',
        gap: 5,
        padding: '13px 14px',
        background: 'var(--metric-bg)',
        minWidth: 0,
    },
    metricLabel: {
        color: 'var(--text-faint)',
        fontSize: 11,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: 0,
    },
    metricValue: {
        color: 'var(--text-strong)',
        fontSize: 18,
        fontWeight: 760,
        lineHeight: 1.2,
        overflowWrap: 'anywhere',
        textTransform: 'capitalize',
    },
    panel: {
        padding: 18,
        borderRadius: 8,
        background: 'var(--panel-bg)',
        border: '1px solid var(--panel-border)',
        boxShadow: 'var(--panel-shadow)',
        minWidth: 0,
    },
    panelHeader: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        marginBottom: 16,
        flexWrap: 'wrap',
    },
    sectionTitle: {
        margin: 0,
        color: 'var(--text-strong)',
        fontSize: 15,
        fontWeight: 760,
        letterSpacing: 0,
    },
    segmented: {
        display: 'inline-grid',
        gridTemplateColumns: '1fr 1fr',
        padding: 3,
        borderRadius: 8,
        background: 'var(--control-bg-muted)',
        border: '1px solid var(--divider)',
    },
    segmentButton: {
        height: 30,
        minWidth: 72,
        padding: '0 10px',
        border: 0,
        borderRadius: 6,
        background: 'transparent',
        color: 'var(--text-muted)',
        fontSize: 12,
        fontWeight: 750,
        cursor: 'pointer',
    },
    segmentButtonActive: {
        background: 'var(--control-text)',
        color: 'var(--panel-bg)',
    },
    fieldFull: {
        display: 'grid',
        gap: 7,
        minWidth: 0,
        marginTop: 12,
    },
    sourceLayout: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))',
        gap: 12,
        alignItems: 'end',
        marginBottom: 12,
    },
    choiceGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
        gap: 10,
    },
    choiceButton: {
        display: 'grid',
        gap: 5,
        minHeight: 66,
        padding: 12,
        borderRadius: 8,
        border: '1px solid var(--panel-border)',
        background: 'var(--panel-bg)',
        color: 'var(--text)',
        textAlign: 'left',
        cursor: 'pointer',
    },
    choiceButtonActive: {
        borderColor: 'var(--primary-border)',
        background: 'var(--primary-soft)',
    },
    choiceTitle: {
        fontSize: 13,
        fontWeight: 850,
    },
    choiceText: {
        color: 'var(--text-muted)',
        fontSize: 12,
        lineHeight: 1.35,
    },
    checkboxRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        minHeight: 40,
    },
    checkboxOption: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        minHeight: 34,
        padding: '0 11px',
        borderRadius: 8,
        border: '1px solid var(--control-border)',
        background: 'var(--control-bg-muted)',
        color: 'var(--text)',
        fontSize: 13,
        fontWeight: 760,
        cursor: 'pointer',
        userSelect: 'none',
    },
    checkboxInput: {
        width: 14,
        height: 14,
        margin: 0,
        accentColor: 'var(--accent)',
        cursor: 'pointer',
    },
    sourceSwitch: {
        display: 'inline-grid',
        gridTemplateColumns: '1fr 1fr',
        justifySelf: 'start',
        padding: 3,
        borderRadius: 8,
        background: 'var(--control-bg-muted)',
        border: '1px solid var(--divider)',
        marginBottom: 12,
    },
    sourceButton: {
        height: 32,
        padding: '0 11px',
        border: 0,
        borderRadius: 6,
        background: 'transparent',
        color: 'var(--text-muted)',
        fontSize: 12,
        fontWeight: 800,
        cursor: 'pointer',
    },
    sourceButtonActive: {
        background: 'var(--control-text)',
        color: 'var(--panel-bg)',
    },
    formStack: {
        display: 'grid',
        gap: 14,
    },
    formGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 210px), 1fr))',
        gap: 12,
    },
    targetGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))',
        gap: 14,
    },
    targetField: {
        display: 'grid',
        gap: 8,
        minWidth: 0,
    },
    targetInput: {
        width: '100%',
        height: 48,
        borderRadius: 8,
        border: '1px solid var(--control-border)',
        background: 'var(--control-bg)',
        color: 'var(--control-text)',
        padding: '0 14px',
        boxSizing: 'border-box',
        outline: 'none',
        fontSize: 15,
        fontWeight: 650,
    },
    prefixedInputWrap: {
        display: 'flex',
        alignItems: 'center',
        width: '100%',
        height: 48,
        borderRadius: 8,
        border: '1px solid var(--control-border)',
        background: 'var(--control-bg)',
        boxSizing: 'border-box',
        overflow: 'hidden',
    },
    prefixSelect: {
        display: 'inline-flex',
        alignItems: 'center',
        alignSelf: 'stretch',
        padding: '0 12px 0 14px',
        border: 0,
        borderRight: '1px solid var(--divider)',
        color: 'var(--text-muted)',
        background: 'var(--control-bg-muted)',
        fontSize: 15,
        fontWeight: 800,
        fontFamily: monoStack,
        whiteSpace: 'nowrap',
        outline: 'none',
        cursor: 'pointer',
    },
    prefixedInput: {
        flex: 1,
        minWidth: 0,
        height: '100%',
        border: 0,
        background: 'transparent',
        color: 'var(--control-text)',
        padding: '0 14px',
        boxSizing: 'border-box',
        outline: 'none',
        fontSize: 15,
        fontWeight: 650,
    },
    advancedDetails: {
        borderTop: '1px solid var(--divider)',
        paddingTop: 12,
    },
    advancedSummary: {
        color: 'var(--text-soft)',
        fontSize: 13,
        fontWeight: 800,
        cursor: 'pointer',
        userSelect: 'none',
    },
    advancedGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 210px), 1fr))',
        gap: 12,
        marginTop: 12,
    },
    field: {
        display: 'grid',
        gap: 7,
        alignContent: 'start',
        minWidth: 0,
    },
    labelText: {
        color: 'var(--text-muted)',
        fontSize: 12,
        fontWeight: 700,
    },
    textarea: {
        width: '100%',
        minHeight: 112,
        borderRadius: 8,
        border: '1px solid var(--control-border)',
        background: 'var(--control-bg)',
        color: 'var(--control-text)',
        padding: '12px 13px',
        resize: 'vertical',
        boxSizing: 'border-box',
        outline: 'none',
        fontSize: 13,
        lineHeight: 1.5,
    },
    input: {
        width: '100%',
        height: 40,
        borderRadius: 8,
        border: '1px solid var(--control-border)',
        background: 'var(--control-bg)',
        color: 'var(--control-text)',
        padding: '0 12px',
        boxSizing: 'border-box',
        outline: 'none',
        fontSize: 13,
    },
    invalidInput: {
        borderColor: 'var(--danger-text)',
        boxShadow: '0 0 0 2px var(--danger-soft)',
    },
    fieldError: {
        color: 'var(--danger-text)',
        fontSize: 12,
        lineHeight: 1.35,
    },
    formError: {
        color: 'var(--danger-text)',
        fontSize: 13,
        lineHeight: 1.45,
    },
    actions: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
    },
    sageActions: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
        marginTop: 12,
        padding: 10,
        borderRadius: 8,
        border: '1px solid var(--accent-border)',
        background: 'var(--accent-soft)',
    },
    sageKeyLabel: {
        color: 'var(--accent-text)',
        fontSize: 12,
        fontWeight: 750,
        overflowWrap: 'anywhere',
    },
    warningBox: {
        display: 'grid',
        gap: 9,
        padding: 12,
        borderRadius: 8,
        border: '1px solid var(--warning-border)',
        background: 'var(--warning-bg)',
        color: 'var(--warning-text)',
        fontSize: 13,
        lineHeight: 1.45,
    },
    warningButton: {
        justifySelf: 'start',
        height: 34,
        borderRadius: 8,
        border: '1px solid var(--warning-border)',
        background: 'var(--warning-button-bg)',
        color: 'var(--warning-text)',
        padding: '0 12px',
        fontSize: 12,
        fontWeight: 850,
        cursor: 'pointer',
    },
    primaryButton: {
        height: 40,
        minWidth: 112,
        borderRadius: 8,
        border: '1px solid var(--primary-border)',
        background: 'var(--primary-bg)',
        color: 'var(--primary-text)',
        padding: '0 16px',
        fontSize: 13,
        fontWeight: 800,
        cursor: 'pointer',
    },
    secondaryButton: {
        height: 40,
        minWidth: 86,
        borderRadius: 8,
        border: '1px solid var(--control-border)',
        background: 'var(--control-bg-muted)',
        color: 'var(--text)',
        padding: '0 15px',
        fontSize: 13,
        fontWeight: 760,
        cursor: 'pointer',
    },
    disabledButton: {
        opacity: 0.48,
        cursor: 'not-allowed',
    },
    resultList: {
        display: 'grid',
        gap: 14,
    },
    resultItem: {
        display: 'grid',
        gap: 10,
        paddingBottom: 14,
        borderBottom: '1px solid var(--divider)',
    },
    resultMeta: {
        display: 'flex',
        justifyContent: 'space-between',
        gap: 10,
        color: 'var(--text-muted)',
        fontSize: 12,
        fontWeight: 750,
        textTransform: 'capitalize',
    },
    addressLine: {
        fontFamily: monoStack,
        fontSize: 13,
        lineHeight: 1.55,
        color: 'var(--text-strong)',
        overflowWrap: 'anywhere',
    },
    copyButton: {
        justifySelf: 'start',
        height: 32,
        borderRadius: 8,
        border: '1px solid var(--accent-border)',
        background: 'var(--accent-soft)',
        color: 'var(--accent-text)',
        padding: '0 12px',
        fontSize: 12,
        fontWeight: 800,
        cursor: 'pointer',
    },
    emptyState: {
        minHeight: 158,
        display: 'grid',
        placeItems: 'center',
        borderRadius: 8,
        border: '1px dashed var(--control-border)',
        color: 'var(--text-faint)',
        fontSize: 13,
    },
    errorBox: {
        display: 'grid',
        gap: 6,
        marginTop: 16,
        paddingTop: 14,
        borderTop: '1px solid var(--danger-border)',
        color: 'var(--danger-text)',
        fontSize: 13,
        lineHeight: 1.45,
    },
};
