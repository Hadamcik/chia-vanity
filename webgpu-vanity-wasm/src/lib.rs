use std::borrow::Cow;
use std::hint::black_box;

use anyhow::{Context, Result};
use blstrs::{G1Affine, G1Projective, Scalar};
use futures::channel::oneshot;
use group::{Curve, Group, GroupEncoding};
use serde::Serialize;
use sha2::{Digest, Sha256};
use wasm_bindgen::prelude::*;
use web_time::Instant;
use webgpu_groth16::gpu::curve::GpuCurve;
use wgpu::util::DeviceExt;

mod search;

pub use search::WebGpuVanitySearch;

pub(crate) type CurveImpl = blstrs::Bls12;

pub(crate) const POINT_BYTES: usize = 384;
pub(crate) const WINDOW_BITS: usize = 4;
pub(crate) const WINDOWS: usize = 256 / WINDOW_BITS;
pub(crate) const TABLE_POINTS_PER_WINDOW: usize = (1 << WINDOW_BITS) - 1;
const Q_MODULUS_13: [u32; 30] = [
    0x0aab, 0x1ffd, 0x1fff, 0x1dff, 0x1b9f, 0x1fff, 0x054f, 0x1fd6, 0x0bff, 0x00f5, 0x1d89, 0x0d61,
    0x0a0f, 0x1869, 0x1d9c, 0x0257, 0x1385, 0x1c27, 0x1dd2, 0x0ec8, 0x1acd, 0x01a5, 0x1ed9, 0x0374,
    0x1a4b, 0x1f34, 0x0e5f, 0x03d4, 0x0011, 0x000d,
];

pub(crate) const FIXED_BASE_ENTRY: &str = r#"
fn scalar_nibble(point_index: u32, window: u32) -> u32 {
    let word = base_indices[point_index * 8u + window / 8u];
    return (word >> ((window % 8u) * 4u)) & 0x0fu;
}

@compute @workgroup_size(64)
fn fixed_base_batch(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let point_index = global_id.x;
    if point_index >= arrayLength(&aggregated_buckets_g1) { return; }

    var sum = G1_INFINITY;
    for (var window = 0u; window < 64u; window = window + 1u) {
        let digit = scalar_nibble(point_index, window);
        if digit != 0u {
            let table_index = window * 15u + digit - 1u;
            sum = add_g1_mixed_safe(sum, load_g1_mont(bases_g1[table_index]));
        }
    }
    aggregated_buckets_g1[point_index] = sum;
}
"#;

pub(crate) const DERIVE_ENTRY: &str = r#"
@group(0) @binding(6) var<storage, read> fixed_addends: array<PointG1>;

fn fixed_base_mul(point_index: u32) -> PointG1 {
    var sum = G1_INFINITY;
    for (var window = 0u; window < 64u; window = window + 1u) {
        let digit = scalar_nibble(point_index, window);
        if digit != 0u {
            let table_index = window * 15u + digit - 1u;
            sum = add_g1_mixed_safe(sum, load_g1_mont(bases_g1[table_index]));
        }
    }
    return sum;
}

@compute @workgroup_size(64)
fn fixed_base_batch_add_one(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let point_index = global_id.x;
    if point_index >= arrayLength(&aggregated_buckets_g1) { return; }
    let product = fixed_base_mul(point_index);
    aggregated_buckets_g1[point_index] = add_g1_mixed_safe(product, fixed_addends[0]);
}

@compute @workgroup_size(64)
fn fixed_base_batch_add_each(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let point_index = global_id.x;
    if point_index >= arrayLength(&aggregated_buckets_g1) { return; }
    let product = fixed_base_mul(point_index);
    aggregated_buckets_g1[point_index] = add_g1_mixed_safe(product, fixed_addends[point_index]);
}
"#;

pub(crate) const NORMALIZE_ENTRY: &str = r#"
@compute @workgroup_size(64)
fn normalize_fixed_base(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let point_index = global_id.x;
    if point_index >= arrayLength(&partial_sums_g1) { return; }
    partial_sums_g1[point_index] = store_g1(agg_ph1_g1[point_index]);
}
"#;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkResult {
    adapter: String,
    count: u32,
    repetitions: u32,
    initialization_ms: f64,
    gpu_samples_ms: Vec<f64>,
    gpu_median_ms: f64,
    gpu_points_per_second: f64,
    cpu_samples_ms: Vec<f64>,
    cpu_median_ms: f64,
    cpu_points_per_second: f64,
    speedup: f64,
    cpu_bridge_samples_ms: Vec<f64>,
    cpu_bridge_median_ms: f64,
    estimated_two_stage_points_per_second: f64,
    correct: bool,
}

pub(crate) fn storage_entry(binding: u32, read_only: bool) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Storage { read_only },
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    }
}

pub(crate) fn pipeline(
    device: &wgpu::Device,
    label: &str,
    source: String,
    entries: &[wgpu::BindGroupLayoutEntry],
    entry_point: &str,
) -> (wgpu::ComputePipeline, wgpu::BindGroupLayout) {
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some(label),
        source: wgpu::ShaderSource::Wgsl(Cow::Owned(source)),
    });
    let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some(label),
        entries,
    });
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some(label),
        bind_group_layouts: &[&bind_group_layout],
        immediate_size: 0,
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some(label),
        layout: Some(&pipeline_layout),
        module: &module,
        entry_point: Some(entry_point),
        compilation_options: Default::default(),
        cache: None,
    });
    (pipeline, bind_group_layout)
}

pub(crate) fn serialize_point(point: G1Projective) -> Vec<u8> {
    <CurveImpl as GpuCurve>::serialize_g1(&point.to_affine())
}

fn gpu_coordinate_limb(point: &[u8], coordinate_offset: usize, limb: usize) -> u32 {
    let offset = coordinate_offset + limb * 4;
    u32::from_le_bytes(
        point[offset..offset + 4]
            .try_into()
            .expect("GPU point limb"),
    )
}

fn gpu_coordinate_to_be_bytes(point: &[u8], coordinate_offset: usize) -> [u8; 48] {
    let mut little_endian = [0_u8; 50];

    for limb_index in 0..30 {
        let limb = gpu_coordinate_limb(point, coordinate_offset, limb_index) & 0x1fff;
        let bit_offset = limb_index * 13;
        let byte_offset = bit_offset / 8;
        let shift = bit_offset % 8;
        let shifted = limb << shift;
        little_endian[byte_offset] |= shifted as u8;
        little_endian[byte_offset + 1] |= (shifted >> 8) as u8;
        little_endian[byte_offset + 2] |= (shifted >> 16) as u8;
    }

    debug_assert_eq!(little_endian[48], 0);
    debug_assert_eq!(little_endian[49], 0);
    let mut big_endian = [0_u8; 48];
    for (index, byte) in little_endian[..48].iter().rev().enumerate() {
        big_endian[index] = *byte;
    }
    big_endian
}

fn gpu_y_is_lexicographically_largest(point: &[u8]) -> bool {
    let mut half_modulus = [0_u32; 30];
    let mut carry = 0_u32;
    for index in (0..30).rev() {
        half_modulus[index] = (Q_MODULUS_13[index] >> 1) | (carry << 12);
        carry = Q_MODULUS_13[index] & 1;
    }

    for index in (0..30).rev() {
        let y_limb = gpu_coordinate_limb(point, 128, index);
        if y_limb != half_modulus[index] {
            return y_limb > half_modulus[index];
        }
    }
    false
}

pub(crate) fn compress_gpu_point(point: &[u8]) -> Result<[u8; 48]> {
    anyhow::ensure!(point.len() >= POINT_BYTES, "GPU point is truncated");
    let mut compressed = gpu_coordinate_to_be_bytes(point, 0);
    compressed[0] |= 0x80;
    if gpu_y_is_lexicographically_largest(point) {
        compressed[0] |= 0x20;
    }
    Ok(compressed)
}

pub(crate) fn fixed_base_table() -> Vec<u8> {
    let mut table = Vec::with_capacity(WINDOWS * TABLE_POINTS_PER_WINDOW * POINT_BYTES);
    let mut window_base = G1Projective::generator();

    for _ in 0..WINDOWS {
        let mut multiple = window_base;
        for _ in 1..=TABLE_POINTS_PER_WINDOW {
            table.extend_from_slice(&serialize_point(multiple));
            multiple += window_base;
        }
        for _ in 0..WINDOW_BITS {
            window_base = window_base.double();
        }
    }
    table
}

fn deterministic_scalars(count: usize) -> Result<(Vec<Scalar>, Vec<u8>)> {
    let mut scalars = Vec::with_capacity(count);
    let mut bytes = Vec::with_capacity(count * 32);
    let mut state = 0x9e37_79b9_7f4a_7c15_u64;

    for index in 0..count {
        let mut encoded = [0_u8; 32];
        for chunk in encoded.chunks_exact_mut(8) {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            chunk.copy_from_slice(&state.to_le_bytes());
        }
        encoded[31] &= 0x3f;
        encoded[0] ^= index as u8;
        let scalar = Option::<Scalar>::from(Scalar::from_bytes_le(&encoded))
            .context("generated scalar was not canonical")?;
        scalars.push(scalar);
        bytes.extend_from_slice(&encoded);
    }
    Ok((scalars, bytes))
}

pub(crate) async fn readback(_device: &wgpu::Device, buffer: &wgpu::Buffer) -> Result<Vec<u8>> {
    let slice = buffer.slice(..);
    let (sender, receiver) = oneshot::channel();
    slice.map_async(wgpu::MapMode::Read, move |result| {
        let _ = sender.send(result);
    });
    receiver.await.context("GPU readback channel closed")??;
    let bytes = slice.get_mapped_range().to_vec();
    let _ = slice;
    buffer.unmap();
    Ok(bytes)
}

async fn dispatch(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    multiply_pipeline: &wgpu::ComputePipeline,
    multiply_group: &wgpu::BindGroup,
    normalize_pipeline: &wgpu::ComputePipeline,
    normalize_group: &wgpu::BindGroup,
    affine_output: &wgpu::Buffer,
    staging: &wgpu::Buffer,
    count: u32,
) -> Result<Vec<u8>> {
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("Vanity fixed-base benchmark"),
    });
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("Fixed-base multiplication"),
            timestamp_writes: None,
        });
        pass.set_pipeline(multiply_pipeline);
        pass.set_bind_group(0, multiply_group, &[]);
        pass.dispatch_workgroups(count.div_ceil(64), 1, 1);
    }
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("Affine normalization"),
            timestamp_writes: None,
        });
        pass.set_pipeline(normalize_pipeline);
        pass.set_bind_group(0, normalize_group, &[]);
        pass.dispatch_workgroups(count.div_ceil(64), 1, 1);
    }
    encoder.copy_buffer_to_buffer(
        affine_output,
        0,
        staging,
        0,
        count as u64 * POINT_BYTES as u64,
    );
    queue.submit(Some(encoder.finish()));
    readback(device, staging).await
}

fn median(samples: &[f64]) -> f64 {
    let mut sorted = samples.to_vec();
    sorted.sort_by(f64::total_cmp);
    sorted[sorted.len() / 2]
}

#[wasm_bindgen(js_name = runFixedBaseBenchmark)]
pub async fn run_fixed_base_benchmark(count: u32, repetitions: u32) -> Result<JsValue, JsValue> {
    console_error_panic_hook::set_once();
    let result = run(count, repetitions)
        .await
        .map_err(|error| JsValue::from_str(&format!("{error:#}")))?;
    serde_wasm_bindgen::to_value(&result).map_err(|error| JsValue::from_str(&error.to_string()))
}

async fn run(count: u32, repetitions: u32) -> Result<BenchmarkResult> {
    anyhow::ensure!(count > 0, "count must be greater than zero");
    anyhow::ensure!(repetitions > 0, "repetitions must be greater than zero");

    let init_started = Instant::now();
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
            label: Some("Vanity WebGPU prototype"),
            required_features: wgpu::Features::empty(),
            required_limits: adapter.limits(),
            ..Default::default()
        })
        .await
        .context("failed to request WebGPU device")?;

    let aggregate_source = format!(
        "{}\n{}",
        <CurveImpl as GpuCurve>::MSM_G1_AGG_SOURCE,
        FIXED_BASE_ENTRY,
    );
    let normalize_source = format!(
        "{}\n{}",
        <CurveImpl as GpuCurve>::MSM_G1_SUBSUM_SOURCE,
        NORMALIZE_ENTRY,
    );
    let (convert_pipeline, convert_layout) = pipeline(
        &device,
        "BLS12-381 table conversion",
        aggregate_source.clone(),
        &[storage_entry(0, false)],
        "to_montgomery_bases_g1",
    );
    let (multiply_pipeline, multiply_layout) = pipeline(
        &device,
        "BLS12-381 fixed-base multiplication",
        aggregate_source,
        &[
            storage_entry(0, true),
            storage_entry(1, true),
            storage_entry(4, false),
        ],
        "fixed_base_batch",
    );
    let (normalize_pipeline, normalize_layout) = pipeline(
        &device,
        "BLS12-381 affine normalization",
        normalize_source,
        &[storage_entry(0, true), storage_entry(3, false)],
        "normalize_fixed_base",
    );

    let table_bytes = fixed_base_table();
    let (scalars, scalar_bytes) = deterministic_scalars(count as usize)?;
    let table = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("Fixed-base lookup table"),
        contents: &table_bytes,
        usage: wgpu::BufferUsages::STORAGE,
    });
    let scalar_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("Fixed-base scalars"),
        contents: &scalar_bytes,
        usage: wgpu::BufferUsages::STORAGE,
    });
    let output_size = count as u64 * POINT_BYTES as u64;
    let projective_output = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Projective results"),
        size: output_size,
        usage: wgpu::BufferUsages::STORAGE,
        mapped_at_creation: false,
    });
    let affine_output = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Affine results"),
        size: output_size,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let staging = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Fixed-base readback"),
        size: output_size,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });

    let convert_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("Table conversion"),
        layout: &convert_layout,
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: table.as_entire_binding(),
        }],
    });
    let multiply_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("Fixed-base multiplication"),
        layout: &multiply_layout,
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
        ],
    });
    let normalize_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("Fixed-base normalization"),
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
        label: Some("Lookup table conversion"),
    });
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("Lookup table conversion"),
            timestamp_writes: None,
        });
        pass.set_pipeline(&convert_pipeline);
        pass.set_bind_group(0, &convert_group, &[]);
        pass.dispatch_workgroups((WINDOWS * TABLE_POINTS_PER_WINDOW) as u32 / 64, 1, 1);
    }
    queue.submit(Some(encoder.finish()));

    let initialization_ms = init_started.elapsed().as_secs_f64() * 1000.0;
    let warmup = dispatch(
        &device,
        &queue,
        &multiply_pipeline,
        &multiply_group,
        &normalize_pipeline,
        &normalize_group,
        &affine_output,
        &staging,
        count,
    )
    .await?;

    let correct = warmup
        .chunks_exact(POINT_BYTES)
        .zip(scalars.iter())
        .all(|(bytes, scalar)| {
            let Ok(actual) = <CurveImpl as GpuCurve>::deserialize_g1(bytes) else {
                return false;
            };
            let expected = G1Projective::generator() * scalar;
            actual == expected
                && compress_gpu_point(bytes).is_ok_and(|compressed| {
                    compressed.as_slice() == expected.to_affine().to_bytes().as_ref()
                })
        });

    let mut gpu_samples_ms = Vec::with_capacity(repetitions as usize);
    for _ in 0..repetitions {
        let started = Instant::now();
        black_box(
            dispatch(
                &device,
                &queue,
                &multiply_pipeline,
                &multiply_group,
                &normalize_pipeline,
                &normalize_group,
                &affine_output,
                &staging,
                count,
            )
            .await?,
        );
        gpu_samples_ms.push(started.elapsed().as_secs_f64() * 1000.0);
    }

    let mut cpu_samples_ms = Vec::with_capacity(repetitions as usize);
    for _ in 0..repetitions {
        let started = Instant::now();
        let mut checksum = 0_u8;
        for scalar in &scalars {
            let affine = G1Affine::from(G1Projective::generator() * scalar);
            checksum ^= affine.to_bytes().as_ref()[0];
        }
        black_box(checksum);
        cpu_samples_ms.push(started.elapsed().as_secs_f64() * 1000.0);
    }

    // A complete Chia public-key search has a dependency between its two
    // fixed-base multiplications: the first point must be compressed and
    // hashed before the second scalar is known. Measure that CPU handoff so
    // the prototype does not pretend the multiplication speedup is the final
    // end-to-end result.
    let hidden_puzzle_hash = [
        0x71, 0x1d, 0x6c, 0x4e, 0x32, 0xc9, 0x2e, 0x53, 0x17, 0x9b, 0x19, 0x94, 0x84, 0xcf, 0x8c,
        0x89, 0x75, 0x42, 0xbc, 0x57, 0xf2, 0xb2, 0x25, 0x82, 0x79, 0x9f, 0x9d, 0x65, 0x7e, 0xec,
        0x46, 0x99,
    ];
    let mut cpu_bridge_samples_ms = Vec::with_capacity(repetitions as usize);
    for _ in 0..repetitions {
        let started = Instant::now();
        let mut checksum = 0_u8;
        for bytes in warmup.chunks_exact(POINT_BYTES) {
            let compressed = compress_gpu_point(bytes)?;
            let digest = Sha256::new()
                .chain_update(compressed)
                .chain_update(hidden_puzzle_hash)
                .finalize();
            checksum ^= digest[0];
        }
        black_box(checksum);
        cpu_bridge_samples_ms.push(started.elapsed().as_secs_f64() * 1000.0);
    }

    let gpu_median_ms = median(&gpu_samples_ms);
    let cpu_median_ms = median(&cpu_samples_ms);
    let cpu_bridge_median_ms = median(&cpu_bridge_samples_ms);
    Ok(BenchmarkResult {
        adapter: adapter_name,
        count,
        repetitions,
        initialization_ms,
        gpu_samples_ms,
        gpu_median_ms,
        gpu_points_per_second: count as f64 / (gpu_median_ms / 1000.0),
        cpu_samples_ms,
        cpu_median_ms,
        cpu_points_per_second: count as f64 / (cpu_median_ms / 1000.0),
        speedup: cpu_median_ms / gpu_median_ms,
        cpu_bridge_samples_ms,
        cpu_bridge_median_ms,
        estimated_two_stage_points_per_second: count as f64
            / ((2.0 * (gpu_median_ms + cpu_bridge_median_ms)) / 1000.0),
        correct,
    })
}
