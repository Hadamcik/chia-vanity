use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc, Arc, Mutex,
};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use bip39::Mnemonic;
use rayon::prelude::*;

use chia_wallet_sdk::chia::bls::{
    master_to_wallet_hardened,
    master_to_wallet_unhardened,
    SecretKey,
};
use chia_wallet_sdk::chia::puzzle_types::DeriveSynthetic;
use chia_wallet_sdk::clvm_utils::ToTreeHash;
use chia_wallet_sdk::driver::StandardLayer;
use chia_wallet_sdk::utils::Address;

#[derive(Debug, Clone, Copy)]
enum Mode {
    Hardened,
    Unhardened,
    Both,
}

impl Mode {
    fn parse(s: &str) -> Result<Self> {
        match s {
            "hardened" => Ok(Self::Hardened),
            "unhardened" => Ok(Self::Unhardened),
            "both" => Ok(Self::Both),
            _ => bail!("mode must be one of: hardened | unhardened | both"),
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum SearchMode {
    Fast,
    Lowest,
}

impl SearchMode {
    fn parse(s: &str) -> Result<Self> {
        match s {
            "fast" => Ok(Self::Fast),
            "lowest" => Ok(Self::Lowest),
            _ => bail!("search_mode must be one of: fast | lowest"),
        }
    }
}

#[derive(Debug, Clone)]
struct Hit {
    index: u32,
    mode: &'static str,
    address: String,
}

#[derive(Debug)]
struct ChunkResult {
    start: u64,
    end: u64,
    best_hit: Option<Hit>,
}

fn master_sk_from_mnemonic(mnemonic_phrase: &str) -> Result<SecretKey> {
    let mnemonic = Mnemonic::parse(mnemonic_phrase).context("invalid BIP39 mnemonic")?;
    let seed = mnemonic.to_seed("");
    Ok(SecretKey::from_seed(&seed))
}

fn standard_address_for_child_sk(child_sk: &SecretKey, prefix: &str) -> Result<String> {
    let synthetic_pk = child_sk.public_key().derive_synthetic();
    let standard = StandardLayer::new(synthetic_pk);
    let puzzle_hash = standard.tree_hash();

    let address = Address::new(puzzle_hash.into(), prefix.to_string())
        .encode()
        .context("failed to encode bech32m address")?;

    Ok(address)
}

fn candidate_for_index(
    master_sk: &SecretKey,
    index: u32,
    mode: Mode,
    prefix: &str,
) -> Result<Vec<Hit>> {
    let mut out = Vec::with_capacity(2);

    match mode {
        Mode::Hardened => {
            let sk = master_to_wallet_hardened(master_sk, index);
            let addr = standard_address_for_child_sk(&sk, prefix)?;
            out.push(Hit {
                index,
                mode: "hardened",
                address: addr,
            });
        }
        Mode::Unhardened => {
            let sk = master_to_wallet_unhardened(master_sk, index);
            let addr = standard_address_for_child_sk(&sk, prefix)?;
            out.push(Hit {
                index,
                mode: "unhardened",
                address: addr,
            });
        }
        Mode::Both => {
            let sk_u = master_to_wallet_unhardened(master_sk, index);
            let addr_u = standard_address_for_child_sk(&sk_u, prefix)?;
            out.push(Hit {
                index,
                mode: "unhardened",
                address: addr_u,
            });

            let sk_h = master_to_wallet_hardened(master_sk, index);
            let addr_h = standard_address_for_child_sk(&sk_h, prefix)?;
            out.push(Hit {
                index,
                mode: "hardened",
                address: addr_h,
            });
        }
    }

    Ok(out)
}

fn process_chunk(
    master_sk: &SecretKey,
    start: u64,
    end: u64,
    mode: Mode,
    hrp: &str,
    wanted_prefix: &str,
    checked: &AtomicU64,
) -> ChunkResult {
    for i in start..end {
        let index = match u32::try_from(i) {
            Ok(v) => v,
            Err(_) => break,
        };

        let candidates = match candidate_for_index(master_sk, index, mode, hrp) {
            Ok(v) => v,
            Err(_) => continue,
        };

        checked.fetch_add(candidates.len() as u64, Ordering::Relaxed);

        for candidate in candidates {
            if candidate.address.to_lowercase().starts_with(wanted_prefix) {
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

fn run_fast_search(
    master_sk: Arc<SecretKey>,
    wanted_prefix: String,
    hrp: String,
    mode: Mode,
    start_index: u64,
    threads: usize,
) -> Result<Option<Hit>> {
    let checked = Arc::new(AtomicU64::new(0));
    let found = Arc::new(AtomicBool::new(false));
    let started = Instant::now();

    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(threads.max(1))
        .build()
        .context("failed to build rayon thread pool")?;

    {
        let checked = Arc::clone(&checked);
        let found = Arc::clone(&found);
        thread::spawn(move || {
            let mut last = 0_u64;
            let mut last_t = Instant::now();

            while !found.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_secs(1));
                let now = checked.load(Ordering::Relaxed);
                let delta = now.saturating_sub(last);
                let elapsed = last_t.elapsed().as_secs_f64();
                let rate = if elapsed > 0.0 { delta as f64 / elapsed } else { 0.0 };

                eprintln!(
                    "checked={} rate={:.0}/s elapsed={:.1}s",
                    now,
                    rate,
                    started.elapsed().as_secs_f64()
                );

                last = now;
                last_t = Instant::now();
            }
        });
    }

    let hit = pool.install(|| {
        (start_index..u32::MAX as u64 + 1)
            .into_par_iter()
            .find_map_any(|i| {
                let index = u32::try_from(i).ok()?;
                let candidates = candidate_for_index(&master_sk, index, mode, &hrp).ok()?;

                checked.fetch_add(candidates.len() as u64, Ordering::Relaxed);

                for candidate in candidates {
                    if candidate.address.to_lowercase().starts_with(&wanted_prefix) {
                        return Some(candidate);
                    }
                }

                None
            })
    });

    found.store(true, Ordering::Relaxed);
    Ok(hit)
}

fn run_lowest_search(
    master_sk: Arc<SecretKey>,
    wanted_prefix: String,
    hrp: String,
    mode: Mode,
    start_index: u64,
    chunk_size: u64,
    worker_count: usize,
) -> Option<Hit> {
    let checked = Arc::new(AtomicU64::new(0));
    let stop_hint = Arc::new(AtomicBool::new(false));

    let (job_tx, job_rx) = mpsc::channel::<(u64, u64)>();
    let (result_tx, result_rx) = mpsc::channel::<ChunkResult>();

    let job_rx = Arc::new(Mutex::new(job_rx));

    for _ in 0..worker_count {
        let job_rx = Arc::clone(&job_rx);
        let result_tx = result_tx.clone();
        let master_sk = Arc::clone(&master_sk);
        let checked = Arc::clone(&checked);
        let wanted_prefix = wanted_prefix.clone();
        let hrp = hrp.clone();

        thread::spawn(move || {
            loop {
                let job = {
                    let rx = job_rx.lock().unwrap();
                    rx.recv()
                };

                let (start, end) = match job {
                    Ok(v) => v,
                    Err(_) => break,
                };

                let result = process_chunk(
                    &master_sk,
                    start,
                    end,
                    mode,
                    &hrp,
                    &wanted_prefix,
                    &checked,
                );

                if result_tx.send(result).is_err() {
                    break;
                }
            }
        });
    }

    let started = Instant::now();
    {
        let checked = Arc::clone(&checked);
        let stop_hint = Arc::clone(&stop_hint);
        thread::spawn(move || {
            let mut last = 0_u64;
            let mut last_t = Instant::now();

            while !stop_hint.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_secs(1));
                let now = checked.load(Ordering::Relaxed);
                let delta = now.saturating_sub(last);
                let elapsed = last_t.elapsed().as_secs_f64();
                let rate = if elapsed > 0.0 { delta as f64 / elapsed } else { 0.0 };

                eprintln!(
                    "checked={} rate={:.0}/s elapsed={:.1}s",
                    now,
                    rate,
                    started.elapsed().as_secs_f64()
                );

                last = now;
                last_t = Instant::now();
            }
        });
    }

    let inflight_target = worker_count * 4;
    let mut next_chunk_start = start_index;

    let mut inflight: BTreeSet<u64> = BTreeSet::new();
    let mut completed_chunks: BTreeMap<u64, ChunkResult> = BTreeMap::new();

    let mut completed_until = start_index;
    let mut best_candidate: Option<Hit> = None;

    loop {
        while inflight.len() < inflight_target {
            if let Some(candidate) = &best_candidate {
                if next_chunk_start > candidate.index as u64 {
                    break;
                }
            }

            let start = next_chunk_start;
            let end = start + chunk_size;

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
                stop_hint.store(true, Ordering::Relaxed);
                return best_candidate;
            }
        }

        if inflight.is_empty() && best_candidate.is_none() {
            while inflight.len() < inflight_target {
                let start = next_chunk_start;
                let end = start + chunk_size;

                if job_tx.send((start, end)).is_err() {
                    break;
                }

                inflight.insert(start);
                next_chunk_start = end;
            }
        }
    }

    stop_hint.store(true, Ordering::Relaxed);
    None
}

fn main() -> Result<()> {
    let args: Vec<String> = env::args().collect();

    if args.len() < 3 {
        eprintln!(
            "Usage:\n  {} '<mnemonic>' <wanted_prefix> [start_index] [chunk_size] [mode] [threads] [search_mode]",
            args[0]
        );
        eprintln!();
        eprintln!("Example fast:");
        eprintln!(
            "  {} 'your 24 words here' xch1name 0 10000 unhardened 0 fast",
            args[0]
        );
        eprintln!();
        eprintln!("Example lowest:");
        eprintln!(
            "  {} 'your 24 words here' xch1name 0 10000 unhardened 0 lowest",
            args[0]
        );
        std::process::exit(1);
    }

    let mnemonic = &args[1];
    let wanted_prefix = args[2].to_lowercase();
    let start_index: u64 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(0);
    let chunk_size: u64 = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(10_000);
    let mode = Mode::parse(args.get(5).map(String::as_str).unwrap_or("unhardened"))?;
    let threads: usize = args.get(6).and_then(|s| s.parse().ok()).unwrap_or(0);
    let search_mode = SearchMode::parse(args.get(7).map(String::as_str).unwrap_or("fast"))?;

    if !(wanted_prefix.starts_with("xch1") || wanted_prefix.starts_with("txch1")) {
        bail!("wanted_prefix must start with xch1... or txch1...");
    }

    let hrp = if wanted_prefix.starts_with("txch1") {
        "txch".to_string()
    } else {
        "xch".to_string()
    };

    let worker_count = if threads == 0 {
        std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1)
    } else {
        threads.max(1)
    };

    let master_sk = Arc::new(master_sk_from_mnemonic(mnemonic)?);

    eprintln!(
        "starting search: prefix={} start_index={} chunk_size={} mode={:?} workers={} search_mode={:?}",
        wanted_prefix, start_index, chunk_size, mode, worker_count, search_mode
    );

    let hit = match search_mode {
        SearchMode::Fast => run_fast_search(
            Arc::clone(&master_sk),
            wanted_prefix,
            hrp,
            mode,
            start_index,
            worker_count,
        )?,
        SearchMode::Lowest => run_lowest_search(
            Arc::clone(&master_sk),
            wanted_prefix,
            hrp,
            mode,
            start_index,
            chunk_size,
            worker_count,
        ),
    };

    match hit {
        Some(hit) => {
            println!("MATCH FOUND");
            println!("index   : {}", hit.index);
            println!("mode    : {}", hit.mode);
            println!("address : {}", hit.address);
        }
        None => {
            println!("No match found");
        }
    }

    Ok(())
}
