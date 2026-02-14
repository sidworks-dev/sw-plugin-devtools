const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

const {
    resolveProjectRoot,
    resolveStorefrontApp,
    createStorefrontRequire,
} = require('./runtime-paths');

const storefrontSassDeprecationsList = ['import', 'global-builtin', 'color-functions', 'slash-div', 'legacy-js-api'];

function asBoolean(value, defaultValue) {
    if (typeof value === 'undefined' || value === '') {
        return defaultValue;
    }

    return value !== '0' && value !== 'false';
}

function toArray(value) {
    if (Array.isArray(value)) {
        return value;
    }

    if (typeof value === 'undefined' || value === null || value === '') {
        return [];
    }

    return [value];
}

function asString(value, defaultValue) {
    if (typeof value === 'undefined' || value === null || value === '') {
        return defaultValue;
    }

    return String(value);
}

function getSassDeprecationsToSilence(sassImplementation) {
    const silenced = [...storefrontSassDeprecationsList];
    const implementationInfo = String(sassImplementation?.info || '').toLowerCase();

    // `mixed-decls` is obsolete in newer sass-embedded versions and can emit
    // an extra warning if we try to silence it there.
    if (!implementationInfo.includes('sass-embedded')) {
        silenced.push('mixed-decls');
    }

    return silenced;
}

function resolveWebSocketHostname() {
    const fallbackHost = 'localhost';
    const sourceUrl = process.env.PROXY_URL || process.env.APP_URL || '';

    if (!sourceUrl) {
        return fallbackHost;
    }

    try {
        return new URL(sourceUrl).hostname;
    } catch (_error) {
        return fallbackHost;
    }
}

function normalizeLoaderRuleEntry(entry) {
    if (typeof entry === 'string') {
        return {
            loader: entry,
            options: {},
        };
    }

    if (!entry || typeof entry !== 'object') {
        return entry;
    }

    return {
        ...entry,
        options: {
            ...(entry.options || {}),
        },
    };
}

function isCssLoader(loaderName) {
    return loaderName.includes('css-loader') && !loaderName.includes('postcss-loader');
}

function isPostCssLoader(loaderName) {
    return loaderName.includes('postcss-loader');
}

function isSassLoader(loaderName) {
    return loaderName.includes('sass-loader');
}

function findScssRule(rules) {
    if (!Array.isArray(rules)) {
        return null;
    }

    for (const rule of rules) {
        if (!rule || typeof rule !== 'object') {
            continue;
        }

        if (rule.test instanceof RegExp && rule.test.test('.scss') && Array.isArray(rule.use)) {
            return rule;
        }

        if (Array.isArray(rule.oneOf)) {
            const found = findScssRule(rule.oneOf);
            if (found) {
                return found;
            }
        }

        if (Array.isArray(rule.rules)) {
            const found = findScssRule(rule.rules);
            if (found) {
                return found;
            }
        }
    }

    return null;
}

function patchScssRule(scssRule, options) {
    if (!scssRule || !Array.isArray(scssRule.use)) {
        return;
    }

    const patchedUse = [];

    for (const useEntry of scssRule.use) {
        const normalized = normalizeLoaderRuleEntry(useEntry);
        const loaderName = typeof normalized?.loader === 'string' ? normalized.loader : '';

        if (options.skipPostCss && isPostCssLoader(loaderName)) {
            continue;
        }

        if (!loaderName) {
            patchedUse.push(normalized);
            continue;
        }

        if (isCssLoader(loaderName)) {
            normalized.options.sourceMap = options.scssSourceMapEnabled;
            if (typeof normalized.options.url === 'undefined') {
                normalized.options.url = false;
            }
        }

        if (isPostCssLoader(loaderName)) {
            normalized.options.sourceMap = options.scssSourceMapEnabled;
            if (!normalized.options.postcssOptions) {
                normalized.options.postcssOptions = {
                    config: false,
                };
            }
        }

        if (isSassLoader(loaderName)) {
            const existingSassOptions = normalized.options.sassOptions || {};

            normalized.options.sourceMap = options.scssSourceMapEnabled;
            normalized.options.implementation = options.sassImplementation;
            normalized.options.warnRuleAsWarning = false;
            normalized.options.sassOptions = {
                ...existingSassOptions,
                quietDeps: true,
                silenceDeprecations: options.silenceSassDeprecations ? options.sassDeprecationsToSilence : [],
            };
        }

        patchedUse.push(normalized);
    }

    scssRule.use = patchedUse;
}

function patchWatchFiles(coreConfig, options) {
    if (!coreConfig.devServer) {
        return;
    }

    const defaultIgnored = [
        '**/.git/**',
        '**/node_modules/**',
        '**/public/theme/**',
        '**/var/cache/**',
    ];

    if (!coreConfig.devServer.watchFiles) {
        coreConfig.devServer.watchFiles = {
            options: {},
        };
    }

    const watchFiles = coreConfig.devServer.watchFiles;
    watchFiles.options = watchFiles.options || {};

    if (options.twigWatchMode === 'narrow') {
        watchFiles.paths = [
            'custom/plugins/**/src/Resources/views/**/*.twig',
            'custom/apps/**/Resources/views/**/*.twig',
            'src/Resources/views/**/*.twig',
            'templates/**/*.twig',
            'vendor/shopware/storefront/Resources/views/**/*.twig',
        ];
    }

    const mergedIgnored = [...new Set([...toArray(watchFiles.options.ignored), ...defaultIgnored])];
    watchFiles.options.ignored = mergedIgnored;
}

function loadPatchedWebpackConfig(explicitProjectRoot) {
    const projectRoot = explicitProjectRoot || resolveProjectRoot(__dirname);
    const storefrontApp = resolveStorefrontApp(projectRoot);
    const storefrontRequire = createStorefrontRequire(projectRoot);
    const runtimeRequire = createRequire(__filename);
    const coreWebpackConfigPath = path.resolve(storefrontApp, 'webpack.config.js');

    const useSassEmbedded = asBoolean(process.env.SHOPWARE_STOREFRONT_USE_SASS_EMBEDDED, true);
    const devCacheEnabled = asBoolean(process.env.SHOPWARE_STOREFRONT_DEV_CACHE, true);
    const jsSourceMapEnabled = asBoolean(process.env.SHOPWARE_STOREFRONT_JS_SOURCE_MAP, false);
    const scssSourceMapEnabled = asBoolean(process.env.SHOPWARE_STOREFRONT_SCSS_SOURCE_MAP, false);
    const skipPostCss = asBoolean(process.env.SHOPWARE_STOREFRONT_SKIP_POSTCSS, false);
    const silenceSassDeprecations = asBoolean(process.env.SHOPWARE_STOREFRONT_SASS_SILENCE_DEPRECATIONS, true);
    const disableJs = asBoolean(process.env.SHOPWARE_STOREFRONT_DISABLE_JS, false);
    const disableTwig = asBoolean(process.env.SHOPWARE_STOREFRONT_DISABLE_TWIG, false);
    const disableScss = asBoolean(process.env.SHOPWARE_STOREFRONT_DISABLE_SCSS, false);
    const coreOnlyHotMode = asBoolean(process.env.SHOPWARE_STOREFRONT_HOT_CORE_ONLY, false) || disableJs;
    const scssEngine = asString(process.env.SHOPWARE_STOREFRONT_SCSS_ENGINE, 'webpack').toLowerCase();
    const useScssSidecar = !disableScss && scssEngine === 'sass-cli';
    const twigWatchMode = asString(process.env.SHOPWARE_STOREFRONT_TWIG_WATCH_MODE, 'narrow').toLowerCase();

    if (twigWatchMode === 'narrow' || disableTwig) {
        process.env.SHOPWARE_STOREFRONT_SKIP_EXTENSION_TWIG_WATCH = '1';
    }

    let sassImplementation;
    try {
        sassImplementation = storefrontRequire('sass');

        if (useSassEmbedded) {
            try {
                sassImplementation = storefrontRequire('sass-embedded');
                console.log('[SidworksDevTools] Using sass-embedded in hot mode');
            } catch (_error) {
                try {
                    sassImplementation = runtimeRequire('sass-embedded');
                    console.log('[SidworksDevTools] Using sass-embedded from runtime in hot mode');
                } catch (_runtimeError) {
                    console.log('[SidworksDevTools] sass-embedded not available, using sass');
                    console.log('[SidworksDevTools] Install hint: npm --prefix vendor/shopware/storefront/Resources/app/storefront i -D sass-embedded');
                }
            }
        }
    } catch (error) {
        throw new Error(`Unable to load Sass implementation from storefront app: ${error.message}`);
    }

    delete require.cache[require.resolve(coreWebpackConfigPath)];

    const previousCwd = process.cwd();
    let webpackConfig;
    try {
        process.chdir(storefrontApp);
        webpackConfig = require(coreWebpackConfigPath);
    } finally {
        process.chdir(previousCwd);
    }
    const configArray = Array.isArray(webpackConfig) ? webpackConfig : [webpackConfig];
    const coreConfig = configArray[0];

    const isHotMode = process.env.MODE === 'hot';
    if (!isHotMode) {
        return webpackConfig;
    }

    coreConfig.devtool = jsSourceMapEnabled ? 'eval-cheap-module-source-map' : false;

    // When this config is required outside the storefront app directory,
    // Shopware's path.resolve('src') entry can resolve to the project root.
    // Force the core storefront entry to its absolute path.
    if (coreConfig.entry && Object.prototype.hasOwnProperty.call(coreConfig.entry, 'storefront')) {
        coreConfig.entry.storefront = path.resolve(storefrontApp, 'src/main.js');
    }

    if (disableScss && coreConfig.entry && Object.prototype.hasOwnProperty.call(coreConfig.entry, 'hot-reloading')) {
        delete coreConfig.entry['hot-reloading'];
        console.log('[SidworksDevTools] SCSS compilation disabled (--no-scss)');
    }

    if (disableJs) {
        const emptyEntryPath = path.resolve(__dirname, 'empty-entry.js');
        const nextEntry = {
            storefront: emptyEntryPath,
        };

        if (!disableScss && !useScssSidecar && coreConfig.entry && coreConfig.entry['hot-reloading']) {
            nextEntry['hot-reloading'] = coreConfig.entry['hot-reloading'];
        }

        coreConfig.entry = nextEntry;
        console.log('[SidworksDevTools] JS compilation disabled (--no-js)');
    }

    if (useScssSidecar) {
        if (coreConfig.entry && Object.prototype.hasOwnProperty.call(coreConfig.entry, 'hot-reloading')) {
            delete coreConfig.entry['hot-reloading'];
        }
        console.log('[SidworksDevTools] SCSS sidecar mode enabled (webpack SCSS entry disabled)');
    }

    if (disableTwig && coreConfig.devServer) {
        delete coreConfig.devServer.watchFiles;
        console.log('[SidworksDevTools] Twig watch disabled (--no-twig)');
    }

    const assetPort = parseInt(process.env.STOREFRONT_ASSETS_PORT || '', 10) || 9999;
    if (coreConfig.devServer) {
        const clientConfig = coreConfig.devServer.client || {};
        const webSocketConfig = clientConfig.webSocketURL || {};

        coreConfig.devServer.client = {
            ...clientConfig,
            webSocketURL: {
                ...webSocketConfig,
                hostname: resolveWebSocketHostname(),
                port: assetPort,
            },
        };
        coreConfig.devServer.liveReload = true;
    }

    if (devCacheEnabled) {
        coreConfig.cache = {
            type: 'filesystem',
            cacheDirectory: path.resolve(projectRoot, 'var/cache/webpack-storefront-hot'),
            buildDependencies: {
                config: [coreWebpackConfigPath, __filename],
            },
        };
    }

    if (!disableTwig) {
        patchWatchFiles(coreConfig, {
            projectRoot,
            twigWatchMode,
        });
    }

    if (!useScssSidecar) {
        const scssRule = findScssRule(coreConfig?.module?.rules);
        patchScssRule(scssRule, {
            scssSourceMapEnabled,
            skipPostCss,
            silenceSassDeprecations,
            sassDeprecationsToSilence: getSassDeprecationsToSilence(sassImplementation),
            sassImplementation,
        });
    }

    const effectiveConfigArray = coreOnlyHotMode ? [coreConfig] : configArray;

    if (coreOnlyHotMode) {
        console.log('[SidworksDevTools] Core-only hot mode enabled (plugin JS compilers disabled)');
    }

    const explicitParallelism = parseInt(process.env.SHOPWARE_BUILD_PARALLELISM || '', 10);
    const detectedCpuCount = (() => {
        const cpuInfo = os.cpus();
        if (!cpuInfo || cpuInfo.length === 0) {
            return 2;
        }

        return cpuInfo.length;
    })();

    const defaultParallelism = Math.max(1, detectedCpuCount - 1);
    effectiveConfigArray.parallelism = Number.isInteger(explicitParallelism) && explicitParallelism > 0
        ? explicitParallelism
        : defaultParallelism;

    return effectiveConfigArray;
}

module.exports = loadPatchedWebpackConfig;
