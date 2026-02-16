const path = require('node:path');

const ANSI = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m',
};

const SASS_DEPRECATIONS = ['import', 'global-builtin', 'color-functions', 'slash-div', 'legacy-js-api'];

function hasInteractiveTty() {
    return Boolean(process.stdout && process.stdout.isTTY);
}

function colorize(text, colorCode) {
    if (!hasInteractiveTty()) {
        return text;
    }

    return `${colorCode}${text}${ANSI.reset}`;
}

function tag(label, colorCode = ANSI.cyan) {
    return colorize(`[${label}]`, colorCode);
}

function formatFilePath(filePath, projectRoot) {
    if (typeof filePath !== 'string' || filePath === '') {
        return '';
    }

    const normalizedRoot = path.resolve(projectRoot);
    const normalizedFile = path.resolve(filePath);

    if (normalizedFile.startsWith(normalizedRoot + path.sep)) {
        return path.relative(normalizedRoot, normalizedFile).replace(/\\/g, '/');
    }

    return filePath.replace(/\\/g, '/');
}

function summarizeFiles(files) {
    const unique = [...new Set((files || []).filter((f) => typeof f === 'string' && f !== ''))];

    if (unique.length === 0) {
        return '';
    }

    if (unique.length <= 3) {
        return unique.join(', ');
    }

    return `${unique.slice(0, 3).join(', ')} +${unique.length - 3} more`;
}

function asString(value, defaultValue) {
    if (typeof value === 'undefined' || value === null || value === '') {
        return defaultValue;
    }

    return String(value);
}

function asBoolean(value, defaultValue) {
    if (typeof value === 'undefined' || value === '') {
        return defaultValue;
    }

    return value !== '0' && value !== 'false';
}

function getSassDeprecationsToSilence(sassImplementation) {
    const silenced = [...SASS_DEPRECATIONS];
    const info = String(sassImplementation?.info || '').toLowerCase();

    if (!info.includes('sass-embedded')) {
        silenced.push('mixed-decls');
    }

    return silenced;
}

function createLogger(prefix) {
    return {
        log(message) {
            console.log(`[SidworksDevTools] ${tag(prefix)} ${message}`);
        },
        error(message) {
            console.error(`[SidworksDevTools] ${tag(prefix)} ${message}`);
        },
        status(status, message, asError = false) {
            const statusColor = status === 'OK' ? ANSI.green
                : status === 'ERR' ? ANSI.red
                    : ANSI.yellow;
            const line = `[SidworksDevTools] ${tag(prefix)} ${colorize(`[${status}]`, statusColor)} ${message}`;

            if (asError) {
                console.error(line);
                return;
            }

            console.log(line);
        },
    };
}

module.exports = {
    ANSI,
    SASS_DEPRECATIONS,
    hasInteractiveTty,
    colorize,
    tag,
    formatFilePath,
    summarizeFiles,
    asString,
    asBoolean,
    getSassDeprecationsToSilence,
    createLogger,
};
