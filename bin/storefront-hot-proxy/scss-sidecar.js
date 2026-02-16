/* eslint no-console: 0 */

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { fileURLToPath, pathToFileURL } = require('node:url');

const {
    resolveProjectRoot,
    resolveStorefrontApp,
    createStorefrontRequire,
} = require('./runtime-paths');
const {
    asString,
    formatFilePath,
    summarizeFiles,
    getSassDeprecationsToSilence,
    createLogger,
} = require('./utils');

const HOT_CSS_BASE_PATH = '/_sidworks_hot';
const HOT_CSS_FILE_NAME = 'sidworks-hot.css';
const HOT_CSS_MAP_FILE_NAME = `${HOT_CSS_FILE_NAME}.map`;
const HOT_CSS_ROUTE = `${HOT_CSS_BASE_PATH}/${HOT_CSS_FILE_NAME}`;
const HOT_CSS_MAP_ROUTE = `${HOT_CSS_BASE_PATH}/${HOT_CSS_MAP_FILE_NAME}`;
const HOT_CSS_EVENTS_ROUTE = `${HOT_CSS_BASE_PATH}/events`;

function readJsonFile(filePath, fallbackValue = null) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_error) {
        return fallbackValue;
    }
}

function toScssImportPath(filePath) {
    return String(filePath).replace(/\\/g, '/').replace(/"/g, '\\"');
}

const resolutionCache = new Map();

function resolveScssCandidate(rawPath) {
    const normalizedPath = path.resolve(rawPath);

    const cached = resolutionCache.get(normalizedPath);
    if (cached !== undefined) {
        return cached;
    }

    const extension = path.extname(normalizedPath);
    const hasResolvableExtension = ['.scss', '.sass', '.css'].includes(extension);
    const dirname = path.dirname(normalizedPath);
    const basename = path.basename(normalizedPath);
    const basenameWithoutExtension = extension ? basename.slice(0, -extension.length) : basename;

    const candidates = hasResolvableExtension
        ? [normalizedPath, path.join(dirname, `_${basename}`)]
        : [
            normalizedPath,
            `${normalizedPath}.scss`,
            `${normalizedPath}.sass`,
            `${normalizedPath}.css`,
            path.join(dirname, `_${basenameWithoutExtension}.scss`),
            path.join(dirname, `_${basenameWithoutExtension}.sass`),
            path.join(dirname, `_${basenameWithoutExtension}.css`),
            path.join(normalizedPath, 'index.scss'),
            path.join(normalizedPath, '_index.scss'),
            path.join(normalizedPath, 'index.css'),
            path.join(normalizedPath, '_index.css'),
        ];

    for (const candidate of candidates) {
        try {
            if (fs.statSync(candidate).isFile()) {
                resolutionCache.set(normalizedPath, candidate);
                return candidate;
            }
        } catch (_error) {
            // not found
        }
    }

    resolutionCache.set(normalizedPath, null);
    return null;
}

function invalidateResolutionCacheForChangedFiles(changedFiles, projectRoot) {
    if (!changedFiles || changedFiles.length === 0) {
        return;
    }

    const absolutePaths = new Set();
    for (const file of changedFiles) {
        if (typeof file !== 'string' || file === '') {
            continue;
        }

        const abs = path.isAbsolute(file) ? file : path.resolve(projectRoot, file);
        absolutePaths.add(abs);
    }

    if (absolutePaths.size === 0) {
        return;
    }

    for (const [key, value] of resolutionCache) {
        if (absolutePaths.has(key) || (value && absolutePaths.has(value))) {
            resolutionCache.delete(key);
        }
    }
}

function toWatchedFilePath(item) {
    if (typeof item === 'string') {
        return item;
    }

    if (item && typeof item === 'object' && item.protocol === 'file:') {
        try {
            return fileURLToPath(item);
        } catch (_error) {
            // invalid URL
        }
    }

    return null;
}

function resolveAliasMap(themeFiles) {
    const aliasMap = {};
    const styles = Array.isArray(themeFiles?.style) ? themeFiles.style : [];

    for (const styleEntry of styles) {
        const resolveMapping = styleEntry && typeof styleEntry.resolveMapping === 'object'
            ? styleEntry.resolveMapping
            : {};

        for (const [alias, aliasPath] of Object.entries(resolveMapping)) {
            if (!alias || typeof aliasPath !== 'string' || aliasPath === '') {
                continue;
            }

            aliasMap[alias] = aliasPath;
        }
    }

    return aliasMap;
}

function createScssSidecar(projectRoot) {
    const rootPath = projectRoot || resolveProjectRoot(__dirname);
    const storefrontApp = resolveStorefrontApp(rootPath);
    const storefrontRequire = createStorefrontRequire(rootPath);
    const runtimeRequire = createRequire(__filename);
    const Watchpack = storefrontRequire('watchpack');
    const log = createLogger('SCSS');

    const themeFilesConfigPath = path.resolve(rootPath, 'var/theme-files.json');
    const themeEntryPath = path.resolve(rootPath, 'var/theme-entry.scss');
    const generatedEntryDirectoryPath = path.resolve(rootPath, 'var', '.sidworks-hot');
    const generatedThemeEntryPath = path.resolve(generatedEntryDirectoryPath, 'theme-entry.generated.scss');
    const featureConfigPath = path.resolve(rootPath, 'var/config_js_features.json');
    const themeConfigPath = path.resolve(rootPath, 'files/theme-config/index.json');
    const fallbackThemeVariablesPath = path.resolve(rootPath, 'var/theme-variables.scss');
    const cssOutputPath = path.resolve(generatedEntryDirectoryPath, HOT_CSS_FILE_NAME);
    const cssMapOutputPath = path.resolve(generatedEntryDirectoryPath, HOT_CSS_MAP_FILE_NAME);
    const scssSourceMapEnabled = asString(process.env.SHOPWARE_STOREFRONT_SCSS_SOURCE_MAP, '1') === '1';
    const silenceDeprecations = asString(process.env.SHOPWARE_STOREFRONT_SASS_SILENCE_DEPRECATIONS, '1') === '1';

    const fileContentCache = new Map();

    const state = {
        subscribers: new Set(),
        watchpack: null,
        compileInFlight: false,
        compileQueued: false,
        compileTimer: null,
        version: Date.now(),
        sassImplementation: null,
        persistentCompiler: null,
        aliasMap: {},
        activeEntryPath: null,
        loggedGeneratedEntryInfo: false,
        pendingChangedFiles: new Set(),
        pendingTriggerType: '',
    };

    function formatPath(filePath) {
        return formatFilePath(filePath, rootPath);
    }

    function rememberPendingTrigger(triggerType, changedFile) {
        if (typeof triggerType === 'string' && triggerType !== '') {
            state.pendingTriggerType = triggerType;
        }

        const normalized = formatPath(changedFile);
        if (normalized !== '') {
            state.pendingChangedFiles.add(normalized);
        }
    }

    function consumePendingTrigger(fallbackType) {
        const reason = state.pendingTriggerType || fallbackType || 'change';
        const changedFiles = [...state.pendingChangedFiles];
        state.pendingTriggerType = '';
        state.pendingChangedFiles.clear();

        return { reason, changedFiles };
    }

    function resolveSassImplementation() {
        try {
            return storefrontRequire('sass-embedded');
        } catch (_error) {
            try {
                return runtimeRequire('sass-embedded');
            } catch (_runtimeError) {
                return storefrontRequire('sass');
            }
        }
    }

    function describeSassImplementation() {
        const info = String(state.sassImplementation?.info || '').toLowerCase();
        if (info.includes('sass-embedded')) {
            return 'sass-embedded';
        }
        return 'sass';
    }

    function findTildeImport(url) {
        if (!url || typeof url !== 'string' || !url.startsWith('~')) {
            return null;
        }

        const request = url.slice(1);
        if (request === '') {
            return null;
        }

        const requestParts = request.split('/');
        const alias = requestParts[0];
        const remainder = requestParts.slice(1).join('/');

        const candidateRoots = [];
        if (state.aliasMap[alias]) {
            candidateRoots.push(remainder ? path.join(state.aliasMap[alias], remainder) : state.aliasMap[alias]);
        }

        candidateRoots.push(path.resolve(storefrontApp, request));
        candidateRoots.push(path.resolve(storefrontApp, 'node_modules', request));
        candidateRoots.push(path.resolve(rootPath, request));

        for (const rootCandidate of candidateRoots) {
            const resolved = resolveScssCandidate(rootCandidate);
            if (resolved) {
                return pathToFileURL(resolved);
            }
        }

        return null;
    }

    function resolveThemeId(themeFiles) {
        if (typeof themeFiles?.themeId === 'string' && themeFiles.themeId !== '') {
            return themeFiles.themeId;
        }

        const themeConfig = readJsonFile(themeConfigPath, {});
        const firstThemeId = Object.values(themeConfig || {})[0];

        if (typeof firstThemeId === 'string' && firstThemeId !== '') {
            return firstThemeId;
        }

        return '';
    }

    function resolveFeaturesScssMap() {
        const features = readJsonFile(featureConfigPath, null);
        if (!features || typeof features !== 'object') {
            return '$sw-features: ();';
        }

        const featureEntries = Object.entries(features).map(([key, value]) => {
            return `'${key}': ${value ? 'true' : 'false'}`;
        });

        if (featureEntries.length === 0) {
            return '$sw-features: ();';
        }

        return `$sw-features: (${featureEntries.join(',')});`;
    }

    function resolveThemeVariablesFilePath(themeId) {
        if (themeId) {
            const dumpedThemeVariablesPath = path.resolve(rootPath, 'var/theme-variables', `${themeId}.scss`);
            if (fs.existsSync(dumpedThemeVariablesPath)) {
                return dumpedThemeVariablesPath;
            }
        }

        if (fs.existsSync(fallbackThemeVariablesPath)) {
            return fallbackThemeVariablesPath;
        }

        return null;
    }

    function buildGeneratedThemeEntry(themeFiles) {
        const styles = Array.isArray(themeFiles?.style) ? themeFiles.style : [];
        if (styles.length === 0) {
            return null;
        }

        const themeId = resolveThemeId(themeFiles);
        const dumpedVariablesPath = resolveThemeVariablesFilePath(themeId);
        const lines = [
            '// ATTENTION! This file is auto generated by SidworksDevTools SCSS sidecar and should not be edited.',
            '',
            resolveFeaturesScssMap(),
        ];

        if (dumpedVariablesPath) {
            lines.push(`@import "${toScssImportPath(dumpedVariablesPath)}";`);
        }

        lines.push(
            `$app-css-relative-asset-path: '/theme/${themeId || 'default'}/assets';`,
            "$sw-asset-public-url: '';",
            "$sw-asset-theme-url: '';",
            "$sw-asset-asset-url: '';",
            "$sw-asset-sitemap-url: '';",
        );

        for (const style of styles) {
            if (!style || typeof style.filepath !== 'string' || style.filepath === '') {
                continue;
            }

            lines.push(`@import "${toScssImportPath(style.filepath)}";`);
        }

        lines.push('');
        return lines.join('\n');
    }

    function writeGeneratedThemeEntry(content) {
        fs.mkdirSync(generatedEntryDirectoryPath, { recursive: true });

        let currentContent = null;
        try {
            currentContent = fs.readFileSync(generatedThemeEntryPath, 'utf8');
        } catch (_error) {
            // file doesn't exist yet
        }

        if (currentContent !== content) {
            fs.writeFileSync(generatedThemeEntryPath, content, 'utf8');
        }
    }

    function resolveCompileEntryPath() {
        const themeFiles = readJsonFile(themeFilesConfigPath, {});
        state.aliasMap = resolveAliasMap(themeFiles);

        const generatedEntryContent = buildGeneratedThemeEntry(themeFiles);
        if (generatedEntryContent) {
            writeGeneratedThemeEntry(generatedEntryContent);
            state.activeEntryPath = generatedThemeEntryPath;

            state.loggedGeneratedEntryInfo = true;

            return generatedThemeEntryPath;
        }

        if (fs.existsSync(themeEntryPath)) {
            state.activeEntryPath = themeEntryPath;
            return themeEntryPath;
        }

        state.activeEntryPath = null;
        return null;
    }

    function scheduleCompile(triggerType = 'change', changedFile = '') {
        rememberPendingTrigger(triggerType, changedFile);

        if (state.compileTimer) {
            clearTimeout(state.compileTimer);
        }

        state.compileTimer = setTimeout(() => {
            state.compileTimer = null;
            const trigger = consumePendingTrigger(triggerType);
            compileAndWatch(trigger.reason, trigger.changedFiles);
        }, 80);
    }

    function ensureWatchpack() {
        if (state.watchpack) {
            return state.watchpack;
        }

        state.watchpack = new Watchpack({
            aggregateTimeout: 120,
            ignored: [
                '**/.git/**',
                '**/node_modules/**',
                '**/var/.sidworks-hot/**',
                '**/var/cache/**',
            ],
        });

        state.watchpack.on('change', (filePath) => scheduleCompile('change', filePath));
        state.watchpack.on('remove', (filePath) => scheduleCompile('remove', filePath));

        return state.watchpack;
    }

    function updateWatchSet(loadedItems, entryPath) {
        const loadedFiles = (loadedItems || [])
            .map(toWatchedFilePath)
            .filter((item) => typeof item === 'string');

        loadedFiles.push(entryPath || state.activeEntryPath || themeEntryPath);
        loadedFiles.push(themeFilesConfigPath, featureConfigPath, themeConfigPath, fallbackThemeVariablesPath);

        const watcher = ensureWatchpack();
        watcher.watch([...new Set(loadedFiles)], [], Date.now() - 1000);
    }

    function broadcastCssUpdate() {
        const payload = JSON.stringify({
            type: 'css-update',
            version: state.version,
        });

        for (const subscriber of state.subscribers) {
            try {
                subscriber.write(`data: ${payload}\n\n`);
            } catch (_error) {
                state.subscribers.delete(subscriber);
            }
        }
    }

    async function compileAndWatch(reason, changedFiles = []) {
        if (!state.sassImplementation) {
            state.sassImplementation = resolveSassImplementation();
            const engine = describeSassImplementation();
            const persistent = typeof state.sassImplementation.initAsyncCompiler === 'function' ? ', persistent' : '';
            log.log(`${engine}${persistent}`);
        }

        const fileSummary = summarizeFiles(changedFiles);
        const reasonLabel = fileSummary ? `${reason}: ${fileSummary}` : reason;

        if (state.compileInFlight) {
            for (const changedFile of changedFiles) {
                rememberPendingTrigger(reason, changedFile);
            }

            if (!state.compileQueued) {
                log.status('WAIT', `change queued while compile is running${state.pendingChangedFiles.size > 0 ? ` (${summarizeFiles([...state.pendingChangedFiles])})` : ''}`);
            }
            state.compileQueued = true;
            return;
        }

        state.compileInFlight = true;
        fileContentCache.clear();
        invalidateResolutionCacheForChangedFiles(changedFiles, rootPath);
        const startedAt = Date.now();
        log.status('RUN', `compiling (${reasonLabel})`);

        try {
            const compileEntryPath = resolveCompileEntryPath();
            if (!compileEntryPath) {
                throw new Error('No SCSS entry found. Expected var/theme-files.json or var/theme-entry.scss');
            }

            const result = await compileSass(compileEntryPath);

            await fs.promises.mkdir(path.dirname(cssOutputPath), { recursive: true });
            await fs.promises.writeFile(cssOutputPath, result.css || '', 'utf8');

            if (scssSourceMapEnabled && typeof result.map === 'string' && result.map !== '') {
                await fs.promises.writeFile(cssMapOutputPath, result.map, 'utf8');
            } else if (fs.existsSync(cssMapOutputPath)) {
                await fs.promises.unlink(cssMapOutputPath);
            }

            state.version = Date.now();
            updateWatchSet(result.loadedFiles, compileEntryPath);
            broadcastCssUpdate();
            log.status('OK', `compiled (${reasonLabel}) in ${Date.now() - startedAt}ms`);
        } catch (error) {
            log.status('ERR', `compile failed (${reasonLabel}) after ${Date.now() - startedAt}ms: ${error?.message || error}`, true);
        } finally {
            state.compileInFlight = false;

            if (state.compileQueued) {
                state.compileQueued = false;
                scheduleCompile(state.pendingTriggerType || 'change');
            }
        }
    }

    function getSharedCompileOptions() {
        const deprecations = silenceDeprecations
            ? getSassDeprecationsToSilence(state.sassImplementation)
            : [];

        return {
            loadPaths: [
                path.resolve(storefrontApp, 'node_modules'),
                path.resolve(storefrontApp, 'vendor'),
                storefrontApp,
                rootPath,
            ],
            silenceDeprecations: deprecations,
        };
    }

    async function ensurePersistentCompiler() {
        if (state.persistentCompiler) {
            return state.persistentCompiler;
        }

        const sass = state.sassImplementation;
        if (typeof sass.initAsyncCompiler === 'function') {
            state.persistentCompiler = await sass.initAsyncCompiler();
            return state.persistentCompiler;
        }

        return null;
    }

    async function compileSass(entryPath) {
        const sass = state.sassImplementation;

        if (typeof sass.compileAsync === 'function') {
            const compiler = await ensurePersistentCompiler();
            return compileWithModernApi(entryPath, compiler);
        }

        if (typeof sass.render === 'function') {
            return compileWithLegacyApi(entryPath);
        }

        throw new Error('Sass implementation has no compileAsync() or render() API');
    }

    async function compileWithModernApi(entryPath, compiler) {
        const shared = getSharedCompileOptions();
        const compile = compiler
            ? (file, opts) => compiler.compileAsync(file, opts)
            : (file, opts) => state.sassImplementation.compileAsync(file, opts);

        const result = await compile(entryPath, {
            sourceMap: scssSourceMapEnabled,
            sourceMapIncludeSources: scssSourceMapEnabled,
            style: 'expanded',
            quietDeps: true,
            loadPaths: shared.loadPaths,
            silenceDeprecations: shared.silenceDeprecations,
            importers: [{
                canonicalize(url, context) {
                    const tildeResult = findTildeImport(url);
                    if (tildeResult) {
                        return tildeResult;
                    }

                    if (context.containingUrl) {
                        const containingDir = path.dirname(fileURLToPath(context.containingUrl));
                        const resolved = resolveScssCandidate(path.resolve(containingDir, url));
                        if (resolved) {
                            return pathToFileURL(resolved);
                        }
                    }

                    return null;
                },
                load(canonicalUrl) {
                    const resolvedPath = fileURLToPath(canonicalUrl);
                    let contents = fileContentCache.get(resolvedPath);
                    if (contents === undefined) {
                        contents = fs.readFileSync(resolvedPath, 'utf8');
                        fileContentCache.set(resolvedPath, contents);
                    }

                    if (resolvedPath.endsWith('.sass')) {
                        return { contents, syntax: 'indented' };
                    }

                    if (resolvedPath.endsWith('.css')) {
                        return { contents, syntax: 'css' };
                    }

                    return { contents, syntax: 'scss' };
                },
            }],
        });

        let map = '';
        if (scssSourceMapEnabled && result.sourceMap) {
            map = JSON.stringify(result.sourceMap);
        }

        const loadedFiles = Array.isArray(result.loadedUrls)
            ? result.loadedUrls.map(toWatchedFilePath).filter(Boolean)
            : [];

        return { css: result.css, map, loadedFiles };
    }

    function compileWithLegacyApi(entryPath) {
        const shared = getSharedCompileOptions();

        return new Promise((resolve, reject) => {
            state.sassImplementation.render({
                file: entryPath,
                outFile: cssOutputPath,
                sourceMap: scssSourceMapEnabled,
                sourceMapContents: scssSourceMapEnabled,
                outputStyle: 'expanded',
                quietDeps: true,
                includePaths: shared.loadPaths,
                silenceDeprecations: shared.silenceDeprecations,
                importer(url) {
                    const resolvedUrl = findTildeImport(url);
                    if (!resolvedUrl) {
                        return null;
                    }

                    const resolvedPath = fileURLToPath(resolvedUrl);
                    if (resolvedPath.endsWith('.css')) {
                        return { contents: fs.readFileSync(resolvedPath, 'utf8') };
                    }

                    return { file: resolvedPath };
                },
            }, (error, result) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve({
                    css: result.css.toString(),
                    map: result.map ? result.map.toString() : '',
                    loadedFiles: result.stats && Array.isArray(result.stats.includedFiles)
                        ? result.stats.includedFiles
                        : [],
                });
            });
        });
    }

    function injectMarkup(html, proxyOrigin) {
        if (!html || typeof html !== 'string' || html.includes('sidworks-hot-css')) {
            return html;
        }

        const cssHrefBase = `${proxyOrigin}${HOT_CSS_ROUTE}`;
        const eventsHref = `${proxyOrigin}${HOT_CSS_EVENTS_ROUTE}`;
        const snippet = [
            `<link id="sidworks-hot-css" rel="stylesheet" href="${cssHrefBase}?v=${state.version}">`,
            '<script>',
            '(function(){',
            `  const cssHrefBase = ${JSON.stringify(cssHrefBase)};`,
            `  const eventsUrl = ${JSON.stringify(eventsHref)};`,
            '  const linkId = "sidworks-hot-css";',
            '  const current = document.getElementById(linkId);',
            '  if (!current) return;',
            '  let source;',
            '  try { source = new EventSource(eventsUrl); } catch (_error) { return; }',
            '  source.onmessage = function(event) {',
            '    try {',
            '      const payload = JSON.parse(event.data || "{}");',
            '      if (payload.type !== "css-update" || !payload.version) return;',
            '      const link = document.getElementById(linkId);',
            '      if (!link) return;',
            '      link.href = cssHrefBase + "?v=" + payload.version;',
            '    } catch (_error) {}',
            '  };',
            '})();',
            '</script>',
        ].join('');

        if (html.includes('</head>')) {
            return html.replace('</head>', `${snippet}</head>`);
        }

        return snippet + html;
    }

    function handleInternalRequest(req, res) {
        const requestPath = (req.url || '').split('?')[0];

        if (requestPath === HOT_CSS_EVENTS_ROUTE) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                Connection: 'keep-alive',
                'Access-Control-Allow-Origin': '*',
            });

            state.subscribers.add(res);
            res.write(`data: ${JSON.stringify({ type: 'connected', version: state.version })}\n\n`);

            req.on('close', () => {
                state.subscribers.delete(res);
            });

            return true;
        }

        if (requestPath === HOT_CSS_ROUTE) {
            if (!fs.existsSync(cssOutputPath)) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('SCSS sidecar CSS not ready');
                return true;
            }

            res.writeHead(200, {
                'Content-Type': 'text/css; charset=utf-8',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Access-Control-Allow-Origin': '*',
            });
            fs.createReadStream(cssOutputPath).pipe(res);
            return true;
        }

        if (requestPath === HOT_CSS_MAP_ROUTE) {
            if (!fs.existsSync(cssMapOutputPath)) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('SCSS sidecar source map not ready');
                return true;
            }

            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Access-Control-Allow-Origin': '*',
            });
            fs.createReadStream(cssMapOutputPath).pipe(res);
            return true;
        }

        return false;
    }

    async function start() {
        if (!resolveCompileEntryPath()) {
            console.warn('[SidworksDevTools] SCSS sidecar disabled: no SCSS entry available');
            return false;
        }

        await compileAndWatch('startup');
        return true;
    }

    function close() {
        if (state.compileTimer) {
            clearTimeout(state.compileTimer);
            state.compileTimer = null;
        }

        if (state.persistentCompiler) {
            state.persistentCompiler.dispose();
            state.persistentCompiler = null;
        }

        if (state.watchpack) {
            state.watchpack.close();
            state.watchpack = null;
        }

        for (const subscriber of state.subscribers) {
            try {
                subscriber.end();
            } catch (_error) {
                // no-op
            }
        }
        state.subscribers.clear();
    }

    return {
        start,
        close,
        handleInternalRequest,
        injectMarkup,
    };
}

module.exports = {
    createScssSidecar,
    HOT_CSS_ROUTE,
    HOT_CSS_EVENTS_ROUTE,
};
