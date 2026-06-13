import React, { useEffect, useMemo, useState } from 'react';
import { runtime } from '../runtime';
import {
    validateWantedPatterns,
    validateWantedPrefix,
    validateWantedSuffix,
} from '../lib/vanityValidation';

type Mode = 'hardened' | 'unhardened' | 'both';
type SearchMode = 'fast' | 'lowest';
type UiState = 'idle' | 'running' | 'stopping';

interface SearchHitPayload {
    index: number;
    mode: string;
    address: string;
}

interface StartSearchRequest {
    mnemonic: string;
    wantedPrefix: string;
    wantedSuffix: string;
    startIndex: number;
    chunkSize: number;
    mode: Mode;
    workerCount: number;
    searchMode: SearchMode;
}

export default function VanityApp() {
    const [hostInfo, setHostInfo] = useState<null | {
        permissions: { network: boolean; persistent_storage: boolean };
        storage: { bytesUsed: number; quotaBytes: number | null };
    }>(null);

    const [mnemonic, setMnemonic] = useState('');
    const [wantedPrefix, setWantedPrefix] = useState('xch1ace');
    const [wantedSuffix, setWantedSuffix] = useState('');
    const [startIndex, setStartIndex] = useState(0);
    const [chunkSize, setChunkSize] = useState(10000);
    const [mode, setMode] = useState<Mode>('unhardened');
    const [workerCount, setWorkerCount] = useState(0);
    const [searchMode, setSearchMode] = useState<SearchMode>('fast');

    const [uiState, setUiState] = useState<UiState>('idle');
    const [checked, setChecked] = useState(0);
    const [ratePerSec, setRatePerSec] = useState(0);
    const [elapsedSecs, setElapsedSecs] = useState(0);
    const [hit, setHit] = useState<SearchHitPayload | null>(null);
    const [error, setError] = useState('');
    const [status, setStatus] = useState('Idle');

    useEffect(() => {
        const maybeLoadHostInfo = async () => {
            const candidate = runtime as {
                getHostCapabilities?: () => Promise<null | {
                    permissions: { network: boolean; persistent_storage: boolean };
                    storage: { bytesUsed: number; quotaBytes: number | null };
                }>;
            };

            if (typeof candidate.getHostCapabilities === 'function') {
                const info = await candidate.getHostCapabilities();
                setHostInfo(info);
            }
        };

        void maybeLoadHostInfo();
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
                setStatus('Searching...');
                setUiState((prev) => (prev === 'stopping' ? prev : 'running'));
            });

            unlistenCompleted = await runtime.onSearchCompleted((event) => {
                setHit(event.hit);
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

    const inputsDisabled = uiState !== 'idle';
    const prefixValidationError = validateWantedPrefix(wantedPrefix);
    const suffixValidationError = validateWantedSuffix(wantedSuffix);
    const patternValidationError = validateWantedPatterns(wantedPrefix, wantedSuffix);

    const canStart = useMemo(() => {
        const hasWantedPattern =
            wantedPrefix.trim().length > 0 || wantedSuffix.trim().length > 0;

        return (
            mnemonic.trim().length > 0 &&
            hasWantedPattern &&
            !prefixValidationError &&
            !suffixValidationError &&
            uiState === 'idle'
        );
    }, [mnemonic, prefixValidationError, suffixValidationError, wantedPrefix, wantedSuffix, uiState]);

    const canStop = uiState === 'running';

    async function handleStart() {
        if (patternValidationError) {
            setError(patternValidationError);
            setStatus('Invalid input');
            return;
        }

        setError('');
        setHit(null);
        setChecked(0);
        setRatePerSec(0);
        setElapsedSecs(0);
        setStatus('Starting...');
        setUiState('running');

        const req: StartSearchRequest = {
            mnemonic: mnemonic.trim(),
            wantedPrefix: wantedPrefix.trim(),
            wantedSuffix: wantedSuffix.trim(),
            startIndex,
            chunkSize,
            mode,
            workerCount,
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
            setStatus('Stopping...');
            await runtime.stopSearch();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
            setStatus('Failed to stop');
            setUiState('running');
        }
    }

    return (
        <main style={styles.page}>
            <div style={styles.shell}>
                <header style={styles.header}>
                    <div>
                        <h1 style={styles.title}>Chia Vanity</h1>
                        <p style={styles.subtitle}>
                            Brute-force receive address prefixes and suffixes by derivation index.
                        </p>
                    </div>

                    <div style={styles.headerStatus}>
                        <div style={styles.statusLabel}>State</div>
                        <div style={styles.statusValue}>{uiState}</div>
                    </div>
                </header>

                {hostInfo ? (
                    <section style={styles.card}>
                        <div style={styles.cardHeaderRow}>
                            <h2 style={styles.sectionTitle}>Host</h2>
                        </div>
                        <div style={styles.compactStatsGrid}>
                            <Stat
                                label="Network"
                                value={hostInfo.permissions.network ? 'allowed' : 'blocked'}
                            />
                            <Stat
                                label="Persistent"
                                value={hostInfo.permissions.persistent_storage ? 'allowed' : 'blocked'}
                            />
                            <Stat
                                label="Storage used"
                                value={`${hostInfo.storage.bytesUsed.toLocaleString()} bytes`}
                            />
                            <Stat
                                label="Quota"
                                value={
                                    hostInfo.storage.quotaBytes === null
                                        ? 'default'
                                        : `${hostInfo.storage.quotaBytes.toLocaleString()} bytes`
                                }
                            />
                        </div>
                    </section>
                ) : null}

                <div style={styles.mainGrid}>
                    <section style={styles.card}>
                        <div style={styles.cardHeaderRow}>
                            <h2 style={styles.sectionTitle}>Search</h2>
                        </div>

                        <label style={styles.label}>
                            <span style={styles.labelText}>Mnemonic</span>
                            <textarea
                                style={styles.textarea}
                                rows={3}
                                value={mnemonic}
                                onChange={(e) => setMnemonic(e.target.value)}
                                placeholder="Enter mnemonic phrase"
                                disabled={inputsDisabled}
                            />
                        </label>

                        <div style={styles.formGrid}>
                            <label style={styles.label}>
                                <span style={styles.labelText}>Wanted prefix</span>
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
                                {prefixValidationError ? (
                                    <span style={styles.fieldError}>{prefixValidationError}</span>
                                ) : null}
                            </label>

                            <label style={styles.label}>
                                <span style={styles.labelText}>Wanted suffix</span>
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
                                {suffixValidationError ? (
                                    <span style={styles.fieldError}>{suffixValidationError}</span>
                                ) : null}
                            </label>

                            <label style={styles.label}>
                                <span style={styles.labelText}>Mode</span>
                                <select
                                    style={styles.input}
                                    value={mode}
                                    onChange={(e) => setMode(e.target.value as Mode)}
                                    disabled={inputsDisabled}
                                >
                                    <option value="hardened">hardened</option>
                                    <option value="unhardened">unhardened</option>
                                    <option value="both">both</option>
                                </select>
                            </label>

                            <label style={styles.label}>
                                <span style={styles.labelText}>Start index</span>
                                <input
                                    style={styles.input}
                                    type="number"
                                    value={startIndex}
                                    onChange={(e) => setStartIndex(Number(e.target.value))}
                                    disabled={inputsDisabled}
                                />
                            </label>

                            <label style={styles.label}>
                                <span style={styles.labelText}>Chunk size</span>
                                <input
                                    style={styles.input}
                                    type="number"
                                    value={chunkSize}
                                    onChange={(e) => setChunkSize(Number(e.target.value))}
                                    disabled={inputsDisabled}
                                />
                            </label>

                            <label style={styles.label}>
                                <span style={styles.labelText}>Worker count</span>
                                <input
                                    style={styles.input}
                                    type="number"
                                    value={workerCount}
                                    onChange={(e) => setWorkerCount(Number(e.target.value))}
                                    disabled={inputsDisabled}
                                />
                            </label>

                            <label style={styles.label}>
                                <span style={styles.labelText}>Search mode</span>
                                <select
                                    style={styles.input}
                                    value={searchMode}
                                    onChange={(e) => setSearchMode(e.target.value as SearchMode)}
                                    disabled={inputsDisabled}
                                >
                                    <option value="fast">fast</option>
                                    <option value="lowest">lowest</option>
                                </select>
                            </label>
                        </div>

                        <div style={styles.actions}>
                            <button style={styles.primaryButton} onClick={handleStart} disabled={!canStart}>
                                Start search
                            </button>
                            <button style={styles.secondaryButton} onClick={handleStop} disabled={!canStop}>
                                Stop
                            </button>
                            <div style={styles.inlineStatus}>
                                <span style={styles.inlineStatusLabel}>Status</span>
                                <span style={styles.inlineStatusValue}>{status}</span>
                            </div>
                        </div>
                    </section>

                    <div style={styles.sideColumn}>
                        <section style={styles.card}>
                            <div style={styles.cardHeaderRow}>
                                <h2 style={styles.sectionTitle}>Progress</h2>
                            </div>
                            <div style={styles.compactStatsGrid}>
                                <Stat label="Checked" value={checked.toLocaleString()} />
                                <Stat label="Rate/s" value={ratePerSec.toFixed(0)} />
                                <Stat label="Elapsed" value={`${elapsedSecs.toFixed(1)} s`} />
                                <Stat label="Status" value={status} mono />
                            </div>
                        </section>

                        <section style={styles.card}>
                            <div style={styles.cardHeaderRow}>
                                <h2 style={styles.sectionTitle}>Result</h2>
                            </div>
                            {hit ? (
                                <div style={styles.resultBox}>
                                    <div style={styles.resultRow}>
                                        <span style={styles.resultKey}>Index</span>
                                        <span style={styles.resultValMono}>{hit.index}</span>
                                    </div>
                                    <div style={styles.resultRow}>
                                        <span style={styles.resultKey}>Mode</span>
                                        <span style={styles.resultValMono}>{hit.mode}</span>
                                    </div>
                                    <div style={styles.resultAddressBlock}>
                                        <div style={styles.resultKey}>Address</div>
                                        <div style={styles.resultAddress}>{hit.address}</div>
                                    </div>
                                </div>
                            ) : (
                                <div style={styles.muted}>No result yet.</div>
                            )}
                        </section>

                        {error ? (
                            <section style={styles.errorBox}>
                                <div style={styles.errorTitle}>Error</div>
                                <div>{error}</div>
                            </section>
                        ) : null}
                    </div>
                </div>
            </div>
        </main>
    );
}

function Stat({
                  label,
                  value,
                  mono = false,
              }: {
    label: string;
    value: string;
    mono?: boolean;
}) {
    return (
        <div style={styles.statCard}>
            <div style={styles.statLabel}>{label}</div>
            <div
                style={{
                    ...styles.statValue,
                    ...(mono ? styles.monoValue : null),
                }}
            >
                {value}
            </div>
        </div>
    );
}

const styles: Record<string, React.CSSProperties> = {
    page: {
        minHeight: '100vh',
        margin: 0,
        background:
            'radial-gradient(circle at top, rgba(37,99,235,0.08), transparent 28%), #0a0f1a',
        color: '#e5e7eb',
        fontFamily:
            'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
    },
    shell: {
        maxWidth: 1120,
        margin: '0 auto',
        padding: 18,
    },
    header: {
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 16,
        marginBottom: 14,
    },
    title: {
        margin: 0,
        fontSize: 24,
        lineHeight: 1,
        fontWeight: 700,
        letterSpacing: -0.5,
    },
    subtitle: {
        margin: '6px 0 0',
        color: '#8ea0b8',
        fontSize: 13,
        lineHeight: 1.45,
    },
    headerStatus: {
        minWidth: 120,
        padding: '10px 12px',
        borderRadius: 12,
        background: 'rgba(15, 23, 42, 0.75)',
        border: '1px solid rgba(148, 163, 184, 0.12)',
        backdropFilter: 'blur(10px)',
    },
    statusLabel: {
        fontSize: 11,
        color: '#8ea0b8',
        textTransform: 'uppercase',
        letterSpacing: 0.8,
    },
    statusValue: {
        marginTop: 4,
        fontSize: 13,
        fontWeight: 700,
        textTransform: 'capitalize',
    },
    mainGrid: {
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1.4fr) minmax(320px, 0.86fr)',
        gap: 14,
        alignItems: 'start',
    },
    sideColumn: {
        display: 'grid',
        gap: 14,
    },
    card: {
        marginTop: 0,
        padding: 16,
        borderRadius: 14,
        background: 'rgba(15, 23, 42, 0.82)',
        border: '1px solid rgba(148, 163, 184, 0.12)',
        boxShadow: '0 10px 30px rgba(0, 0, 0, 0.22)',
        backdropFilter: 'blur(10px)',
    },
    cardHeaderRow: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 12,
    },
    sectionTitle: {
        margin: 0,
        fontSize: 14,
        fontWeight: 700,
        letterSpacing: 0.2,
    },
    label: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minWidth: 0,
    },
    labelText: {
        fontSize: 12,
        color: '#9fb0c7',
        fontWeight: 500,
    },
    textarea: {
        width: '100%',
        minHeight: 92,
        borderRadius: 10,
        border: '1px solid rgba(148, 163, 184, 0.16)',
        background: '#0b1220',
        color: '#e5e7eb',
        padding: '10px 12px',
        resize: 'vertical',
        boxSizing: 'border-box',
        outline: 'none',
        fontSize: 13,
        lineHeight: 1.45,
    },
    formGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        gap: 12,
        marginTop: 12,
    },
    input: {
        width: '100%',
        height: 40,
        borderRadius: 10,
        border: '1px solid rgba(148, 163, 184, 0.16)',
        background: '#0b1220',
        color: '#e5e7eb',
        padding: '0 12px',
        boxSizing: 'border-box',
        outline: 'none',
        fontSize: 13,
    },
    invalidInput: {
        borderColor: 'rgba(248, 113, 113, 0.75)',
        boxShadow: '0 0 0 1px rgba(248, 113, 113, 0.18)',
    },
    fieldError: {
        color: '#fca5a5',
        fontSize: 12,
        lineHeight: 1.35,
    },
    actions: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        marginTop: 14,
        flexWrap: 'wrap',
    },
    primaryButton: {
        height: 40,
        borderRadius: 10,
        border: '1px solid rgba(96, 165, 250, 0.25)',
        background: 'linear-gradient(180deg, #2563eb, #1d4ed8)',
        color: '#fff',
        padding: '0 14px',
        fontSize: 13,
        fontWeight: 700,
        cursor: 'pointer',
        boxShadow: '0 8px 20px rgba(37, 99, 235, 0.28)',
    },
    secondaryButton: {
        height: 40,
        borderRadius: 10,
        border: '1px solid rgba(148, 163, 184, 0.18)',
        background: 'rgba(15, 23, 42, 0.6)',
        color: '#dbe4f0',
        padding: '0 14px',
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
    },
    inlineStatus: {
        marginLeft: 'auto',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        minHeight: 40,
        padding: '0 12px',
        borderRadius: 10,
        background: '#0b1220',
        border: '1px solid rgba(148, 163, 184, 0.12)',
    },
    inlineStatusLabel: {
        fontSize: 12,
        color: '#8ea0b8',
    },
    inlineStatusValue: {
        fontSize: 12,
        fontWeight: 700,
        color: '#e5e7eb',
    },
    compactStatsGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        gap: 10,
    },
    statCard: {
        padding: 12,
        borderRadius: 12,
        background: '#0b1220',
        border: '1px solid rgba(148, 163, 184, 0.1)',
        minWidth: 0,
    },
    statLabel: {
        fontSize: 11,
        color: '#8ea0b8',
        textTransform: 'uppercase',
        letterSpacing: 0.7,
    },
    statValue: {
        marginTop: 6,
        fontSize: 15,
        fontWeight: 700,
        lineHeight: 1.3,
        wordBreak: 'break-word',
    },
    monoValue: {
        fontFamily:
            'ui-monospace, SFMono-Regular, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace',
        fontSize: 13,
    },
    resultBox: {
        padding: 12,
        borderRadius: 12,
        background: '#0b1220',
        border: '1px solid rgba(148, 163, 184, 0.1)',
        display: 'grid',
        gap: 10,
    },
    resultRow: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
    },
    resultKey: {
        fontSize: 11,
        color: '#8ea0b8',
        textTransform: 'uppercase',
        letterSpacing: 0.7,
    },
    resultValMono: {
        fontFamily:
            'ui-monospace, SFMono-Regular, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace',
        fontSize: 13,
        fontWeight: 700,
        color: '#e5e7eb',
    },
    resultAddressBlock: {
        display: 'grid',
        gap: 6,
        paddingTop: 2,
    },
    resultAddress: {
        fontFamily:
            'ui-monospace, SFMono-Regular, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace',
        fontSize: 13,
        lineHeight: 1.5,
        wordBreak: 'break-all',
        color: '#dbe4f0',
    },
    muted: {
        color: '#8ea0b8',
        fontSize: 13,
    },
    errorBox: {
        padding: 14,
        borderRadius: 12,
        background: 'rgba(127, 29, 29, 0.18)',
        border: '1px solid rgba(239, 68, 68, 0.28)',
        color: '#fecaca',
    },
    errorTitle: {
        marginBottom: 6,
        fontSize: 12,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: 0.7,
    },
};
