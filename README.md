# Chia Vanity Address Brute Forcer

A high-performance, multi-core brute forcer for generating Chia wallet receive addresses with a desired prefix, suffix, or both.

This tool derives real wallet addresses from your mnemonic and searches for ones matching patterns like:

```
xch1name...
...ace
```

---

## ⚠️ Security Notice

- This tool requires your **mnemonic (private key material)**.
- **Never use a mnemonic you don’t trust this machine with.**
- Build from source and review the code before running.
- **Do not pass the mnemonic as a command-line argument.** Anything on the
  command line is visible to every other user via `ps` / `/proc/<pid>/cmdline`
  and is saved in your shell history. Use one of the private methods below.

---

## 🚀 What it does

- Derives wallet addresses from your mnemonic (`m/12381/8444/2/i`)
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

---

## 🔑 Providing your mnemonic

If you don’t pass the mnemonic as an argument, the tool figures out where to get
it (**no extra flags needed**). The first three methods keep it **off the command
line**, so it never shows up in `ps` or your shell history:

| Method | How | Notes |
|--------|-----|-------|
| **Interactive prompt** (default) | Run with no mnemonic | Hidden, no-echo prompt. Most private; best for interactive use. |
| **Standard input** | Pipe it in, or redirect a file | Auto-detected when stdin isn’t a terminal: `pass show ... \| chia-vanity-cli ...` or `chia-vanity-cli ... < mnemonic.txt` |
| **Environment variable** | `CHIA_VANITY_MNEMONIC=...` | Convenient, but readable via `/proc/<pid>/environ` by the same user. |
| Positional argument | `chia-vanity-cli "<mnemonic>" ...` | ⚠️ **Insecure**: visible via `ps`. Kept only for backwards compatibility; prints a warning. |

When no mnemonic is given on the command line, the resolution order is
`CHIA_VANITY_MNEMONIC`, then stdin (if piped or redirected), then the interactive
prompt. Leading/trailing and repeated whitespace (including newlines) is ignored,
so a phrase saved on its own line in a file or piped from another command works
as-is.

---

## ▶️ Usage

The root workspace defaults to the native Rust CLI, so this does not start Tauri or use WASM.
With no mnemonic argument, you’ll be prompted for it securely (input hidden):

```bash
cargo run --release -- \
  --prefix xch1name \
  --suffix ace
```

At least one of `--prefix` or `--suffix` is required. When both are supplied, the address must match both.

### Prefix only

```bash
cargo run --release -- \
  --prefix xch1name \
  < ./mnemonic.txt
```

### Suffix only

```bash
cargo run --release -- \
  --suffix ace \
  < ./mnemonic.txt
```

Suffix-only searches encode `xch` addresses by default. Use `--address-prefix txch` for testnet addresses.

### Prefix and suffix

```bash
cargo run --release -- \
  --prefix xch1name \
  --suffix ace \
  < ./mnemonic.txt
```

### Exact index

Use `--derive-index` to print the address at a known derivation index instead of searching:

```bash
cargo run --release -- \
  --derive-index 123456 \
  < ./mnemonic.txt
```

This respects `--mode hardened|unhardened|both` and `--address-prefix xch|txch`.

### From standard input

Pipe it in from another command, or redirect a file as in the examples above:

```bash
pass show chia/mnemonic | cargo run --release -- \
  --prefix xch1name
```

### From an environment variable

Convenient for scripts, but the value is readable via `/proc/<pid>/environ` by the same user:

```bash
CHIA_VANITY_MNEMONIC="word1 word2 ... word24" \
  cargo run --release -- --prefix xch1name
```

### Useful options

```bash
--mode hardened|unhardened|both
--search-mode fast|lowest
--derive-index 123456
--threads 0
--start-index 0
--chunk-size 10000
--address-prefix xch|txch
```

The mnemonic itself takes no flag: pass it on stdin (a pipe or `< file`), set the
`CHIA_VANITY_MNEMONIC` environment variable, or just run without it to be
prompted. See [Providing your mnemonic](#-providing-your-mnemonic) above.

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
