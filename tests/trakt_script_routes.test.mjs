import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
    TRAKT_TAMPER_ACCESS_TOKEN_TTL_MS,
    TRAKT_TAMPER_CLIENT_ID,
    TRAKT_TAMPER_EXEMPT_CLIENT_IDS,
    TRAKT_TAMPER_REDIRECT_URI,
    TRAKT_TAMPER_STATE_RECORD_LIMIT,
    TRAKT_TAMPER_TOKEN_RECORD_LIMIT,
} from "../trakt_simplified_chinese/src/features/tamper-app-authorization.mjs";
import { createResponsePhaseRoutes } from "../trakt_simplified_chinese/src/response.mjs";
import { REGION_CODES } from "../trakt_simplified_chinese/src/shared/player-definitions.mjs";
import { TRAKT_DIRECT_TRANSLATION_MAX_REFS } from "../trakt_simplified_chinese/src/shared/trakt-translation-helper.mjs";
import { TAMPER_AUTHORIZATION_KEY, UNIFIED_CACHE_KEY } from "../trakt_simplified_chinese/src/utils/cache.mjs";
import { generatePkcePair } from "../trakt_simplified_chinese/src/utils/pkce.mjs";

import {
    computeStringHash,
    createCommentTranslationCache,
    createListTranslationCache,
    createMediaTranslationEntry,
    createMovieTranslationCache,
    createPeopleTranslationCache,
    createSentimentTranslationCache,
    createUnifiedPersistentData,
    createWrappedMovieBody,
    parseTamperAuthorization,
    readFixture,
    runRequestCase,
    runResponseCase,
} from "./helpers/trakt-test-helpers.mjs";

// 授权流程状态、篡改签发的 token 与待回写标记落在独立持久化 key 里，不再占用 unified cache
function readTamperStore(persistentData) {
    const store = parseTamperAuthorization(persistentData);
    return {
        records: store.records.slice(),
        tokens: store.tokens.slice(),
        pending: store.pending.slice(),
    };
}

function readTamperRecords(persistentData) {
    return readTamperStore(persistentData)
        .records.slice()
        .sort((left, right) => Number(left.createdAt) - Number(right.createdAt));
}

function readTamperStates(persistentData) {
    return readTamperRecords(persistentData);
}

function readTamperTokens(persistentData) {
    return readTamperStore(persistentData)
        .tokens.slice()
        .sort((left, right) => Number(left.createdAt) - Number(right.createdAt));
}

function createTamperPersistentData({ records = [], tokens = [], pending = [] } = {}) {
    return createUnifiedPersistentData({ tamperAuthorization: { records, tokens, pending } });
}

function createTamperTokenRecord(accessToken, refreshToken, overrides = {}) {
    return {
        accessToken,
        refreshToken,
        clientId: "old-client",
        expiresAt: Date.now() + 60 * 60 * 1000,
        createdAt: Date.now(),
        ...overrides,
    };
}

function readLatestTamperState(persistentData) {
    const states = readTamperStates(persistentData);
    return states[states.length - 1];
}

function createTamperCallbackUrl(targetUrl, code = "auth-code", host = "auth.trakt.tv") {
    const callbackUrl = new URL(`https://${host}/api/auth/oauth2/authorize`);
    callbackUrl.searchParams.set("response_type", "code");
    callbackUrl.searchParams.set("redirect_uri", TRAKT_TAMPER_REDIRECT_URI);
    callbackUrl.searchParams.set("state", targetUrl.searchParams.get("state") ?? "");
    callbackUrl.searchParams.set("code_challenge", targetUrl.searchParams.get("code_challenge") ?? "");
    callbackUrl.searchParams.set("code", code);
    return callbackUrl.toString();
}

function createTamperStateRecord(index, overrides = {}) {
    return {
        id: `existing-id-${index}`,
        redirectUri: `existing://callback/${index}`,
        originalState: `existing-state-${index}`,
        codeVerifier: `existing-verifier-${index}`,
        codeChallenge: `existing-challenge-${index}`,
        createdAt: Date.now(),
        ...overrides,
    };
}

function createMoviePersistentData() {
    return createUnifiedPersistentData({
        traktTranslation: JSON.parse(createMovieTranslationCache()),
    });
}

function createShowPersistentData() {
    return createUnifiedPersistentData({
        traktTranslation: {
            "translation:shows:456:cn": createMediaTranslationEntry({
                translation: {
                    title: "中文剧名",
                    overview: "中文剧集简介",
                    tagline: "中文剧集标语",
                },
            }),
        },
    });
}

function createMixedDirectMediaPersistentData() {
    return createUnifiedPersistentData({
        traktTranslation: {
            "translation:movies:123:cn": createMediaTranslationEntry({
                translation: {
                    title: "中文电影",
                    overview: "中文电影简介",
                    tagline: "中文电影标语",
                },
            }),
            "translation:shows:456:cn": createMediaTranslationEntry({
                translation: {
                    title: "中文剧名",
                    overview: "中文剧集简介",
                    tagline: "中文剧集标语",
                },
            }),
        },
    });
}

function createEpisodePersistentData() {
    return createUnifiedPersistentData({
        traktTranslation: {
            "translation:episodes:555:1:1:cn": createMediaTranslationEntry({
                translation: {
                    title: "第一集中文",
                    overview: "第一集中文简介",
                    tagline: "第一集中文标语",
                },
            }),
            "translation:episodes:555:1:2:cn": createMediaTranslationEntry({
                translation: {
                    title: "第二集中文",
                    overview: "第二集中文简介",
                    tagline: "第二集中文标语",
                },
            }),
            "translation:episodes:777:2:1:cn": createMediaTranslationEntry({
                translation: {
                    title: "其他剧中文",
                    overview: "其他剧中文简介",
                    tagline: "其他剧中文标语",
                },
            }),
        },
    });
}

function createResponseRouteStubs() {
    return createResponsePhaseRoutes();
}

function createTraktZhTranslationBody(overrides = {}) {
    return JSON.stringify([
        {
            language: "zh",
            country: "cn",
            title: "Trakt 标题",
            overview: "Trakt 简介",
            tagline: "Trakt 标语",
            ...overrides,
        },
    ]);
}

function createBackendTranslationOverridesBody(fieldName, lookupKey, entry) {
    return JSON.stringify({
        shows: {},
        movies: {},
        episodes: {},
        [fieldName]: {
            [lookupKey]: entry,
        },
    });
}

// 覆盖条目按地区存放：cn/tw/hk 各一份 translation
function createTranslationOverrideEntry(translation) {
    return {
        cn: { translation },
        updatedAt: 1710000000000,
    };
}

function createDirectMovieBody() {
    return readFixture("recommendations-movies.json");
}

function createDirectShowBody() {
    return JSON.stringify([
        {
            title: "Original Show Title",
            overview: "Original Show Overview",
            first_aired: "2025-01-01T00:00:00.000Z",
            network: "HBO",
            tagline: "Original Show Tagline",
            ids: {
                trakt: 456,
            },
        },
    ]);
}

function createMixedMovieBody(extra = {}) {
    return JSON.stringify([
        {
            type: "movie",
            movie: JSON.parse(readFixture("recommendations-movies.json"))[0],
            ...extra,
        },
    ]);
}

function createUpNextBody() {
    return JSON.stringify([
        {
            show: {
                title: "Original Show Title",
                overview: "Original Show Overview",
                first_aired: "2025-01-01T00:00:00.000Z",
                network: "HBO",
                tagline: "Original Show Tagline",
                ids: {
                    trakt: 555,
                },
            },
            progress: {
                next_episode: {
                    season: 1,
                    number: 2,
                    title: "Original Episode Title",
                    overview: "Original Episode Overview",
                    ids: {
                        trakt: 1001,
                    },
                },
            },
        },
    ]);
}

function createWatchingEpisodeBody() {
    return JSON.stringify({
        started_at: "2026-05-14T10:00:00.000Z",
        action: "scrobble",
        type: "episode",
        show: {
            title: "Original Show Title",
            overview: "Original Show Overview",
            first_aired: "2025-01-01T00:00:00.000Z",
            network: "HBO",
            tagline: "Original Show Tagline",
            ids: {
                trakt: 555,
            },
        },
        episode: {
            season: 1,
            number: 2,
            title: "Original Episode Title",
            overview: "Original Episode Overview",
            ids: {
                trakt: 1001,
            },
        },
    });
}

function createWatchingMovieBody() {
    return JSON.stringify({
        started_at: "2026-05-14T10:00:00.000Z",
        action: "scrobble",
        type: "movie",
        movie: JSON.parse(readFixture("recommendations-movies.json"))[0],
    });
}

function createListWrapperBody() {
    return JSON.stringify([
        {
            type: "list",
            list: JSON.parse(readFixture("list-descriptions.json"))[0],
        },
    ]);
}

function createCalendarMediaBody() {
    return JSON.stringify([
        {
            first_aired: "2026-09-13T00:00:00.000Z",
            released: null,
            show: {
                title: "Original Show Title",
                overview: "Original Show Overview",
                first_aired: "2025-01-01T00:00:00.000Z",
                network: "HBO",
                tagline: "Original Show Tagline",
                ids: {
                    trakt: 456,
                },
            },
            episode: {
                season: 1,
                number: 2,
                title: "Original Episode Title",
                overview: "Original Episode Overview",
                ids: {
                    trakt: 1001,
                },
            },
        },
        {
            released: "2026-09-13",
            movie: JSON.parse(readFixture("recommendations-movies.json"))[0],
        },
    ]);
}

function createCalendarPersistentData() {
    return createUnifiedPersistentData({
        traktTranslation: {
            ...JSON.parse(createMovieTranslationCache()),
            "translation:shows:456:cn": createMediaTranslationEntry({
                translation: {
                    title: "中文剧名",
                    overview: "中文剧集简介",
                    tagline: "中文剧集标语",
                },
            }),
            "translation:episodes:456:1:2:cn": createMediaTranslationEntry({
                translation: {
                    title: "第二集中文",
                    overview: "第二集中文简介",
                    tagline: "第二集中文标语",
                },
            }),
        },
    });
}

function createProminentListBody() {
    return JSON.stringify([
        {
            like_count: 12,
            comment_count: 3,
            list: JSON.parse(readFixture("list-descriptions.json"))[0],
        },
    ]);
}

function createEpisodeCommentPersistentData() {
    return createUnifiedPersistentData({
        googleComments: JSON.parse(createCommentTranslationCache()),
    });
}

function createTmdbDetailBody(results) {
    return JSON.stringify({
        id: 108978,
        name: "Reacher",
        "watch/providers": {
            results,
        },
    });
}

test("TMDB tv 详情只保留注入播放器并清除原有观看来源", async () => {
    const { result } = await runResponseCase({
        url: "https://api.themoviedb.org/3/tv/108978?api_key=x&append_to_response=watch/providers",
        body: createTmdbDetailBody({
            AD: {
                link: "https://www.themoviedb.org/tv/108978-reacher/watch?locale=AD",
                flatrate: [{ logo_path: "/prime.jpg", provider_id: 119, provider_name: "Amazon Prime Video", display_priority: 1 }],
            },
            US: {
                link: "https://www.themoviedb.org/tv/108978-reacher/watch?locale=US",
                buy: [{ logo_path: "/apple.jpg", provider_id: 350, provider_name: "Apple TV", display_priority: 2 }],
                ads: [{ logo_path: "/tubi.jpg", provider_id: 478, provider_name: "Tubi", display_priority: 3 }],
            },
        }),
        headers: {
            "user-agent": "Sofa Time/1.0",
        },
    });

    const payload = JSON.parse(result.body);
    const ad = payload["watch/providers"].results.AD;
    assert.equal(ad.link, "https://fwds.cc/tmdb?type=tv&id=108978");
    assert.equal(ad.flatrate.length, 1);
    assert.equal(ad.flatrate[0].provider_id, 2);
    assert.equal(ad.flatrate[0].provider_name, "Forward");
    assert.equal(ad.flatrate[0].display_priority, 1);

    const us = payload["watch/providers"].results.US;
    assert.equal(us.link, "https://fwds.cc/tmdb?type=tv&id=108978");
    assert.equal(us.flatrate.length, 1);
    assert.equal(us.flatrate[0].provider_id, 2);
    assert.equal(us.buy, undefined);
    assert.equal(us.ads, undefined);
});

test("TMDB movie 详情会注入 type=movie 的 deeplink", async () => {
    const { result } = await runResponseCase({
        url: "https://api.themoviedb.org/3/movie/550?api_key=x&append_to_response=watch/providers",
        body: createTmdbDetailBody({
            US: {
                link: "https://www.themoviedb.org/movie/550-fight-club/watch?locale=US",
            },
        }),
        headers: {
            "user-agent": "Sofa Time/1.0",
        },
    });

    const payload = JSON.parse(result.body);
    const us = payload["watch/providers"].results.US;
    assert.equal(us.link, "https://fwds.cc/tmdb?type=movie&id=550");
    assert.equal(us.flatrate[0].provider_id, 2);
});

test("TMDB 详情在自定义序号下只注入排序 1 的播放器", async () => {
    const { result } = await runResponseCase({
        url: "https://api.themoviedb.org/3/tv/108978?api_key=x&append_to_response=watch/providers",
        body: createTmdbDetailBody({ US: { link: "https://www.themoviedb.org/tv/108978/watch?locale=US" } }),
        headers: {
            "user-agent": "Sofa Time/1.0",
        },
        argument: {
            forwardButtonOrder: 3,
            infuseButtonOrder: 1,
            rexButtonOrder: 2,
        },
    });

    const payload = JSON.parse(result.body);
    const us = payload["watch/providers"].results.US;
    assert.equal(us.link, "infuse://series/108978");
    assert.equal(us.flatrate.length, 1);
    assert.equal(us.flatrate[0].provider_id, 3);
    assert.equal(us.flatrate[0].provider_name, "Infuse");
});

test("TMDB 详情在部分序号为 0 时只注入序号非 0 的最前播放器", async () => {
    const { result } = await runResponseCase({
        url: "https://api.themoviedb.org/3/tv/108978?api_key=x&append_to_response=watch/providers",
        body: createTmdbDetailBody({ US: { link: "https://www.themoviedb.org/tv/108978/watch?locale=US" } }),
        headers: {
            "user-agent": "Sofa Time/1.0",
        },
        argument: {
            forwardButtonOrder: 1,
            infuseButtonOrder: 2,
        },
    });

    const payload = JSON.parse(result.body);
    const us = payload["watch/providers"].results.US;
    assert.equal(us.flatrate[0].provider_id, 2);
    assert.equal(us.flatrate[0].provider_name, "Forward");
});

test("TMDB 详情在全部序号为 0 时不注入任何播放器", async () => {
    const { result } = await runResponseCase({
        url: "https://api.themoviedb.org/3/tv/108978?api_key=x&append_to_response=watch/providers",
        body: createTmdbDetailBody({ US: { link: "https://www.themoviedb.org/tv/108978/watch?locale=US" } }),
        headers: {
            "user-agent": "Sofa Time/1.0",
        },
        argument: {
            forwardButtonOrder: 0,
            infuseButtonOrder: 0,
            rexButtonOrder: 0,
        },
    });

    assert.equal(Object.keys(result).length, 0);
});

test("TMDB 详情在 results 为空时为全部 REGION_CODES 注入", async () => {
    const { result } = await runResponseCase({
        url: "https://api.themoviedb.org/3/tv/108978?api_key=x&append_to_response=watch/providers",
        body: createTmdbDetailBody({}),
        headers: {
            "user-agent": "Sofa Time/1.0",
        },
    });

    const payload = JSON.parse(result.body);
    const results = payload["watch/providers"].results;
    assert.equal(Object.keys(results).length, REGION_CODES.length);
    REGION_CODES.forEach((regionCode) => {
        assert.equal(results[regionCode].link, "https://fwds.cc/tmdb?type=tv&id=108978", `region ${regionCode} link`);
        assert.equal(results[regionCode].flatrate.length, 1, `region ${regionCode} flatrate`);
    });
});

test("TMDB 详情对非 SofaTime 请求直接透传", async () => {
    const { result } = await runResponseCase({
        url: "https://api.themoviedb.org/3/tv/108978?api_key=x&append_to_response=watch/providers",
        body: createTmdbDetailBody({ US: { link: "https://www.themoviedb.org/tv/108978/watch?locale=US" } }),
    });

    assert.equal(Object.keys(result).length, 0);
});

test("TMDB 详情 append_to_response 不含 watch/providers 时透传", async () => {
    const { result } = await runResponseCase({
        url: "https://api.themoviedb.org/3/tv/108978?api_key=x&append_to_response=videos",
        body: createTmdbDetailBody({ US: { link: "https://www.themoviedb.org/tv/108978/watch?locale=US" } }),
        headers: {
            "user-agent": "Sofa Time/1.0",
        },
    });

    assert.equal(Object.keys(result).length, 0);
});

test("TMDB 详情 body 无 watch/providers 字段时透传", async () => {
    const { result } = await runResponseCase({
        url: "https://api.themoviedb.org/3/tv/108978?api_key=x&append_to_response=watch/providers",
        body: JSON.stringify({ id: 108978, name: "Reacher" }),
        headers: {
            "user-agent": "Sofa Time/1.0",
        },
    });

    assert.equal(Object.keys(result).length, 0);
});

test("TMDB 详情 flatrate 已有旧自定义条目时也会整体清除只留注入播放器", async () => {
    const { result } = await runResponseCase({
        url: "https://api.themoviedb.org/3/tv/108978?api_key=x&append_to_response=watch/providers",
        body: createTmdbDetailBody({
            US: {
                link: "https://fwds.cc/tmdb?type=tv&id=108978",
                flatrate: [
                    { logo_path: "/infuse_logo.webp", provider_id: 3, provider_name: "Infuse", display_priority: 1 },
                    { logo_path: "/prime.jpg", provider_id: 119, provider_name: "Amazon Prime Video", display_priority: 2 },
                ],
            },
        }),
        headers: {
            "user-agent": "Sofa Time/1.0",
        },
    });

    const payload = JSON.parse(result.body);
    const us = payload["watch/providers"].results.US;
    assert.equal(us.flatrate.length, 1);
    assert.equal(us.flatrate[0].provider_id, 2);
});

test("TMDb provider catalog 会注入自定义 provider", async () => {
    const { result } = await runResponseCase({
        url: "https://api.themoviedb.org/3/watch/providers/movie",
        body: readFixture("tmdb-provider-catalog.json"),
        headers: {
            "user-agent": "Sofa Time/1.0",
        },
    });

    const payload = JSON.parse(result.body);
    assert.deepEqual(
        payload.results.slice(0, 3).map((item) => item.provider_id),
        [2, 3, 4],
    );
    assert.ok(payload.results.some((item) => item.provider_id === 8));
    assert.equal(payload.results.filter((item) => item.provider_id === 2).length, 1);
});

test("TMDb provider catalog 在自定义序号下会按序号升序重排自定义 provider", async () => {
    const { result } = await runResponseCase({
        url: "https://api.themoviedb.org/3/watch/providers/movie",
        body: readFixture("tmdb-provider-catalog.json"),
        headers: {
            "user-agent": "Sofa Time/1.0",
        },
        argument: {
            forwardButtonOrder: 3,
            infuseButtonOrder: 1,
            rexButtonOrder: 2,
        },
    });

    const payload = JSON.parse(result.body);
    assert.deepEqual(
        payload.results.slice(0, 3).map((item) => item.provider_id),
        [3, 4, 2],
    );
});

test("TMDb provider catalog 在全部序号为 0 时仍保留全部自定义 provider（按声明顺序）", async () => {
    const { result } = await runResponseCase({
        url: "https://api.themoviedb.org/3/watch/providers/movie",
        body: readFixture("tmdb-provider-catalog.json"),
        headers: {
            "user-agent": "Sofa Time/1.0",
        },
        argument: {
            forwardButtonOrder: 0,
            infuseButtonOrder: 0,
            rexButtonOrder: 0,
        },
    });

    const payload = JSON.parse(result.body);
    assert.deepEqual(
        payload.results.slice(0, 3).map((item) => item.provider_id),
        [2, 3, 4],
    );
});

test("handleList 按 direct list、wrapped list 与 prominent list 路由分组生效", async (t) => {
    const persistentData = createUnifiedPersistentData({
        googleList: JSON.parse(
            createListTranslationCache({
                "list:translation:321:cn": {
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
        ),
    });

    const cases = [
        {
            name: "media lists direct array",
            url: "https://api.trakt.tv/movies/123/lists/popular",
            body: readFixture("list-descriptions.json"),
        },
        {
            name: "users likes lists wrapped array",
            url: "https://api.trakt.tv/users/me/likes/lists",
            body: createListWrapperBody(),
        },
        {
            name: "users lists collaborations direct array",
            url: "https://api.trakt.tv/users/me/lists/collaborations",
            body: readFixture("list-descriptions.json"),
        },
        {
            name: "search list wrapped array",
            url: "https://api.trakt.tv/search/list?query=test",
            body: createListWrapperBody(),
        },
        {
            name: "lists popular prominent wrapper array",
            url: "https://api.trakt.tv/lists/popular",
            body: createProminentListBody(),
        },
    ];

    for (const item of cases) {
        await t.test(item.name, async () => {
            const { result } = await runResponseCase({
                url: item.url,
                body: item.body,
                persistentData,
            });

            const payload = JSON.parse(result.body);
            const target = payload[0].list ?? payload[0];
            assert.equal(target.name, "收藏夹");
            assert.equal(target.description, "一个不错的列表");
        });
    }
});

test("handleDirectMediaList 按 direct summary 路由分组生效", async (t) => {
    const cases = [
        {
            name: "typed recommendations direct movie summary",
            url: "https://api.trakt.tv/recommendations/movies",
            body: createDirectMovieBody(),
            persistentData: createMoviePersistentData(),
            assertPayload(payload) {
                assert.equal(payload[0].title, "中文电影");
            },
        },
        {
            name: "typed popular direct show summary",
            url: "https://api.trakt.tv/shows/popular",
            body: createDirectShowBody(),
            persistentData: createShowPersistentData(),
            assertPayload(payload) {
                assert.equal(payload[0].title, "中文剧名");
            },
        },
        {
            name: "apiz related direct movie summary",
            url: "https://apiz.trakt.tv/movies/531178/related?extended=cloud9,full",
            body: createDirectMovieBody(),
            persistentData: createMoviePersistentData(),
            assertPayload(payload) {
                assert.equal(payload[0].title, "中文电影");
                assert.equal(payload[0].overview, "中文简介");
            },
        },
        {
            name: "apiz related direct show summary",
            url: "https://apiz.trakt.tv/shows/531178/related?extended=cloud9,full",
            body: createDirectShowBody(),
            persistentData: createShowPersistentData(),
            assertPayload(payload) {
                assert.equal(payload[0].title, "中文剧名");
                assert.equal(payload[0].overview, "中文剧集简介");
            },
        },
        {
            name: "mixed direct media summary",
            url: "https://api.trakt.tv/media/popular",
            body: JSON.stringify([JSON.parse(createDirectMovieBody())[0], JSON.parse(createDirectShowBody())[0]]),
            persistentData: createMixedDirectMediaPersistentData(),
            assertPayload(payload) {
                assert.equal(payload[0].title, "中文电影");
                assert.equal(payload[1].title, "中文剧名");
            },
        },
        {
            name: "mixed direct media summary with unknown item",
            url: "https://api.trakt.tv/media/popular",
            body: JSON.stringify([
                JSON.parse(createDirectMovieBody())[0],
                {
                    title: "Unknown Media",
                    ids: {
                        trakt: 999,
                    },
                },
                JSON.parse(createDirectShowBody())[0],
            ]),
            persistentData: createMixedDirectMediaPersistentData(),
            assertPayload(payload) {
                assert.equal(payload[0].title, "中文电影");
                assert.equal(payload[1].title, "Unknown Media");
                assert.equal(payload[2].title, "中文剧名");
            },
        },
        {
            name: "mixed popular wrapper show summary",
            url: "https://api.trakt.tv/media/popular/next",
            body: JSON.stringify([
                {
                    show: {
                        title: "Original Show Title",
                        overview: "Original Show Overview",
                        first_aired: "2025-01-01T00:00:00.000Z",
                        network: "HBO",
                        tagline: "Original Show Tagline",
                        ids: {
                            trakt: 456,
                        },
                    },
                },
            ]),
            persistentData: createShowPersistentData(),
            assertPayload(payload) {
                assert.equal(payload[0].show.title, "中文剧名");
            },
        },
        {
            name: "boxoffice direct movie summary",
            url: "https://api.trakt.tv/movies/boxoffice",
            body: createDirectMovieBody(),
            persistentData: createMoviePersistentData(),
            assertPayload(payload) {
                assert.equal(payload[0].title, "中文电影");
            },
        },
    ];

    for (const item of cases) {
        await t.test(item.name, async () => {
            const { result } = await runResponseCase({
                url: item.url,
                body: item.body,
                persistentData: item.persistentData,
            });

            item.assertPayload(JSON.parse(result.body));
        });
    }
});

test("handleDirectMediaList 与 handleWrapperMediaList 会叠加 translationOverrides", async (t) => {
    await t.test("direct popular 会覆盖 show 标题", async () => {
        const { result } = await runResponseCase({
            url: "https://api.trakt.tv/shows/popular",
            body: createDirectShowBody(),
            persistentData: createShowPersistentData(),
            argument: {
                backendBaseUrl: "https://backend.example",
            },
            httpGetMocks: {
                "https://backend.example/api/trakt/translation-overrides": createBackendTranslationOverridesBody(
                    "shows",
                    "456",
                    createTranslationOverrideEntry({ title: "热门榜覆盖剧名" }),
                ),
            },
        });

        const payload = JSON.parse(result.body);
        assert.equal(payload[0].title, "热门榜覆盖剧名");
        assert.equal(payload[0].overview, "中文剧集简介");
    });

    await t.test("wrapper up_next_nitro 会覆盖 next episode 标题", async () => {
        const { result } = await runResponseCase({
            url: "https://api.trakt.tv/sync/progress/up_next_nitro",
            body: createUpNextBody(),
            persistentData: createEpisodePersistentData(),
            argument: {
                backendBaseUrl: "https://backend.example",
            },
            httpGetMocks: {
                "https://backend.example/api/trakt/translation-overrides": createBackendTranslationOverridesBody(
                    "episodes",
                    "555:1:2",
                    createTranslationOverrideEntry({ title: "即将播放覆盖标题" }),
                ),
            },
        });

        const payload = JSON.parse(result.body);
        assert.equal(payload[0].progress.next_episode.title, "即将播放覆盖标题");
        assert.equal(payload[0].progress.next_episode.overview, "第二集中文简介");
    });
});

test("handleWrapperMediaList 按 wrapper 路由分组生效", async (t) => {
    const cases = [
        {
            name: "typed trending wrapper array",
            url: "https://api.trakt.tv/movies/trending",
            body: createWrappedMovieBody(),
            persistentData: createMoviePersistentData(),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "中文电影");
            },
        },
        {
            name: "mixed trending wrapper array",
            url: "https://api.trakt.tv/media/trending",
            body: createMixedMovieBody({ watchers: 9 }),
            persistentData: createMoviePersistentData(),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "中文电影");
                assert.equal(payload[0].watchers, 9);
            },
        },
        {
            name: "typed anticipated stats wrapper",
            url: "https://api.trakt.tv/movies/anticipated",
            body: createMixedMovieBody({ list_count: 99 }),
            persistentData: createMoviePersistentData(),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "中文电影");
                assert.equal(payload[0].list_count, 99);
            },
        },
        {
            name: "mixed recommendations wrapper",
            url: "https://api.trakt.tv/media/recommendations",
            body: createMixedMovieBody(),
            persistentData: createMoviePersistentData(),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "中文电影");
            },
        },
        {
            name: "mixed search wrapper route",
            url: "https://apiz.trakt.tv/search/movie,show?extended=cloud9,full&limit=100&page=1&query=%E5%AE%B6%E5%BC%91%E6%9C%8D%E5%8A%A1",
            body: createMixedMovieBody(),
            persistentData: createMoviePersistentData(),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "中文电影");
            },
        },
        {
            name: "mixed exact search wrapper route",
            url: "https://apiz.trakt.tv/search/movie,show/exact?extended=cloud9,full&limit=100&page=1&query=%E5%AE%B6%E5%BC%91%E6%9C%8D%E5%8A%A1",
            body: createMixedMovieBody(),
            persistentData: createMoviePersistentData(),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "中文电影");
            },
        },
        {
            name: "mixed reordered search wrapper route",
            url: "https://apiz.trakt.tv/search/show,movie?extended=cloud9,full&limit=100&page=1&query=%E5%AE%B6%E5%BC%91%E6%9C%8D%E5%8A%A1",
            body: createMixedMovieBody(),
            persistentData: createMoviePersistentData(),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "中文电影");
            },
        },
        {
            name: "recent by id search wrapper route",
            url: "https://apiz.trakt.tv/search/recent_by_id/global/movies,shows?extended=cloud9,full,images&limit=50",
            body: createMixedMovieBody(),
            persistentData: createMoviePersistentData(),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "中文电影");
            },
        },
        {
            name: "watchlist mixed route",
            url: "https://api.trakt.tv/users/me/watchlist/movie,show/rank",
            body: createMixedMovieBody(),
            persistentData: createMoviePersistentData(),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "中文电影");
            },
        },
        {
            name: "watchlist typed released route",
            url: "https://api.trakt.tv/users/me/watchlist/movies/released/desc",
            body: createWrappedMovieBody(),
            persistentData: createMoviePersistentData(),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "中文电影");
            },
        },
        {
            name: "users hidden dropped route",
            url: "https://apiz.trakt.tv/users/hidden/dropped?extended=full,images&limit=15&page=1",
            body: JSON.stringify([
                {
                    hidden_at: "2026-05-01T00:00:00.000Z",
                    type: "show",
                    section: "dropped",
                    show: {
                        title: "Original Show Title",
                        overview: "Original Show Overview",
                        first_aired: "2025-01-01T00:00:00.000Z",
                        network: "HBO",
                        tagline: "Original Show Tagline",
                        ids: {
                            trakt: 456,
                        },
                    },
                },
            ]),
            persistentData: createShowPersistentData(),
            assertPayload(payload) {
                assert.equal(payload[0].show.title, "中文剧名");
                assert.equal(payload[0].section, "dropped");
            },
        },
        {
            name: "favorites mixed route",
            url: "https://api.trakt.tv/users/me/favorites/media/rank",
            body: createMixedMovieBody(),
            persistentData: createMoviePersistentData(),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "中文电影");
            },
        },
        {
            name: "collection mixed route",
            url: "https://api.trakt.tv/users/me/collection/media",
            body: createMixedMovieBody(),
            persistentData: createMoviePersistentData(),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "中文电影");
            },
        },
        {
            name: "sync history typed route",
            url: "https://api.trakt.tv/sync/history/movies",
            body: createWrappedMovieBody(),
            persistentData: createMoviePersistentData(),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "中文电影");
            },
        },
        {
            name: "users history shows route",
            url: "https://api.trakt.tv/users/me/history/shows?extended=full&limit=50&page=2",
            body: JSON.stringify([
                {
                    show: {
                        title: "Original Show Title",
                        overview: "Original Show Overview",
                        first_aired: "2025-01-01T00:00:00.000Z",
                        network: "HBO",
                        tagline: "Original Show Tagline",
                        ids: {
                            trakt: 456,
                        },
                    },
                },
            ]),
            persistentData: createShowPersistentData(),
            assertPayload(payload) {
                assert.equal(payload[0].show.title, "中文剧名");
                assert.equal(payload[0].show.overview, "中文剧集简介");
            },
        },
        {
            name: "list items mixed route",
            url: "https://api.trakt.tv/lists/321/items/movie,show",
            body: createMixedMovieBody(),
            persistentData: createMoviePersistentData(),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "中文电影");
            },
        },
        {
            name: "users list items all route",
            url: "https://api.trakt.tv/users/me/lists/321/items/movie,show,season,episode",
            body: createMixedMovieBody(),
            persistentData: createMoviePersistentData(),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "中文电影");
            },
        },
        {
            name: "list items all route with alternate order",
            url: "https://api.trakt.tv/lists/321/items/movie,show,episode,season",
            body: createMixedMovieBody(),
            persistentData: createMoviePersistentData(),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "中文电影");
            },
        },
        {
            name: "smart list items all route",
            url: "https://apiz.trakt.tv/smart-lists/list-2511e1626ebd8469/items?extended=colors,full,images&limit=100&page=1",
            body: createMixedMovieBody({ rank: 1 }),
            persistentData: createMoviePersistentData(),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "中文电影");
                assert.equal(payload[0].movie.overview, "中文简介");
                assert.equal(payload[0].rank, 1);
            },
        },
        {
            name: "users ratings typed route",
            url: "https://api.trakt.tv/users/me/ratings/movies",
            body: createWrappedMovieBody(),
            persistentData: createMoviePersistentData(),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "中文电影");
            },
        },
        {
            name: "up-next wrapper route",
            url: "https://api.trakt.tv/sync/progress/up_next_nitro",
            body: createUpNextBody(),
            persistentData: createEpisodePersistentData(),
            assertPayload(payload) {
                assert.equal(payload[0].progress.next_episode.title, "第二集中文");
            },
        },
        {
            name: "my media calendar mixed route",
            url: "https://apiz.trakt.tv/calendars/my/media/2026-09-13/9?extended=full",
            body: createCalendarMediaBody(),
            persistentData: createCalendarPersistentData(),
            assertPayload(payload) {
                assert.equal(payload[0].show.title, "中文剧名");
                assert.equal(payload[0].episode.title, "第二集中文");
                assert.equal(payload[0].first_aired, "2026-09-13T00:00:00.000Z");
                assert.equal(payload[1].movie.title, "中文电影");
                assert.equal(payload[1].released, "2026-09-13");
            },
        },
        {
            name: "releases hot calendar mixed route",
            url: "https://apiz.trakt.tv/calendars/releases/hot/2026-09-13/7?extended=full,images",
            body: createCalendarMediaBody(),
            persistentData: createCalendarPersistentData(),
            assertPayload(payload) {
                assert.equal(payload[0].episode.title, "第二集中文");
                assert.equal(payload[1].movie.title, "中文电影");
            },
        },
        {
            name: "playback wrapper route",
            url: "https://api.trakt.tv/sync/playback/movies",
            body: createWrappedMovieBody(),
            persistentData: createMoviePersistentData(),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "中文电影");
            },
        },
    ];

    for (const item of cases) {
        await t.test(item.name, async () => {
            const { result } = await runResponseCase({
                url: item.url,
                body: item.body,
                persistentData: item.persistentData,
            });

            item.assertPayload(JSON.parse(result.body));
        });
    }
});

test("handleWrapperMediaObject 覆盖 watching 单对象响应", async (t) => {
    const cases = [
        {
            name: "watching episode object",
            body: createWatchingEpisodeBody(),
            persistentData: createUnifiedPersistentData({
                traktTranslation: {
                    "translation:shows:555:cn": createMediaTranslationEntry({
                        translation: {
                            title: "中文剧名",
                            overview: "中文剧集简介",
                            tagline: "中文剧集标语",
                        },
                    }),
                    "translation:episodes:555:1:2:cn": createMediaTranslationEntry({
                        translation: {
                            title: "第二集中文",
                            overview: "第二集中文简介",
                            tagline: "第二集中文标语",
                        },
                    }),
                },
            }),
            assertPayload(payload) {
                assert.equal(payload.show.title, "中文剧名");
                assert.equal(payload.episode.title, "第二集中文");
            },
        },
        {
            name: "watching movie object",
            body: createWatchingMovieBody(),
            persistentData: createMoviePersistentData(),
            assertPayload(payload) {
                assert.equal(payload.movie.title, "中文电影");
                assert.equal(payload.movie.overview, "中文简介");
            },
        },
    ];

    for (const item of cases) {
        await t.test(item.name, async () => {
            const { result } = await runResponseCase({
                url: "https://apiz.trakt.tv/users/me/watching?extended=cloud9,full",
                body: item.body,
                persistentData: item.persistentData,
            });

            item.assertPayload(JSON.parse(result.body));
        });
    }
});

test("handleMergedHistoryEpisodeList 覆盖 users 与 sync episode history 路由", async (t) => {
    const cases = ["https://api.trakt.tv/users/me/history/episodes?page=1&limit=10", "https://api.trakt.tv/sync/history/episodes"];

    for (const url of cases) {
        await t.test(url, async () => {
            const { result } = await runResponseCase({
                url,
                body: readFixture("history-episodes.json"),
                headers: {
                    "user-agent": "Trakt/1.0",
                },
                httpGetMocks: {
                    "https://api.trakt.tv/shows/555/translations/zh?extended=all": "[]",
                    "https://api.trakt.tv/shows/777/translations/zh?extended=all": "[]",
                },
                persistentData: createEpisodePersistentData(),
            });

            const payload = JSON.parse(result.body);
            assert.equal(payload[0].episode.title, "第二集中文");
        });
    }
});

test("handleRecentCommentsList 覆盖 recent comments 媒体包装路由", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/comments/recent/movies/weekly",
        body: readFixture("recent-comments.json"),
        persistentData: createUnifiedPersistentData({
            traktTranslation: JSON.parse(createMovieTranslationCache()),
            googleComments: JSON.parse(createCommentTranslationCache()),
        }),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].movie.title, "中文电影");
    assert.equal(payload[0].comment.comment, "很棒的电影");
});

test("handleComments 覆盖 media comments、episode comments 与 replies 路由", async (t) => {
    const cases = [
        "https://api.trakt.tv/movies/123/comments/newest",
        "https://api.trakt.tv/shows/555/seasons/1/comments/newest",
        "https://api.trakt.tv/shows/555/seasons/1/episodes/2/comments/newest",
        "https://api.trakt.tv/comments/123/replies",
        "https://apiz.trakt.tv/comments/453514?extended=reactions",
    ];

    for (const url of cases) {
        await t.test(url, async () => {
            const isDetail = /\/comments\/\d+(\?|$)/i.test(url);
            const { result } = await runResponseCase({
                url,
                body: isDetail ? JSON.stringify(JSON.parse(readFixture("comments.json"))[0]) : readFixture("comments.json"),
                persistentData: createEpisodeCommentPersistentData(),
            });

            const payload = JSON.parse(result.body);
            assert.equal(isDetail ? payload.comment : payload[0].comment, "很棒的电影");
        });
    }
});

test("handleMediaPeopleList 覆盖 movie、show 与 episode people 路由", async (t) => {
    const cases = [
        "https://api.trakt.tv/movies/123/people",
        "https://api.trakt.tv/shows/555/people",
        "https://api.trakt.tv/shows/555/seasons/1/people",
        "https://api.trakt.tv/shows/555/seasons/1/episodes/2/people",
    ];

    for (const url of cases) {
        await t.test(url, async () => {
            const { result } = await runResponseCase({
                url,
                body: readFixture("media-people-list.json"),
                persistentData: createUnifiedPersistentData({
                    googlePeople: JSON.parse(createPeopleTranslationCache()),
                }),
            });

            const payload = JSON.parse(result.body);
            assert.match(payload.cast[0].person.name, /^汤姆·汉克斯/);
        });
    }
});

test("handlePeopleSearchList 覆盖 search person 与 people this_month 路由", async (t) => {
    const cases = [
        {
            url: "https://api.trakt.tv/search/person?extended=cloud9,full&limit=100&page=1&query=gong",
            body: JSON.stringify([
                {
                    type: "person",
                    score: 1,
                    person: {
                        name: "Tom Hanks",
                        biography: "An American actor and filmmaker.",
                        ids: {
                            trakt: 42,
                        },
                    },
                },
            ]),
        },
        {
            url: "https://api.trakt.tv/people/this_month?extended=cloud9,full",
            body: JSON.stringify([
                {
                    name: "Tom Hanks",
                    biography: "An American actor and filmmaker.",
                    ids: {
                        trakt: 42,
                    },
                },
            ]),
        },
    ];

    for (const item of cases) {
        await t.test(item.url, async () => {
            const { result } = await runResponseCase({
                url: item.url,
                body: item.body,
                persistentData: createUnifiedPersistentData({
                    googlePeople: JSON.parse(createPeopleTranslationCache()),
                }),
            });

            const payload = JSON.parse(result.body);
            const person = payload[0].person ?? payload[0];
            assert.match(person.name, /^汤姆·汉克斯/);
            assert.equal(person.biography, "一位美国演员和电影制作人。");
        });
    }
});

test("handlePersonMediaCreditsList 覆盖 people movie credits 与 show credits 路由", async (t) => {
    const cases = [
        {
            name: "movie credits",
            url: "https://api.trakt.tv/people/42/movies",
            body: readFixture("people-credits.json"),
            persistentData: createMoviePersistentData(),
        },
        {
            name: "show credits",
            url: "https://api.trakt.tv/people/42/shows",
            body: JSON.stringify({
                cast: [
                    {
                        show: {
                            title: "Original Show Title",
                            overview: "Original Show Overview",
                            first_aired: "2025-01-01T00:00:00.000Z",
                            network: "HBO",
                            tagline: "Original Show Tagline",
                            ids: {
                                trakt: 456,
                            },
                        },
                    },
                ],
                crew: {},
            }),
            persistentData: createShowPersistentData(),
        },
    ];

    for (const item of cases) {
        await t.test(item.name, async () => {
            const { result } = await runResponseCase({
                url: item.url,
                body: item.body,
                headers: {
                    "user-agent": "Rippple/1.0",
                },
                persistentData: item.persistentData,
            });

            const payload = JSON.parse(result.body);
            const target = payload.cast[0].movie ?? payload.cast[0].show;
            assert.match(target.title, /^中文/);
        });
    }
});

test("handleMir 会把缓存中的中文翻译应用到 first_watched 媒体", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/users/me/mir",
        body: readFixture("mir.json"),
        persistentData: createMoviePersistentData(),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.first_watched.movie.title, "中文电影");
    assert.equal(payload.first_watched.movie.overview, "中文简介");
    assert.equal(payload.first_watched.movie.tagline, "中文标语");
});

test("handleMir 会叠加 translationOverrides 到 first_watched 媒体", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/users/me/mir",
        body: readFixture("mir.json"),
        persistentData: createMoviePersistentData(),
        argument: {
            backendBaseUrl: "https://backend.example",
        },
        httpGetMocks: {
            "https://backend.example/api/trakt/translation-overrides": createBackendTranslationOverridesBody(
                "movies",
                "123",
                createTranslationOverrideEntry({ title: "月度回顾覆盖标题" }),
            ),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.first_watched.movie.title, "月度回顾覆盖标题");
    assert.equal(payload.first_watched.movie.overview, "中文简介");
});

test("handleMediaDetail 覆盖 movie、show、season info 与 episode detail 路由", async (t) => {
    const cases = [
        {
            name: "movie detail",
            url: "https://api.trakt.tv/movies/123",
            body: readFixture("movie-detail.json"),
            persistentData: createUnifiedPersistentData({
                traktTranslation: JSON.parse(
                    createMovieTranslationCache({
                        "translation:movies:123:cn": createMediaTranslationEntry({
                            translation: {
                                title: "中文电影",
                                overview: "中文简介",
                                tagline: "中文标语",
                            },
                        }),
                    }),
                ),
            }),
            assertPayload(payload) {
                assert.equal(payload.title, "中文电影");
            },
        },
        {
            name: "show detail",
            url: "https://api.trakt.tv/shows/456",
            body: JSON.stringify({
                title: "Original Show Title",
                overview: "Original Show Overview",
                first_aired: "2025-01-01T00:00:00.000Z",
                network: "HBO",
                tagline: "Original Show Tagline",
                ids: {
                    trakt: 456,
                },
            }),
            persistentData: createShowPersistentData(),
            assertPayload(payload) {
                assert.equal(payload.title, "中文剧名");
            },
        },
        {
            name: "season info",
            url: "https://api.trakt.tv/shows/555/seasons/1/info",
            body: JSON.stringify({
                number: 1,
                title: "Original Season Title",
                overview: "Original Season Overview",
                ids: {
                    trakt: 1002,
                },
            }),
            persistentData: createUnifiedPersistentData({
                traktTranslation: {
                    "translation:shows:555:1:cn": createMediaTranslationEntry({
                        translation: {
                            title: "第一季",
                            overview: "第一季简介",
                        },
                    }),
                },
            }),
            assertPayload(payload) {
                assert.equal(payload.title, "第一季");
                assert.equal(payload.overview, "第一季简介");
            },
        },
        {
            name: "episode detail",
            url: "https://api.trakt.tv/shows/555/seasons/1/episodes/2",
            body: JSON.stringify({
                season: 1,
                number: 2,
                title: "Original Episode Title",
                overview: "Original Episode Overview",
                ids: {
                    trakt: 1001,
                },
            }),
            persistentData: createEpisodePersistentData(),
            assertPayload(payload) {
                assert.equal(payload.title, "第二集中文");
            },
        },
    ];

    for (const item of cases) {
        await t.test(item.name, async () => {
            const { result } = await runResponseCase({
                url: item.url,
                body: item.body,
                persistentData: item.persistentData,
            });

            item.assertPayload(JSON.parse(result.body));
        });
    }
});

test("handleMediaDetail 会叠加远端 translationOverrides 表", async (t) => {
    const cases = [
        {
            name: "movie detail override title",
            url: "https://api.trakt.tv/movies/123",
            body: readFixture("movie-detail.json"),
            persistentData: createMoviePersistentData(),
            backendBody: createBackendTranslationOverridesBody("movies", "123", createTranslationOverrideEntry({ title: "电影覆盖标题" })),
            assertPayload(payload) {
                assert.equal(payload.title, "电影覆盖标题");
                assert.equal(payload.overview, "中文简介");
            },
        },
        {
            name: "show detail override overview",
            url: "https://api.trakt.tv/shows/456",
            body: JSON.stringify({
                title: "Original Show Title",
                overview: "Original Show Overview",
                first_aired: "2025-01-01T00:00:00.000Z",
                network: "HBO",
                tagline: "Original Show Tagline",
                ids: {
                    trakt: 456,
                },
            }),
            persistentData: createShowPersistentData(),
            backendBody: createBackendTranslationOverridesBody("shows", "456", createTranslationOverrideEntry({ overview: "剧集覆盖简介" })),
            assertPayload(payload) {
                assert.equal(payload.title, "中文剧名");
                assert.equal(payload.overview, "剧集覆盖简介");
            },
        },
        {
            name: "episode detail override title",
            url: "https://api.trakt.tv/shows/555/seasons/1/episodes/2",
            body: JSON.stringify({
                season: 1,
                number: 2,
                title: "Original Episode Title",
                overview: "Original Episode Overview",
                ids: {
                    trakt: 1001,
                },
            }),
            persistentData: createEpisodePersistentData(),
            backendBody: createBackendTranslationOverridesBody("episodes", "555:1:2", createTranslationOverrideEntry({ title: "单集覆盖标题" })),
            assertPayload(payload) {
                assert.equal(payload.title, "单集覆盖标题");
                assert.equal(payload.overview, "第二集中文简介");
            },
        },
    ];

    for (const item of cases) {
        await t.test(item.name, async () => {
            const { result } = await runResponseCase({
                url: item.url,
                body: item.body,
                persistentData: item.persistentData,
                argument: {
                    backendBaseUrl: "https://backend.example",
                },
                httpGetMocks: {
                    "https://backend.example/api/trakt/translation-overrides": item.backendBody,
                },
            });

            item.assertPayload(JSON.parse(result.body));
        });
    }
});

test("handlePeopleDetail 覆盖 /people/:id 路由", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/people/42",
        body: readFixture("people-detail.json"),
        persistentData: createUnifiedPersistentData({
            googlePeople: JSON.parse(createPeopleTranslationCache()),
        }),
    });

    const payload = JSON.parse(result.body);
    assert.match(payload.name, /^汤姆·汉克斯/);
    assert.equal(payload.biography, "一位美国演员和电影制作人。");
});

test("handleTranslations 覆盖 movie、show 与 episode /translations/zh 路由", async (t) => {
    const cases = [
        {
            name: "movie translations",
            url: "https://api.trakt.tv/movies/123/translations/zh?extended=all",
            body: readFixture("translations.json"),
        },
        {
            name: "show translations",
            url: "https://api.trakt.tv/shows/456/translations/zh?extended=all",
            body: readFixture("translations.json"),
        },
        {
            name: "episode translations",
            url: "https://api.trakt.tv/shows/555/seasons/1/episodes/2/translations/zh?extended=all",
            body: JSON.stringify([
                {
                    language: "zh",
                    country: "cn",
                    title: "剧集中文标题",
                    overview: "剧集中文简介",
                },
            ]),
        },
    ];

    for (const item of cases) {
        await t.test(item.name, async () => {
            const { result } = await runResponseCase({
                url: item.url,
                body: item.body,
            });

            const payload = JSON.parse(result.body);
            assert.equal(payload[0].country, "cn");
        });
    }
});

test("handleTranslations 只覆盖 translationOverrides 提供字段", async (t) => {
    const cases = [
        {
            name: "movie override title only",
            url: "https://api.trakt.tv/movies/123/translations/zh?extended=all",
            backendUrl: "https://backend.example/api/trakt/translation-overrides",
            backendBody: createBackendTranslationOverridesBody("movies", "123", createTranslationOverrideEntry({ title: "覆盖标题" })),
            assertPayload(payload) {
                assert.equal(payload[0].title, "覆盖标题");
                assert.equal(payload[0].overview, "Trakt 简介");
                assert.equal(payload[0].tagline, "Trakt 标语");
            },
        },
        {
            name: "show override overview only",
            url: "https://api.trakt.tv/shows/456/translations/zh?extended=all",
            backendUrl: "https://backend.example/api/trakt/translation-overrides",
            backendBody: createBackendTranslationOverridesBody("shows", "456", createTranslationOverrideEntry({ overview: "覆盖剧集简介" })),
            assertPayload(payload) {
                assert.equal(payload[0].title, "Trakt 标题");
                assert.equal(payload[0].overview, "覆盖剧集简介");
                assert.equal(payload[0].tagline, "Trakt 标语");
            },
        },
        {
            name: "episode override title only",
            url: "https://api.trakt.tv/shows/555/seasons/1/episodes/2/translations/zh?extended=all",
            backendUrl: "https://backend.example/api/trakt/translation-overrides",
            backendBody: createBackendTranslationOverridesBody("episodes", "555:1:2", createTranslationOverrideEntry({ title: "覆盖单集标题" })),
            assertPayload(payload) {
                assert.equal(payload[0].title, "覆盖单集标题");
                assert.equal(payload[0].overview, "Trakt 简介");
                assert.equal(payload[0].tagline, "Trakt 标语");
            },
        },
    ];

    for (const item of cases) {
        await t.test(item.name, async () => {
            const { result } = await runResponseCase({
                url: item.url,
                body: createTraktZhTranslationBody(),
                argument: {
                    backendBaseUrl: "https://backend.example",
                },
                httpGetMocks: {
                    [item.backendUrl]: item.backendBody,
                },
            });

            item.assertPayload(JSON.parse(result.body));
        });
    }
});

test("handleTranslations override 字段为空时保留 Trakt 当前翻译", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/translations/zh?extended=all",
        body: createTraktZhTranslationBody(),
        argument: {
            backendBaseUrl: "https://backend.example",
        },
        httpGetMocks: {
            "https://backend.example/api/trakt/translation-overrides": createBackendTranslationOverridesBody("movies", "123", createTranslationOverrideEntry({ title: null })),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].title, "Trakt 标题");
    assert.equal(payload[0].overview, "Trakt 简介");
});

test("handleTranslations backend override 读取失败时保持现状", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/translations/zh?extended=all",
        body: createTraktZhTranslationBody(),
        argument: {
            backendBaseUrl: "https://backend.example",
        },
        httpGetMocks: {
            "https://backend.example/api/trakt/translation-overrides": {
                error: "backend unavailable",
            },
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].title, "Trakt 标题");
    assert.equal(payload[0].overview, "Trakt 简介");
    assert.equal(payload[0].tagline, "Trakt 标语");
});

test("handleTranslations 脚本内部请求不会读取 translationOverrides 表", async () => {
    const { result, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/translations/zh?extended=all",
        body: createTraktZhTranslationBody(),
        headers: {
            "x-script-trakt-translation-request": "true",
        },
        argument: {
            backendBaseUrl: "https://backend.example",
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].title, "Trakt 标题");
    assert.equal(
        httpLogs.some((item) => item.method === "GET" && item.url === "https://backend.example/api/trakt/translation-overrides"),
        false,
    );
});

test("handleMediaDetail translationOverrides 在刷新周期内直接读本地缓存", async () => {
    const { result, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body: readFixture("movie-detail.json"),
        persistentData: createUnifiedPersistentData({
            traktTranslation: JSON.parse(createMovieTranslationCache()),
            translationOverrides: {
                fetchedAt: Date.now(),
                shows: {},
                movies: {
                    123: createTranslationOverrideEntry({ title: "缓存覆盖标题" }),
                },
                episodes: {},
            },
        }),
        argument: {
            backendBaseUrl: "https://backend.example",
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.title, "缓存覆盖标题");
    assert.equal(
        httpLogs.some((item) => item.method === "GET" && item.url === "https://backend.example/api/trakt/translation-overrides"),
        false,
    );
});

test("handleMediaDetail 只含 tw/hk 的覆盖条目在刷新周期内仍生效", async () => {
    const { result, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body: readFixture("movie-detail.json"),
        persistentData: createUnifiedPersistentData({
            traktTranslation: JSON.parse(createMovieTranslationCache()),
            translationOverrides: {
                fetchedAt: Date.now(),
                shows: {},
                episodes: {},
                movies: {
                    123: {
                        tw: { translation: { title: "台灣覆蓋標題" } },
                    },
                },
            },
        }),
        argument: {
            chineseLocale: "tw",
            backendBaseUrl: "https://backend.example",
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.title, "台灣覆蓋標題");
    assert.equal(
        httpLogs.some((item) => item.method === "GET" && item.url === "https://backend.example/api/trakt/translation-overrides"),
        false,
        "刷新周期内应直接使用本地覆盖缓存",
    );
});

test("debugMode=disableLocal 时禁用本地缓存，每次从远端获取 translationOverrides", async () => {
    const { result, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body: readFixture("movie-detail.json"),
        persistentData: createUnifiedPersistentData({
            traktTranslation: JSON.parse(createMovieTranslationCache()),
            translationOverrides: {
                fetchedAt: Date.now(),
                shows: {},
                movies: {
                    123: createTranslationOverrideEntry({ title: "旧缓存标题" }),
                },
                episodes: {},
            },
        }),
        argument: {
            backendBaseUrl: "https://backend.example",
            debugMode: "disableLocal",
        },
        httpGetMocks: {
            "https://backend.example/api/trakt/translation-overrides": createBackendTranslationOverridesBody(
                "movies",
                "123",
                createTranslationOverrideEntry({ title: "远端最新标题" }),
            ),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.title, "远端最新标题");
    assert.equal(
        httpLogs.some((item) => item.method === "GET" && item.url === "https://backend.example/api/trakt/translation-overrides"),
        true,
    );
});

test("debugMode=disableLocal 时不读写本地持久化缓存", async () => {
    const initialPersistentData = createUnifiedPersistentData({
        traktTranslation: JSON.parse(createMovieTranslationCache()),
        translationOverrides: {
            fetchedAt: Date.now(),
            shows: {},
            movies: {
                123: createTranslationOverrideEntry({ title: "旧缓存标题" }),
            },
            episodes: {},
        },
    });
    const initialCacheSnapshot = JSON.stringify(initialPersistentData);

    const { persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body: readFixture("movie-detail.json"),
        persistentData: initialPersistentData,
        argument: {
            backendBaseUrl: "https://backend.example",
            debugMode: "disableLocal",
        },
        httpGetMocks: {
            "https://backend.example/api/trakt/translation-overrides": createBackendTranslationOverridesBody(
                "movies",
                "123",
                createTranslationOverrideEntry({ title: "远端最新标题" }),
            ),
        },
    });

    assert.equal(JSON.stringify(persistentData), initialCacheSnapshot);
});

test("debugMode=disableRemote 时不请求远端缓存接口，本地缓存正常读写", async () => {
    const initialPersistentData = createUnifiedPersistentData({
        traktTranslation: JSON.parse(createMovieTranslationCache()),
        translationOverrides: {
            fetchedAt: 0,
            shows: {},
            movies: {
                123: createTranslationOverrideEntry({ title: "本地覆盖标题" }),
            },
            episodes: {},
        },
    });
    const initialCacheSnapshot = JSON.stringify(initialPersistentData);

    const { result, httpLogs, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body: readFixture("movie-detail.json"),
        persistentData: initialPersistentData,
        argument: {
            backendBaseUrl: "https://backend.example",
            debugMode: "disableRemote",
        },
        httpGetMocks: {
            "https://backend.example/api/trakt/translation-overrides": createBackendTranslationOverridesBody(
                "movies",
                "123",
                createTranslationOverrideEntry({ title: "远端最新标题" }),
            ),
        },
    });

    const payload = JSON.parse(result.body);
    // apikeys 是配置下发而非缓存，debugMode 禁的是缓存，因此它是这里唯一允许的远端请求
    assert.equal(
        httpLogs.some((item) => item.url?.startsWith("https://backend.example") && !item.url.includes("/api/trakt/apikeys")),
        false,
    );
    assert.notEqual(payload.title, "远端最新标题");
    assert.notEqual(JSON.stringify(persistentData), initialCacheSnapshot);
});

test("debugMode=disableAll 时既不请求远端缓存也不读写本地", async () => {
    const initialPersistentData = createUnifiedPersistentData({
        traktTranslation: JSON.parse(createMovieTranslationCache()),
        translationOverrides: {
            fetchedAt: 0,
            shows: {},
            movies: {
                123: createTranslationOverrideEntry({ title: "本地覆盖标题" }),
            },
            episodes: {},
        },
    });
    const initialCacheSnapshot = JSON.stringify(initialPersistentData);

    const { result, httpLogs, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body: readFixture("movie-detail.json"),
        persistentData: initialPersistentData,
        argument: {
            backendBaseUrl: "https://backend.example",
            debugMode: "disableAll",
        },
        httpGetMocks: {
            "https://backend.example/api/trakt/translation-overrides": createBackendTranslationOverridesBody(
                "movies",
                "123",
                createTranslationOverrideEntry({ title: "远端最新标题" }),
            ),
        },
    });

    const payload = JSON.parse(result.body);
    // apikeys 是配置下发而非缓存，不受 disableAll 影响
    assert.equal(
        httpLogs.some((item) => item.url?.startsWith("https://backend.example") && !item.url.includes("/api/trakt/apikeys")),
        false,
    );
    assert.notEqual(payload.title, "本地覆盖标题");
    assert.notEqual(payload.title, "远端最新标题");
    assert.equal(JSON.stringify(persistentData), initialCacheSnapshot);
});

test("handleSentiments 覆盖原生 sentiments 与代理兼容路由", async (t) => {
    const googleSentiments = JSON.parse(createSentimentTranslationCache());
    googleSentiments["movie:853702:cn"] = JSON.parse(JSON.stringify(googleSentiments["movie:123:cn"]));

    const cases = [
        {
            name: "native movie sentiments",
            url: "https://api.trakt.tv/movies/123/sentiments",
            persistentData: createUnifiedPersistentData({
                googleSentiments: JSON.parse(createSentimentTranslationCache()),
            }),
        },
        {
            name: "proxy media info version route",
            url: "https://apiz.trakt.tv/v3/media/movie/853702/info/5/version/1",
            persistentData: createUnifiedPersistentData({
                googleSentiments,
            }),
        },
    ];

    for (const item of cases) {
        await t.test(item.name, async () => {
            const { result } = await runResponseCase({
                url: item.url,
                body: readFixture("sentiments.json"),
                persistentData: item.persistentData,
            });

            const payload = JSON.parse(result.body);
            assert.equal(payload.aspect.pros[0].theme, "剧情");
        });
    }
});

test("handleSeasonEpisodesList 覆盖 /shows/:id/seasons 路由", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/shows/555/seasons",
        body: readFixture("season-list.json"),
        persistentData: createUnifiedPersistentData({
            persistentCurrentSeason: { showId: "555", seasonNumber: 1 },
            traktTranslation: {
                "translation:episodes:555:1:1:cn": createMediaTranslationEntry({
                    translation: {
                        title: "第一集中文",
                        overview: "第一集中文简介",
                        tagline: "第一集中文标语",
                    },
                }),
                "translation:episodes:555:1:2:cn": createMediaTranslationEntry({
                    translation: {
                        title: "第二集中文",
                        overview: "第二集中文简介",
                        tagline: "第二集中文标语",
                    },
                }),
            },
        }),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].episodes[0].title, "第一集中文");
    assert.equal(payload[0].episodes[1].title, "第二集中文");
});

test("handleSeasonEpisodesList 会叠加 episode translationOverrides", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/shows/555/seasons",
        body: readFixture("season-list.json"),
        persistentData: createUnifiedPersistentData({
            persistentCurrentSeason: { showId: "555", seasonNumber: 1 },
            traktTranslation: {
                "translation:episodes:555:1:1:cn": createMediaTranslationEntry({
                    translation: {
                        title: "第一集中文",
                        overview: "第一集中文简介",
                        tagline: "第一集中文标语",
                    },
                }),
                "translation:episodes:555:1:2:cn": createMediaTranslationEntry({
                    translation: {
                        title: "第二集中文",
                        overview: "第二集中文简介",
                        tagline: "第二集中文标语",
                    },
                }),
            },
        }),
        argument: {
            backendBaseUrl: "https://backend.example",
        },
        httpGetMocks: {
            "https://backend.example/api/trakt/translation-overrides": createBackendTranslationOverridesBody(
                "episodes",
                "555:1:2",
                createTranslationOverrideEntry({ title: "第二集覆盖标题" }),
            ),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].episodes[0].title, "第一集中文");
    assert.equal(payload[0].episodes[1].title, "第二集覆盖标题");
    assert.equal(payload[0].episodes[1].overview, "第二集中文简介");
});

test("response phase migrated conditions 逐条覆盖且互斥", () => {
    const routes = createResponseRouteStubs();
    const cases = [
        ["directMedia.popular", "https://api.trakt.tv/shows/popular"],
        ["directMedia.related", "https://apiz.trakt.tv/movies/531178/related?extended=cloud9,full"],
        ["directMedia.related", "https://apiz.trakt.tv/shows/531178/related?extended=cloud9,full"],
        ["wrapperMedia.popularNext", "https://api.trakt.tv/media/popular/next"],
        ["users.hidden.section", "https://apiz.trakt.tv/users/hidden/dropped?extended=full,images&limit=15&page=1"],
        ["users.history.mediaTyped", "https://api.trakt.tv/users/me/history/shows?extended=full&limit=50&page=2"],
        ["calendars.media", "https://apiz.trakt.tv/calendars/my/media/2026-09-13/9?extended=full"],
        ["calendars.media", "https://api.trakt.tv/calendars/all/movies/2026-01-01/7"],
        ["calendars.media", "https://api.trakt.tv/calendars/all/dvd/2026-01-01/7"],
        ["calendars.media", "https://api.trakt.tv/calendars/my/streaming/2026-01-01/7"],
        ["calendars.shows", "https://api.trakt.tv/calendars/my/shows/2026-01-01/7"],
        ["calendars.shows", "https://api.trakt.tv/calendars/all/shows/new/2026-01-01/7"],
        ["calendars.shows", "https://api.trakt.tv/calendars/all/shows/premieres/2026-01-01/7"],
        ["calendars.shows", "https://api.trakt.tv/calendars/all/shows/finales/2026-01-01/7"],
        ["calendars.releases", "https://apiz.trakt.tv/calendars/releases/hot/2026-09-13/7?extended=full,images"],
        ["calendars.releases", "https://api.trakt.tv/calendars/releases/hot/new/2026-09-13/7"],
        ["calendars.releases", "https://api.trakt.tv/calendars/releases/hot/premieres/2026-09-13/7"],
        ["calendars.releases", "https://api.trakt.tv/calendars/releases/hot/finales/2026-09-13/7"],
        ["users.watching", "https://apiz.trakt.tv/users/me/watching?extended=cloud9,full"],
        ["search.media", "https://apiz.trakt.tv/search/movie,show?extended=cloud9,full&limit=100&page=1&query=%E5%AE%B6%E5%BC%91%E6%9C%8D%E5%8A%A1"],
        ["search.media", "https://apiz.trakt.tv/search/movie,show/exact?extended=cloud9,full&limit=100&page=1&query=%E5%AE%B6%E5%BC%91%E6%9C%8D%E5%8A%A1"],
        ["search.media", "https://apiz.trakt.tv/search/show,movie?extended=cloud9,full&limit=100&page=1&query=%E5%AE%B6%E5%BC%91%E6%9C%8D%E5%8A%A1"],
        ["search.recentById", "https://apiz.trakt.tv/search/recent_by_id/global/movies,shows?extended=cloud9,full,images&limit=50"],
        ["users.settings", "https://api.trakt.tv/users/settings"],
        ["tmdb.watchProviders", "https://api.themoviedb.org/3/watch/providers/movie"],
        ["tmdb.watchProviders", "https://api.themoviedb.org/3/watch/providers/tv"],
        ["tmdb.detail.watchProviders", "https://api.themoviedb.org/3/tv/108978?api_key=x&append_to_response=watch/providers"],
        ["tmdb.detail.watchProviders", "https://api.themoviedb.org/3/movie/123?append_to_response=seasons,watch/providers"],
        ["watchnow.sources", "https://api.trakt.tv/watchnow/sources"],
        ["media.people", "https://api.trakt.tv/movies/123/people"],
        ["media.people", "https://api.trakt.tv/shows/123/people"],
        ["shows.season.people", "https://api.trakt.tv/shows/123/seasons/1/people"],
        ["shows.episode.people", "https://api.trakt.tv/shows/123/seasons/1/episodes/2/people"],
        ["media.comments", "https://api.trakt.tv/movies/123/comments/newest"],
        ["media.comments", "https://api.trakt.tv/shows/123/comments/newest"],
        ["shows.season.comments", "https://api.trakt.tv/shows/123/seasons/1/comments/newest"],
        ["shows.episode.comments", "https://api.trakt.tv/shows/123/seasons/1/episodes/2/comments/newest"],
        ["comments.replies", "https://api.trakt.tv/comments/123/replies"],
        ["comments.detail", "https://apiz.trakt.tv/comments/453514?extended=reactions"],
        ["media.translations.zh", "https://api.trakt.tv/movies/123/translations/zh?extended=all"],
        ["media.translations.zh", "https://api.trakt.tv/shows/123/translations/zh?extended=all"],
        ["shows.episode.translations.zh", "https://api.trakt.tv/shows/123/seasons/1/episodes/2/translations/zh?extended=all"],
        ["media.watchnow", "https://api.trakt.tv/movies/123/watchnow"],
        ["media.watchnow", "https://api.trakt.tv/shows/123/watchnow"],
        ["episodes.watchnow", "https://api.trakt.tv/episodes/123/watchnow"],
        ["media.videos", "https://api.trakt.tv/movies/123/videos"],
        ["media.videos", "https://apiz.trakt.tv/shows/123/videos"],
        ["shows.seasons", "https://api.trakt.tv/shows/123/seasons"],
        ["media.proxySentiments", "https://apiz.trakt.tv/v3/media/movie/123/info/5/version/1"],
        ["media.proxySentiments", "https://apiz.trakt.tv/v3/media/show/123/info/5/version/1"],
        ["media.sentiments", "https://api.trakt.tv/movies/123/sentiments"],
        ["media.sentiments", "https://api.trakt.tv/shows/123/sentiments"],
        ["movies.summary", "https://api.trakt.tv/movies/123"],
        ["shows.summary", "https://api.trakt.tv/shows/123"],
        ["shows.season.info", "https://api.trakt.tv/shows/123/seasons/1/info"],
        ["shows.episode.summary", "https://api.trakt.tv/shows/123/seasons/1/episodes/2"],
        ["people.summary", "https://api.trakt.tv/people/42"],
    ];

    for (const [expectedId, url] of cases) {
        const routeUrl = new URL(url);
        const matchedRoutes = routes.filter((route) => route.test({ url: routeUrl }));
        assert.deepEqual(
            matchedRoutes.map((route) => route.id),
            [expectedId],
            `Expected exactly one route match for ${url}`,
        );
    }
});

test("calendars 路由剔除 Trakt 返回 405 的不存在类型组合", () => {
    const routes = createResponseRouteStubs();
    const invalidPaths = [];
    for (const target of ["my", "all"]) {
        for (const type of ["media", "movies", "dvd", "streaming"]) {
            for (const subType of ["new", "premieres", "finales"]) {
                invalidPaths.push(`calendars/${target}/${type}/${subType}/2026-09-13/7`);
            }
        }
    }
    for (const type of ["movies", "dvd", "shows"]) {
        invalidPaths.push(`calendars/releases/${type}/2026-09-13/7`);
        for (const subType of ["new", "premieres", "finales"]) {
            invalidPaths.push(`calendars/releases/${type}/${subType}/2026-09-13/7`);
        }
    }

    for (const pathname of invalidPaths) {
        const matchedRoutes = routes.filter((route) => route.test({ url: new URL(`https://api.trakt.tv/${pathname}`) }));
        assert.deepEqual(
            matchedRoutes.map((route) => route.id),
            [],
            `Expected no route match for ${pathname}`,
        );
    }
});

test(`media list 向 Trakt 批量补翻译时最多只请求 ${TRAKT_DIRECT_TRANSLATION_MAX_REFS} 条`, async () => {
    const body = JSON.stringify(
        Array.from({ length: TRAKT_DIRECT_TRANSLATION_MAX_REFS + 1 }, (_, index) => {
            const traktId = index + 1000;
            return {
                movie: {
                    title: `Original Movie ${traktId}`,
                    overview: `Original Overview ${traktId}`,
                    released: "2025-01-01",
                    ids: {
                        trakt: traktId,
                    },
                },
            };
        }),
    );

    const bulkMovieMap = {};
    for (let index = 0; index < TRAKT_DIRECT_TRANSLATION_MAX_REFS; index += 1) {
        bulkMovieMap[String(1000 + index)] = { title: "中文电影" };
    }
    const bulkResponseBody = JSON.stringify({ movie: bulkMovieMap });

    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/users/me/watchlist/movies?page=1&limit=501",
        body,
        headers: { authorization: "Bearer test-token" },
        httpGetMocks: {
            "regex:^https://api\\.trakt\\.tv/v3/intl/bulk\\?": bulkResponseBody,
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].movie.title, "中文电影");
    assert.equal(payload[TRAKT_DIRECT_TRANSLATION_MAX_REFS - 1].movie.title, "中文电影");
    assert.equal(payload[TRAKT_DIRECT_TRANSLATION_MAX_REFS].movie.title, `Original Movie ${1000 + TRAKT_DIRECT_TRANSLATION_MAX_REFS}`);
});

test("未命中任何已知 handler 的响应会以空结果直接放行", async () => {
    const body = JSON.stringify({
        untouched: true,
        value: 42,
    });

    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/sync/unknown-endpoint",
        body,
    });

    assert.equal(Object.keys(result).length, 0);
});

test("未命中任何已知 handler 的 request phase 请求会以空结果直接放行", async () => {
    const { result } = await runRequestCase({
        url: "https://api.trakt.tv/sync/unknown-endpoint",
        headers: {
            "user-agent": "UnitTest/1.0",
            "x-demo": "keep",
        },
    });

    assert.equal(Object.keys(result).length, 0);
});

test("bundle 每次执行结束后都会清理 globalThis.$ctx", async () => {
    const responseRun = await runResponseCase({
        url: "https://api.trakt.tv/sync/unknown-endpoint",
        body: JSON.stringify({ untouched: true }),
    });
    assert.equal(responseRun.hasRuntimeCtx, false);

    const requestRun = await runRequestCase({
        url: "https://api.trakt.tv/sync/unknown-endpoint",
        headers: {
            "user-agent": "UnitTest/1.0",
        },
    });
    assert.equal(requestRun.hasRuntimeCtx, false);
});

test("篡改应用授权的 PKCE verifier 随机生成且 challenge 匹配", () => {
    const first = generatePkcePair();
    const second = generatePkcePair();

    assert.match(first.verifier, /^[A-Za-z0-9\-._~]{43,128}$/);
    assert.equal(first.method, "S256");
    assert.equal(createHash("sha256").update(first.verifier).digest("base64url"), first.challenge);
    assert.notEqual(first.verifier, second.verifier);
});

test("篡改应用授权在 getRandomValues 抛错时回退 Math.random", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        value: {
            getRandomValues() {
                throw new Error("crypto unavailable");
            },
        },
    });

    try {
        const pair = generatePkcePair();
        assert.match(pair.verifier, /^[A-Za-z0-9\-._~]{43,128}$/);
        assert.equal(createHash("sha256").update(pair.verifier).digest("base64url"), pair.challenge);
    } finally {
        Object.defineProperty(globalThis, "crypto", descriptor);
    }
});

test("篡改应用授权默认关闭时 OAuth 请求直接放行", async () => {
    const deviceRun = await runRequestCase({
        url: "https://api.trakt.tv/oauth/device/code",
        headers: {
            "content-type": "application/json",
            "trakt-api-key": "old-client",
        },
        body: JSON.stringify({ client_id: "old-client" }),
    });
    assert.equal(Object.keys(deviceRun.result).length, 0);

    const authorizeRun = await runRequestCase({
        url: "https://trakt.tv/oauth/authorize?response_type=code&client_id=old-client&redirect_uri=senplayer%3A%2F%2Foauth-trakt",
    });
    assert.equal(Object.keys(authorizeRun.result).length, 0);
});

test("不计入授权数量限制的 Client（Infuse/Showly/Rippple）授权请求不会被篡改", async () => {
    for (const clientId of TRAKT_TAMPER_EXEMPT_CLIENT_IDS) {
        const authorizeRun = await runRequestCase({
            url: `https://trakt.tv/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=thirdparty%3A%2F%2Foauth%2Fcallback&state=original-state`,
            argument: {
                tamperAppAuthorizationEnabled: true,
            },
        });
        assert.equal(Object.keys(authorizeRun.result).length, 0);

        const deviceRun = await runRequestCase({
            url: "https://api.trakt.tv/oauth/device/code",
            headers: {
                "content-type": "application/json",
                "trakt-api-key": clientId,
            },
            body: JSON.stringify({ client_id: clientId }),
            argument: {
                tamperAppAuthorizationEnabled: true,
            },
        });
        assert.equal(Object.keys(deviceRun.result).length, 0);

        const tokenRun = await runRequestCase({
            url: "https://auth.trakt.tv/oauth/token",
            headers: {
                "content-type": "application/json",
                "trakt-api-key": clientId,
            },
            body: JSON.stringify({
                client_id: clientId,
                redirect_uri: "thirdparty://oauth/callback",
                grant_type: "authorization_code",
                code: "auth-code",
            }),
            argument: {
                tamperAppAuthorizationEnabled: true,
            },
        });
        assert.equal(Object.keys(tokenRun.result).length, 0);
    }
});

test("官方 Trakt Client 的授权请求不会被篡改", async () => {
    const { result } = await runRequestCase({
        url: `https://trakt.tv/oauth/authorize?response_type=code&client_id=${TRAKT_TAMPER_CLIENT_ID}&redirect_uri=trakt%3A%2F%2Fauth`,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(Object.keys(result).length, 0);
});

test("非 code 的授权请求不会被篡改", async () => {
    const { result } = await runRequestCase({
        url: "https://trakt.tv/oauth/authorize?response_type=token&client_id=old-client&redirect_uri=thirdparty%3A%2F%2Foauth%2Fcallback",
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(Object.keys(result).length, 0);
});

test("rex://、forward:// 和 reflix:// redirect_uri 会禁用篡改应用授权", async () => {
    for (const redirectUri of ["rex://callback", "forward://callback", "reflix://callback", "Reflix://oauth/callback"]) {
        const authorizeRun = await runRequestCase({
            url: `https://trakt.tv/oauth/authorize?response_type=code&client_id=old-client&redirect_uri=${encodeURIComponent(redirectUri)}&state=original-state`,
            argument: {
                tamperAppAuthorizationEnabled: true,
            },
        });
        assert.equal(Object.keys(authorizeRun.result).length, 0);

        const tokenRun = await runRequestCase({
            url: "https://auth.trakt.tv/oauth/token",
            headers: {
                "content-type": "application/json",
            },
            body: JSON.stringify({
                client_id: "old-client",
                redirect_uri: redirectUri,
                refresh_token: "refresh-token",
                grant_type: "refresh_token",
            }),
            argument: {
                tamperAppAuthorizationEnabled: true,
            },
        });
        assert.equal(Object.keys(tokenRun.result).length, 0);
    }
});

test("官方 Trakt Client 的 device 请求不会被篡改", async () => {
    const codeRun = await runRequestCase({
        url: "https://api.trakt.tv/oauth/device/code",
        headers: {
            "content-type": "application/json",
            "trakt-api-key": TRAKT_TAMPER_CLIENT_ID,
        },
        body: JSON.stringify({ client_id: TRAKT_TAMPER_CLIENT_ID }),
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });
    assert.equal(Object.keys(codeRun.result).length, 0);

    const tokenRun = await runRequestCase({
        url: "https://api.trakt.tv/oauth/device/token",
        headers: {
            "content-type": "application/json",
            "trakt-api-key": TRAKT_TAMPER_CLIENT_ID,
        },
        body: JSON.stringify({ client_id: TRAKT_TAMPER_CLIENT_ID, code: "official-device-code" }),
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });
    assert.equal(Object.keys(tokenRun.result).length, 0);
});

test("篡改应用授权会替换 device/code 的 trakt-api-key 和 JSON client_id", async () => {
    const { result } = await runRequestCase({
        url: "https://api.trakt.tv/oauth/device/code",
        headers: {
            "content-type": "application/json",
            "content-length": "99",
            "trakt-api-key": "old-client",
        },
        body: JSON.stringify({ client_id: "old-client" }),
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(result.headers["trakt-api-key"], TRAKT_TAMPER_CLIENT_ID);
    assert.equal(Object.hasOwn(result.headers, "content-length"), false);
    assert.equal(JSON.parse(result.body).client_id, TRAKT_TAMPER_CLIENT_ID);
});

test("篡改应用授权会替换 device/token 的 client_id 并移除 client_secret", async () => {
    const { result } = await runRequestCase({
        url: "https://api.trakt.tv/oauth/device/token",
        headers: {
            "content-type": "application/x-www-form-urlencoded",
            "trakt-api-key": "old-client",
        },
        body: "code=device-code&client_id=old-client&client_secret=old-secret",
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(result.headers["trakt-api-key"], TRAKT_TAMPER_CLIENT_ID);
    assert.match(result.body, /(?:^|&)client_id=fa21865a71b1bbf9464522c876864aa6e863df53d1f3e3fc7398394ead549787(?:&|$)/);
    assert.doesNotMatch(result.body, /(?:^|&)client_secret=/);
});

test("篡改应用授权会改写授权地址并保留 scope，同时记录第三方 redirect_uri", async () => {
    const redirectUri = "thirdparty://oauth/callback";
    const { result, persistentData } = await runRequestCase({
        url: `https://trakt.tv/oauth/authorize?response_type=code&client_id=old-client&redirect_uri=${encodeURIComponent(redirectUri)}&state=original-state&scope=public`,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    const targetUrl = new URL(result.url);
    // 授权页改写保留原域名、只替换 query：QX 实机实测跨域 url 会被半套用（Host 换掉、path/query 不换），Trakt 回 403
    assert.equal(`${targetUrl.origin}${targetUrl.pathname}`, "https://trakt.tv/oauth/authorize");
    assert.equal(targetUrl.searchParams.get("response_type"), "code");
    assert.equal(targetUrl.searchParams.get("client_id"), TRAKT_TAMPER_CLIENT_ID);
    assert.equal(targetUrl.searchParams.get("redirect_uri"), TRAKT_TAMPER_REDIRECT_URI);
    assert.equal(targetUrl.searchParams.get("lang"), "zh-hans-cn");
    assert.equal(targetUrl.searchParams.get("code_challenge_method"), "S256");
    assert.equal(targetUrl.searchParams.get("state"), targetUrl.searchParams.get("code_challenge"));
    assert.equal(targetUrl.searchParams.get("scope"), "public offline_access");

    const state = readLatestTamperState(persistentData);
    assert.equal(state.redirectUri, redirectUri);
    assert.equal(state.originalState, "original-state");
    assert.match(state.codeVerifier, /^[A-Za-z0-9\-._~]{43,128}$/);
    assert.equal(targetUrl.searchParams.get("code_challenge"), state.codeChallenge);
    assert.equal(createHash("sha256").update(state.codeVerifier).digest("base64url"), state.codeChallenge);
});

// 授权页改写必须保留原域名：QX 实测跨域 url 会被半套用（Host 换掉、path/query 不换 → Trakt 403），
// 三平台统一同域改写后行为一致，也少一次跨域跳转。
test("篡改应用授权改写授权地址时保留原域名", async () => {
    for (const host of ["trakt.tv", "auth.trakt.tv"]) {
        const { result } = await runRequestCase({
            url: `https://${host}/oauth/authorize?response_type=code&client_id=old-client&redirect_uri=${encodeURIComponent("thirdparty://oauth/callback")}`,
            argument: {
                tamperAppAuthorizationEnabled: true,
            },
        });

        const targetUrl = new URL(result.url);
        assert.equal(targetUrl.hostname, host, `${host} 的授权地址不应跨域`);
        assert.equal(targetUrl.pathname, "/oauth/authorize");
        assert.equal(targetUrl.searchParams.get("client_id"), TRAKT_TAMPER_CLIENT_ID);
        assert.equal(targetUrl.searchParams.get("redirect_uri"), TRAKT_TAMPER_REDIRECT_URI);
    }
});

test("篡改应用授权每次授权生成不同的 PKCE verifier，并保留多条流程状态", async () => {
    const firstRun = await runRequestCase({
        url: "https://trakt.tv/oauth/authorize?response_type=code&client_id=old-client&redirect_uri=first%3A%2F%2Fcallback&state=first",
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });
    const secondRun = await runRequestCase({
        url: "https://trakt.tv/oauth/authorize?response_type=code&client_id=old-client&redirect_uri=second%3A%2F%2Fcallback&state=second",
        persistentData: firstRun.persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    const firstTargetUrl = new URL(firstRun.result.url);
    const secondTargetUrl = new URL(secondRun.result.url);
    const states = readTamperStates(secondRun.persistentData);
    assert.equal(states.length, 2);
    assert.notEqual(states[0].codeVerifier, states[1].codeVerifier);
    assert.notEqual(states[0].codeChallenge, states[1].codeChallenge);

    const firstCallbackRun = await runResponseCase({
        url: createTamperCallbackUrl(firstTargetUrl, "first-code"),
        responseStatus: 302,
        responseHeaders: {
            location: "trakt://auth?code=first-code",
        },
        persistentData: secondRun.persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });
    assert.equal(firstCallbackRun.result.headers.Location, "first://callback?code=first-code&state=first");

    const secondCallbackRun = await runResponseCase({
        url: createTamperCallbackUrl(secondTargetUrl, "second-code"),
        responseStatus: 302,
        responseHeaders: {
            location: "trakt://auth?code=second-code",
        },
        persistentData: secondRun.persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });
    assert.equal(secondCallbackRun.result.headers.Location, "second://callback?code=second-code&state=second");
});

test("篡改应用授权会把 Trakt 回调还原为第三方 App 的 redirect_uri", async () => {
    const redirectUri = "thirdparty://oauth/callback";
    const authorizeRun = await runRequestCase({
        url: `https://trakt.tv/oauth/authorize?response_type=code&client_id=old-client&redirect_uri=${encodeURIComponent(redirectUri)}&state=original-state`,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });
    const targetUrl = new URL(authorizeRun.result.url);

    const callbackRun = await runResponseCase({
        url: createTamperCallbackUrl(targetUrl, "callback-code"),
        responseStatus: 302,
        responseHeaders: {
            location: "trakt://auth?code=callback-code",
        },
        persistentData: authorizeRun.persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(callbackRun.result.status, 302);
    assert.equal(callbackRun.result.headers.Location, "thirdparty://oauth/callback?code=callback-code&state=original-state");
    assert.equal(readLatestTamperState(callbackRun.persistentData).code, "callback-code");
});

test("trakt.tv 回调响应也会还原为第三方 App 的 redirect_uri", async () => {
    const redirectUri = "thirdparty://oauth/callback";
    const authorizeRun = await runRequestCase({
        url: `https://trakt.tv/oauth/authorize?response_type=code&client_id=old-client&redirect_uri=${encodeURIComponent(redirectUri)}&state=original-state`,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });
    const targetUrl = new URL(authorizeRun.result.url);

    const callbackRun = await runResponseCase({
        url: createTamperCallbackUrl(targetUrl, "callback-code", "trakt.tv"),
        responseStatus: 302,
        responseHeaders: {
            location: `trakt://auth?code=callback-code&state=${targetUrl.searchParams.get("state")}`,
        },
        persistentData: authorizeRun.persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(callbackRun.result.status, 302);
    assert.equal(callbackRun.result.headers.Location, "thirdparty://oauth/callback?code=callback-code&state=original-state");
});

test("篡改应用授权会用回调 code 对应的 verifier 改写 token 请求", async () => {
    const redirectUri = "thirdparty://oauth/callback";
    const authorizeRun = await runRequestCase({
        url: `https://trakt.tv/oauth/authorize?response_type=code&client_id=old-client&redirect_uri=${encodeURIComponent(redirectUri)}&state=original-state`,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });
    const targetUrl = new URL(authorizeRun.result.url);
    const callbackRun = await runResponseCase({
        url: createTamperCallbackUrl(targetUrl, "auth-code"),
        responseStatus: 302,
        responseHeaders: {
            location: "trakt://auth?code=auth-code",
        },
        persistentData: authorizeRun.persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });
    const state = readLatestTamperState(callbackRun.persistentData);

    const { result } = await runRequestCase({
        url: "https://auth.trakt.tv/oauth/token",
        headers: {
            "content-type": "application/json",
            "content-length": "200",
            "trakt-api-key": "old-client",
        },
        body: JSON.stringify({
            client_id: "old-client",
            client_secret: "old-secret",
            redirect_uri: redirectUri,
            code: "auth-code",
            grant_type: "authorization_code",
            code_verifier: "old-verifier",
        }),
        persistentData: callbackRun.persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(result.headers["trakt-api-key"], TRAKT_TAMPER_CLIENT_ID);
    assert.equal(Object.hasOwn(result.headers, "content-length"), false);
    assert.equal(payload.client_id, TRAKT_TAMPER_CLIENT_ID);
    assert.equal(payload.redirect_uri, TRAKT_TAMPER_REDIRECT_URI);
    assert.equal(payload.code_verifier, state.codeVerifier);
    assert.equal(payload.code, "auth-code");
    assert.equal(Object.hasOwn(payload, "client_secret"), false);
});

test("篡改应用授权会改写发往 trakt.tv 的 token 请求", async () => {
    const redirectUri = "senplayer://oauth-trakt";
    const originalClientId = "7b898599ce5b183b48819a49e2ef6280e235bdfe7603e8e3a242c2ff1c6b1440";
    const authorizeRun = await runRequestCase({
        url: `https://trakt.tv/oauth/authorize?response_type=code&client_id=${originalClientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=original-state`,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });
    const targetUrl = new URL(authorizeRun.result.url);
    const callbackRun = await runResponseCase({
        url: createTamperCallbackUrl(targetUrl, "senplayer-code", "trakt.tv"),
        responseStatus: 302,
        responseHeaders: {
            location: "trakt://auth?code=senplayer-code",
        },
        persistentData: authorizeRun.persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });
    const state = readLatestTamperState(callbackRun.persistentData);

    const { result } = await runRequestCase({
        url: "https://trakt.tv/oauth/token",
        headers: {
            "content-type": "application/json",
            "content-length": "220",
            "trakt-api-key": originalClientId,
        },
        body: JSON.stringify({
            code: "senplayer-code",
            client_secret: "old-secret",
            client_id: originalClientId,
            grant_type: "authorization_code",
            redirect_uri: redirectUri,
        }),
        persistentData: callbackRun.persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(result.headers["trakt-api-key"], TRAKT_TAMPER_CLIENT_ID);
    assert.equal(Object.hasOwn(result.headers, "content-length"), false);
    assert.equal(payload.client_id, TRAKT_TAMPER_CLIENT_ID);
    assert.equal(payload.redirect_uri, TRAKT_TAMPER_REDIRECT_URI);
    assert.equal(payload.code_verifier, state.codeVerifier);
    assert.equal(payload.code, "senplayer-code");
    assert.equal(Object.hasOwn(payload, "client_secret"), false);
});

test("authorization_code token 仅在 code 匹配时改写", async () => {
    const redirectUri = "thirdparty://oauth/callback";
    const authorizeRun = await runRequestCase({
        url: `https://trakt.tv/oauth/authorize?response_type=code&client_id=old-client&redirect_uri=${encodeURIComponent(redirectUri)}&state=original-state`,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    const { result } = await runRequestCase({
        url: "https://auth.trakt.tv/oauth/token",
        headers: {
            "content-type": "application/json",
        },
        body: JSON.stringify({
            client_id: "old-client",
            redirect_uri: redirectUri,
            code: "unknown-code",
            grant_type: "authorization_code",
        }),
        persistentData: authorizeRun.persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(Object.keys(result).length, 0);
});

test("篡改应用授权 refresh_token 命中 token 记录时移除 client_secret 且不注入 code_verifier", async () => {
    const clientId = "old-client";
    const persistentData = createTamperPersistentData({
        tokens: [createTamperTokenRecord("old-access-token", "refresh-token", { clientId })],
    });

    const { result } = await runRequestCase({
        url: "https://auth.trakt.tv/oauth/token",
        headers: {
            "content-type": "application/json",
            "trakt-api-key": clientId,
        },
        body: JSON.stringify({
            client_id: clientId,
            client_secret: "old-secret",
            redirect_uri: "thirdparty://oauth/callback",
            refresh_token: "refresh-token",
            grant_type: "refresh_token",
        }),
        persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.client_id, TRAKT_TAMPER_CLIENT_ID);
    assert.equal(payload.redirect_uri, TRAKT_TAMPER_REDIRECT_URI);
    assert.equal(payload.refresh_token, "refresh-token");
    assert.equal(Object.hasOwn(payload, "client_secret"), false);
    assert.equal(Object.hasOwn(payload, "code_verifier"), false);
});

test("篡改应用授权 token 响应写入记录后状态过期仍能改写 refresh", async () => {
    const redirectUri = "senplayer://oauth-trakt";
    const clientId = "7b898599ce5b183b48819a49e2ef6280e235bdfe7603e8e3a242c2ff1c6b1440";
    const authorizeRun = await runRequestCase({
        url: `https://trakt.tv/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=original-state`,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });
    const targetUrl = new URL(authorizeRun.result.url);
    const callbackRun = await runResponseCase({
        url: createTamperCallbackUrl(targetUrl, "senplayer-code", "trakt.tv"),
        responseStatus: 302,
        responseHeaders: {
            location: "trakt://auth?code=senplayer-code",
        },
        persistentData: authorizeRun.persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(Object.hasOwn(callbackRun.persistentData, TAMPER_AUTHORIZATION_KEY), true, "篡改授权状态写入独立持久化 key");

    const tokenRequestBody = JSON.stringify({
        client_id: clientId,
        redirect_uri: redirectUri,
        code: "senplayer-code",
        grant_type: "authorization_code",
    });
    const tokenRequestRun = await runRequestCase({
        url: "https://trakt.tv/oauth/token",
        headers: {
            "content-type": "application/json",
            "trakt-api-key": clientId,
        },
        body: tokenRequestBody,
        persistentData: callbackRun.persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });
    const tokenResponseRun = await runResponseCase({
        url: "https://trakt.tv/oauth/token",
        requestBody: tokenRequestBody,
        headers: {
            "content-type": "application/json",
        },
        body: JSON.stringify({ access_token: "senplayer-access", refresh_token: "senplayer-refresh", expires_in: 604800 }),
        persistentData: tokenRequestRun.persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    const tokens = readTamperTokens(tokenResponseRun.persistentData);
    assert.equal(tokens.length, 1, "token 响应应把签发结果写进 unified cache");
    assert.equal(readTamperStore(tokenResponseRun.persistentData).pending.length, 0);

    // 把授权流程状态人为置为过期，只保留 token 记录
    const tokenOnly = createTamperPersistentData({ tokens });

    const { result } = await runRequestCase({
        url: "https://trakt.tv/oauth/token",
        headers: {
            "content-type": "application/json",
            "trakt-api-key": clientId,
        },
        body: JSON.stringify({
            client_id: clientId,
            client_secret: "old-secret",
            redirect_uri: redirectUri,
            refresh_token: "senplayer-refresh",
            grant_type: "refresh_token",
        }),
        persistentData: tokenOnly,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.client_id, TRAKT_TAMPER_CLIENT_ID);
    assert.equal(payload.redirect_uri, TRAKT_TAMPER_REDIRECT_URI);
    assert.equal(Object.hasOwn(payload, "client_secret"), false);
    assert.equal(Object.hasOwn(payload, "code_verifier"), false);
});

test("篡改应用授权 refresh 只认 refresh_token 命中，不按 client_id 或 redirect_uri 命中", async () => {
    const persistentData = createTamperPersistentData({
        tokens: [createTamperTokenRecord("bound-access", "bound-refresh", { clientId: "bound-client" })],
    });

    const { result } = await runRequestCase({
        url: "https://trakt.tv/oauth/token",
        headers: {
            "content-type": "application/json",
        },
        body: JSON.stringify({
            client_id: "bound-client",
            redirect_uri: "thirdparty://oauth/callback",
            refresh_token: "other-refresh",
            grant_type: "refresh_token",
        }),
        persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(Object.keys(result).length, 0);
});

test("篡改应用授权 refresh 无 redirect_uri 时可按 refresh_token 命中记录", async () => {
    const clientId = "old-client";
    const persistentData = createTamperPersistentData({
        tokens: [createTamperTokenRecord("old-access", "refresh-token", { clientId })],
    });

    const { result } = await runRequestCase({
        url: "https://trakt.tv/oauth/token",
        headers: {
            "content-type": "application/json",
            "trakt-api-key": clientId,
        },
        body: JSON.stringify({
            client_id: clientId,
            refresh_token: "refresh-token",
            grant_type: "refresh_token",
        }),
        persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.client_id, TRAKT_TAMPER_CLIENT_ID);
});

test("篡改应用授权 refresh 响应会用新 token 替换旧记录并更新过期时间", async () => {
    const clientId = "old-client";
    const persistentData = createTamperPersistentData({
        tokens: [createTamperTokenRecord("old-access", "old-refresh", { clientId, expiresAt: Date.now() + 60 * 1000 })],
    });

    const requestBody = JSON.stringify({
        client_id: clientId,
        refresh_token: "old-refresh",
        grant_type: "refresh_token",
    });
    const tokenRequestRun = await runRequestCase({
        url: "https://trakt.tv/oauth/token",
        headers: {
            "content-type": "application/json",
            "trakt-api-key": clientId,
        },
        body: requestBody,
        persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });
    assert.equal(readTamperStore(tokenRequestRun.persistentData).pending.length, 1);

    const tokenResponseRun = await runResponseCase({
        url: "https://trakt.tv/oauth/token",
        requestBody,
        headers: {
            "content-type": "application/json",
        },
        body: JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 604800 }),
        persistentData: tokenRequestRun.persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    const tokens = readTamperTokens(tokenResponseRun.persistentData);
    assert.equal(tokens.length, 1, "刷新后应替换旧记录而不是追加");
    assert.equal(tokens[0].accessToken, "new-access");
    assert.equal(tokens[0].refreshToken, "new-refresh");
    const remaining = Number(tokens[0].expiresAt) - Date.now();
    assert.ok(remaining > TRAKT_TAMPER_ACCESS_TOKEN_TTL_MS - 60 * 1000, "应按 expires_in 更新过期时间");
});

test("篡改应用授权在响应阶段拿不到请求体时按唯一 pending 兜底写入 token 记录", async () => {
    const redirectUri = "thirdparty://oauth/callback";
    const authorizeRun = await runRequestCase({
        url: `https://trakt.tv/oauth/authorize?response_type=code&client_id=old-client&redirect_uri=${encodeURIComponent(redirectUri)}&state=original-state`,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });
    const targetUrl = new URL(authorizeRun.result.url);
    const callbackRun = await runResponseCase({
        url: createTamperCallbackUrl(targetUrl, "no-body-code", "trakt.tv"),
        responseStatus: 302,
        responseHeaders: {
            location: "trakt://auth?code=no-body-code",
        },
        persistentData: authorizeRun.persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    const tokenRequestBody = JSON.stringify({
        client_id: "old-client",
        redirect_uri: redirectUri,
        code: "no-body-code",
        grant_type: "authorization_code",
    });
    const tokenRequestRun = await runRequestCase({
        url: "https://trakt.tv/oauth/token",
        headers: {
            "content-type": "application/json",
            "trakt-api-key": "old-client",
        },
        body: tokenRequestBody,
        persistentData: callbackRun.persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });
    assert.equal(readTamperStore(tokenRequestRun.persistentData).pending.length, 1);

    // 模拟响应阶段拿不到 $request.body：只能按唯一 pending 兜底
    const tokenResponseRun = await runResponseCase({
        url: "https://trakt.tv/oauth/token",
        headers: {
            "content-type": "application/json",
        },
        body: JSON.stringify({ access_token: "no-body-access", refresh_token: "no-body-refresh", expires_in: 604800 }),
        persistentData: tokenRequestRun.persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    const store = readTamperStore(tokenResponseRun.persistentData);
    assert.equal(store.pending.length, 0);
    assert.equal(store.tokens.length, 1);
    assert.equal(store.tokens[0].accessToken, "no-body-access");
    assert.equal(store.tokens[0].refreshToken, "no-body-refresh");
});

// 平台给响应脚本的请求头可能已被请求阶段改写为官方 client id：此时原始 client 不可知，应退回唯一 pending 匹配
test("篡改应用授权响应阶段请求头已是官方 client 时仍按唯一 pending 写入 token 记录", async () => {
    const persistentData = createTamperPersistentData({
        pending: [
            {
                kind: "authorization_code",
                id: "official-header-code",
                clientId: "old-client",
                createdAt: Date.now(),
                expiresAt: Date.now() + 60 * 1000,
            },
        ],
    });

    const { persistentData: nextPersistentData } = await runResponseCase({
        url: "https://api.trakt.tv/oauth/token",
        headers: {
            "content-type": "application/json",
            "trakt-api-key": TRAKT_TAMPER_CLIENT_ID,
        },
        body: JSON.stringify({ access_token: "official-header-access", refresh_token: "official-header-refresh", expires_in: 604800 }),
        environment: "qx",
        omitRequestBody: true,
        persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    const store = readTamperStore(nextPersistentData);
    assert.equal(store.pending.length, 0);
    assert.equal(store.tokens.length, 1);
    assert.equal(store.tokens[0].accessToken, "official-header-access");
    assert.equal(store.tokens[0].clientId, "old-client");
});

test("篡改应用授权 refresh 响应阶段拿不到请求体时也能替换旧记录", async () => {
    const persistentData = createTamperPersistentData({
        tokens: [createTamperTokenRecord("old-access", "old-refresh", { clientId: "old-client", expiresAt: Date.now() + 60 * 1000 })],
    });

    const requestBody = JSON.stringify({
        client_id: "old-client",
        refresh_token: "old-refresh",
        grant_type: "refresh_token",
    });
    const tokenRequestRun = await runRequestCase({
        url: "https://trakt.tv/oauth/token",
        headers: {
            "content-type": "application/json",
            "trakt-api-key": "old-client",
        },
        body: requestBody,
        persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    const tokenResponseRun = await runResponseCase({
        url: "https://trakt.tv/oauth/token",
        headers: {
            "content-type": "application/json",
        },
        body: JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 604800 }),
        persistentData: tokenRequestRun.persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    const tokens = readTamperTokens(tokenResponseRun.persistentData);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].accessToken, "new-access");
    assert.equal(tokens[0].refreshToken, "new-refresh");
});

test("篡改应用授权 token 交换失败时保留 pending", async () => {
    const clientId = "old-client";
    const persistentData = createTamperPersistentData({
        pending: [
            {
                kind: "authorization_code",
                id: "failed-code",
                clientId,
                createdAt: Date.now(),
                expiresAt: Date.now() + 60 * 1000,
            },
        ],
    });

    const { persistentData: updatedData } = await runResponseCase({
        url: "https://trakt.tv/oauth/token",
        headers: {
            "content-type": "application/json",
        },
        body: JSON.stringify({ error: "invalid_grant" }),
        persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(readTamperStore(updatedData).pending.length, 1);
    assert.equal(readTamperTokens(updatedData).length, 0);
});

test("篡改应用授权 refresh_token 不在 token 记录时放行", async () => {
    const persistentData = createTamperPersistentData({
        tokens: [createTamperTokenRecord("some-access", "some-refresh")],
    });

    const { result } = await runRequestCase({
        url: "https://trakt.tv/oauth/token",
        headers: {
            "content-type": "application/json",
        },
        body: JSON.stringify({
            client_id: "old-client",
            redirect_uri: "thirdparty://oauth/callback",
            refresh_token: "old-refresh",
            grant_type: "refresh_token",
        }),
        persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(Object.keys(result).length, 0);
});

test("篡改应用授权 device/code 响应写入 device_code pending，device/token 成功后可改写非认证请求", async () => {
    const clientId = "old-client";
    const deviceCodeRequestBody = JSON.stringify({ client_id: clientId });
    const deviceCodeRun = await runRequestCase({
        url: "https://api.trakt.tv/oauth/device/code",
        headers: {
            "content-type": "application/json",
            "trakt-api-key": clientId,
        },
        body: deviceCodeRequestBody,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });
    assert.equal(readTamperStore(deviceCodeRun.persistentData).pending.length, 1, "device/code 请求写 device_flow 标记");

    const deviceCodeResponseRun = await runResponseCase({
        url: "https://api.trakt.tv/oauth/device/code",
        requestBody: deviceCodeRequestBody,
        headers: {
            "content-type": "application/json",
        },
        body: JSON.stringify({
            device_code: "device-code",
            user_code: "USER",
            verification_url: "https://trakt.tv/activate",
            expires_in: 600,
            interval: 5,
        }),
        persistentData: deviceCodeRun.persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    const deviceCodeStore = readTamperStore(deviceCodeResponseRun.persistentData);
    assert.equal(deviceCodeStore.pending.length, 1);
    assert.equal(deviceCodeStore.pending[0].kind, "device_code");
    assert.equal(deviceCodeStore.pending[0].id, "device-code");
    assert.ok(Number(deviceCodeStore.pending[0].expiresAt) - Date.now() > 9 * 60 * 1000, "device_code pending 应覆盖 Trakt 的 expires_in");

    const deviceRequestBody = JSON.stringify({ client_id: clientId, code: "device-code" });
    const deviceTokenRun = await runRequestCase({
        url: "https://api.trakt.tv/oauth/device/token",
        headers: {
            "content-type": "application/json",
            "trakt-api-key": clientId,
        },
        body: deviceRequestBody,
        persistentData: deviceCodeResponseRun.persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    const deviceResponseRun = await runResponseCase({
        url: "https://api.trakt.tv/oauth/device/token",
        requestBody: deviceRequestBody,
        headers: {
            "content-type": "application/json",
        },
        body: JSON.stringify({ access_token: "device-access", refresh_token: "device-refresh", expires_in: 604800 }),
        persistentData: deviceTokenRun.persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    const tokens = readTamperTokens(deviceResponseRun.persistentData);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].accessToken, "device-access");
    assert.equal(readTamperStore(deviceResponseRun.persistentData).pending.length, 0);

    const { result } = await runRequestCase({
        url: "https://api.trakt.tv/sync/history",
        headers: {
            "content-type": "application/json",
            authorization: "Bearer device-access",
            "trakt-api-key": clientId,
        },
        persistentData: deviceResponseRun.persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });
    assert.equal(result.headers["trakt-api-key"], TRAKT_TAMPER_CLIENT_ID);
});

test("篡改应用授权会把带 access token 的非认证请求 trakt-api-key 换成篡改应用 client id", async () => {
    const accessToken = "PTUrnuoZdFhppVGGLiWVodKJfRcDrQxv";
    const persistentData = createTamperPersistentData({
        tokens: [createTamperTokenRecord(accessToken, "refresh-token")],
    });

    const { result } = await runRequestCase({
        url: "https://api.trakt.tv/sync/history",
        headers: {
            "content-type": "application/json",
            "content-length": "101",
            authorization: `Bearer ${accessToken}`,
            "trakt-api-key": "7b898599ce5b183b48819a49e2ef6280e235bdfe7603e8e3a242c2ff1c6b1440",
        },
        body: JSON.stringify({ shows: [] }),
        persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(result.url, "https://api.trakt.tv/sync/history");
    assert.equal(result.headers["trakt-api-key"], TRAKT_TAMPER_CLIENT_ID);
    assert.equal(result.headers.authorization, `Bearer ${accessToken}`);
    // 只改 trakt-api-key、不动请求体：必须原样保留 content-length，QX 的 header-only 重写不会自动补长度头
    assert.equal(result.headers["content-length"], "101");
    assert.equal(Object.hasOwn(result, "body"), false);
});

// QX 的 header-only 重写不会自动重算长度头：丢了 content-length 会让带 body 的 POST 变成没有请求体
test("篡改应用授权在无请求体时改写 trakt-api-key 会保留 content-length", async () => {
    const accessToken = "qx-watchlist-access";
    const persistentData = createTamperPersistentData({
        tokens: [createTamperTokenRecord(accessToken, "refresh-token")],
    });

    const { result } = await runRequestCase({
        url: "https://api.trakt.tv/sync/watchlist",
        headers: {
            "content-type": "application/json",
            "content-length": "42",
            authorization: `Bearer ${accessToken}`,
            "trakt-api-key": "third-party-client",
        },
        requestBody: JSON.stringify({ movies: [{ ids: { trakt: 1 } }] }),
        environment: "qx",
        omitRequestBody: true,
        persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(result.headers["trakt-api-key"], TRAKT_TAMPER_CLIENT_ID);
    assert.equal(result.headers["content-length"], "42");
    assert.equal(Object.hasOwn(result, "body"), false, "无请求体分支不能回写 body");
});

test("篡改应用授权非认证请求未带 access token 时不改写 trakt-api-key", async () => {
    const persistentData = createTamperPersistentData({
        tokens: [createTamperTokenRecord("access-token", "refresh-token")],
    });

    const { result } = await runRequestCase({
        url: "https://api.trakt.tv/sync/history",
        headers: {
            "content-type": "application/json",
            "trakt-api-key": "old-client",
        },
        persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(Object.keys(result).length, 0);
});

test("篡改应用授权非认证请求 access token 未命中 token 记录时不改写", async () => {
    const { result } = await runRequestCase({
        url: "https://api.trakt.tv/sync/history",
        headers: {
            "content-type": "application/json",
            authorization: "Bearer unbound-access-token",
            "trakt-api-key": "old-client",
        },
        persistentData: createTamperPersistentData({
            tokens: [createTamperTokenRecord("bound-access-token", "bound-refresh-token")],
        }),
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(Object.keys(result).length, 0);
});

// 授权响应漏记 token 时，用「该 client 仍有新鲜的篡改授权流程记录」补记一次，让存量授权也能自愈
test("篡改应用授权 token 记录缺失但授权流程仍新鲜时补记并改写非认证请求", async () => {
    const persistentData = createTamperPersistentData({
        records: [
            createTamperStateRecord(0, {
                clientId: "old-client",
                code: "fresh-code",
                redirectUri: "thirdparty://oauth/callback",
            }),
        ],
    });

    const { result, persistentData: nextPersistentData } = await runRequestCase({
        url: "https://api.trakt.tv/sync/history",
        headers: {
            "content-type": "application/json",
            authorization: "Bearer fresh-access-token",
            "trakt-api-key": "old-client",
        },
        persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(result.headers["trakt-api-key"], TRAKT_TAMPER_CLIENT_ID);
    const tokens = readTamperTokens(nextPersistentData);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].accessToken, "fresh-access-token");
    assert.equal(tokens[0].clientId, "old-client");
});

test("篡改应用授权授权流程已过期时不会凭 Bearer token 补记", async () => {
    const persistentData = createTamperPersistentData({
        records: [
            createTamperStateRecord(0, {
                clientId: "old-client",
                createdAt: Date.now() - 5 * 60 * 1000 - 1000,
            }),
        ],
    });

    const { result, persistentData: nextPersistentData } = await runRequestCase({
        url: "https://api.trakt.tv/sync/history",
        headers: {
            "content-type": "application/json",
            authorization: "Bearer stale-access-token",
            "trakt-api-key": "old-client",
        },
        persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(Object.keys(result).length, 0);
    assert.equal(readTamperTokens(nextPersistentData).length, 0);
});

test("篡改应用授权非认证请求命中 token 记录时没有 trakt-api-key 也会补上官方 client id", async () => {
    const { result } = await runRequestCase({
        url: "https://api.trakt.tv/sync/history",
        headers: {
            "content-type": "application/json",
            authorization: "Bearer access-token",
        },
        persistentData: createTamperPersistentData({
            tokens: [createTamperTokenRecord("access-token", "refresh-token")],
        }),
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(result.headers["trakt-api-key"], TRAKT_TAMPER_CLIENT_ID);
});

test("篡改应用授权已由其他路由改写请求时仍会补上 trakt-api-key", async () => {
    const persistentData = createTamperPersistentData({
        tokens: [createTamperTokenRecord("access-token", "refresh-token")],
    });

    const { result } = await runRequestCase({
        url: "https://api.trakt.tv/sync/history/episodes",
        headers: {
            "content-type": "application/json",
            "user-agent": "Trakt/1.0",
            authorization: "Bearer access-token",
        },
        persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
            historyEpisodesMergedByShow: true,
        },
    });

    assert.match(result.url, /[?&]limit=/);
    assert.equal(result.headers["trakt-api-key"], TRAKT_TAMPER_CLIENT_ID);
});

test("篡改应用授权 refresh_token 在没有匹配 token 记录时放行", async () => {
    const { result } = await runRequestCase({
        url: "https://trakt.tv/oauth/token",
        headers: {
            "content-type": "application/json",
            "trakt-api-key": "old-client",
        },
        body: JSON.stringify({
            client_id: "old-client",
            client_secret: "old-secret",
            redirect_uri: "senplayer://oauth-trakt",
            refresh_token: "refresh-token",
            grant_type: "refresh_token",
        }),
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(Object.keys(result).length, 0);
});

test("篡改应用授权状态超过 5 分钟后不再参与 authorization_code 匹配", async () => {
    const persistentData = createTamperPersistentData({
        records: [
            createTamperStateRecord(0, {
                redirectUri: "thirdparty://oauth/callback",
                code: "stale-code",
                createdAt: Date.now() - 5 * 60 * 1000 - 1000,
            }),
        ],
    });

    const { result } = await runRequestCase({
        url: "https://trakt.tv/oauth/token",
        headers: {
            "content-type": "application/json",
        },
        body: JSON.stringify({
            client_id: "old-client",
            redirect_uri: "thirdparty://oauth/callback",
            code: "stale-code",
            grant_type: "authorization_code",
        }),
        persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(Object.keys(result).length, 0);
});

test("官方 Trakt Client 的 token 请求不会被篡改", async () => {
    const { result } = await runRequestCase({
        url: "https://auth.trakt.tv/oauth/token",
        headers: {
            "content-type": "application/json",
        },
        body: JSON.stringify({
            client_id: TRAKT_TAMPER_CLIENT_ID,
            redirect_uri: TRAKT_TAMPER_REDIRECT_URI,
            code: "official-code",
            grant_type: "authorization_code",
        }),
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(Object.keys(result).length, 0);
});

test("已改写的授权地址不会覆盖第三方流程状态", async () => {
    const redirectUri = "thirdparty://oauth/callback";
    const firstRun = await runRequestCase({
        url: `https://trakt.tv/oauth/authorize?response_type=code&client_id=old-client&redirect_uri=${encodeURIComponent(redirectUri)}&state=original-state`,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    const secondRun = await runRequestCase({
        url: firstRun.result.url,
        persistentData: firstRun.persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });
    assert.equal(Object.keys(secondRun.result).length, 0);

    const targetUrl = new URL(firstRun.result.url);
    const callbackRun = await runResponseCase({
        url: createTamperCallbackUrl(targetUrl, "callback-code"),
        responseStatus: 302,
        responseHeaders: {
            location: "trakt://auth?code=callback-code",
        },
        persistentData: secondRun.persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });
    assert.equal(callbackRun.result.headers.Location, "thirdparty://oauth/callback?code=callback-code&state=original-state");
});

test("篡改应用授权不会按第三方原始 state 匹配回调", async () => {
    const authorizeRun = await runRequestCase({
        url: `https://trakt.tv/oauth/authorize?response_type=code&client_id=old-client&redirect_uri=${encodeURIComponent("thirdparty://oauth/callback")}&state=original-state`,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    const callbackRun = await runResponseCase({
        url: "https://auth.trakt.tv/api/auth/oauth2/authorize?state=original-state&code=other-code",
        responseStatus: 302,
        responseHeaders: {
            location: "trakt://auth?code=other-code&state=original-state",
        },
        persistentData: authorizeRun.persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(Object.keys(callbackRun.result).length, 0);
});

test("篡改应用授权在 QX 字符串状态码下仍返回 302", async () => {
    const authorizeRun = await runRequestCase({
        url: `https://trakt.tv/oauth/authorize?response_type=code&client_id=old-client&redirect_uri=${encodeURIComponent("thirdparty://oauth/callback")}&state=original-state`,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });
    const targetUrl = new URL(authorizeRun.result.url);

    const callbackRun = await runResponseCase({
        url: createTamperCallbackUrl(targetUrl, "callback-code"),
        responseStatus: "HTTP/1.1 302 Found",
        responseHeaders: {
            location: "trakt://auth?code=callback-code",
        },
        persistentData: authorizeRun.persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(callbackRun.result.status, 302);
    assert.equal(callbackRun.result.headers.Location, "thirdparty://oauth/callback?code=callback-code&state=original-state");
});

test("篡改应用授权在已有流程记录时不会覆盖其它流程状态", async () => {
    const existingCount = TRAKT_TAMPER_STATE_RECORD_LIMIT - 1;
    const persistentData = createTamperPersistentData({
        records: Array.from({ length: existingCount }, (_, index) => createTamperStateRecord(index)),
    });

    const authorizeRun = await runRequestCase({
        url: `https://trakt.tv/oauth/authorize?response_type=code&client_id=old-client&redirect_uri=${encodeURIComponent("thirdparty://oauth/callback")}&state=original-state`,
        persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    const states = readTamperStates(authorizeRun.persistentData);
    assert.equal(states.length, TRAKT_TAMPER_STATE_RECORD_LIMIT);
    for (let index = 0; index < existingCount; index += 1) {
        assert.ok(states.some((state) => state.id === `existing-id-${index}`));
    }
});

test("篡改应用授权在记录数超限时淘汰最没有保留价值的流程", async () => {
    const now = Date.now();
    const limit = TRAKT_TAMPER_STATE_RECORD_LIMIT;
    const persistentData = createTamperPersistentData({
        records: Array.from({ length: limit }, (_, index) => createTamperStateRecord(index, { createdAt: now - (limit - index) * 1000 })),
    });

    const authorizeRun = await runRequestCase({
        url: `https://trakt.tv/oauth/authorize?response_type=code&client_id=old-client&redirect_uri=${encodeURIComponent("thirdparty://oauth/callback")}&state=original-state`,
        persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    const states = readTamperStates(authorizeRun.persistentData);
    assert.equal(states.length, limit);
    assert.equal(
        states.some((state) => state.id === "existing-id-0"),
        false,
    );
});

test("篡改应用授权在流程记录占满时保留最新流程", async () => {
    const now = Date.now();
    const limit = TRAKT_TAMPER_STATE_RECORD_LIMIT;
    const persistentData = createTamperPersistentData({
        records: Array.from({ length: limit }, (_, index) => createTamperStateRecord(index, { createdAt: now - (limit - index) * 1000 })),
    });

    const authorizeRun = await runRequestCase({
        url: `https://trakt.tv/oauth/authorize?response_type=code&client_id=old-client&redirect_uri=${encodeURIComponent("thirdparty://oauth/callback")}&state=original-state`,
        persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    const challenge = new URL(authorizeRun.result.url).searchParams.get("code_challenge");
    const states = readTamperStates(authorizeRun.persistentData);
    assert.equal(states.length, limit);
    assert.ok(
        states.some((state) => state.id === challenge),
        "进行中的新流程必须保留",
    );
    assert.equal(
        states.some((state) => state.id === "existing-id-0"),
        false,
        "应淘汰最旧的流程",
    );
});

test("篡改应用授权 device/token 轮询不再写 unified cache", async () => {
    const { persistentData } = await runRequestCase({
        url: "https://api.trakt.tv/oauth/device/token",
        headers: {
            "content-type": "application/json",
            "trakt-api-key": "old-client",
        },
        body: JSON.stringify({ client_id: "old-client", code: "device-code" }),
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(Object.hasOwn(persistentData, UNIFIED_CACHE_KEY), false, "轮询不应写 unified cache");
    assert.equal(Object.hasOwn(persistentData, TAMPER_AUTHORIZATION_KEY), false, "轮询也不写独立的篡改授权 key");
});

test("篡改应用授权 token 记录超过上限时保留最新记录", async () => {
    const limit = TRAKT_TAMPER_TOKEN_RECORD_LIMIT;
    const tokens = Array.from({ length: limit }, (_, index) => createTamperTokenRecord(`access-${index}`, `refresh-${index}`, { createdAt: Date.now() - (limit - index) * 1000 }));
    const persistentData = createTamperPersistentData({ tokens });

    const requestBody = JSON.stringify({
        client_id: "old-client",
        refresh_token: `refresh-${limit - 1}`,
        grant_type: "refresh_token",
    });
    const tokenRequestRun = await runRequestCase({
        url: "https://trakt.tv/oauth/token",
        headers: {
            "content-type": "application/json",
        },
        body: requestBody,
        persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });
    const tokenResponseRun = await runResponseCase({
        url: "https://trakt.tv/oauth/token",
        requestBody,
        headers: {
            "content-type": "application/json",
        },
        body: JSON.stringify({ access_token: "newest-access", refresh_token: "newest-refresh", expires_in: 604800 }),
        persistentData: tokenRequestRun.persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    const resultTokens = readTamperTokens(tokenResponseRun.persistentData);
    assert.equal(resultTokens.length, limit);
    assert.ok(resultTokens.some((token) => token.accessToken === "newest-access"));
});

test("篡改应用授权 token 记录超限时优先淘汰无 refresh_token 的过期记录", async () => {
    const limit = TRAKT_TAMPER_TOKEN_RECORD_LIMIT;
    const now = Date.now();
    const redirectUri = "thirdparty://oauth/callback";
    const authorizeRun = await runRequestCase({
        url: `https://trakt.tv/oauth/authorize?response_type=code&client_id=old-client&redirect_uri=${encodeURIComponent(redirectUri)}&state=original-state`,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });
    const targetUrl = new URL(authorizeRun.result.url);
    const callbackRun = await runResponseCase({
        url: createTamperCallbackUrl(targetUrl, "cap-code", "trakt.tv"),
        responseStatus: 302,
        responseHeaders: {
            location: "trakt://auth?code=cap-code",
        },
        persistentData: authorizeRun.persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    const liveTokens = Array.from({ length: limit - 1 }, (_, index) =>
        createTamperTokenRecord(`live-access-${index}`, `live-refresh-${index}`, { createdAt: now - (limit - index) * 1000 }),
    );
    const deadToken = createTamperTokenRecord("dead-access", "", { createdAt: now, expiresAt: now - 1000 });
    const persistentData = createTamperPersistentData({
        records: readTamperRecords(callbackRun.persistentData),
        tokens: [...liveTokens, deadToken],
    });

    const requestBody = JSON.stringify({
        client_id: "old-client",
        redirect_uri: redirectUri,
        code: "cap-code",
        grant_type: "authorization_code",
    });
    const tokenRequestRun = await runRequestCase({
        url: "https://trakt.tv/oauth/token",
        headers: {
            "content-type": "application/json",
            "trakt-api-key": "old-client",
        },
        body: requestBody,
        persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });
    const tokenResponseRun = await runResponseCase({
        url: "https://trakt.tv/oauth/token",
        requestBody,
        headers: {
            "content-type": "application/json",
        },
        body: JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 604800 }),
        persistentData: tokenRequestRun.persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    const tokens = readTamperTokens(tokenResponseRun.persistentData);
    assert.equal(tokens.length, limit);
    assert.equal(
        tokens.some((token) => token.accessToken === "dead-access"),
        false,
        "无 refresh_token 的过期记录应优先淘汰",
    );
    assert.ok(tokens.some((token) => token.accessToken === "new-access"));
});

// QX 实机实测：script-request-body 可同时返回 {body, headers, path}，
// 因此不再需要并行的 script-request-header 规则；跨域 url 会被半套用，统一改用 path。
// QX 实机结论：request-body 可同时返回 {body, headers, path}，但不支持跨域 url；
// 这条用例把「一次调用改完三样」与「不返回跨域 url」两个能力边界固定下来。
test("QX 请求体脚本不返回跨域 url，只返回同域 path", async () => {
    const { result } = await runRequestCase({
        url: "https://auth.trakt.tv/oauth/token",
        headers: {
            "content-type": "application/json",
            "trakt-api-key": "old-client",
        },
        body: JSON.stringify({ client_id: "old-client", refresh_token: "refresh-1", grant_type: "refresh_token" }),
        environment: "qx",
        persistentData: createTamperPersistentData({
            tokens: [createTamperTokenRecord("access-1", "refresh-1", { clientId: "old-client" })],
        }),
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(Object.hasOwn(result, "url"), false, "QX 下不得返回 url（跨域会被半套用）");
    assert.equal(result.path, "/oauth/token", "应返回同域 path");
    assert.equal(result.headers["trakt-api-key"], TRAKT_TAMPER_CLIENT_ID, "headers 应同时生效");
    assert.equal(JSON.parse(result.body).client_id, TRAKT_TAMPER_CLIENT_ID, "body 应同时生效");
});

test("QX 请求体脚本一次返回 body、headers 与 path", async () => {
    const { result } = await runRequestCase({
        url: "https://api.trakt.tv/oauth/device/code",
        headers: {
            "content-type": "application/json",
            "trakt-api-key": "old-client",
        },
        body: JSON.stringify({ client_id: "old-client" }),
        environment: "qx",
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(JSON.parse(result.body).client_id, TRAKT_TAMPER_CLIENT_ID, "body 应被改写");
    assert.equal(result.headers["trakt-api-key"], TRAKT_TAMPER_CLIENT_ID, "headers 应与 body 在同一次调用里改写");
    assert.equal(result.path, "/oauth/device/code", "QX 下应返回 path 而不是 url");
    assert.equal(Object.hasOwn(result, "url"), false, "QX 下不应返回 url");
});

test("QX 下 token 请求的 body、headers、query 一次改写完成", async () => {
    const persistentData = createTamperPersistentData({
        tokens: [createTamperTokenRecord("access-1", "refresh-1", { clientId: "old-client" })],
    });
    const { result } = await runRequestCase({
        url: "https://trakt.tv/oauth/token?client_id=old-client&client_secret=secret&redirect_uri=thirdparty%3A%2F%2Foauth%2Fcallback",
        headers: {
            "content-type": "application/json",
            "trakt-api-key": "old-client",
        },
        body: JSON.stringify({ client_id: "old-client", refresh_token: "refresh-1", grant_type: "refresh_token" }),
        environment: "qx",
        persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(result.headers["trakt-api-key"], TRAKT_TAMPER_CLIENT_ID);
    assert.equal(JSON.parse(result.body).client_id, TRAKT_TAMPER_CLIENT_ID);

    const target = new URL(result.path, "https://trakt.tv");
    assert.equal(target.searchParams.get("client_id"), TRAKT_TAMPER_CLIENT_ID);
    assert.equal(target.searchParams.get("client_secret"), null);
    assert.equal(target.searchParams.get("redirect_uri"), TRAKT_TAMPER_REDIRECT_URI);
});

// QX 的跨域 url 会被半套用（Host 换掉但 path/query 不换），授权页必须同域改写
test("QX 下授权页保持原域名只改写 query", async () => {
    const { result } = await runRequestCase({
        url: "https://trakt.tv/oauth/authorize?response_type=code&client_id=old-client&redirect_uri=thirdparty%3A%2F%2Foauth%2Fcallback",
        environment: "qx",
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(Object.hasOwn(result, "url"), false, "QX 下不应返回跨域 url");
    assert.ok(result.path.startsWith("/oauth/authorize?"), "应返回同域 path");
    const target = new URL(result.path, "https://trakt.tv");
    assert.equal(target.searchParams.get("client_id"), TRAKT_TAMPER_CLIENT_ID);
    assert.equal(target.searchParams.get("redirect_uri"), TRAKT_TAMPER_REDIRECT_URI);
});

test("QX 下没有篡改痕迹的 token 请求会放行", async () => {
    const { result } = await runRequestCase({
        url: "https://trakt.tv/oauth/token",
        headers: {
            "content-type": "application/json",
            "trakt-api-key": "old-client",
        },
        body: JSON.stringify({ client_id: "old-client", refresh_token: "unknown-refresh", grant_type: "refresh_token" }),
        environment: "qx",
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(Object.keys(result).length, 0, "refresh_token 未命中记录时不应改写");
});

test("QX 下按已签发 token 的 client 改写 refresh 请求", async () => {
    const persistentData = createTamperPersistentData({
        tokens: [createTamperTokenRecord("access-1", "refresh-1", { clientId: "old-client" })],
    });
    const { result } = await runRequestCase({
        url: "https://trakt.tv/oauth/token",
        headers: {
            "content-type": "application/json",
            "trakt-api-key": "old-client",
        },
        body: JSON.stringify({ client_id: "old-client", refresh_token: "refresh-1", grant_type: "refresh_token" }),
        environment: "qx",
        persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(result.headers["trakt-api-key"], TRAKT_TAMPER_CLIENT_ID);
    assert.equal(JSON.parse(result.body).client_id, TRAKT_TAMPER_CLIENT_ID);
});

// QX build 954 实测：script-request-body 在空 body/GET 也会执行；
// 空 body 时仍只改 query/headers，不合成 body（官方 sample.conf 第 290 行已过时）。
test("QX 空 body 的 token 请求由请求体脚本改写 query/headers 且不合成 body", async () => {
    const persistentData = createTamperPersistentData({
        tokens: [createTamperTokenRecord("access-1", "refresh-1", { clientId: "old-client" })],
    });
    const { result } = await runRequestCase({
        url: "https://trakt.tv/oauth/token?client_id=old-client&client_secret=secret&redirect_uri=thirdparty%3A%2F%2Foauth%2Fcallback&refresh_token=refresh-1&grant_type=refresh_token",
        headers: {
            "content-type": "application/json",
            "trakt-api-key": "old-client",
        },
        body: "",
        environment: "qx",
        persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(result.headers["trakt-api-key"], TRAKT_TAMPER_CLIENT_ID, "应补写 trakt-api-key");
    assert.equal(Object.hasOwn(result, "body"), false, "空 body 时不合成 body");
    assert.equal(Object.hasOwn(result, "url"), false, "QX 下不应返回 url");

    const target = new URL(result.path, "https://trakt.tv");
    assert.equal(target.searchParams.get("client_id"), TRAKT_TAMPER_CLIENT_ID);
    assert.equal(target.searchParams.get("client_secret"), null);
    assert.equal(target.searchParams.get("redirect_uri"), TRAKT_TAMPER_REDIRECT_URI);
});

test("QX 空 body 的 device/code 请求会改写 query 并写入 device_flow", async () => {
    const { result, persistentData } = await runRequestCase({
        url: "https://api.trakt.tv/oauth/device/code?client_id=old-client",
        headers: {
            "content-type": "application/json",
            "trakt-api-key": "old-client",
        },
        body: "",
        environment: "qx",
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(Object.hasOwn(result, "body"), false, "空 body 时不合成 body");
    assert.equal(result.path, `/oauth/device/code?client_id=${TRAKT_TAMPER_CLIENT_ID}`);
    assert.ok(
        readTamperStore(persistentData).pending.some((entry) => entry.kind === "device_flow" && entry.clientId === "old-client"),
        "device_flow 应写入 pending",
    );
});

test("$request.body 缺失时只改 query/headers、不合成 body", async () => {
    const persistentData = createTamperPersistentData({
        tokens: [createTamperTokenRecord("access-1", "refresh-1", { clientId: "old-client" })],
    });
    const { result } = await runRequestCase({
        url: "https://trakt.tv/oauth/token?client_id=old-client&refresh_token=refresh-1&grant_type=refresh_token",
        headers: {
            "trakt-api-key": "old-client",
        },
        environment: "qx",
        omitRequestBody: true,
        persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(result.headers["trakt-api-key"], TRAKT_TAMPER_CLIENT_ID);
    assert.equal(Object.hasOwn(result, "body"), false, "无请求体时不合成 body");
});

test("QX 空 body 时识别不出第三方 client 则放行", async () => {
    const { result } = await runRequestCase({
        url: "https://api.trakt.tv/oauth/device/code",
        headers: {
            "content-type": "application/json",
        },
        body: "",
        environment: "qx",
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(Object.keys(result).length, 0, "无法识别 client 时不应改写");
});

test("QX 空 body 时 query 形式禁用 redirect_uri 的 token 请求放行", async () => {
    const persistentData = createTamperPersistentData({
        tokens: [createTamperTokenRecord("access-1", "refresh-1", { clientId: "old-client" })],
    });
    const { result } = await runRequestCase({
        url: `https://trakt.tv/oauth/token?client_id=old-client&redirect_uri=${encodeURIComponent("rex://oauth/callback")}`,
        body: "",
        environment: "qx",
        persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(Object.keys(result).length, 0, "禁用篡改的 redirect_uri 应直接放行");
});

test("篡改应用授权在 QX 下遇到禁用篡改的 redirect_uri 时不写流程状态", async () => {
    const { persistentData, result } = await runRequestCase({
        url: `https://trakt.tv/oauth/authorize?response_type=code&client_id=rex-client&redirect_uri=${encodeURIComponent("rex://oauth/callback")}&state=original-state`,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(Object.keys(result).length, 0, "禁用篡改的 redirect_uri 应直接放行");
    assert.equal(readTamperStore(persistentData).records.length, 0, "放行的授权请求不应写流程状态");
});

test("篡改应用授权在 QX 请求体脚本里仍然改写 body 与 trakt-api-key", async () => {
    const { result } = await runRequestCase({
        url: "https://api.trakt.tv/oauth/device/code",
        headers: {
            "content-type": "application/json",
            "trakt-api-key": "old-client",
        },
        body: JSON.stringify({ client_id: "old-client" }),
        environment: "qx",
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    assert.equal(result.headers["trakt-api-key"], TRAKT_TAMPER_CLIENT_ID);
    assert.equal(JSON.parse(result.body).client_id, TRAKT_TAMPER_CLIENT_ID);
});

// QX 的 script-response-body 拿不到 $request.body：靠 sessionIndex 精确关联，避免并发授权时串号
test("篡改应用授权在 QX 响应阶段按 sessionIndex 精确命中 pending", async () => {
    const persistentData = createTamperPersistentData({
        pending: [
            {
                kind: "authorization_code",
                id: "code-a",
                clientId: "client-a",
                sessionIndex: "session-a",
                createdAt: Date.now(),
                expiresAt: Date.now() + 60 * 1000,
            },
            {
                kind: "authorization_code",
                id: "code-b",
                clientId: "client-b",
                sessionIndex: "session-b",
                createdAt: Date.now(),
                expiresAt: Date.now() + 60 * 1000,
            },
        ],
    });

    const { persistentData: nextPersistentData } = await runResponseCase({
        url: "https://trakt.tv/oauth/token",
        headers: {
            "content-type": "application/json",
        },
        body: JSON.stringify({ access_token: "access-b", refresh_token: "refresh-b", expires_in: 604800 }),
        environment: "qx",
        omitRequestBody: true,
        requestSessionIndex: "session-b",
        responseSessionIndex: "session-b",
        persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    const store = readTamperStore(nextPersistentData);
    assert.equal(store.tokens.length, 1);
    assert.equal(store.tokens[0].accessToken, "access-b");
    assert.equal(store.tokens[0].clientId, "client-b", "应关联到 sessionIndex 对应的流程");
    const pendingIds = store.pending.map((entry) => String(entry.id));
    assert.ok(pendingIds.includes("code-a"), "未命中的流程状态应保留");
    assert.equal(pendingIds.includes("code-b"), false, "命中的 pending 应被消费");
});

test("篡改应用授权在 QX 响应阶段拿不到请求体时按唯一 pending 兜底", async () => {
    const persistentData = createTamperPersistentData({
        pending: [
            {
                kind: "device_code",
                id: "device-code",
                clientId: "old-client",
                createdAt: Date.now(),
                expiresAt: Date.now() + 60 * 1000,
            },
        ],
    });

    const { persistentData: nextPersistentData } = await runResponseCase({
        url: "https://api.trakt.tv/oauth/device/token",
        headers: {
            "content-type": "application/json",
        },
        body: JSON.stringify({ access_token: "device-access", refresh_token: "device-refresh", expires_in: 604800 }),
        environment: "qx",
        omitRequestBody: true,
        persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    const tokens = readTamperTokens(nextPersistentData);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].accessToken, "device-access");
    assert.equal(tokens[0].clientId, "old-client");
});

// 兜底匹配必须同时看「请求路径对应的 pending 类型」和「client」，否则会把别的 App 的 token 响应算进篡改流程
test("篡改应用授权拿不到请求体时不会用 device_code pending 消费 token 响应", async () => {
    const persistentData = createTamperPersistentData({
        pending: [
            {
                kind: "device_code",
                id: "device-code",
                clientId: "old-client",
                createdAt: Date.now(),
                expiresAt: Date.now() + 10 * 60 * 1000,
            },
        ],
    });

    const { persistentData: nextPersistentData } = await runResponseCase({
        url: "https://trakt.tv/oauth/token",
        headers: {
            "content-type": "application/json",
            "trakt-api-key": "old-client",
        },
        body: JSON.stringify({ access_token: "other-app-access", refresh_token: "other-app-refresh", expires_in: 604800 }),
        environment: "qx",
        omitRequestBody: true,
        persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    const store = readTamperStore(nextPersistentData);
    assert.equal(store.tokens.length, 0, "oauth/token 的响应不应消费 device_code pending");
    assert.equal(store.pending.length, 1, "未命中的 device_code pending 应保留");
});

test("篡改应用授权拿不到请求体时 client 不一致的 device/token 响应不会消费 pending", async () => {
    const persistentData = createTamperPersistentData({
        pending: [
            {
                kind: "device_code",
                id: "device-code",
                clientId: "app-a",
                createdAt: Date.now(),
                expiresAt: Date.now() + 10 * 60 * 1000,
            },
        ],
    });

    const { persistentData: nextPersistentData } = await runResponseCase({
        url: "https://api.trakt.tv/oauth/device/token",
        headers: {
            "content-type": "application/json",
            "trakt-api-key": "app-b",
        },
        body: JSON.stringify({ access_token: "app-b-access", refresh_token: "app-b-refresh", expires_in: 604800 }),
        environment: "qx",
        omitRequestBody: true,
        persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    const store = readTamperStore(nextPersistentData);
    assert.equal(store.tokens.length, 0, "client 不一致时不应把 token 记成篡改流程签发");
    assert.equal(store.pending.length, 1, "未命中的 device_code pending 应保留");
});

test("篡改应用授权拿不到请求体时仍能按 client 命中 device/token 的 pending", async () => {
    const persistentData = createTamperPersistentData({
        pending: [
            {
                kind: "device_code",
                id: "device-code-a",
                clientId: "app-a",
                createdAt: Date.now(),
                expiresAt: Date.now() + 10 * 60 * 1000,
            },
            {
                kind: "authorization_code",
                id: "code-b",
                clientId: "app-b",
                createdAt: Date.now(),
                expiresAt: Date.now() + 60 * 1000,
            },
        ],
    });

    const { persistentData: nextPersistentData } = await runResponseCase({
        url: "https://api.trakt.tv/oauth/device/token",
        headers: {
            "content-type": "application/json",
            "trakt-api-key": "app-a",
        },
        body: JSON.stringify({ access_token: "device-access-a", refresh_token: "device-refresh-a", expires_in: 604800 }),
        environment: "qx",
        omitRequestBody: true,
        persistentData,
        argument: {
            tamperAppAuthorizationEnabled: true,
        },
    });

    const store = readTamperStore(nextPersistentData);
    assert.equal(store.tokens.length, 1);
    assert.equal(store.tokens[0].accessToken, "device-access-a");
    assert.equal(store.tokens[0].clientId, "app-a");
    assert.deepEqual(
        store.pending.map((entry) => String(entry.id)),
        ["code-b"],
        "只消费命中 client 的 device_code pending",
    );
});
