use std::{
    cmp::Ordering,
    str::FromStr,
    sync::{
        atomic::{AtomicBool, Ordering as AtomicOrdering},
        mpsc, Arc,
    },
    thread,
};

use anyhow::{anyhow, bail, Context, Result};
use bip39::Mnemonic;
use chia_bls::{DerivableKey, SecretKey};
use chia_puzzle_types::{standard::StandardArgs, DeriveSynthetic};
use chia_sdk_types::Mod;
use chia_sdk_utils::Address;
use clap::{Parser, ValueEnum};

const CHIA_PURPOSE: u32 = 12381;
const CHIA_COIN_TYPE: u32 = 8444;
const CHIA_ACCOUNT: u32 = 2;
const BECH32_DATA_CHARS: &str = "023456789acdefghjklmnpqrstuvwxyz";
const CHIA_ADDRESS_PREFIXES: [&str; 2] = ["xch1", "txch1"];

#[derive(Debug, Parser)]
#[command(
    author,
    version,
    about = "Find Chia receive addresses matching a prefix and/or suffix."
)]
struct Cli {
    /// The wallet mnemonic phrase.
    mnemonic: String,

    /// Wanted address prefix. Supports full Chia wrappers like xch1ace or txch1ace.
    #[arg(long, short = 'p')]
    prefix: Option<String>,

    /// Wanted address suffix.
    #[arg(long, short = 's')]
    suffix: Option<String>,

    /// Address prefix used for encoding when it cannot be inferred from --prefix.
    #[arg(long = "address-prefix", default_value = "xch")]
    address_prefix: String,

    /// First derivation index to check.
    #[arg(long, default_value_t = 0)]
    start_index: u32,

    /// Derivation mode to search.
    #[arg(long, value_enum, default_value_t = Mode::Unhardened)]
    mode: Mode,

    /// Search mode. fast returns the first match found; lowest guarantees the lowest index.
    #[arg(long = "search-mode", value_enum, default_value_t = SearchMode::Fast)]
    search_mode: SearchMode,

    /// Number of worker threads. Use 0 to auto-detect.
    #[arg(long, short = 't', default_value_t = 0)]
    threads: usize,

    /// Chunk size for lowest-index search coordination.
    #[arg(long, default_value_t = 10_000)]
    chunk_size: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum Mode {
    Hardened,
    Unhardened,
    Both,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum SearchMode {
    Fast,
    Lowest,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CandidateMode {
    Hardened,
    Unhardened,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SearchHit {
    index: u32,
    mode: CandidateMode,
    address: String,
}

#[derive(Clone, Debug)]
struct SearchConfig {
    wanted_prefix: String,
    wanted_suffix: String,
    address_prefix: String,
    start_index: u32,
    mode: Mode,
    threads: usize,
    chunk_size: u32,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let config = SearchConfig::from_cli(&cli)?;
    let wallet_root = Arc::new(wallet_root_from_mnemonic(&cli.mnemonic)?);

    eprintln!(
        "Searching {} addresses from index {} with {} thread(s)...",
        mode_label(config.mode),
        config.start_index,
        config.threads
    );

    let hit = match cli.search_mode {
        SearchMode::Fast => search_fast(wallet_root, &config)?,
        SearchMode::Lowest => search_lowest(wallet_root, &config)?,
    };

    match hit {
        Some(hit) => {
            println!("MATCH FOUND");
            println!("index   : {}", hit.index);
            println!("mode    : {}", candidate_mode_label(hit.mode));
            println!("address : {}", hit.address);
        }
        None => {
            println!("NO MATCH FOUND");
        }
    }

    Ok(())
}

impl SearchConfig {
    fn from_cli(cli: &Cli) -> Result<Self> {
        let wanted_prefix = cli
            .prefix
            .as_deref()
            .map(str::trim)
            .unwrap_or_default()
            .to_lowercase();
        let wanted_suffix = cli
            .suffix
            .as_deref()
            .map(str::trim)
            .unwrap_or_default()
            .to_lowercase();

        validate_wanted_prefix(&wanted_prefix)?;
        validate_wanted_suffix(&wanted_suffix)?;

        if wanted_prefix.is_empty() && wanted_suffix.is_empty() {
            bail!("prefix or suffix is required");
        }

        let address_prefix = infer_address_prefix(&wanted_prefix, &cli.address_prefix)?;
        let threads = if cli.threads == 0 {
            thread::available_parallelism()
                .map(usize::from)
                .unwrap_or(1)
        } else {
            cli.threads
        };

        if threads == 0 {
            bail!("thread count must be greater than zero");
        }

        if cli.chunk_size == 0 {
            bail!("chunk size must be greater than zero");
        }

        Ok(Self {
            wanted_prefix,
            wanted_suffix,
            address_prefix,
            start_index: cli.start_index,
            mode: cli.mode,
            threads,
            chunk_size: cli.chunk_size,
        })
    }
}

fn wallet_root_from_mnemonic(mnemonic_phrase: &str) -> Result<SecretKey> {
    let mnemonic = Mnemonic::from_str(mnemonic_phrase).context("invalid mnemonic")?;
    let seed = mnemonic.to_seed("");
    let master_sk = SecretKey::from_seed(&seed);

    Ok(master_sk
        .derive_hardened(CHIA_PURPOSE)
        .derive_hardened(CHIA_COIN_TYPE)
        .derive_hardened(CHIA_ACCOUNT))
}

fn search_fast(wallet_root: Arc<SecretKey>, config: &SearchConfig) -> Result<Option<SearchHit>> {
    let stop = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::channel();
    let mut handles = Vec::with_capacity(config.threads);

    for worker_id in 0..config.threads {
        let start_index = match config.start_index.checked_add(worker_id as u32) {
            Some(index) => index,
            None => continue,
        };
        let wallet_root = Arc::clone(&wallet_root);
        let stop = Arc::clone(&stop);
        let tx = tx.clone();
        let config = config.clone();

        handles.push(thread::spawn(move || {
            let mut index = start_index;

            loop {
                if stop.load(AtomicOrdering::Relaxed) {
                    break;
                }

                if let Some(hit) = find_hit_at_index(&wallet_root, index, &config) {
                    stop.store(true, AtomicOrdering::Relaxed);
                    let _ = tx.send(hit);
                    break;
                }

                let Some(next_index) = index.checked_add(config.threads as u32) else {
                    break;
                };
                index = next_index;
            }
        }));
    }

    drop(tx);
    let hit = rx.recv().ok();

    for handle in handles {
        handle
            .join()
            .map_err(|_| anyhow!("search worker panicked"))?;
    }

    Ok(hit)
}

fn search_lowest(wallet_root: Arc<SecretKey>, config: &SearchConfig) -> Result<Option<SearchHit>> {
    let mut chunk_start = config.start_index;

    loop {
        let chunk_end = chunk_start.saturating_add(config.chunk_size.saturating_sub(1));
        let best = search_lowest_chunk(Arc::clone(&wallet_root), config, chunk_start, chunk_end)?;

        if best.is_some() || chunk_end == u32::MAX {
            return Ok(best);
        }

        chunk_start = chunk_end + 1;
    }
}

fn search_lowest_chunk(
    wallet_root: Arc<SecretKey>,
    config: &SearchConfig,
    chunk_start: u32,
    chunk_end: u32,
) -> Result<Option<SearchHit>> {
    let (tx, rx) = mpsc::channel();
    let mut handles = Vec::with_capacity(config.threads);

    for worker_id in 0..config.threads {
        let start_index = match chunk_start.checked_add(worker_id as u32) {
            Some(index) if index <= chunk_end => index,
            _ => continue,
        };
        let wallet_root = Arc::clone(&wallet_root);
        let tx = tx.clone();
        let config = config.clone();

        handles.push(thread::spawn(move || {
            let mut index = start_index;
            let mut best: Option<SearchHit> = None;

            while index <= chunk_end {
                if let Some(hit) = find_hit_at_index(&wallet_root, index, &config) {
                    if is_better_hit(&hit, best.as_ref()) {
                        best = Some(hit);
                    }
                }

                let Some(next_index) = index.checked_add(config.threads as u32) else {
                    break;
                };
                index = next_index;
            }

            if let Some(best) = best {
                let _ = tx.send(best);
            }
        }));
    }

    drop(tx);

    let mut best: Option<SearchHit> = None;
    for hit in rx {
        if is_better_hit(&hit, best.as_ref()) {
            best = Some(hit);
        }
    }

    for handle in handles {
        handle
            .join()
            .map_err(|_| anyhow!("search worker panicked"))?;
    }

    Ok(best)
}

fn find_hit_at_index(
    wallet_root: &SecretKey,
    index: u32,
    config: &SearchConfig,
) -> Option<SearchHit> {
    for &mode in candidate_modes(config.mode) {
        let address = address_for_child(wallet_root, index, mode, &config.address_prefix);

        if matches_wanted_address(&address, &config.wanted_prefix, &config.wanted_suffix) {
            return Some(SearchHit {
                index,
                mode,
                address,
            });
        }
    }

    None
}

fn address_for_child(
    wallet_root: &SecretKey,
    index: u32,
    mode: CandidateMode,
    address_prefix: &str,
) -> String {
    let child = match mode {
        CandidateMode::Hardened => wallet_root.derive_hardened(index),
        CandidateMode::Unhardened => DerivableKey::derive_unhardened(wallet_root, index),
    };
    let synthetic_pk = child.public_key().derive_synthetic();
    let puzzle_hash = StandardArgs::new(synthetic_pk).curry_tree_hash().into();

    Address::new(puzzle_hash, address_prefix.to_string())
        .encode()
        .expect("standard Chia address encoding should not fail")
}

fn candidate_modes(mode: Mode) -> &'static [CandidateMode] {
    match mode {
        Mode::Hardened => &[CandidateMode::Hardened],
        Mode::Unhardened => &[CandidateMode::Unhardened],
        Mode::Both => &[CandidateMode::Unhardened, CandidateMode::Hardened],
    }
}

fn matches_wanted_address(address: &str, wanted_prefix: &str, wanted_suffix: &str) -> bool {
    let address = address.to_lowercase();

    if !wanted_prefix.is_empty() && !address.starts_with(wanted_prefix) {
        return false;
    }

    if !wanted_suffix.is_empty() && !address.ends_with(wanted_suffix) {
        return false;
    }

    true
}

fn is_better_hit(next: &SearchHit, current: Option<&SearchHit>) -> bool {
    let Some(current) = current else {
        return true;
    };

    match next.index.cmp(&current.index) {
        Ordering::Less => true,
        Ordering::Greater => false,
        Ordering::Equal => {
            next.mode == CandidateMode::Unhardened && current.mode == CandidateMode::Hardened
        }
    }
}

fn validate_wanted_prefix(prefix: &str) -> Result<()> {
    if prefix.is_empty() {
        return Ok(());
    }

    let Some(data_part) = prefix_data_part(prefix) else {
        bail!("prefix can only use the xch1 or txch1 separator");
    };

    validate_bech32_data_chars(data_part, "prefix")
}

fn validate_wanted_suffix(suffix: &str) -> Result<()> {
    if suffix.is_empty() {
        return Ok(());
    }

    validate_bech32_data_chars(suffix, "suffix")
}

fn validate_bech32_data_chars(value: &str, name: &str) -> Result<()> {
    if value.chars().all(|char| BECH32_DATA_CHARS.contains(char)) {
        return Ok(());
    }

    bail!("{name} can only contain Bech32 characters: {BECH32_DATA_CHARS}")
}

fn prefix_data_part(prefix: &str) -> Option<&str> {
    if let Some(matched_prefix) = CHIA_ADDRESS_PREFIXES
        .iter()
        .find(|address_prefix| prefix.starts_with(**address_prefix))
    {
        return Some(&prefix[matched_prefix.len()..]);
    }

    if CHIA_ADDRESS_PREFIXES
        .iter()
        .any(|address_prefix| address_prefix.starts_with(prefix))
    {
        return Some("");
    }

    if prefix.contains('1') {
        return None;
    }

    Some(prefix)
}

fn infer_address_prefix(wanted_prefix: &str, fallback: &str) -> Result<String> {
    let fallback = fallback.trim().to_lowercase();

    if wanted_prefix.starts_with("txch1") {
        return Ok("txch".to_string());
    }

    if wanted_prefix.starts_with("xch1") {
        return Ok("xch".to_string());
    }

    match fallback.as_str() {
        "xch" | "txch" => Ok(fallback),
        _ => bail!("address prefix must be xch or txch"),
    }
}

fn mode_label(mode: Mode) -> &'static str {
    match mode {
        Mode::Hardened => "hardened",
        Mode::Unhardened => "unhardened",
        Mode::Both => "hardened and unhardened",
    }
}

fn candidate_mode_label(mode: CandidateMode) -> &'static str {
    match mode {
        CandidateMode::Hardened => "hardened",
        CandidateMode::Unhardened => "unhardened",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_prefix_wrapper_and_data_part() {
        assert!(validate_wanted_prefix("xch1ace").is_ok());
        assert!(validate_wanted_prefix("txch1ace").is_ok());
        assert!(validate_wanted_prefix("xch1b").is_err());
        assert!(validate_wanted_prefix("ace1ace").is_err());
    }

    #[test]
    fn validates_suffix_data_chars() {
        assert!(validate_wanted_suffix("ace").is_ok());
        assert!(validate_wanted_suffix("bio").is_err());
    }

    #[test]
    fn compares_hits_by_index_then_mode() {
        let hardened = SearchHit {
            index: 7,
            mode: CandidateMode::Hardened,
            address: "xch1hard".to_string(),
        };
        let unhardened = SearchHit {
            index: 7,
            mode: CandidateMode::Unhardened,
            address: "xch1soft".to_string(),
        };

        assert!(is_better_hit(&unhardened, Some(&hardened)));
        assert!(!is_better_hit(&hardened, Some(&unhardened)));
    }
}
