# WebGPU Chia vanity search

This package implements the batched BLS12-381 operations used by Chia's unhardened public-key derivation. It builds on `webgpu-groth16`'s WGSL field and point arithmetic. Hashing, Bech32m matching, and final candidate selection run inside the same WASM search engine; the application re-derives every reported match with the canonical Chia SDK.

The benchmark verifies every GPU result against `nam-blstrs`. GPU timings include affine normalization and readback. The CPU bridge timing additionally measures deserialization, compressed point encoding, and SHA-256, approximating the dependency between Chia's first and second fixed-base multiplication.

Build with an LLVM clang that supports WebAssembly:

```sh
CC=/opt/homebrew/opt/llvm/bin/clang wasm-pack build --target web --out-dir pkg
```

Serve the repository root with Vite and open `/webgpu-vanity-wasm/bench.html` in a WebGPU-capable browser.

For memory regression testing, open `/webgpu-vanity-wasm/memory-test.html`. It can run 500 consecutive full batches and 20 repeated create/search/free lifecycle cycles while reporting the WASM and JavaScript heap sizes.

## Verification and measured result

- Native tests check raw GPU-limb compression and a canonical known Chia address.
- Browser differential tests compared 4,096 consecutive child keys, synthetic keys, and puzzle hashes at starts 0 and 4,096 with zero mismatches.
- The integrated application found known mainnet and testnet results, then independently verified them through `chia-wallet-sdk-wasm`.
- A 25-second no-match run processed 749,568 complete addresses at 29.7k addresses/second, essentially unchanged from 29.2k addresses/second after five seconds. The same app/browser measured 3.3k addresses/second on its multi-worker CPU path, making this run about 9x faster.
- A 500-batch memory run processed 2,048,000 addresses. The WASM heap grew once from 2.13 MiB to 5.25 MiB during warm-up, then remained exactly 5.25 MiB through all remaining batches. JavaScript heap samples repeatedly returned to roughly 5–10 MiB after collection.
- Forty direct GPU create/search/free cycles and ten full application worker start/stop cycles did not accumulate GPU-process memory; observed GPU-process RSS fell from about 100 MiB to 52 MiB after cleanup.

The search object allocates its GPU and CPU staging buffers once at a fixed capacity of 4,096 candidates and reuses them for every batch. Calling `free()` or terminating its worker releases the search context.
