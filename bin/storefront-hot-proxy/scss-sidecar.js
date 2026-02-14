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

const HOT_CSS_BASE_PATH = '/_sidworks_hot';
const HOT_CSS_FILE_NAME = 'sidworks-hot.css';
const HOT_CSS_ROUTE = `${HOT_CSS_BASE_PATH}/${HOT_CSS_FILE_NAME}`;
const HOT_CSS_EVENTS_ROUTE = `${HOT_CSS_BASE_PATH}/events`;

const sassDeprecations = ['import', 'global-builtin', 'color-functions', 'slash-div', 'legacy-js-api'];

function asString(value, defaultValue) {
    if (typeof value === 'undefined' || value === null || value === '') {
        return defaultValue;
    }

    return String(value);
}

function toFilePath(urlValue) {
    if (!urlValue || typeof urlValue !== 'object') {
        return null;
    }

    if (urlValue.protocol !== 'file:') {
        return null;
    }

    try {
        return fileURLToPath(urlValue);
    } catch (_error) {
        return null;
    }
}

function readJsonFile(filePath, fallbackValue = null) {
    if (!fs.existsSync(filePath)) {
        return fallbackValue;
    }

    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_error) {
        return fallbackValue;
    }
}

function toScssImportPath(filePath) {
    return String(filePath).replace(/\\/g, '/').replace(/"/g, '\\"');
}

function resolveScssCandidate(rawPath) {
    const normalizedPath = path.resolve(rawPath);
    const extension = path.extname(normalizedPath);
    const hasResolvableExtension = ['.scss', '.sass', '.css'].includes(extension);
    const dirname = path.dirname(normalizedPath);
    const basename = path.basename(normalizedPath);
    const basenameWithoutExtension = extension ? basename.slice(0, -extension.length) : basename;

    const candidates = [];
    if (hasResolvableExtension) {
        candidates.push(normalizedPath);
        candidates.push(path.join(dirname, `_${basename}`));
    } else {
        candidates.push(normalizedPath);
        candidates.push(`${normalizedPath}.scss`);
        candidates.push(`${normalizedPath}.sass`);
        candidates.push(`${normalizedPath}.css`);
        candidates.push(path.join(dirname, `_${basenameWithoutExtension}.scss`));
        candidates.push(path.join(dirname, `_${basenameWithoutExtension}.sass`));
        candidates.push(path.join(dirname, `_${basenameWithoutExtension}.css`));
        candidates.push(path.join(normalizedPath, 'index.scss'));
        candidates.push(path.join(normalizedPath, '_index.scss'));
        candidates.push(path.join(normalizedPath, 'index.css'));
        candidates.push(path.join(normalizedPath, '_index.css'));
    }

    for (const candidate of candidates) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
        }
    }

    return null;
}

function toWatchedFilePath(item) {
    if (!item) {
        return null;
    }

    if (typeof item === 'string') {
        return item;
    }

    return toFilePath(item);
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

    const themeFilesConfigPath = path.resolve(rootPath, 'var/theme-files.json');
    const themeEntryPath = path.resolve(rootPath, 'var/theme-entry.scss');
    const generatedEntryDirectoryPath = path.resolve(rootPath, 'var', '.sidworks-hot');
    const generatedThemeEntryPath = path.resolve(generatedEntryDirectoryPath, 'theme-entry.generated.scss');
    const featureConfigPath = path.resolve(rootPath, 'var/config_js_features.json');
    const themeConfigPath = path.resolve(rootPath, 'files/theme-config/index.json');
    const fallbackThemeVariablesPath = path.resolve(rootPath, 'var/theme-variables.scss');
    const cssOutputPath = path.resolve(rootPath, 'public', HOT_CSS_BASE_PATH.replace(/^\//, ''), HOT_CSS_FILE_NAME);

    const state = {
        subscribers: new Set(),
        watchpack: null,
        compileInFlight: false,
        compileQueued: false,
        compileTimer: null,
        version: Date.now(),
        sassImplementation: null,
        aliasMap: {},
        activeEntryPath: null,
        loggedGeneratedEntryInfo: false,
    };

    function resolveSassImplementation() {
        try {
            const embedded = storefrontRequire('sass-embedded');
            console.log('[SidworksDevTools] SCSS sidecar uses sass-embedded from storefront');
            return embedded;
        } catch (_error) {
            try {
                const embedded = runtimeRequire('sass-embedded');
                console.log('[SidworksDevTools] SCSS sidecar uses sass-embedded from runtime');
                return embedded;
            } catch (_runtimeError) {
                const sass = storefrontRequire('sass');
                console.log('[SidworksDevTools] SCSS sidecar fallback: using sass');
                return sass;
            }
        }
    }

    function resolveSilencedDeprecations() {
        const silenced = [...sassDeprecations];
        const info = String(state.sassImplementation?.info || '').toLowerCase();

        if (!info.includes('sass-embedded')) {
            silenced.push('mixed-decls');
        }

        return silenced;
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
        fs.mkdirSync(generatedEntryDirectoryPath, {
            recursive: true,
        });

        let currentContent = null;
        if (fs.existsSync(generatedThemeEntryPath)) {
            try {
                currentContent = fs.readFileSync(generatedThemeEntryPath, 'utf8');
            } catch (_error) {
                currentContent = null;
            }
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

            if (!state.loggedGeneratedEntryInfo) {
                console.log('[SidworksDevTools] SCSS sidecar uses generated entry from theme-files.json');
                state.loggedGeneratedEntryInfo = true;
            }

            return generatedThemeEntryPath;
        }

        if (fs.existsSync(themeEntryPath)) {
            state.activeEntryPath = themeEntryPath;
            return themeEntryPath;
        }

        state.activeEntryPath = null;
        return null;
    }

    function scheduleCompile() {
        if (state.compileTimer) {
            clearTimeout(state.compileTimer);
        }

        state.compileTimer = setTimeout(() => {
            state.compileTimer = null;
            compileAndWatch('change');
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
                '**/public/_sidworks_hot/**',
                '**/var/.sidworks-hot/**',
                '**/var/cache/**',
            ],
        });

        state.watchpack.on('change', scheduleCompile);
        state.watchpack.on('remove', scheduleCompile);

        return state.watchpack;
    }

    function updateWatchSet(loadedItems, entryPath) {
        const loadedFiles = (loadedItems || [])
            .map(toWatchedFilePath)
            .filter((item) => typeof item === 'string');

        loadedFiles.push(entryPath || state.activeEntryPath || themeEntryPath);
        loadedFiles.push(themeFilesConfigPath, featureConfigPath, themeConfigPath, fallbackThemeVariablesPath);
        const uniqueFiles = [...new Set(loadedFiles)];

        const watcher = ensureWatchpack();
        watcher.watch(uniqueFiles, [], Date.now() - 1000);
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

    async function compileAndWatch(reason) {
        if (!state.sassImplementation) {
            state.sassImplementation = resolveSassImplementation();
        }

        if (state.compileInFlight) {
            state.compileQueued = true;
            return;
        }

        state.compileInFlight = true;
        const startedAt = Date.now();

        try {
            const compileEntryPath = resolveCompileEntryPath();
            if (!compileEntryPath) {
                throw new Error('No SCSS entry found. Expected var/theme-files.json or var/theme-entry.scss');
            }

            const result = await compileWithLegacyImporter(compileEntryPath);

            await fs.promises.mkdir(path.dirname(cssOutputPath), {
                recursive: true,
            });
            await fs.promises.writeFile(cssOutputPath, result.css || '', 'utf8');

            state.version = Date.now();
            updateWatchSet(result.loadedFiles, compileEntryPath);
            broadcastCssUpdate();
            console.log(`[SidworksDevTools] SCSS sidecar compiled (${reason}) in ${Date.now() - startedAt}ms`);
        } catch (error) {
            const errorMessage = error?.message || String(error);
            console.error(`[SidworksDevTools] SCSS sidecar compile failed (${reason}): ${errorMessage}`);
        } finally {
            state.compileInFlight = false;

            if (state.compileQueued) {
                state.compileQueued = false;
                scheduleCompile();
            }
        }
    }

    function compileWithLegacyImporter(entryPath) {
        return new Promise((resolve, reject) => {
            if (typeof state.sassImplementation.render !== 'function') {
                reject(new Error('Sass implementation does not expose render() API'));
                return;
            }

            state.sassImplementation.render({
                file: entryPath,
                outFile: cssOutputPath,
                sourceMap: false,
                outputStyle: 'expanded',
                quietDeps: true,
                includePaths: [
                    path.resolve(storefrontApp, 'node_modules'),
                    path.resolve(storefrontApp, 'vendor'),
                    storefrontApp,
                    rootPath,
                ],
                silenceDeprecations: asString(process.env.SHOPWARE_STOREFRONT_SASS_SILENCE_DEPRECATIONS, '1') === '1'
                    ? resolveSilencedDeprecations()
                    : [],
                importer(url) {
                    const resolvedUrl = findTildeImport(url);
                    if (!resolvedUrl) {
                        return null;
                    }

                    const resolvedPath = fileURLToPath(resolvedUrl);
                    if (resolvedPath.endsWith('.css')) {
                        return {
                            contents: fs.readFileSync(resolvedPath, 'utf8'),
                        };
                    }

                    return {
                        file: resolvedPath,
                    };
                },
            }, (error, result) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve({
                    css: result.css.toString(),
                    loadedFiles: result.stats && Array.isArray(result.stats.includedFiles)
                        ? result.stats.includedFiles
                        : [],
                });
            });
        });
    }

    function injectMarkup(html, proxyOrigin) {
        if (!html || typeof html !== 'string') {
            return html;
        }

        if (html.includes('sidworks-hot-css')) {
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
                res.writeHead(404, {
                    'Content-Type': 'text/plain',
                });
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
