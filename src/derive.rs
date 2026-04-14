use anyhow::{Context, Result};
use bip39::Mnemonic;

use chia_wallet_sdk::chia::bls::{
    master_to_wallet_hardened,
    master_to_wallet_unhardened,
    SecretKey,
};
use chia_wallet_sdk::chia::puzzle_types::DeriveSynthetic;
use chia_wallet_sdk::clvm_utils::ToTreeHash;
use chia_wallet_sdk::driver::StandardLayer;
use chia_wallet_sdk::utils::Address;

use crate::types::{Hit, HitMode, Mode};

pub fn master_sk_from_mnemonic(mnemonic_phrase: &str) -> Result<SecretKey> {
    let mnemonic = Mnemonic::parse(mnemonic_phrase).context("invalid BIP39 mnemonic")?;
    let seed = mnemonic.to_seed("");
    Ok(SecretKey::from_seed(&seed))
}

pub fn standard_address_for_child_sk(child_sk: &SecretKey, prefix: &str) -> Result<String> {
    let synthetic_pk = child_sk.public_key().derive_synthetic();
    let standard = StandardLayer::new(synthetic_pk);
    let puzzle_hash = standard.tree_hash();

    let address = Address::new(puzzle_hash.into(), prefix.to_string())
        .encode()
        .context("failed to encode bech32m address")?;

    Ok(address)
}

pub fn candidate_for_index(
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
                mode: HitMode::Hardened,
                address: addr,
            });
        }
        Mode::Unhardened => {
            let sk = master_to_wallet_unhardened(master_sk, index);
            let addr = standard_address_for_child_sk(&sk, prefix)?;
            out.push(Hit {
                index,
                mode: HitMode::Unhardened,
                address: addr,
            });
        }
        Mode::Both => {
            let sk_u = master_to_wallet_unhardened(master_sk, index);
            let addr_u = standard_address_for_child_sk(&sk_u, prefix)?;
            out.push(Hit {
                index,
                mode: HitMode::Unhardened,
                address: addr_u,
            });

            let sk_h = master_to_wallet_hardened(master_sk, index);
            let addr_h = standard_address_for_child_sk(&sk_h, prefix)?;
            out.push(Hit {
                index,
                mode: HitMode::Hardened,
                address: addr_h,
            });
        }
    }

    Ok(out)
}
