import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appRoot, '..');

const distDir = path.join(appRoot, 'dist');
const buildRoot = path.join(repoRoot, 'build');
const packageDir = path.join(buildRoot, 'chia-vanity');
const packageDistDir = path.join(packageDir, 'dist');
const sourceIcon = path.join(appRoot, 'src-tauri', 'icons', '128x128.png');
const targetIcon = path.join(packageDir, 'icon.png');

const manifest = {
    name: 'Chia Vanity',
    version: '0.1.0',
    permissions: {
        network: false,
        persistent_storage: true,
    },
};

function rmrf(target) {
    fs.rmSync(target, { recursive: true, force: true });
}

function mkdirp(target) {
    fs.mkdirSync(target, { recursive: true });
}

function copyDir(src, dst) {
    fs.cpSync(src, dst, { recursive: true });
}

if (!fs.existsSync(distDir)) {
    throw new Error('Missing dist/. Run pnpm build first.');
}

if (!fs.existsSync(sourceIcon)) {
    throw new Error(`Missing icon at ${sourceIcon}`);
}

mkdirp(buildRoot);
rmrf(packageDir);
mkdirp(packageDir);

copyDir(distDir, packageDistDir);
fs.copyFileSync(sourceIcon, targetIcon);

fs.writeFileSync(
    path.join(packageDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
);

console.log(`Sage package assembled at: ${packageDir}`);
