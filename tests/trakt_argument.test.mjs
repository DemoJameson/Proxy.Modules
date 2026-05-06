import assert from "node:assert/strict";
import test from "node:test";

import { WATCHNOW_REDIRECT_URL } from "../trakt_simplified_chinese/src/features/player-injection-trakt.mjs";

import { createUnifiedPersistentData, parseUnifiedCache, readFixture, runRequestCase, runResponseCase } from "./helpers/trakt-test-helpers.mjs";

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

test("useShortcutsJumpEnabled=true 时 redirect 请求会返回 shortcuts jump", async () => {
    const { result } = await runRequestCase({
        url: `${WATCHNOW_REDIRECT_URL}?deeplink=infuse%3A%2F%2Fmovie%2F456`,
        argument: {
            useShortcutsJumpEnabled: true,
        },
    });

    assert.equal(result.response.status, 302);
    assert.equal(result.response.headers.Location, "shortcuts://run-shortcut?name=%E6%89%93%E5%BC%80%E9%93%BE%E6%8E%A5&input=text&text=infuse%3A%2F%2Fmovie%2F456");
});

test("useShortcutsJumpEnabled=false 时 redirect 请求直接返回原 deeplink", async () => {
    const { result } = await runRequestCase({
        url: `${WATCHNOW_REDIRECT_URL}?deeplink=infuse%3A%2F%2Fmovie%2F456`,
        argument: {
            useShortcutsJumpEnabled: false,
        },
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
        httpLogs.some((entry) => entry.method === "POST" && entry.url === "https://translation.googleapis.com/language/translate/v2"),
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
            "https://translation.googleapis.com/language/translate/v2": JSON.stringify({
                data: {
                    translations: [{ translatedText: "很棒的电影" }],
                },
            }),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].comment, "很棒的电影");
    assert.equal(parseUnifiedCache(persistentData).google.comments["9001"].comment.translatedText, "很棒的电影");
    assert.equal(
        httpLogs.some((entry) => entry.method === "POST" && entry.url === "https://translation.googleapis.com/language/translate/v2"),
        true,
    );
});

test("关闭全部 player button 时 /movies/:id/watchnow 不注入自定义播放器条目", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/watchnow",
        body: readFixture("movie-watchnow.json"),
        argument: {
            eplayerxEnabled: false,
            forwardEnabled: false,
            infuseEnabled: false,
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

test("仅开启 forward 时 /movies/:id/watchnow 只注入 forward 条目", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/watchnow",
        body: readFixture("movie-watchnow.json"),
        argument: {
            eplayerxEnabled: false,
            forwardEnabled: true,
            infuseEnabled: false,
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
