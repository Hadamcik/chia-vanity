# Chia Vanity Address Brute Forcer (Rust)

A high-performance, multi-core brute forcer for generating Chia wallet receive addresses with a desired prefix (vanity address).

This tool derives real wallet addresses from your mnemonic and searches for ones matching a prefix like:

```
xch1name...
```

---

## ⚠️ Security Notice

- This tool requires your **mnemonic (private key material)**.
- **Never use a mnemonic you don’t trust this machine with.**
- Build from source and review the code before running.

---

## 🚀 What it does

- Derives wallet addresses from your mnemonic (`m/12381/8444/2/i`)
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

## ▶️ Usage

```bash
cargo run --release -- \\
  "<your 24 word mnemonic>" \\
  <wanted_prefix> \\
  [start_index] \\
  [chunk_size] \\
  [mode] \\
  [threads] \\
  [search_mode]
```

### Example

```bash
cargo run --release -- \\
  "word1 word2 ... word24" \\
  xch1name \\
  0 \\
  10000 \\
  unhardened \\
  0 \\
  fast
```

---

## 🔀 Search modes

### ⚡ fast (default)

- Uses Rayon parallel iteration over entire range
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