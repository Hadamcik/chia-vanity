use std::env;
use std::sync::{
    atomic::AtomicBool,
    Arc,
};

use anyhow::Result;

use chia_vanity::search::run_search_with_generator;
use chia_vanity::types::{Mode, SearchMode, SearchRequest, SearchResult};

#[cfg(feature = "native-cli")]
use chia_vanity::derive::{candidate_for_index, master_sk_from_mnemonic};

fn print_usage(program: &str) {
    eprintln!(
        "Usage:\n  {} '<mnemonic>' <wanted_prefix> [start_index] [chunk_size] [mode] [threads] [search_mode]",
        program
    );
    eprintln!();
    eprintln!("Example fast:");
    eprintln!(
        "  {} 'your 24 words here' xch1name 0 10000 unhardened 0 fast",
        program
    );
    eprintln!();
    eprintln!("Example lowest:");
    eprintln!(
        "  {} 'your 24 words here' xch1name 0 10000 unhardened 0 lowest",
        program
    );
}

fn print_result(result: SearchResult) {
    match result.hit {
        Some(hit) => {
            println!("MATCH FOUND");
            println!("index   : {}", hit.index);
            println!("mode    : {}", hit.mode.as_str());
            println!("address : {}", hit.address);
        }
        None => {
            println!("No match found");
        }
    }
}

fn main() -> Result<()> {
    let args: Vec<String> = env::args().collect();

    if args.len() < 3 {
        print_usage(&args[0]);
        std::process::exit(1);
    }

    let start_index: u64 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(0);
    let chunk_size: u64 = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(10_000);
    let mode = Mode::parse(args.get(5).map(String::as_str).unwrap_or("unhardened"))?;
    let threads: usize = args.get(6).and_then(|s| s.parse().ok()).unwrap_or(0);
    let search_mode = SearchMode::parse(args.get(7).map(String::as_str).unwrap_or("fast"))?;

    let worker_count = if threads == 0 {
        std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1)
    } else {
        threads.max(1)
    };

    let request = SearchRequest {
        mnemonic: args[1].clone(),
        wanted_prefix: args[2].clone(),
        start_index,
        chunk_size,
        mode,
        worker_count,
        search_mode,
    };

    eprintln!(
        "starting search: prefix={} start_index={} chunk_size={} mode={:?} workers={} search_mode={:?}",
        request.wanted_prefix,
        request.start_index,
        request.chunk_size,
        request.mode,
        request.worker_count,
        request.search_mode
    );

    let master_sk = master_sk_from_mnemonic(&request.mnemonic)?;
    let should_stop = Arc::new(AtomicBool::new(false));

    let result = run_search_with_generator(request, should_stop, |progress| {
        eprintln!(
            "checked={} rate={:.0}/s elapsed={:.1}s",
            progress.checked,
            progress.rate_per_sec,
            progress.elapsed_secs
        );
    }, move |index, mode, hrp| {
        candidate_for_index(&master_sk, index, mode, hrp)
    })?;

    print_result(result);

    Ok(())
}
