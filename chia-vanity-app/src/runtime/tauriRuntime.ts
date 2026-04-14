import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
    SearchCompletedPayload,
    SearchFailedPayload,
    SearchProgressPayload,
    SearchStatePayload,
    StartSearchRequest,
    VanityRuntime,
} from './types';

export const tauriRuntime: VanityRuntime = {
    async startSearch(req: StartSearchRequest) {
        await invoke('start_search', { req });
    },

    async stopSearch() {
        await invoke('stop_search');
    },

    async getSearchState() {
        return invoke<SearchStatePayload>('get_search_state');
    },

    async onSearchProgress(cb) {
        return listen<SearchProgressPayload>('search-progress', (event) => {
            cb(event.payload);
        });
    },

    async onSearchCompleted(cb) {
        return listen<SearchCompletedPayload>('search-completed', (event) => {
            cb(event.payload);
        });
    },

    async onSearchFailed(cb) {
        return listen<SearchFailedPayload>('search-failed', (event) => {
            cb(event.payload);
        });
    },

    async onSearchState(cb) {
        return listen<SearchStatePayload>('search-state', (event) => {
            cb(event.payload);
        });
    },
};
