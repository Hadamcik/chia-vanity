import React, { useEffect, useMemo, useState } from 'react';
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

type WorkMode = 'search' | 'derive';
type AddressPrefix = 'xch' | 'txch';
type CredentialKind = 'public' | 'private';
type CredentialSource = 'sage' | 'manual';

const MAX_INDEX = 0xffffffff;
const WALLET_KEY_CAPABILITY = 'wallet.get_key';
const WALLET_SECRET_CAPABILITY = 'wallet.get_secret_key';

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
    const [wantedPrefix, setWantedPrefix] = useState('xch1ace');
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
    const [status, setStatus] = useState('Idle');
    const [sageKey, setSageKey] = useState<SageKeyMaterial | null>(null);
    const [sageCapabilities, setSageCapabilities] = useState<string[]>([]);
    const [loadingSageKey, setLoadingSageKey] = useState(false);
    const [loadingSageSecret, setLoadingSageSecret] = useState(false);
    const [allowUnsafeMnemonicPaste, setAllowUnsafeMnemonicPaste] = useState(false);

    useEffect(() => {
        const maybeLoadHostInfo = async () => {
            const candidate = runtime as {
                getHostCapabilities?: () => Promise<null | {
                    permissions: { network: boolean; persistent_storage: boolean };
                    storage: { bytesUsed: number; quotaBytes: number | null };
                }>;
                getSageCapabilities?: () => Promise<string[]>;
            };

            if (typeof candidate.getHostCapabilities === 'function') {
                const info = await candidate.getHostCapabilities();
                setHostInfo(info);
            }

            if (typeof candidate.getSageCapabilities === 'function') {
                const capabilities = await candidate.getSageCapabilities();
                setSageCapabilities(capabilities);
            }
        };

        void maybeLoadHostInfo();
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

                if (!capabilities.includes(WALLET_KEY_CAPABILITY)) {
                    setSageKey((prev) => {
                        if (prev) {
                            setMasterPublicKey('');
                        }

                        return null;
                    });
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
                setResults(event.hit ? [event.hit] : []);
                setResultLabel(event.hit ? 'Search match' : 'No match found');
                setStatus(event.hit ? 'Match found' : 'No match found');
                setUiState('idle');
            });

            unlistenFailed = await runtime.onSearchFailed((event) => {
                setError(event.message);
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

    const inputsDisabled = uiState !== 'idle' || deriving;
    const isSage = hostInfo !== null;
    const activeCredentialSource: CredentialSource = isSage ? credentialSource : 'manual';
    const canUsePublicCredential = mode === 'unhardened';
    const hasSageKeyPermission = sageCapabilities.includes(WALLET_KEY_CAPABILITY);
    const hasSageSecretPermission = sageCapabilities.includes(WALLET_SECRET_CAPABILITY);
    const prefixValidationError = validateWantedPrefix(wantedPrefix);
    const suffixValidationError = validateWantedSuffix(wantedSuffix);
    const patternValidationError = validateWantedPatterns(wantedPrefix, wantedSuffix);
    const publicKeyValidationError =
        credentialKind === 'public' && mode === 'unhardened'
            ? validateMasterPublicKey(masterPublicKey)
            : null;
    const hasMnemonic = mnemonic.trim().length > 0;
    const hasSecretKey = masterSecretKey.trim().length > 0;
    const hasValidPublicKey =
        masterPublicKey.trim().length > 0 && !publicKeyValidationError;
    const hasRequiredKeyMaterial =
        credentialKind === 'public'
            ? canUsePublicCredential && hasValidPublicKey
            : hasMnemonic || hasSecretKey;
    const credentialReadyLabel = credentialKind === 'public'
        ? 'Public key ready'
        : hasSecretKey
            ? 'Private key ready'
            : hasMnemonic
                ? 'Mnemonic ready'
                : 'Choose a key source';

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

        const req: StartSearchRequest = {
            mnemonic: credentialKind === 'private' ? mnemonic.trim() : '',
            masterSecretKey: credentialKind === 'private' ? normalizeSecretKeyInput(masterSecretKey) : '',
            masterPublicKey: credentialKind === 'public' ? normalizePublicKeyInput(masterPublicKey) : '',
            wantedPrefix: wantedPrefix.trim(),
            wantedSuffix: wantedSuffix.trim(),
            startIndex: clampU32(startIndex),
            chunkSize: Math.max(1, Math.floor(chunkSize) || 10000),
            mode,
            workerCount: Math.max(0, Math.floor(workerCount) || 0),
            searchMode,
        };

        try {
            await runtime.startSearch(req);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
            setStatus('Failed to start');
            setUiState('idle');
        }
    }

    async function handleStop() {
        try {
            setUiState('stopping');
            setStatus('Stopping');
            await runtime.stopSearch();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
            setStatus('Failed to stop');
            setUiState('running');
        }
    }

    async function handleDerive() {
        setWorkMode('derive');
        setError('');
        setResults([]);
        setResultLabel('Deriving');
        setStatus('Deriving');
        setDeriving(true);

        try {
            const derived = await runtime.deriveAddresses({
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

    async function handleLoadSageKey() {
        const candidate = runtime as {
            getSageKeyMaterial?: () => Promise<SageKeyMaterial | null>;
        };

        if (typeof candidate.getSageKeyMaterial !== 'function') {
            setError('Sage bridge is not available.');
            setStatus('Sage unavailable');
            return;
        }

        setLoadingSageKey(true);
        setError('');
        setStatus('Loading Sage key');

        try {
            const key = await candidate.getSageKeyMaterial();
            if (!key) {
                setStatus('No Sage key');
                return;
            }

            setSageKey(key);
            setMasterPublicKey(normalizePublicKeyInput(key.publicKey));
            await refreshSageCapabilities();
            setStatus('Sage public key loaded');
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setStatus('Sage key failed');
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

        let activeKey = sageKey;

        if (!activeKey) {
            const keyCandidate = runtime as {
                getSageKeyMaterial?: () => Promise<SageKeyMaterial | null>;
            };

            if (typeof keyCandidate.getSageKeyMaterial !== 'function') {
                setError('Sage bridge is not available.');
                setStatus('Sage unavailable');
                return;
            }

            activeKey = await keyCandidate.getSageKeyMaterial();
            if (activeKey) {
                setSageKey(activeKey);
                setMasterPublicKey(normalizePublicKeyInput(activeKey.publicKey));
                await refreshSageCapabilities();
            }
        }

        if (!activeKey) {
            setError('Load the Sage wallet key first.');
            setStatus('Sage key needed');
            return;
        }

        if (typeof candidate.getSageSecretKey !== 'function') {
            setError('Sage secret-key bridge is not available.');
            setStatus('Sage unavailable');
            return;
        }

        setLoadingSageSecret(true);
        setError('');
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
            setStatus('Sage secret failed');
        } finally {
            setLoadingSageSecret(false);
        }
    }

    return (
        <main style={styles.page}>
            <div style={styles.shell}>
                <header style={styles.header}>
                    <div style={styles.brandBlock}>
                        <div style={styles.brandMark}>CV</div>
                        <div>
                            <h1 style={styles.title}>Chia Vanity</h1>
                            <div style={styles.subtleLine}>
                                {workerCount > 0 ? `${workerCount} workers` : 'auto workers'} · {mode}
                            </div>
                        </div>
                    </div>

                    <div style={styles.statusPill}>
                        <span style={styles.statusDot} />
                        <span>{status}</span>
                    </div>
                </header>

                <section style={styles.topStrip}>
                    <Metric label="Checked" value={checked.toLocaleString()} />
                    <Metric label="Rate" value={`${formatNumber(ratePerSec)}/s`} />
                    <Metric label="Elapsed" value={`${elapsedSecs.toFixed(1)} s`} />
                    <Metric label="State" value={uiState} />
                    {hostInfo ? (
                        <Metric
                            label="Host"
                            value={hostInfo.permissions.persistent_storage ? 'persistent' : 'session'}
                        />
                    ) : null}
                </section>

                <div style={styles.layout}>
                    <section style={styles.panel}>
                        <div style={styles.panelHeader}>
                            <div>
                                <h2 style={styles.sectionTitle}>Work</h2>
                            </div>
                            <SegmentedControl
                                value={workMode}
                                onChange={setWorkMode}
                                disabled={inputsDisabled}
                            />
                        </div>

                        <section style={styles.credentialPanel}>
                            <div style={styles.credentialHeader}>
                                <div>
                                    <h3 style={styles.credentialTitle}>Key source</h3>
                                    <div style={styles.subtleLine}>{credentialReadyLabel}</div>
                                </div>
                                {isSage ? (
                                    <span style={styles.sageBadge}>Sage</span>
                                ) : (
                                    <span style={styles.browserBadge}>Browser</span>
                                )}
                            </div>

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
                                            ? 'Importing'
                                            : hasSageKeyPermission
                                                ? 'Import public key'
                                                : 'Grant and import public key'}
                                    </button>
                                    <PermissionPill granted={hasSageKeyPermission} label="wallet.get_key" />
                                    {sageKey ? (
                                        <div style={styles.sageKeyLabel}>
                                            {sageKey.name} · {sageKey.fingerprint}
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
                                    <PermissionPill granted={hasSageSecretPermission} label="wallet.get_secret_key" />
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
                                        This app does not send your mnemonic anywhere, but pasting a mnemonic into websites is still risky. Other sites may be dishonest, and browser extensions can read page contents. Installing this app into Sage is safer because Sage can provide keys through its permission prompts.
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

                        {workMode === 'search' ? (
                            <div style={styles.formStack}>
                                <div style={styles.formGrid}>
                                    <label style={styles.field}>
                                        <span style={styles.labelText}>Prefix</span>
                                        <input
                                            style={{
                                                ...styles.input,
                                                ...(prefixValidationError ? styles.invalidInput : null),
                                            }}
                                            value={wantedPrefix}
                                            onChange={(e) => setWantedPrefix(e.target.value)}
                                            placeholder="xch1ace"
                                            aria-invalid={Boolean(prefixValidationError)}
                                            disabled={inputsDisabled}
                                        />
                                        <FieldError message={prefixValidationError} />
                                    </label>

                                    <label style={styles.field}>
                                        <span style={styles.labelText}>Suffix</span>
                                        <input
                                            style={{
                                                ...styles.input,
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

                                    <label style={styles.field}>
                                        <span style={styles.labelText}>Mode</span>
                                        <select
                                            style={styles.input}
                                            value={mode}
                                            onChange={(e) => setMode(e.target.value as Mode)}
                                            disabled={inputsDisabled}
                                        >
                                            <option value="unhardened">unhardened</option>
                                            <option value="hardened">hardened</option>
                                            <option value="both">both</option>
                                        </select>
                                    </label>

                                    <label style={styles.field}>
                                        <span style={styles.labelText}>Search</span>
                                        <select
                                            style={styles.input}
                                            value={searchMode}
                                            onChange={(e) => setSearchMode(e.target.value as SearchMode)}
                                            disabled={inputsDisabled}
                                        >
                                            <option value="fast">fast</option>
                                            <option value="lowest">lowest index</option>
                                        </select>
                                    </label>

                                    <NumberField
                                        label="Start index"
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

                                {patternValidationError ? (
                                    <div style={styles.formError}>{patternValidationError}</div>
                                ) : null}
                                {!hasRequiredKeyMaterial ? (
                                    <CredentialHint
                                        isSage={isSage}
                                        kind={credentialKind}
                                        source={activeCredentialSource}
                                        publicAllowed={canUsePublicCredential}
                                    />
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
                                        label="Index"
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

                                    <label style={styles.field}>
                                        <span style={styles.labelText}>Mode</span>
                                        <select
                                            style={styles.input}
                                            value={mode}
                                            onChange={(e) => setMode(e.target.value as Mode)}
                                            disabled={inputsDisabled}
                                        >
                                            <option value="unhardened">unhardened</option>
                                            <option value="hardened">hardened</option>
                                            <option value="both">both</option>
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
                                {!hasRequiredKeyMaterial ? (
                                    <CredentialHint
                                        isSage={isSage}
                                        kind={credentialKind}
                                        source={activeCredentialSource}
                                        publicAllowed={canUsePublicCredential}
                                    />
                                ) : null}
                            </div>
                        )}
                    </section>

                    <aside style={styles.panel}>
                        <div style={styles.panelHeader}>
                            <div>
                                <h2 style={styles.sectionTitle}>Result</h2>
                                <div style={styles.subtleLine}>{resultLabel}</div>
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
                        ) : (
                            <div style={styles.emptyState}>Waiting for output</div>
                        )}

                        {error ? (
                            <div style={styles.errorBox}>
                                <strong>Error</strong>
                                <span>{error}</span>
                            </div>
                        ) : null}
                    </aside>
                </div>
            </div>
        </main>
    );
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
                    {item === 'search' ? 'Search' : 'Index'}
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

function PermissionPill({ granted, label }: { granted: boolean; label: string }) {
    return (
        <span
            style={{
                ...styles.permissionPill,
                ...(granted ? styles.permissionGranted : styles.permissionMissing),
            }}
        >
            {granted ? 'Granted' : 'Needs permission'} · {label}
        </span>
    );
}

function CredentialHint({
    isSage,
    kind,
    source,
    publicAllowed,
}: {
    isSage: boolean;
    kind: CredentialKind;
    source: CredentialSource;
    publicAllowed: boolean;
}) {
    let message = '';

    if (kind === 'public' && !publicAllowed) {
        message = 'Public-key mode is only available for unhardened derivation.';
    } else if (isSage && source === 'sage') {
        message = kind === 'public'
            ? 'Import the public key from Sage to continue.'
            : 'Import the private key from Sage to continue.';
    } else {
        message = kind === 'public'
            ? 'Paste a master public key to continue.'
            : 'Paste a mnemonic to continue.';
    }

    return <div style={styles.credentialHint}>{message}</div>;
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
                <span>Index {item.index}</span>
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
        background: '#151513',
        color: '#f3f0e8',
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
        display: 'grid',
        placeItems: 'center',
        background: '#d7ff66',
        color: '#12120f',
        fontWeight: 800,
        fontSize: 13,
    },
    title: {
        margin: 0,
        fontSize: 25,
        lineHeight: 1,
        fontWeight: 760,
        letterSpacing: 0,
    },
    subtleLine: {
        marginTop: 5,
        color: '#a7a194',
        fontSize: 12,
        lineHeight: 1.35,
        textTransform: 'capitalize',
    },
    statusPill: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        minHeight: 34,
        padding: '0 12px',
        borderRadius: 8,
        border: '1px solid rgba(243, 240, 232, 0.12)',
        background: '#1f1f1b',
        color: '#e9e2d0',
        fontSize: 13,
        fontWeight: 650,
    },
    statusDot: {
        width: 8,
        height: 8,
        borderRadius: 99,
        background: '#41d6a3',
        boxShadow: '0 0 0 3px rgba(65, 214, 163, 0.14)',
    },
    topStrip: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap: 1,
        overflow: 'hidden',
        borderRadius: 8,
        border: '1px solid rgba(243, 240, 232, 0.1)',
        background: 'rgba(243, 240, 232, 0.1)',
        marginBottom: 16,
    },
    metric: {
        display: 'grid',
        gap: 5,
        padding: '13px 14px',
        background: '#1b1b18',
        minWidth: 0,
    },
    metricLabel: {
        color: '#8f897c',
        fontSize: 11,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: 0,
    },
    metricValue: {
        color: '#f7f2e7',
        fontSize: 18,
        fontWeight: 760,
        lineHeight: 1.2,
        overflowWrap: 'anywhere',
        textTransform: 'capitalize',
    },
    layout: {
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1.25fr) minmax(min(100%, 340px), 0.75fr)',
        gap: 16,
        alignItems: 'start',
    },
    panel: {
        padding: 18,
        borderRadius: 8,
        background: '#20201c',
        border: '1px solid rgba(243, 240, 232, 0.11)',
        boxShadow: '0 18px 55px rgba(0, 0, 0, 0.24)',
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
        color: '#fffaf0',
        fontSize: 15,
        fontWeight: 760,
        letterSpacing: 0,
    },
    segmented: {
        display: 'inline-grid',
        gridTemplateColumns: '1fr 1fr',
        padding: 3,
        borderRadius: 8,
        background: '#151513',
        border: '1px solid rgba(243, 240, 232, 0.1)',
    },
    segmentButton: {
        height: 30,
        minWidth: 72,
        padding: '0 10px',
        border: 0,
        borderRadius: 6,
        background: 'transparent',
        color: '#9f9888',
        fontSize: 12,
        fontWeight: 750,
        cursor: 'pointer',
    },
    segmentButtonActive: {
        background: '#f3f0e8',
        color: '#171714',
    },
    fieldFull: {
        display: 'grid',
        gap: 7,
        minWidth: 0,
    },
    credentialPanel: {
        display: 'grid',
        gap: 13,
        padding: 14,
        borderRadius: 8,
        border: '1px solid rgba(243, 240, 232, 0.1)',
        background: '#191914',
    },
    credentialHeader: {
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 12,
        flexWrap: 'wrap',
    },
    credentialTitle: {
        margin: 0,
        color: '#fffaf0',
        fontSize: 13,
        fontWeight: 800,
        letterSpacing: 0,
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
        border: '1px solid rgba(243, 240, 232, 0.1)',
        background: '#20201c',
        color: '#f3f0e8',
        textAlign: 'left',
        cursor: 'pointer',
    },
    choiceButtonActive: {
        borderColor: 'rgba(215, 255, 102, 0.45)',
        background: 'rgba(215, 255, 102, 0.08)',
    },
    choiceTitle: {
        fontSize: 13,
        fontWeight: 850,
    },
    choiceText: {
        color: '#a7a194',
        fontSize: 12,
        lineHeight: 1.35,
    },
    sourceSwitch: {
        display: 'inline-grid',
        gridTemplateColumns: '1fr 1fr',
        justifySelf: 'start',
        padding: 3,
        borderRadius: 8,
        background: '#10100e',
        border: '1px solid rgba(243, 240, 232, 0.1)',
    },
    sourceButton: {
        height: 32,
        padding: '0 11px',
        border: 0,
        borderRadius: 6,
        background: 'transparent',
        color: '#9f9888',
        fontSize: 12,
        fontWeight: 800,
        cursor: 'pointer',
    },
    sourceButtonActive: {
        background: '#f3f0e8',
        color: '#171714',
    },
    sageBadge: {
        display: 'inline-flex',
        alignItems: 'center',
        minHeight: 26,
        padding: '0 9px',
        borderRadius: 8,
        border: '1px solid rgba(65, 214, 163, 0.25)',
        background: 'rgba(65, 214, 163, 0.1)',
        color: '#93f1d3',
        fontSize: 11,
        fontWeight: 850,
    },
    browserBadge: {
        display: 'inline-flex',
        alignItems: 'center',
        minHeight: 26,
        padding: '0 9px',
        borderRadius: 8,
        border: '1px solid rgba(255, 189, 89, 0.24)',
        background: 'rgba(255, 189, 89, 0.08)',
        color: '#ffd08a',
        fontSize: 11,
        fontWeight: 850,
    },
    formStack: {
        display: 'grid',
        gap: 14,
        marginTop: 14,
    },
    formGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 210px), 1fr))',
        gap: 12,
    },
    field: {
        display: 'grid',
        gap: 7,
        alignContent: 'start',
        minWidth: 0,
    },
    labelText: {
        color: '#b1aa9c',
        fontSize: 12,
        fontWeight: 700,
    },
    textarea: {
        width: '100%',
        minHeight: 112,
        borderRadius: 8,
        border: '1px solid rgba(243, 240, 232, 0.13)',
        background: '#151513',
        color: '#f6f0e3',
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
        border: '1px solid rgba(243, 240, 232, 0.13)',
        background: '#151513',
        color: '#f6f0e3',
        padding: '0 12px',
        boxSizing: 'border-box',
        outline: 'none',
        fontSize: 13,
    },
    invalidInput: {
        borderColor: '#e06464',
        boxShadow: '0 0 0 2px rgba(224, 100, 100, 0.16)',
    },
    fieldError: {
        color: '#ff9f9f',
        fontSize: 12,
        lineHeight: 1.35,
    },
    formError: {
        color: '#ffb2a8',
        fontSize: 13,
        lineHeight: 1.45,
    },
    credentialHint: {
        color: '#d6cfbf',
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
        border: '1px solid rgba(65, 214, 163, 0.16)',
        background: 'rgba(65, 214, 163, 0.06)',
    },
    sageKeyLabel: {
        color: '#93f1d3',
        fontSize: 12,
        fontWeight: 750,
        overflowWrap: 'anywhere',
    },
    permissionPill: {
        display: 'inline-flex',
        alignItems: 'center',
        minHeight: 30,
        padding: '0 10px',
        borderRadius: 8,
        fontSize: 12,
        fontWeight: 750,
        overflowWrap: 'anywhere',
    },
    permissionGranted: {
        color: '#93f1d3',
        background: 'rgba(65, 214, 163, 0.1)',
        border: '1px solid rgba(65, 214, 163, 0.2)',
    },
    permissionMissing: {
        color: '#ffd08a',
        background: 'rgba(255, 189, 89, 0.08)',
        border: '1px solid rgba(255, 189, 89, 0.22)',
    },
    warningBox: {
        display: 'grid',
        gap: 9,
        padding: 12,
        borderRadius: 8,
        border: '1px solid rgba(255, 189, 89, 0.24)',
        background: 'rgba(255, 189, 89, 0.08)',
        color: '#ffe0ae',
        fontSize: 13,
        lineHeight: 1.45,
    },
    warningButton: {
        justifySelf: 'start',
        height: 34,
        borderRadius: 8,
        border: '1px solid rgba(255, 189, 89, 0.28)',
        background: '#2d2619',
        color: '#ffe0ae',
        padding: '0 12px',
        fontSize: 12,
        fontWeight: 850,
        cursor: 'pointer',
    },
    primaryButton: {
        height: 40,
        minWidth: 112,
        borderRadius: 8,
        border: '1px solid rgba(215, 255, 102, 0.25)',
        background: '#d7ff66',
        color: '#12120f',
        padding: '0 16px',
        fontSize: 13,
        fontWeight: 800,
        cursor: 'pointer',
    },
    secondaryButton: {
        height: 40,
        minWidth: 86,
        borderRadius: 8,
        border: '1px solid rgba(243, 240, 232, 0.13)',
        background: '#292921',
        color: '#f3f0e8',
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
        borderBottom: '1px solid rgba(243, 240, 232, 0.1)',
    },
    resultMeta: {
        display: 'flex',
        justifyContent: 'space-between',
        gap: 10,
        color: '#b3ab9b',
        fontSize: 12,
        fontWeight: 750,
        textTransform: 'capitalize',
    },
    addressLine: {
        fontFamily: monoStack,
        fontSize: 13,
        lineHeight: 1.55,
        color: '#f7f2e7',
        overflowWrap: 'anywhere',
    },
    copyButton: {
        justifySelf: 'start',
        height: 32,
        borderRadius: 8,
        border: '1px solid rgba(65, 214, 163, 0.26)',
        background: 'rgba(65, 214, 163, 0.12)',
        color: '#93f1d3',
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
        border: '1px dashed rgba(243, 240, 232, 0.16)',
        color: '#8f897c',
        fontSize: 13,
    },
    errorBox: {
        display: 'grid',
        gap: 6,
        marginTop: 16,
        paddingTop: 14,
        borderTop: '1px solid rgba(224, 100, 100, 0.28)',
        color: '#ffb2a8',
        fontSize: 13,
        lineHeight: 1.45,
    },
};
