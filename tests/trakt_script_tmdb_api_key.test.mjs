import assert from "node:assert/strict";
import test from "node:test";

import { TMDB_API_KEY_CACHE_KEY } from "../trakt_simplified_chinese/src/outbound/tmdb-client.mjs";

import { TEST_TMDB_API_KEY } from "./helpers/run-script.mjs";
import {
    createHttpErrorMock,
    createHttpStatusMock,
    createTmdbImagesResponse,
    createUnifiedPersistentData,
    parseUnifiedCache,
    runResponseCase,
} from "./helpers/trakt-test-helpers.mjs";

const TEST_BACKEND_BASE_URL = "https://backend.example";
const TEST_API_KEYS_URL = `${TEST_BACKEND_BASE_URL}/api/trakt/apikeys`;
const TMDB_REQUEST_PATTERN = /^https:\/\/api\.tmdb\.org\//;
const TMDB_IMAGES_PATTERN = "regex:^https://api\\.tmdb\\.org/3/movie/456/images";
const REMOTE_CACHE_REQUEST_PATTERN = /\/api\/trakt\/(translations|translation-overrides|images|credits|people-names|comment-translations|list-translations)(?:\?|$)/;

function createApiKeysBody(apiKey) {
    return JSON.stringify({ keys: { tmdb: apiKey } });
}

function createApiKeyCacheData(apiKey, expiresAt, { invalidApiKey = "", invalidUntil = 0 } = {}) {
    return {
        ...createUnifiedPersistentData(),
        [TMDB_API_KEY_CACHE_KEY]: JSON.stringify({ apiKey, expiresAt, invalidApiKey, invalidUntil }),
    };
}

function readApiKeyCache(persistentData) {
    return JSON.parse(String(persistentData[TMDB_API_KEY_CACHE_KEY] ?? "{}"));
}

function readCachedApiKey(persistentData) {
    return readApiKeyCache(persistentData).apiKey;
}

// 走一次会触发海报替换的详情响应：chinese 模式必然需要 TMDb 图片，是验证 key 下发链路最短的入口。
function runPosterCase({ argument = {}, persistentData, httpGetMocks = {} } = {}) {
    return runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body: JSON.stringify({
            title: "Original Title",
            overview: "Original Overview",
            tagline: "Original Tagline",
            ids: { trakt: 123, tmdb: 456 },
            language: "en",
            country: "US",
            available_translations: ["en", "zh"],
            images: {
                poster: ["https://walter.trakt.tv/images/movies/000/000/123/posters/original.jpg"],
                logo: ["https://walter.trakt.tv/images/movies/000/000/123/logos/original.png"],
            },
        }),
        argument: { backendBaseUrl: TEST_BACKEND_BASE_URL, posterImageMode: "chinese", ...argument },
        persistentData: persistentData ?? createUnifiedPersistentData(),
        httpGetMocks: {
            // 兜底：original 模式的补充请求不参与断言，避免未 mock 的 URL 直接报错
            [TMDB_IMAGES_PATTERN]: createTmdbImagesResponse([]),
            ...httpGetMocks,
        },
    });
}

function findRequestIndex(httpLogs, predicate) {
    return httpLogs.findIndex((log) => log.method === "GET" && predicate(log.url));
}

const CHINESE_POSTER = {
    iso_639_1: "zh",
    iso_3166_1: "CN",
    file_path: "/cn-poster.jpg",
    vote_average: 8,
    vote_count: 10,
};

test("需要 TMDb 时先向后端取 key，再用下发 key 请求 TMDb 并写回本地缓存", async () => {
    const { result, httpLogs, persistentData } = await runPosterCase({
        httpGetMocks: {
            [`https://api.tmdb.org/3/movie/456/images?language=zh%2Cen&api_key=${TEST_TMDB_API_KEY}`]: createTmdbImagesResponse([CHINESE_POSTER]),
        },
    });

    const apiKeysIndex = findRequestIndex(httpLogs, (url) => url === TEST_API_KEYS_URL);
    const tmdbIndex = findRequestIndex(httpLogs, (url) => url.includes(`api_key=${TEST_TMDB_API_KEY}`));
    assert.ok(apiKeysIndex >= 0, "应先请求后端 key 接口");
    assert.ok(tmdbIndex > apiKeysIndex, "TMDb 请求应发生在取到 key 之后");

    // 命中下发的 key 后能真正取回中文海报
    assert.match(String(JSON.parse(result.body).images.poster[0]), /\/w780\/cn-poster\.jpg$/);
    assert.equal(readCachedApiKey(persistentData), TEST_TMDB_API_KEY);
});

test("本地缓存的 key 未过期时不请求后端 key 接口", async () => {
    const { httpLogs } = await runPosterCase({
        persistentData: createApiKeyCacheData("cached-tmdb-key", Date.now() + 60 * 60 * 1000),
        httpGetMocks: {
            "https://api.tmdb.org/3/movie/456/images?language=zh%2Cen&api_key=cached-tmdb-key": createTmdbImagesResponse([CHINESE_POSTER]),
        },
    });

    assert.equal(
        findRequestIndex(httpLogs, (url) => url === TEST_API_KEYS_URL),
        -1,
    );
    assert.ok(findRequestIndex(httpLogs, (url) => url.includes("api_key=cached-tmdb-key")) >= 0);
});

test("本地缓存的 key 已过期时重新向后端取 key", async () => {
    const { httpLogs, persistentData } = await runPosterCase({
        persistentData: createApiKeyCacheData("expired-tmdb-key", Date.now() - 1000),
        httpGetMocks: {
            [`https://api.tmdb.org/3/movie/456/images?language=zh%2Cen&api_key=${TEST_TMDB_API_KEY}`]: createTmdbImagesResponse([CHINESE_POSTER]),
        },
    });

    assert.ok(findRequestIndex(httpLogs, (url) => url === TEST_API_KEYS_URL) >= 0, "过期缓存应触发后端重取");
    assert.equal(
        findRequestIndex(httpLogs, (url) => url.includes("api_key=expired-tmdb-key")),
        -1,
    );
    assert.equal(readCachedApiKey(persistentData), TEST_TMDB_API_KEY);
});

test("后端未配置 key（500）时不请求 TMDb，也不写图片负缓存", async () => {
    const { httpLogs, persistentData } = await runPosterCase({
        httpGetMocks: {
            [TEST_API_KEYS_URL]: createHttpStatusMock(500, '{"error":"No API key is configured."}'),
        },
    });

    assert.ok(findRequestIndex(httpLogs, (url) => url === TEST_API_KEYS_URL) >= 0);
    assert.equal(
        httpLogs.some((log) => TMDB_REQUEST_PATTERN.test(log.url)),
        false,
    );
    assert.deepEqual(parseUnifiedCache(persistentData).trakt.image, {});
    assert.equal(persistentData[TMDB_API_KEY_CACHE_KEY], undefined);
});

test("后端不可达时不请求 TMDb，也不写图片负缓存", async () => {
    const { httpLogs, persistentData } = await runPosterCase({
        httpGetMocks: {
            [TEST_API_KEYS_URL]: createHttpErrorMock("network unreachable"),
        },
    });

    assert.equal(
        httpLogs.some((log) => TMDB_REQUEST_PATTERN.test(log.url)),
        false,
    );
    assert.deepEqual(parseUnifiedCache(persistentData).trakt.image, {});
});

test("debugMode 禁用远端缓存时仍下发 key，只是不碰远端缓存接口", async () => {
    for (const debugMode of ["disableRemote", "disableAll"]) {
        const { httpLogs, result } = await runPosterCase({
            argument: { debugMode },
            httpGetMocks: {
                [`https://api.tmdb.org/3/movie/456/images?language=zh%2Cen&api_key=${TEST_TMDB_API_KEY}`]: createTmdbImagesResponse([CHINESE_POSTER]),
            },
        });

        // key 属于配置下发，不是缓存：禁掉它会让海报能力直接消失
        assert.ok(findRequestIndex(httpLogs, (url) => url === TEST_API_KEYS_URL) >= 0, `${debugMode} 下仍应下发 key`);
        assert.ok(findRequestIndex(httpLogs, (url) => url.includes(`api_key=${TEST_TMDB_API_KEY}`)) >= 0, `${debugMode} 下 TMDb 应可用`);
        assert.match(String(JSON.parse(result.body).images.poster[0]), /\/w780\/cn-poster\.jpg$/);

        assert.equal(
            httpLogs.some((log) => REMOTE_CACHE_REQUEST_PATTERN.test(log.url)),
            false,
            `${debugMode} 下仍不应请求远端缓存接口`,
        );
    }
});

test("原图模式既不取 key 也不请求 TMDb", async () => {
    const { httpLogs } = await runPosterCase({ argument: { posterImageMode: "default" } });

    assert.equal(
        findRequestIndex(httpLogs, (url) => url === TEST_API_KEYS_URL),
        -1,
    );
    assert.equal(
        httpLogs.some((log) => TMDB_REQUEST_PATTERN.test(log.url)),
        false,
    );
});

test("TMDb 返回 401 时失效本地 key 并重取一次，不必等 TTL 过期", async () => {
    const rotatedKey = "rotated-tmdb-key";
    const { httpLogs, persistentData } = await runPosterCase({
        persistentData: createApiKeyCacheData("stale-tmdb-key", Date.now() + 60 * 60 * 1000),
        httpGetMocks: {
            [TEST_API_KEYS_URL]: createApiKeysBody(rotatedKey),
            "https://api.tmdb.org/3/movie/456/images?language=zh%2Cen&api_key=stale-tmdb-key": createHttpStatusMock(401, "{}"),
            [`https://api.tmdb.org/3/movie/456/images?language=zh%2Cen&api_key=${rotatedKey}`]: createTmdbImagesResponse([CHINESE_POSTER]),
        },
    });

    assert.ok(findRequestIndex(httpLogs, (url) => url.includes("api_key=stale-tmdb-key")) >= 0, "应先用缓存 key 试一次");
    assert.ok(findRequestIndex(httpLogs, (url) => url === TEST_API_KEYS_URL) >= 0, "401 后应重取 key");
    assert.ok(findRequestIndex(httpLogs, (url) => url.includes(`api_key=${rotatedKey}`)) >= 0, "应用新 key 重试");
    assert.equal(readCachedApiKey(persistentData), rotatedKey);
    assert.equal(readApiKeyCache(persistentData).invalidApiKey, "", "换到可用 key 后应清掉失效标记");
});

test("401 且后端还没换出新 key 时拉黑旧 key，只撞一次 TMDb", async () => {
    const staleKey = "stale-tmdb-key";
    const { httpLogs, persistentData } = await runPosterCase({
        persistentData: createApiKeyCacheData(staleKey, Date.now() + 60 * 60 * 1000),
        httpGetMocks: {
            [TEST_API_KEYS_URL]: createApiKeysBody(staleKey),
            [`https://api.tmdb.org/3/movie/456/images?language=zh%2Cen&api_key=${staleKey}`]: createHttpStatusMock(401, "{}"),
        },
    });

    const tmdbRequests = httpLogs.filter((log) => TMDB_REQUEST_PATTERN.test(log.url));
    assert.equal(tmdbRequests.length, 1, "后端没给新 key 时不应再拿同一个 key 撞一次 TMDb");
    assert.ok(findRequestIndex(httpLogs, (url) => url === TEST_API_KEYS_URL) >= 0, "401 后应立刻问后端");

    const cache = readApiKeyCache(persistentData);
    assert.equal(cache.apiKey, "", "失效 key 不应留在缓存里继续被复用");
    assert.equal(cache.invalidApiKey, staleKey, "应把失效 key 落到持久化缓存");
});

test("下一个请求直接用后端换出的新 key，不再拿已拉黑的旧 key 撞 TMDb", async () => {
    const staleKey = "stale-tmdb-key";
    const freshKey = "fresh-tmdb-key";

    // 第一次请求：缓存里的 key 已失效，后端也还没换，于是被拉黑
    const first = await runPosterCase({
        persistentData: createApiKeyCacheData(staleKey, Date.now() + 60 * 60 * 1000),
        httpGetMocks: {
            [TEST_API_KEYS_URL]: createApiKeysBody(staleKey),
            [`https://api.tmdb.org/3/movie/456/images?language=zh%2Cen&api_key=${staleKey}`]: createHttpStatusMock(401, "{}"),
        },
    });
    assert.equal(readApiKeyCache(first.persistentData).invalidApiKey, staleKey);

    // 第二次请求（新的脚本上下文，复用持久化数据）：后端已换新 key，应立刻可用且不再碰旧 key
    const second = await runPosterCase({
        persistentData: first.persistentData,
        httpGetMocks: {
            [TEST_API_KEYS_URL]: createApiKeysBody(freshKey),
            [`https://api.tmdb.org/3/movie/456/images?language=zh%2Cen&api_key=${freshKey}`]: createTmdbImagesResponse([CHINESE_POSTER]),
        },
    });

    assert.equal(
        findRequestIndex(second.httpLogs, (url) => url.includes(`api_key=${staleKey}`)),
        -1,
        "不应再用已拉黑的 key",
    );
    assert.ok(findRequestIndex(second.httpLogs, (url) => url.includes(`api_key=${freshKey}`)) >= 0);
    assert.match(String(JSON.parse(second.result.body).images.poster[0]), /\/w780\/cn-poster\.jpg$/);
});

test("后端换出的新 key 同样无效时一并拉黑，下个请求不再撞 TMDb", async () => {
    const staleKey = "stale-tmdb-key";
    const alsoBadKey = "also-bad-tmdb-key";
    const { httpLogs, persistentData } = await runPosterCase({
        persistentData: createApiKeyCacheData(staleKey, Date.now() + 60 * 60 * 1000),
        httpGetMocks: {
            [TEST_API_KEYS_URL]: createApiKeysBody(alsoBadKey),
            [`https://api.tmdb.org/3/movie/456/images?language=zh%2Cen&api_key=${staleKey}`]: createHttpStatusMock(401, "{}"),
            [`https://api.tmdb.org/3/movie/456/images?language=zh%2Cen&api_key=${alsoBadKey}`]: createHttpStatusMock(401, "{}"),
        },
    });

    assert.equal(httpLogs.filter((log) => TMDB_REQUEST_PATTERN.test(log.url)).length, 2, "旧 key、新 key 各撞一次即可");
    assert.equal(readApiKeyCache(persistentData).invalidApiKey, alsoBadKey, "新 key 同样无效时也要拉黑");

    const next = await runPosterCase({
        persistentData,
        httpGetMocks: { [TEST_API_KEYS_URL]: createApiKeysBody(alsoBadKey) },
    });
    assert.equal(
        next.httpLogs.some((log) => TMDB_REQUEST_PATTERN.test(log.url)),
        false,
        "已拉黑的 key 不应再被拿去请求 TMDb",
    );
});

test("拉黑有效期过后允许用同一把 key 自愈，不会把 key 永久判死", async () => {
    // 模拟把瞬时 401 误判成 key 失效：拉黑已过期，后端下发的仍是同一把 key
    const key = "spurious-401-tmdb-key";
    const { httpLogs, result, persistentData } = await runPosterCase({
        persistentData: createApiKeyCacheData("", 0, { invalidApiKey: key, invalidUntil: Date.now() - 1000 }),
        httpGetMocks: {
            [TEST_API_KEYS_URL]: createApiKeysBody(key),
            [`https://api.tmdb.org/3/movie/456/images?language=zh%2Cen&api_key=${key}`]: createTmdbImagesResponse([CHINESE_POSTER]),
        },
    });

    assert.ok(findRequestIndex(httpLogs, (url) => url.includes(`api_key=${key}`)) >= 0, "拉黑过期后应再试一次");
    assert.match(String(JSON.parse(result.body).images.poster[0]), /\/w780\/cn-poster\.jpg$/);
    assert.equal(readCachedApiKey(persistentData), key);
    assert.equal(readApiKeyCache(persistentData).invalidApiKey, "", "可用后应清掉拉黑标记");
});
