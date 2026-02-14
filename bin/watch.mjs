#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const currentFile = fileURLToPath(import.meta.url);
const scriptDir = dirname(currentFile);
const pluginRoot = resolve(scriptDir, '..');

function findProjectRoot(startDir) {
    let dir = startDir;

    while (dir !== '/') {
        if (existsSync(resolve(dir, 'vendor/shopware')) && existsSync(resolve(dir, 'var'))) {
            return dir;
        }

        dir = dirname(dir);
    }

    return null;
}

const projectRoot = findProjectRoot(pluginRoot);
if (!projectRoot) {
    console.error('Could not find Shopware project root.');
    process.exit(1);
}

const inContainer = existsSync('/.dockerenv');
const args = process.argv.slice(2);

console.warn('SidworksDevTools legacy watch.mjs is deprecated.');
console.warn('Forwarding to unified watcher: bin/watch-storefront.sh');

const child = inContainer
    ? spawn(resolve(projectRoot, 'bin/watch-storefront.sh'), ['--use-plugin-hot-proxy', ...args], {
        stdio: 'inherit',
        cwd: projectRoot,
        shell: true,
    })
    : spawn('ddev', ['exec', 'env', 'PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1', '/var/www/html/bin/watch-storefront.sh', '--use-plugin-hot-proxy', ...args], {
        stdio: 'inherit',
        cwd: projectRoot,
    });

child.on('exit', (code) => {
    process.exit(code ?? 0);
});

child.on('error', (error) => {
    console.error('Unable to start unified storefront watcher:', error.message);
    process.exit(1);
});
