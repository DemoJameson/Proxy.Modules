import assert from "node:assert/strict";
import test from "node:test";

import { buildFoldTriples, parseArgs, runMigration } from "../scripts/migrate-trakt-translation-layout.mjs";

import { createPipelineResponse, getJsonValue, jsonValue } from "./helpers/kv-rest-mock.mjs";

const TEST_CONFIG = {
    url: "https://kv.example",
    token: "test-token",
};

function createRedisFetch(store) {
    return async (url, init = {}) => {
        const parsed = new URL(url);
        assert.equal(parsed.pathname, "/pipeline");
        assert.equal(init.headers.Authorization, "Bearer test-token");
        return createPipelineResponse(store, init);
    };
}
test("parseArgs 默认 dry-run，支持执行与限速参数", () => {
    const defaults = parseArgs([]);
    assert.equal(defaults.execute, false);
    assert.equal(defaults.pruneExpired, false);
    assert.ok(defaults.scanCount > 0);
    assert.ok(defaults.batchSize > 0);

    const executed = parseArgs(["--execute", "--prune-expired", "--scan-count", "500", "--batch-size", "10"]);
    assert.equal(executed.execute, true);
    assert.equal(executed.pruneExpired, true);
    assert.equal(executed.scanCount, 500);
    assert.equal(executed.batchSize, 10);

    assert.throws(() => parseArgs(["--batch-size", "0"]));
    assert.throws(() => parseArgs(["--unknown"]));
});

test("buildFoldTriples 把旧根字段折叠进 cn 并清空根字段", () => {
    const triples = buildFoldTriples(
        "trakt:translation:movies:123",
        { status: 1, translation: { title: "标题" }, complete: true },
        { rootFields: ["status", "translation", "complete", "expiresAt"] },
    );
    assert.deepEqual(triples, [
        "trakt:translation:movies:123",
        "$.cn",
        JSON.stringify({ status: 1, translation: { title: "标题" }, complete: true }),
        "trakt:translation:movies:123",
        "$.status",
        "null",
        "trakt:translation:movies:123",
        "$.translation",
        "null",
        "trakt:translation:movies:123",
        "$.complete",
        "null",
        "trakt:translation:movies:123",
        "$.expiresAt",
        "null",
    ]);
    // 已是新结构：默认不动
    assert.deepEqual(buildFoldTriples("trakt:translation:movies:123", { cn: { status: 1 }, tw: { status: 1 } }, { rootFields: ["status"] }), []);
});

test("runMigration dry-run 只读取统计，不写入", async () => {
    const store = new Map();
    store.set("trakt:translation:movies:123", jsonValue({ status: 1, translation: { title: "标题" } }));
    store.set("trakt:translation:movies:456", jsonValue({ cn: { status: 1 }, tw: { status: 1 } }));
    store.set("trakt:person-name:42", jsonValue({ name: { sourceTextHash: "hash", translatedText: "汤姆·汉克斯", source: "tmdb" } }));

    const stats = await runMigration(
        { execute: false, pruneExpired: false, scanCount: 100, batchSize: 10, maxKeys: 1000 },
        { config: TEST_CONFIG, fetchImpl: createRedisFetch(store) },
    );

    assert.equal(stats.dryRun, true);
    assert.equal(stats.scannedKeys, 3);
    assert.equal(stats.legacyKeys, 2);
    assert.equal(stats.migratedKeys, 2);
    assert.equal(stats.writeCommands, 2);
    assert.equal(store.msetCommands, undefined);
    assert.equal(store.persistCommands, undefined);
    // 旧结构保持原样
    assert.deepEqual(getJsonValue(store, "trakt:translation:movies:123"), { status: 1, translation: { title: "标题" } });
});

test("runMigration --execute 折叠旧结构并跳过已折叠的 key", async () => {
    const store = new Map();
    store.set("trakt:translation:movies:123", jsonValue({ status: 1, translation: { title: "标题" }, complete: true }));
    store.set("trakt:translation:movies:456", jsonValue({ cn: { status: 1 }, tw: { status: 1 } }));

    const stats = await runMigration(
        { execute: true, pruneExpired: false, scanCount: 100, batchSize: 10, maxKeys: 1000 },
        { config: TEST_CONFIG, fetchImpl: createRedisFetch(store) },
    );

    assert.equal(stats.dryRun, false);
    assert.equal(stats.migratedKeys, 1);
    assert.deepEqual(getJsonValue(store, "trakt:translation:movies:123"), {
        status: null,
        translation: null,
        complete: null,
        expiresAt: null,
        cn: { status: 1, translation: { title: "标题" }, complete: true },
    });
    assert.deepEqual(getJsonValue(store, "trakt:translation:movies:456"), { cn: { status: 1 }, tw: { status: 1 } });

    // 可重入：再次执行不再产生写入
    const second = await runMigration(
        { execute: true, pruneExpired: false, scanCount: 100, batchSize: 10, maxKeys: 1000 },
        { config: TEST_CONFIG, fetchImpl: createRedisFetch(store) },
    );
    assert.equal(second.migratedKeys, 0);
    assert.equal(second.writeCommands, 0);
});

test("runMigration --prune-expired 清理已过期地区字段", async () => {
    const store = new Map();
    const now = Date.now();
    store.set(
        "trakt:person-name:42",
        jsonValue({ cn: { name: { translatedText: "旧名", expiresAt: now - 1000 } }, tw: { name: { translatedText: "舊名", expiresAt: now + 1000 } } }),
    );

    const stats = await runMigration(
        { execute: true, pruneExpired: true, scanCount: 100, batchSize: 10, maxKeys: 1000 },
        { config: TEST_CONFIG, fetchImpl: createRedisFetch(store), now },
    );

    assert.equal(stats.prunedEntries, 1);
    assert.deepEqual(getJsonValue(store, "trakt:person-name:42"), { cn: null, tw: { name: { translatedText: "舊名", expiresAt: now + 1000 } } });
});

test("runMigration --prune-expired 按 poster/logo 字段判断图片地区条目", async () => {
    const store = new Map();
    const now = Date.now();
    store.set(
        "trakt:image:chinese:movies:123",
        jsonValue({
            cn: {
                poster: { status: 2, url: "https://image.tmdb.org/t/p/original/cn-poster.jpg", expiresAt: now - 1000 },
                logo: { status: 2, url: "https://image.tmdb.org/t/p/original/cn-logo.png", expiresAt: now - 1000 },
            },
            tw: {
                poster: { status: 2, url: "https://image.tmdb.org/t/p/original/tw-poster.jpg", expiresAt: now - 1000 },
                logo: { status: 2, url: "https://image.tmdb.org/t/p/original/tw-logo.png", expiresAt: now + 1000 },
            },
        }),
    );

    const stats = await runMigration(
        { execute: true, pruneExpired: true, scanCount: 100, batchSize: 10, maxKeys: 1000 },
        { config: TEST_CONFIG, fetchImpl: createRedisFetch(store), now },
    );

    assert.equal(stats.prunedEntries, 1);
    const value = getJsonValue(store, "trakt:image:chinese:movies:123");
    assert.equal(value.cn, null, "poster/logo 全部过期的地区字段应被清理");
    assert.equal(value.tw.poster.url, "https://image.tmdb.org/t/p/original/tw-poster.jpg", "仍有未过期字段的地区条目应保留");
    assert.equal(value.tw.logo.url, "https://image.tmdb.org/t/p/original/tw-logo.png");
});

test("runMigration --execute 清掉旧 key 上残留的 Redis TTL", async () => {
    const store = new Map();
    store.set("trakt:translation:movies:123", jsonValue({ status: 1, translation: { title: "标题" } }));
    store.ttlByKey = new Map([["trakt:translation:movies:123", 24 * 60 * 60 * 1000]]);

    await runMigration({ execute: true, pruneExpired: false, scanCount: 100, batchSize: 10, maxKeys: 1000 }, { config: TEST_CONFIG, fetchImpl: createRedisFetch(store) });

    assert.deepEqual(store.persistCommands, [["PERSIST", "trakt:translation:movies:123"]]);
    assert.equal(store.ttlByKey.has("trakt:translation:movies:123"), false, "折叠后 key 不应再受旧 TTL 影响");
});
