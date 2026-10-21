import { pathToFileURL } from "node:url";

// 把旧结构（根字段平铺，等价于 cn）折叠成 cn/tw/hk 三字段结构。
// 默认 dry-run：只读取并统计；加 --execute 才写入。可重复执行（已折叠的 key 会被跳过）。

const LOCALE_FIELDS = ["cn", "tw", "hk"];
const DEFAULT_SCAN_COUNT = 1000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_KEYS = 200000;
const IMAGE_LOCALE_FIELDS = ["poster", "logo"];

// 每类 key 的旧根字段名：折叠时把根字段写进 cn 并把它们置 null
const KEY_SPECS = [
    { name: "translation", prefix: "trakt:translation:", rootFields: ["status", "translation", "complete", "expiresAt"] },
    { name: "person-name", prefix: "trakt:person-name:", rootFields: ["name", "notFound"] },
    { name: "comment-translation", prefix: "trakt:comment-translation:", rootFields: ["comment"] },
    { name: "list-translation", prefix: "trakt:list-translation:", rootFields: ["name", "description"] },
    { name: "image", prefix: "trakt:image:", rootFields: ["poster", "logo"] },
];

function getKvConfig(env = process.env) {
    const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || "";
    const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || "";

    if (!url || !token) {
        throw new Error("KV is not configured. Set KV_REST_API_URL and KV_REST_API_TOKEN, or UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.");
    }

    return {
        url: url.replace(/\/+$/, ""),
        token,
    };
}

function parseArgs(argv = process.argv.slice(2)) {
    const options = {
        execute: false,
        pruneExpired: false,
        scanCount: DEFAULT_SCAN_COUNT,
        batchSize: DEFAULT_BATCH_SIZE,
        maxKeys: DEFAULT_MAX_KEYS,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--execute") {
            options.execute = true;
        } else if (arg === "--prune-expired") {
            options.pruneExpired = true;
        } else if (arg === "--scan-count") {
            options.scanCount = Number.parseInt(argv[index + 1] || "", 10);
            index += 1;
        } else if (arg.startsWith("--scan-count=")) {
            options.scanCount = Number.parseInt(arg.slice("--scan-count=".length), 10);
        } else if (arg === "--batch-size") {
            options.batchSize = Number.parseInt(argv[index + 1] || "", 10);
            index += 1;
        } else if (arg.startsWith("--batch-size=")) {
            options.batchSize = Number.parseInt(arg.slice("--batch-size=".length), 10);
        } else if (arg === "--max-keys") {
            options.maxKeys = Number.parseInt(argv[index + 1] || "", 10);
            index += 1;
        } else if (arg.startsWith("--max-keys=")) {
            options.maxKeys = Number.parseInt(arg.slice("--max-keys=".length), 10);
        } else if (arg === "--help" || arg === "-h") {
            options.help = true;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    if (!Number.isInteger(options.scanCount) || options.scanCount <= 0) {
        throw new Error("--scan-count must be a positive integer.");
    }
    if (!Number.isInteger(options.batchSize) || options.batchSize <= 0) {
        throw new Error("--batch-size must be a positive integer.");
    }
    if (!Number.isInteger(options.maxKeys) || options.maxKeys <= 0) {
        throw new Error("--max-keys must be a positive integer.");
    }

    return options;
}

function parseScanResult(result) {
    if (Array.isArray(result)) {
        return {
            cursor: String(result[0] || "0"),
            keys: Array.isArray(result[1]) ? result[1] : [],
        };
    }
    if (result && typeof result === "object") {
        return {
            cursor: String(result.cursor || result.nextCursor || "0"),
            keys: Array.isArray(result.keys) ? result.keys : [],
        };
    }
    return { cursor: "0", keys: [] };
}

function chunkArray(items, size) {
    const chunks = [];
    for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
    }
    return chunks;
}

function hasLocaleField(doc) {
    return !!doc && typeof doc === "object" && LOCALE_FIELDS.some((locale) => doc[locale] !== undefined);
}

// 图片条目的过期时间嵌在 poster/logo 字段内：只有所有存在的字段都过期，整个地区条目才算过期
function isExpiredImageEntry(entry, now) {
    const fields = IMAGE_LOCALE_FIELDS.filter((field) => entry?.[field] && typeof entry[field] === "object");
    if (fields.length === 0) {
        return false;
    }
    return fields.every((field) => {
        const expiresAt = Number(entry[field].expiresAt);
        return Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now;
    });
}

function isExpiredEntry(entry, now = Date.now()) {
    if (!entry || typeof entry !== "object") {
        return false;
    }
    if (isExpiredImageEntry(entry, now)) {
        return true;
    }
    const expiresAt = Number(entry.name?.expiresAt ?? entry.notFound?.expiresAt ?? entry.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now;
}

function pickRootEntry(doc, spec) {
    if (!doc || typeof doc !== "object") {
        return null;
    }
    const hasRootField = spec.rootFields.some((field) => doc[field] !== undefined && doc[field] !== null);
    if (!hasRootField) {
        return null;
    }
    const entry = {};
    spec.rootFields.forEach((field) => {
        if (doc[field] !== undefined && doc[field] !== null) {
            entry[field] = doc[field];
        }
    });
    return Object.keys(entry).length > 0 ? entry : null;
}

// 生成单个 key 的折叠补丁：$.cn = 根字段数据（JSON 字符串）+ 根字段置 "null"；--prune-expired 时顺带清理已过期地区字段
function buildFoldTriples(key, doc, spec, options = {}) {
    const triples = [];
    const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
    const localeFieldExists = hasLocaleField(doc);
    if (!localeFieldExists) {
        const rootEntry = pickRootEntry(doc, spec);
        if (!rootEntry) {
            return triples;
        }
        if (options.pruneExpired && isExpiredEntry(rootEntry, now)) {
            spec.rootFields.forEach((field) => {
                triples.push(key, `$.${field}`, "null");
            });
            return triples;
        }
        triples.push(key, "$.cn", JSON.stringify(rootEntry));
        spec.rootFields.forEach((field) => {
            triples.push(key, `$.${field}`, "null");
        });
        return triples;
    }

    if (!options.pruneExpired) {
        return triples;
    }
    LOCALE_FIELDS.forEach((locale) => {
        if (isExpiredEntry(doc[locale], now)) {
            triples.push(key, `$.${locale}`, "null");
        }
    });
    return triples;
}

async function kvPipeline(config, commands, fetchImpl = globalThis.fetch) {
    if (commands.length === 0) {
        return [];
    }
    const response = await fetchImpl(`${config.url}/pipeline`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${config.token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(commands),
    });
    if (!response.ok) {
        throw new Error(`KV HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (!Array.isArray(payload)) {
        throw new Error("KV pipeline returned non-array response");
    }
    return payload.map((item) => {
        if (!item || typeof item !== "object") {
            throw new Error("KV pipeline returned invalid command response");
        }
        if ("error" in item) {
            throw new Error(`KV pipeline command failed: ${item.error}`);
        }
        if (!("result" in item)) {
            throw new Error("KV pipeline command response is missing result");
        }
        return item.result;
    });
}

async function scanKeys(config, spec, options, fetchImpl) {
    const keys = [];
    let cursor = "0";
    do {
        const [result] = await kvPipeline(config, [["SCAN", cursor, "MATCH", `${spec.prefix}*`, "COUNT", options.scanCount]], fetchImpl);
        const scan = parseScanResult(result);
        keys.push(...scan.keys);
        cursor = scan.cursor;
    } while (cursor !== "0" && keys.length < options.maxKeys);
    return keys.slice(0, options.maxKeys);
}

function parseRedisJsonValue(value) {
    if (value === undefined || value === null || value === "") {
        return null;
    }
    let parsed = value;
    if (typeof parsed === "string") {
        try {
            parsed = JSON.parse(parsed);
        } catch {
            return null;
        }
    }
    if (Array.isArray(parsed)) {
        parsed = parsed.length > 0 ? parsed[0] : null;
    }
    return parsed && typeof parsed === "object" ? parsed : null;
}

async function runMigration(options = {}, deps = {}) {
    const config = deps.config || getKvConfig(deps.env);
    const fetchImpl = deps.fetchImpl || globalThis.fetch;
    const now = Number.isFinite(deps.now) ? Number(deps.now) : Date.now();
    const stats = {
        dryRun: !options.execute,
        scannedKeys: 0,
        legacyKeys: 0,
        migratedKeys: 0,
        prunedEntries: 0,
        readCommands: 0,
        writeCommands: 0,
        batches: 0,
    };

    for (const spec of KEY_SPECS) {
        const keys = await scanKeys(config, spec, options, fetchImpl);
        stats.scannedKeys += keys.length;
        for (const batch of chunkArray(keys, options.batchSize)) {
            stats.batches += 1;
            const [result] = await kvPipeline(config, [["JSON.MGET", ...batch, "$"]], fetchImpl);
            stats.readCommands += 1;
            const values = Array.isArray(result) ? result : [];
            const triples = [];
            const writtenKeys = [];
            batch.forEach((key, index) => {
                const doc = parseRedisJsonValue(values[index]);
                if (!doc) {
                    return;
                }
                if (!hasLocaleField(doc)) {
                    stats.legacyKeys += 1;
                }
                const keyTriples = buildFoldTriples(key, doc, spec, { pruneExpired: options.pruneExpired, now });
                if (keyTriples.length === 0) {
                    return;
                }
                // 只有真正写入 cn 数据才算折叠；把地区字段置 "null" 属于清理
                const migrated = keyTriples.some((value, position) => position % 3 === 1 && value === "$.cn" && keyTriples[position + 1] !== "null");
                if (migrated) {
                    stats.migratedKeys += 1;
                } else {
                    stats.prunedEntries += 1;
                }
                triples.push(...keyTriples);
                writtenKeys.push(key);
            });
            if (triples.length === 0) {
                continue;
            }
            stats.writeCommands += 1;
            if (options.execute) {
                // TTL 现在由数据字段 expiresAt 表达：清掉旧版本遗留在 key 上的 Redis TTL，
                // 否则刚折叠进去的 cn/tw/hk 字段会跟着旧 TTL 一起消失
                const persistCommands = [...new Set(writtenKeys)].map((key) => ["PERSIST", key]);
                await kvPipeline(config, [["JSON.MSET", ...triples], ...persistCommands], fetchImpl);
            }
        }
    }

    return stats;
}

function formatStats(stats) {
    const lines = [
        stats.dryRun ? "dry-run（未写入；加 --execute 执行）" : "已执行迁移",
        `扫描 key：${stats.scannedKeys}`,
        `旧结构 key：${stats.legacyKeys}`,
        `折叠 key：${stats.migratedKeys}`,
        `清理过期地区字段：${stats.prunedEntries}`,
        `读取命令：${stats.readCommands}`,
        `写入命令：${stats.writeCommands}`,
        `批次数：${stats.batches}`,
    ];
    return lines.join("\n");
}

const isCliEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCliEntry) {
    const options = parseArgs();
    if (options.help) {
        console.log(`用法：node scripts/migrate-trakt-translation-layout.mjs [--execute] [--prune-expired] [--scan-count N] [--batch-size N] [--max-keys N]`);
    } else {
        runMigration(options)
            .then((stats) => {
                console.log(formatStats(stats));
            })
            .catch((error) => {
                console.error(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            });
    }
}

export { buildFoldTriples, formatStats, getKvConfig, hasLocaleField, isExpiredEntry, KEY_SPECS, parseArgs, runMigration };
