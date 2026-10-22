import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { getString, invoke, seedString, withBackend } from "./helpers/backend-v2.mjs";

const require = createRequire(import.meta.url);
const handler = require("../api/trakt/credits.js");
const { CACHE_STATUS, getCreditCacheStatus } = require("../api/trakt/translation-cache.js");

const MOVIE_KEY = "credit:movies:123";
const SHOW_KEY = "credit:shows:456";

function completeEntry(title = "电影") {
    return {
        subject: { title, targetType: "movies" },
        seasons: { 1: { episodes: 10 } },
        credits: { cast: [{ name: "演员" }] },
    };
}

test("douban GET 使用 MGET 批量读取并设置 FOUND 缓存头", async () => {
    const store = new Map();
    seedString(store, MOVIE_KEY, completeEntry());
    seedString(store, SHOW_KEY, { ...completeEntry("剧集"), subject: { title: "剧集", targetType: "shows" } });
    await withBackend(store, async () => {
        const res = await invoke(handler, { query: { movies: "123", shows: "456" } });
        assert.equal(res.statusCode, 200);
        assert.equal(res.jsonBody.movies["123"].subject.title, "电影");
        assert.equal(res.jsonBody.shows["456"].subject.title, "剧集");
        assert.ok(res.jsonBody.movies["123"].expiresAt > Date.now());
        assert.ok(res.jsonBody.shows["456"].expiresAt > Date.now());
        assert.equal(res.headers["Cache-Control"], "public, max-age=300");
        assert.deepEqual(store.mgetCommands, [["MGET", MOVIE_KEY, SHOW_KEY]]);
    });
});

test("douban GET partial entry 原样返回但使用 PARTIAL_FOUND 缓存头", async () => {
    const store = new Map();
    seedString(store, MOVIE_KEY, { subject: { title: "电影", targetType: "movies" }, expiresAt: Date.now() + 60_000 });
    await withBackend(store, async () => {
        const res = await invoke(handler, { query: { movies: "123" } });
        assert.equal(res.jsonBody.movies["123"].subject.title, "电影");
        assert.equal(res.headers["Cache-Control"], "public, max-age=120");
        assert.equal(res.headers["CDN-Cache-Control"], "public, s-maxage=3600, stale-while-revalidate=3600");
    });
});

test("credits cache status 区分完整、partial 和缺失条目", () => {
    assert.equal(getCreditCacheStatus({ movies: { 123: completeEntry() }, shows: {} }, { movies: 1, shows: 0 }), CACHE_STATUS.FOUND);
    assert.equal(getCreditCacheStatus({ movies: { 123: { subject: { title: "电影", targetType: "movies" } } }, shows: {} }, { movies: 1, shows: 0 }), CACHE_STATUS.PARTIAL_FOUND);
    assert.equal(getCreditCacheStatus({ movies: {}, shows: {} }, { movies: 1, shows: 0 }), CACHE_STATUS.NOT_FOUND);
});

test("douban GET 未命中时使用新的 NOT_FOUND 缓存头", async () => {
    const store = new Map();
    await withBackend(store, async () => {
        const res = await invoke(handler, { query: { movies: "123" } });
        assert.deepEqual(res.jsonBody, { movies: {}, shows: {} });
        assert.equal(res.headers["Cache-Control"], "public, max-age=120");
        assert.equal(res.headers["CDN-Cache-Control"], "public, s-maxage=3600, stale-while-revalidate=3600");
    });
});

test("douban POST 完整 entry 用一条 MSET 写入并记录 30 天过期时间", async () => {
    const store = new Map();
    await withBackend(store, async () => {
        const res = await invoke(handler, {
            method: "POST",
            body: { movies: { 123: completeEntry() }, shows: { 456: { ...completeEntry("剧集"), subject: { title: "剧集", targetType: "shows" } } } },
        });
        assert.deepEqual(res.jsonBody, { counts: { movies: 1, shows: 1 } });
        assert.equal(store.msetCommands.length, 1);
        assert.ok(Number.isFinite(getString(store, MOVIE_KEY).expiresAt));
        assert.ok(Number.isFinite(getString(store, SHOW_KEY).expiresAt));
        assert.equal(store.mgetCommands, undefined);
    });
});

test("douban POST partial entry 会先 MGET 合并再 MSET", async () => {
    const store = new Map();
    seedString(store, MOVIE_KEY, { subject: { title: "旧标题" }, seasons: { 1: {} } });
    await withBackend(store, async () => {
        const res = await invoke(handler, {
            method: "POST",
            body: { movies: { 123: { credits: { cast: [{ name: "新演员" }] } } } },
        });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(store.mgetCommands, [["MGET", MOVIE_KEY]]);
        assert.equal(getString(store, MOVIE_KEY).subject.title, "旧标题");
        assert.equal(getString(store, MOVIE_KEY).credits.cast[0].name, "新演员");
    });
});

test("douban POST 空 body 和 KV 未配置处理正确", async () => {
    const store = new Map();
    await withBackend(store, async () => {
        const empty = await invoke(handler, { method: "POST", body: {} });
        assert.deepEqual(empty.jsonBody, { counts: { movies: 0, shows: 0 } });
        assert.equal(store.msetCommands, undefined);
    });
    await withBackend(
        store,
        async () => {
            const missing = await invoke(handler, { query: { movies: "123" } });
            assert.equal(missing.statusCode, 500);
        },
        { kvUrl: null },
    );
});
