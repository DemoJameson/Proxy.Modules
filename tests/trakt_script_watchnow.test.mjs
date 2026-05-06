import assert from "node:assert/strict";
import test from "node:test";

import { WATCHNOW_REDIRECT_URL } from "../trakt_simplified_chinese/src/features/player-injection-trakt.mjs";

import {
    createEpisodeWatchnowIdsEntry,
    createHttpStatusMock,
    createInvalidJsonResponse,
    createMediaTranslationCache,
    createMediaTranslationEntry,
    createUnifiedPersistentData,
    createWatchnowIdsCache,
    createWatchnowIdsEntry,
    parseUnifiedCache,
    readFixture,
    runRequestCase,
    runResponseCase,
    UNIFIED_CACHE_KEY,
} from "./helpers/trakt-test-helpers.mjs";

const MOVIE_DETAIL_LOOKUP_URL = "https://api.trakt.tv/movies/123?extended=cloud9,full,watchnow";

const movieWatchnowDetailFailureCases = [
    {
        name: "/movies/:id/watchnow 在 detail lookup 返回 HTTP 失败时不会写入 link cache 且不会注入自定义播放器",
        mock: createHttpStatusMock(404, "{}"),
    },
    {
        name: "/movies/:id/watchnow 在 detail lookup 返回非法 JSON 时不会写入 link cache 且不会注入自定义播放器",
        mock: createInvalidJsonResponse(),
    },
];

test("/users/settings 会注入 vip 标记、广告标记和 watchnow favorites", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/users/settings",
        body: readFixture("user-settings.json"),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.user.vip, true);
    assert.equal(payload.account.display_ads, false);
    assert.deepEqual(payload.browsing.watchnow.favorites.slice(0, 3), ["sg-eplayerx", "sg-forward", "sg-infuse"]);
});

test("/watchnow/sources 会注入自定义 source 定义", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/watchnow/sources",
        body: readFixture("watchnow-sources.json"),
    });

    const payload = JSON.parse(result.body);
    assert.deepEqual(
        payload[0].sg.slice(0, 3).map((item) => item.source),
        ["infuse", "forward", "eplayerx"],
    );
});

test("/watchnow/sources 在关闭全部 player button 时仍会保留自定义 source 定义", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/watchnow/sources",
        body: readFixture("watchnow-sources.json"),
        argument: {
            eplayerxEnabled: false,
            infuseEnabled: false,
            forwardEnabled: false,
        },
    });

    const payload = JSON.parse(result.body);
    assert.deepEqual(
        payload[0].sg.slice(0, 3).map((item) => item.source),
        ["infuse", "forward", "eplayerx"],
    );
});

test("/movies/:id/watchnow 会根据缓存 ids 注入自定义播放器条目", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/watchnow",
        body: readFixture("movie-watchnow.json"),
        persistentData: createUnifiedPersistentData({
            traktLinkIds: JSON.parse(
                createWatchnowIdsCache({
                    123: createWatchnowIdsEntry({
                        ids: {
                            tmdb: 456,
                        },
                    }),
                }),
            ),
        }),
    });

    const payload = JSON.parse(result.body);
    assert.deepEqual(
        payload.us.free.slice(0, 3).map((item) => item.source),
        ["eplayerx", "forward", "infuse"],
    );
});

test("/movies/:id/watchnow 在禁用部分 player button 时只注入启用的播放器", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/watchnow",
        body: readFixture("movie-watchnow.json"),
        argument: {
            eplayerxEnabled: false,
            infuseEnabled: false,
            forwardEnabled: true,
        },
        persistentData: createUnifiedPersistentData({
            traktLinkIds: JSON.parse(
                createWatchnowIdsCache({
                    123: createWatchnowIdsEntry({
                        ids: {
                            tmdb: 456,
                        },
                    }),
                }),
            ),
        }),
    });

    const payload = JSON.parse(result.body);
    assert.deepEqual(
        payload.us.free.slice(0, 2).map((item) => item.source),
        ["forward", "hulu"],
    );
    assert.equal(
        payload.us.free.some((item) => item.source === "eplayerx"),
        false,
    );
    assert.equal(
        payload.us.free.some((item) => item.source === "infuse"),
        false,
    );
});

test("/movies/:id/watchnow 在禁用全部 player button 时会保留原始 watchnow 响应", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/watchnow",
        body: readFixture("movie-watchnow.json"),
        argument: {
            eplayerxEnabled: false,
            infuseEnabled: false,
            forwardEnabled: false,
        },
        persistentData: createUnifiedPersistentData({
            traktLinkIds: JSON.parse(
                createWatchnowIdsCache({
                    123: createWatchnowIdsEntry({
                        ids: {
                            tmdb: 456,
                        },
                    }),
                }),
            ),
        }),
    });

    const payload = JSON.parse(result.body);
    assert.deepEqual(
        payload.us.free.map((item) => item.source),
        ["hulu"],
    );
});

test("/movies/:id/watchnow 在 link cache 未命中时会拉取 detail ids 并写回缓存", async () => {
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/watchnow",
        body: readFixture("movie-watchnow.json"),
        httpGetMocks: {
            [MOVIE_DETAIL_LOOKUP_URL]: JSON.stringify({
                ids: {
                    trakt: 123,
                    tmdb: 456,
                },
            }),
        },
    });

    const payload = JSON.parse(result.body);
    assert.deepEqual(
        payload.us.free.slice(0, 3).map((item) => item.source),
        ["eplayerx", "forward", "infuse"],
    );

    const linkCache = parseUnifiedCache(persistentData).trakt.linkIds;
    assert.equal(linkCache["123"].ids.tmdb, 456);
});

movieWatchnowDetailFailureCases.forEach(({ name, mock }) => {
    test(name, async () => {
        const { result, persistentData } = await runResponseCase({
            url: "https://api.trakt.tv/movies/123/watchnow",
            body: readFixture("movie-watchnow.json"),
            httpGetMocks: {
                [MOVIE_DETAIL_LOOKUP_URL]: mock,
            },
        });

        assert.equal(result.body, undefined);
        assert.deepEqual(parseUnifiedCache(persistentData).trakt.linkIds, {});
    });
});

test("/movies/:id/watchnow 遇到损坏的 link cache 字符串时会安全恢复并重新写回缓存", async () => {
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/watchnow",
        body: readFixture("movie-watchnow.json"),
        persistentData: {
            [UNIFIED_CACHE_KEY]: "{not-json",
        },
        httpGetMocks: {
            [MOVIE_DETAIL_LOOKUP_URL]: JSON.stringify({
                ids: {
                    trakt: 123,
                    tmdb: 456,
                },
            }),
        },
    });

    const payload = JSON.parse(result.body);
    assert.deepEqual(
        payload.us.free.slice(0, 3).map((item) => item.source),
        ["eplayerx", "forward", "infuse"],
    );

    const linkCache = parseUnifiedCache(persistentData).trakt.linkIds;
    assert.equal(linkCache["123"].ids.trakt, 123);
    assert.equal(linkCache["123"].ids.tmdb, 456);
});

test("/movies/:id/watchnow 遇到缺失 tmdb 的部分 link cache 时会补全并裁掉未使用的冗余字段", async () => {
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/watchnow",
        body: readFixture("movie-watchnow.json"),
        persistentData: createUnifiedPersistentData({
            traktLinkIds: JSON.parse(
                createWatchnowIdsCache({
                    123: createWatchnowIdsEntry({
                        ids: {
                            trakt: 123,
                            imdb: "tt0123456",
                        },
                    }),
                }),
            ),
        }),
        httpGetMocks: {
            [MOVIE_DETAIL_LOOKUP_URL]: JSON.stringify({
                ids: {
                    trakt: 123,
                    tmdb: 456,
                },
            }),
        },
    });

    const payload = JSON.parse(result.body);
    assert.deepEqual(
        payload.us.free.slice(0, 3).map((item) => item.source),
        ["eplayerx", "forward", "infuse"],
    );

    const linkCache = parseUnifiedCache(persistentData).trakt.linkIds;
    assert.equal(linkCache["123"].ids.trakt, 123);
    assert.equal(linkCache["123"].ids.imdb, undefined);
    assert.equal(linkCache["123"].ids.tmdb, 456);
});

test("/episodes/:id/watchnow 会补全 showIds.tmdb 并保留 episode 元数据", async () => {
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/episodes/1001/watchnow",
        body: readFixture("movie-watchnow.json"),
        persistentData: createUnifiedPersistentData({
            traktLinkIds: JSON.parse(
                createWatchnowIdsCache({
                    1001: createEpisodeWatchnowIdsEntry(),
                }),
            ),
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
    assert.deepEqual(
        payload.us.free.slice(0, 3).map((item) => item.source),
        ["eplayerx", "forward", "infuse"],
    );

    const linkCache = parseUnifiedCache(persistentData).trakt.linkIds;
    assert.equal(linkCache["1001"].showIds.trakt, 555);
    assert.equal(linkCache["1001"].showIds.imdb, undefined);
    assert.equal(linkCache["1001"].showIds.tmdb, 777);
    assert.equal(linkCache["1001"].seasonNumber, 1);
    assert.equal(linkCache["1001"].episodeNumber, 2);
});

test("/episodes/:id/watchnow 在缺少 showIds.trakt 时会安全降级为原始响应", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/episodes/1001/watchnow",
        body: readFixture("movie-watchnow.json"),
        persistentData: createUnifiedPersistentData({
            traktLinkIds: JSON.parse(
                createWatchnowIdsCache({
                    1001: createEpisodeWatchnowIdsEntry({
                        showIds: {},
                    }),
                }),
            ),
        }),
    });

    const payload = JSON.parse(result.body);
    assert.deepEqual(
        payload.us.free.map((item) => item.source),
        ["hulu"],
    );
});

test("season detail 请求会在 request phase 记录当前 season", async () => {
    const { result, persistentData } = await runRequestCase({
        url: "https://api.trakt.tv/shows/555/seasons/3",
    });

    assert.equal(Object.keys(result).length, 0);
    assert.equal(JSON.stringify(parseUnifiedCache(persistentData).persistent.currentSeason), JSON.stringify({ showId: "555", seasonNumber: 3 }));
});

test("merged history episodes 请求在关闭 historyEpisodesMergedByShow 后不会改写", async () => {
    const { result } = await runRequestCase({
        url: "https://api.trakt.tv/users/me/history/episodes?page=2&limit=10",
        argument: {
            historyEpisodesMergedByShow: false,
        },
    });

    assert.equal(Object.keys(result).length, 0);
});

test("关闭 historyEpisodesMergedByShow 不会影响 Rippple history 的最小 limit 改写", async () => {
    const { result } = await runRequestCase({
        url: "https://api.trakt.tv/users/me/history?page=1&limit=20",
        headers: {
            "user-agent": "Rippple/1.0",
        },
        argument: {
            historyEpisodesMergedByShow: false,
        },
    });

    assert.equal(result.url, "https://api.trakt.tv/users/me/history?page=1&limit=100");
});

test("Rippple history 请求在非 Rippple UA 下不会误改写", async () => {
    const { result } = await runRequestCase({
        url: "https://api.trakt.tv/users/me/history?page=1&limit=20",
        headers: {
            "user-agent": "UnitTest/1.0",
        },
    });

    assert.equal(Object.keys(result).length, 0);
});

test("/shows/:id/seasons 会应用缓存剧集翻译并更新 link id 缓存", async () => {
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/shows/555/seasons",
        body: readFixture("season-list.json"),
        persistentData: createUnifiedPersistentData({
            persistentCurrentSeason: { showId: "555", seasonNumber: 1 },
            traktTranslation: JSON.parse(
                createMediaTranslationCache({
                    "episode:555:1:1": createMediaTranslationEntry({
                        translation: {
                            title: "第一集",
                            overview: "第一集简介",
                            tagline: "第一集标语",
                        },
                    }),
                    "episode:555:1:2": createMediaTranslationEntry({
                        translation: {
                            title: "第二集",
                            overview: "第二集简介",
                            tagline: "第二集标语",
                        },
                    }),
                }),
            ),
        }),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].episodes[0].title, "第一集");
    assert.equal(payload[0].episodes[1].title, "第二集");

    const linkCache = parseUnifiedCache(persistentData).trakt.linkIds;
    assert.equal(linkCache["1001"].showIds.trakt, "555");
    assert.equal(linkCache["1001"].seasonNumber, 1);
    assert.equal(linkCache["1002"].episodeNumber, 2);
    assert.equal(parseUnifiedCache(persistentData).persistent.currentSeason, null);
});

test("direct redirect 请求在启用时会返回 shortcuts 跳转", async () => {
    const deeplink = "infuse://movie/123";
    const { result } = await runRequestCase({
        url: `${WATCHNOW_REDIRECT_URL}?deeplink=${encodeURIComponent(deeplink)}`,
        argument: {
            useShortcutsJumpEnabled: true,
        },
    });

    assert.equal(result.response.status, 302);
    assert.match(result.response.headers.Location, /^shortcuts:\/\/run-shortcut\?/);
    assert.match(result.response.headers.Location, /input=text/);
});

test("tmdb logo 请求会重定向到仓库内置 logo 资源", async () => {
    const { result } = await runRequestCase({
        url: "https://image.tmdb.org/t/p/w342/forward_logo.webp",
    });

    assert.equal(result.response.status, 302);
    assert.equal(result.response.headers.Location, "https://raw.githubusercontent.com/DemoJameson/Proxy.Modules/main/trakt_simplified_chinese/images/forward_logo.webp");
});

test("useShortcutsJumpEnabled 不会影响 tmdb logo redirect 的目标地址", async () => {
    const { result } = await runRequestCase({
        url: "https://image.tmdb.org/t/p/w342/forward_logo.webp",
        argument: {
            useShortcutsJumpEnabled: true,
        },
    });

    assert.equal(result.response.status, 302);
    assert.equal(result.response.headers.Location, "https://raw.githubusercontent.com/DemoJameson/Proxy.Modules/main/trakt_simplified_chinese/images/forward_logo.webp");
});
