import assert from "node:assert/strict";
import test from "node:test";
import { resolveTmdbLanguage } from "../trakt_simplified_chinese/src/outbound/tmdb-client.mjs";
import { createBackendState, extractBackendWritePayload } from "../trakt_simplified_chinese/src/shared/media-translation-backend.mjs";
import { MEDIA_TYPE } from "../trakt_simplified_chinese/src/shared/media-types.mjs";
import { TEST_TMDB_API_KEY } from "./helpers/run-script.mjs";

import { createHttpStatusMock, createTmdbImagesResponse, createUnifiedPersistentData, runResponseCase } from "./helpers/trakt-test-helpers.mjs";

const TEST_BACKEND_BASE_URL = "https://backend.example";
const TEST_BACKEND_TRANSLATIONS_URL = `${TEST_BACKEND_BASE_URL}/api/trakt/translations`;
const TEST_BACKEND_IMAGES_URL = `${TEST_BACKEND_BASE_URL}/api/trakt/images`;
const TEST_DIRECT_TRANSLATION_URL = "https://api.trakt.tv/movies/123/translations/zh?extended=all";
const TEST_TMDB_MOVIE_IMAGES_URL = `https://api.tmdb.org/3/movie/456/images?language=zh%2Cen&api_key=${TEST_TMDB_API_KEY}`;

function createMovieBody() {
    return JSON.stringify({
        title: "Original Title",
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
    });
}

function createNativeTwMovieBody() {
    return JSON.stringify({
        ...JSON.parse(createMovieBody()),
        title: "泰德拉索：錯棚教練趣事多",
        overview: "台灣原生簡介",
    });
}

function createTranslationsBody() {
    return JSON.stringify([
        {
            language: "zh",
            country: "cn",
            title: "蜘蛛侠：英雄无归",
            overview: "简体简介",
            tagline: "简体标语",
        },
        {
            language: "zh",
            country: "tw",
            title: "蜘蛛人：無家日",
            overview: "台灣繁體簡介",
            tagline: "台灣標語",
        },
        {
            language: "zh",
            country: "hk",
            title: "蜘蛛俠：不戰無歸",
            overview: "香港繁體簡介",
            tagline: "香港標語",
        },
    ]);
}

// App 进入详情页后自行请求 /translations/zh：脚本只负责按地区归一化并缓存/回写，不再代为出站
async function runLocaleTranslationCase(locale) {
    const { result, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/translations/zh?extended=all",
        body: createTranslationsBody(),
        argument: {
            chineseLocale: locale,
            backendBaseUrl: TEST_BACKEND_BASE_URL,
        },
        persistentData: createUnifiedPersistentData(),
        httpPostMocks: {
            [TEST_BACKEND_TRANSLATIONS_URL]: [createHttpStatusMock(200, "{}")],
        },
    });

    return {
        payload: JSON.parse(result.body),
        backendPost: httpLogs.find((entry) => entry.method === "POST" && entry.url === TEST_BACKEND_TRANSLATIONS_URL),
    };
}

test("TMDb 语言按中文地区映射：cn → zh-CN，tw → zh-TW，hk → zh-HK", () => {
    const originalContext = globalThis.$ctx;
    try {
        for (const [locale, expected] of [
            ["cn", "zh-CN"],
            ["tw", "zh-TW"],
            ["hk", "zh-HK"],
        ]) {
            globalThis.$ctx = { argument: { chineseLocale: locale } };
            assert.equal(resolveTmdbLanguage(), expected);
        }
    } finally {
        globalThis.$ctx = originalContext;
    }
});

test("chineseLocale=tw 优先使用台湾原生译名并回写 locale + cn 折叠数据", async () => {
    const { payload, backendPost } = await runLocaleTranslationCase("tw");

    assert.equal(payload[0].title, "蜘蛛人：無家日");
    assert.equal(payload[0].overview, "台灣繁體簡介");
    assert.ok(backendPost, "应回写后端缓存");
    const body = JSON.parse(backendPost.body);
    assert.equal(body.locale, "tw");
    assert.equal(body.movies["123"].translation.title, "蜘蛛人：無家日");
    // cn 折叠数据来自同一次上游响应
    assert.equal(body.cn.movies["123"].translation.title, "蜘蛛侠：英雄无归");
});

test("chineseLocale=hk 优先使用香港原生译名", async () => {
    const { payload, backendPost } = await runLocaleTranslationCase("hk");

    assert.equal(payload[0].title, "蜘蛛俠：不戰無歸");
    assert.equal(payload[0].overview, "香港繁體簡介");
    const body = JSON.parse(backendPost.body);
    assert.equal(body.locale, "hk");
    assert.equal(body.cn.movies["123"].translation.title, "蜘蛛侠：英雄无归");
});

test("默认 cn 保持旧行为：简体译名且请求不带 locale 参数", async () => {
    const { payload, backendPost } = await runLocaleTranslationCase("cn");

    assert.equal(payload[0].title, "蜘蛛侠：英雄无归");
    assert.equal(payload[0].overview, "简体简介");
    const body = JSON.parse(backendPost.body);
    assert.equal(Object.hasOwn(body, "locale"), false);
    assert.equal(Object.hasOwn(body, "cn"), false);
});

test("chineseLocale=tw 海报优先台湾地区图片并请求 locale=tw", async () => {
    const { result, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body: createMovieBody(),
        argument: {
            chineseLocale: "tw",
            posterImageMode: "tw",
            backendBaseUrl: TEST_BACKEND_BASE_URL,
        },
        persistentData: createUnifiedPersistentData(),
        httpGetMocks: {
            [TEST_TMDB_MOVIE_IMAGES_URL]: createTmdbImagesResponse([
                {
                    iso_639_1: "zh",
                    iso_3166_1: "CN",
                    file_path: "/cn-poster.jpg",
                    vote_average: 10,
                    vote_count: 100,
                },
                {
                    iso_639_1: "zh",
                    iso_3166_1: "TW",
                    file_path: "/tw-poster.jpg",
                    vote_average: 1,
                    vote_count: 1,
                },
            ]),
        },
        httpPostMocks: {
            [TEST_BACKEND_IMAGES_URL]: [createHttpStatusMock(200, "{}")],
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.images.poster[0], "https://image.tmdb.org/t/p/w780/tw-poster.jpg");

    const backendGet = httpLogs.find((entry) => entry.method === "GET" && entry.url.startsWith(`${TEST_BACKEND_IMAGES_URL}?`));
    assert.ok(backendGet, "应读取后端图片缓存");
    assert.ok(backendGet.url.includes("locale=tw"), `后端图片读取应带 locale=tw：${backendGet.url}`);

    const imagePost = httpLogs.find((entry) => entry.method === "POST" && entry.url === TEST_BACKEND_IMAGES_URL);
    assert.ok(imagePost);
    const body = JSON.parse(imagePost.body);
    assert.equal(body.locale, "tw");
    assert.equal(body.modes.chinese.movies["123"].poster.url, "https://image.tmdb.org/t/p/original/tw-poster.jpg");
});

test("旧海报语言值 chinese 等价简体中文档位，不再静默回落到原片语言", async () => {
    const { result, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body: createMovieBody(),
        argument: {
            chineseLocale: "cn",
            posterImageMode: "chinese",
            backendBaseUrl: TEST_BACKEND_BASE_URL,
        },
        persistentData: createUnifiedPersistentData(),
        httpGetMocks: {
            [TEST_TMDB_MOVIE_IMAGES_URL]: createTmdbImagesResponse([
                {
                    iso_639_1: "zh",
                    iso_3166_1: "TW",
                    file_path: "/tw-poster.jpg",
                    vote_average: 10,
                    vote_count: 100,
                },
                {
                    iso_639_1: "zh",
                    iso_3166_1: "CN",
                    file_path: "/cn-poster.jpg",
                    vote_average: 1,
                    vote_count: 1,
                },
            ]),
        },
        httpPostMocks: {
            [TEST_BACKEND_IMAGES_URL]: [createHttpStatusMock(200, "{}")],
        },
    });

    const payload = JSON.parse(result.body);
    // cn 档位优先 CN 地区海报（即使 TW 评分更高），说明旧值被识别为简体中文档位
    assert.equal(payload.images.poster[0], "https://image.tmdb.org/t/p/w780/cn-poster.jpg");

    const imagePost = httpLogs.find((entry) => entry.method === "POST" && entry.url === TEST_BACKEND_IMAGES_URL);
    assert.ok(imagePost);
    const body = JSON.parse(imagePost.body);
    // cn 是默认地区：请求体不追加 locale 字段
    assert.equal(Object.hasOwn(body, "locale"), false);
    assert.equal(body.modes.chinese.movies["123"].poster.url, "https://image.tmdb.org/t/p/original/cn-poster.jpg");
});

async function runOverrideCase(locale, overrideEntry, body = createMovieBody()) {
    const { result, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body,
        argument: {
            chineseLocale: locale,
            backendBaseUrl: TEST_BACKEND_BASE_URL,
        },
        persistentData: createUnifiedPersistentData(),
        httpGetMocks: {
            [TEST_DIRECT_TRANSLATION_URL]: createHttpStatusMock(200, "[]"),
            [`${TEST_BACKEND_BASE_URL}/api/trakt/translation-overrides`]: createHttpStatusMock(200, JSON.stringify({ movies: { 123: overrideEntry }, shows: {}, episodes: {} })),
        },
        httpPostMocks: {
            [TEST_BACKEND_TRANSLATIONS_URL]: [createHttpStatusMock(200, "{}")],
        },
    });

    return { payload: JSON.parse(result.body), httpLogs };
}

test("tw/hk 覆盖按地区生效，不用 cn 覆盖覆盖原生译名", async () => {
    const nativeTwBody = createNativeTwMovieBody();

    const twOverride = await runOverrideCase(
        "tw",
        {
            cn: { translation: { title: "大陆覆盖标题" } },
            tw: { translation: { title: "台灣覆蓋標題" } },
        },
        nativeTwBody,
    );
    assert.equal(twOverride.payload.title, "台灣覆蓋標題");

    const cnOnly = await runOverrideCase(
        "tw",
        {
            cn: { translation: { title: "足球教练" } },
        },
        nativeTwBody,
    );
    assert.equal(cnOnly.payload.title, "泰德拉索：錯棚教練趣事多");

    const legacyRoot = await runOverrideCase(
        "tw",
        {
            translation: { title: "足球教练" },
        },
        nativeTwBody,
    );
    assert.equal(legacyRoot.payload.title, "泰德拉索：錯棚教練趣事多");

    const duplicatedFallback = await runOverrideCase(
        "tw",
        {
            cn: { translation: { title: "足球教练" } },
            tw: { translation: { title: "足球教练" } },
        },
        nativeTwBody,
    );
    assert.equal(duplicatedFallback.payload.title, "泰德拉索：錯棚教練趣事多");

    const nativeTwOverride = await runOverrideCase(
        "tw",
        {
            cn: { translation: { title: "足球教练" } },
            tw: { translation: { title: "泰德拉索：錯棚教練趣事多" } },
        },
        nativeTwBody,
    );
    assert.equal(nativeTwOverride.payload.title, "泰德拉索：錯棚教練趣事多");

    const mixedFields = await runOverrideCase(
        "tw",
        {
            cn: { translation: { title: "足球教练", overview: "简体简介" } },
            tw: { translation: { title: "泰德拉索：錯棚教練趣事多", overview: "台灣原生簡介" } },
        },
        nativeTwBody,
    );
    assert.equal(mixedFields.payload.title, "泰德拉索：錯棚教練趣事多");
    assert.equal(mixedFields.payload.overview, "台灣原生簡介");

    const cnOverride = await runOverrideCase(
        "cn",
        {
            cn: { translation: { title: "足球教练" } },
        },
        nativeTwBody,
    );
    assert.equal(cnOverride.payload.title, "足球教练");

    const duplicatedHk = await runOverrideCase(
        "hk",
        {
            cn: { translation: { title: "软件" } },
            hk: { translation: { title: "软件" } },
        },
        JSON.stringify({
            ...JSON.parse(nativeTwBody),
            title: "香港原生標題",
        }),
    );
    assert.equal(duplicatedHk.payload.title, "香港原生標題");
});

test("tw 列表命中后端 cn 提示时，回写 payload 带上 cn 折叠数据", async () => {
    const cnEntry = { status: 1, translation: { title: "简体标题", overview: "简体简介" }, complete: true };
    const listBody = JSON.stringify(
        [123, 124, 125, 126].map((id) => ({
            watchers: 1,
            movie: {
                title: `Original ${id}`,
                overview: `Original overview ${id}`,
                ids: { trakt: id },
                available_translations: ["zh"],
            },
        })),
    );
    const { httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/movies/trending",
        body: listBody,
        argument: {
            chineseLocale: "tw",
            backendBaseUrl: TEST_BACKEND_BASE_URL,
        },
        persistentData: createUnifiedPersistentData(),
        httpGetMocks: {
            [`${TEST_BACKEND_TRANSLATIONS_URL}?movies=123,124,125,126&locale=tw`]: createHttpStatusMock(200, JSON.stringify({ movies: {}, cn: { movies: { 123: cnEntry } } })),
            // 上游只有 tw 翻译：回写里的 cn 只能来自后端提示
            "https://api.trakt.tv/movies/123/translations/zh?extended=all": createHttpStatusMock(
                200,
                JSON.stringify([{ language: "zh", country: "tw", title: "蜘蛛人：無家日", overview: "台灣簡介" }]),
            ),
            "https://api.trakt.tv/movies/124/translations/zh?extended=all": createHttpStatusMock(200, "[]"),
            "https://api.trakt.tv/movies/125/translations/zh?extended=all": createHttpStatusMock(200, "[]"),
            "https://api.trakt.tv/movies/126/translations/zh?extended=all": createHttpStatusMock(200, "[]"),
        },
        httpPostMocks: {
            [TEST_BACKEND_TRANSLATIONS_URL]: [createHttpStatusMock(200, "{}")],
        },
    });

    const backendPost = httpLogs.find((entry) => entry.method === "POST" && entry.url === TEST_BACKEND_TRANSLATIONS_URL);
    assert.ok(backendPost, "应回写后端缓存");
    const body = JSON.parse(backendPost.body);
    assert.equal(body.locale, "tw");
    assert.equal(body.cn.movies["123"].translation.title, "简体标题");
});

test("tw 命中后端图片 cn 提示时，回写 payload 带上 cn", async () => {
    const cnImageEntry = {
        poster: { status: 1, url: "https://image.tmdb.org/t/p/original/cn-poster.jpg", expiresAt: null },
    };
    const { httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body: createMovieBody(),
        argument: {
            chineseLocale: "tw",
            posterImageMode: "tw",
            backendBaseUrl: TEST_BACKEND_BASE_URL,
        },
        persistentData: createUnifiedPersistentData(),
        httpGetMocks: {
            [`${TEST_BACKEND_IMAGES_URL}?mode=chinese&movies=123&locale=tw`]: createHttpStatusMock(200, JSON.stringify({ movies: {}, cn: { movies: { 123: cnImageEntry } } })),
            [TEST_TMDB_MOVIE_IMAGES_URL]: createTmdbImagesResponse([
                {
                    iso_639_1: "zh",
                    iso_3166_1: "TW",
                    file_path: "/tw-poster.jpg",
                    vote_average: 5,
                    vote_count: 5,
                },
            ]),
        },
        httpPostMocks: {
            [TEST_BACKEND_IMAGES_URL]: [createHttpStatusMock(200, "{}")],
        },
    });

    const imagePost = httpLogs.find((entry) => entry.method === "POST" && entry.url === TEST_BACKEND_IMAGES_URL);
    assert.ok(imagePost, "应回写后端图片缓存");
    const body = JSON.parse(imagePost.body);
    assert.equal(body.locale, "tw");
    assert.equal(body.cn.chinese.movies["123"].poster.url, "https://image.tmdb.org/t/p/original/cn-poster.jpg");
});

test("tw 请求 /translations/zh 时派生的 cn 折叠数据按内容推导状态并标记 complete", async () => {
    const { httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/translations/zh?extended=all",
        body: createTranslationsBody(),
        argument: {
            chineseLocale: "tw",
            backendBaseUrl: TEST_BACKEND_BASE_URL,
        },
        persistentData: createUnifiedPersistentData(),
        httpPostMocks: {
            [TEST_BACKEND_TRANSLATIONS_URL]: [createHttpStatusMock(200, "{}")],
        },
    });

    const backendPost = httpLogs.find((entry) => entry.method === "POST" && entry.url === TEST_BACKEND_TRANSLATIONS_URL);
    assert.ok(backendPost);
    const body = JSON.parse(backendPost.body);
    assert.equal(body.cn.movies["123"].translation.title, "蜘蛛侠：英雄无归");
    assert.equal(body.cn.movies["123"].status, 1, "有 title 的 cn 折叠数据应为 FOUND");
    assert.equal(body.cn.movies["123"].complete, true);
});

test("默认海报档位（原片语言）下仍写回中文图片后端缓存", async () => {
    // 原片语言为 ja/JP：original 档位会真正发起图片抓取（language=en 时会被跳过）
    const jaMovieBody = JSON.stringify({
        ...JSON.parse(createMovieBody()),
        language: "ja",
        country: "JP",
    });
    const tmdbJaImagesUrl = `https://api.tmdb.org/3/movie/456/images?language=zh%2Cja&api_key=${TEST_TMDB_API_KEY}`;
    const { httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body: jaMovieBody,
        argument: {
            chineseLocale: "cn",
            posterImageMode: "original",
            backendBaseUrl: TEST_BACKEND_BASE_URL,
        },
        persistentData: createUnifiedPersistentData(),
        httpGetMocks: {
            [tmdbJaImagesUrl]: createTmdbImagesResponse([
                { iso_639_1: "zh", iso_3166_1: "CN", file_path: "/cn-poster.jpg", vote_average: 5, vote_count: 5 },
                { iso_639_1: "ja", iso_3166_1: "JP", file_path: "/ja-poster.jpg", vote_average: 5, vote_count: 5 },
            ]),
        },
        httpPostMocks: {
            [TEST_BACKEND_IMAGES_URL]: [createHttpStatusMock(200, "{}")],
        },
    });

    const imagePost = httpLogs.find((entry) => entry.method === "POST" && entry.url === TEST_BACKEND_IMAGES_URL);
    assert.ok(imagePost, "应写回后端图片缓存");
    const body = JSON.parse(imagePost.body);
    assert.ok(body.modes.chinese, "默认档位也应写入中文海报缓存");
    assert.ok(body.modes.original, "原片语言档位也应写入");
});

test("/translations/zh 在 tw 地区把覆盖写到 zh-TW 主条目", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/translations/zh?extended=all",
        body: JSON.stringify([
            { language: "zh", country: "cn", title: "简体标题", overview: "简体简介" },
            { language: "zh", country: "tw", title: "台灣標題", overview: "台灣簡介" },
        ]),
        argument: {
            chineseLocale: "tw",
            backendBaseUrl: TEST_BACKEND_BASE_URL,
        },
        persistentData: createUnifiedPersistentData(),
        httpGetMocks: {
            [`${TEST_BACKEND_BASE_URL}/api/trakt/translation-overrides`]: createHttpStatusMock(
                200,
                JSON.stringify({
                    movies: {
                        123: {
                            cn: { translation: { title: "大陆覆盖" } },
                            tw: { translation: { title: "台灣覆蓋" } },
                        },
                    },
                    shows: {},
                    episodes: {},
                }),
            ),
        },
    });

    const payload = JSON.parse(result.body);
    const twEntry = payload.find((item) => item.country === "tw");
    const cnEntry = payload.find((item) => item.country === "cn");
    assert.equal(twEntry.title, "台灣覆蓋", "tw 覆盖应落在 zh-TW 主条目");
    assert.notEqual(cnEntry.title, "台灣覆蓋", "cn 条目不应被写成繁体覆盖");
});

test("后端写回批次被截断时仍带上已写出条目的 cn 折叠数据", () => {
    const backendState = createBackendState({ [MEDIA_TYPE.MOVIE]: {} });
    backendState.pendingBackendWrites[MEDIA_TYPE.MOVIE] = {
        123: { status: 2, translation: { title: "简体标题" } },
        456: { status: 2, translation: { title: "简体标题二" } },
    };
    backendState.pendingCnWrites[MEDIA_TYPE.MOVIE] = {
        123: { status: 1, translation: { title: "简体标题" } },
    };

    const payload = extractBackendWritePayload(backendState, 1);

    assert.deepEqual(Object.keys(payload.movies), ["123"], "只应写出批次内的条目");
    assert.deepEqual(payload.cn, { movies: { 123: { status: 1, translation: { title: "简体标题" } } } }, "截断时不能丢 cn 折叠数据");
    assert.deepEqual(Object.keys(backendState.pendingBackendWrites[MEDIA_TYPE.MOVIE]), ["456"], "未写出的条目应留在队列");
    assert.deepEqual(Object.keys(backendState.pendingCnWrites[MEDIA_TYPE.MOVIE]), [], "已写出条目的 cn 提示应被消费");
});
