/* eslint no-console: 0 */

const path = require('node:path');
const loadPatchedWebpackConfig = require('./patch-webpack-config');
const {
    resolveProjectRoot,
    createStorefrontRequire,
} = require('./runtime-paths');

module.exports = function createLiveReloadServer(sslOptions) {
    return new Promise((resolve, reject) => {
        const projectRoot = resolveProjectRoot(__dirname);
        const storefrontRequire = createStorefrontRequire(projectRoot);
        const webpack = storefrontRequire('webpack');
        const WebpackDevServer = storefrontRequire('webpack-dev-server');

        const webpackConfig = loadPatchedWebpackConfig(projectRoot);
        const compiler = webpack(webpackConfig);
        const coreWebpackConfig = Array.isArray(webpackConfig) ? webpackConfig[0] : webpackConfig;

        attachCompileFeedback(compiler, projectRoot);

        let serverConfig = {
            type: 'http',
        };
        if (Object.keys(sslOptions).length !== 0) {
            serverConfig = {
                type: 'https',
                options: sslOptions,
            };
        }

        const baseDevServer = coreWebpackConfig.devServer || {};
        const devServerOptions = {
            ...baseDevServer,
            open: false,
            host: '0.0.0.0',
            server: serverConfig,
            devMiddleware: {
                ...(baseDevServer.devMiddleware || {}),
                stats: {
                    colors: true,
                },
            },
        };

        const server = new WebpackDevServer(devServerOptions, compiler);

        (async () => {
            try {
                await server.start();
            } catch (error) {
                reject(error);
                return;
            }

            console.log('Starting the SidworksDevTools hot reload server:\n');
        })();

        compiler.hooks.done.tap('resolveServer', () => {
            resolve(server);
        });
    });
};

function attachCompileFeedback(compiler, projectRoot) {
    const compilers = Array.isArray(compiler.compilers) ? compiler.compilers : [compiler];

    for (const currentCompiler of compilers) {
        const compilerName = currentCompiler.options?.name || 'shopware-6-storefront';
        let initialBuildLogged = false;
        const pendingChangedFiles = new Set();

        currentCompiler.hooks.watchRun.tap('SidworksCompileFeedback', (watchingCompiler) => {
            const changedFromWebpack = collectChangedFilesFromCompiler(watchingCompiler, projectRoot);
            for (const file of changedFromWebpack) {
                pendingChangedFiles.add(file);
            }

            const changedSummary = summarizeFiles([...pendingChangedFiles]);
            if (initialBuildLogged) {
                if (changedSummary) {
                    console.log(`[SidworksDevTools] ${compilerName}: rebuild started (${changedSummary})`);
                } else {
                    console.log(`[SidworksDevTools] ${compilerName}: rebuild started`);
                }
                pendingChangedFiles.clear();
                return;
            }

            initialBuildLogged = true;
            if (changedSummary) {
                console.log(`[SidworksDevTools] ${compilerName}: initial build started (${changedSummary})`);
            } else {
                console.log(`[SidworksDevTools] ${compilerName}: initial build started`);
            }
            pendingChangedFiles.clear();
        });

        currentCompiler.hooks.invalid.tap('SidworksCompileFeedback', (changedFile) => {
            const shortFile = formatChangedFile(changedFile, projectRoot);
            if (shortFile) {
                pendingChangedFiles.add(shortFile);
                console.log(`[SidworksDevTools] ${compilerName}: changed (${shortFile})`);
            } else {
                console.log(`[SidworksDevTools] ${compilerName}: changed`);
            }
        });
    }
}

function formatChangedFile(changedFile, projectRoot) {
    if (typeof changedFile !== 'string' || changedFile === '') {
        return '';
    }

    const normalizedRoot = path.resolve(projectRoot);
    const normalizedFile = path.resolve(changedFile);
    if (normalizedFile.startsWith(normalizedRoot + path.sep)) {
        return path.relative(normalizedRoot, normalizedFile);
    }

    return changedFile;
}

function collectChangedFilesFromCompiler(compiler, projectRoot) {
    const changed = [];

    if (compiler?.modifiedFiles instanceof Set) {
        for (const modifiedFile of compiler.modifiedFiles) {
            const shortFile = formatChangedFile(modifiedFile, projectRoot);
            if (shortFile) {
                changed.push(shortFile);
            }
        }
    }

    if (compiler?.removedFiles instanceof Set) {
        for (const removedFile of compiler.removedFiles) {
            const shortFile = formatChangedFile(removedFile, projectRoot);
            if (shortFile) {
                changed.push(`${shortFile} (removed)`);
            }
        }
    }

    return [...new Set(changed)];
}

function summarizeFiles(files) {
    const uniqueFiles = [...new Set((files || []).filter((file) => typeof file === 'string' && file !== ''))];
    if (uniqueFiles.length === 0) {
        return '';
    }

    if (uniqueFiles.length <= 3) {
        return uniqueFiles.join(', ');
    }

    return `${uniqueFiles.slice(0, 3).join(', ')} +${uniqueFiles.length - 3} more`;
}
