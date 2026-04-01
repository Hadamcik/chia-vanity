use std::env;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
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
use chia_wallet_sdk::driver::StandardLayer;
use chia_wallet_sdk::utils::Address;
use chia_wallet_sdk::clvm_utils::ToTreeHash;

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

#[derive(Debug, Clone)]
struct Hit {
    index: u32,
    mode: &'static str,
    address: String,
}

fn master_sk_from_mnemonic(mnemonic_phrase: &str) -> Result<SecretKey> {
    let mnemonic = Mnemonic::parse(mnemonic_phrase)
        .context("invalid BIP39 mnemonic")?;

    // Chia master SK generation expects seed bytes; chia-bls supports SecretKey::from_seed.
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

fn candidate_for_index(master_sk: &SecretKey, index: u32, mode: Mode, prefix: &str) -> Result<Vec<Hit>> {
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

fn main() -> Result<()> {
    let args: Vec<String> = env::args().collect();

    if args.len() < 3 {
        eprintln!(
            "Usage:\n  {} '<mnemonic>' <wanted_prefix> [start_index] [chunk_size] [mode] [threads]",
            args[0]
        );
        eprintln!();
        eprintln!("Example:");
        eprintln!(
            "  {} 'your 24 words here' xch1place 0 200000 unhardened 0",
            args[0]
        );
        eprintln!();
        eprintln!("threads: 0 = auto");
        std::process::exit(1);
    }

    let mnemonic = &args[1];
    let wanted_prefix = args[2].to_lowercase();
    let mut next_start: u64 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(0);
    let chunk_size: u64 = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(200_000);
    let mode = Mode::parse(args.get(5).map(String::as_str).unwrap_or("unhardened"))?;
    let threads: usize = args.get(6).and_then(|s| s.parse().ok()).unwrap_or(0);

    if !(wanted_prefix.starts_with("xch1") || wanted_prefix.starts_with("txch1")) {
        bail!("wanted_prefix must start with xch1... or txch1...");
    }

    let hrp = if wanted_prefix.starts_with("txch1") {
        "txch"
    } else {
        "xch"
    };

    let master_sk = Arc::new(master_sk_from_mnemonic(mnemonic)?);

    let threads = if threads == 0 { num_cpus::get() } else { threads };
    rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
        .build_global()
        .ok();

    let checked = Arc::new(AtomicU64::new(0));
    let found = Arc::new(AtomicBool::new(false));
    let started = Instant::now();

    {
        let checked = Arc::clone(&checked);
        let found = Arc::clone(&found);
        thread::spawn(move || {
            let mut prev_count = 0_u64;
            let mut prev_time = Instant::now();

            while !found.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_secs(1));
                let now_count = checked.load(Ordering::Relaxed);
                let delta = now_count.saturating_sub(prev_count);
                let elapsed = prev_time.elapsed().as_secs_f64();
                let rate = if elapsed > 0.0 {
                    delta as f64 / elapsed
                } else {
                    0.0
                };

                eprintln!(
                    "checked={} rate={:.0}/s elapsed={:.1}s",
                    now_count,
                    rate,
                    started.elapsed().as_secs_f64()
                );

                prev_count = now_count;
                prev_time = Instant::now();
            }
        });
    }

    loop {
        let chunk_start = next_start;
        let chunk_end = chunk_start + chunk_size;

        let master_sk = Arc::clone(&master_sk);
        let checked = Arc::clone(&checked);
        let found = Arc::clone(&found);
        let wanted_prefix = wanted_prefix.clone();

        let hit = (chunk_start..chunk_end)
            .into_par_iter()
            .find_map_any(|i| {
                if found.load(Ordering::Relaxed) {
                    return None;
                }

                let index = match u32::try_from(i) {
                    Ok(v) => v,
                    Err(_) => return None,
                };

                let candidates = match candidate_for_index(&master_sk, index, mode, hrp) {
                    Ok(v) => v,
                    Err(_) => return None,
                };

                checked.fetch_add(candidates.len() as u64, Ordering::Relaxed);

                for candidate in candidates {
                    if candidate.address.to_lowercase().starts_with(&wanted_prefix) {
                        return Some(candidate);
                    }
                }

                None
            });

        if let Some(hit) = hit {
            found.store(true, Ordering::Relaxed);
            println!("MATCH FOUND");
            println!("index   : {}", hit.index);
            println!("mode    : {}", hit.mode);
            println!("address : {}", hit.address);
            println!("elapsed : {:.2}s", started.elapsed().as_secs_f64());
            return Ok(());
        }

        next_start = chunk_end;
    }
}
