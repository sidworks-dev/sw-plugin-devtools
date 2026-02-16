/* eslint no-console: 0 */

const fs = require('node:fs');
const path = require('node:path');

const {
    resolveStorefrontApp,
    createStorefrontRequire,
} = require('./runtime-paths');
const {
    ANSI,
    colorize,
    formatFilePath,
    summarizeFiles,
    createLogger,
} = require('./utils');

function createChangeFeedbackWatcher(projectRoot, options = {}) {
    const DUPLICATE_LOG_WINDOW_MS = 2000;
    const TWIG_DEBOUNCE_MS = 90;
    const TRANSLATION_DEBOUNCE_MS = 180;
    const rootPath = path.resolve(projectRoot);
    const storefrontApp = resolveStorefrontApp(rootPath);
    const storefrontRequire = createStorefrontRequire(rootPath);
    const Watchpack = storefrontRequire('watchpack');
    const coreOnlyHotMode = process.env.SHOPWARE_STOREFRONT_HOT_CORE_ONLY === '1';
    const disableJsCompilation = process.env.SHOPWARE_STOREFRONT_DISABLE_JS === '1';
    const jsCompileFeedbackEnabled = process.env.SHOPWARE_STOREFRONT_JS_COMPILE_FEEDBACK !== '0';
    const disableTwigWatch = process.env.SHOPWARE_STOREFRONT_DISABLE_TWIG === '1';
    const disableTranslationWatch = process.env.SHOPWARE_STOREFRONT_DISABLE_TRANSLATION_WATCH === '1';
    const onTranslationChange = typeof options.onTranslationChange === 'function'
        ? options.onTranslationChange
        : null;
    const twigLog = createLogger('TWIG');
    const translationLog = createLogger('I18N');

    let watchpack = null;
    const recentlyLogged = new Map();
    const twigState = {
        timer: null,
        waitLogged: false,
        pendingEventType: '',
        pendingFiles: new Set(),
    };
    const translationState = {
        timer: null,
        inFlight: false,
        queued: false,
        waitLogged: false,
        pendingEventType: '',
        pendingFiles: new Set(),
    };

    function logFileEvent(fileType, eventType, formattedFile, details = '') {
        const eventColor = eventType === 'remove' ? ANSI.yellow : ANSI.green;
        const typeTag = colorize(`[${fileType.toUpperCase()}]`, ANSI.cyan);
        const eventTag = colorize(`[${eventType.toUpperCase()}]`, eventColor);
        const suffix = details ? ` ${colorize(details, ANSI.gray)}` : '';

        console.log(`[SidworksDevTools] ${typeTag} ${eventTag} ${formattedFile}${suffix}`);
    }

    function isExistingDirectory(directoryPath) {
        try {
            return fs.statSync(directoryPath).isDirectory();
        } catch (_error) {
            return false;
        }
    }

    function isPathInside(childPath, parentPath) {
        const normalizedChild = path.resolve(childPath);
        const normalizedParent = path.resolve(parentPath);

        return normalizedChild === normalizedParent || normalizedChild.startsWith(normalizedParent + path.sep);
    }

    function readPluginsConfig() {
        const pluginsConfigPath = path.resolve(rootPath, 'var/plugins.json');

        try {
            const parsed = JSON.parse(fs.readFileSync(pluginsConfigPath, 'utf8'));
            return typeof parsed === 'object' && parsed !== null
                ? Object.values(parsed)
                : [];
        } catch (_error) {
            return [];
        }
    }

    function resolvePluginBasePath(pluginConfig) {
        const basePath = typeof pluginConfig?.basePath === 'string' ? pluginConfig.basePath : '';
        if (basePath === '') {
            return rootPath;
        }

        return path.isAbsolute(basePath) ? basePath : path.resolve(rootPath, basePath);
    }

    function collectWatchDirectories() {
        const directories = new Set();
        const storefrontViewsRoot = path.resolve(storefrontApp, '..', '..', 'views');

        [
            path.resolve(storefrontApp, 'src'),
            path.resolve(rootPath, 'src/Resources/views'),
            path.resolve(rootPath, 'templates'),
            storefrontViewsRoot,
            path.resolve(rootPath, 'custom/plugins'),
            path.resolve(rootPath, 'custom/apps'),
        ].filter(isExistingDirectory).forEach((d) => directories.add(d));

        const pluginConfigs = readPluginsConfig();
        for (const pluginConfig of pluginConfigs) {
            const pluginBasePath = resolvePluginBasePath(pluginConfig);

            const viewDirectories = Array.isArray(pluginConfig?.views) ? pluginConfig.views : [];
            for (const viewDirectory of viewDirectories) {
                if (typeof viewDirectory !== 'string' || viewDirectory === '') {
                    continue;
                }

                const resolved = path.resolve(pluginBasePath, viewDirectory);
                if (isExistingDirectory(resolved) && ![...directories].some((d) => isPathInside(resolved, d))) {
                    directories.add(resolved);
                }
            }

            const storefrontPath = typeof pluginConfig?.storefront?.path === 'string'
                ? pluginConfig.storefront.path
                : '';
            if (storefrontPath !== '') {
                const resolved = path.resolve(pluginBasePath, storefrontPath);
                if (isExistingDirectory(resolved) && ![...directories].some((d) => isPathInside(resolved, d))) {
                    directories.add(resolved);
                }
            }

            const entryFilePath = typeof pluginConfig?.storefront?.entryFilePath === 'string'
                ? pluginConfig.storefront.entryFilePath
                : '';
            if (entryFilePath !== '') {
                const resolved = path.dirname(path.resolve(pluginBasePath, entryFilePath));
                if (isExistingDirectory(resolved) && ![...directories].some((d) => isPathInside(resolved, d))) {
                    directories.add(resolved);
                }
            }
        }

        return [...directories];
    }

    function classifyFile(filePath) {
        const extension = path.extname(filePath).toLowerCase();
        if (extension === '.twig') {
            return 'twig';
        }

        if (extension === '.json' && isTranslationJsonFile(filePath)) {
            return 'translation';
        }

        if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'].includes(extension)) {
            return 'js';
        }

        return '';
    }

    function shouldSkipDuplicate(eventType, formattedFile) {
        const dedupeKey = `${eventType}:${formattedFile}`;
        const now = Date.now();
        const previous = recentlyLogged.get(dedupeKey) || 0;
        recentlyLogged.set(dedupeKey, now);
        return now - previous < DUPLICATE_LOG_WINDOW_MS;
    }

    function isTranslationJsonFile(filePath) {
        const normalizedPath = String(filePath || '').replace(/\\/g, '/').toLowerCase();
        if (normalizedPath === '' || !normalizedPath.endsWith('.json')) {
            return false;
        }

        return normalizedPath.includes('/snippet/') || normalizedPath.includes('/snippets/');
    }

    function rememberTwigPending(eventType, formattedFile) {
        if (typeof eventType === 'string' && eventType !== '') {
            twigState.pendingEventType = eventType;
        }

        if (typeof formattedFile === 'string' && formattedFile !== '') {
            twigState.pendingFiles.add(formattedFile);
        }
    }

    function flushTwigReloadFeedback() {
        const trigger = twigState.pendingEventType || 'change';
        const fileSummary = summarizeFiles([...twigState.pendingFiles]);
        const reasonLabel = fileSummary ? `${trigger}: ${fileSummary}` : trigger;

        twigState.pendingEventType = '';
        twigState.pendingFiles.clear();
        twigState.waitLogged = false;

        const startedAt = Date.now();
        twigLog.status('RUN', `reloading (${reasonLabel})`);
        twigLog.status('OK', `reloaded (${reasonLabel}) in ${Date.now() - startedAt}ms`);
    }

    function scheduleTwigReloadFeedback(eventType, formattedFile) {
        rememberTwigPending(eventType, formattedFile);

        if (twigState.timer) {
            if (!twigState.waitLogged) {
                const queuedFiles = summarizeFiles([...twigState.pendingFiles]);
                twigLog.status('WAIT', `change queued while reload is running${queuedFiles ? ` (${queuedFiles})` : ''}`);
                twigState.waitLogged = true;
            }
            return;
        }

        twigState.timer = setTimeout(() => {
            twigState.timer = null;
            flushTwigReloadFeedback();
        }, TWIG_DEBOUNCE_MS);
    }

    function rememberTranslationPending(eventType, formattedFile) {
        if (typeof eventType === 'string' && eventType !== '') {
            translationState.pendingEventType = eventType;
        }

        if (typeof formattedFile === 'string' && formattedFile !== '') {
            translationState.pendingFiles.add(formattedFile);
        }
    }

    async function flushTranslationFeedback() {
        const pendingFiles = [...translationState.pendingFiles];
        const trigger = translationState.pendingEventType || 'change';
        const fileSummary = summarizeFiles(pendingFiles);
        const reasonLabel = fileSummary ? `${trigger}: ${fileSummary}` : trigger;

        if (translationState.inFlight) {
            translationState.queued = true;
            if (!translationState.waitLogged) {
                translationLog.status('WAIT', `change queued while cache flush is running${fileSummary ? ` (${fileSummary})` : ''}`);
                translationState.waitLogged = true;
            }
            return;
        }

        translationState.pendingEventType = '';
        translationState.pendingFiles.clear();
        translationState.waitLogged = false;
        translationState.inFlight = true;
        const startedAt = Date.now();
        translationLog.status('RUN', `flushing cache (${reasonLabel})`);

        try {
            if (onTranslationChange) {
                await onTranslationChange({
                    eventType: trigger,
                    reasonLabel,
                    files: pendingFiles,
                });
            }

            translationLog.status('OK', `cache flushed + reload triggered (${reasonLabel}) in ${Date.now() - startedAt}ms`);
        } catch (error) {
            translationLog.status('ERR', `cache flush failed (${reasonLabel}) after ${Date.now() - startedAt}ms: ${error?.message || error}`, true);
        } finally {
            translationState.inFlight = false;

            if (translationState.queued) {
                translationState.queued = false;
                setTimeout(() => {
                    void flushTranslationFeedback();
                }, TRANSLATION_DEBOUNCE_MS);
            }
        }
    }

    function scheduleTranslationFeedback(eventType, formattedFile) {
        rememberTranslationPending(eventType, formattedFile);

        if (translationState.timer) {
            if (!translationState.waitLogged) {
                const queuedFiles = summarizeFiles([...translationState.pendingFiles]);
                translationLog.status('WAIT', `change queued while cache flush is running${queuedFiles ? ` (${queuedFiles})` : ''}`);
                translationState.waitLogged = true;
            }
            return;
        }

        translationState.timer = setTimeout(() => {
            translationState.timer = null;
            void flushTranslationFeedback();
        }, TRANSLATION_DEBOUNCE_MS);
    }

    function handleFileEvent(eventType, absoluteFilePath) {
        const fileType = classifyFile(absoluteFilePath);
        if (!fileType) {
            return;
        }

        const formattedFile = formatFilePath(absoluteFilePath, rootPath);
        if (!formattedFile) {
            return;
        }

        if (fileType === 'js') {
            if (shouldSkipDuplicate(eventType, formattedFile)) {
                return;
            }

            if (disableJsCompilation) {
                logFileEvent('js', eventType, formattedFile, '(skipped: --no-js)');
                return;
            }

            if (coreOnlyHotMode) {
                logFileEvent('js', eventType, formattedFile, '(skipped: core-only-hot mode)');
                return;
            }

            if (jsCompileFeedbackEnabled) {
                return;
            }

            logFileEvent('js', eventType, formattedFile);
            return;
        }

        if (fileType === 'twig') {
            if (disableTwigWatch) {
                if (shouldSkipDuplicate(eventType, formattedFile)) {
                    return;
                }

                logFileEvent('twig', eventType, formattedFile, '(skipped: --no-twig)');
                return;
            }

            scheduleTwigReloadFeedback(eventType, formattedFile);
            return;
        }

        if (fileType === 'translation') {
            if (disableTranslationWatch) {
                if (shouldSkipDuplicate(eventType, formattedFile)) {
                    return;
                }

                logFileEvent('i18n', eventType, formattedFile, '(skipped: translation watch disabled)');
                return;
            }

            if (shouldSkipDuplicate(eventType, formattedFile)) {
                return;
            }

            scheduleTranslationFeedback(eventType, formattedFile);
        }
    }

    function start() {
        if (watchpack) {
            return true;
        }

        const directoriesToWatch = collectWatchDirectories();
        if (directoriesToWatch.length === 0) {
            return false;
        }

        watchpack = new Watchpack({
            aggregateTimeout: 80,
            ignored: [
                '**/.git/**',
                '**/node_modules/**',
                '**/var/cache/**',
                '**/var/.sidworks-hot/**',
            ],
        });

        watchpack.on('change', (filePath) => handleFileEvent('change', filePath));
        watchpack.on('remove', (filePath) => handleFileEvent('remove', filePath));
        watchpack.watch([], directoriesToWatch, Date.now() - 1000);
        return true;
    }

    function close() {
        if (twigState.timer) {
            clearTimeout(twigState.timer);
            twigState.timer = null;
        }

        if (translationState.timer) {
            clearTimeout(translationState.timer);
            translationState.timer = null;
        }

        if (watchpack) {
            watchpack.close();
            watchpack = null;
        }
    }

    return {
        start,
        close,
    };
}

module.exports = {
    createChangeFeedbackWatcher,
};
