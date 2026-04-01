# Chia Vanity Address Brute Forcer (Rust)

A high-performance, multi-core brute forcer for generating Chia wallet receive addresses with a desired prefix (vanity address).

This tool derives real wallet addresses from your mnemonic and searches for ones matching a prefix like:

```text
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
- Uses all CPU cores via `rayon`
- Searches sequential indices until a match is found

---

## ⚙️ Requirements

- Rust (stable)
- A multi-core CPU (more cores = faster)

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
  [threads]
```

### Example

```bash
cargo run --release -- \\
  "word1 word2 ... word24" \\
  xch1name \\
  0 \\
  200000 \\
  unhardened \\
  0
```

### Arguments

| Argument | Description |
|---|---|
| mnemonic | Your 24-word seed phrase |
| wanted_prefix | Target prefix, e.g. `xch1name` |
| start_index | Optional start index (default: `0`) |
| chunk_size | Batch size per iteration (default: `200000`) |
| mode | `hardened`, `unhardened`, or `both` |
| threads | Number of threads (`0` = auto / all cores) |

---

## ⚡ Performance

This is a **CPU-bound, embarrassingly parallel workload**, so:

- More cores usually gives near-linear speedup
- Better single-core performance also helps

### Real-world baseline

On an Apple M2, a 4-character vanity search **after `xch1`** took about **100 seconds** in testing.

That means something like:

```text
xch1name
```

where `name` is the brute-forced part.

---

## 🔢 Difficulty scaling

Each additional character increases expected work by **32×**.

| Characters after `xch1` | Expected attempts |
|---|---:|
| 4 | ~1,048,576 |
| 5 | ~33,554,432 |
| 6 | ~1,073,741,824 |

So roughly:

- 4 chars: seconds to minutes
- 5 chars: minutes to hours
- 6 chars: hours to days

---

## 🧠 Notes

- The search space is large (~4.3 billion indices per derivation mode), but vanity targets are usually found much earlier.
- Using `both` mode checks two derivations per index, which improves match rate per index but uses more CPU per index.
- Very high indices may not be automatically discovered by wallet software without manual derivation.

---

## 🛠️ Tips

- Start with `unhardened`
- Keep indices relatively low if you want easier wallet compatibility
- Run on a high-core machine for best results
- Always use `--release`

---

## 🧾 Output

When a match is found:

```text
MATCH FOUND
index   : 123456
mode    : unhardened
address : xch1name...
elapsed : 42.13s
```

You can later re-derive this address using the same mnemonic and index.
