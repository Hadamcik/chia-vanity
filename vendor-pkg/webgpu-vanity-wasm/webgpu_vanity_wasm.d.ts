/* tslint:disable */
/* eslint-disable */

export class WebGpuVanitySearch {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static create(account_public_key: Uint8Array): Promise<WebGpuVanitySearch>;
    deriveChildPublicKeys(start_index: number, count: number): Promise<Uint8Array>;
    derivePuzzleHashes(start_index: number, count: number): Promise<Uint8Array>;
    deriveSyntheticPublicKeys(start_index: number, count: number): Promise<Uint8Array>;
    searchBatch(start_index: number, count: number, address_prefix: string, wanted_prefix: string, wanted_suffix: string): Promise<any>;
    readonly adapterName: string;
    readonly batchCapacity: number;
}

export function runFixedBaseBenchmark(count: number, repetitions: number): Promise<any>;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_webgpuvanitysearch_free: (a: number, b: number) => void;
    readonly webgpuvanitysearch_adapterName: (a: number) => [number, number];
    readonly webgpuvanitysearch_batchCapacity: (a: number) => number;
    readonly webgpuvanitysearch_create: (a: number, b: number) => any;
    readonly webgpuvanitysearch_deriveChildPublicKeys: (a: number, b: number, c: number) => any;
    readonly webgpuvanitysearch_derivePuzzleHashes: (a: number, b: number, c: number) => any;
    readonly webgpuvanitysearch_deriveSyntheticPublicKeys: (a: number, b: number, c: number) => any;
    readonly webgpuvanitysearch_searchBatch: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => any;
    readonly runFixedBaseBenchmark: (a: number, b: number) => any;
    readonly wasm_bindgen_e54f6e71b3bf86da___convert__closures_____invoke___wasm_bindgen_e54f6e71b3bf86da___JsValue__core_f0fd674eaa06beef___result__Result_____wasm_bindgen_e54f6e71b3bf86da___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_e54f6e71b3bf86da___convert__closures_____invoke___js_sys_6dc4e045ed5c0733___Function_fn_wasm_bindgen_e54f6e71b3bf86da___JsValue_____wasm_bindgen_e54f6e71b3bf86da___sys__Undefined___js_sys_6dc4e045ed5c0733___Function_fn_wasm_bindgen_e54f6e71b3bf86da___JsValue_____wasm_bindgen_e54f6e71b3bf86da___sys__Undefined_______true_: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen_e54f6e71b3bf86da___convert__closures_____invoke___wasm_bindgen_e54f6e71b3bf86da___JsValue______true_: (a: number, b: number, c: any) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
