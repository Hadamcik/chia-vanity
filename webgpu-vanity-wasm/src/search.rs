use anyhow::{Context, Result};
use bech32::{ToBase32, Variant};
use blstrs::{G1Affine, G1Projective};
use group::prime::PrimeCurveAffine;
use num_bigint::BigInt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use wasm_bindgen::prelude::*;
use web_time::Instant;
use webgpu_groth16::gpu::curve::GpuCurve;
use wgpu::util::DeviceExt;

use crate::{
    CurveImpl, DERIVE_ENTRY, FIXED_BASE_ENTRY, NORMALIZE_ENTRY, POINT_BYTES, compress_gpu_point,
    fixed_base_table, pipeline, readback, serialize_point, storage_entry,
};

const BATCH_CAPACITY: u32 = 4096;
const SCALAR_BYTES: usize = 32;
const PUBLIC_KEY_BYTES: usize = 48;
const DEFAULT_HIDDEN_PUZZLE_HASH: [u8; 32] = [
    0x71, 0x1d, 0x6c, 0x4e, 0x32, 0xc9, 0x2e, 0x53, 0x17, 0x9b, 0x19, 0x94, 0x84, 0xcf, 0x8c, 0x89,
    0x75, 0x42, 0xbc, 0x57, 0xf2, 0xb2, 0x25, 0x82, 0x79, 0x9f, 0x9d, 0x65, 0x7e, 0xec, 0x46, 0x99,
];
const GROUP_ORDER: [u8; 32] = [
    0x73, 0xed, 0xa7, 0x53, 0x29, 0x9d, 0x7d, 0x48, 0x33, 0x39, 0xd8, 0x08, 0x09, 0xa1, 0xd8, 0x05,
    0x53, 0xbd, 0xa4, 0x02, 0xff, 0xfe, 0x5b, 0xfe, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x01,
];
const STANDARD_PUZZLE_PROGRAM_HASH: [u8; 32] = [
    0xe9, 0xaa, 0xa4, 0x9f, 0x45, 0xba, 0xd5, 0xc8, 0x89, 0xb8, 0x6e, 0xe3, 0x34, 0x15, 0x50, 0xc1,
    0x55, 0xcf, 0xdd, 0x10, 0xc3, 0xa6, 0x75, 0x7d, 0xe6, 0x18, 0xd2, 0x06, 0x12, 0xff, 0xfd, 0x52,
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchBatchResult {
    checked: u32,
    elapsed_ms: f64,
    hit_index: Option<u32>,
    hit_address: Option<String>,
}

fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().into()
}

fn tree_hash_atom(atom: &[u8]) -> [u8; 32] {
    sha256(&[&[1], atom])
}

fn tree_hash_pair(left: [u8; 32], right: [u8; 32]) -> [u8; 32] {
    sha256(&[&[2], &left, &right])
}

fn standard_puzzle_hash(public_key: &[u8; PUBLIC_KEY_BYTES]) -> [u8; 32] {
    let nil = tree_hash_atom(&[]);
    let op_q = tree_hash_atom(&[1]);
    let op_a = tree_hash_atom(&[2]);
    let op_c = tree_hash_atom(&[4]);
    let quoted_program = tree_hash_pair(op_q, STANDARD_PUZZLE_PROGRAM_HASH);

    let arg_hash = tree_hash_atom(public_key);
    let quoted_arg = tree_hash_pair(op_q, arg_hash);
    let terminated_args = tree_hash_pair(tree_hash_atom(&[1]), nil);
    let terminated_args = tree_hash_pair(quoted_arg, terminated_args);
    let quoted_args = tree_hash_pair(op_c, terminated_args);

    let terminated_args = tree_hash_pair(quoted_args, nil);
    let program_and_args = tree_hash_pair(quoted_program, terminated_args);
    tree_hash_pair(op_a, program_and_args)
}

fn synthetic_scalar_little_endian(public_key: &[u8; PUBLIC_KEY_BYTES]) -> [u8; 32] {
    let digest = sha256(&[public_key, &DEFAULT_HIDDEN_PUZZLE_HASH]);
    let value = BigInt::from_signed_bytes_be(&digest);
    let order = BigInt::from_signed_bytes_be(&GROUP_ORDER);
    let modulo = ((value % &order) + &order) % &order;
    let mut bytes = modulo.to_bytes_be().1;
    if bytes.len() < SCALAR_BYTES {
        bytes.splice(0..0, std::iter::repeat_n(0, SCALAR_BYTES - bytes.len()));
    }
    let mut little_endian: [u8; SCALAR_BYTES] = bytes.try_into().expect("scalar is 32 bytes");
    little_endian.reverse();
    little_endian
}

fn first_stage_scalars(
    account_public_key: &[u8; PUBLIC_KEY_BYTES],
    start_index: u32,
    step: u32,
) -> Vec<u8> {
    let mut scalars = Vec::with_capacity(BATCH_CAPACITY as usize * SCALAR_BYTES);
    for offset in 0..BATCH_CAPACITY {
        let index = start_index.wrapping_add(offset.wrapping_mul(step));
        let mut scalar = sha256(&[account_public_key, &index.to_be_bytes()]);
        scalar.reverse();
        scalars.extend_from_slice(&scalar);
    }
    scalars
}

fn compressed_points(bytes: &[u8]) -> Result<Vec<[u8; PUBLIC_KEY_BYTES]>> {
    bytes
        .chunks_exact(POINT_BYTES)
        .map(compress_gpu_point)
        .collect()
}

fn second_stage_scalars(points: &[[u8; PUBLIC_KEY_BYTES]]) -> Vec<u8> {
    let mut scalars = Vec::with_capacity(points.len() * SCALAR_BYTES);
    for point in points {
        scalars.extend_from_slice(&synthetic_scalar_little_endian(point));
    }
    scalars
}

#[wasm_bindgen]
pub struct WebGpuVanitySearch {
    device: wgpu::Device,
    queue: wgpu::Queue,
    adapter_name: String,
    account_public_key: [u8; PUBLIC_KEY_BYTES],
    convert_pipeline: wgpu::ComputePipeline,
    derive_one_pipeline: wgpu::ComputePipeline,
    derive_each_pipeline: wgpu::ComputePipeline,
    normalize_pipeline: wgpu::ComputePipeline,
    convert_children_group: wgpu::BindGroup,
    derive_one_group: wgpu::BindGroup,
    derive_each_group: wgpu::BindGroup,
    normalize_group: wgpu::BindGroup,
    scalar_buffer: wgpu::Buffer,
    affine_output: wgpu::Buffer,
    staging: wgpu::Buffer,
}

#[wasm_bindgen]
impl WebGpuVanitySearch {
    #[wasm_bindgen(js_name = create)]
    pub async fn create(account_public_key: Vec<u8>) -> Result<WebGpuVanitySearch, JsValue> {
        console_error_panic_hook::set_once();
        Self::create_inner(account_public_key)
            .await
            .map_err(|error| JsValue::from_str(&format!("{error:#}")))
    }

    #[wasm_bindgen(getter, js_name = adapterName)]
    pub fn adapter_name(&self) -> String {
        self.adapter_name.clone()
    }

    #[wasm_bindgen(getter, js_name = batchCapacity)]
    pub fn batch_capacity(&self) -> u32 {
        BATCH_CAPACITY
    }

    #[wasm_bindgen(js_name = deriveSyntheticPublicKeys)]
    pub async fn derive_synthetic_public_keys(
        &self,
        start_index: u32,
        count: u32,
    ) -> Result<Vec<u8>, JsValue> {
        if count > BATCH_CAPACITY {
            return Err(JsValue::from_str("count exceeds GPU batch capacity"));
        }
        let points = self
            .derive_batch(start_index, 1)
            .await
            .map_err(|error| JsValue::from_str(&format!("{error:#}")))?;
        Ok(points.into_iter().take(count as usize).flatten().collect())
    }

    #[wasm_bindgen(js_name = deriveChildPublicKeys)]
    pub async fn derive_child_public_keys(
        &self,
        start_index: u32,
        count: u32,
    ) -> Result<Vec<u8>, JsValue> {
        if count > BATCH_CAPACITY {
            return Err(JsValue::from_str("count exceeds GPU batch capacity"));
        }
        let points = self
            .derive_children(start_index, 1)
            .await
            .map_err(|error| JsValue::from_str(&format!("{error:#}")))?;
        Ok(points.into_iter().take(count as usize).flatten().collect())
    }

    #[wasm_bindgen(js_name = derivePuzzleHashes)]
    pub async fn derive_puzzle_hashes(
        &self,
        start_index: u32,
        count: u32,
    ) -> Result<Vec<u8>, JsValue> {
        if count > BATCH_CAPACITY {
            return Err(JsValue::from_str("count exceeds GPU batch capacity"));
        }
        let points = self
            .derive_batch(start_index, 1)
            .await
            .map_err(|error| JsValue::from_str(&format!("{error:#}")))?;
        Ok(points
            .iter()
            .take(count as usize)
            .flat_map(standard_puzzle_hash)
            .collect())
    }

    #[wasm_bindgen(js_name = searchBatch)]
    pub async fn search_batch(
        &self,
        start_index: u32,
        count: u32,
        step: u32,
        address_prefix: String,
        wanted_prefix: String,
        wanted_suffix: String,
    ) -> Result<JsValue, JsValue> {
        if count == 0 || count > BATCH_CAPACITY {
            return Err(JsValue::from_str(
                "count must be within the GPU batch capacity",
            ));
        }
        if step == 0 {
            return Err(JsValue::from_str("step must be greater than zero"));
        }

        let started = Instant::now();
        let points = self
            .derive_batch(start_index, step)
            .await
            .map_err(|error| JsValue::from_str(&format!("{error:#}")))?;
        let wanted_prefix = wanted_prefix.to_lowercase();
        let wanted_suffix = wanted_suffix.to_lowercase();
        let mut hit_index = None;
        let mut hit_address = None;

        for (offset, public_key) in points.iter().take(count as usize).enumerate() {
            let puzzle_hash = standard_puzzle_hash(public_key);
            let address =
                bech32::encode(&address_prefix, puzzle_hash.to_base32(), Variant::Bech32m)
                    .context("failed to encode Chia address")
                    .map_err(|error| JsValue::from_str(&format!("{error:#}")))?;
            let address_lower = address.to_lowercase();
            if (!wanted_prefix.is_empty() && !address_lower.starts_with(&wanted_prefix))
                || (!wanted_suffix.is_empty() && !address_lower.ends_with(&wanted_suffix))
            {
                continue;
            }
            hit_index = Some(start_index.wrapping_add((offset as u32).wrapping_mul(step)));
            hit_address = Some(address);
            break;
        }

        serde_wasm_bindgen::to_value(&SearchBatchResult {
            checked: count,
            elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
            hit_index,
            hit_address,
        })
        .map_err(|error| JsValue::from_str(&error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use blstrs::Scalar;
    use group::{Curve, Group, GroupEncoding};

    fn decode_hex<const N: usize>(value: &str) -> [u8; N] {
        assert_eq!(value.len(), N * 2);
        let mut bytes = [0_u8; N];
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).unwrap();
        }
        bytes
    }

    #[test]
    fn gpu_point_compression_matches_standard_encoding() {
        let generator = G1Projective::generator();
        let gpu_bytes = serialize_point(generator);
        assert_eq!(
            compress_gpu_point(&gpu_bytes).unwrap().as_slice(),
            generator.to_affine().to_bytes().as_ref(),
        );
    }

    #[test]
    fn first_stage_scalars_honor_index_stride() {
        let account_public_key = [0x42; PUBLIC_KEY_BYTES];
        let scalars = first_stage_scalars(&account_public_key, 5, 3);

        for (offset, expected_index) in [5_u32, 8, 11].into_iter().enumerate() {
            let mut expected = sha256(&[&account_public_key, &expected_index.to_be_bytes()]);
            expected.reverse();

            let start = offset * SCALAR_BYTES;
            assert_eq!(&scalars[start..start + SCALAR_BYTES], &expected);
        }
    }

    #[test]
    fn synthetic_and_standard_puzzle_hash_match_known_address() {
        let child_bytes = decode_hex::<48>(
            "90197e0bf07d90dc9ace9d5e2d51e1d0c4bbc17af930217bd02616345bff5c713e0b82b838426d8d86b37fc5a249e133",
        );
        let child = Option::<G1Affine>::from(G1Affine::from_compressed(&child_bytes)).unwrap();
        let scalar_bytes = synthetic_scalar_little_endian(&child_bytes);
        let scalar = Option::<Scalar>::from(Scalar::from_bytes_le(&scalar_bytes)).unwrap();
        let synthetic = G1Projective::from(child) + G1Projective::generator() * scalar;
        let synthetic_bytes = synthetic.to_affine().to_compressed();
        let puzzle_hash = standard_puzzle_hash(&synthetic_bytes);
        let address = bech32::encode("xch", puzzle_hash.to_base32(), Variant::Bech32m).unwrap();

        assert_eq!(
            address,
            "xch18nwy3t78xc3nuhyh8xkm9zh8l9qdf03clzgyhdq5zfz7tefzqq0scwrfc5",
        );
    }
}

impl WebGpuVanitySearch {
    async fn create_inner(account_public_key: Vec<u8>) -> Result<Self> {
        anyhow::ensure!(
            account_public_key.len() == PUBLIC_KEY_BYTES,
            "account public key must be 48 bytes"
        );
        let account_public_key: [u8; PUBLIC_KEY_BYTES] = account_public_key
            .try_into()
            .expect("checked account public key length");
        let account_affine =
            Option::<G1Affine>::from(G1Affine::from_compressed(&account_public_key))
                .context("account public key is not a valid BLS12-381 point")?;
        anyhow::ensure!(
            !bool::from(account_affine.is_identity()),
            "account public key cannot be infinity"
        );

        let instance = wgpu::Instance::default();
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                compatible_surface: None,
            })
            .await
            .context("no WebGPU adapter available")?;
        let adapter_name = adapter.get_info().name;
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("Vanity WebGPU search"),
                required_features: wgpu::Features::empty(),
                required_limits: adapter.limits(),
                ..Default::default()
            })
            .await
            .context("failed to request WebGPU device")?;

        let aggregate_source = format!(
            "{}\n{}\n{}",
            <CurveImpl as GpuCurve>::MSM_G1_AGG_SOURCE,
            FIXED_BASE_ENTRY,
            DERIVE_ENTRY,
        );
        let normalize_source = format!(
            "{}\n{}",
            <CurveImpl as GpuCurve>::MSM_G1_SUBSUM_SOURCE,
            NORMALIZE_ENTRY,
        );
        let (convert_pipeline, convert_layout) = pipeline(
            &device,
            "Vanity point conversion",
            aggregate_source.clone(),
            &[storage_entry(0, false)],
            "to_montgomery_bases_g1",
        );
        let derive_entries = [
            storage_entry(0, true),
            storage_entry(1, true),
            storage_entry(4, false),
            storage_entry(6, true),
        ];
        let (derive_one_pipeline, derive_one_layout) = pipeline(
            &device,
            "Vanity first derivation",
            aggregate_source.clone(),
            &derive_entries,
            "fixed_base_batch_add_one",
        );
        let (derive_each_pipeline, derive_each_layout) = pipeline(
            &device,
            "Vanity synthetic derivation",
            aggregate_source,
            &derive_entries,
            "fixed_base_batch_add_each",
        );
        let (normalize_pipeline, normalize_layout) = pipeline(
            &device,
            "Vanity affine normalization",
            normalize_source,
            &[storage_entry(0, true), storage_entry(3, false)],
            "normalize_fixed_base",
        );

        let table = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Vanity fixed-base table"),
            contents: &fixed_base_table(),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let account_point = serialize_point(G1Projective::from(account_affine));
        let account = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Vanity account public key"),
            contents: &account_point,
            usage: wgpu::BufferUsages::STORAGE,
        });
        let output_size = BATCH_CAPACITY as u64 * POINT_BYTES as u64;
        let scalar_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Vanity derivation scalars"),
            size: BATCH_CAPACITY as u64 * SCALAR_BYTES as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let projective_output = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Vanity projective keys"),
            size: output_size,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });
        let affine_output = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Vanity affine keys"),
            size: output_size,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let staging = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Vanity GPU readback"),
            size: output_size,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let table_convert_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Vanity table conversion"),
            layout: &convert_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: table.as_entire_binding(),
            }],
        });
        let account_convert_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Vanity account conversion"),
            layout: &convert_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: account.as_entire_binding(),
            }],
        });
        let convert_children_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Vanity child conversion"),
            layout: &convert_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: affine_output.as_entire_binding(),
            }],
        });
        let derive_one_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Vanity first derivation"),
            layout: &derive_one_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: table.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: scalar_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: projective_output.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 6,
                    resource: account.as_entire_binding(),
                },
            ],
        });
        let derive_each_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Vanity synthetic derivation"),
            layout: &derive_each_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: table.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: scalar_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: projective_output.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 6,
                    resource: affine_output.as_entire_binding(),
                },
            ],
        });
        let normalize_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Vanity normalization"),
            layout: &normalize_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: projective_output.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: affine_output.as_entire_binding(),
                },
            ],
        });

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Vanity static point conversion"),
        });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("Vanity static point conversion"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&convert_pipeline);
            pass.set_bind_group(0, &table_convert_group, &[]);
            pass.dispatch_workgroups(15, 1, 1);
            pass.set_bind_group(0, &account_convert_group, &[]);
            pass.dispatch_workgroups(1, 1, 1);
        }
        queue.submit(Some(encoder.finish()));

        Ok(Self {
            device,
            queue,
            adapter_name,
            account_public_key,
            convert_pipeline,
            derive_one_pipeline,
            derive_each_pipeline,
            normalize_pipeline,
            convert_children_group,
            derive_one_group,
            derive_each_group,
            normalize_group,
            scalar_buffer,
            affine_output,
            staging,
        })
    }

    async fn dispatch_stage(
        &self,
        derive_pipeline: &wgpu::ComputePipeline,
        derive_group: &wgpu::BindGroup,
        convert_children_first: bool,
    ) -> Result<Vec<u8>> {
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Vanity GPU derivation batch"),
            });
        if convert_children_first {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("Vanity child Montgomery conversion"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.convert_pipeline);
            pass.set_bind_group(0, &self.convert_children_group, &[]);
            pass.dispatch_workgroups(BATCH_CAPACITY.div_ceil(64), 1, 1);
        }
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("Vanity fixed-base derivation"),
                timestamp_writes: None,
            });
            pass.set_pipeline(derive_pipeline);
            pass.set_bind_group(0, derive_group, &[]);
            pass.dispatch_workgroups(BATCH_CAPACITY.div_ceil(64), 1, 1);
        }
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("Vanity affine normalization"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.normalize_pipeline);
            pass.set_bind_group(0, &self.normalize_group, &[]);
            pass.dispatch_workgroups(BATCH_CAPACITY.div_ceil(64), 1, 1);
        }
        encoder.copy_buffer_to_buffer(
            &self.affine_output,
            0,
            &self.staging,
            0,
            BATCH_CAPACITY as u64 * POINT_BYTES as u64,
        );
        self.queue.submit(Some(encoder.finish()));
        readback(&self.device, &self.staging).await
    }

    async fn derive_batch(
        &self,
        start_index: u32,
        step: u32,
    ) -> Result<Vec<[u8; PUBLIC_KEY_BYTES]>> {
        let children = self.derive_children(start_index, step).await?;

        let synthetic_scalars = second_stage_scalars(&children);
        self.queue
            .write_buffer(&self.scalar_buffer, 0, &synthetic_scalars);
        let synthetic_bytes = self
            .dispatch_stage(&self.derive_each_pipeline, &self.derive_each_group, true)
            .await?;
        compressed_points(&synthetic_bytes)
    }

    async fn derive_children(
        &self,
        start_index: u32,
        step: u32,
    ) -> Result<Vec<[u8; PUBLIC_KEY_BYTES]>> {
        let first_scalars = first_stage_scalars(&self.account_public_key, start_index, step);
        self.queue
            .write_buffer(&self.scalar_buffer, 0, &first_scalars);
        let child_bytes = self
            .dispatch_stage(&self.derive_one_pipeline, &self.derive_one_group, false)
            .await?;
        compressed_points(&child_bytes)
    }
}
