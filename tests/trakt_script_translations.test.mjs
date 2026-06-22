import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_BACKEND_BASE_URL } from "../trakt_simplified_chinese/src/module-manifest.mjs";
import { convertTraditionalChineseToSimplified } from "../trakt_simplified_chinese/src/shared/chinese-script-converter.mjs";

import {
    computeStringHash,
    createCommentTranslationCache,
    createEmptyGoogleTranslateResponse,
    createGoogleTranslateResponse,
    createHttpErrorMock,
    createHttpStatusMock,
    createInvalidJsonResponse,
    createListTranslationCache,
    createMediaTranslationCache,
    createMediaTranslationEntry,
    createSentimentTranslationCache,
    createTmdbImagesResponse,
    createUnifiedPersistentData,
    extractDeepLxRequestTexts,
    parseUnifiedCache,
    readFixture,
    runRequestCase,
    runResponseCase,
    UNIFIED_CACHE_KEY,
    UNIFIED_CACHE_SCHEMA_VERSION,
} from "./helpers/trakt-test-helpers.mjs";

const GOOGLE_TRANSLATE_URL = "https://deeplx.demojameson.de5.net/google";
const TEST_BACKEND_BASE_URL = "https://backend.example";
const TEST_BACKEND_TRANSLATIONS_URL = `${TEST_BACKEND_BASE_URL}/api/trakt/translations`;
const TEST_BACKEND_IMAGES_URL = `${TEST_BACKEND_BASE_URL}/api/trakt/images`;
const TEST_DIRECT_TRANSLATION_URL = "https://api.trakt.tv/movies/123/translations/zh?extended=all";
const TEST_DIRECT_EPISODE_TRANSLATION_URL = "https://api.trakt.tv/shows/555/seasons/1/episodes/12/translations/zh?extended=all";
const TEST_TMDB_MOVIE_IMAGES_URL = "https://api.tmdb.org/3/movie/456/images?language=zh%2Cen&api_key=a0a4d50000eeb10604c5f9342c8b3f62";
const TEST_TMDB_MOVIE_IMAGES_ZH_URL = "https://api.tmdb.org/3/movie/456/images?language=zh&api_key=a0a4d50000eeb10604c5f9342c8b3f62";
const TEST_TMDB_SHOW_IMAGES_URL = "https://api.tmdb.org/3/tv/777/images?language=zh%2Cen&api_key=a0a4d50000eeb10604c5f9342c8b3f62";
const TEST_TMDB_SEASON_IMAGES_URL = "https://api.tmdb.org/3/tv/777/season/1/images?language=zh%2Cen&api_key=a0a4d50000eeb10604c5f9342c8b3f62";
const TEST_TMDB_MOVIE_IMAGES_JA_URL = "https://api.tmdb.org/3/movie/456/images?language=zh%2Cja&api_key=a0a4d50000eeb10604c5f9342c8b3f62";
const TEST_TMDB_MOVIE_DETAIL_URL = "https://api.tmdb.org/3/movie/456?api_key=a0a4d50000eeb10604c5f9342c8b3f62";

function createPendingBackendPostMocks() {
    return {
        [TEST_BACKEND_TRANSLATIONS_URL]: [createHttpStatusMock(200, "{}")],
    };
}

function createDirectTranslationLookupBody() {
    return JSON.stringify([
        {
            watchers: 1,
            movie: {
                title: "Original Title",
                overview: "Original Overview",
                tagline: "Original Tagline",
                ids: {
                    trakt: 123,
                },
                available_translations: ["zh"],
            },
        },
    ]);
}

function createEpisodeTranslationLookupBody(title = "Episode 12") {
    return JSON.stringify([
        {
            watchers: 1,
            show: {
                title: "Original Show",
                ids: {
                    trakt: 555,
                },
                available_translations: [],
            },
            episode: {
                title,
                overview: "Original Episode Overview",
                season: 1,
                number: 12,
                available_translations: ["zh"],
            },
        },
    ]);
}

function createMovieWithPoster(overrides = {}) {
    return {
        title: "Original Movie",
        overview: "Original Overview",
        tagline: "Original Tagline",
        ids: {
            trakt: 123,
            tmdb: 456,
        },
        language: "en",
        country: "US",
        available_translations: ["en", "zh"],
        images: {
            poster: ["https://walter.trakt.tv/images/movies/000/000/123/posters/original.jpg"],
            logo: ["https://walter.trakt.tv/images/movies/000/000/123/logos/original.png"],
        },
        ...overrides,
    };
}

function createShowWithPoster(overrides = {}) {
    return {
        title: "Original Show",
        overview: "Original Show Overview",
        status: "returning series",
        ids: {
            trakt: 555,
            tmdb: 777,
        },
        language: "en",
        country: "US",
        available_translations: ["en", "zh"],
        images: {
            poster: ["https://walter.trakt.tv/images/shows/000/000/555/posters/original.jpg"],
            logo: ["https://walter.trakt.tv/images/shows/000/000/555/logos/original.png"],
        },
        ...overrides,
    };
}

async function runDirectTranslationLookupCase(translationMock) {
    const httpPostMocks = createPendingBackendPostMocks();
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/movies/trending",
        body: createDirectTranslationLookupBody(),
        argument: {
            backendBaseUrl: TEST_BACKEND_BASE_URL,
        },
        httpGetMocks: {
            [TEST_DIRECT_TRANSLATION_URL]: translationMock,
        },
        httpPostMocks,
    });

    return {
        result,
        persistentData,
        backendPostQueue: httpPostMocks[TEST_BACKEND_TRANSLATIONS_URL],
    };
}

async function runEpisodeTranslationLookupCase(translationMock, title = "Episode 12") {
    const httpPostMocks = createPendingBackendPostMocks();
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/media/trending",
        body: createEpisodeTranslationLookupBody(title),
        argument: {
            backendBaseUrl: TEST_BACKEND_BASE_URL,
        },
        httpGetMocks: {
            [TEST_DIRECT_EPISODE_TRANSLATION_URL]: translationMock,
        },
        httpPostMocks,
    });

    return {
        result,
        persistentData,
        backendPostQueue: httpPostMocks[TEST_BACKEND_TRANSLATIONS_URL],
    };
}

function createGoogleFailureCases() {
    return [
        {
            name: "Google 翻译失败",
            mock: createHttpErrorMock("google translate unavailable"),
        },
        {
            name: "Google 返回 HTTP 500",
            mock: createHttpStatusMock(500),
        },
        {
            name: "Google 返回非法 JSON",
            mock: createInvalidJsonResponse(),
        },
    ];
}

test("通用繁转简会统一转换不同区域的繁体样例", () => {
    assert.equal(convertTraditionalChineseToSimplified("國行標題"), "国行标题");
    assert.equal(convertTraditionalChineseToSimplified("台灣標題"), "台湾标题");
    assert.equal(convertTraditionalChineseToSimplified("港版標語"), "港版标语");
    assert.equal(convertTraditionalChineseToSimplified("新加坡標題"), "新加坡标题");
});

test("通用繁转简对简体与空值输入保持稳定", () => {
    assert.equal(convertTraditionalChineseToSimplified("中文简介"), "中文简介");
    assert.equal(convertTraditionalChineseToSimplified(""), "");
    assert.equal(convertTraditionalChineseToSimplified(null), "");
    assert.equal(convertTraditionalChineseToSimplified(undefined), "");
});

test("/translations/zh 会把 fallback zh 响应归一化为 zh-cn 条目", async () => {
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/translations/zh?extended=all",
        body: readFixture("translations.json"),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].country, "cn");
    assert.equal(payload[0].title, "港版标题");
    assert.equal(payload[0].status, 2);
    assert.ok(persistentData[UNIFIED_CACHE_KEY]);
});

test("/translations/zh 排序后会把 zh-CN 条目放在最前", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/translations/zh?extended=all",
        body: readFixture("translations-mixed.json"),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].language, "zh");
    assert.equal(payload[0].country, "cn");
    assert.equal(payload[0].title, "国行标题");
});

test("/translations/zh 仅有 hk 条目时会按字段转成简体中文", async () => {
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/translations/zh?extended=all",
        body: readFixture("translations-traditional-hk.json"),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].country, "cn");
    assert.equal(payload[0].title, "港版标题");
    assert.equal(payload[0].overview, "繁体简介与观众评价");
    assert.equal(payload[0].tagline, "繁体标语");

    const cacheEntry = parseUnifiedCache(persistentData).trakt.translation["movie:123"];
    assert.deepEqual(cacheEntry.translation, {
        title: "港版标题",
        overview: "繁体简介与观众评价",
        tagline: "繁体标语",
    });
});

test("/translations/zh 仅有 tw 条目时会按字段转成简体中文", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/translations/zh?extended=all",
        body: readFixture("translations-traditional-tw.json"),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].country, "cn");
    assert.equal(payload[0].title, "台湾标题");
    assert.equal(payload[0].overview, "繁体剧情与观众评价");
    assert.equal(payload[0].tagline, "繁体标语");
});

test("/translations/zh 命中 cn 条目时会统一转为简体", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/translations/zh?extended=all",
        body: readFixture("translations-traditional-cn.json"),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].country, "cn");
    assert.equal(payload[0].title, "国行标题");
    assert.equal(payload[0].overview, "繁体简介与观众评价");
    assert.equal(payload[0].tagline, "繁体标语");
});

test("/translations/zh 使用 sg fallback 时也会统一转为简体", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/translations/zh?extended=all",
        body: readFixture("translations-traditional-sg.json"),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].country, "cn");
    assert.equal(payload[0].title, "新加坡标题");
    assert.equal(payload[0].overview, "繁体简介与观众评价");
    assert.equal(payload[0].tagline, "繁体标语");
});

test("/translations/zh 混合来源时所有进入结果的字段都会统一转为简体", async () => {
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/translations/zh?extended=all",
        body: readFixture("translations-traditional-mixed.json"),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].country, "cn");
    assert.equal(payload[0].title, "台湾标题");
    assert.equal(payload[0].overview, "新加坡繁体简介");
    assert.equal(payload[0].tagline, "港版标语");

    const cacheEntry = parseUnifiedCache(persistentData).trakt.translation["movie:123"];
    assert.deepEqual(cacheEntry.translation, {
        title: "台湾标题",
        overview: "新加坡繁体简介",
        tagline: "港版标语",
    });
});

test("/translations/zh 应用中文翻译前会 trim 首尾空白和全角空格", async () => {
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/translations/zh?extended=all",
        body: JSON.stringify([
            {
                language: "zh",
                country: "cn",
                title: "　 港版标题 　",
                overview: "\u3000中文简介\t",
                tagline: "  中文标语　",
            },
        ]),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].title, "港版标题");
    assert.equal(payload[0].overview, "中文简介");
    assert.equal(payload[0].tagline, "中文标语");

    const cacheEntry = parseUnifiedCache(persistentData).trakt.translation["movie:123"];
    assert.deepEqual(cacheEntry.translation, {
        title: "港版标题",
        overview: "中文简介",
        tagline: "中文标语",
    });
});

test("/translations/zh 会把简介中间连续两个或多个全角空格转成换行", async () => {
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/translations/zh?extended=all",
        body: JSON.stringify([
            {
                language: "zh",
                country: "cn",
                title: "中文标题",
                overview: "第一段　　第二段　　　第三段",
                tagline: "中文标语",
            },
        ]),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].overview, "第一段\n第二段\n第三段");

    const cacheEntry = parseUnifiedCache(persistentData).trakt.translation["movie:123"];
    assert.deepEqual(cacheEntry.translation, {
        title: "中文标题",
        overview: "第一段\n第二段\n第三段",
        tagline: "中文标语",
    });
});

[
    {
        name: "空响应体",
        mock: createHttpStatusMock(200, ""),
    },
    {
        name: "空白响应体",
        mock: createHttpStatusMock(200, "   "),
    },
    {
        name: "空数组响应",
        mock: "[]",
    },
    {
        name: "无有效翻译字段响应",
        mock: JSON.stringify([
            {
                language: "zh",
                country: "cn",
            },
        ]),
    },
].forEach(({ name, mock }) => {
    test(`媒体列表直查翻译在 ${name} 时会缓存 NOT_FOUND 并回传 backend`, async () => {
        const { result, persistentData, backendPostQueue } = await runDirectTranslationLookupCase(mock);

        const payload = JSON.parse(result.body);
        assert.equal(payload[0].movie.title, "Original Title");

        const cacheEntry = parseUnifiedCache(persistentData).trakt.translation["movie:123"];
        assert.equal(cacheEntry.translation, undefined);
        assert.equal(cacheEntry.status, 3);
        assert.equal(backendPostQueue.length, 0);
    });
});

test("episode 数字占位标题无中文简介时会生成标题但保持 NOT_FOUND", async () => {
    const { result, persistentData, backendPostQueue } = await runEpisodeTranslationLookupCase(
        JSON.stringify([
            {
                language: "zh",
                country: "cn",
            },
        ]),
    );

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].episode.title, "第12集");

    const cacheEntry = parseUnifiedCache(persistentData).trakt.translation["episode:555:1:12"];
    assert.equal(cacheEntry.status, 3);
    assert.equal(cacheEntry.translation, undefined);
    assert.equal(backendPostQueue.length, 0);
});

test("episode 数字占位标题有中文简介时会生成标题并标记 PARTIAL_FOUND", async () => {
    const { result, persistentData } = await runEpisodeTranslationLookupCase(
        JSON.stringify([
            {
                language: "zh",
                country: "cn",
                overview: "中文简介",
            },
        ]),
        "Episode 2",
    );

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].episode.title, "第2集");
    assert.equal(payload[0].episode.overview, "中文简介");

    const cacheEntry = parseUnifiedCache(persistentData).trakt.translation["episode:555:1:12"];
    assert.equal(cacheEntry.status, 2);
    assert.equal(cacheEntry.translation.title, undefined);
    assert.equal(cacheEntry.translation.overview, "中文简介");
});

test("episode 数字占位标题会按标题数字生成并去掉前导零", async () => {
    const { result } = await runEpisodeTranslationLookupCase(
        JSON.stringify([
            {
                language: "zh",
                country: "cn",
            },
        ]),
        "Episode 02",
    );

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].episode.title, "第2集");
});

test("episode 已有真实中文标题时不会用数字占位标题覆盖", async () => {
    const { result, persistentData } = await runEpisodeTranslationLookupCase(
        JSON.stringify([
            {
                language: "zh",
                country: "cn",
                title: "真正中文标题",
                overview: "中文简介",
            },
        ]),
        "Episode 2",
    );

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].episode.title, "真正中文标题");

    const cacheEntry = parseUnifiedCache(persistentData).trakt.translation["episode:555:1:12"];
    assert.equal(cacheEntry.status, 1);
    assert.equal(cacheEntry.translation.title, "真正中文标题");
});

test("episode 非数字占位标题不会生成中文集数标题", async () => {
    const { result, persistentData } = await runEpisodeTranslationLookupCase(
        JSON.stringify([
            {
                language: "zh",
                country: "cn",
            },
        ]),
        "Episode xx",
    );

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].episode.title, "Episode xx");

    const cacheEntry = parseUnifiedCache(persistentData).trakt.translation["episode:555:1:12"];
    assert.equal(cacheEntry.status, 3);
    assert.equal(cacheEntry.translation, undefined);
});

test("movie 的 Episode 数字标题不会生成中文集数标题", async () => {
    const { result, persistentData } = await runDirectTranslationLookupCase(
        JSON.stringify([
            {
                language: "zh",
                country: "cn",
                title: "Episode 1",
            },
        ]),
    );

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].movie.title, "Episode 1");

    const cacheEntry = parseUnifiedCache(persistentData).trakt.translation["movie:123"];
    assert.equal(cacheEntry.status, 1);
    assert.equal(cacheEntry.translation.title, "Episode 1");
});

[
    {
        name: "HTTP 非 200",
        mock: createHttpStatusMock(500),
    },
    {
        name: "网络异常",
        mock: createHttpErrorMock("trakt unavailable"),
    },
    {
        name: "非法 JSON 非空响应",
        mock: createInvalidJsonResponse(),
    },
].forEach(({ name, mock }) => {
    test(`媒体列表直查翻译在 ${name} 时不会回传 backend`, async () => {
        const { result, persistentData, backendPostQueue } = await runDirectTranslationLookupCase(mock);

        const payload = JSON.parse(result.body);
        assert.equal(payload[0].movie.title, "Original Title");
        assert.deepEqual(parseUnifiedCache(persistentData).trakt.translation, {});
        assert.equal(backendPostQueue.length, 1);
    });
});

test("/movies/:id 会把缓存中的中文翻译应用到详情响应", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body: readFixture("movie-detail.json"),
        headers: {
            "user-agent": "Rippple/1.0",
        },
        persistentData: createUnifiedPersistentData({
            traktTranslation: JSON.parse(
                createMediaTranslationCache({
                    "movie:123": createMediaTranslationEntry({
                        translation: {
                            title: "中文标题",
                            overview: "中文简介",
                            tagline: "中文标语",
                        },
                    }),
                }),
            ),
        }),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.title, "中文标题");
    assert.equal(payload.original_title, "中文标题");
    assert.equal(payload.overview, "中文简介");
    assert.equal(payload.tagline, "中文标语");
});

test("/movies/:id 会用 TMDb 中文 w780 海报替换 images.poster[0]", async () => {
    const { result, persistentData, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body: JSON.stringify(createMovieWithPoster()),
        argument: {
            posterImageMode: "chinese",
        },
        persistentData: createUnifiedPersistentData(),
        httpGetMocks: {
            [TEST_TMDB_MOVIE_IMAGES_URL]: createTmdbImagesResponse([
                {
                    iso_639_1: "zh-tw",
                    iso_3166_1: "TW",
                    file_path: "/tw-poster.jpg",
                    vote_average: 10,
                    vote_count: 100,
                },
                {
                    iso_639_1: "zh",
                    iso_3166_1: "CN",
                    file_path: "/low-cn-poster.jpg",
                    vote_average: 1,
                    vote_count: 1,
                },
                {
                    iso_639_1: "zh",
                    iso_3166_1: "CN",
                    file_path: "/best-cn-poster.jpg",
                    vote_average: 8,
                    vote_count: 20,
                },
            ]),
        },
    });

    const payload = JSON.parse(result.body);
    const cachePoster = parseUnifiedCache(persistentData).trakt.image["movie:123"].poster;
    assert.equal(payload.images.poster[0], "https://image.tmdb.org/t/p/w780/best-cn-poster.jpg");
    assert.equal(cachePoster.status, 1);
    assert.equal(cachePoster.url, "https://image.tmdb.org/t/p/original/best-cn-poster.jpg");
    assert.equal(cachePoster.expiresAt, null);
    assert.ok(httpLogs.some((entry) => entry.method === "GET" && entry.url === TEST_TMDB_MOVIE_IMAGES_URL));
});

for (const userAgent of ["Rippple/1.0", "Infuse/8.0"]) {
    test(`${userAgent} 即使开启 posterImageMode 也不替换海报`, async () => {
        const original = createMovieWithPoster();
        const { result, persistentData, httpLogs } = await runResponseCase({
            url: "https://api.trakt.tv/movies/123",
            headers: {
                "user-agent": userAgent,
            },
            body: JSON.stringify(original),
            argument: {
                posterImageMode: "chinese",
            },
            persistentData: createUnifiedPersistentData(),
            httpGetMocks: {
                [TEST_TMDB_MOVIE_IMAGES_URL]: createTmdbImagesResponse([
                    {
                        iso_639_1: "zh",
                        iso_3166_1: "CN",
                        file_path: "/non-trakt-should-not-use.jpg",
                        vote_average: 9,
                        vote_count: 10,
                    },
                ]),
            },
        });

        const payload = JSON.parse(result.body);
        assert.equal(payload.images.poster[0], original.images.poster[0]);
        assert.deepEqual(parseUnifiedCache(persistentData).trakt.image, {});
        assert.ok(!httpLogs.some((entry) => entry.method === "GET" && entry.url === TEST_TMDB_MOVIE_IMAGES_URL));
    });
}

test("后端批量翻译即使保存时被本地缓存限额裁剪，当前响应仍会应用", async () => {
    const body = JSON.stringify([
        {
            movie: {
                title: "Movie 101",
                overview: "Overview 101",
                ids: {
                    trakt: 101,
                },
                available_translations: ["zh"],
            },
        },
        {
            movie: {
                title: "Movie 102",
                overview: "Overview 102",
                ids: {
                    trakt: 102,
                },
                available_translations: ["zh"],
            },
        },
        {
            movie: {
                title: "Movie 103",
                overview: "Overview 103",
                ids: {
                    trakt: 103,
                },
                available_translations: ["zh"],
            },
        },
        {
            movie: {
                title: "Movie 104",
                overview: "Overview 104",
                ids: {
                    trakt: 104,
                },
                available_translations: ["zh"],
            },
        },
    ]);

    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/users/demo/watchlist/movies",
        body,
        argument: {
            backendBaseUrl: TEST_BACKEND_BASE_URL,
        },
        persistentData: createUnifiedPersistentData({
            maxBytes: 1,
        }),
        httpGetMocks: {
            [`${TEST_BACKEND_TRANSLATIONS_URL}?movies=101,102,103,104`]: JSON.stringify({
                movies: {
                    101: {
                        status: 1,
                        translation: {
                            title: "后端中文标题",
                            overview: "后端中文简介",
                        },
                    },
                },
            }),
        },
    });

    const payload = JSON.parse(result.body);
    const storedTranslationCache = parseUnifiedCache(persistentData).trakt.translation;
    assert.equal(payload.find((item) => item?.movie?.ids?.trakt === 101)?.movie?.title, "后端中文标题");
    assert.equal(payload.find((item) => item?.movie?.ids?.trakt === 101)?.movie?.overview, "后端中文简介");
    assert.equal(storedTranslationCache["movie:101"], undefined);
});

test("posterImageMode=default 时 movie/show 不请求也不替换中文图片", async () => {
    const original = createMovieWithPoster();
    const { result, persistentData, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body: JSON.stringify(original),
        argument: {
            backendBaseUrl: TEST_BACKEND_BASE_URL,
            posterImageMode: "default",
        },
        persistentData: createUnifiedPersistentData(),
        httpGetMocks: {
            [`${TEST_BACKEND_IMAGES_URL}?mode=chinese&movies=123`]: JSON.stringify({
                movies: {
                    123: {
                        poster: {
                            status: 1,
                            url: "https://image.tmdb.org/t/p/original/backend-poster.jpg",
                        },
                        logo: {
                            status: 1,
                            url: "https://image.tmdb.org/t/p/original/backend-logo.png",
                        },
                    },
                },
            }),
            [TEST_TMDB_MOVIE_IMAGES_URL]: createTmdbImagesResponse([
                {
                    iso_639_1: "zh",
                    iso_3166_1: "CN",
                    file_path: "/movie-poster.jpg",
                    vote_average: 6,
                    vote_count: 2,
                },
            ]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.images.poster[0], original.images.poster[0]);
    assert.equal(payload.images.logo[0], original.images.logo[0]);
    assert.deepEqual(parseUnifiedCache(persistentData).trakt.image, {});
    assert.equal(
        httpLogs.some((entry) => entry.url.startsWith(TEST_BACKEND_IMAGES_URL) || entry.url.startsWith("https://api.tmdb.org/3/")),
        false,
    );
});

test("TMDb 图片选择会优先 iso_3166_1 中文地区再比较评分", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/shows/555",
        body: JSON.stringify(createShowWithPoster()),
        argument: {
            posterImageMode: "chinese",
        },
        persistentData: createUnifiedPersistentData(),
        httpGetMocks: {
            [TEST_TMDB_SHOW_IMAGES_URL]: createTmdbImagesResponse([
                {
                    iso_639_1: "zh",
                    iso_3166_1: "HK",
                    file_path: "/hk-high-score-poster.jpg",
                    vote_average: 9,
                    vote_count: 100,
                },
                {
                    iso_639_1: "zh",
                    iso_3166_1: "CN",
                    file_path: "/cn-lower-score-poster.jpg",
                    vote_average: 5,
                    vote_count: 1,
                },
            ]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.images.poster[0], "https://image.tmdb.org/t/p/w780/cn-lower-score-poster.jpg");
});

test("posterImageMode=original 时按响应 language/country 请求并优先地区海报", async () => {
    const movie = createMovieWithPoster({
        language: "ja",
        country: "JP",
    });
    const { result, persistentData, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body: JSON.stringify(movie),
        argument: {
            posterImageMode: "original",
        },
        persistentData: createUnifiedPersistentData(),
        httpGetMocks: {
            [TEST_TMDB_MOVIE_IMAGES_JA_URL]: createTmdbImagesResponse([
                {
                    iso_639_1: "ja",
                    iso_3166_1: "US",
                    file_path: "/ja-us-poster.jpg",
                    vote_average: 10,
                    vote_count: 100,
                },
                {
                    iso_639_1: "ja",
                    iso_3166_1: "JP",
                    file_path: "/ja-jp-poster.jpg",
                    vote_average: 1,
                    vote_count: 1,
                },
            ]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.images.poster[0], "https://image.tmdb.org/t/p/w780/ja-jp-poster.jpg");
    assert.equal(parseUnifiedCache(persistentData).trakt.image["original:movies:123"].poster.url, "https://image.tmdb.org/t/p/original/ja-jp-poster.jpg");
    assert.ok(httpLogs.some((entry) => entry.method === "GET" && entry.url === TEST_TMDB_MOVIE_IMAGES_JA_URL));
});

test("posterImageMode=original 且 language=en 时不替换图片", async () => {
    const movie = createMovieWithPoster({
        language: "en",
        country: "US",
    });
    const { result, persistentData, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body: JSON.stringify(movie),
        argument: {
            posterImageMode: "original",
        },
        persistentData: createUnifiedPersistentData(),
        httpGetMocks: {
            [TEST_TMDB_MOVIE_IMAGES_URL]: createTmdbImagesResponse([
                {
                    iso_639_1: "en",
                    iso_3166_1: "US",
                    file_path: "/en-us-poster.jpg",
                    vote_average: 10,
                    vote_count: 100,
                },
            ]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.images.poster[0], movie.images.poster[0]);
    assert.equal(parseUnifiedCache(persistentData).trakt.image["original:movies:123"], undefined);
    assert.equal(
        httpLogs.some((entry) => entry.method === "GET" && entry.url.startsWith("https://api.tmdb.org/3/")),
        false,
    );
});

test("posterImageMode=original 且 language=en 时不使用本地 original 图片缓存", async () => {
    const movie = createMovieWithPoster({
        language: "en",
        country: "US",
    });
    const { result, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body: JSON.stringify(movie),
        argument: {
            posterImageMode: "original",
        },
        persistentData: createUnifiedPersistentData({
            traktImage: {
                "original:movies:123": {
                    poster: {
                        status: 1,
                        url: "https://image.tmdb.org/t/p/original/cached-original-poster.jpg",
                    },
                    logo: {
                        status: 1,
                        url: "https://image.tmdb.org/t/p/original/cached-original-logo.png",
                    },
                },
            },
        }),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.images.poster[0], movie.images.poster[0]);
    assert.equal(payload.images.logo[0], movie.images.logo[0]);
    assert.equal(
        httpLogs.some((entry) => entry.method === "GET" && entry.url.startsWith("https://api.tmdb.org/3/")),
        false,
    );
});

test("posterImageMode=original 且中文原片无对应 country 时按中文地区优先级选图", async () => {
    const movie = createMovieWithPoster({
        language: "zh",
        country: "MO",
    });
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body: JSON.stringify(movie),
        argument: {
            posterImageMode: "original",
        },
        persistentData: createUnifiedPersistentData(),
        httpGetMocks: {
            [TEST_TMDB_MOVIE_IMAGES_ZH_URL]: createTmdbImagesResponse([
                {
                    iso_639_1: "zh",
                    iso_3166_1: "HK",
                    file_path: "/hk-high-score-original-poster.jpg",
                    vote_average: 10,
                    vote_count: 100,
                },
                {
                    iso_639_1: "zh",
                    iso_3166_1: "CN",
                    file_path: "/cn-priority-original-poster.jpg",
                    vote_average: 1,
                    vote_count: 1,
                },
            ]),
        },
    });

    const payload = JSON.parse(result.body);
    const cachePoster = parseUnifiedCache(persistentData).trakt.image["original:movies:123"].poster;
    assert.equal(payload.images.poster[0], "https://image.tmdb.org/t/p/w780/cn-priority-original-poster.jpg");
    assert.equal(cachePoster.status, 2);
    assert.ok(cachePoster.expiresAt > Date.now() + 29 * 24 * 60 * 60 * 1000);
});

test("posterImageMode=original 缺少响应 language 时用 TMDb 详情 original_language", async () => {
    const { result, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body: JSON.stringify(createMovieWithPoster({ language: null })),
        argument: {
            posterImageMode: "original",
        },
        persistentData: createUnifiedPersistentData(),
        httpGetMocks: {
            [TEST_TMDB_MOVIE_DETAIL_URL]: JSON.stringify({
                original_language: "ja",
            }),
            [TEST_TMDB_MOVIE_IMAGES_JA_URL]: createTmdbImagesResponse([
                {
                    iso_639_1: "ja",
                    file_path: "/ja-detail-poster.jpg",
                    vote_average: 6,
                    vote_count: 2,
                },
            ]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.images.poster[0], "https://image.tmdb.org/t/p/w780/ja-detail-poster.jpg");
    assert.ok(httpLogs.some((entry) => entry.method === "GET" && entry.url === TEST_TMDB_MOVIE_DETAIL_URL));
    assert.ok(httpLogs.some((entry) => entry.method === "GET" && entry.url === TEST_TMDB_MOVIE_IMAGES_JA_URL));
});

test("posterImageMode=original 缺少响应 country 时用 TMDb 详情 origin_country", async () => {
    const { result, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body: JSON.stringify(createMovieWithPoster({ language: "ja", country: null })),
        argument: {
            posterImageMode: "original",
        },
        persistentData: createUnifiedPersistentData(),
        httpGetMocks: {
            [TEST_TMDB_MOVIE_DETAIL_URL]: JSON.stringify({
                original_language: "ja",
                origin_country: ["JP"],
            }),
            [TEST_TMDB_MOVIE_IMAGES_JA_URL]: createTmdbImagesResponse([
                {
                    iso_639_1: "ja",
                    iso_3166_1: "US",
                    file_path: "/ja-us-detail-country-poster.jpg",
                    vote_average: 10,
                    vote_count: 100,
                },
                {
                    iso_639_1: "ja",
                    iso_3166_1: "JP",
                    file_path: "/ja-jp-detail-country-poster.jpg",
                    vote_average: 1,
                    vote_count: 1,
                },
            ]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.images.poster[0], "https://image.tmdb.org/t/p/w780/ja-jp-detail-country-poster.jpg");
    assert.ok(httpLogs.some((entry) => entry.method === "GET" && entry.url === TEST_TMDB_MOVIE_DETAIL_URL));
});

test("posterImageMode=original 补查 TMDb country 失败时仍保持详情响应", async () => {
    const { result, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body: JSON.stringify(createMovieWithPoster({ language: "ja", country: null })),
        argument: {
            posterImageMode: "original",
        },
        persistentData: createUnifiedPersistentData(),
        httpGetMocks: {
            [TEST_TMDB_MOVIE_DETAIL_URL]: createHttpStatusMock(500),
            [TEST_TMDB_MOVIE_IMAGES_JA_URL]: createTmdbImagesResponse([
                {
                    iso_639_1: "ja",
                    iso_3166_1: "US",
                    file_path: "/ja-us-detail-failed-poster.jpg",
                    vote_average: 10,
                    vote_count: 100,
                },
            ]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.images.poster[0], "https://image.tmdb.org/t/p/w780/ja-us-detail-failed-poster.jpg");
    assert.ok(httpLogs.some((entry) => entry.method === "GET" && entry.url === TEST_TMDB_MOVIE_DETAIL_URL));
    assert.ok(httpLogs.some((entry) => entry.method === "GET" && entry.url === TEST_TMDB_MOVIE_IMAGES_JA_URL));
});

test("/movies/:id 会用 TMDb 中文 logo 替换 images.logo[0] 并写回后端图片缓存", async () => {
    const backendImagePostQueue = [createHttpStatusMock(200, "{}")];
    const { result, persistentData, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body: JSON.stringify(
            createMovieWithPoster({
                language: "ja",
                country: "JP",
            }),
        ),
        argument: {
            backendBaseUrl: TEST_BACKEND_BASE_URL,
            posterImageMode: "chinese",
        },
        persistentData: createUnifiedPersistentData(),
        httpGetMocks: {
            [`${TEST_BACKEND_IMAGES_URL}?mode=chinese&movies=123`]: "{}",
            [TEST_TMDB_MOVIE_IMAGES_JA_URL]: createTmdbImagesResponse(
                [
                    {
                        iso_639_1: "ja",
                        iso_3166_1: "JP",
                        file_path: "/ja-original-poster.jpg",
                        vote_average: 9,
                        vote_count: 10,
                    },
                    {
                        iso_639_1: "zh",
                        file_path: "/movie-poster.jpg",
                        vote_average: 6,
                        vote_count: 2,
                    },
                ],
                [
                    {
                        iso_639_1: "ja",
                        iso_3166_1: "JP",
                        file_path: "/ja-original-logo.png",
                        vote_average: 9,
                        vote_count: 10,
                    },
                    {
                        iso_639_1: "zh",
                        iso_3166_1: "HK",
                        file_path: "/hk-logo.png",
                        vote_average: 10,
                        vote_count: 100,
                    },
                    {
                        iso_639_1: "zh",
                        iso_3166_1: "CN",
                        file_path: "/cn-logo.png",
                        vote_average: 1,
                        vote_count: 1,
                    },
                ],
            ),
        },
        httpPostMocks: {
            [TEST_BACKEND_IMAGES_URL]: backendImagePostQueue,
        },
    });

    const payload = JSON.parse(result.body);
    const imageCache = parseUnifiedCache(persistentData).trakt.image;
    const cache = imageCache["movie:123"];
    const imagePost = httpLogs.find((entry) => entry.method === "POST" && entry.url === TEST_BACKEND_IMAGES_URL);
    const imagePostBody = JSON.parse(imagePost.body);
    assert.equal(payload.images.poster[0], "https://image.tmdb.org/t/p/w780/movie-poster.jpg");
    assert.equal(payload.images.logo[0], "https://image.tmdb.org/t/p/w500/cn-logo.png");
    assert.equal(cache.poster.url, "https://image.tmdb.org/t/p/original/movie-poster.jpg");
    assert.equal(cache.logo.url, "https://image.tmdb.org/t/p/original/cn-logo.png");
    assert.equal(imageCache["original:movies:123"], undefined);
    assert.equal(imagePostBody.modes.chinese.movies["123"].poster.url, "https://image.tmdb.org/t/p/original/movie-poster.jpg");
    assert.equal(imagePostBody.modes.original.movies["123"].poster.url, "https://image.tmdb.org/t/p/original/ja-original-poster.jpg");
});

test("后端原片语言图片写入不受本地 original 缓存影响", async () => {
    const { persistentData, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body: JSON.stringify(
            createMovieWithPoster({
                language: "ja",
                country: "JP",
            }),
        ),
        argument: {
            backendBaseUrl: TEST_BACKEND_BASE_URL,
            posterImageMode: "chinese",
        },
        persistentData: createUnifiedPersistentData({
            traktImage: {
                "original:movies:123": {
                    poster: {
                        status: 1,
                        url: "https://image.tmdb.org/t/p/original/stale-original-poster.jpg",
                    },
                    logo: {
                        status: 1,
                        url: "https://image.tmdb.org/t/p/original/stale-original-logo.png",
                    },
                },
            },
        }),
        httpGetMocks: {
            [`${TEST_BACKEND_IMAGES_URL}?mode=chinese&movies=123`]: "{}",
            [TEST_TMDB_MOVIE_IMAGES_JA_URL]: createTmdbImagesResponse(
                [
                    {
                        iso_639_1: "zh",
                        iso_3166_1: "CN",
                        file_path: "/fresh-chinese-poster.jpg",
                        vote_average: 7,
                        vote_count: 3,
                    },
                    {
                        iso_639_1: "ja",
                        iso_3166_1: "JP",
                        file_path: "/fresh-original-poster.jpg",
                        vote_average: 7,
                        vote_count: 3,
                    },
                ],
                [
                    {
                        iso_639_1: "zh",
                        iso_3166_1: "CN",
                        file_path: "/fresh-chinese-logo.png",
                        vote_average: 7,
                        vote_count: 3,
                    },
                    {
                        iso_639_1: "ja",
                        iso_3166_1: "JP",
                        file_path: "/fresh-original-logo.png",
                        vote_average: 7,
                        vote_count: 3,
                    },
                ],
            ),
        },
    });

    const imagePost = httpLogs.find((entry) => entry.method === "POST" && entry.url === TEST_BACKEND_IMAGES_URL);
    const imagePostBody = JSON.parse(imagePost.body);
    const imageCache = parseUnifiedCache(persistentData).trakt.image;
    assert.equal(imagePostBody.modes.original.movies["123"].poster.url, "https://image.tmdb.org/t/p/original/fresh-original-poster.jpg");
    assert.equal(imageCache["original:movies:123"].poster.url, "https://image.tmdb.org/t/p/original/stale-original-poster.jpg");
});

test("posterImageMode=chinese 时原片语言详情失败不影响中文海报", async () => {
    const movie = createMovieWithPoster({
        language: null,
    });
    const { result, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body: JSON.stringify(movie),
        argument: {
            posterImageMode: "chinese",
        },
        persistentData: createUnifiedPersistentData(),
        httpGetMocks: {
            [TEST_TMDB_MOVIE_DETAIL_URL]: createHttpStatusMock(500),
            [TEST_TMDB_MOVIE_IMAGES_ZH_URL]: createTmdbImagesResponse([
                {
                    iso_639_1: "zh",
                    iso_3166_1: "CN",
                    file_path: "/safe-chinese-poster.jpg",
                    vote_average: 6,
                    vote_count: 2,
                },
            ]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.images.poster[0], "https://image.tmdb.org/t/p/w780/safe-chinese-poster.jpg");
    assert.ok(httpLogs.some((entry) => entry.method === "GET" && entry.url === TEST_TMDB_MOVIE_DETAIL_URL));
    assert.ok(httpLogs.some((entry) => entry.method === "GET" && entry.url === TEST_TMDB_MOVIE_IMAGES_ZH_URL));
});

test("movie/show 向 TMDb 请求图片时会同时缓存 poster 和 logo", async () => {
    const movie = createMovieWithPoster({
        images: {
            poster: ["https://walter.trakt.tv/images/movies/000/000/123/posters/original.jpg"],
        },
    });
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body: JSON.stringify(movie),
        argument: {
            backendBaseUrl: TEST_BACKEND_BASE_URL,
            posterImageMode: "chinese",
        },
        persistentData: createUnifiedPersistentData(),
        httpGetMocks: {
            [`${TEST_BACKEND_IMAGES_URL}?mode=chinese&movies=123`]: "{}",
            [TEST_TMDB_MOVIE_IMAGES_URL]: createTmdbImagesResponse(
                [
                    {
                        iso_639_1: "zh",
                        iso_3166_1: "CN",
                        file_path: "/movie-poster.jpg",
                        vote_average: 6,
                        vote_count: 2,
                    },
                ],
                [
                    {
                        iso_639_1: "zh",
                        iso_3166_1: "CN",
                        file_path: "/movie-logo.png",
                        vote_average: 6,
                        vote_count: 2,
                    },
                ],
            ),
        },
    });

    const payload = JSON.parse(result.body);
    const cache = parseUnifiedCache(persistentData).trakt.image["movie:123"];
    assert.equal(payload.images.poster[0], "https://image.tmdb.org/t/p/w780/movie-poster.jpg");
    assert.equal(payload.images.logo, undefined);
    assert.equal(cache.poster.url, "https://image.tmdb.org/t/p/original/movie-poster.jpg");
    assert.equal(cache.logo.url, "https://image.tmdb.org/t/p/original/movie-logo.png");
});

test("/movies/:id 命中后端图片缓存时替换 poster/logo 且不请求 TMDb", async () => {
    const { result, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body: JSON.stringify(createMovieWithPoster()),
        argument: {
            backendBaseUrl: TEST_BACKEND_BASE_URL,
            posterImageMode: "chinese",
        },
        persistentData: createUnifiedPersistentData(),
        httpGetMocks: {
            [`${TEST_BACKEND_IMAGES_URL}?mode=chinese&movies=123`]: JSON.stringify({
                movies: {
                    123: {
                        poster: {
                            status: 1,
                            url: "https://image.tmdb.org/t/p/original/backend-poster.jpg",
                        },
                        logo: {
                            status: 1,
                            url: "https://image.tmdb.org/t/p/original/backend-logo.png",
                        },
                    },
                },
            }),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.images.poster[0], "https://image.tmdb.org/t/p/w780/backend-poster.jpg");
    assert.equal(payload.images.logo[0], "https://image.tmdb.org/t/p/w500/backend-logo.png");
    assert.equal(
        httpLogs.some((entry) => entry.url.startsWith("https://api.tmdb.org/3/")),
        false,
    );
});

test("后端图片缓存命中 NOT_FOUND 时不再请求 TMDb", async () => {
    const original = createMovieWithPoster();
    const { result, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body: JSON.stringify(original),
        argument: {
            backendBaseUrl: TEST_BACKEND_BASE_URL,
        },
        persistentData: createUnifiedPersistentData(),
        httpGetMocks: {
            [`${TEST_BACKEND_IMAGES_URL}?mode=chinese&movies=123`]: JSON.stringify({
                movies: {
                    123: {
                        poster: { status: 3 },
                        logo: { status: 3 },
                    },
                },
            }),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.images.poster[0], original.images.poster[0]);
    assert.equal(payload.images.logo[0], original.images.logo[0]);
    assert.equal(
        httpLogs.some((entry) => entry.url.startsWith("https://api.tmdb.org/3/")),
        false,
    );
});

test("本地图片缓存 PARTIAL_FOUND 未过期时直接替换且不请求 TMDb", async () => {
    const { result, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body: JSON.stringify(createMovieWithPoster()),
        argument: {
            posterImageMode: "chinese",
        },
        persistentData: createUnifiedPersistentData({
            traktImage: {
                "movie:123": {
                    poster: {
                        status: 2,
                        url: "https://image.tmdb.org/t/p/original/partial-poster.jpg",
                        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
                    },
                    logo: {
                        status: 2,
                        url: "https://image.tmdb.org/t/p/original/partial-logo.png",
                        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
                    },
                },
            },
        }),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.images.poster[0], "https://image.tmdb.org/t/p/w780/partial-poster.jpg");
    assert.equal(payload.images.logo[0], "https://image.tmdb.org/t/p/w500/partial-logo.png");
    assert.equal(
        httpLogs.some((entry) => entry.url.startsWith("https://api.tmdb.org/3/")),
        false,
    );
});

test("TMDb 获取后本地当前模式缓存会写入新获取的完整图片数据", async () => {
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body: JSON.stringify(createMovieWithPoster()),
        argument: {
            posterImageMode: "chinese",
        },
        persistentData: createUnifiedPersistentData({
            traktImage: {
                "movie:123": {
                    poster: {
                        status: 1,
                        url: "https://image.tmdb.org/t/p/original/old-poster.jpg",
                    },
                },
            },
        }),
        httpGetMocks: {
            [TEST_TMDB_MOVIE_IMAGES_URL]: createTmdbImagesResponse(
                [
                    {
                        iso_639_1: "zh",
                        iso_3166_1: "CN",
                        file_path: "/new-poster.jpg",
                        vote_average: 7,
                        vote_count: 3,
                    },
                ],
                [
                    {
                        iso_639_1: "zh",
                        iso_3166_1: "CN",
                        file_path: "/new-logo.png",
                        vote_average: 7,
                        vote_count: 3,
                    },
                ],
            ),
        },
    });

    const payload = JSON.parse(result.body);
    const cache = parseUnifiedCache(persistentData).trakt.image["movie:123"];
    assert.equal(payload.images.poster[0], "https://image.tmdb.org/t/p/w780/new-poster.jpg");
    assert.equal(payload.images.logo[0], "https://image.tmdb.org/t/p/w500/new-logo.png");
    assert.equal(cache.poster.url, "https://image.tmdb.org/t/p/original/new-poster.jpg");
    assert.equal(cache.logo.url, "https://image.tmdb.org/t/p/original/new-logo.png");
});

test("当前模式本地图片缓存命中时不请求另一种模式后端缓存", async () => {
    const { result, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body: JSON.stringify(createMovieWithPoster()),
        argument: {
            backendBaseUrl: TEST_BACKEND_BASE_URL,
            posterImageMode: "chinese",
        },
        persistentData: createUnifiedPersistentData({
            traktImage: {
                "movie:123": {
                    poster: {
                        status: 1,
                        url: "https://image.tmdb.org/t/p/original/cached-poster.jpg",
                    },
                    logo: {
                        status: 1,
                        url: "https://image.tmdb.org/t/p/original/cached-logo.png",
                    },
                },
            },
        }),
        httpGetMocks: {
            [`${TEST_BACKEND_IMAGES_URL}?mode=original&movies=123`]: JSON.stringify({
                movies: {
                    123: {
                        poster: {
                            status: 1,
                            url: "https://image.tmdb.org/t/p/original/original-poster.jpg",
                        },
                    },
                },
            }),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.images.poster[0], "https://image.tmdb.org/t/p/w780/cached-poster.jpg");
    assert.equal(payload.images.logo[0], "https://image.tmdb.org/t/p/w500/cached-logo.png");
    assert.equal(
        httpLogs.some((entry) => entry.url === `${TEST_BACKEND_IMAGES_URL}?mode=original&movies=123`),
        false,
    );
    assert.equal(
        httpLogs.some((entry) => entry.url.startsWith("https://api.tmdb.org/3/")),
        false,
    );
});

test("当前模式后端图片缓存未命中时不请求另一种模式后端缓存", async () => {
    const { result, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body: JSON.stringify(
            createMovieWithPoster({
                language: "ja",
                country: "JP",
            }),
        ),
        argument: {
            backendBaseUrl: TEST_BACKEND_BASE_URL,
            posterImageMode: "original",
        },
        persistentData: createUnifiedPersistentData(),
        httpGetMocks: {
            [`${TEST_BACKEND_IMAGES_URL}?mode=original&movies=123`]: "{}",
            [`${TEST_BACKEND_IMAGES_URL}?mode=chinese&movies=123`]: JSON.stringify({
                movies: {
                    123: {
                        poster: {
                            status: 1,
                            url: "https://image.tmdb.org/t/p/original/chinese-poster.jpg",
                        },
                        logo: {
                            status: 1,
                            url: "https://image.tmdb.org/t/p/original/chinese-logo.png",
                        },
                    },
                },
            }),
            [TEST_TMDB_MOVIE_IMAGES_JA_URL]: createTmdbImagesResponse(
                [
                    {
                        iso_639_1: "ja",
                        iso_3166_1: "JP",
                        file_path: "/ja-poster.jpg",
                        vote_average: 7,
                        vote_count: 3,
                    },
                ],
                [
                    {
                        iso_639_1: "ja",
                        iso_3166_1: "JP",
                        file_path: "/ja-logo.png",
                        vote_average: 7,
                        vote_count: 3,
                    },
                ],
            ),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.images.poster[0], "https://image.tmdb.org/t/p/w780/ja-poster.jpg");
    assert.equal(payload.images.logo[0], "https://image.tmdb.org/t/p/w500/ja-logo.png");
    assert.equal(
        httpLogs.some((entry) => entry.url === `${TEST_BACKEND_IMAGES_URL}?mode=chinese&movies=123`),
        false,
    );
});

test("本地图片缓存 PARTIAL_FOUND/NOT_FOUND 过期后会重新请求 TMDb", async () => {
    const { result, persistentData, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body: JSON.stringify(createMovieWithPoster()),
        argument: {
            posterImageMode: "chinese",
        },
        persistentData: createUnifiedPersistentData({
            traktImage: {
                "movie:123": {
                    poster: {
                        status: 2,
                        url: "https://image.tmdb.org/t/p/original/expired-poster.jpg",
                        expiresAt: Date.now() - 1000,
                    },
                    logo: {
                        status: 3,
                        expiresAt: Date.now() - 1000,
                    },
                },
            },
        }),
        httpGetMocks: {
            [TEST_TMDB_MOVIE_IMAGES_URL]: createTmdbImagesResponse(
                [
                    {
                        iso_639_1: "zh",
                        iso_3166_1: "CN",
                        file_path: "/fresh-poster.jpg",
                        vote_average: 6,
                        vote_count: 2,
                    },
                ],
                [
                    {
                        iso_639_1: "zh",
                        iso_3166_1: "CN",
                        file_path: "/fresh-logo.png",
                        vote_average: 6,
                        vote_count: 2,
                    },
                ],
            ),
        },
    });

    const payload = JSON.parse(result.body);
    const cache = parseUnifiedCache(persistentData).trakt.image["movie:123"];
    assert.equal(payload.images.poster[0], "https://image.tmdb.org/t/p/w780/fresh-poster.jpg");
    assert.equal(cache.poster.status, 1);
    assert.equal(cache.poster.expiresAt, null);
    assert.ok(httpLogs.some((entry) => entry.method === "GET" && entry.url === TEST_TMDB_MOVIE_IMAGES_URL));
});

test("/shows 直出列表会用 TMDb 中文海报替换剧集 images.poster[0]", async () => {
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/shows/popular",
        body: JSON.stringify([createShowWithPoster()]),
        argument: {
            posterImageMode: "chinese",
        },
        persistentData: createUnifiedPersistentData({
            traktTranslation: {
                "show:555": createMediaTranslationEntry({
                    translation: {
                        title: "中文剧集",
                    },
                }),
            },
        }),
        httpGetMocks: {
            [TEST_TMDB_SHOW_IMAGES_URL]: createTmdbImagesResponse([
                {
                    iso_639_1: "zh",
                    iso_3166_1: "HK",
                    file_path: "/hk-show-poster.jpg",
                    vote_average: 4,
                    vote_count: 2,
                },
                {
                    iso_639_1: "zh",
                    iso_3166_1: "SG",
                    file_path: "/sg-show-poster.jpg",
                    vote_average: 3,
                    vote_count: 1,
                },
            ]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].title, "中文剧集");
    assert.equal(payload[0].images.poster[0], "https://image.tmdb.org/t/p/w780/sg-show-poster.jpg");
    const cachePoster = parseUnifiedCache(persistentData).trakt.image["show:555"].poster;
    assert.equal(cachePoster.status, 2);
    assert.equal(cachePoster.url, "https://image.tmdb.org/t/p/original/sg-show-poster.jpg");
    assert.ok(cachePoster.expiresAt > Date.now() + 29 * 24 * 60 * 60 * 1000);
});

test("posterImageMode=original 且列表项 language=en 时不使用本地 original 图片缓存", async () => {
    const show = createShowWithPoster({
        language: "en",
        country: "US",
    });
    const { result, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/shows/popular",
        body: JSON.stringify([show]),
        argument: {
            posterImageMode: "original",
        },
        persistentData: createUnifiedPersistentData({
            traktImage: {
                "original:shows:555": {
                    poster: {
                        status: 1,
                        url: "https://image.tmdb.org/t/p/original/cached-original-show-poster.jpg",
                    },
                    logo: {
                        status: 1,
                        url: "https://image.tmdb.org/t/p/original/cached-original-show-logo.png",
                    },
                },
            },
        }),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].images.poster[0], show.images.poster[0]);
    assert.equal(payload[0].images.logo[0], show.images.logo[0]);
    assert.equal(
        httpLogs.some((entry) => entry.method === "GET" && entry.url.startsWith("https://api.tmdb.org/3/")),
        false,
    );
});

[
    {
        name: "没有中文海报",
        mock: createTmdbImagesResponse([
            {
                iso_639_1: "en",
                file_path: "/en-poster.jpg",
                vote_average: 10,
                vote_count: 10,
            },
        ]),
    },
    {
        name: "TMDb HTTP 非 200",
        mock: createHttpStatusMock(500),
    },
    {
        name: "TMDb 返回非法 JSON",
        mock: createInvalidJsonResponse(),
    },
].forEach(({ name, mock }) => {
    test(`/movies/:id 在 ${name} 时保持原 poster`, async () => {
        const originalPoster = createMovieWithPoster().images.poster[0];
        const { result } = await runResponseCase({
            url: "https://api.trakt.tv/movies/123",
            body: JSON.stringify(createMovieWithPoster()),
            argument: {
                posterImageMode: "chinese",
            },
            persistentData: createUnifiedPersistentData(),
            httpGetMocks: {
                [TEST_TMDB_MOVIE_IMAGES_URL]: mock,
            },
        });

        const payload = JSON.parse(result.body);
        assert.equal(payload.images.poster[0], originalPoster);
    });
});

test("缺少 images.poster 时仍会请求 TMDb 写入图片缓存，缺少 ids.tmdb 时跳过", async () => {
    const { result, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/movies/popular",
        body: JSON.stringify([
            createMovieWithPoster({
                images: undefined,
            }),
            createMovieWithPoster({
                ids: {
                    trakt: 124,
                },
            }),
        ]),
        argument: {
            backendBaseUrl: TEST_BACKEND_BASE_URL,
            posterImageMode: "chinese",
        },
        persistentData: createUnifiedPersistentData({
            traktTranslation: {
                "movie:123": createMediaTranslationEntry(),
                "movie:124": createMediaTranslationEntry(),
            },
        }),
        httpGetMocks: {
            [TEST_TMDB_MOVIE_IMAGES_URL]: createTmdbImagesResponse([
                {
                    iso_639_1: "zh",
                    iso_3166_1: "CN",
                    file_path: "/shape-less-poster.jpg",
                    vote_average: 6,
                    vote_count: 2,
                },
            ]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].images, undefined);
    assert.equal(payload[1].images.poster[0], "https://walter.trakt.tv/images/movies/000/000/123/posters/original.jpg");
    assert.equal(httpLogs.filter((entry) => entry.url === TEST_TMDB_MOVIE_IMAGES_URL).length, 1);
});

test("TMDb poster 缓存命中时不会重复请求", async () => {
    const { result, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body: JSON.stringify(createMovieWithPoster()),
        argument: {
            posterImageMode: "chinese",
        },
        persistentData: createUnifiedPersistentData({
            traktImage: {
                "movie:123": {
                    poster: {
                        status: 1,
                        url: "https://image.tmdb.org/t/p/original/cached-poster.jpg",
                    },
                    logo: {
                        status: 3,
                        expiresAt: Date.now() + 5 * 24 * 60 * 60 * 1000,
                    },
                },
            },
        }),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.images.poster[0], "https://image.tmdb.org/t/p/w780/cached-poster.jpg");
    assert.equal(
        httpLogs.some((entry) => entry.url.startsWith("https://api.tmdb.org/3/")),
        false,
    );
});

test("episode 对象不会替换 images.poster[0]", async () => {
    const originalPoster = "https://walter.trakt.tv/images/episodes/000/001/posters/original.jpg";
    const { result, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/shows/555/seasons/1/episodes/12",
        body: JSON.stringify({
            title: "Episode 12",
            overview: "Original Episode Overview",
            ids: {
                trakt: 9001,
                tmdb: 8888,
            },
            images: {
                poster: [originalPoster],
            },
        }),
        persistentData: createUnifiedPersistentData(),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.title, "第12集");
    assert.equal(payload.images.poster[0], originalPoster);
    assert.equal(
        httpLogs.some((entry) => entry.url.startsWith("https://api.tmdb.org/3/")),
        false,
    );
});

test("/shows/:id/seasons 会用 TMDb 中文季海报替换 season images.poster[0]", async () => {
    const seasonPoster = "https://walter.trakt.tv/images/seasons/000/001/posters/original.jpg";
    const { result, persistentData, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/shows/555/seasons",
        body: JSON.stringify([
            {
                number: 1,
                first_aired: "2024-01-01T00:00:00.000Z",
                images: {
                    poster: [seasonPoster],
                },
                episodes: [
                    {
                        season: 1,
                        number: 1,
                        title: "Episode One",
                        overview: "Episode One Overview",
                        first_aired: "2024-01-01T00:00:00.000Z",
                        available_translations: ["en", "zh"],
                        ids: {
                            trakt: 1001,
                            tmdb: 5001,
                        },
                    },
                ],
            },
        ]),
        argument: {
            backendBaseUrl: TEST_BACKEND_BASE_URL,
            posterImageMode: "chinese",
        },
        persistentData: createUnifiedPersistentData({
            persistentCurrentSeason: { showId: "555", seasonNumber: 1 },
            traktLinkIds: {
                555: {
                    ids: {
                        trakt: 555,
                    },
                },
            },
            traktTranslation: {
                "episode:555:1:1": createMediaTranslationEntry({
                    translation: {
                        title: "第一集中文",
                    },
                }),
            },
        }),
        httpGetMocks: {
            [`${TEST_BACKEND_IMAGES_URL}?mode=chinese&seasons=555:1`]: "{}",
            [`${TEST_BACKEND_IMAGES_URL}?mode=original&seasons=555:1`]: "{}",
            "https://api.trakt.tv/shows/555?extended=cloud9,full,watchnow": JSON.stringify({
                ids: {
                    trakt: 555,
                    tmdb: 777,
                },
                language: "en",
                country: "US",
            }),
            [TEST_TMDB_SEASON_IMAGES_URL]: createTmdbImagesResponse([
                {
                    iso_639_1: "zh",
                    iso_3166_1: "HK",
                    file_path: "/hk-season-poster.jpg",
                    vote_average: 10,
                    vote_count: 100,
                },
                {
                    iso_639_1: "zh",
                    iso_3166_1: "CN",
                    file_path: "/best-season-poster.jpg",
                    vote_average: 6,
                    vote_count: 2,
                },
            ]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].images.poster[0], "https://image.tmdb.org/t/p/w780/best-season-poster.jpg");
    assert.equal(payload[0].episodes[0].title, "第一集中文");
    assert.equal(parseUnifiedCache(persistentData).trakt.image["season:seasons:555:1"].poster.url, "https://image.tmdb.org/t/p/original/best-season-poster.jpg");
    assert.ok(httpLogs.some((entry) => entry.method === "GET" && entry.url === "https://api.trakt.tv/shows/555?extended=cloud9,full,watchnow"));
    assert.ok(httpLogs.some((entry) => entry.method === "GET" && entry.url === `${TEST_BACKEND_IMAGES_URL}?mode=chinese&seasons=555:1`));
    assert.ok(httpLogs.some((entry) => entry.method === "GET" && entry.url === TEST_TMDB_SEASON_IMAGES_URL));
});

test("posterImageMode=original 时季海报缺 show language/country 会补查 show detail", async () => {
    const seasonPoster = "https://walter.trakt.tv/images/seasons/000/001/posters/original.jpg";
    const seasonImagesUrl = "https://api.tmdb.org/3/tv/777/season/1/images?language=zh%2Cja&api_key=a0a4d50000eeb10604c5f9342c8b3f62";
    const { result, persistentData, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/shows/555/seasons",
        body: JSON.stringify([
            {
                number: 1,
                first_aired: "2024-01-01T00:00:00.000Z",
                images: {
                    poster: [seasonPoster],
                },
                episodes: [],
            },
        ]),
        argument: {
            backendBaseUrl: TEST_BACKEND_BASE_URL,
            posterImageMode: "original",
        },
        persistentData: createUnifiedPersistentData({
            traktLinkIds: {
                555: {
                    ids: {
                        trakt: 555,
                        tmdb: 777,
                    },
                },
            },
        }),
        httpGetMocks: {
            [`${TEST_BACKEND_IMAGES_URL}?mode=original&seasons=555:1`]: "{}",
            [`${TEST_BACKEND_IMAGES_URL}?mode=chinese&seasons=555:1`]: "{}",
            "https://api.trakt.tv/shows/555?extended=cloud9,full,watchnow": JSON.stringify({
                ids: {
                    trakt: 555,
                    tmdb: 777,
                },
                language: "ja",
                country: "JP",
            }),
            [seasonImagesUrl]: createTmdbImagesResponse([
                {
                    iso_639_1: "ja",
                    iso_3166_1: "US",
                    file_path: "/ja-us-season-poster.jpg",
                    vote_average: 10,
                    vote_count: 100,
                },
                {
                    iso_639_1: "ja",
                    iso_3166_1: "JP",
                    file_path: "/ja-jp-season-poster.jpg",
                    vote_average: 1,
                    vote_count: 1,
                },
            ]),
        },
    });

    const payload = JSON.parse(result.body);
    const cache = parseUnifiedCache(persistentData);
    assert.equal(payload[0].images.poster[0], "https://image.tmdb.org/t/p/w780/ja-jp-season-poster.jpg");
    assert.equal(cache.trakt.image["original:seasons:555:1"].poster.url, "https://image.tmdb.org/t/p/original/ja-jp-season-poster.jpg");
    assert.equal(cache.trakt.linkIds["555"].language, "ja");
    assert.equal(cache.trakt.linkIds["555"].country, "JP");
    assert.ok(httpLogs.some((entry) => entry.method === "GET" && entry.url === "https://api.trakt.tv/shows/555?extended=cloud9,full,watchnow"));
});

test("posterImageMode=original 时季海报缺 show country 会用 TMDb detail 补国家", async () => {
    const seasonPoster = "https://walter.trakt.tv/images/seasons/000/001/posters/original.jpg";
    const tmdbShowDetailUrl = "https://api.tmdb.org/3/tv/777?api_key=a0a4d50000eeb10604c5f9342c8b3f62";
    const seasonImagesUrl = "https://api.tmdb.org/3/tv/777/season/1/images?language=zh%2Cja&api_key=a0a4d50000eeb10604c5f9342c8b3f62";
    const { result, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/shows/555/seasons",
        body: JSON.stringify([
            {
                number: 1,
                first_aired: "2024-01-01T00:00:00.000Z",
                images: {
                    poster: [seasonPoster],
                },
                episodes: [],
            },
        ]),
        argument: {
            backendBaseUrl: TEST_BACKEND_BASE_URL,
            posterImageMode: "original",
        },
        persistentData: createUnifiedPersistentData({
            traktLinkIds: {
                555: {
                    ids: {
                        trakt: 555,
                        tmdb: 777,
                    },
                    language: "ja",
                },
            },
        }),
        httpGetMocks: {
            [`${TEST_BACKEND_IMAGES_URL}?mode=original&seasons=555:1`]: "{}",
            [`${TEST_BACKEND_IMAGES_URL}?mode=chinese&seasons=555:1`]: "{}",
            "https://api.trakt.tv/shows/555?extended=cloud9,full,watchnow": JSON.stringify({
                ids: {
                    trakt: 555,
                    tmdb: 777,
                },
                language: "ja",
                country: null,
            }),
            [tmdbShowDetailUrl]: JSON.stringify({
                original_language: "ja",
                origin_country: ["JP"],
            }),
            [seasonImagesUrl]: createTmdbImagesResponse([
                {
                    iso_639_1: "ja",
                    iso_3166_1: "US",
                    file_path: "/ja-us-season-country-poster.jpg",
                    vote_average: 10,
                    vote_count: 100,
                },
                {
                    iso_639_1: "ja",
                    iso_3166_1: "JP",
                    file_path: "/ja-jp-season-country-poster.jpg",
                    vote_average: 1,
                    vote_count: 1,
                },
            ]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].images.poster[0], "https://image.tmdb.org/t/p/w780/ja-jp-season-country-poster.jpg");
    assert.ok(httpLogs.some((entry) => entry.method === "GET" && entry.url === tmdbShowDetailUrl));
});

test("/shows/:id/seasons 没有 currentSeason 时仍会替换季海报", async () => {
    const seasonPoster = "https://walter.trakt.tv/images/seasons/000/001/posters/original.jpg";
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/shows/555/seasons",
        body: JSON.stringify([
            {
                number: 1,
                first_aired: "2024-01-01T00:00:00.000Z",
                images: {
                    poster: [seasonPoster],
                },
                episodes: [],
            },
        ]),
        argument: {
            backendBaseUrl: TEST_BACKEND_BASE_URL,
            posterImageMode: "chinese",
        },
        persistentData: createUnifiedPersistentData({
            traktLinkIds: {
                555: {
                    ids: {
                        trakt: 555,
                        tmdb: 777,
                    },
                    language: "en",
                    country: "US",
                },
            },
        }),
        httpGetMocks: {
            [`${TEST_BACKEND_IMAGES_URL}?mode=chinese&seasons=555:1`]: "{}",
            [`${TEST_BACKEND_IMAGES_URL}?mode=original&seasons=555:1`]: "{}",
            [TEST_TMDB_SEASON_IMAGES_URL]: createTmdbImagesResponse([
                {
                    iso_639_1: "zh",
                    iso_3166_1: "CN",
                    file_path: "/direct-season-poster.jpg",
                    vote_average: 6,
                    vote_count: 2,
                },
            ]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].images.poster[0], "https://image.tmdb.org/t/p/w780/direct-season-poster.jpg");
});

test("/shows/:id/seasons 命中后端季图片缓存时写入新 season 本地 key 且不请求 TMDb", async () => {
    const seasonPoster = "https://walter.trakt.tv/images/seasons/000/001/posters/original.jpg";
    const { result, persistentData, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/shows/555/seasons",
        body: JSON.stringify([
            {
                number: 1,
                first_aired: "2024-01-01T00:00:00.000Z",
                images: {
                    poster: [seasonPoster],
                },
                episodes: [],
            },
        ]),
        argument: {
            backendBaseUrl: TEST_BACKEND_BASE_URL,
            posterImageMode: "chinese",
        },
        persistentData: createUnifiedPersistentData({
            traktLinkIds: {
                555: {
                    ids: {
                        trakt: 555,
                        tmdb: 777,
                    },
                    language: "en",
                    country: "US",
                },
            },
        }),
        httpGetMocks: {
            [`${TEST_BACKEND_IMAGES_URL}?mode=chinese&seasons=555:1`]: JSON.stringify({
                seasons: {
                    "555:1": {
                        poster: {
                            status: 1,
                            url: "https://image.tmdb.org/t/p/original/backend-season-poster.jpg",
                        },
                    },
                },
            }),
        },
    });

    const payload = JSON.parse(result.body);
    const imageCache = parseUnifiedCache(persistentData).trakt.image;
    assert.equal(payload[0].images.poster[0], "https://image.tmdb.org/t/p/w780/backend-season-poster.jpg");
    assert.equal(imageCache["season:seasons:555:1"].poster.url, "https://image.tmdb.org/t/p/original/backend-season-poster.jpg");
    assert.equal(imageCache["season:555:1"], undefined);
    assert.equal(
        httpLogs.some((entry) => entry.method === "GET" && entry.url === TEST_TMDB_SEASON_IMAGES_URL),
        false,
    );
});

test("posterImageMode=default 时 season 不补 TMDb ID 且不替换季海报", async () => {
    const seasonPoster = "https://walter.trakt.tv/images/seasons/000/001/posters/original.jpg";
    const { result, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/shows/555/seasons",
        body: JSON.stringify([
            {
                number: 1,
                first_aired: "2024-01-01T00:00:00.000Z",
                images: {
                    poster: [seasonPoster],
                },
                episodes: [],
            },
        ]),
        argument: {
            posterImageMode: "default",
        },
        persistentData: createUnifiedPersistentData({
            traktLinkIds: {
                555: {
                    ids: {
                        trakt: 555,
                    },
                },
            },
        }),
        httpGetMocks: {
            "https://api.trakt.tv/shows/555?extended=cloud9,full,watchnow": JSON.stringify({
                ids: {
                    trakt: 555,
                    tmdb: 777,
                },
            }),
            [TEST_TMDB_SEASON_IMAGES_URL]: createTmdbImagesResponse([
                {
                    iso_639_1: "zh",
                    iso_3166_1: "CN",
                    file_path: "/disabled-season-poster.jpg",
                    vote_average: 6,
                    vote_count: 2,
                },
            ]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].images.poster[0], seasonPoster);
    assert.equal(
        httpLogs.some((entry) => entry.url === "https://api.trakt.tv/shows/555?extended=cloud9,full,watchnow" || entry.url === TEST_TMDB_SEASON_IMAGES_URL),
        false,
    );
});

test("/shows/:id/seasons 没有季海报字段时不补 TMDb ID", async () => {
    const { result, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/shows/555/seasons",
        body: JSON.stringify([
            {
                number: 1,
                first_aired: "2024-01-01T00:00:00.000Z",
                episodes: [],
            },
        ]),
        persistentData: createUnifiedPersistentData({
            traktLinkIds: {
                555: {
                    ids: {
                        trakt: 555,
                    },
                },
            },
        }),
        httpGetMocks: {
            "https://api.trakt.tv/shows/555?extended=cloud9,full,watchnow": JSON.stringify({
                ids: {
                    trakt: 555,
                    tmdb: 777,
                },
            }),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].images, undefined);
    assert.equal(
        httpLogs.some((entry) => entry.url === "https://api.trakt.tv/shows/555?extended=cloud9,full,watchnow" || entry.url.startsWith("https://api.tmdb.org/3/")),
        false,
    );
});

test("/shows/:id/seasons/:season/episodes/:episode 会直接生成中文集数标题", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/shows/555/seasons/1/episodes/12",
        body: JSON.stringify({
            title: "Episode 12",
            overview: "Original Episode Overview",
        }),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.title, "第12集");
    assert.equal(payload.overview, "Original Episode Overview");
});

test("Rippple episode 详情生成中文集数标题时会同步 original_title", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/shows/555/seasons/1/episodes/2",
        body: JSON.stringify({
            title: "Episode 02",
            original_title: "Episode 02",
            overview: "Original Episode Overview",
        }),
        headers: {
            "user-agent": "Rippple/1.0",
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.title, "第2集");
    assert.equal(payload.original_title, "第2集");
});

test("媒体列表已有缓存翻译时不会重复写入统一缓存", async () => {
    const persistentData = createUnifiedPersistentData({
        rev: 123,
        traktTranslation: JSON.parse(createMediaTranslationCache()),
    });
    const beforeCache = persistentData[UNIFIED_CACHE_KEY];
    const { result, persistentData: afterPersistentData } = await runResponseCase({
        url: "https://api.trakt.tv/movies/trending",
        body: createDirectTranslationLookupBody(),
        persistentData,
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].movie.title, "中文电影");
    assert.equal(afterPersistentData[UNIFIED_CACHE_KEY], beforeCache);
});

test("/translations/zh 写回媒体缓存时只保留状态和翻译", async () => {
    const { persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/translations/zh?extended=all",
        body: readFixture("translations.json"),
    });

    const cacheEntry = parseUnifiedCache(persistentData).trakt.translation["movie:123"];
    assert.ok(cacheEntry);
    assert.deepEqual(Object.keys(cacheEntry).sort(), ["status", "translation"]);
});

test("/movies/:id 遇到损坏的媒体缓存字符串时会安全降级", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body: readFixture("movie-detail.json"),
        persistentData: {
            [UNIFIED_CACHE_KEY]: "{not-json",
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.title, "Original Title");
    assert.equal(payload.overview, "Original Overview");
    assert.equal(payload.tagline, "Original Tagline");
});

test("统一缓存 version 不匹配时会清空旧缓存并正常写入新翻译", async () => {
    const { persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/translations/zh?extended=all",
        body: readFixture("translations.json"),
        persistentData: {
            [UNIFIED_CACHE_KEY]: JSON.stringify({
                version: 999,
                trakt: {
                    translation: {
                        "movie:123": createMediaTranslationEntry({
                            translation: {
                                title: "旧标题",
                            },
                        }),
                        "movie:456": createMediaTranslationEntry({
                            translation: {
                                title: "应被清空的旧标题",
                            },
                        }),
                    },
                },
            }),
        },
    });

    const unifiedCache = parseUnifiedCache(persistentData);
    assert.equal(unifiedCache.version, UNIFIED_CACHE_SCHEMA_VERSION);
    assert.equal(unifiedCache.trakt.translation["movie:123"].translation.title, "港版标题");
    assert.equal(unifiedCache.trakt.translation["movie:456"], undefined);
});

test("统一缓存超过上限时会裁剪低优先级 Google 评论并保留媒体翻译与持久状态", async () => {
    const largeText = "A".repeat(1100 * 1024);
    const { persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/comments/123/replies",
        body: readFixture("comments.json"),
        persistentData: createUnifiedPersistentData({
            traktTranslation: {
                "movie:123": createMediaTranslationEntry({
                    translation: {
                        title: "保留标题",
                        overview: "保留简介",
                    },
                }),
            },
            persistentHistoryShows: {
                "https://api.trakt.tv/users/me/history/episodes": {
                    shows: {
                        555: true,
                    },
                },
            },
            googleComments: {
                old: {
                    comment: {
                        sourceTextHash: computeStringHash("old"),
                        translatedText: largeText,
                    },
                },
                newer: {
                    comment: {
                        sourceTextHash: computeStringHash("newer"),
                        translatedText: largeText,
                    },
                },
            },
        }),
        httpPostMocks: {
            [GOOGLE_TRANSLATE_URL]: createGoogleTranslateResponse(["很棒的电影"]),
        },
    });

    const unifiedCache = parseUnifiedCache(persistentData);
    assert.equal(Object.keys(unifiedCache.google.comments).length, 2);
    assert.equal(unifiedCache.trakt.translation["movie:123"].translation.title, "保留标题");
    assert.deepEqual(unifiedCache.persistent.historyShows["https://api.trakt.tv/users/me/history/episodes"], {
        shows: {
            555: true,
        },
    });
    assert.equal(unifiedCache.persistent.currentSeason, null);
});

test("merged history episodes 请求会在 request phase 改写为最小 limit", async () => {
    const { result } = await runRequestCase({
        url: "https://api.trakt.tv/users/me/history/episodes?page=2&limit=10",
        headers: {
            "user-agent": "Trakt/1.0",
        },
    });

    assert.equal(result.url, "https://api.trakt.tv/users/me/history/episodes?page=2&limit=500");
});

test("Rippple history 请求不会再在 request phase 改写 limit", async () => {
    const { result } = await runRequestCase({
        url: "https://api.trakt.tv/users/me/history?page=1&limit=20",
        headers: {
            "user-agent": "Rippple/1.0",
        },
    });

    assert.equal(Object.keys(result).length, 0);
});

test("merged history episodes 列表会按 show 保留最新一条并应用缓存翻译", async () => {
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/users/me/history/episodes?page=1&limit=10",
        body: readFixture("history-episodes.json"),
        headers: {
            "user-agent": "Trakt/1.0",
        },
        httpGetMocks: {
            "https://api.trakt.tv/shows/555/translations/zh?extended=all": "[]",
            "https://api.trakt.tv/shows/777/translations/zh?extended=all": "[]",
        },
        persistentData: createUnifiedPersistentData({
            traktTranslation: JSON.parse(
                createMediaTranslationCache({
                    "episode:555:1:2": createMediaTranslationEntry({
                        translation: {
                            title: "第二集中文",
                            overview: "第二集中文简介",
                            tagline: "第二集中文标语",
                        },
                    }),
                    "episode:777:2:1": createMediaTranslationEntry({
                        translation: {
                            title: "其他剧中文",
                            overview: "其他剧中文简介",
                            tagline: "其他剧中文标语",
                        },
                    }),
                }),
            ),
        }),
    });

    const payload = JSON.parse(result.body);
    assert.deepEqual(
        payload.map((item) => item.id),
        [2, 3],
    );
    assert.equal(payload[0].episode.title, "第二集中文");
    assert.equal(payload[1].episode.title, "其他剧中文");

    const historyCache = parseUnifiedCache(persistentData).persistent.historyShows;
    const bucketKey = "https://api.trakt.tv/users/me/history/episodes";
    assert.ok(historyCache[bucketKey]);
    assert.deepEqual(historyCache[bucketKey].shows, {
        555: true,
        777: true,
    });
});

test("historyEpisodesMergedByShow 启用时历史剧集只缓存合并后剧集和对应电视剧翻译", async () => {
    const translationsBody = readFixture("translations.json");
    const { result, persistentData, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/users/me/history/episodes?page=1&limit=10",
        body: readFixture("history-episodes.json"),
        headers: {
            "user-agent": "Trakt/1.0",
        },
        httpGetMocks: {
            "https://api.trakt.tv/shows/555/translations/zh?extended=all": translationsBody,
            "https://api.trakt.tv/shows/777/translations/zh?extended=all": translationsBody,
            "https://api.trakt.tv/shows/555/seasons/1/episodes/2/translations/zh?extended=all": translationsBody,
            "https://api.trakt.tv/shows/777/seasons/2/episodes/1/translations/zh?extended=all": translationsBody,
        },
    });

    const payload = JSON.parse(result.body);
    assert.deepEqual(
        payload.map((item) => item.id),
        [2, 3],
    );
    assert.equal(payload[0].show.title, "港版标题");
    assert.equal(payload[0].episode.title, "港版标题");
    assert.equal(payload[1].show.title, "港版标题");
    assert.equal(payload[1].episode.title, "港版标题");

    const translationCache = parseUnifiedCache(persistentData).trakt.translation;
    assert.deepEqual(Object.keys(translationCache).sort(), ["episode:555:1:2", "episode:777:2:1", "show:555", "show:777"]);
    assert.equal(translationCache["show:555"].translation.title, "港版标题");
    assert.equal(translationCache["show:777"].translation.title, "港版标题");
    assert.equal(translationCache["episode:555:1:2"].translation.title, "港版标题");
    assert.equal(translationCache["episode:777:2:1"].translation.title, "港版标题");
    assert.equal(translationCache["episode:555:1:1"], undefined);
    assert.equal(
        httpLogs.some((entry) => entry.method === "GET" && entry.url === `${DEFAULT_BACKEND_BASE_URL}/api/trakt/translations?shows=555,777&episodes=555:1:2,777:2:1`),
        true,
    );

    assert.equal(
        httpLogs.some((entry) => entry.method === "GET" && entry.url === "https://api.trakt.tv/shows/555/seasons/1/episodes/1/translations/zh?extended=all"),
        false,
    );
});

test("comments 列表会应用缓存中的评论翻译", async () => {
    const persistentData = createUnifiedPersistentData({
        rev: 123,
        googleComments: JSON.parse(createCommentTranslationCache()),
    });
    const beforeCache = persistentData[UNIFIED_CACHE_KEY];
    const { result, persistentData: afterPersistentData } = await runResponseCase({
        url: "https://api.trakt.tv/comments/123/replies",
        body: readFixture("comments.json"),
        persistentData,
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].comment, "很棒的电影");
    assert.equal(afterPersistentData[UNIFIED_CACHE_KEY], beforeCache);
});

test("googleTranslationEnabled=false 时 comments 不触发 Google 翻译，但仍可应用缓存", async () => {
    const cachedComments = JSON.parse(createCommentTranslationCache());
    const { result, persistentData, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/comments/123/replies",
        body: readFixture("comments.json"),
        argument: {
            googleTranslationEnabled: false,
        },
        persistentData: createUnifiedPersistentData({
            googleComments: cachedComments,
        }),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].comment, "很棒的电影");
    assert.equal(parseUnifiedCache(persistentData).google.comments["9001"].comment.translatedText, "很棒的电影");
    assert.equal(
        httpLogs.some((entry) => entry.method === "POST" && entry.url === GOOGLE_TRANSLATE_URL),
        false,
    );
});

test("comments 列表会翻译未命中的评论并写回缓存", async () => {
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/comments/123/replies",
        body: readFixture("comments.json"),
        httpPostMocks: {
            "https://translation.googleapis.com/language/translate/v2": createGoogleTranslateResponse(["很棒的电影"]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].comment, "很棒的电影");

    const cache = parseUnifiedCache(persistentData).google.comments;
    assert.equal(cache["9001"].comment.translatedText, "很棒的电影");
    assert.equal(cache["9001"].comment.sourceTextHash, computeStringHash("Great movie"));
});

test("comments 写回缓存时会保留其他 comment 项", async () => {
    const { persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/comments/123/replies",
        body: readFixture("comments.json"),
        persistentData: createUnifiedPersistentData({
            googleComments: {
                7777: {
                    comment: {
                        sourceTextHash: "cafebabe",
                        translatedText: "其他评论",
                    },
                },
            },
        }),
        httpPostMocks: {
            "https://translation.googleapis.com/language/translate/v2": createGoogleTranslateResponse(["很棒的电影"]),
        },
    });

    const cache = parseUnifiedCache(persistentData).google.comments;
    assert.equal(cache["9001"].comment.translatedText, "很棒的电影");
    assert.equal(cache["7777"].comment.translatedText, "其他评论");
});

test("comments 列表会按语言分组翻译并跳过中文项", async () => {
    const body = JSON.stringify([
        {
            id: 9001,
            language: "en",
            comment: "Great movie",
        },
        {
            id: 9002,
            language: "es",
            comment: "Excelente pelicula",
        },
        {
            id: 9003,
            language: "zh-CN",
            comment: "已经是中文",
        },
    ]);

    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/comments/123/replies",
        body,
        httpPostMocks: {
            "https://translation.googleapis.com/language/translate/v2": [createGoogleTranslateResponse(["很棒的电影"]), createGoogleTranslateResponse(["优秀的电影"])],
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].comment, "很棒的电影");
    assert.equal(payload[1].comment, "优秀的电影");
    assert.equal(payload[2].comment, "已经是中文");

    const cache = parseUnifiedCache(persistentData).google.comments;
    assert.equal(cache["9001"].comment.translatedText, "很棒的电影");
    assert.equal(cache["9002"].comment.translatedText, "优秀的电影");
    assert.equal(cache["9003"], undefined);
});

test("comments 在部分翻译结果为空时只更新成功项并保留其他原文", async () => {
    const body = JSON.stringify([
        {
            id: 9001,
            language: "en",
            comment: "Great movie",
        },
        {
            id: 9002,
            language: "en",
            comment: "Needs work",
        },
    ]);

    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/comments/123/replies",
        body,
        httpPostMocks: {
            "https://translation.googleapis.com/language/translate/v2": createGoogleTranslateResponse(["很棒的电影", ""]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].comment, "很棒的电影");
    assert.equal(payload[1].comment, "Needs work");

    const cache = parseUnifiedCache(persistentData).google.comments;
    assert.equal(cache["9001"].comment.translatedText, "很棒的电影");
    assert.equal(cache["9002"], undefined);
});

test("comments 列表遇到 hash 不匹配的旧缓存时会忽略旧值并刷新缓存", async () => {
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/comments/123/replies",
        body: readFixture("comments.json"),
        persistentData: createUnifiedPersistentData({
            googleComments: JSON.parse(
                createCommentTranslationCache({
                    9001: {
                        comment: {
                            sourceTextHash: "deadbeef",
                            translatedText: "旧错误翻译",
                        },
                    },
                }),
            ),
        }),
        httpPostMocks: {
            "https://translation.googleapis.com/language/translate/v2": createGoogleTranslateResponse(["很棒的电影"]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].comment, "很棒的电影");

    const cache = parseUnifiedCache(persistentData).google.comments;
    assert.equal(cache["9001"].comment.translatedText, "很棒的电影");
    assert.equal(cache["9001"].comment.sourceTextHash, computeStringHash("Great movie"));
});

createGoogleFailureCases().forEach(({ name, mock }) => {
    test(`comments 列表在${name}时会保留原文且不写入脏缓存`, async () => {
        const { result, persistentData } = await runResponseCase({
            url: "https://api.trakt.tv/comments/123/replies",
            body: readFixture("comments.json"),
            httpPostMocks: {
                [GOOGLE_TRANSLATE_URL]: mock,
            },
        });

        const payload = JSON.parse(result.body);
        assert.equal(payload[0].comment, "Great movie");
        assert.deepEqual(parseUnifiedCache(persistentData).google.comments, {});
    });
});

test("comments 列表在 Google 返回空翻译结果时会保留原文且不写入脏缓存", async () => {
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/comments/123/replies",
        body: readFixture("comments.json"),
        httpPostMocks: {
            "https://translation.googleapis.com/language/translate/v2": createEmptyGoogleTranslateResponse(),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].comment, "Great movie");
    assert.deepEqual(parseUnifiedCache(persistentData).google.comments, {});
});

test("recent comments 列表会同时应用媒体翻译和评论翻译", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/comments/recent/movies/weekly",
        body: readFixture("recent-comments.json"),
        persistentData: createUnifiedPersistentData({
            traktTranslation: JSON.parse(createMediaTranslationCache()),
            googleComments: JSON.parse(createCommentTranslationCache()),
        }),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].movie.title, "中文电影");
    assert.equal(payload[0].comment.comment, "很棒的电影");
});

test("list descriptions 会应用缓存中的描述翻译", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/lists/popular",
        body: readFixture("list-descriptions.json"),
        persistentData: createUnifiedPersistentData({
            googleList: JSON.parse(createListTranslationCache()),
        }),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].description, "一个不错的列表");
});

test("googleTranslationEnabled=false 时 list descriptions 不触发 Google 翻译，但仍可应用缓存", async () => {
    const cachedList = JSON.parse(
        createListTranslationCache({
            321: {
                name: {
                    sourceTextHash: computeStringHash("Favorites"),
                    translatedText: "收藏夹",
                },
                description: {
                    sourceTextHash: computeStringHash("A good list"),
                    translatedText: "一个不错的列表",
                },
            },
        }),
    );
    const persistentData = createUnifiedPersistentData({
        rev: 123,
        googleList: cachedList,
    });
    const beforeCache = persistentData[UNIFIED_CACHE_KEY];
    const {
        result,
        persistentData: afterPersistentData,
        httpLogs,
    } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/lists/popular",
        body: readFixture("list-descriptions.json"),
        argument: {
            googleTranslationEnabled: false,
        },
        persistentData,
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].name, "收藏夹");
    assert.equal(payload[0].description, "一个不错的列表");
    const cache = parseUnifiedCache(afterPersistentData).google.list;
    assert.equal(cache["321"].name.translatedText, "收藏夹");
    assert.equal(cache["321"].description.translatedText, "一个不错的列表");
    assert.equal(afterPersistentData[UNIFIED_CACHE_KEY], beforeCache);
    assert.equal(
        httpLogs.some((entry) => entry.method === "POST" && entry.url === GOOGLE_TRANSLATE_URL),
        false,
    );
});

test("list descriptions 会翻译未命中的描述并写回缓存", async () => {
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/lists/popular",
        body: readFixture("list-descriptions.json"),
        httpPostMocks: {
            "https://translation.googleapis.com/language/translate/v2": createGoogleTranslateResponse(["收藏夹", "一个不错的列表"]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].description, "一个不错的列表");

    const cache = parseUnifiedCache(persistentData).google.list;
    assert.equal(cache["321"].description.translatedText, "一个不错的列表");
    assert.equal(cache["321"].description.sourceTextHash, computeStringHash("A good list"));
});

test("list descriptions 遇到 hash 不匹配的旧缓存时会忽略旧值并刷新缓存", async () => {
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/lists/popular",
        body: readFixture("list-descriptions.json"),
        persistentData: createUnifiedPersistentData({
            googleList: JSON.parse(
                createListTranslationCache({
                    321: {
                        description: {
                            sourceTextHash: "deadbeef",
                            translatedText: "旧错误描述",
                        },
                    },
                }),
            ),
        }),
        httpPostMocks: {
            "https://translation.googleapis.com/language/translate/v2": createGoogleTranslateResponse(["收藏夹", "一个不错的列表"]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].description, "一个不错的列表");

    const cache = parseUnifiedCache(persistentData).google.list;
    assert.equal(cache["321"].description.translatedText, "一个不错的列表");
    assert.equal(cache["321"].description.sourceTextHash, computeStringHash("A good list"));
});

test("list descriptions 会批量翻译多个非中文描述并跳过已是中文的描述", async () => {
    const body = JSON.stringify([
        {
            name: "Favorites",
            language: "en",
            description: "A good list",
            ids: {
                trakt: 321,
            },
        },
        {
            name: "Popular",
            language: "es",
            description: "Lista excelente",
            ids: {
                trakt: 322,
            },
        },
        {
            name: "中文列表",
            language: "zh-CN",
            description: "已经是中文描述",
            ids: {
                trakt: 323,
            },
        },
    ]);

    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/lists/popular",
        body,
        httpPostMocks: {
            "https://translation.googleapis.com/language/translate/v2": createGoogleTranslateResponse(["收藏夹", "一个不错的列表", "热门", "优秀列表"]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].name, "收藏夹");
    assert.equal(payload[0].description, "一个不错的列表");
    assert.equal(payload[1].name, "热门");
    assert.equal(payload[1].description, "优秀列表");
    assert.equal(payload[2].description, "已经是中文描述");

    const cache = parseUnifiedCache(persistentData).google.list;
    assert.equal(cache["321"].description.translatedText, "一个不错的列表");
    assert.equal(cache["322"].description.translatedText, "优秀列表");
    assert.equal(cache["323"], undefined);
});

test("list descriptions 在部分翻译结果为空时只更新成功项并保留其他原文", async () => {
    const body = JSON.stringify([
        {
            name: "Favorites",
            description: "A good list",
            ids: {
                trakt: 321,
            },
        },
        {
            name: "Popular",
            description: "Needs more detail",
            ids: {
                trakt: 322,
            },
        },
    ]);

    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/lists/popular",
        body,
        httpPostMocks: {
            "https://translation.googleapis.com/language/translate/v2": createGoogleTranslateResponse(["收藏夹", "一个不错的列表", "", ""]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].description, "一个不错的列表");
    assert.equal(payload[1].description, "Needs more detail");

    const cache = parseUnifiedCache(persistentData).google.list;
    assert.equal(cache["321"].description.translatedText, "一个不错的列表");
    assert.equal(cache["322"], undefined);
});

createGoogleFailureCases().forEach(({ name, mock }) => {
    test(`list descriptions 在${name}时会保留原描述且不写入脏缓存`, async () => {
        const { result, persistentData } = await runResponseCase({
            url: "https://api.trakt.tv/movies/123/lists/popular",
            body: readFixture("list-descriptions.json"),
            httpPostMocks: {
                [GOOGLE_TRANSLATE_URL]: mock,
            },
        });

        const payload = JSON.parse(result.body);
        assert.equal(payload[0].description, "A good list");
        assert.deepEqual(parseUnifiedCache(persistentData).google.list, {});
    });
});

test("list descriptions 在 Google 返回空翻译结果时会保留原描述且不写入脏缓存", async () => {
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/lists/popular",
        body: readFixture("list-descriptions.json"),
        httpPostMocks: {
            "https://translation.googleapis.com/language/translate/v2": createEmptyGoogleTranslateResponse(),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].description, "A good list");
    assert.deepEqual(parseUnifiedCache(persistentData).google.list, {});
});

test("sentiments 会应用缓存中的翻译结果", async () => {
    const data = JSON.parse(readFixture("sentiments.json"));
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/sentiments",
        body: JSON.stringify(data),
        persistentData: createUnifiedPersistentData({
            googleSentiments: JSON.parse(createSentimentTranslationCache()),
        }),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.aspect.pros[0].theme, "剧情");
    assert.equal(payload.aspect.cons[0].theme, "节奏");
    assert.equal(payload.good[0].sentiment, "演员阵容出色");
    assert.equal(payload.bad[0].sentiment, "结尾较弱");
    assert.equal(payload.summary[0], "整体观感不错");
    assert.equal(payload.analysis, "详细分析");
    assert.equal(payload.highlight, "高光时刻");
    assert.equal(payload.items[0].text, "难忘场景");
    assert.equal(payload.text, "观众文本");
});

test("googleTranslationEnabled=false 时 sentiments 不触发 Google 翻译，但仍可应用缓存", async () => {
    const cachedSentiments = JSON.parse(createSentimentTranslationCache());
    const { result, persistentData, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/sentiments",
        body: readFixture("sentiments.json"),
        argument: {
            googleTranslationEnabled: false,
        },
        persistentData: createUnifiedPersistentData({
            googleSentiments: cachedSentiments,
        }),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.aspect.pros[0].theme, "剧情");
    assert.equal(payload.good[0].sentiment, "演员阵容出色");
    assert.equal(payload.text, "观众文本");
    const cache = parseUnifiedCache(persistentData).google.sentiments;
    assert.equal(cache["movie:123"].translation.aspect.pros[0].translatedText, "剧情");
    assert.equal(cache["movie:123"].translation.text.translatedText, "观众文本");
    assert.equal(
        httpLogs.some((entry) => entry.method === "POST" && entry.url === GOOGLE_TRANSLATE_URL),
        false,
    );
});

["https://apiz.trakt.tv/v3/media/movie/853702/info/5/version/1", "https://apiz.trakt.tv/v3/media/movie/853702/info/0/version/1"].forEach((url) => {
    test(`${url} 会应用缓存中的 sentiments 翻译`, async () => {
        const data = JSON.parse(readFixture("sentiments.json"));
        const googleSentiments = JSON.parse(createSentimentTranslationCache());
        googleSentiments["movie:853702"] = JSON.parse(JSON.stringify(googleSentiments["movie:123"]));

        const { result } = await runResponseCase({
            url,
            body: JSON.stringify(data),
            persistentData: createUnifiedPersistentData({
                googleSentiments,
            }),
        });

        const payload = JSON.parse(result.body);
        assert.equal(payload.aspect.pros[0].theme, "剧情");
        assert.equal(payload.aspect.cons[0].theme, "节奏");
        assert.equal(payload.good[0].sentiment, "演员阵容出色");
        assert.equal(payload.bad[0].sentiment, "结尾较弱");
        assert.equal(payload.summary[0], "整体观感不错");
        assert.equal(payload.analysis, "详细分析");
        assert.equal(payload.highlight, "高光时刻");
        assert.equal(payload.items[0].text, "难忘场景");
        assert.equal(payload.text, "观众文本");
    });
});

test("sentiments 会用双语片名语境翻译未命中的叙述内容并写回缓存", async () => {
    const translatedSentiments = [
        "剧情",
        "节奏",
        "演员阵容出色",
        "结尾较弱",
        "Original Movie (中文电影)\n整体观感不错",
        "Original Movie (中文电影)\n详细分析",
        "高光时刻",
        "难忘场景",
        "观众文本",
    ];
    const { result, persistentData, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/sentiments",
        body: readFixture("sentiments.json"),
        persistentData: createUnifiedPersistentData({
            traktLinkIds: {
                123: {
                    ids: { trakt: 123 },
                    title: "Original Movie",
                },
            },
            traktTranslation: {
                "movie:123": createMediaTranslationEntry(),
            },
        }),
        httpPostMocks: {
            "https://translation.googleapis.com/language/translate/v2": [createGoogleTranslateResponse(translatedSentiments), createGoogleTranslateResponse(translatedSentiments)],
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.aspect.pros[0].theme, "剧情");
    assert.equal(payload.good[0].sentiment, "演员阵容出色");
    assert.equal(payload.text, "观众文本");
    assert.equal(payload.summary[0], "整体观感不错");
    assert.equal(payload.analysis, "详细分析");

    const googleRequestBody = httpLogs.find((entry) => entry.method === "POST" && entry.url === GOOGLE_TRANSLATE_URL)?.body ?? "";
    const googleRequestText = JSON.parse(googleRequestBody).text;
    assert.equal(googleRequestText.match(/Original Movie \(中文电影\)/g)?.length, 1);
    assert.deepEqual(extractDeepLxRequestTexts(googleRequestBody), [
        "§Original Movie (中文电影)§Story",
        "Pacing",
        "Great cast",
        "Weak ending",
        "Overall enjoyable",
        "Detailed analysis",
        "Best moment",
        "Memorable scene",
        "Audience text",
    ]);

    const cache = parseUnifiedCache(persistentData).google.sentiments;
    assert.equal(cache["movie:123"].translation.aspect.pros[0].translatedText, "剧情");
    assert.equal(cache["movie:123"].translation.summary[0].sourceTextHash, computeStringHash("Overall enjoyable"));
    assert.equal(cache["movie:123"].translation.summary[0].translatedText, "整体观感不错");
    assert.equal(cache["movie:123"].translation.text.translatedText, "观众文本");
});

test("sentiments 移除片名语境后会修复正文开头残缺书名号", async () => {
    const translatedSentiments = [
        "剧情",
        "节奏",
        "演员阵容出色",
        "结尾较弱",
        "The Housemaid (家弑服务)\n整体观感不错",
        "The Housemaid (家弑服务)\n家弑服务》是一部心理惊悚片。",
        "The Housemaid (家弑服务)\n高光时刻",
        "The Housemaid (家弑服务)\n难忘场景",
        "The Housemaid (家弑服务)\n观众文本",
    ];
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/sentiments",
        body: readFixture("sentiments.json"),
        persistentData: createUnifiedPersistentData({
            traktLinkIds: {
                123: {
                    ids: { trakt: 123 },
                    title: "The Housemaid",
                },
            },
            traktTranslation: {
                "movie:123": createMediaTranslationEntry({
                    translation: {
                        title: "家弑服务",
                        overview: "中文简介",
                        tagline: "中文标语",
                    },
                }),
            },
        }),
        httpPostMocks: {
            [GOOGLE_TRANSLATE_URL]: [createGoogleTranslateResponse(translatedSentiments), createGoogleTranslateResponse(translatedSentiments)],
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.analysis, "《家弑服务》是一部心理惊悚片。");

    const cache = parseUnifiedCache(persistentData).google.sentiments;
    assert.equal(cache["movie:123"].translation.analysis.translatedText, "《家弑服务》是一部心理惊悚片。");
});

test("sentiments 在部分翻译结果为空时只更新成功项并保留其他原文", async () => {
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/sentiments",
        body: readFixture("sentiments.json"),
        httpPostMocks: {
            "https://translation.googleapis.com/language/translate/v2": createGoogleTranslateResponse(["剧情", "", "演员阵容出色", "", "", "", "", "", ""]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.aspect.pros[0].theme, "剧情");
    assert.equal(payload.aspect.cons[0].theme, "Pacing");
    assert.equal(payload.good[0].sentiment, "演员阵容出色");
    assert.equal(payload.bad[0].sentiment, "Weak ending");
    assert.equal(payload.text, "Audience text");

    const cache = parseUnifiedCache(persistentData).google.sentiments;
    assert.equal(cache["movie:123"].translation.aspect.pros[0].translatedText, "剧情");
    assert.equal(cache["movie:123"].translation.aspect.cons[0].translatedText, "Pacing");
    assert.equal(cache["movie:123"].translation.good[0].translatedText, "演员阵容出色");
    assert.equal(cache["movie:123"].translation.bad[0].translatedText, "Weak ending");
});

test("sentiments 遇到 sourceTextHash 不匹配的旧缓存时会忽略旧值并刷新缓存", async () => {
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/sentiments",
        body: readFixture("sentiments.json"),
        persistentData: createUnifiedPersistentData({
            googleSentiments: JSON.parse(
                createSentimentTranslationCache({
                    "movie:123": {
                        translation: {
                            aspect: {
                                pros: [{ sourceTextHash: "deadbeef", translatedText: "旧剧情" }],
                            },
                            good: [],
                            bad: [],
                            summary: [],
                            analysis: { sourceTextHash: "deadbeef", translatedText: "旧分析" },
                            highlight: { sourceTextHash: "deadbeef", translatedText: "旧高光" },
                            items: [],
                            text: { sourceTextHash: "deadbeef", translatedText: "旧文本" },
                        },
                    },
                }),
            ),
        }),
        httpPostMocks: {
            "https://translation.googleapis.com/language/translate/v2": createGoogleTranslateResponse([
                "剧情",
                "节奏",
                "演员阵容出色",
                "结尾较弱",
                "整体观感不错",
                "详细分析",
                "高光时刻",
                "难忘场景",
                "观众文本",
            ]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.aspect.pros[0].theme, "剧情");
    assert.equal(payload.analysis, "详细分析");

    const cache = parseUnifiedCache(persistentData).google.sentiments;
    assert.equal(cache["movie:123"].translation.aspect.pros[0].translatedText, "剧情");
    assert.equal(cache["movie:123"].translation.analysis.translatedText, "详细分析");
});

createGoogleFailureCases().forEach(({ name, mock }) => {
    test(`sentiments 在${name}时会保留原文且不写入缓存`, async () => {
        const { result, persistentData } = await runResponseCase({
            url: "https://api.trakt.tv/movies/123/sentiments",
            body: readFixture("sentiments.json"),
            httpPostMocks: {
                [GOOGLE_TRANSLATE_URL]: mock,
            },
        });

        const payload = JSON.parse(result.body);
        assert.equal(payload.aspect.pros[0].theme, "Story");
        assert.equal(payload.good[0].sentiment, "Great cast");
        assert.equal(payload.text, "Audience text");
        assert.deepEqual(parseUnifiedCache(persistentData).google.sentiments, {});
    });
});

test("sentiments 在 Google 返回空翻译结果时会保留原文并按原文回写缓存", async () => {
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/sentiments",
        body: readFixture("sentiments.json"),
        httpPostMocks: {
            "https://translation.googleapis.com/language/translate/v2": createEmptyGoogleTranslateResponse(),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.aspect.pros[0].theme, "Story");
    assert.equal(payload.good[0].sentiment, "Great cast");
    assert.equal(payload.text, "Audience text");

    const cache = parseUnifiedCache(persistentData).google.sentiments;
    assert.equal(cache["movie:123"].translation.aspect.pros[0].translatedText, "Story");
    assert.equal(cache["movie:123"].translation.good[0].translatedText, "Great cast");
});
