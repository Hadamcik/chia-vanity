use anyhow::{bail, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Hardened,
    Unhardened,
    Both,
}

impl Mode {
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "hardened" => Ok(Self::Hardened),
            "unhardened" => Ok(Self::Unhardened),
            "both" => Ok(Self::Both),
            _ => bail!("mode must be one of: hardened | unhardened | both"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchMode {
    Fast,
    Lowest,
}

impl SearchMode {
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "fast" => Ok(Self::Fast),
            "lowest" => Ok(Self::Lowest),
            _ => bail!("search_mode must be one of: fast | lowest"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HitMode {
    Hardened,
    Unhardened,
}

impl HitMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hardened => "hardened",
            Self::Unhardened => "unhardened",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hit {
    pub index: u32,
    pub mode: HitMode,
    pub address: String,
}

#[derive(Debug, Clone)]
pub struct ChunkResult {
    pub start: u64,
    pub end: u64,
    pub best_hit: Option<Hit>,
}

#[derive(Debug, Clone)]
pub struct SearchRequest {
    pub mnemonic: String,
    pub wanted_prefix: String,
    pub start_index: u64,
    pub chunk_size: u64,
    pub mode: Mode,
    pub worker_count: usize,
    pub search_mode: SearchMode,
}

#[derive(Debug, Clone, Copy)]
pub struct SearchProgress {
    pub checked: u64,
    pub rate_per_sec: f64,
    pub elapsed_secs: f64,
}

#[derive(Debug, Clone)]
pub struct SearchResult {
    pub hit: Option<Hit>,
}
