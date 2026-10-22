import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { getString, invoke, seedString, withBackend } from "./helpers/backend-v2.mjs";

const require = createRequire(import.meta.url);
const handler = require("../api/trakt/list-translations.js");

const KEY_42_CN = "list:translation:42:cn";
const KEY_99_CN = "list:translation:99:cn";

function entry(hash = "hash-1", text = "最佳影片合集", expiresAt = Date.now() + 60_000) {
    return { description: { sourceTextHash: hash, translatedText: text }, expiresAt };
}

test("list-translations GET 命中时使用 MGET 并设置 FOUND 缓存头", async () => {
    const store = new Map();
    const firstEntry = entry();
    const secondEntry = entry("hash-2", "年度佳剧清单");
    seedString(store, KEY_42_CN, firstEntry);
    seedString(store, KEY_99_CN, secondEntry);

    await withBackend(store, async () => {
        const res = await invoke(handler, { query: { lists: "42,99" } });
        assert.deepEqual(res.jsonBody.lists["42"], firstEntry);
        assert.equal(res.headers["Cache-Control"], "public, max-age=300");
        assert.deepEqual(store.mgetCommands, [["MGET", KEY_42_CN, KEY_99_CN]]);
    });
});

test("list-translations GET 未命中时使用新的 NOT_FOUND 缓存头", async () => {
    const store = new Map();
    await withBackend(store, async () => {
        const res = await invoke(handler, { query: { lists: "42,99" } });
        assert.deepEqual(res.jsonBody.lists, {});
        assert.equal(res.headers["Cache-Control"], "public, max-age=120");
        assert.equal(res.headers["CDN-Cache-Control"], "public, s-maxage=3600, stale-while-revalidate=3600");
    });
});

test("list-translations 部分命中时回带 cn 提示但使用 NOT_FOUND 缓存头", async () => {
    const store = new Map();
    const cnEntry = entry();
    const twEntry = entry("hash-2", "另一份片单");
    seedString(store, KEY_42_CN, cnEntry);
    seedString(store, "list:translation:99:tw", twEntry);
    await withBackend(store, async () => {
        const res = await invoke(handler, { query: { lists: "42,99", locale: "tw" } });
        assert.deepEqual(res.jsonBody.lists["99"], twEntry);
        assert.deepEqual(res.jsonBody.cn.lists["42"], cnEntry);
        assert.equal(res.headers["Cache-Control"], "public, max-age=120");
        assert.equal(res.headers["Vercel-CDN-Cache-Control"], "public, s-maxage=3600, stale-while-revalidate=3600");
    });
});

test("list-translations POST 用一条 MSET 写入并记录 90 天过期时间", async () => {
    const store = new Map();
    await withBackend(store, async () => {
        const res = await invoke(handler, {
            method: "POST",
            body: { lists: { 42: entry(), 99: entry("hash-2", "年度佳剧清单") } },
        });
        assert.deepEqual(res.jsonBody, { counts: { lists: 2 } });
        assert.equal(store.msetCommands.length, 1);
        assert.equal(store.msetCommands[0][0], "MSET");
        assert.ok(Number.isFinite(getString(store, KEY_42_CN).expiresAt));
        assert.equal(store.expireCommands, undefined);
    });
});

test("list-translations POST 非法 ID 和空 body 不写 KV", async () => {
    const store = new Map();
    await withBackend(store, async () => {
        const invalid = await invoke(handler, { method: "POST", body: { lists: { abc: entry(), 44: { description: {} } } } });
        assert.deepEqual(invalid.jsonBody, { counts: { lists: 0 } });
        assert.equal(store.msetCommands, undefined);
        const empty = await invoke(handler, { method: "POST", body: {} });
        assert.deepEqual(empty.jsonBody, { counts: { lists: 0 } });
    });
});

test("list-translations KV 未配置返回 500，非 GET/POST 返回 405", async () => {
    const store = new Map();
    await withBackend(
        store,
        async () => {
            const missing = await invoke(handler, { query: { lists: "42" } });
            assert.equal(missing.statusCode, 500);
        },
        { kvUrl: null },
    );
    await withBackend(store, async () => {
        const method = await invoke(handler, { method: "DELETE" });
        assert.equal(method.statusCode, 405);
        assert.equal(method.headers.Allow, "GET, POST");
    });
});
