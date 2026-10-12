import assert from "node:assert/strict";
import test from "node:test";

import {
    ARGUMENT_FIELDS,
    applyArgumentObjectConfig,
    applyArgumentStringConfig,
    createDefaultArgumentConfig,
    normalizeArgument,
} from "../trakt_simplified_chinese/src/argument.mjs";
import { WATCHNOW_REDIRECT_URL } from "../trakt_simplified_chinese/src/features/player-injection-trakt.mjs";
import { DEEPLX_TRANSLATE_API_URL as DEEPLX_TRANSLATE_URL } from "../trakt_simplified_chinese/src/outbound/deeplx-translate-client.mjs";

import { createUnifiedPersistentData, parseUnifiedCache, readFixture, runRequestCase, runResponseCase } from "./helpers/trakt-test-helpers.mjs";

test("字符串参数第 0 位解析为 fakeVipEnabled，第 1 位 chineseLocale，第 2 位 posterImageMode，第 6-8 位为 *Order 数字", () => {
    const parsed = normalizeArgument(applyArgumentStringConfig(createDefaultArgumentConfig(), "[true,cn,original,google,false,true,2,1,3]"));

    assert.equal(parsed.fakeVipEnabled, true);
    assert.equal(parsed.posterImageMode, "original");
    assert.equal(parsed.historyEpisodesMergedByShow, true);
    assert.equal(parsed.translationEngine, "google");
    assert.equal(parsed.characterTranslationEnabled, false);
    assert.equal(parsed.playerButtonOrder.forward, 2);
    assert.equal(parsed.playerButtonOrder.infuse, 1);
    assert.equal(parsed.playerButtonOrder.rex, 3);
    assert.deepEqual(parsed.orderedPlayerTypes, ["infuse", "forward", "rex"]);
    assert.deepEqual(parsed.enabledPlayerTypes, ["infuse", "forward", "rex"]);
});

test("translationEngine 位于 characterTranslationEnabled 前，历史合并位于其后面", () => {
    assert.equal(ARGUMENT_FIELDS[3].key, "translationEngine");
    assert.equal(ARGUMENT_FIELDS[4].key, "characterTranslationEnabled");
    assert.equal(ARGUMENT_FIELDS[5].key, "historyEpisodesMergedByShow");

    const defaults = normalizeArgument(createDefaultArgumentConfig());
    assert.equal(defaults.characterTranslationEnabled, true);

    const parsed = normalizeArgument(applyArgumentStringConfig(createDefaultArgumentConfig(), "[true,cn,original,google,false,true]"));
    assert.equal(parsed.translationEngine, "google");
    assert.equal(parsed.characterTranslationEnabled, false);
    assert.equal(parsed.historyEpisodesMergedByShow, true);
    assert.equal(parsed.playerButtonOrder.forward, 1);
    assert.deepEqual(parsed.orderedPlayerTypes, ["forward", "infuse", "rex"]);
    assert.deepEqual(parsed.enabledPlayerTypes, ["forward", "infuse", "rex"]);
});

test("*Order 默认值为 1/2/3，非法值回落到默认序号", () => {
    const defaults = normalizeArgument(createDefaultArgumentConfig());
    assert.equal(defaults.playerButtonOrder.forward, 1);
    assert.equal(defaults.playerButtonOrder.infuse, 2);
    assert.equal(defaults.playerButtonOrder.rex, 3);

    const parsed = normalizeArgument(applyArgumentStringConfig(createDefaultArgumentConfig(), "[true,cn,original,google,false,true,abc,NaN,2.5]"));
    assert.equal(parsed.playerButtonOrder.forward, 1);
    assert.equal(parsed.playerButtonOrder.infuse, 2);
    assert.equal(parsed.playerButtonOrder.rex, 2);
});

test("序号 0 在 enabledPlayerTypes 中隐藏，但仍保留在 orderedPlayerTypes 末尾", () => {
    const parsed = normalizeArgument(applyArgumentStringConfig(createDefaultArgumentConfig(), "[true,cn,original,google,false,true,0,2,1]"));
    assert.equal(parsed.playerButtonOrder.forward, 0);
    assert.equal(parsed.playerButtonOrder.infuse, 2);
    assert.equal(parsed.playerButtonOrder.rex, 1);
    assert.deepEqual(parsed.orderedPlayerTypes, ["rex", "infuse", "forward"]);
    assert.deepEqual(parsed.enabledPlayerTypes, ["rex", "infuse"]);
});

test("全部序号相同（含 0）时按 PLAYER_TYPE 声明顺序稳定排序", () => {
    const parsed = normalizeArgument(
        applyArgumentObjectConfig(createDefaultArgumentConfig(), {
            forwardButtonOrder: 5,
            infuseButtonOrder: 0,
            rexButtonOrder: 5,
        }),
    );
    assert.deepEqual(parsed.orderedPlayerTypes, ["forward", "rex", "infuse"]);
    assert.deepEqual(parsed.enabledPlayerTypes, ["forward", "rex"]);
});

test("fakeVipEnabled 是配置第一项，chineseLocale 是第二项，只解析新显示标签", () => {
    assert.equal(ARGUMENT_FIELDS[0].key, "fakeVipEnabled");
    assert.equal(ARGUMENT_FIELDS[1].key, "chineseLocale");

    const defaults = normalizeArgument(createDefaultArgumentConfig());
    assert.equal(defaults.chineseLocale, "cn");

    const cnLabel = normalizeArgument(applyArgumentObjectConfig(createDefaultArgumentConfig(), { chineseLocale: "简体中文" }));
    assert.equal(cnLabel.chineseLocale, "cn");
    const twLabel = normalizeArgument(applyArgumentObjectConfig(createDefaultArgumentConfig(), { chineseLocale: "繁體中文（台灣）" }));
    assert.equal(twLabel.chineseLocale, "tw");
    const hkLabel = normalizeArgument(applyArgumentObjectConfig(createDefaultArgumentConfig(), { chineseLocale: "繁體中文（香港）" }));
    assert.equal(hkLabel.chineseLocale, "hk");
    const legacyCn = normalizeArgument(applyArgumentObjectConfig(createDefaultArgumentConfig(), { chineseLocale: "中文（简体）" }));
    assert.equal(legacyCn.chineseLocale, "cn");
    const legacyTw = normalizeArgument(applyArgumentObjectConfig(createDefaultArgumentConfig(), { chineseLocale: "中文（繁体·台湾）" }));
    assert.equal(legacyTw.chineseLocale, "cn");
    const legacyHk = normalizeArgument(applyArgumentObjectConfig(createDefaultArgumentConfig(), { chineseLocale: "繁體（香港）" }));
    assert.equal(legacyHk.chineseLocale, "cn");
    const bogus = normalizeArgument(applyArgumentObjectConfig(createDefaultArgumentConfig(), { chineseLocale: "bogus" }));
    assert.equal(bogus.chineseLocale, "cn");
});

test("位置参数只按当前顺序解析（首项为 fakeVipEnabled，第二项为目标语言），不再兼容历史顺序", () => {
    const parsed = normalizeArgument(applyArgumentStringConfig(createDefaultArgumentConfig(), "[true,tw,original,google,true,true,1,2,3,https://backend.example,false,关闭]"));
    assert.equal(parsed.fakeVipEnabled, true);
    assert.equal(parsed.chineseLocale, "tw");
    assert.equal(parsed.posterImageMode, "original");
    assert.equal(parsed.translationEngine, "google");
    assert.equal(parsed.characterTranslationEnabled, true);
    assert.equal(parsed.historyEpisodesMergedByShow, true);
    assert.equal(parsed.debugMode, "off");
    assert.equal(parsed.backendBaseUrl, "https://backend.example");

    // 旧顺序（首项为 chineseLocale）不再识别：首项被当作 fakeVipEnabled，第二项被当作 chineseLocale 并回落 cn
    const legacyOrder = normalizeArgument(applyArgumentStringConfig(createDefaultArgumentConfig(), "[tw,true,original,true,google,true,1,2,3,https://backend.example,false,关闭]"));
    assert.equal(legacyOrder.fakeVipEnabled, true);
    assert.equal(legacyOrder.chineseLocale, "cn");
    assert.equal(legacyOrder.debugMode, "off");
    assert.equal(legacyOrder.tamperAppAuthorizationEnabled, false);
});

test("字符串参数兼容平台包裹：Loon 方括号、Surge 双引号与逐项引号", () => {
    const base = "true,繁體中文（台灣）,原片语言,谷歌翻译,true,true,1,2,3,https://backend.example,false,关闭";
    const wrappedArguments = [
        `[${base}]`,
        `"${base}"`,
        `'${base}'`,
        '"true","繁體中文（台灣）","原片语言","谷歌翻译","true","true","1","2","3","https://backend.example","false","关闭"',
    ];

    for (const wrapped of wrappedArguments) {
        const parsed = normalizeArgument(applyArgumentStringConfig(createDefaultArgumentConfig(), wrapped));
        assert.equal(parsed.fakeVipEnabled, true, `fakeVipEnabled 解析失败：${wrapped}`);
        assert.equal(parsed.chineseLocale, "tw", `chineseLocale 解析失败：${wrapped}`);
        assert.equal(parsed.posterImageMode, "original", `posterImageMode 解析失败：${wrapped}`);
        assert.equal(parsed.translationEngine, "google", `translationEngine 解析失败：${wrapped}`);
        assert.equal(parsed.debugMode, "off", `debugMode 解析失败：${wrapped}`);
        assert.equal(parsed.backendBaseUrl, "https://backend.example", `backendBaseUrl 解析失败：${wrapped}`);
    }
});

test("posterImageMode 解析当前显示标签", () => {
    const cn = normalizeArgument(applyArgumentObjectConfig(createDefaultArgumentConfig(), { posterImageMode: "简体中文" }));
    assert.equal(cn.posterImageMode, "cn");
    const tw = normalizeArgument(applyArgumentObjectConfig(createDefaultArgumentConfig(), { posterImageMode: "繁體中文（台灣）" }));
    assert.equal(tw.posterImageMode, "tw");
    const hk = normalizeArgument(applyArgumentObjectConfig(createDefaultArgumentConfig(), { posterImageMode: "繁體中文（香港）" }));
    assert.equal(hk.posterImageMode, "hk");
});

test("posterImageMode 兼容旧标签与旧值：中文/chinese → cn，默认 → default", () => {
    const legacyChinese = normalizeArgument(applyArgumentObjectConfig(createDefaultArgumentConfig(), { posterImageMode: "chinese" }));
    assert.equal(legacyChinese.posterImageMode, "cn");
    const legacyLabel = normalizeArgument(applyArgumentObjectConfig(createDefaultArgumentConfig(), { posterImageMode: "中文" }));
    assert.equal(legacyLabel.posterImageMode, "cn");
    const legacyDefault = normalizeArgument(applyArgumentObjectConfig(createDefaultArgumentConfig(), { posterImageMode: "默认" }));
    assert.equal(legacyDefault.posterImageMode, "default");
    const legacyOriginal = normalizeArgument(applyArgumentObjectConfig(createDefaultArgumentConfig(), { posterImageMode: "original" }));
    assert.equal(legacyOriginal.posterImageMode, "original");
});

test("posterImageMode 非法值回退 original", () => {
    const parsed = normalizeArgument(applyArgumentStringConfig(createDefaultArgumentConfig(), "[true,cn,bogus]"));

    assert.equal(parsed.posterImageMode, "original");
});

test("posterImageMode 支持中文选项标签", () => {
    const parsed = normalizeArgument(applyArgumentStringConfig(createDefaultArgumentConfig(), "[true,cn,原片语言]"));
    const defaultParsed = normalizeArgument(applyArgumentStringConfig(createDefaultArgumentConfig(), "[true,cn,原图]"));

    assert.equal(parsed.posterImageMode, "original");
    assert.equal(defaultParsed.posterImageMode, "default");
});

test("debugMode 非法值回退 off", () => {
    const parsed = normalizeArgument(applyArgumentStringConfig(createDefaultArgumentConfig(), "[true,cn,original,google,true,true,1,2,3,https://backend.example,false,bogus]"));

    assert.equal(parsed.debugMode, "off");
});

test("debugMode 支持中文选项标签", () => {
    const offParsed = normalizeArgument(applyArgumentStringConfig(createDefaultArgumentConfig(), "[true,cn,original,google,true,true,1,2,3,https://backend.example,false,关闭]"));
    const localParsed = normalizeArgument(
        applyArgumentStringConfig(createDefaultArgumentConfig(), "[true,cn,original,google,true,true,1,2,3,https://backend.example,false,禁用本地缓存]"),
    );
    const remoteParsed = normalizeArgument(
        applyArgumentStringConfig(createDefaultArgumentConfig(), "[true,cn,original,google,true,true,1,2,3,https://backend.example,false,禁用远端缓存]"),
    );
    const allParsed = normalizeArgument(
        applyArgumentStringConfig(createDefaultArgumentConfig(), "[true,cn,original,google,true,true,1,2,3,https://backend.example,false,禁用所有缓存]"),
    );

    assert.equal(offParsed.debugMode, "off");
    assert.equal(localParsed.debugMode, "disableLocal");
    assert.equal(remoteParsed.debugMode, "disableRemote");
    assert.equal(allParsed.debugMode, "disableAll");
});

test("tamperAppAuthorizationEnabled 默认关闭，对象和字符串参数均可开启", () => {
    const defaults = normalizeArgument(createDefaultArgumentConfig());
    assert.equal(defaults.tamperAppAuthorizationEnabled, false);

    const objectParsed = normalizeArgument(
        applyArgumentObjectConfig(createDefaultArgumentConfig(), {
            tamperAppAuthorizationEnabled: true,
        }),
    );
    assert.equal(objectParsed.tamperAppAuthorizationEnabled, true);

    const stringParsed = normalizeArgument(applyArgumentStringConfig(createDefaultArgumentConfig(), "[true,cn,original,google,true,true,1,2,3,https://backend.example,true,关闭]"));
    assert.equal(stringParsed.tamperAppAuthorizationEnabled, true);
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

test("translationEngine=off 时 comments 不触发 Google 翻译且保留原文", async () => {
    const { result, persistentData, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/comments/123/replies",
        body: readFixture("comments.json"),
        argument: {
            translationEngine: "off",
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

test("translationEngine=deeplx 时 comments 会请求 DeepLX 翻译并写回缓存", async () => {
    const { result, persistentData, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/comments/123/replies",
        body: readFixture("comments.json"),
        argument: {
            translationEngine: "deeplx",
        },
        httpPostMocks: {
            [DEEPLX_TRANSLATE_URL]: JSON.stringify({ data: "很棒的电影" }),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].comment, "很棒的电影");
    assert.equal(parseUnifiedCache(persistentData).google.comments["9001:cn"].comment.translatedText, "很棒的电影");
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
            forwardButtonOrder: 0,
            infuseButtonOrder: 0,
            rexButtonOrder: 0,
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
            forwardButtonOrder: 1,
            infuseButtonOrder: 0,
            rexButtonOrder: 0,
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
