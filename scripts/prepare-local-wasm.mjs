import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRoot = path.resolve(__dirname, '..');

const walletSdkRoot = path.join(appRoot, 'external', 'chia-wallet-sdk', 'wasm');
const walletSdkPkg = path.join(walletSdkRoot, 'pkg');

const vendorPkgRoot = path.join(appRoot, 'vendor-pkg');
const localWalletPkg = path.join(vendorPkgRoot, 'chia-wallet-sdk-wasm');

const llvmPrefix = '/opt/homebrew/opt/llvm';

function rmrf(target) {
    fs.rmSync(target, { recursive: true, force: true });
}

function mkdirp(target) {
    fs.mkdirSync(target, { recursive: true });
}

function copyDir(src, dst) {
    rmrf(dst);
    mkdirp(path.dirname(dst));
    fs.cpSync(src, dst, { recursive: true });
}

function existsDir(target) {
    return fs.existsSync(target) && fs.statSync(target).isDirectory();
}

function runWasmPackBuild(cwd) {
    execSync('wasm-pack build --target web --out-dir pkg', {
        cwd,
        stdio: 'inherit',
        env: {
            ...process.env,
            CC_wasm32_unknown_unknown: `${llvmPrefix}/bin/clang`,
            AR_wasm32_unknown_unknown: `${llvmPrefix}/bin/llvm-ar`,
            CFLAGS_wasm32_unknown_unknown: '--target=wasm32-unknown-unknown',
        },
    });
}

if (!existsDir(walletSdkRoot)) {
    throw new Error(
        'Missing external/chia-wallet-sdk submodule. Run: git submodule update --init --recursive',
    );
}

mkdirp(vendorPkgRoot);

console.log('Building chia-wallet-sdk-wasm...');
runWasmPackBuild(walletSdkRoot);

console.log('Copying local wasm packages...');
copyDir(walletSdkPkg, localWalletPkg);

console.log('Local wasm packages prepared.');
