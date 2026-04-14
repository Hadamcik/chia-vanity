import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appRoot, '..');

const buildRoot = path.join(repoRoot, 'build');
const packageDir = path.join(buildRoot, 'chia-vanity');
const zipPath = path.join(buildRoot, 'chia-vanity.zip');

if (!fs.existsSync(packageDir)) {
    throw new Error(`Missing package directory at ${packageDir}. Run pnpm build:sage-package first.`);
}

fs.rmSync(zipPath, { force: true });

execSync(`cd "${buildRoot}" && zip -r "chia-vanity.zip" "chia-vanity"`, {
    stdio: 'inherit',
});

console.log(`Sage zip created at: ${zipPath}`);
