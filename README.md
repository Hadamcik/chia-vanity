# Vanity address

A high-performance, multi-core brute forcer for generating Chia wallet receive addresses with a desired prefix, suffix, or both.

This tool derives real wallet addresses from your mnemonic, or from your master public key for unhardened derivation, and searches for ones matching patterns like:

```
xch1name...
...ace
```

---

## ⚠️ Security Notice

- Hardened derivation requires your **mnemonic (private key material)**.
- Unhardened derivation can use a master public key instead.
- **Never use a mnemonic you don’t trust this machine with.**
- Build from source and review the code before running.

---

## 🚀 What it does

- Derives wallet addresses from your mnemonic (`m/12381/8444/2/i`)
- Supports public-key-only unhardened derivation
- Matches prefix, suffix, or both at the same time
- Can derive and print the address at an exact index without searching
- Supports:
  - hardened
  - unhardened
  - both derivation modes
- Uses all CPU cores
- Supports two search modes:
  - **fast** → returns first match (not lowest index)
  - **lowest** → guarantees lowest index

---

## 🔤 Bech32m character set

Chia addresses use **Bech32m encoding**, which only allows a specific set of characters.

Valid characters (alphabetically sorted):
```text
023456789acdefghjklmnpqrstuvwxyz
```

---

## ⚙️ Requirements

- Rust (stable)
- Multi-core CPU (more cores = faster)

---

## 📦 Build

```bash
cargo build --release
```

### Sage app build

The browser app is Sage Apps compatible and uses `sage-app-sdk` for manifest finalization:

```bash
pnpm install
pnpm build
```

The build writes the Sage-ready app bundle to `dist/`, including `dist/sage-manifest.json`.

For Cloudflare Pages, use the committed WASM package instead of rebuilding it:

```bash
pnpm build:cloudflare
```

Set the build output directory to `dist`.

If your Cloudflare project also has a deploy command, use:

```bash
npx wrangler deploy
```

The checked-in `wrangler.jsonc` points Wrangler at the already-built `dist` assets so it does not rerun `pnpm build`.

Inside Sage, use **Load Sage key** for public-key-only unhardened searches through Sage's derived-public-key bridge. Use **Load Sage private key** only when you need hardened derivation or the WebGPU path.

### Browser CPU and GPU search

The browser app exposes separate CPU and GPU checkboxes next to the search target. Both are selected by default so compatible unhardened searches use their combined throughput:

- CPU and GPU workers receive disjoint index ranges, so they never duplicate successful work.
- Fast hybrid auto mode starts at about 47% of the browser-reported logical threads, then tunes the live CPU worker count up or down from stabilized aggregate-rate samples. Workers draw bounded ranges from a shared coordinator, so adjustment does not skip or duplicate indexes. An explicit CPU worker count still disables tuning and overrides the automatic value.
- The progress panel shows the current tuning phase and sample count, then keeps the optimized worker count and best measured rate visible once tuning settles.
- Unchecking the only selected engine switches to the other engine when it is available. Unavailable engines are disabled with an explanation in the UI.
- If WebGPU is unavailable or fails while both engines are selected, CPU workers take over its unfinished range without leaving a gap.
- GPU-only search keeps one bounded 4,096-address batch in flight and supports unhardened derivation.
- Every GPU match is re-derived and checked with the canonical CPU Chia wallet SDK before it is shown.
- Hardened searches use the CPU. Sage's public-key bridge also uses the CPU because it supplies already-derived public keys rather than an account public key; importing a private key or entering key material manually supports the normal GPU path.

---

## ▶️ Usage

The root workspace defaults to the native Rust CLI, so this does not start Tauri or use WASM:

```bash
cargo run --release -- \
  "<your mnemonic>" \
  --prefix xch1name \
  --suffix ace
```

At least one of `--prefix` or `--suffix` is required. When both are supplied, the address must match both.

### Prefix only

```bash
cargo run --release -- \
  "word1 word2 ... word24" \
  --prefix xch1name
```

### Suffix only

```bash
cargo run --release -- \
  "word1 word2 ... word24" \
  --suffix ace
```

Suffix-only searches encode `xch` addresses by default. Use `--address-prefix txch` for testnet addresses.

### Prefix and suffix

```bash
cargo run --release -- \
  "word1 word2 ... word24" \
  --prefix xch1name \
  --suffix ace
```

### Exact index

Use `--derive-index` to print the address at a known derivation index instead of searching:

```bash
cargo run --release -- \
  "word1 word2 ... word24" \
  --derive-index 123456
```

This respects `--mode hardened|unhardened|both` and `--address-prefix xch|txch`.

### Public-key-only unhardened mode

For unhardened addresses, you can provide a 48-byte master public key as 96 hex characters and omit the mnemonic:

```bash
cargo run --release -- \
  --public-key "<96 hex chars>" \
  --mode unhardened \
  --prefix xch1name
```

This also works with exact-index derivation:

```bash
cargo run --release -- \
  --public-key "<96 hex chars>" \
  --mode unhardened \
  --derive-index 123456
```

`--public-key` is intentionally rejected for `--mode hardened` and `--mode both`.

### Useful options

```bash
--mode hardened|unhardened|both
--search-mode fast|lowest
--derive-index 123456
--public-key <96 hex chars>
--threads 0
--start-index 0
--chunk-size 10000
--address-prefix xch|txch
```

---

## 🔀 Search modes

### ⚡ fast (default)

- Uses worker threads over the address range
- Returns first match found by any thread
- **Fastest**
- **Index can be very large and non-sequential**

Example:
```
index = 1610617400
```

This happens because the search space is split across threads.

---

### 🎯 lowest

- Guarantees **smallest possible index**
- Uses chunk-based coordination
- Slightly slower
- Better for wallet compatibility

---

## ⚡ Performance

This is a CPU-bound, embarrassingly parallel workload:

- More cores → near-linear speedup
- Single-core performance still matters

### Real-world baseline

- Apple M2:
  - ~100 seconds for 4 characters after `xch1`

The WebGPU result depends heavily on the browser and GPU. On the development machine, the complete integrated path sustained about 29,000 verified address candidates per second versus about 3,300/second for the multi-worker CPU path; use the in-app rate for the device you are actually searching on.

---

## 🔢 Difficulty scaling

Each extra character multiplies work by **32×**.

| Characters after `xch1` | Expected attempts |
|------------------------|------------------|
| 4                      | ~1 million       |
| 5                      | ~33 million      |
| 6                      | ~1 billion       |

---

## 🧠 Notes

- Bech32 encoding means prefixes are not perfectly uniform
- Early characters may have slight bias
- Default `unhardened` mode uses the same receive-address derivation style as Sage Wallet
- Prefix and suffix inputs are validated against the Bech32 character set
- `fast` mode may return very high indices due to parallel splitting
- `lowest` mode ensures minimal index

---

## 🛠️ Tips

- Use `fast` for quick vanity search
- Use `lowest` for deterministic result
- Keep `chunk_size` small (1k–10k) for `lowest`
- Use `unhardened` for modern wallets
- Always use `--release`

---

## 🧾 Output

```
MATCH FOUND
index   : 123456
mode    : unhardened
address : xch1name...
```

---

## 🚀 Recommended defaults

| Setting      | Value       |
|-------------|------------|
| mode        | unhardened |
| search_mode | fast       |
| threads     | 0 (auto)   |
| chunk_size  | 10000      |

---

## 💡 Summary

- **fast** = maximum speed, random index
- **lowest** = guaranteed smallest index

Choose based on your goal.
