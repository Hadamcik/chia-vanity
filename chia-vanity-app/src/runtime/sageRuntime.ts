import type {
    SearchCompletedPayload,
    SearchFailedPayload,
    SearchProgressPayload,
    SearchStatePayload,
    VanityRuntime,
} from './types';

type BridgeRequest = {
    channel: 'sage-bridge';
    id: string;
    method: string;
    params?: unknown;
};

type BridgeSuccess = {
    channel: 'sage-bridge';
    id: string;
    ok: true;
    result: unknown;
};

type BridgeFailure = {
    channel: 'sage-bridge';
    id: string;
    ok: false;
    error: {
        code: string;
        message: string;
    };
};

function randomId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function callBridge<T>(method: string, params?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
        const id = randomId();

        function onMessage(event: MessageEvent) {
            const data = event.data as BridgeSuccess | BridgeFailure | undefined;
            if (!data || data.channel !== 'sage-bridge' || data.id !== id) {
                return;
            }

            window.removeEventListener('message', onMessage);

            if (data.ok) {
                resolve(data.result as T);
            } else {
                reject(new Error(data.error.message));
            }
        }

        window.addEventListener('message', onMessage);

        const request: BridgeRequest = {
            channel: 'sage-bridge',
            id,
            method,
            params,
        };

        window.parent.postMessage(request, '*');
    });
}

function subscribeEvent<T>(
    eventName: string,
    cb: (payload: T) => void,
): Promise<() => void> {
    function handler(event: MessageEvent) {
        const data = event.data as
            | { channel: 'sage-bridge-event'; event: string; payload: T }
            | undefined;

        if (!data || data.channel !== 'sage-bridge-event' || data.event !== eventName) {
            return;
        }

        cb(data.payload);
    }

    window.addEventListener('message', handler);
    return Promise.resolve(() => {
        window.removeEventListener('message', handler);
    });
}

export const sageRuntime: VanityRuntime = {
    async startSearch(req) {
        await callBridge('vanity.startSearch', req);
    },

    async stopSearch() {
        await callBridge('vanity.stopSearch');
    },

    async getSearchState() {
        return callBridge<SearchStatePayload>('vanity.getSearchState');
    },

    async onSearchProgress(cb) {
        return subscribeEvent<SearchProgressPayload>('vanity.searchProgress', cb);
    },

    async onSearchCompleted(cb) {
        return subscribeEvent<SearchCompletedPayload>('vanity.searchCompleted', cb);
    },

    async onSearchFailed(cb) {
        return subscribeEvent<SearchFailedPayload>('vanity.searchFailed', cb);
    },

    async onSearchState(cb) {
        return subscribeEvent<SearchStatePayload>('vanity.searchState', cb);
    },
};
