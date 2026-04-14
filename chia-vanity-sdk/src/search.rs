#[cfg(not(target_arch = "wasm32"))]
use std::collections::{BTreeMap, BTreeSet};

use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};

#[cfg(not(target_arch = "wasm32"))]
use std::sync::{mpsc, Mutex};

use anyhow::{bail, Context, Result};
use rayon::prelude::*;

use crate::types::{
    ChunkResult, Hit, Mode, SearchMode, SearchProgress, SearchRequest, SearchResult,
};

type CandidateGenerator = dyn Fn(u32, Mode, &str) -> Result<Vec<Hit>> + Send + Sync + 'static;

struct SearchShared {
    checked: Arc<AtomicU64>,
    should_stop: Arc<AtomicBool>,
}

struct SearchConfig {
    wanted_prefix: String,
    hrp: String,
    mode: Mode,
    generator: Arc<CandidateGenerator>,
}

struct FastSearchContext<F>
where
    F: Fn(SearchProgress) + Send + Sync + 'static,
{
    shared: SearchShared,
    config: SearchConfig,
    start_index: u64,
    threads: usize,
    progress: Arc<F>,
}

#[cfg(not(target_arch = "wasm32"))]
struct LowestSearchContext<F>
where
    F: Fn(SearchProgress) + Send + Sync + 'static,
{
    shared: SearchShared,
    config: SearchConfig,
    start_index: u64,
    chunk_size: u64,
    worker_count: usize,
    progress: Arc<F>,
}

fn address_matches(candidate_address: &str, wanted_prefix: &str) -> bool {
    if candidate_address.len() < wanted_prefix.len() {
        return false;
    }

    candidate_address[..wanted_prefix.len()].eq_ignore_ascii_case(wanted_prefix)
}

#[cfg(not(target_arch = "wasm32"))]
fn process_chunk(
    start: u64,
    end: u64,
    config: &SearchConfig,
    shared: &SearchShared,
) -> ChunkResult {
    for i in start..end {
        if shared.should_stop.load(Ordering::Relaxed) {
            break;
        }

        let index = match u32::try_from(i) {
            Ok(v) => v,
            Err(_) => break,
        };

        let candidates = match (config.generator)(index, config.mode, &config.hrp) {
            Ok(v) => v,
            Err(_) => continue,
        };

        shared
            .checked
            .fetch_add(candidates.len() as u64, Ordering::Relaxed);

        for candidate in candidates {
            if address_matches(&candidate.address, &config.wanted_prefix) {
                return ChunkResult {
                    start,
                    end,
                    best_hit: Some(candidate),
                };
            }
        }
    }

    ChunkResult {
        start,
        end,
        best_hit: None,
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn start_progress_reporter<F>(
    checked: Arc<AtomicU64>,
    should_stop: Arc<AtomicBool>,
    progress: Arc<F>,
) -> Option<std::thread::JoinHandle<()>>
where
    F: Fn(SearchProgress) + Send + Sync + 'static,
{
    Some(std::thread::spawn(move || {
        let started = std::time::Instant::now();
        let mut last = 0_u64;
        let mut last_t = std::time::Instant::now();

        while !should_stop.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_secs(1));

            let now = checked.load(Ordering::Relaxed);
            let delta = now.saturating_sub(last);
            let elapsed = last_t.elapsed().as_secs_f64();
            let rate = if elapsed > 0.0 {
                delta as f64 / elapsed
            } else {
                0.0
            };

            progress(SearchProgress {
                checked: now,
                rate_per_sec: rate,
                elapsed_secs: started.elapsed().as_secs_f64(),
            });

            last = now;
            last_t = std::time::Instant::now();
        }
    }))
}

#[cfg(target_arch = "wasm32")]
fn start_progress_reporter<F>(
    _checked: Arc<AtomicU64>,
    _should_stop: Arc<AtomicBool>,
    _progress: Arc<F>,
) -> Option<()>
where
    F: Fn(SearchProgress) + Send + Sync + 'static,
{
    None
}

#[cfg(not(target_arch = "wasm32"))]
fn join_progress_reporter(handle: Option<std::thread::JoinHandle<()>>) {
    if let Some(handle) = handle {
        let _ = handle.join();
    }
}

#[cfg(target_arch = "wasm32")]
fn join_progress_reporter(_handle: Option<()>) {}

enum FastSearchOutcome {
    Hit(Hit),
    Stopped,
}

fn run_fast_search<F>(ctx: FastSearchContext<F>) -> Result<Option<Hit>>
where
    F: Fn(SearchProgress) + Send + Sync + 'static,
{
    let reporter = start_progress_reporter(
        Arc::clone(&ctx.shared.checked),
        Arc::clone(&ctx.shared.should_stop),
        Arc::clone(&ctx.progress),
    );

    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(ctx.threads.max(1))
        .build()
        .context("failed to build rayon thread pool")?;

    let outcome = pool.install(|| {
        (ctx.start_index..=(u32::MAX as u64))
            .into_par_iter()
            .find_map_any(|i| {
                if ctx.shared.should_stop.load(Ordering::Relaxed) {
                    return Some(FastSearchOutcome::Stopped);
                }

                let index = u32::try_from(i).ok()?;
                let candidates =
                    (ctx.config.generator)(index, ctx.config.mode, &ctx.config.hrp).ok()?;

                ctx.shared
                    .checked
                    .fetch_add(candidates.len() as u64, Ordering::Relaxed);

                candidates
                    .into_iter()
                    .find(|candidate| {
                        address_matches(&candidate.address, &ctx.config.wanted_prefix)
                    })
                    .map(FastSearchOutcome::Hit)
            })
    });

    ctx.shared.should_stop.store(true, Ordering::Relaxed);
    join_progress_reporter(reporter);

    let hit = match outcome {
        Some(FastSearchOutcome::Hit(hit)) => Some(hit),
        Some(FastSearchOutcome::Stopped) | None => None,
    };

    Ok(hit)
}

#[cfg(not(target_arch = "wasm32"))]
fn run_lowest_search<F>(ctx: LowestSearchContext<F>) -> Option<Hit>
where
    F: Fn(SearchProgress) + Send + Sync + 'static,
{
    let (job_tx, job_rx) = mpsc::channel::<(u64, u64)>();
    let (result_tx, result_rx) = mpsc::channel::<ChunkResult>();

    let job_rx = Arc::new(Mutex::new(job_rx));

    let reporter = start_progress_reporter(
        Arc::clone(&ctx.shared.checked),
        Arc::clone(&ctx.shared.should_stop),
        Arc::clone(&ctx.progress),
    );

    for _ in 0..ctx.worker_count.max(1) {
        let job_rx = Arc::clone(&job_rx);
        let result_tx = result_tx.clone();
        let checked = Arc::clone(&ctx.shared.checked);
        let should_stop = Arc::clone(&ctx.shared.should_stop);
        let wanted_prefix = ctx.config.wanted_prefix.clone();
        let hrp = ctx.config.hrp.clone();
        let mode = ctx.config.mode;
        let generator = Arc::clone(&ctx.config.generator);

        std::thread::spawn(move || {
            let shared = SearchShared {
                checked,
                should_stop,
            };

            let config = SearchConfig {
                wanted_prefix,
                hrp,
                mode,
                generator,
            };

            loop {
                if shared.should_stop.load(Ordering::Relaxed) {
                    break;
                }

                let job = {
                    let rx = job_rx.lock().unwrap();
                    rx.recv()
                };

                let (start, end) = match job {
                    Ok(v) => v,
                    Err(_) => break,
                };

                let result = process_chunk(start, end, &config, &shared);

                if result_tx.send(result).is_err() {
                    break;
                }
            }
        });
    }

    let inflight_target = ctx.worker_count.max(1) * 4;
    let mut next_chunk_start = ctx.start_index;

    let mut inflight: BTreeSet<u64> = BTreeSet::new();
    let mut completed_chunks: BTreeMap<u64, ChunkResult> = BTreeMap::new();

    let mut completed_until = ctx.start_index;
    let mut best_candidate: Option<Hit> = None;

    loop {
        if ctx.shared.should_stop.load(Ordering::Relaxed) {
            ctx.shared.should_stop.store(true, Ordering::Relaxed);
            join_progress_reporter(reporter);
            return best_candidate;
        }

        while inflight.len() < inflight_target {
            if let Some(candidate) = &best_candidate {
                if next_chunk_start > candidate.index as u64 {
                    break;
                }
            }

            let start = next_chunk_start;
            let end = start.saturating_add(ctx.chunk_size);

            if job_tx.send((start, end)).is_err() {
                break;
            }

            inflight.insert(start);
            next_chunk_start = end;
        }

        let result = match result_rx.recv() {
            Ok(r) => r,
            Err(_) => break,
        };

        inflight.remove(&result.start);

        if let Some(hit) = &result.best_hit {
            match &best_candidate {
                Some(existing) if existing.index <= hit.index => {}
                _ => best_candidate = Some(hit.clone()),
            }
        }

        completed_chunks.insert(result.start, result);

        while let Some(chunk) = completed_chunks.remove(&completed_until) {
            completed_until = chunk.end;
        }

        if let Some(candidate) = &best_candidate {
            if completed_until > candidate.index as u64 {
                ctx.shared.should_stop.store(true, Ordering::Relaxed);
                join_progress_reporter(reporter);
                return best_candidate;
            }
        }

        if inflight.is_empty() && best_candidate.is_none() {
            while inflight.len() < inflight_target {
                let start = next_chunk_start;
                let end = start.saturating_add(ctx.chunk_size);

                if job_tx.send((start, end)).is_err() {
                    break;
                }

                inflight.insert(start);
                next_chunk_start = end;
            }
        }
    }

    ctx.shared.should_stop.store(true, Ordering::Relaxed);
    join_progress_reporter(reporter);
    None
}

pub fn run_search_with_generator<F, G>(
    request: SearchRequest,
    should_stop: Arc<AtomicBool>,
    progress: F,
    generator: G,
) -> Result<SearchResult>
where
    F: Fn(SearchProgress) + Send + Sync + 'static,
    G: Fn(u32, Mode, &str) -> Result<Vec<Hit>> + Send + Sync + 'static,
{
    let wanted_prefix = request.wanted_prefix.to_lowercase();

    if !(wanted_prefix.starts_with("xch1") || wanted_prefix.starts_with("txch1")) {
        bail!("wanted_prefix must start with xch1... or txch1...");
    }

    let hrp = if wanted_prefix.starts_with("txch1") {
        "txch".to_string()
    } else {
        "xch".to_string()
    };

    let worker_count = request.worker_count.max(1);
    let progress = Arc::new(progress);

    let shared = SearchShared {
        checked: Arc::new(AtomicU64::new(0)),
        should_stop,
    };

    let config = SearchConfig {
        wanted_prefix,
        hrp,
        mode: request.mode,
        generator: Arc::new(generator),
    };

    let hit = match request.search_mode {
        SearchMode::Fast => {
            let ctx = FastSearchContext {
                shared,
                config,
                start_index: request.start_index,
                threads: worker_count,
                progress,
            };

            run_fast_search(ctx)?
        }
        SearchMode::Lowest => {
            #[cfg(target_arch = "wasm32")]
            {
                bail!("lowest search mode is not implemented for wasm yet");
            }

            #[cfg(not(target_arch = "wasm32"))]
            {
                let ctx = LowestSearchContext {
                    shared,
                    config,
                    start_index: request.start_index,
                    chunk_size: request.chunk_size,
                    worker_count,
                    progress,
                };

                run_lowest_search(ctx)
            }
        }
    };

    Ok(SearchResult { hit })
}
