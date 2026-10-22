import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { getHashValue, getString, invoke, seedHash, seedString, withBackend } from "./helpers/backend-v2.mjs";

const require = createRequire(import.meta.url);
const translationsHandler = require("../api/trakt/translations.js");
const imagesHandler = require("../api/trakt/images.js");
const adminHandler = require("../api/trakt/translations/admin.js");
const overridesHandler = require("../api/trakt/translation-overrides.js");
const { CACHE_STATUS, getResponseCacheStatus, normalizeTranslationOverrideEntry, FOUND_TTL_SECONDS } = require("../lib/trakt-cache/normalize.js");

const OVERRIDES_KEY = "translation:overrides";
const MOVIE_123_CN = "translation:movies:123:cn";
const MOVIE_123_TW = "translation:movies:123:tw";
const MOVIE_456_CN = "translation:movies:456:cn";
const IMAGE_CHINESE_MOVIE_123_CN = "image:chinese:movies:123:cn";
const IMAGE_CHINESE_SHOW_555_CN = "image:chinese:shows:555:cn";
const IMAGE_CHINESE_SEASON_555_1_CN = "image:chinese:seasons:555:1:cn";

function adminHeaders(token = "test-admin-token") {
    return { authorization: `Bearer ${token}` };
}

function translation(title, extra = {}) {
    return { status: 1, translation: { title, overview: null, tagline: null }, ...extra };
}

function override(title) {
    return { translation: { title }, updatedAt: 1710000000000 };
}

test("override 规范化不再接受旧根 translation 字段", () => {
    const normalized = normalizeTranslationOverrideEntry({ translation: { title: "旧根字段" }, updatedAt: 1710000000000 });
    assert.equal(normalized.cn, undefined);
});

test("translations GET 返回 String key，overrides GET 从 Hash 重建并设置缓存头", async () => {
    const store = new Map();
    seedString(store, MOVIE_123_CN, translation("自动标题"));
    seedHash(store, OVERRIDES_KEY, { "movies:123:cn": JSON.stringify(override("人工标题")) });

    await withBackend(store, async () => {
        const res = await invoke(translationsHandler, { query: { movies: "123" } });
        assert.equal(res.statusCode, 200);
        assert.equal(res.jsonBody.movies["123"].translation.title, "自动标题");
        assert.ok(res.jsonBody.movies["123"].expiresAt > Date.now());
        assert.ok(res.jsonBody.movies["123"].expiresAt <= Date.now() + FOUND_TTL_SECONDS * 1000);
        assert.deepEqual(store.mgetCommands, [["MGET", MOVIE_123_CN]]);

        const overrideRes = await invoke(overridesHandler, {});
        assert.equal(overrideRes.statusCode, 200);
        assert.deepEqual(overrideRes.jsonBody.movies["123"].cn.translation, { title: "人工标题" });
        assert.equal(overrideRes.headers["Cache-Control"], "public, max-age=60");
        assert.equal(overrideRes.headers["CDN-Cache-Control"], "public, s-maxage=300, stale-while-revalidate=300");
        assert.deepEqual(store.hgetallCommands, [["HGETALL", OVERRIDES_KEY]]);
    });
});

test("overrides Hash 拒绝 __proto__ 字段且不会污染原型", async () => {
    const store = new Map();
    seedHash(store, OVERRIDES_KEY, { "movies:__proto__:cn": JSON.stringify(override("恶意标题")) });
    delete Object.prototype.cn;

    try {
        await withBackend(store, async () => {
            const overridesRes = await invoke(overridesHandler, {});
            assert.equal(overridesRes.statusCode, 200);
            assert.deepEqual(overridesRes.jsonBody, { shows: {}, movies: {}, episodes: {} });
            assert.equal(Object.hasOwn(Object.prototype, "cn"), false);

            const putRes = await invoke(adminHandler, {
                method: "PUT",
                headers: adminHeaders(),
                body: { type: "movies", id: "__proto__", locale: "cn", translation: { title: "恶意标题" } },
            });
            assert.equal(putRes.statusCode, 400);
            assert.equal(putRes.jsonBody.error, "Invalid id");
            assert.equal(Object.hasOwn(Object.prototype, "cn"), false);
        });
    } finally {
        delete Object.prototype.cn;
    }
});

test("images GET 读取按 locale 拆分的 String key", async () => {
    const store = new Map();
    seedString(store, IMAGE_CHINESE_MOVIE_123_CN, { poster: { status: 1, url: "https://img/movie.jpg" } });
    seedString(store, IMAGE_CHINESE_SHOW_555_CN, { poster: { status: 1, url: "https://img/show.jpg" } });
    seedString(store, IMAGE_CHINESE_SEASON_555_1_CN, { poster: { status: 1, url: "https://img/season.jpg" } });

    await withBackend(store, async () => {
        const res = await invoke(imagesHandler, { query: { movies: "123", shows: "555", seasons: "555:1", mode: "chinese" } });
        assert.equal(res.jsonBody.movies["123"].poster.url, "https://img/movie.jpg");
        assert.ok(res.jsonBody.movies["123"].poster.expiresAt > Date.now());
        assert.ok(res.jsonBody.movies["123"].poster.expiresAt <= Date.now() + FOUND_TTL_SECONDS * 1000);
        assert.equal(res.jsonBody.shows["555"].poster.url, "https://img/show.jpg");
        assert.equal(res.jsonBody.seasons["555:1"].poster.url, "https://img/season.jpg");
        assert.equal(res.headers["Cache-Control"], "public, max-age=300");
    });
});

test("images GET 保留 PARTIAL_FOUND 内容并使用 PARTIAL_FOUND 缓存头", async () => {
    const store = new Map();
    seedString(store, IMAGE_CHINESE_MOVIE_123_CN, {
        poster: { status: 2, url: "https://img/partial.jpg", expiresAt: Date.now() + 60_000 },
    });
    await withBackend(store, async () => {
        const res = await invoke(imagesHandler, { query: { movies: "123", mode: "chinese" } });
        assert.equal(res.jsonBody.movies["123"].poster.status, 2);
        assert.equal(res.jsonBody.movies["123"].poster.url, "https://img/partial.jpg");
        assert.equal(res.headers["Cache-Control"], "public, max-age=120");
        assert.equal(res.headers["Vercel-CDN-Cache-Control"], "public, s-maxage=3600, stale-while-revalidate=3600");
    });
});

test("images GET tw 目标字段过期时回带 cn fallback", async () => {
    const store = new Map();
    seedString(store, "image:chinese:movies:123:tw", {
        poster: { status: 3, expiresAt: Date.now() - 1_000 },
        logo: { status: 3, expiresAt: Date.now() - 1_000 },
    });
    seedString(store, IMAGE_CHINESE_MOVIE_123_CN, {
        poster: { status: 1, url: "https://img/cn.jpg" },
        logo: { status: 1, url: "https://img/cn-logo.png" },
    });
    await withBackend(store, async () => {
        const res = await invoke(imagesHandler, { query: { movies: "123", mode: "chinese", locale: "tw" } });
        assert.equal(res.jsonBody.movies["123"], undefined);
        assert.equal(res.jsonBody.cn.movies["123"].poster.url, "https://img/cn.jpg");
        assert.equal(res.headers["Cache-Control"], "public, max-age=120");
    });
});

test("images GET 过滤已过期的 poster/logo 字段", async () => {
    const store = new Map();
    seedString(store, IMAGE_CHINESE_MOVIE_123_CN, {
        poster: { status: 3, expiresAt: Date.now() - 1000 },
        logo: { status: 1, url: "https://img/logo.png", expiresAt: null },
    });
    await withBackend(store, async () => {
        const res = await invoke(imagesHandler, { query: { movies: "123", mode: "chinese" } });
        assert.equal(res.jsonBody.movies["123"].poster, undefined);
        assert.equal(res.jsonBody.movies["123"].logo.url, "https://img/logo.png");
    });
});

test("images POST 用一条 MSET 写入不同 mode/group 的 locale key", async () => {
    const store = new Map();
    await withBackend(store, async () => {
        const res = await invoke(imagesHandler, {
            method: "POST",
            body: {
                modes: {
                    chinese: {
                        movies: { 123: { poster: { status: 1, url: "https://img/chinese.jpg" } } },
                        seasons: { "555:1": { poster: { status: 3 } } },
                    },
                    original: {
                        movies: { 123: { poster: { status: 1, url: "https://img/original.jpg" } } },
                    },
                },
            },
        });
        assert.deepEqual(res.jsonBody.counts, { shows: 0, movies: 2, seasons: 1 });
        assert.equal(store.msetCommands.length, 1);
        const command = store.msetCommands[0];
        assert.equal(command[0], "MSET");
        assert.ok(command.includes("image:chinese:movies:123:cn"));
        assert.ok(command.includes("image:chinese:seasons:555:1:cn"));
        assert.ok(command.includes("image:original:movies:123:cn"));
        assert.ok(Number.isFinite(getString(store, "image:chinese:seasons:555:1:cn").poster.expiresAt));
        assert.equal(store.expireCommands, undefined);
    });
});

test("images POST 保留 PARTIAL_FOUND URL 和 30 天 TTL", async () => {
    const store = new Map();
    await withBackend(store, async () => {
        const res = await invoke(imagesHandler, {
            method: "POST",
            body: { modes: { chinese: { movies: { 123: { poster: { status: 2, url: "https://img/partial.jpg" } } } } } },
        });
        assert.equal(res.statusCode, 200);
        const stored = getString(store, IMAGE_CHINESE_MOVIE_123_CN);
        assert.equal(stored.poster.status, 2);
        assert.equal(stored.poster.url, "https://img/partial.jpg");
        assert.ok(stored.poster.expiresAt > Date.now() + 29 * 24 * 60 * 60 * 1000);
    });
});

test("translations POST 保留 status 2 内容，并使用 PARTIAL_FOUND 缓存头", async () => {
    const store = new Map();
    await withBackend(store, async () => {
        const post = await invoke(translationsHandler, {
            method: "POST",
            body: { movies: { 123: { status: 2, translation: { title: "部分标题" } } } },
        });
        assert.equal(post.statusCode, 200);
        const stored = getString(store, MOVIE_123_CN);
        assert.equal(stored.status, 2);
        assert.equal(stored.translation.title, "部分标题");
        assert.ok(Number.isFinite(stored.expiresAt));

        const get = await invoke(translationsHandler, { query: { movies: "123" } });
        assert.equal(get.jsonBody.movies["123"].status, 2);
        assert.equal(get.jsonBody.movies["123"].translation.title, "部分标题");
        assert.equal(get.headers["Cache-Control"], "public, max-age=120");
    });
});

test("translations POST 用一条 MSET 写入 cn/tw 与 complete 标记", async () => {
    const store = new Map();
    await withBackend(store, async () => {
        const res = await invoke(translationsHandler, {
            method: "POST",
            body: {
                locale: "tw",
                shows: { 101: translation("剧集") },
                movies: { 123: translation("電影", { complete: true }) },
                episodes: { "301:1:1": translation("集") },
                cn: { movies: { 123: translation("电影") } },
            },
        });
        assert.deepEqual(res.jsonBody.counts, { shows: 1, movies: 1, episodes: 1 });
        assert.equal(store.msetCommands.length, 1);
        assert.ok(store.msetCommands[0].includes(MOVIE_123_TW));
        assert.ok(store.msetCommands[0].includes("translation:shows:101:tw"));
        assert.ok(store.msetCommands[0].includes("translation:episodes:301:1:1:tw"));
        assert.equal(getString(store, MOVIE_123_TW).complete, true);
        assert.equal(getString(store, "translation:movies:123:cn").translation.title, "电影");
    });
});

test("admin PUT/GET/DELETE 使用 Hash field 且不覆盖其它 locale", async () => {
    const store = new Map();
    seedString(store, MOVIE_123_CN, translation("自动标题"));
    seedHash(store, OVERRIDES_KEY, { "movies:123:cn": JSON.stringify(override("旧人工标题")) });

    await withBackend(store, async () => {
        const put = await invoke(adminHandler, {
            method: "PUT",
            headers: adminHeaders(),
            body: { type: "movies", id: "123", locale: "tw", translation: { title: "台灣標題" } },
        });
        assert.equal(put.statusCode, 200);
        assert.equal(put.jsonBody.override.translation.title, "台灣標題");
        assert.ok(store.hsetCommands.some((command) => command[0] === "HSET" && command.includes("movies:123:tw")));
        assert.equal(getHashValue(store, OVERRIDES_KEY)["movies:123:cn"].includes("旧人工标题"), true);

        const item = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: { action: "item", type: "movies", id: "123", locale: "tw" },
        });
        assert.equal(item.jsonBody.override.translation.title, "台灣標題");
        assert.equal(item.jsonBody.autoEntry, null);
        assert.equal(item.jsonBody.autoKey, MOVIE_123_TW);
        assert.equal(item.jsonBody.overrideKey, OVERRIDES_KEY);
        assert.equal(item.jsonBody.overrideField, "movies:123:tw");
        assert.equal(store.hmgetCommands.length, 2);

        const cnItem = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: { action: "item", type: "movies", id: "123", locale: "cn" },
        });
        assert.equal(cnItem.jsonBody.autoEntry.translation.title, "自动标题");
        assert.equal(cnItem.jsonBody.override.translation.title, "旧人工标题");
        assert.equal(store.hmgetCommands.length, 3);

        const deleted = await invoke(adminHandler, {
            method: "DELETE",
            headers: adminHeaders(),
            query: { type: "movies", id: "123", target: "override", locale: "tw" },
        });
        assert.equal(deleted.statusCode, 200);
        assert.equal(getHashValue(store, OVERRIDES_KEY)["movies:123:tw"], undefined);
        assert.ok(store.hdelCommands.some((command) => command.includes("movies:123:tw")));
    });
});

test("admin 支持季级覆盖（shows 组的 showId:season 形态）", async () => {
    const store = new Map();
    seedString(store, "translation:shows:555:1:cn", translation("第一季自动标题"));

    await withBackend(store, async () => {
        const put = await invoke(adminHandler, {
            method: "PUT",
            headers: adminHeaders(),
            body: { type: "shows", id: "555:1", locale: "cn", translation: { title: "第一季人工标题" } },
        });
        assert.equal(put.statusCode, 200);
        assert.equal(getHashValue(store, OVERRIDES_KEY)["shows:555:1:cn"] !== undefined, true);

        const overridesRes = await invoke(overridesHandler, {});
        assert.equal(overridesRes.jsonBody.shows["555:1"].cn.translation.title, "第一季人工标题");
        assert.equal(overridesRes.jsonBody.shows["555"], undefined);

        const item = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: { action: "item", type: "shows", id: "555:1", locale: "cn" },
        });
        assert.equal(item.statusCode, 200);
        assert.equal(item.jsonBody.override.translation.title, "第一季人工标题");
        assert.equal(item.jsonBody.autoEntry.translation.title, "第一季自动标题");
        assert.equal(item.jsonBody.overrideField, "shows:555:1:cn");

        const search = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: { action: "list", type: "shows", q: "555:1", locale: "cn" },
        });
        assert.equal(search.statusCode, 200);
        assert.deepEqual(
            search.jsonBody.items.map((entry) => entry.id),
            ["555:1"],
        );

        const removed = await invoke(adminHandler, {
            method: "DELETE",
            headers: adminHeaders(),
            query: { type: "shows", id: "555:1", target: "all", locale: "cn" },
        });
        assert.equal(removed.statusCode, 200);
        assert.equal(getHashValue(store, OVERRIDES_KEY)?.["shows:555:1:cn"], undefined);
        assert.equal(getString(store, "translation:shows:555:1:cn"), null);
    });
});

test("admin list 使用新的 locale 扫描模式，并支持标题搜索", async () => {
    const store = new Map();
    seedString(store, MOVIE_123_CN, translation("自动标题"));
    seedString(store, MOVIE_456_CN, translation("另一部电影"));
    seedHash(store, OVERRIDES_KEY, { "movies:123:cn": JSON.stringify(override("人工标题")) });
    store.traktSearchResults = { movie: [{ type: "movie", movie: { ids: { trakt: 123 } } }] };

    await withBackend(store, async () => {
        const list = await invoke(adminHandler, { headers: adminHeaders(), query: { type: "movies", locale: "cn" } });
        assert.equal(list.statusCode, 200);
        assert.equal(list.jsonBody.items.length, 2);
        assert.ok(store.scanCommands.some((command) => command.includes("translation:movies:*:cn")));

        const search = await invoke(adminHandler, { headers: adminHeaders(), query: { type: "movies", locale: "cn", q: "自动标题" } });
        assert.equal(search.statusCode, 200);
        assert.equal(search.jsonBody.items[0].id, "123");
        assert.equal(store.traktSearchRequests.length, 1);
    });
});

test("admin list 可以筛选并保留 PARTIAL_FOUND 状态", async () => {
    const store = new Map();
    seedString(store, MOVIE_123_CN, { status: 2, translation: { title: "部分标题" }, expiresAt: Date.now() + 60_000 });
    seedString(store, MOVIE_456_CN, translation("完整标题"));
    await withBackend(store, async () => {
        const res = await invoke(adminHandler, { headers: adminHeaders(), query: { type: "movies", locale: "cn", status: "partial_found" } });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(
            res.jsonBody.items.map((item) => item.id),
            ["123"],
        );
        assert.equal(res.jsonBody.items[0].effectiveEntry.status, CACHE_STATUS.PARTIAL_FOUND);
    });
});

test("admin auth、KV 未配置和 405 处理正确", async () => {
    const store = new Map();
    await withBackend(store, async () => {
        const unauthorized = await invoke(adminHandler, { headers: { authorization: "Bearer wrong" } });
        assert.equal(unauthorized.statusCode, 401);
        const method = await invoke(adminHandler, { method: "POST", headers: adminHeaders() });
        assert.equal(method.statusCode, 400);
    });
    await withBackend(
        store,
        async () => {
            const missing = await invoke(translationsHandler, { query: { movies: "123" } });
            assert.equal(missing.statusCode, 500);
        },
        { kvUrl: null },
    );
});

test("translation cache 区分 FOUND、PARTIAL_FOUND 和 NOT_FOUND", async () => {
    assert.equal(getResponseCacheStatus({ movies: { 123: { status: CACHE_STATUS.FOUND } } }, { movies: 1 }), CACHE_STATUS.FOUND);
    assert.equal(getResponseCacheStatus({ movies: { 123: { status: CACHE_STATUS.PARTIAL_FOUND } } }, { movies: 1 }), CACHE_STATUS.PARTIAL_FOUND);
    assert.equal(getResponseCacheStatus({ movies: { 123: { status: CACHE_STATUS.PARTIAL_FOUND } } }, { movies: 2 }), CACHE_STATUS.NOT_FOUND);
    assert.equal(getResponseCacheStatus({ movies: { 123: { poster: { status: CACHE_STATUS.PARTIAL_FOUND } } } }, { movies: 1 }), CACHE_STATUS.PARTIAL_FOUND);
});

test("translation cache 只有全部命中时才使用 FOUND", async () => {
    const store = new Map();
    seedString(store, MOVIE_123_CN, translation("完整标题"));
    seedString(store, MOVIE_456_CN, { status: 2, translation: { title: "部分标题", overview: null, tagline: null } });
    await withBackend(store, async () => {
        const allFound = await invoke(translationsHandler, { query: { movies: "123" } });
        assert.equal(allFound.headers["Cache-Control"], "public, max-age=300");
        assert.equal(allFound.headers["Vercel-CDN-Cache-Control"], "public, s-maxage=604800, stale-while-revalidate=604800");

        const partial = await invoke(translationsHandler, { query: { movies: "123,456" } });
        assert.equal(partial.headers["Cache-Control"], "public, max-age=120");
        assert.equal(partial.headers["Vercel-CDN-Cache-Control"], "public, s-maxage=3600, stale-while-revalidate=3600");

        const legacyPartial = await invoke(translationsHandler, { query: { movies: "456" } });
        assert.equal(legacyPartial.jsonBody.movies["456"].status, 2);
        assert.equal(legacyPartial.jsonBody.movies["456"].translation.title, "部分标题");
        assert.equal(legacyPartial.headers["Cache-Control"], "public, max-age=120");
    });
});
