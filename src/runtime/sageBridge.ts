import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';

export type SageBridgeCapability =
    | 'app.get_info'
    | 'app.get_capabilities'
    | 'app.request_capability_grant'
    | 'wallet.get_key'
    | 'wallet.get_secret_key'
    | 'environment.get_network'
    | 'storage.persistent_webview';

export interface SageRequestedPermissions {
    capabilities: {
        required: SageBridgeCapability[];
        optional: SageBridgeCapability[];
    };
    network: unknown;
}

export interface SageAppInfo {
    id: string;
    name: string;
    version: string;
    requestedPermissions: SageRequestedPermissions;
    capabilities: SageBridgeCapability[];
    network: unknown[];
}

export interface SageKeyInfo {
    name: string;
    fingerprint: number;
    public_key: string;
    has_secrets: boolean;
    network_id: string;
}

export interface SageSecretKeyInfo {
    mnemonic: string | null;
    secret_key: string;
}

interface SageInvokeResult {
    kind: 'success' | 'error' | 'pending';
    resultJson?: string;
    error?: {
        code: string;
        message: string;
    };
}

interface SageBridgeResponse {
    bridgeVersion: 'v1';
    id: string;
    ok: boolean;
    result?: unknown;
    resultJson?: string;
    error?: {
        code: string;
        message: string;
    };
}

interface SageListenEvent<T = unknown> {
    payload: T;
}

const SAGE_BRIDGE_VERSION = 'v1';
const INVOKE_COMMAND = 'apps_invoke_bridge';
const RESPONSE_EVENT = 'sage-bridge:response';
const RUNTIME_EVENT = 'sage-bridge:event';
const REQUEST_TIMEOUT_MS = 30000;

let initialized = false;
const pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeoutId: number;
}>();
const runtimeEventListeners = new Map<string, Set<(payload: unknown) => void>>();

interface SageRuntimeEventEnvelope {
    type: string;
    payload: unknown;
}

function parseJsonOrNull(value: string | null | undefined): unknown {
    if (value == null) {
        return null;
    }

    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function bridgeResponseResult(data: SageBridgeResponse): unknown {
    if ('result' in data) {
        return data.result;
    }

    return parseJsonOrNull(data.resultJson);
}

function makeId(): string {
    return `sage-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function settleResponse(data: SageBridgeResponse) {
    if (!data || data.bridgeVersion !== SAGE_BRIDGE_VERSION) {
        return;
    }

    const request = pending.get(data.id);
    if (!request) {
        return;
    }

    pending.delete(data.id);
    window.clearTimeout(request.timeoutId);

    if (data.ok) {
        request.resolve(bridgeResponseResult(data));
    } else {
        request.reject(new Error(data.error?.message || 'Unknown Sage bridge error'));
    }
}

function settleInvokeResult(id: string, result: SageInvokeResult): boolean {
    if (result.kind === 'pending') {
        return false;
    }

    settleResponse({
        bridgeVersion: SAGE_BRIDGE_VERSION,
        id,
        ok: result.kind === 'success',
        resultJson: result.resultJson,
        error: result.error,
    });

    return true;
}

function isRuntimeEventEnvelope(value: unknown): value is SageRuntimeEventEnvelope {
    return Boolean(
        value &&
        typeof value === 'object' &&
        typeof (value as Partial<SageRuntimeEventEnvelope>).type === 'string' &&
        'payload' in value,
    );
}

function dispatchRuntimeEvent(data: SageRuntimeEventEnvelope) {
    const listeners = runtimeEventListeners.get(data.type);
    if (!listeners) {
        return;
    }

    for (const listener of listeners) {
        listener(data.payload);
    }
}

export function isSageInjected(): boolean {
    return typeof window !== 'undefined' && (
        Boolean((window as typeof window & { __SAGE__?: unknown }).__SAGE__) ||
        Boolean((window as typeof window & { __SAGE_APP_INFO__?: unknown }).__SAGE_APP_INFO__)
    );
}

export function initSageBridge(): boolean {
    if (initialized) {
        return true;
    }

    if (!isSageInjected()) {
        return false;
    }

    try {
        const webview = getCurrentWebview();
        void webview.listen<SageBridgeResponse>(
            RESPONSE_EVENT,
            (event: SageListenEvent<SageBridgeResponse>) => {
                settleResponse(event.payload);
            },
        );
        void webview.listen<SageRuntimeEventEnvelope>(
            RUNTIME_EVENT,
            (event: SageListenEvent<SageRuntimeEventEnvelope>) => {
                if (isRuntimeEventEnvelope(event.payload)) {
                    dispatchRuntimeEvent(event.payload);
                }
            },
        );

        initialized = true;
        return true;
    } catch {
        return false;
    }
}

export function onSageRuntimeEvent<T>(
    type: string,
    handler: (payload: T) => void,
): () => void {
    let listeners = runtimeEventListeners.get(type);

    if (!listeners) {
        listeners = new Set();
        runtimeEventListeners.set(type, listeners);
    }

    const wrapped = handler as (payload: unknown) => void;
    listeners.add(wrapped);

    return () => {
        listeners?.delete(wrapped);
    };
}

export async function callSage<T = unknown>(
    method: string,
    params?: unknown,
): Promise<T> {
    if (!initSageBridge()) {
        throw new Error('Sage bridge is unavailable in this runtime.');
    }

    const id = makeId();

    return await new Promise<T>((resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
            if (!pending.has(id)) {
                return;
            }

            pending.delete(id);
            reject(new Error(`Sage bridge timeout for ${method}`));
        }, REQUEST_TIMEOUT_MS);

        pending.set(id, {
            resolve: (value) => resolve(value as T),
            reject,
            timeoutId,
        });

        void (async () => {
            try {
                const result = await invoke<SageInvokeResult>(INVOKE_COMMAND, {
                    request: {
                        bridgeVersion: SAGE_BRIDGE_VERSION,
                        id,
                        method,
                        paramsJson: params === undefined ? null : JSON.stringify(params),
                    },
                });

                settleInvokeResult(id, result);
            } catch (error) {
                const request = pending.get(id);
                if (!request) {
                    return;
                }

                pending.delete(id);
                window.clearTimeout(request.timeoutId);
                request.reject(error instanceof Error ? error : new Error(String(error)));
            }
        })();
    });
}
