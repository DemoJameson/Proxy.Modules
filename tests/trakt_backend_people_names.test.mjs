import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { getString, invoke, seedString, withBackend } from "./helpers/backend-v2.mjs";

const require = createRequire(import.meta.url);
const handler = require("../api/trakt/people-names.js");

const KEY_42_CN = "person:name:42:cn";
const KEY_99_CN = "person:name:99:cn";

function entry(hash = "hash-1", text = "汤姆·汉克斯", source = "tmdb", expiresAt = Date.now() + 60_000) {
    return {
        status: 1,
        name: text,
        sourceTextHash: hash,
        source,
        expiresAt,
    };
}

function missingEntry(expiresAt = Date.now() + 60_000) {
    return {
        status: 3,
        expiresAt,
        tmdbMissing: true,
    };
}

test("people-names GET 命中时使用 MGET、返回 expiresAt 并设置 FOUND 缓存头", async () => {
    const store = new Map();
    const cached = entry();
    seedString(store, KEY_42_CN, cached);
    await withBackend(store, async () => {
        const res = await invoke(handler, { query: { people: "42" } });
        assert.deepEqual(res.jsonBody.people["42"], cached);
        assert.equal(res.headers["Cache-Control"], "public, max-age=300");
        assert.deepEqual(store.mgetCommands, [["MGET", KEY_42_CN]]);
    });
});

test("people-names GET 未命中时使用新的 NOT_FOUND 缓存头", async () => {
    const store = new Map();
    await withBackend(store, async () => {
        const res = await invoke(handler, { query: { people: "42,99" } });
        assert.deepEqual(res.jsonBody.people, {});
        assert.equal(res.headers["Cache-Control"], "public, max-age=120");
        assert.equal(res.headers["CDN-Cache-Control"], "public, s-maxage=3600, stale-while-revalidate=3600");
    });
});

test("people-names TMDB 无中文名时返回数字 NOT_FOUND 状态和 expiresAt", async () => {
    const store = new Map();
    const cached = missingEntry();
    seedString(store, KEY_42_CN, cached);
    await withBackend(store, async () => {
        const res = await invoke(handler, { query: { people: "42" } });
        assert.deepEqual(res.jsonBody.people["42"], cached);
        assert.equal(res.headers["Cache-Control"], "public, max-age=120");
        assert.equal(res.headers["Vercel-CDN-Cache-Control"], "public, s-maxage=3600, stale-while-revalidate=3600");
    });
});

test("people-names 部分命中时回带 cn 提示但使用 NOT_FOUND 缓存头", async () => {
    const store = new Map();
    const cnEntry = entry();
    const twEntry = entry("hash-2", "另一人");
    seedString(store, KEY_42_CN, cnEntry);
    seedString(store, "person:name:99:tw", twEntry);
    await withBackend(store, async () => {
        const res = await invoke(handler, { query: { people: "42,99", locale: "tw" } });
        assert.deepEqual(res.jsonBody.people["99"], twEntry);
        assert.deepEqual(res.jsonBody.cn.people["42"], cnEntry);
        assert.equal(res.headers["Cache-Control"], "public, max-age=120");
    });
});

test("people-names POST 用一条 MSET 写入 cn，并记录 source TTL", async () => {
    const store = new Map();
    await withBackend(store, async () => {
        const res = await invoke(handler, { method: "POST", body: { people: { 42: entry(), 99: entry("hash-2", "巩俐", "google") } } });
        assert.deepEqual(res.jsonBody, { counts: { people: 2 } });
        assert.equal(store.msetCommands.length, 1);
        assert.ok(getString(store, KEY_42_CN).expiresAt > Date.now());
        assert.ok(getString(store, KEY_99_CN).expiresAt > Date.now());
        assert.equal(getString(store, KEY_99_CN).source, "google");
    });
});

test("people-names POST 支持负缓存、Google 来源和 cnData", async () => {
    const store = new Map();
    await withBackend(store, async () => {
        await invoke(handler, { method: "POST", body: { people: { 42: { status: 3, tmdbMissing: true }, 99: entry("hash-g", "谷歌译名", "google") } } });
        assert.equal(getString(store, KEY_42_CN).status, 3);
        assert.equal(getString(store, KEY_42_CN).tmdbMissing, true);
        assert.ok(getString(store, KEY_42_CN).expiresAt > Date.now());
        assert.ok(getString(store, KEY_99_CN).expiresAt > Date.now());

        const twEntry = entry("hash-tw", "湯姆·漢克斯");
        const cnEntry = entry("hash-cn", "汤姆·汉克斯");
        await invoke(handler, {
            method: "POST",
            body: { locale: "tw", people: { 42: twEntry }, cn: { people: { 42: cnEntry } } },
        });
        assert.equal(getString(store, "person:name:42:tw").name, "湯姆·漢克斯");
        assert.equal(getString(store, "person:name:42:cn").name, "汤姆·汉克斯");
    });
});

test("people-names 用单个扁平条目保留 Google 姓名和 TMDB miss 标记", async () => {
    const store = new Map();
    const googleName = entry("hash-google", "谷歌译名", "google");
    await withBackend(store, async () => {
        const postRes = await invoke(handler, {
            method: "POST",
            body: {
                people: {
                    42: {
                        ...googleName,
                        tmdbMissing: true,
                    },
                },
            },
        });
        assert.deepEqual(postRes.jsonBody, { counts: { people: 1 } });

        const stored = getString(store, KEY_42_CN);
        assert.equal(stored.status, 1);
        assert.equal(stored.name, "谷歌译名");
        assert.equal(stored.tmdbMissing, true);
        assert.ok(stored.expiresAt > Date.now());

        const getRes = await invoke(handler, { query: { people: "42" } });
        assert.deepEqual(getRes.jsonBody.people["42"], stored);
    });
});

test("people-names POST 非法 ID、空 body 和 KV 未配置处理正确", async () => {
    const store = new Map();
    await withBackend(store, async () => {
        const invalid = await invoke(handler, { method: "POST", body: { people: { abc: entry(), 44: { name: {} } } } });
        assert.deepEqual(invalid.jsonBody, { counts: { people: 0 } });
        assert.equal(store.msetCommands, undefined);
        const empty = await invoke(handler, { method: "POST", body: {} });
        assert.deepEqual(empty.jsonBody, { counts: { people: 0 } });
    });
    await withBackend(
        store,
        async () => {
            const missing = await invoke(handler, { query: { people: "42" } });
            assert.equal(missing.statusCode, 500);
        },
        { kvUrl: null },
    );
});

test("people-names 硬切后拒绝旧 notFound、providers 和 name-only 结构", async () => {
    const store = new Map();
    await withBackend(store, async () => {
        const res = await invoke(handler, {
            method: "POST",
            body: {
                people: {
                    42: { notFound: true },
                    43: { status: 1, name: "旧结构", providers: { tmdb: { status: "FOUND" } } },
                    44: { name: { sourceTextHash: "hash", translatedText: "旧结构", source: "tmdb" } },
                },
            },
        });
        assert.deepEqual(res.jsonBody, { counts: { people: 0 } });
        assert.equal(store.msetCommands, undefined);
    });
});
