export interface SageBridgeRequest {
    channel: 'sage-bridge';
    id: string;
    method: string;
    params?: unknown;
}

export interface SageBridgeSuccessResponse {
    channel: 'sage-bridge';
    id: string;
    ok: true;
    result: unknown;
}

export interface SageBridgeErrorResponse {
    channel: 'sage-bridge';
    id: string;
    ok: false;
    error: {
        code: string;
        message: string;
    };
}

export type SageBridgeResponse =
    | SageBridgeSuccessResponse
    | SageBridgeErrorResponse;

function isBridgeResponse(value: unknown): value is SageBridgeResponse {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const maybe = value as Partial<SageBridgeResponse>;
    return (
        maybe.channel === 'sage-bridge' &&
        typeof maybe.id === 'string' &&
        typeof maybe.ok === 'boolean'
    );
}

function makeId(): string {
    return `sage-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function callSage<T = unknown>(
    method: string,
    params?: unknown,
): Promise<T> {
    if (window.parent === window) {
        throw new Error('Not running inside Sage host');
    }

    const id = makeId();

    return new Promise<T>((resolve, reject) => {
        const onMessage = (event: MessageEvent) => {
            if (!isBridgeResponse(event.data)) {
                return;
            }

            if (event.data.id !== id) {
                return;
            }

            window.removeEventListener('message', onMessage);

            if (event.data.ok) {
                resolve(event.data.result as T);
            } else {
                reject(new Error(event.data.error.message));
            }
        };

        window.addEventListener('message', onMessage);

        const request: SageBridgeRequest = {
            channel: 'sage-bridge',
            id,
            method,
            params,
        };

        window.parent.postMessage(request, '*');
    });
}
