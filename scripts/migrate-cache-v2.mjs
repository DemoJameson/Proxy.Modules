import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import Redis from "ioredis";

const require = createRequire(import.meta.url);
const { normalizeEntry, normalizeImageEntry } = require("../lib/trakt-cache/normalize.js");
const { normalizeCommentTranslationEntry } = require("../lib/trakt-cache/comment-translation-store.js");
const { normalizeListTranslationEntry } = require("../lib/trakt-cache/list-translation-store.js");

const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379";
const LOCALES = ["cn", "tw", "hk"];
const IMAGE_GROUPS = ["shows", "movies", "seasons"];
const PERSON_NAME_SOURCES = ["tmdb", "google"];
const PERSON_NAME_TMDB_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const PERSON_NAME_GOOGLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PERSON_NAME_TMDB_MISSING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DOUBAN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OVERRIDES_KEY = "translation:overrides";
const LEGACY_OVERRIDES_KEY = "trakt:translation:overrides";

// V2 之前存在两代图片 key：original:{group}:* 和 trakt:image:{group}:*。
// 这里按 group 精确扫描，避免误迁移其它以 original: 开头的业务 key。
const LEGACY_SPECS = [
    { prefix: "trakt:translation:", type: "translation", rootFields: ["status", "translation", "complete", "expiresAt"] },
    ...IMAGE_GROUPS.flatMap((group) => [
        { prefix: `original:${group}:`, type: "image", rootFields: ["poster", "logo"], imageMode: "original", group },
        { prefix: `trakt:image:${group}:`, type: "image", rootFields: ["poster", "logo"], imageMode: "chinese", group },
        { prefix: `trakt:image:chinese:${group}:`, type: "image", rootFields: ["poster", "logo"], imageMode: "chinese", group },
        { prefix: `trakt:image:original:${group}:`, type: "image", rootFields: ["poster", "logo"], imageMode: "original", group },
    ]),
    { prefix: "trakt:person-name:", type: "person-name", rootFields: ["name", "notFound"] },
    { prefix: "trakt:comment-translation:", type: "comment-translation", rootFields: ["comment"] },
    { prefix: "trakt:list-translation:", type: "list-translation", rootFields: ["name", "description"] },
    { prefix: "trakt:credit:", type: "credit" },
];

function parseArgs(argv) {
    const options = {
        execute: false,
        redisUrl: DEFAULT_REDIS_URL,
        scanCount: 1000,
        batchSize: 500,
        maxKeys: 0,
        maxOutputKeys: 2_000_000,
        maxOutputBytes: 0,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--execute") {
            options.execute = true;
        } else if (arg === "--redis-url") {
            options.redisUrl = argv[++index] || options.redisUrl;
        } else if (arg === "--scan-count") {
            options.scanCount = Math.max(1, Number.parseInt(argv[++index] || "1000", 10) || 1000);
        } else if (arg === "--batch-size") {
            options.batchSize = Math.max(1, Number.parseInt(argv[++index] || "500", 10) || 500);
        } else if (arg === "--max-keys") {
            options.maxKeys = Math.max(0, Number.parseInt(argv[++index] || "0", 10) || 0);
        } else if (arg === "--max-output-keys") {
            options.maxOutputKeys = Math.max(1, Number.parseInt(argv[++index] || "2000000", 10) || 2_000_000);
        } else if (arg === "--max-output-bytes") {
            options.maxOutputBytes = Math.max(0, Number.parseInt(argv[++index] || "0", 10) || 0);
        } else if (arg === "--help" || arg === "-h") {
            options.help = true;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    return options;
}

function parseJson(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }
    if (typeof value === "object") {
        return Array.isArray(value) ? (value[0] ?? null) : value;
    }
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? (parsed[0] ?? null) : parsed;
    } catch {
        return null;
    }
}

function extractLocaleEntries(doc, rootFields = []) {
    if (!doc || typeof doc !== "object") {
        return [];
    }
    const entries = LOCALES.flatMap((locale) => (doc[locale] && typeof doc[locale] === "object" ? [{ locale, entry: doc[locale] }] : []));
    if (!doc.cn || typeof doc.cn !== "object") {
        const rootEntry = Object.fromEntries(rootFields.filter((field) => Object.hasOwn(doc, field)).map((field) => [field, doc[field]]));
        if (Object.keys(rootEntry).length > 0) {
            entries.unshift({ locale: "cn", entry: rootEntry });
        }
    }
    return entries;
}

function buildPersonNameV2Entry(entry, now = Date.now(), legacyTtlMs = 0) {
    if (!entry || typeof entry !== "object") {
        return null;
    }

    const name = entry.name && typeof entry.name === "object" ? entry.name : null;
    const sourceTextHash = String(name?.sourceTextHash || "").trim();
    const translatedText = String(name?.translatedText || "").trim();
    const source = String(name?.source || "")
        .trim()
        .toLowerCase();
    const normalizedName = sourceTextHash && translatedText && PERSON_NAME_SOURCES.includes(source) ? { sourceTextHash, translatedText, source } : null;
    const hasNotFound = entry.notFound === true || (entry.notFound && typeof entry.notFound === "object");
    const notFoundExpiresAt = Number(entry.notFound?.expiresAt);
    const nameExpiresAt = Number(name?.expiresAt);
    const legacyExpiresAt = legacyTtlMs > 0 ? now + legacyTtlMs : null;

    if (normalizedName) {
        const tmdbMissing = normalizedName.source !== "tmdb" && hasNotFound;
        const defaultTtlMs = tmdbMissing ? PERSON_NAME_TMDB_MISSING_TTL_MS : normalizedName.source === "google" ? PERSON_NAME_GOOGLE_TTL_MS : PERSON_NAME_TMDB_TTL_MS;
        const defaultExpiresAt = now + defaultTtlMs;
        const expiresAt = Number.isFinite(nameExpiresAt) && nameExpiresAt > 0 ? nameExpiresAt : (legacyExpiresAt ?? defaultExpiresAt);
        const missingExpiresAt = Number.isFinite(notFoundExpiresAt) && notFoundExpiresAt > 0 ? notFoundExpiresAt : (legacyExpiresAt ?? now + PERSON_NAME_TMDB_MISSING_TTL_MS);
        return {
            status: 1,
            name: normalizedName.translatedText,
            sourceTextHash: normalizedName.sourceTextHash,
            source: normalizedName.source,
            expiresAt: tmdbMissing ? Math.min(expiresAt, missingExpiresAt) : expiresAt,
            ...(tmdbMissing ? { tmdbMissing: true } : {}),
        };
    }

    if (!hasNotFound) {
        return null;
    }

    return {
        status: 3,
        expiresAt: Number.isFinite(notFoundExpiresAt) && notFoundExpiresAt > 0 ? notFoundExpiresAt : (legacyExpiresAt ?? now + PERSON_NAME_TMDB_MISSING_TTL_MS),
        tmdbMissing: true,
    };
}

function buildCreditV2Entry(entry, now = Date.now(), legacyTtlMs = 0) {
    if (!entry || typeof entry !== "object") {
        return null;
    }
    const expiresAt = Number(entry.expiresAt);
    return { ...entry, expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : legacyTtlMs > 0 ? now + legacyTtlMs : now + DOUBAN_TTL_MS };
}

function hasExplicitExpiresAt(entry) {
    if (!entry || typeof entry !== "object" || !Object.hasOwn(entry, "expiresAt")) {
        return false;
    }
    const expiresAt = entry.expiresAt;
    return Number.isFinite(Number(expiresAt)) && Number(expiresAt) > 0;
}

function applyLegacyExpiresAt(value, rawEntry, legacyTtlMs, now = Date.now()) {
    if (!value || legacyTtlMs <= 0 || !rawEntry || typeof rawEntry !== "object" || hasExplicitExpiresAt(rawEntry)) {
        return value;
    }
    return { ...value, expiresAt: now + legacyTtlMs };
}

function applyLegacyImageExpiresAt(value, rawEntry, legacyTtlMs, now = Date.now()) {
    if (!value || legacyTtlMs <= 0 || !rawEntry || typeof rawEntry !== "object") {
        return value;
    }
    const next = { ...value };
    for (const field of ["poster", "logo"]) {
        const rawField = rawEntry[field];
        if (next[field] && rawField && typeof rawField === "object" && !hasExplicitExpiresAt(rawField)) {
            next[field] = { ...next[field], expiresAt: now + legacyTtlMs };
        }
    }
    return next;
}

function buildV2StringEntries(legacyKey, doc, legacyTtlMs = 0) {
    const spec = LEGACY_SPECS.find((item) => legacyKey.startsWith(item.prefix));
    if (!spec) {
        return [];
    }
    const rest = legacyKey.slice(spec.prefix.length);
    if (!rest) {
        return [];
    }

    const now = Date.now();

    if (spec.type === "credit") {
        const value = buildCreditV2Entry(doc, now, legacyTtlMs);
        return value ? [{ key: `credit:${rest}`, value }] : [];
    }

    const baseKey = (() => {
        if (spec.type === "translation") return `translation:${rest}`;
        if (spec.type === "image") {
            if (!spec.group || !spec.imageMode) {
                return "";
            }
            return `image:${spec.imageMode}:${spec.group}:${rest}`;
        }
        if (spec.type === "person-name") return `person:name:${rest}`;
        if (spec.type === "comment-translation") return `comment:translation:${rest}`;
        return `list:translation:${rest}`;
    })();

    return extractLocaleEntries(doc, spec.rootFields)
        .map(({ locale, entry }) => {
            const value =
                spec.type === "person-name"
                    ? buildPersonNameV2Entry(entry, now, legacyTtlMs)
                    : spec.type === "translation"
                      ? applyLegacyExpiresAt(normalizeEntry(entry), entry, legacyTtlMs, now)
                      : spec.type === "image"
                        ? applyLegacyImageExpiresAt(normalizeImageEntry(entry), entry, legacyTtlMs, now)
                        : spec.type === "comment-translation"
                          ? applyLegacyExpiresAt(normalizeCommentTranslationEntry(entry), entry, legacyTtlMs, now)
                          : spec.type === "list-translation"
                            ? applyLegacyExpiresAt(normalizeListTranslationEntry(entry), entry, legacyTtlMs, now)
                            : spec.type === "credit"
                              ? buildCreditV2Entry(entry)
                              : entry;
            return value ? { key: `${baseKey}:${locale}`, value } : null;
        })
        .filter(Boolean);
}

function buildV2OverrideFields(doc) {
    const fields = {};
    if (!doc || typeof doc !== "object") {
        return fields;
    }
    for (const mediaType of ["shows", "movies", "episodes"]) {
        const entries = doc[mediaType] && typeof doc[mediaType] === "object" ? doc[mediaType] : {};
        for (const [id, rawEntry] of Object.entries(entries)) {
            if (!rawEntry || typeof rawEntry !== "object") {
                continue;
            }
            const updatedAt = Number.isFinite(Number(rawEntry.updatedAt)) ? Number(rawEntry.updatedAt) : Date.now();
            const localeEntries = LOCALES.flatMap((locale) => (rawEntry[locale]?.translation ? [{ locale, translation: rawEntry[locale].translation }] : []));
            const rootTranslation = rawEntry.cn?.translation ?? rawEntry.translation;
            if (!rawEntry.cn?.translation && rootTranslation && typeof rootTranslation === "object") {
                localeEntries.unshift({ locale: "cn", translation: rootTranslation });
            }
            for (const { locale, translation } of localeEntries) {
                fields[`${mediaType}:${id}:${locale}`] = JSON.stringify({ translation, updatedAt });
            }
        }
    }
    return fields;
}

function isWrongTypeError(error) {
    return /WRONGTYPE/.test(String(error?.message || error));
}

// 兼容早期版本写入的 String JSON；RedisJSON key 仍优先走 JSON.GET。
async function readLegacyDoc(redis, key) {
    const readPttl = async () => {
        try {
            const value = typeof redis.pttl === "function" ? await redis.pttl(key) : await redis.call("PTTL", key);
            const ttl = Number(value);
            return Number.isFinite(ttl) && ttl > 0 ? ttl : 0;
        } catch {
            return 0;
        }
    };

    try {
        const raw = await redis.call("JSON.GET", key, "$");
        return { doc: parseJson(raw), pttl: await readPttl() };
    } catch (error) {
        if (!isWrongTypeError(error)) {
            throw error;
        }
        try {
            const raw = await redis.call("GET", key);
            return { doc: parseJson(raw), pttl: await readPttl() };
        } catch (fallbackError) {
            if (isWrongTypeError(fallbackError)) {
                return { doc: null, pttl: 0 };
            }
            throw fallbackError;
        }
    }
}

async function forEachScannedKey(redis, pattern, options, callback) {
    let cursor = "0";
    let processed = 0;
    do {
        const [nextCursor, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", options.scanCount);
        cursor = nextCursor;
        for (const key of batch) {
            await callback(key);
            processed += 1;
            if (options.maxKeys > 0 && processed >= options.maxKeys) {
                return;
            }
        }
    } while (cursor !== "0");
}

async function writeBatch(redis, keyValues, batchSize) {
    for (let index = 0; index < keyValues.length; index += batchSize) {
        const batch = keyValues.slice(index, index + batchSize);
        if (batch.length > 0) {
            await redis.mset(...batch.flatMap(({ key, value }) => [key, JSON.stringify(value)]));
        }
    }
}

async function writeHashFields(redis, fields, batchSize) {
    const entries = Object.entries(fields);
    for (let index = 0; index < entries.length; index += batchSize) {
        const batch = entries.slice(index, index + batchSize);
        if (batch.length > 0) {
            await redis.hset(OVERRIDES_KEY, ...batch.flat());
        }
    }
}

async function deleteKeys(redis, keys, batchSize) {
    let deleted = 0;
    for (let index = 0; index < keys.length; index += batchSize) {
        const batch = keys.slice(index, index + batchSize);
        if (batch.length > 0) {
            deleted += Number(await redis.del(...batch)) || 0;
        }
    }
    return deleted;
}

function createMigrationStats() {
    return {
        legacyKeys: 0,
        newStringKeys: 0,
        overrideFields: 0,
        estimatedBytes: 0,
        skippedKeys: 0,
        deletedLegacyKeys: 0,
    };
}

function addStringEntriesToStats(stats, entries) {
    stats.newStringKeys += entries.length;
    stats.estimatedBytes += entries.reduce((total, item) => total + Buffer.byteLength(item.key) + Buffer.byteLength(JSON.stringify(item.value)), 0);
}

async function scanLegacyData(redis, settings, onEntries = null) {
    const stats = createMigrationStats();

    for (const spec of LEGACY_SPECS) {
        await forEachScannedKey(redis, `${spec.prefix}*`, settings, async (key) => {
            stats.legacyKeys += 1;
            if (key === LEGACY_OVERRIDES_KEY) {
                return;
            }
            const { doc, pttl } = await readLegacyDoc(redis, key);
            const entries = buildV2StringEntries(key, doc, pttl);
            if (entries.length === 0) {
                stats.skippedKeys += 1;
                return;
            }
            addStringEntriesToStats(stats, entries);
            if (onEntries) {
                await onEntries(key, entries);
            }
        });
    }

    const { doc: overrideDoc } = await readLegacyDoc(redis, LEGACY_OVERRIDES_KEY);
    const overrideFields = buildV2OverrideFields(overrideDoc);
    stats.overrideFields = Object.keys(overrideFields).length;
    stats.estimatedBytes += Object.entries(overrideFields).reduce((total, [field, value]) => total + Buffer.byteLength(field) + Buffer.byteLength(value), 0);

    return {
        stats,
        overrideFields,
        hasOverrideDoc: !!overrideDoc,
    };
}

async function runMigration(redis, options = {}) {
    const settings = {
        execute: false,
        scanCount: 1000,
        batchSize: 500,
        maxKeys: 0,
        maxOutputKeys: 2_000_000,
        maxOutputBytes: 0,
        ...options,
    };
    if (settings.execute && !(Number(settings.maxOutputBytes) > 0)) {
        throw new Error("--max-output-bytes is required with --execute");
    }
    const preflight = await scanLegacyData(redis, settings);
    const { stats } = preflight;
    if (stats.newStringKeys > settings.maxOutputKeys) {
        throw new Error(`Output key count ${stats.newStringKeys} exceeds max-output-keys ${settings.maxOutputKeys}`);
    }
    if (settings.maxOutputBytes > 0 && stats.estimatedBytes > settings.maxOutputBytes) {
        throw new Error(`Estimated output size ${stats.estimatedBytes} bytes exceeds max-output-bytes ${settings.maxOutputBytes}`);
    }
    if (!settings.execute) {
        return stats;
    }

    const writePass = await scanLegacyData(redis, settings, async (key, entries) => {
        await writeBatch(redis, entries, settings.batchSize);
        stats.deletedLegacyKeys += await deleteKeys(redis, [key], settings.batchSize);
    });
    await writeHashFields(redis, writePass.overrideFields, settings.batchSize);
    if (writePass.hasOverrideDoc) {
        stats.deletedLegacyKeys += await deleteKeys(redis, [LEGACY_OVERRIDES_KEY], settings.batchSize);
    }
    return stats;
}

function formatStats(stats) {
    return [
        `legacy keys: ${stats.legacyKeys}`,
        `new string keys: ${stats.newStringKeys}`,
        `override fields: ${stats.overrideFields}`,
        `estimated bytes: ${stats.estimatedBytes}`,
        `skipped keys: ${stats.skippedKeys}`,
        `deleted legacy keys: ${stats.deletedLegacyKeys}`,
    ].join("\n");
}

function printHelp() {
    console.log(
        `Usage: node scripts/migrate-cache-v2.mjs [options]\n\nOptions:\n  --execute              Write the transformed data and delete legacy keys\n  --redis-url <url>      Local Redis URL (default: ${DEFAULT_REDIS_URL})\n  --scan-count <n>       SCAN COUNT (default: 1000)\n  --batch-size <n>       Write/delete batch size (default: 500)\n  --max-keys <n>         Stop after n legacy keys per prefix (0 = unlimited)\n  --max-output-keys <n>  Maximum new key count (default: 2000000)\n  --max-output-bytes <n> Maximum estimated output bytes (required with --execute)\n  --help                 Show this help\n\nRun dry-run first, validate the output, then run with --execute.`,
    );
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        printHelp();
        return;
    }
    const redis = new Redis(options.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
    try {
        await redis.connect();
        const stats = await runMigration(redis, options);
        console.log(`${options.execute ? "EXECUTED" : "DRY RUN"}\n${formatStats(stats)}`);
    } finally {
        redis.disconnect();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}

export { buildV2OverrideFields, buildV2StringEntries, formatStats, parseArgs, runMigration };
