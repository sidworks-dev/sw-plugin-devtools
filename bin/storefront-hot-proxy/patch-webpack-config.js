const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

const {
    resolveProjectRoot,
    resolveStorefrontApp,
    createStorefrontRequire,
} = require('./runtime-paths');
const {
    asBoolean,
    asString,
    getSassDeprecationsToSilence,
} = require('./utils');

function toArray(value) {
    if (Array.isArray(value)) {
        return value;
    }

    if (typeof value === 'undefined' || value === null || value === '') {
        return [];
    }

    return [value];
}

function resolveWebSocketHostname() {
    const sourceUrl = process.env.PROXY_URL || process.env.APP_URL || '';

    if (!sourceUrl) {
        return 'localhost';
    }

    try {
        return new URL(sourceUrl).hostname;
    } catch (_error) {
        return 'localhost';
    }
}

function normalizeLoaderRuleEntry(entry) {
    if (typeof entry === 'string') {
        return { loader: entry, options: {} };
    }

    if (!entry || typeof entry !== 'object') {
        return entry;
    }

    return {
        ...entry,
        options: { ...(entry.options || {}) },
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
                normalized.options.postcssOptions = { config: false };
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

function patchScssSidecarWatchBehavior(configArray) {
    const scssIgnoredPatterns = ['**/*.scss', '**/*.sass'];

    for (const config of configArray) {
        if (!config || typeof config !== 'object') {
            continue;
        }

        config.watchOptions = config.watchOptions || {};
        config.watchOptions.ignored = [...new Set([
            ...toArray(config.watchOptions.ignored),
            ...scssIgnoredPatterns,
        ])];

        if (!config.devServer || !config.devServer.watchFiles || typeof config.devServer.watchFiles !== 'object' || Array.isArray(config.devServer.watchFiles)) {
            continue;
        }

        const watchFiles = config.devServer.watchFiles;
        const watchFilesOptions = watchFiles.options || {};
        watchFilesOptions.ignored = [...new Set([
            ...toArray(watchFilesOptions.ignored),
            ...scssIgnoredPatterns,
        ])];
        watchFiles.options = watchFilesOptions;
    }
}

function walkRules(rules, callback) {
    if (!Array.isArray(rules)) {
        return;
    }

    for (const rule of rules) {
        if (!rule || typeof rule !== 'object') {
            continue;
        }

        callback(rule);

        if (Array.isArray(rule.oneOf)) {
            walkRules(rule.oneOf, callback);
        }

        if (Array.isArray(rule.rules)) {
            walkRules(rule.rules, callback);
        }
    }
}

function isScssOrSassRule(rule) {
    return rule.test instanceof RegExp
        && (rule.test.test('.scss') || rule.test.test('.sass'));
}

function patchScssRulesToNoop(configArray) {
    const noopScssLoaderPath = path.resolve(__dirname, 'noop-scss-loader.js');

    for (const config of configArray) {
        if (!config || typeof config !== 'object') {
            continue;
        }

        walkRules(config?.module?.rules, (rule) => {
            if (!isScssOrSassRule(rule)) {
                return;
            }

            rule.use = [{ loader: noopScssLoaderPath }];
        });
    }
}

function stripWebpackBarPlugins(configArray) {
    for (const config of configArray) {
        if (!config || typeof config !== 'object' || !Array.isArray(config.plugins)) {
            continue;
        }

        config.plugins = config.plugins.filter((plugin) => {
            return !/webpackbar/i.test(String(plugin?.constructor?.name || ''));
        });
    }
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
    const disableScss = asBoolean(process.env.SHOPWARE_STOREFRONT_DISABLE_SCSS, false);
    const verboseWebpackOutput = asBoolean(process.env.SHOPWARE_STOREFRONT_VERBOSE_WEBPACK, false);
    const coreOnlyHotMode = asBoolean(process.env.SHOPWARE_STOREFRONT_HOT_CORE_ONLY, false) || disableJs;
    const prebuiltVendorPlugins = asBoolean(process.env.SHOPWARE_STOREFRONT_PREBUILT_VENDOR_PLUGINS, true);
    const scssEngine = asString(process.env.SHOPWARE_STOREFRONT_SCSS_ENGINE, 'webpack').toLowerCase();
    const useScssSidecar = !disableScss && scssEngine === 'sass-cli';

    process.env.SHOPWARE_STOREFRONT_SKIP_EXTENSION_TWIG_WATCH = '1';

    let sassImplementation;
    try {
        sassImplementation = storefrontRequire('sass');

        if (useSassEmbedded) {
            try {
                sassImplementation = storefrontRequire('sass-embedded');
            } catch (_error) {
                try {
                    sassImplementation = runtimeRequire('sass-embedded');
                } catch (_runtimeError) {
                    // sass-embedded not available, keep using sass
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

    if (coreConfig.entry && Object.prototype.hasOwnProperty.call(coreConfig.entry, 'storefront')) {
        coreConfig.entry.storefront = path.resolve(storefrontApp, 'src/main.js');
    }

    if (disableScss && coreConfig.entry && Object.prototype.hasOwnProperty.call(coreConfig.entry, 'hot-reloading')) {
        delete coreConfig.entry['hot-reloading'];
    }

    if (disableJs) {
        const emptyEntryPath = path.resolve(__dirname, 'empty-entry.js');
        const nextEntry = { storefront: emptyEntryPath };

        if (!disableScss && !useScssSidecar && coreConfig.entry && coreConfig.entry['hot-reloading']) {
            nextEntry['hot-reloading'] = coreConfig.entry['hot-reloading'];
        }

        coreConfig.entry = nextEntry;
    }

    if (useScssSidecar || disableScss) {
        // The storefront template always requests this entry in HMR mode; answer with an empty
        // module instead of a 404 (which Chrome reports as an ORB-blocked script).
        addDevServerMiddleware(coreConfig, 'sidworks-empty-hot-reloading', (req, res, next) => {
            if (!coreConfig.entry?.['hot-reloading'] && String(req.url || '').split('?')[0] === '/storefront/hot-reloading.js') {
                res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.end('/* SCSS is served by the Sidworks SCSS sidecar */');
                return;
            }

            next();
        });
    }

    if (useScssSidecar) {
        if (coreConfig.entry && Object.prototype.hasOwnProperty.call(coreConfig.entry, 'hot-reloading')) {
            delete coreConfig.entry['hot-reloading'];
        }
        patchScssSidecarWatchBehavior(configArray);
        patchScssRulesToNoop(configArray);
    }

    // Twig reloads are driven by change-feedback-watcher (single watcher over all plugin view
    // directories), so the core chokidar glob watcher would only duplicate work and reloads.
    if (coreConfig.devServer) {
        delete coreConfig.devServer.watchFiles;
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

    let effectiveConfigArray = coreOnlyHotMode ? [coreConfig] : [...configArray];

    // Theme SCSS gets its own "hot-reloading" compiler; the sidecar (or --no-scss) makes it dead weight.
    if (useScssSidecar || disableScss) {
        effectiveConfigArray = effectiveConfigArray.filter((config) => config === coreConfig || !isHotReloadingOnlyConfig(config));
    }

    if (!coreOnlyHotMode) {
        effectiveConfigArray = applyPrebuiltVendorPlugins(effectiveConfigArray, coreConfig, projectRoot, prebuiltVendorPlugins);
    }

    effectiveConfigArray.forEach((config) => {
        if (!config || typeof config !== 'object') {
            return;
        }

        // Plugin compilers default to eval source maps; skip them unless JS source maps are requested.
        if (config !== coreConfig && !jsSourceMapEnabled) {
            config.devtool = false;
        }

    });

    // Only the (large) core bundle gets a persistent cache. Measured on 55 plugin compilers:
    // per-plugin filesystem caches made startup and rebuilds slower due to (de)serialization.
    if (devCacheEnabled) {
        coreConfig.cache = {
            type: 'filesystem',
            cacheDirectory: path.resolve(projectRoot, 'var/cache/webpack-storefront-hot'),
            buildDependencies: {
                config: [coreWebpackConfigPath, __filename],
            },
        };
    }

    if (!verboseWebpackOutput) {
        stripWebpackBarPlugins(effectiveConfigArray);

        for (const config of effectiveConfigArray) {
            if (!config || typeof config !== 'object') {
                continue;
            }

            config.stats = 'errors-only';
            config.infrastructureLogging = {
                ...(config.infrastructureLogging || {}),
                level: 'error',
            };
        }
    }

    const explicitParallelism = parseInt(process.env.SHOPWARE_BUILD_PARALLELISM || '', 10);
    const detectedCpuCount = os.cpus().length || 2;
    const parallelismValue = Number.isInteger(explicitParallelism) && explicitParallelism > 0
        ? explicitParallelism
        : Math.max(1, detectedCpuCount - 1);

    // MultiCompiler reads parallelism from the array itself, not from the individual configs.
    effectiveConfigArray.parallelism = parallelismValue;

    return effectiveConfigArray;
}

/**
 * Plugins installed via Composer (vendor/) don't change while developing and always ship a
 * production build in Resources/app/storefront/dist. Serve those files from the dev server
 * instead of compiling them on every start; only project plugins (custom/) are compiled live.
 *
 * SHOPWARE_STOREFRONT_WATCH_PLUGINS=name-a,name-b forces live compilation for specific plugins.
 */
function applyPrebuiltVendorPlugins(configArray, coreConfig, projectRoot, prebuiltVendorPlugins) {
    const pluginsJson = readJson(path.resolve(projectRoot, 'var/plugins.json')) || {};
    const forceWatch = new Set(asString(process.env.SHOPWARE_STOREFRONT_WATCH_PLUGINS, '')
        .split(',').map((name) => name.trim()).filter(Boolean));
    const prebuiltDirs = new Map();

    for (const definition of Object.values(pluginsJson)) {
        const technicalName = typeof definition?.technicalName === 'string' ? definition.technicalName : '';
        const basePath = typeof definition?.basePath === 'string' ? definition.basePath : '';
        if (!technicalName || technicalName === 'storefront' || forceWatch.has(technicalName)) {
            continue;
        }

        // Plugins without a JS entry but with a shipped dist bundle are never compiled by webpack,
        // so core hot mode would 404 them. Serve their dist regardless of location.
        const hasEntry = Boolean(definition?.storefront?.entryFilePath);
        const absoluteBase = path.resolve(projectRoot, basePath);
        if (hasEntry && (!prebuiltVendorPlugins || !absoluteBase.startsWith(path.resolve(projectRoot, 'vendor') + path.sep))) {
            continue;
        }

        const distDir = path.resolve(absoluteBase, 'Resources/app/storefront/dist/storefront/js', technicalName);
        if (fs.existsSync(path.join(distDir, `${technicalName}.js`))) {
            prebuiltDirs.set(technicalName, distDir);
        }
    }

    if (prebuiltDirs.size === 0 || !coreConfig.devServer) {
        return configArray;
    }

    addDevServerMiddleware(coreConfig, 'sidworks-prebuilt-vendor-plugins', (req, res, next) => serveFromPrebuiltDir(prebuiltDirs, req, res, next));

    process.env.SIDWORKS_PREBUILT_PLUGIN_COUNT = String(prebuiltDirs.size);

    return configArray.filter((config) => config === coreConfig || !prebuiltDirs.has(config?.name));
}

function addDevServerMiddleware(coreConfig, name, middleware) {
    if (!coreConfig.devServer) {
        return;
    }

    const originalSetupMiddlewares = coreConfig.devServer.setupMiddlewares;
    coreConfig.devServer.setupMiddlewares = (middlewares, devServer) => {
        middlewares.unshift({ name, middleware });

        return typeof originalSetupMiddlewares === 'function'
            ? originalSetupMiddlewares(middlewares, devServer)
            : middlewares;
    };
}

function serveFromPrebuiltDir(prebuiltDirs, req, res, next) {
    // Entry: /<name>/<name>.js ; async chunks resolve (publicPath "auto" + "../../") to /js/<name>/<chunk>.js
    const match = /^\/(?:js\/)?([^/]+)\/([^/]+\.js(?:\.map)?)$/.exec(String(req.url || '').split('?')[0]);
    const distDir = match ? prebuiltDirs.get(match[1]) : null;
    if (!distDir) {
        next();
        return;
    }

    const filePath = path.resolve(distDir, match[2]);
    if (!filePath.startsWith(distDir + path.sep) || !fs.existsSync(filePath)) {
        next();
        return;
    }

    res.setHeader('Content-Type', filePath.endsWith('.map') ? 'application/json; charset=utf-8' : 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');
    fs.createReadStream(filePath).pipe(res);
}

function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_error) {
        return null;
    }
}

function isHotReloadingOnlyConfig(config) {
    const entryKeys = config && config.entry && typeof config.entry === 'object' ? Object.keys(config.entry) : [];

    return entryKeys.length === 1 && entryKeys[0] === 'hot-reloading';
}

module.exports = loadPatchedWebpackConfig;
