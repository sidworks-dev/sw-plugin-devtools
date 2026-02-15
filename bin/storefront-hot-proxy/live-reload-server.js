/* eslint no-console: 0 */

const path = require('node:path');
const loadPatchedWebpackConfig = require('./patch-webpack-config');
const {
    resolveProjectRoot,
    createStorefrontRequire,
} = require('./runtime-paths');

const ANSI = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
};

module.exports = function createLiveReloadServer(sslOptions) {
    return new Promise((resolve, reject) => {
        const projectRoot = resolveProjectRoot(__dirname);
        const storefrontRequire = createStorefrontRequire(projectRoot);
        const webpack = storefrontRequire('webpack');
        const WebpackDevServer = storefrontRequire('webpack-dev-server');
        const verboseWebpackOutput = process.env.SHOPWARE_STOREFRONT_VERBOSE_WEBPACK === '1';
        const jsCompileFeedbackEnabled = process.env.SHOPWARE_STOREFRONT_JS_COMPILE_FEEDBACK !== '0';

        const webpackConfig = loadPatchedWebpackConfig(projectRoot);
        const compiler = webpack(webpackConfig);
        const coreWebpackConfig = Array.isArray(webpackConfig) ? webpackConfig[0] : webpackConfig;

        if (jsCompileFeedbackEnabled) {
            attachCompileFeedback(compiler, projectRoot);
        }

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
                stats: verboseWebpackOutput ? { colors: true } : 'errors-only',
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
    const state = {
        initialized: false,
        compileInFlight: false,
        waitLogged: false,
        startedAt: 0,
        activeReasonLabel: 'change',
        pendingChangedFiles: new Set(),
    };

    compiler.hooks.invalid.tap('SidworksCompileFeedback', (changedFile) => {
        const shortFile = formatChangedFile(changedFile, projectRoot);
        if (shortFile) {
            state.pendingChangedFiles.add(shortFile);
        }

        if (!state.initialized) {
            return;
        }

        if (!state.compileInFlight) {
            state.startedAt = Date.now();
            state.compileInFlight = true;
            state.waitLogged = false;
            const changedSummary = summarizeFiles([...state.pendingChangedFiles]);
            state.activeReasonLabel = changedSummary ? `change: ${changedSummary}` : 'change';
            logJs(`${colorize('[RUN]', ANSI.yellow)} compiling (${state.activeReasonLabel})`);
            return;
        }

        if (state.waitLogged) {
            return;
        }

        const queuedFiles = summarizeFiles([...state.pendingChangedFiles]);
        if (queuedFiles) {
            logJs(`${colorize('[WAIT]', ANSI.yellow)} change queued while compile is running (${queuedFiles})`);
        } else {
            logJs(`${colorize('[WAIT]', ANSI.yellow)} change queued while compile is running`);
        }
        state.waitLogged = true;
    });

    compiler.hooks.done.tap('SidworksCompileFeedback', (stats) => {
        if (!state.initialized) {
            state.initialized = true;
            state.pendingChangedFiles.clear();
            return;
        }

        if (!state.compileInFlight) {
            return;
        }

        const duration = getCompileDurationMs(stats, state.startedAt);
        if (stats?.hasErrors && stats.hasErrors()) {
            const errorMessage = summarizeFirstError(stats);
            const suffix = errorMessage ? `: ${errorMessage}` : '';
            logJsError(`${colorize('[ERR]', ANSI.red)} compile failed (${state.activeReasonLabel}) after ${duration}ms${suffix}`);
        } else {
            logJs(`${colorize('[OK]', ANSI.green)} compiled (${state.activeReasonLabel}) in ${duration}ms`);
        }

        state.compileInFlight = false;
        state.waitLogged = false;
        state.pendingChangedFiles.clear();
    });
}

function formatChangedFile(changedFile, projectRoot) {
    if (typeof changedFile !== 'string' || changedFile === '') {
        return '';
    }

    const normalizedRoot = path.resolve(projectRoot);
    const normalizedFile = path.resolve(changedFile);
    if (normalizedFile.startsWith(normalizedRoot + path.sep)) {
        return path.relative(normalizedRoot, normalizedFile).replace(/\\/g, '/');
    }

    return changedFile.replace(/\\/g, '/');
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

function hasInteractiveTty() {
    return Boolean(process.stdout && process.stdout.isTTY);
}

function colorize(text, colorCode) {
    if (!hasInteractiveTty()) {
        return text;
    }

    return `${colorCode}${text}${ANSI.reset}`;
}

function logJs(message) {
    const tag = colorize('[JS]', ANSI.cyan);
    console.log(`[SidworksDevTools] ${tag} ${message}`);
}

function logJsError(message) {
    const tag = colorize('[JS]', ANSI.cyan);
    console.error(`[SidworksDevTools] ${tag} ${message}`);
}

function getCompileDurationMs(stats, startedAt) {
    const startTime = Number(stats?.startTime);
    const endTime = Number(stats?.endTime);
    if (Number.isFinite(startTime) && Number.isFinite(endTime) && endTime >= startTime) {
        return Math.round(endTime - startTime);
    }

    if (Number.isFinite(startedAt) && startedAt > 0) {
        return Math.max(0, Date.now() - startedAt);
    }

    return 0;
}

function summarizeFirstError(stats) {
    try {
        const json = stats.toJson({
            all: false,
            errors: true,
            errorDetails: false,
        });
        const firstError = Array.isArray(json?.errors) ? json.errors[0] : null;
        if (!firstError) {
            return '';
        }

        if (typeof firstError === 'string') {
            return compactLine(firstError);
        }

        if (typeof firstError.message === 'string') {
            return compactLine(firstError.message);
        }

        return '';
    } catch (_error) {
        return '';
    }
}

function compactLine(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 220);
}
