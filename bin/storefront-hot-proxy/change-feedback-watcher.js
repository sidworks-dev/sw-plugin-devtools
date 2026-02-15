/* eslint no-console: 0 */

const fs = require('node:fs');
const path = require('node:path');

const {
    resolveStorefrontApp,
    createStorefrontRequire,
} = require('./runtime-paths');

const ANSI = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    gray: '\x1b[90m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
};

function createChangeFeedbackWatcher(projectRoot) {
    const DUPLICATE_LOG_WINDOW_MS = 2000;
    const TWIG_DEBOUNCE_MS = 90;
    const rootPath = path.resolve(projectRoot);
    const storefrontApp = resolveStorefrontApp(rootPath);
    const storefrontRequire = createStorefrontRequire(rootPath);
    const Watchpack = storefrontRequire('watchpack');
    const coreOnlyHotMode = process.env.SHOPWARE_STOREFRONT_HOT_CORE_ONLY === '1';
    const disableJsCompilation = process.env.SHOPWARE_STOREFRONT_DISABLE_JS === '1';
    const jsCompileFeedbackEnabled = process.env.SHOPWARE_STOREFRONT_JS_COMPILE_FEEDBACK !== '0';
    const disableTwigWatch = process.env.SHOPWARE_STOREFRONT_DISABLE_TWIG === '1';

    let watchpack = null;
    const recentlyLogged = new Map();
    const twigState = {
        timer: null,
        waitLogged: false,
        pendingEventType: '',
        pendingFiles: new Set(),
    };

    function hasInteractiveTty() {
        return Boolean(process.stdout && process.stdout.isTTY);
    }

    function colorize(text, colorCode) {
        if (!hasInteractiveTty()) {
            return text;
        }

        return `${colorCode}${text}${ANSI.reset}`;
    }

    function logFileEvent(fileType, eventType, formattedFile, details = '') {
        const typeColor = ANSI.cyan;
        const eventColor = eventType === 'remove' ? ANSI.yellow : ANSI.green;
        const typeTag = colorize(`[${fileType.toUpperCase()}]`, typeColor);
        const eventTag = colorize(`[${eventType.toUpperCase()}]`, eventColor);
        const suffix = details ? ` ${colorize(details, ANSI.gray)}` : '';

        console.log(`[SidworksDevTools] ${typeTag} ${eventTag} ${formattedFile}${suffix}`);
    }

    function logTwigStatus(status, message, asError = false) {
        const typeTag = colorize('[TWIG]', ANSI.cyan);
        const statusColor = status === 'OK'
            ? ANSI.green
            : status === 'ERR'
                ? ANSI.red
                : ANSI.yellow;
        const statusTag = colorize(`[${status}]`, statusColor);
        const line = `[SidworksDevTools] ${typeTag} ${statusTag} ${message}`;

        if (asError) {
            console.error(line);
            return;
        }

        console.log(line);
    }

    function isExistingDirectory(directoryPath) {
        return fs.existsSync(directoryPath) && fs.statSync(directoryPath).isDirectory();
    }

    function isPathInside(childPath, parentPath) {
        const normalizedChild = path.resolve(childPath);
        const normalizedParent = path.resolve(parentPath);

        return normalizedChild === normalizedParent || normalizedChild.startsWith(normalizedParent + path.sep);
    }

    function readPluginsConfig() {
        const pluginsConfigPath = path.resolve(rootPath, 'var/plugins.json');
        if (!fs.existsSync(pluginsConfigPath)) {
            return [];
        }

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

        return path.isAbsolute(basePath)
            ? basePath
            : path.resolve(rootPath, basePath);
    }

    function collectWatchDirectories() {
        const directories = new Set();
        const storefrontViewsRoot = path.resolve(storefrontApp, '..', '..', 'views');

        const baseDirectories = [
            path.resolve(storefrontApp, 'src'),
            path.resolve(rootPath, 'src/Resources/views'),
            path.resolve(rootPath, 'templates'),
            storefrontViewsRoot,
            path.resolve(rootPath, 'custom/plugins'),
            path.resolve(rootPath, 'custom/apps'),
        ].filter(isExistingDirectory);

        baseDirectories.forEach((directoryPath) => directories.add(directoryPath));

        const pluginConfigs = readPluginsConfig();
        for (const pluginConfig of pluginConfigs) {
            const pluginBasePath = resolvePluginBasePath(pluginConfig);

            const viewDirectories = Array.isArray(pluginConfig?.views) ? pluginConfig.views : [];
            for (const viewDirectory of viewDirectories) {
                if (typeof viewDirectory !== 'string' || viewDirectory === '') {
                    continue;
                }

                const resolvedViewDirectory = path.resolve(pluginBasePath, viewDirectory);
                if (
                    isExistingDirectory(resolvedViewDirectory) &&
                    ![...directories].some((directoryPath) => isPathInside(resolvedViewDirectory, directoryPath))
                ) {
                    directories.add(resolvedViewDirectory);
                }
            }

            const storefrontPath = typeof pluginConfig?.storefront?.path === 'string'
                ? pluginConfig.storefront.path
                : '';
            if (storefrontPath !== '') {
                const resolvedStorefrontPath = path.resolve(pluginBasePath, storefrontPath);
                if (
                    isExistingDirectory(resolvedStorefrontPath) &&
                    ![...directories].some((directoryPath) => isPathInside(resolvedStorefrontPath, directoryPath))
                ) {
                    directories.add(resolvedStorefrontPath);
                }
            }

            const entryFilePath = typeof pluginConfig?.storefront?.entryFilePath === 'string'
                ? pluginConfig.storefront.entryFilePath
                : '';
            if (entryFilePath !== '') {
                const resolvedEntryDirectory = path.dirname(path.resolve(pluginBasePath, entryFilePath));
                if (
                    isExistingDirectory(resolvedEntryDirectory) &&
                    ![...directories].some((directoryPath) => isPathInside(resolvedEntryDirectory, directoryPath))
                ) {
                    directories.add(resolvedEntryDirectory);
                }
            }
        }

        return [...directories];
    }

    function formatFilePath(absoluteFilePath) {
        if (typeof absoluteFilePath !== 'string' || absoluteFilePath === '') {
            return '';
        }

        const normalizedRoot = path.resolve(rootPath);
        const normalizedFile = path.resolve(absoluteFilePath);
        if (normalizedFile.startsWith(normalizedRoot + path.sep)) {
            return path.relative(normalizedRoot, normalizedFile).replace(/\\/g, '/');
        }

        return absoluteFilePath.replace(/\\/g, '/');
    }

    function classifyFile(filePath) {
        const extension = path.extname(filePath).toLowerCase();
        if (extension === '.twig') {
            return 'twig';
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

    function rememberTwigPending(eventType, formattedFile) {
        if (typeof eventType === 'string' && eventType !== '') {
            twigState.pendingEventType = eventType;
        }

        if (typeof formattedFile === 'string' && formattedFile !== '') {
            twigState.pendingFiles.add(formattedFile);
        }
    }

    function formatTwigReasonLabel() {
        const trigger = twigState.pendingEventType || 'change';
        const fileSummary = summarizeFiles([...twigState.pendingFiles]);
        return fileSummary ? `${trigger}: ${fileSummary}` : trigger;
    }

    function flushTwigReloadFeedback() {
        const reasonLabel = formatTwigReasonLabel();
        const startedAt = Date.now();

        twigState.pendingEventType = '';
        twigState.pendingFiles.clear();
        twigState.waitLogged = false;

        logTwigStatus('RUN', `reloading (${reasonLabel})`);
        logTwigStatus('OK', `reloaded (${reasonLabel}) in ${Date.now() - startedAt}ms`);
    }

    function scheduleTwigReloadFeedback(eventType, formattedFile) {
        rememberTwigPending(eventType, formattedFile);

        if (twigState.timer) {
            if (!twigState.waitLogged) {
                const queuedFiles = summarizeFiles([...twigState.pendingFiles]);
                if (queuedFiles) {
                    logTwigStatus('WAIT', `change queued while reload is running (${queuedFiles})`);
                } else {
                    logTwigStatus('WAIT', 'change queued while reload is running');
                }
                twigState.waitLogged = true;
            }
            return;
        }

        twigState.timer = setTimeout(() => {
            twigState.timer = null;
            flushTwigReloadFeedback();
        }, TWIG_DEBOUNCE_MS);
    }

    function handleFileEvent(eventType, absoluteFilePath) {
        const fileType = classifyFile(absoluteFilePath);
        if (!fileType) {
            return;
        }

        const formattedFile = formatFilePath(absoluteFilePath);
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
