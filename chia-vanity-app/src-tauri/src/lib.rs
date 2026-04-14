use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;

use chia_vanity::search::run_search;
use chia_vanity::types::{HitMode, Mode, SearchMode, SearchRequest};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
struct SearchController {
    running: Mutex<Option<Arc<AtomicBool>>>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartSearchRequest {
    mnemonic: String,
    wanted_prefix: String,
    start_index: u64,
    chunk_size: u64,
    mode: String,
    worker_count: usize,
    search_mode: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SearchProgressPayload {
    checked: u64,
    rate_per_sec: f64,
    elapsed_secs: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SearchHitPayload {
    index: u32,
    mode: String,
    address: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SearchCompletedPayload {
    hit: Option<SearchHitPayload>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SearchFailedPayload {
    message: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SearchStatePayload {
    running: bool,
}

fn parse_mode(value: &str) -> Result<Mode, String> {
    Mode::parse(value).map_err(|err| err.to_string())
}

fn parse_search_mode(value: &str) -> Result<SearchMode, String> {
    SearchMode::parse(value).map_err(|err| err.to_string())
}

fn to_hit_payload(hit: chia_vanity::types::Hit) -> SearchHitPayload {
    let mode = match hit.mode {
        HitMode::Hardened => "hardened",
        HitMode::Unhardened => "unhardened",
    }
        .to_string();

    SearchHitPayload {
        index: hit.index,
        mode,
        address: hit.address,
    }
}

fn set_running_flag(
    state: &State<'_, SearchController>,
    value: Option<Arc<AtomicBool>>,
) -> Result<(), String> {
    let mut guard = state
        .running
        .lock()
        .map_err(|_| "failed to lock search state".to_string())?;
    *guard = value;
    Ok(())
}

#[tauri::command]
fn start_search(
    app: AppHandle,
    state: State<'_, SearchController>,
    req: StartSearchRequest,
) -> Result<(), String> {
    {
        let guard = state
            .running
            .lock()
            .map_err(|_| "failed to lock search state".to_string())?;

        if guard.is_some() {
            return Err("search is already running".to_string());
        }
    }

    let mode = parse_mode(&req.mode)?;
    let search_mode = parse_search_mode(&req.search_mode)?;

    let should_stop = Arc::new(AtomicBool::new(false));
    set_running_flag(&state, Some(Arc::clone(&should_stop)))?;

    app.emit(
        "search-state",
        SearchStatePayload { running: true },
    )
        .map_err(|err| err.to_string())?;

    let app_handle = app.clone();

    thread::spawn(move || {
        let request = SearchRequest {
            mnemonic: req.mnemonic,
            wanted_prefix: req.wanted_prefix,
            start_index: req.start_index,
            chunk_size: req.chunk_size,
            mode,
            worker_count: req.worker_count.max(1),
            search_mode,
        };

        let result = run_search(request, Arc::clone(&should_stop), {
            let app = app_handle.clone();
            move |progress| {
                let _ = app.emit(
                    "search-progress",
                    SearchProgressPayload {
                        checked: progress.checked,
                        rate_per_sec: progress.rate_per_sec,
                        elapsed_secs: progress.elapsed_secs,
                    },
                );
            }
        });

        match result {
            Ok(result) => {
                let payload = SearchCompletedPayload {
                    hit: result.hit.map(to_hit_payload),
                };
                let _ = app_handle.emit("search-completed", payload);
            }
            Err(err) => {
                let _ = app_handle.emit(
                    "search-failed",
                    SearchFailedPayload {
                        message: err.to_string(),
                    },
                );
            }
        }

        let state = app_handle.state::<SearchController>();
        let _ = set_running_flag(&state, None);
        let _ = app_handle.emit(
            "search-state",
            SearchStatePayload { running: false },
        );
    });

    Ok(())
}

#[tauri::command]
fn stop_search(state: State<'_, SearchController>) -> Result<(), String> {
    let guard = state
        .running
        .lock()
        .map_err(|_| "failed to lock search state".to_string())?;

    if let Some(flag) = guard.as_ref() {
        flag.store(true, Ordering::Relaxed);
    }

    Ok(())
}

#[tauri::command]
fn get_search_state(state: State<'_, SearchController>) -> Result<SearchStatePayload, String> {
    let guard = state
        .running
        .lock()
        .map_err(|_| "failed to lock search state".to_string())?;

    Ok(SearchStatePayload {
        running: guard.is_some(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SearchController::default())
        .invoke_handler(tauri::generate_handler![
            start_search,
            stop_search,
            get_search_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
