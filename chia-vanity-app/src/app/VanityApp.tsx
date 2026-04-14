import React, { useEffect, useMemo, useState } from 'react';
import {runtime} from "../runtime";

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
    startIndex: number;
    chunkSize: number;
    mode: Mode;
    workerCount: number;
    searchMode: SearchMode;
}

export default function VanityApp() {
    const [mnemonic, setMnemonic] = useState('');
    const [wantedPrefix, setWantedPrefix] = useState('xch1ace');
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
        let unlistenProgress: (() => void) | undefined;
        let unlistenCompleted: (() => void) | undefined;
        let unlistenFailed: (() => void) | undefined;
        let unlistenState: (() => void) | undefined;

        const setup = async () => {
            unlistenProgress = await runtime.onSearchProgress(
                (event) => {
                    setChecked(event.checked);
                    setRatePerSec(event.ratePerSec);
                    setElapsedSecs(event.elapsedSecs);
                    setStatus('Searching...');
                    setUiState((prev) => (prev === 'stopping' ? prev : 'running'));
                },
            );

            unlistenCompleted = await runtime.onSearchCompleted(
                (event) => {
                    setHit(event.hit);
                    setStatus(event.hit ? 'Match found' : 'No match found');
                    setUiState('idle');
                },
            );

            unlistenFailed = await runtime.onSearchFailed(
                (event) => {
                    setError(event.message);
                    setStatus('Search failed');
                    setUiState('idle');
                },
            );

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
    const canStart = useMemo(() => {
        return (
            mnemonic.trim().length > 0 &&
            wantedPrefix.trim().length > 0 &&
            uiState === 'idle'
        );
    }, [mnemonic, wantedPrefix, uiState]);

    const canStop = uiState === 'running';

    async function handleStart() {
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
            <div style={styles.container}>
                <h1 style={styles.title}>Chia Vanity Address Generator</h1>
                <p style={styles.subtitle}>
                    Standalone desktop app for brute-forcing Chia receive address prefixes.
                </p>

                <section style={styles.card}>
                    <h2 style={styles.sectionTitle}>Search</h2>

                    <label style={styles.label}>
                        Mnemonic
                        <textarea
                            style={styles.textarea}
                            rows={4}
                            value={mnemonic}
                            onChange={(e) => setMnemonic(e.target.value)}
                            placeholder="Enter mnemonic phrase"
                            disabled={inputsDisabled}
                        />
                    </label>

                    <div style={styles.grid}>
                        <label style={styles.label}>
                            Wanted prefix
                            <input
                                style={styles.input}
                                value={wantedPrefix}
                                onChange={(e) => setWantedPrefix(e.target.value)}
                                placeholder="xch1ace"
                                disabled={inputsDisabled}
                            />
                        </label>

                        <label style={styles.label}>
                            Start index
                            <input
                                style={styles.input}
                                type="number"
                                value={startIndex}
                                onChange={(e) => setStartIndex(Number(e.target.value))}
                                disabled={inputsDisabled}
                            />
                        </label>

                        <label style={styles.label}>
                            Chunk size
                            <input
                                style={styles.input}
                                type="number"
                                value={chunkSize}
                                onChange={(e) => setChunkSize(Number(e.target.value))}
                                disabled={inputsDisabled}
                            />
                        </label>

                        <label style={styles.label}>
                            Worker count
                            <input
                                style={styles.input}
                                type="number"
                                value={workerCount}
                                onChange={(e) => setWorkerCount(Number(e.target.value))}
                                disabled={inputsDisabled}
                            />
                        </label>

                        <label style={styles.label}>
                            Mode
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
                            Search mode
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
                            Start
                        </button>
                        <button style={styles.secondaryButton} onClick={handleStop} disabled={!canStop}>
                            Stop
                        </button>
                    </div>
                </section>

                <section style={styles.card}>
                    <h2 style={styles.sectionTitle}>Progress</h2>
                    <div style={styles.statsGrid}>
                        <Stat label="State" value={uiState} />
                        <Stat label="Status" value={status} />
                        <Stat label="Checked" value={checked.toLocaleString()} />
                        <Stat label="Rate / sec" value={ratePerSec.toFixed(0)} />
                        <Stat label="Elapsed" value={`${elapsedSecs.toFixed(1)} s`} />
                    </div>
                </section>

                <section style={styles.card}>
                    <h2 style={styles.sectionTitle}>Result</h2>
                    {hit ? (
                        <div style={styles.resultBox}>
                            <div><strong>Index:</strong> {hit.index}</div>
                            <div><strong>Mode:</strong> {hit.mode}</div>
                            <div style={styles.break}><strong>Address:</strong> {hit.address}</div>
                        </div>
                    ) : (
                        <div style={styles.muted}>No result yet.</div>
                    )}
                </section>

                {error ? (
                    <section style={styles.errorBox}>
                        <strong>Error:</strong> {error}
                    </section>
                ) : null}
            </div>
        </main>
    );
}

function Stat({ label, value }: { label: string; value: string }) {
    return (
        <div style={styles.statCard}>
            <div style={styles.statLabel}>{label}</div>
            <div style={styles.statValue}>{value}</div>
        </div>
    );
}

const styles: Record<string, React.CSSProperties> = {
    page: {
        minHeight: '100vh',
        margin: 0,
        background: '#0b1020',
        color: '#e5e7eb',
        fontFamily:
            'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
    },
    container: {
        maxWidth: 980,
        margin: '0 auto',
        padding: 24,
    },
    title: {
        margin: 0,
        fontSize: 32,
        lineHeight: 1.1,
    },
    subtitle: {
        marginTop: 8,
        color: '#94a3b8',
    },
    card: {
        marginTop: 20,
        padding: 20,
        borderRadius: 16,
        background: '#111827',
        border: '1px solid #1f2937',
    },
    sectionTitle: {
        marginTop: 0,
        marginBottom: 16,
        fontSize: 20,
    },
    label: {
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        fontSize: 14,
        color: '#cbd5e1',
    },
    textarea: {
        width: '100%',
        borderRadius: 10,
        border: '1px solid #334155',
        background: '#0f172a',
        color: '#e5e7eb',
        padding: 12,
        resize: 'vertical',
        boxSizing: 'border-box',
    },
    grid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 16,
        marginTop: 16,
    },
    input: {
        width: '100%',
        borderRadius: 10,
        border: '1px solid #334155',
        background: '#0f172a',
        color: '#e5e7eb',
        padding: 12,
        boxSizing: 'border-box',
    },
    actions: {
        display: 'flex',
        gap: 12,
        marginTop: 20,
    },
    primaryButton: {
        borderRadius: 10,
        border: 'none',
        background: '#2563eb',
        color: 'white',
        padding: '12px 18px',
        cursor: 'pointer',
    },
    secondaryButton: {
        borderRadius: 10,
        border: '1px solid #475569',
        background: 'transparent',
        color: '#e5e7eb',
        padding: '12px 18px',
        cursor: 'pointer',
    },
    statsGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: 12,
    },
    statCard: {
        padding: 16,
        borderRadius: 12,
        background: '#0f172a',
        border: '1px solid #1e293b',
    },
    statLabel: {
        fontSize: 12,
        color: '#94a3b8',
    },
    statValue: {
        marginTop: 8,
        fontSize: 18,
        fontWeight: 600,
    },
    resultBox: {
        padding: 16,
        borderRadius: 12,
        background: '#0f172a',
        border: '1px solid #1e293b',
        display: 'grid',
        gap: 8,
    },
    break: {
        wordBreak: 'break-all',
    },
    muted: {
        color: '#94a3b8',
    },
    errorBox: {
        marginTop: 20,
        padding: 16,
        borderRadius: 12,
        background: '#3f1212',
        border: '1px solid #7f1d1d',
        color: '#fecaca',
    },
};
