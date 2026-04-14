use std::sync::{
    atomic::AtomicBool,
    Arc,
};

use chia_vanity::search::run_search_with_generator;
use chia_vanity::types::{Hit, Mode, SearchMode, SearchRequest, SearchResult};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

pub use wasm_bindgen_rayon::init_thread_pool;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WasmStartSearchRequest {
    pub mnemonic: String,
    pub wanted_prefix: String,
    pub start_index: u64,
    pub chunk_size: u64,
    pub mode: String,
    pub worker_count: usize,
    pub search_mode: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WasmSearchHitPayload {
    pub index: u32,
    pub mode: String,
    pub address: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WasmSearchCompletedPayload {
    pub hit: Option<WasmSearchHitPayload>,
}

fn parse_mode(value: &str) -> Result<Mode, String> {
    Mode::parse(value).map_err(|err| err.to_string())
}

fn parse_search_mode(value: &str) -> Result<SearchMode, String> {
    SearchMode::parse(value).map_err(|err| err.to_string())
}

fn to_hit_payload(hit: Hit) -> WasmSearchHitPayload {
    WasmSearchHitPayload {
        index: hit.index,
        mode: hit.mode.as_str().to_string(),
        address: hit.address,
    }
}

fn to_completed_payload(result: SearchResult) -> WasmSearchCompletedPayload {
    WasmSearchCompletedPayload {
        hit: result.hit.map(to_hit_payload),
    }
}

#[wasm_bindgen]
pub fn run_search_once(req: JsValue) -> Result<JsValue, JsValue> {
    let req: WasmStartSearchRequest =
        serde_wasm_bindgen::from_value(req).map_err(|err| JsValue::from_str(&err.to_string()))?;

    let mode = parse_mode(&req.mode).map_err(|err| JsValue::from_str(&err))?;
    let search_mode =
        parse_search_mode(&req.search_mode).map_err(|err| JsValue::from_str(&err))?;

    let should_stop = Arc::new(AtomicBool::new(false));

    let request = SearchRequest {
        mnemonic: req.mnemonic,
        wanted_prefix: req.wanted_prefix,
        start_index: req.start_index,
        chunk_size: req.chunk_size,
        mode,
        worker_count: req.worker_count.max(1),
        search_mode,
    };

    let result = run_search_with_generator(
        request,
        Arc::clone(&should_stop),
        |_progress| {},
        |_index, _mode, _hrp| Ok(Vec::new()),
    )
        .map_err(|err| JsValue::from_str(&err.to_string()))?;

    serde_wasm_bindgen::to_value(&to_completed_payload(result))
        .map_err(|err| JsValue::from_str(&err.to_string()))
}
