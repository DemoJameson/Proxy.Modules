import assert from "node:assert/strict";
import test from "node:test";

import { applyArgumentObjectConfig, applyArgumentStringConfig, createDefaultArgumentConfig, normalizeArgument } from "../trakt_simplified_chinese/src/argument.mjs";
import { WATCHNOW_REDIRECT_URL } from "../trakt_simplified_chinese/src/features/player-injection-trakt.mjs";
import { DEEPLX_TRANSLATE_API_URL as DEEPLX_TRANSLATE_URL } from "../trakt_simplified_chinese/src/outbound/google-translate-client.mjs";

import { createUnifiedPersistentData, parseUnifiedCache, readFixture, runRequestCase, runResponseCase } from "./helpers/trakt-test-helpers.mjs";

test("字符串参数第 0 位解析为 fakeVipEnabled，第 1 位解析为 posterImageMode，第 5-7 位解析为 *Order 数字", () => {
    const parsed = normalizeArgument(applyArgumentStringConfig(createDefaultArgumentConfig(), "[true,original,true,true,false,2,1,3]"));

    assert.equal(parsed.fakeVipEnabled, true);
    assert.equal(parsed.posterImageMode, "original");
    assert.equal(parsed.historyEpisodesMergedByShow, true);
    assert.equal(parsed.googleTranslationEnabled, true);
    assert.equal(parsed.characterTranslationEnabled, false);
    assert.equal(parsed.playerButtonOrder.eplayerx, 2);
    assert.equal(parsed.playerButtonOrder.forward, 1);
    assert.equal(parsed.playerButtonOrder.infuse, 3);
    assert.deepEqual(parsed.orderedPlayerTypes, ["forward", "eplayerx", "infuse"]);
    assert.deepEqual(parsed.enabledPlayerTypes, ["forward", "eplayerx", "infuse"]);
});

test("characterTranslationEnabled 默认开启，且位于 googleTranslationEnabled 后一位", () => {
    const defaults = normalizeArgument(createDefaultArgumentConfig());
    assert.equal(defaults.characterTranslationEnabled, true);

    const parsed = normalizeArgument(applyArgumentStringConfig(createDefaultArgumentConfig(), "[true,original,true,true,false]"));
    assert.equal(parsed.googleTranslationEnabled, true);
    assert.equal(parsed.characterTranslationEnabled, false);
    assert.equal(parsed.playerButtonOrder.eplayerx, 1);
    assert.deepEqual(parsed.orderedPlayerTypes, ["eplayerx", "forward", "infuse"]);
    assert.deepEqual(parsed.enabledPlayerTypes, ["eplayerx", "forward", "infuse"]);
});

test("*Order 默认值为 1/2/3，非法值回落到默认序号", () => {
    const defaults = normalizeArgument(createDefaultArgumentConfig());
    assert.equal(defaults.playerButtonOrder.eplayerx, 1);
    assert.equal(defaults.playerButtonOrder.forward, 2);
    assert.equal(defaults.playerButtonOrder.infuse, 3);

    const parsed = normalizeArgument(applyArgumentStringConfig(createDefaultArgumentConfig(), "[true,original,true,true,false,abc,NaN,2.5]"));
    assert.equal(parsed.playerButtonOrder.eplayerx, 1);
    assert.equal(parsed.playerButtonOrder.forward, 2);
    assert.equal(parsed.playerButtonOrder.infuse, 2);
});

test("序号 0 在 enabledPlayerTypes 中隐藏，但仍保留在 orderedPlayerTypes 末尾", () => {
    const parsed = normalizeArgument(applyArgumentStringConfig(createDefaultArgumentConfig(), "[true,original,true,true,false,0,2,1]"));
    assert.equal(parsed.playerButtonOrder.eplayerx, 0);
    assert.equal(parsed.playerButtonOrder.forward, 2);
    assert.equal(parsed.playerButtonOrder.infuse, 1);
    assert.deepEqual(parsed.orderedPlayerTypes, ["infuse", "forward", "eplayerx"]);
    assert.deepEqual(parsed.enabledPlayerTypes, ["infuse", "forward"]);
});

test("全部序号相同（含 0）时按 PLAYER_TYPE 声明顺序稳定排序", () => {
    const parsed = normalizeArgument(
        applyArgumentObjectConfig(createDefaultArgumentConfig(), {
            eplayerxOrder: 5,
            forwardOrder: 5,
            infuseOrder: 0,
        }),
    );
    assert.deepEqual(parsed.orderedPlayerTypes, ["eplayerx", "forward", "infuse"]);
    assert.deepEqual(parsed.enabledPlayerTypes, ["eplayerx", "forward"]);
});

test("posterImageMode 非法值回退 original", () => {
    const parsed = normalizeArgument(applyArgumentStringConfig(createDefaultArgumentConfig(), "[true,bogus]"));

    assert.equal(parsed.posterImageMode, "original");
});

test("posterImageMode 支持中文选项标签", () => {
    const parsed = normalizeArgument(applyArgumentStringConfig(createDefaultArgumentConfig(), "[true,原片语言]"));
    const defaultParsed = normalizeArgument(applyArgumentStringConfig(createDefaultArgumentConfig(), "[true,原图]"));

    assert.equal(parsed.posterImageMode, "original");
    assert.equal(defaultParsed.posterImageMode, "default");
});

test("historyEpisodesMergedByShow=false 时历史剧集请求不改写 limit", async () => {
    const { result } = await runRequestCase({
        url: "https://api.trakt.tv/users/me/history/episodes?page=1&limit=10",
        argument: {
            historyEpisodesMergedByShow: false,
        },
    });

    assert.equal(Object.keys(result).length, 0);
});

test("historyEpisodesMergedByShow=true 时历史剧集请求会改写到最小 limit", async () => {
    const { result } = await runRequestCase({
        url: "https://api.trakt.tv/users/me/history/episodes?page=1&limit=10",
        headers: {
            "user-agent": "Trakt/1.0",
        },
        argument: {
            historyEpisodesMergedByShow: true,
        },
    });

    assert.equal(result.url, "https://api.trakt.tv/users/me/history/episodes?page=1&limit=500");
});

test("redirect 请求直接返回原 deeplink", async () => {
    const { result } = await runRequestCase({
        url: `${WATCHNOW_REDIRECT_URL}?deeplink=infuse%3A%2F%2Fmovie%2F456`,
    });

    assert.equal(result.response.status, 302);
    assert.equal(result.response.headers.Location, "infuse://movie/456");
});

test("googleTranslationEnabled=false 时 comments 不触发 Google 翻译且保留原文", async () => {
    const { result, persistentData, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/comments/123/replies",
        body: readFixture("comments.json"),
        argument: {
            googleTranslationEnabled: false,
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].comment, "Great movie");
    assert.deepEqual(parseUnifiedCache(persistentData).google.comments, {});
    assert.equal(
        httpLogs.some((entry) => entry.method === "POST" && entry.url === DEEPLX_TRANSLATE_URL),
        false,
    );
});

test("googleTranslationEnabled=true 时 comments 会请求 Google 翻译并写回缓存", async () => {
    const { result, persistentData, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/comments/123/replies",
        body: readFixture("comments.json"),
        argument: {
            googleTranslationEnabled: true,
        },
        httpPostMocks: {
            [DEEPLX_TRANSLATE_URL]: JSON.stringify({ data: "很棒的电影" }),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].comment, "很棒的电影");
    assert.equal(parseUnifiedCache(persistentData).google.comments["9001"].comment.translatedText, "很棒的电影");
    assert.equal(
        httpLogs.some((entry) => entry.method === "POST" && entry.url === DEEPLX_TRANSLATE_URL),
        true,
    );
});

test("全部序号为 0 时 /movies/:id/watchnow 不注入自定义播放器条目", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/watchnow",
        body: readFixture("movie-watchnow.json"),
        argument: {
            eplayerxOrder: 0,
            forwardOrder: 0,
            infuseOrder: 0,
        },
        persistentData: createUnifiedPersistentData({
            traktLinkIds: {
                123: {
                    ids: {
                        trakt: 123,
                        tmdb: 456,
                    },
                },
            },
        }),
    });

    const payload = JSON.parse(result.body);
    assert.deepEqual(
        payload.us.free.map((item) => item.source),
        ["hulu"],
    );
});

test("仅 forward 序号非 0 时 /movies/:id/watchnow 只注入 forward 条目", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/watchnow",
        body: readFixture("movie-watchnow.json"),
        argument: {
            eplayerxOrder: 0,
            forwardOrder: 1,
            infuseOrder: 0,
        },
        persistentData: createUnifiedPersistentData({
            traktLinkIds: {
                123: {
                    ids: {
                        trakt: 123,
                        tmdb: 456,
                    },
                },
            },
        }),
    });

    const payload = JSON.parse(result.body);
    assert.deepEqual(
        payload.us.free.map((item) => item.source),
        ["forward", "hulu"],
    );
});

test("backendBaseUrl 参数会影响媒体翻译后端读取地址，且后端 query 会规范化排序", async () => {
    const backendBody = JSON.stringify([
        { title: "Movie 126", overview: "Overview 126", tagline: "Tagline 126", ids: { trakt: 126 }, available_translations: ["en", "zh"] },
        { title: "Movie 123", overview: "Overview 123", tagline: "Tagline 123", ids: { trakt: 123 }, available_translations: ["en", "zh"] },
        { title: "Movie 125", overview: "Overview 125", tagline: "Tagline 125", ids: { trakt: 125 }, available_translations: ["en", "zh"] },
        { title: "Movie 124", overview: "Overview 124", tagline: "Tagline 124", ids: { trakt: 124 }, available_translations: ["en", "zh"] },
    ]);

    const { result, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/recommendations/movies",
        body: backendBody,
        argument: {
            backendBaseUrl: "https://demo.example/custom",
        },
        httpGetMocks: {
            "https://demo.example/custom/api/trakt/translations?movies=123,124,125,126": JSON.stringify({
                movies: {
                    123: {
                        status: 1,
                        translation: {
                            title: "后端中文标题",
                            overview: "后端中文简介",
                            tagline: "后端中文标语",
                        },
                    },
                },
            }),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.find((item) => item?.ids?.trakt === 123)?.title, "后端中文标题");
    assert.equal(
        httpLogs.some((entry) => entry.method === "GET" && entry.url === "https://demo.example/custom/api/trakt/translations?movies=123,124,125,126"),
        true,
    );
});
