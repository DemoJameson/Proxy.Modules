import { pathToFileURL } from "node:url";

const IMAGE_GROUPS = ["movies", "shows", "seasons"];
const DEFAULT_SCAN_COUNT = 1000;
const DEFAULT_RENAME_BATCH_SIZE = 100;

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
        scanCount: DEFAULT_SCAN_COUNT,
        renameBatchSize: DEFAULT_RENAME_BATCH_SIZE,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--execute") {
            options.execute = true;
        } else if (arg === "--scan-count") {
            options.scanCount = Number.parseInt(argv[index + 1] || "", 10);
            index += 1;
        } else if (arg.startsWith("--scan-count=")) {
            options.scanCount = Number.parseInt(arg.slice("--scan-count=".length), 10);
        } else if (arg === "--rename-batch-size") {
            options.renameBatchSize = Number.parseInt(argv[index + 1] || "", 10);
            index += 1;
        } else if (arg.startsWith("--rename-batch-size=")) {
            options.renameBatchSize = Number.parseInt(arg.slice("--rename-batch-size=".length), 10);
        } else if (arg === "--help" || arg === "-h") {
            options.help = true;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    if (!Number.isInteger(options.scanCount) || options.scanCount <= 0) {
        throw new Error("--scan-count must be a positive integer.");
    }
    if (!Number.isInteger(options.renameBatchSize) || options.renameBatchSize <= 0) {
        throw new Error("--rename-batch-size must be a positive integer.");
    }

    return options;
}

function getMigrationSpecs() {
    return [
        ...IMAGE_GROUPS.map((group) => ({
            group,
            mode: "original",
            pattern: `original:${group}:*`,
            oldPrefix: `original:${group}:`,
            newPrefix: `trakt:image:original:${group}:`,
        })),
        ...IMAGE_GROUPS.map((group) => ({
            group,
            mode: "chinese",
            pattern: `trakt:image:${group}:*`,
            oldPrefix: `trakt:image:${group}:`,
            newPrefix: `trakt:image:chinese:${group}:`,
        })),
    ];
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

    return {
        cursor: "0",
        keys: [],
    };
}

function mapTargetKey(key, spec) {
    return key.startsWith(spec.oldPrefix) ? `${spec.newPrefix}${key.slice(spec.oldPrefix.length)}` : "";
}

function chunkArray(items, size) {
    const chunks = [];
    for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
    }
    return chunks;
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
        const [result] = await kvPipeline(config, [["SCAN", cursor, "MATCH", spec.pattern, "COUNT", options.scanCount]], fetchImpl);
        const scan = parseScanResult(result);
        keys.push(...scan.keys);
        cursor = scan.cursor;
    } while (cursor !== "0");

    return keys;
}

function createSummary(options) {
    return {
        mode: options.execute ? "execute" : "dry-run",
        scanned: 0,
        plannedRenames: 0,
        executedRenames: 0,
        specs: [],
    };
}

async function runMigration(options = {}) {
    const normalizedOptions = {
        execute: options.execute === true,
        scanCount: options.scanCount || DEFAULT_SCAN_COUNT,
        renameBatchSize: options.renameBatchSize || DEFAULT_RENAME_BATCH_SIZE,
    };
    const config = options.config || getKvConfig(options.env);
    const fetchImpl = options.fetch || globalThis.fetch;
    const summary = createSummary(normalizedOptions);

    for (const spec of getMigrationSpecs()) {
        const keys = await scanKeys(config, spec, normalizedOptions, fetchImpl);
        const renames = keys.map((key) => [key, mapTargetKey(key, spec)]).filter(([, targetKey]) => targetKey);
        const specSummary = {
            mode: spec.mode,
            group: spec.group,
            pattern: spec.pattern,
            scanned: keys.length,
            plannedRenames: renames.length,
            executedRenames: 0,
            sample: renames.slice(0, 3).map(([from, to]) => ({ from, to })),
        };

        summary.scanned += keys.length;
        summary.plannedRenames += renames.length;

        if (normalizedOptions.execute) {
            for (const batch of chunkArray(renames, normalizedOptions.renameBatchSize)) {
                await kvPipeline(
                    config,
                    batch.map(([from, to]) => ["RENAME", from, to]),
                    fetchImpl,
                );
                specSummary.executedRenames += batch.length;
                summary.executedRenames += batch.length;
            }
        }

        summary.specs.push(specSummary);
    }

    return summary;
}

function printHelp() {
    console.log(`Usage: npm run migrate:trakt:image-keys -- [--execute] [--scan-count 1000] [--rename-batch-size 100]

Migrates Trakt image Redis keys:
  original:{group}:{id}      -> trakt:image:original:{group}:{id}
  trakt:image:{group}:{id}   -> trakt:image:chinese:{group}:{id}

Without --execute this runs in dry-run mode and only scans keys.`);
}

async function main() {
    const options = parseArgs();
    if (options.help) {
        printHelp();
        return;
    }

    const summary = await runMigration(options);
    console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}

export { getMigrationSpecs, mapTargetKey, parseArgs, runMigration };
