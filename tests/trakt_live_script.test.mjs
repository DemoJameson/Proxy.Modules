import assert from "node:assert/strict";
import test from "node:test";

import { WATCHNOW_REDIRECT_URL } from "../trakt_simplified_chinese/src/features/player-injection-trakt.mjs";
import { createRequestPhaseRoutes } from "../trakt_simplified_chinese/src/request.mjs";
import { createResponsePhaseRoutes } from "../trakt_simplified_chinese/src/response.mjs";

import {
    createScriptRequestHeaders,
    fetchTraktJson,
    getLiveConfig,
    hasOAuthToken,
    resolveMovieWithComments,
    resolveMovieWithPeople,
    resolveMovieWithSentiments,
    resolveMovieWithWatchnow,
    resolveMovieWithZhTranslation,
    resolvePopularMovieWithZhTranslation,
    resolvePopularShowWithZhTranslation,
    resolveShowEpisodeSample,
    runLiveRequestCase,
    runLiveResponseCase,
} from "./helpers/trakt-live-test-helpers.mjs";
import {
    computeStringHash,
    createCommentTranslationCache,
    createEpisodeWatchnowIdsEntry,
    createMediaTranslationEntry,
    createPeopleTranslationCache,
    createSentimentTranslationCache,
    createUnifiedPersistentData,
    createWatchnowIdsEntry,
    parseUnifiedCache,
    readFixture,
} from "./helpers/trakt-test-helpers.mjs";

function createWrappedMovieItems(movie) {
    return [
        {
            movie,
        },
    ];
}

function createWrappedShowItems(show) {
    return [
        {
            show,
        },
    ];
}

function createRecentCommentsItems(movie, comment) {
    return [
        {
            movie,
            comment,
        },
    ];
}

function createMergedHistoryEpisodeItems(sample) {
    return [
        {
            id: 1,
            show: sample.show,
            episode: sample.episode,
        },
    ];
}

function createUpNextItems(sample) {
    return [
        {
            show: sample.show,
            progress: {
                next_episode: sample.episode,
            },
        },
    ];
}

function createMirPayload(movie) {
    return {
        first_watched: {
            movie,
        },
    };
}

function createEpisodeTranslationCache(sample, title = "中文剧集标题") {
    return {
        [`episode:${sample.traktId}:${sample.seasonNumber}:${sample.episodeNumber}`]: {
            status: 1,
            translation: {
                title,
                overview: `${title}-简介`,
                tagline: "",
            },
        },
    };
}

function pickPreferredZhTranslation(translations) {
    const normalizedTranslations = Array.isArray(translations) ? translations : [];
    return (
        normalizedTranslations.find((item) => {
            return String(item?.language ?? "").toLowerCase() === "zh" && String(item?.country ?? "").toLowerCase() === "cn";
        }) ??
        normalizedTranslations[0] ??
        null
    );
}

function skipOnLiveSampleError(t, error) {
    t.skip(String(error?.message ?? error));
}

function flattenResponseRouteEntries(routes) {
    return routes.map((route) => {
        return {
            id: route.id,
            description: route.describe(),
        };
    });
}

function collectMatchedResponseEntryIds(routes, urls) {
    const matchedRouteIds = new Set();
    urls.forEach((url) => {
        const routeUrl = new URL(url);
        const matchedRoutes = routes.filter((route) => route.test({ url: routeUrl }));
        assert.equal(matchedRoutes.length, 1, `Expected exactly one matched response entry for ${url}`);
        matchedRouteIds.add(matchedRoutes[0].id);
    });

    return matchedRouteIds;
}

async function resolveListDescriptionSample(config) {
    const response = await fetchTraktJson(config, "/users/trakt/lists?page=1&limit=50");
    assert.equal(response.status, 200);

    const list = (Array.isArray(response.json) ? response.json : []).find((item) => {
        return String(item?.description ?? "").trim() && String(item?.ids?.trakt ?? "").trim();
    });
    assert.ok(list, "Could not find a live list sample with description");

    return {
        list,
        body: JSON.stringify([list]),
    };
}

async function resolvePersonMovieCreditsSample(config) {
    const peopleSample = await resolveMovieWithPeople(config);
    const response = await fetchTraktJson(config, `/people/${peopleSample.personId}/movies?page=1&limit=10`);
    assert.equal(response.status, 200);

    const payload = response.json;
    const castItem = Array.isArray(payload?.cast) ? payload.cast.find((item) => item?.movie?.ids?.trakt) : null;
    assert.ok(castItem?.movie, "Could not find a live person movie credits sample");

    return {
        personId: peopleSample.personId,
        movie: castItem.movie,
        body: response.body,
    };
}

test("live script: /translations/zh 响应会被归一化并优先放置 zh-CN", async (t) => {
    const config = getLiveConfig();
    let sample;
    try {
        sample = await resolveMovieWithZhTranslation(config);
    } catch (error) {
        skipOnLiveSampleError(t, error);
        return;
    }

    const { result } = await runLiveResponseCase(config, {
        url: `https://api.trakt.tv/movies/${sample.traktId}/translations/zh?extended=all`,
        headers: createScriptRequestHeaders(config),
        body: JSON.stringify(sample.translations),
    });

    const payload = JSON.parse(result.body);
    assert.ok(Array.isArray(payload));
    assert.ok(payload.length > 0);
    assert.equal(payload[0].language, "zh");

    const firstCnIndex = payload.findIndex((item) => String(item?.country ?? "").toLowerCase() === "cn");
    if (firstCnIndex !== -1) {
        assert.equal(firstCnIndex, 0);
    }
});

test("live script: /movies/:id 会在 /translations/zh 写入本地缓存后应用中文翻译", async (t) => {
    const config = getLiveConfig();
    let sample;
    try {
        sample = await resolveMovieWithZhTranslation(config);
    } catch (error) {
        skipOnLiveSampleError(t, error);
        return;
    }
    const detailResponse = await fetchTraktJson(config, `/movies/${sample.traktId}?extended=full`);

    assert.equal(detailResponse.status, 200);

    const translationRun = await runLiveResponseCase(config, {
        url: `https://api.trakt.tv/movies/${sample.traktId}/translations/zh?extended=all`,
        argument: {
            backendBaseUrl: config.backendBaseUrl,
        },
        headers: createScriptRequestHeaders(config),
        body: JSON.stringify(sample.translations),
    });

    const normalizedTranslations = JSON.parse(translationRun.result.body);
    const cnTranslation = pickPreferredZhTranslation(normalizedTranslations);

    const { result, httpLogs } = await runLiveResponseCase(config, {
        url: `https://api.trakt.tv/movies/${sample.traktId}`,
        argument: {
            backendBaseUrl: config.backendBaseUrl,
        },
        headers: createScriptRequestHeaders(config, {
            "user-agent": "Rippple/1.0",
        }),
        body: detailResponse.body,
        persistentData: createUnifiedPersistentData({
            traktTranslation: parseUnifiedCache(translationRun.persistentData).trakt.translation,
        }),
    });

    const payload = JSON.parse(result.body);
    assert.equal(typeof payload.title, "string");
    assert.equal(typeof payload.overview, "string");
    assert.equal(typeof payload.tagline, "string");
    assert.equal(payload.title, String(cnTranslation?.title ?? payload.title));
    assert.equal(
        httpLogs.every((log) => {
            return (
                log.method === "GET" &&
                (log.url.startsWith(`${config.backendBaseUrl}/api/trakt/translations`) || log.url.startsWith(`${config.backendBaseUrl}/api/trakt/translation-overrides`))
            );
        }),
        true,
    );
});

test("live script: /movies/:id/watchnow 响应会注入自定义播放器条目", async (t) => {
    const config = getLiveConfig();
    if (!hasOAuthToken(config)) {
        t.skip("未配置 TRAKT_OAUTH_TOKEN，跳过登录态 watchnow 真请求测试");
        return;
    }
    let sample;
    try {
        sample = await resolveMovieWithWatchnow(config);
    } catch (error) {
        if (/unauthorized for the current token/i.test(String(error?.message ?? error))) {
            t.skip("当前 Trakt token 无法访问真实 watchnow 接口，跳过该 live case");
            return;
        }
        throw error;
    }

    const { result, httpLogs } = await runLiveResponseCase(config, {
        url: `https://api.trakt.tv/movies/${sample.traktId}/watchnow`,
        argument: {
            backendBaseUrl: config.backendBaseUrl,
        },
        headers: createScriptRequestHeaders(config),
        body: JSON.stringify(sample.watchnow),
    });

    const payload = JSON.parse(result.body);
    const regions = Object.values(payload).filter((entry) => entry && typeof entry === "object");
    const allSources = [];

    regions.forEach((region) => {
        Object.values(region).forEach((items) => {
            if (Array.isArray(items)) {
                items.forEach((item) => {
                    allSources.push(String(item?.source ?? ""));
                });
            }
        });
    });

    assert.equal(allSources.includes("eplayerx"), true);
    assert.equal(allSources.includes("forward"), true);
    assert.equal(allSources.includes("infuse"), true);
    assert.equal(
        httpLogs.some((log) => /\?extended=cloud9,full,watchnow$/.test(log.url)),
        true,
    );
});

test("live script: /users/settings 响应会注入 vip、关闭广告并补 watchnow favorites", async (t) => {
    const config = getLiveConfig();
    if (!hasOAuthToken(config)) {
        t.skip("未配置 TRAKT_OAUTH_TOKEN，跳过登录态 settings 真请求测试");
        return;
    }

    const settingsResponse = await fetchTraktJson(config, "/users/settings");
    assert.equal(settingsResponse.status, 200);

    const { result } = await runLiveResponseCase(config, {
        url: "https://api.trakt.tv/users/settings",
        argument: {
            backendBaseUrl: config.backendBaseUrl,
        },
        headers: createScriptRequestHeaders(config),
        body: settingsResponse.body,
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.user.vip, true);
    assert.equal(payload.account.display_ads, false);
    assert.ok(Array.isArray(payload.browsing?.watchnow?.favorites));
    assert.equal(payload.browsing.watchnow.favorites.includes("us-eplayerx"), true);
    assert.equal(payload.browsing.watchnow.favorites.includes("us-forward"), true);
    assert.equal(payload.browsing.watchnow.favorites.includes("us-infuse"), true);
});

test("live script: /users/me/watchlist/movies 会走登录态列表翻译链路", async (t) => {
    const config = getLiveConfig();
    if (!hasOAuthToken(config)) {
        t.skip("未配置 TRAKT_OAUTH_TOKEN，跳过登录态 watchlist 真请求测试");
        return;
    }

    const watchlistResponse = await fetchTraktJson(config, "/users/me/watchlist/movies?page=1&limit=10");
    assert.equal(watchlistResponse.status, 200);

    const items = Array.isArray(watchlistResponse.json) ? watchlistResponse.json : [];
    if (items.length === 0) {
        t.skip("当前账号的 watchlist movies 为空，跳过该用例");
        return;
    }

    const { result } = await runLiveResponseCase(config, {
        url: "https://api.trakt.tv/users/me/watchlist/movies?page=1&limit=10",
        argument: {
            backendBaseUrl: config.backendBaseUrl,
        },
        headers: createScriptRequestHeaders(config),
        body: watchlistResponse.body,
    });

    const payload = JSON.parse(result.body);
    assert.ok(Array.isArray(payload));
    assert.equal(payload.length > 0, true);
    assert.equal(typeof payload[0]?.movie?.title, "string");
});

test("live script: /shows/popular 会命中列表翻译路由并应用缓存中的中文翻译", async (t) => {
    const config = getLiveConfig();
    let sample;
    try {
        sample = await resolvePopularShowWithZhTranslation(config);
    } catch (error) {
        skipOnLiveSampleError(t, error);
        return;
    }
    const normalizedTranslations = JSON.parse(
        await runLiveResponseCase(config, {
            url: `https://api.trakt.tv/shows/${sample.traktId}/translations/zh?extended=all`,
            argument: {
                backendBaseUrl: config.backendBaseUrl,
            },
            headers: createScriptRequestHeaders(config),
            body: JSON.stringify(sample.translations),
        }).then(({ result }) => result.body),
    );
    const cnTranslation = pickPreferredZhTranslation(normalizedTranslations);

    const { result } = await runLiveResponseCase(config, {
        url: "https://apiz.trakt.tv/shows/popular?extended=cloud9,full&limit=100&local_name=%E7%83%AD%E9%97%A8%E5%89%A7%E9%9B%86&page=1&ratings=80-100",
        argument: {
            backendBaseUrl: config.backendBaseUrl,
        },
        headers: createScriptRequestHeaders(config),
        body: sample.listBody,
        persistentData: createUnifiedPersistentData({
            traktTranslation: {
                [`show:${sample.traktId}`]: createMediaTranslationEntry({
                    translation: {
                        title: String(cnTranslation?.title ?? ""),
                        overview: String(cnTranslation?.overview ?? ""),
                        tagline: String(cnTranslation?.tagline ?? ""),
                    },
                }),
            },
        }),
    });

    const payload = JSON.parse(result.body);
    const targetItem = (Array.isArray(payload) ? payload : []).find((item) => {
        const targetShow = item?.show && typeof item.show === "object" ? item.show : item;
        return String(targetShow?.ids?.trakt ?? "") === String(sample.traktId);
    });
    const targetShow = targetItem?.show && typeof targetItem.show === "object" ? targetItem.show : targetItem;

    assert.ok(targetShow);
    if (cnTranslation?.title) {
        assert.equal(targetShow.title, String(cnTranslation.title));
    }
});

test("live script: /movies/popular 会命中列表翻译路由并应用缓存中的中文翻译", async (t) => {
    const config = getLiveConfig();
    let sample;
    try {
        sample = await resolvePopularMovieWithZhTranslation(config);
    } catch (error) {
        skipOnLiveSampleError(t, error);
        return;
    }
    const normalizedTranslations = JSON.parse(
        await runLiveResponseCase(config, {
            url: `https://api.trakt.tv/movies/${sample.traktId}/translations/zh?extended=all`,
            argument: {
                backendBaseUrl: config.backendBaseUrl,
            },
            headers: createScriptRequestHeaders(config),
            body: JSON.stringify(sample.translations),
        }).then(({ result }) => result.body),
    );
    const cnTranslation = pickPreferredZhTranslation(normalizedTranslations);

    const { result } = await runLiveResponseCase(config, {
        url: "https://apiz.trakt.tv/movies/popular?extended=cloud9,full&limit=100&local_name=%E7%83%AD%E9%97%A8%E7%94%B5%E5%BD%B1&page=1&ratings=80-100",
        argument: {
            backendBaseUrl: config.backendBaseUrl,
        },
        headers: createScriptRequestHeaders(config),
        body: sample.listBody,
        persistentData: createUnifiedPersistentData({
            traktTranslation: {
                [`movie:${sample.traktId}`]: createMediaTranslationEntry({
                    translation: {
                        title: String(cnTranslation?.title ?? ""),
                        overview: String(cnTranslation?.overview ?? ""),
                        tagline: String(cnTranslation?.tagline ?? ""),
                    },
                }),
            },
        }),
    });

    const payload = JSON.parse(result.body);
    const targetItem = (Array.isArray(payload) ? payload : []).find((item) => {
        const targetMovie = item?.movie && typeof item.movie === "object" ? item.movie : item;
        return String(targetMovie?.ids?.trakt ?? "") === String(sample.traktId);
    });
    const targetMovie = targetItem?.movie && typeof targetItem.movie === "object" ? targetItem.movie : targetItem;

    assert.ok(targetMovie);
    if (cnTranslation?.title) {
        assert.equal(targetMovie.title, String(cnTranslation.title));
    }
});

test("live script: /people/:id 会应用缓存中的中文姓名和 biography", async (t) => {
    const config = getLiveConfig();
    let sample;
    try {
        sample = await resolveMovieWithPeople(config);
    } catch (error) {
        t.skip(String(error?.message ?? error));
        return;
    }

    const originalName = String(sample.personDetail?.name ?? "").trim();
    const originalBiography = String(sample.personDetail?.biography ?? "").trim();
    if (!originalName || !originalBiography) {
        t.skip("真实 people detail 缺少可验证的 name 或 biography");
        return;
    }

    const translatedName = `中文-${originalName}`;
    const translatedBiography = `中文-${originalBiography}`;

    const { result } = await runLiveResponseCase(config, {
        url: `https://api.trakt.tv/people/${sample.personId}`,
        argument: {
            backendBaseUrl: config.backendBaseUrl,
        },
        headers: createScriptRequestHeaders(config),
        body: JSON.stringify(sample.personDetail),
        persistentData: createUnifiedPersistentData({
            googlePeople: {
                [sample.personId]: {
                    name: {
                        sourceTextHash: computeStringHash(originalName),
                        translatedText: translatedName,
                        source: "google",
                    },
                    biography: {
                        sourceTextHash: computeStringHash(originalBiography),
                        translatedText: translatedBiography,
                    },
                },
            },
        }),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.name, `${translatedName}\n${originalName}`);
    assert.equal(payload.biography, translatedBiography);
});

test("live script: /movies/:id/people 会应用缓存中的中文姓名", async (t) => {
    const config = getLiveConfig();
    let sample;
    try {
        sample = await resolveMovieWithPeople(config);
    } catch (error) {
        t.skip(String(error?.message ?? error));
        return;
    }

    const originalName = String(sample.person?.name ?? "").trim();
    if (!originalName) {
        t.skip("真实 media people 缺少可验证的人名");
        return;
    }

    const translatedName = `中文-${originalName}`;

    const { result } = await runLiveResponseCase(config, {
        url: `https://api.trakt.tv/movies/${sample.traktId}/people`,
        argument: {
            backendBaseUrl: config.backendBaseUrl,
        },
        headers: createScriptRequestHeaders(config),
        body: JSON.stringify(sample.people),
        persistentData: createUnifiedPersistentData({
            googlePeople: {
                [sample.personId]: {
                    name: {
                        sourceTextHash: computeStringHash(originalName),
                        translatedText: translatedName,
                        source: "google",
                    },
                },
            },
        }),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.cast[0].person.name, translatedName);
});

test("live script: comments 响应会应用缓存中的评论翻译", async (t) => {
    const config = getLiveConfig();
    let sample;
    try {
        sample = await resolveMovieWithComments(config);
    } catch (error) {
        t.skip(String(error?.message ?? error));
        return;
    }

    const originalComment = String(sample.firstComment?.comment ?? "").trim();
    const commentId = String(sample.firstComment?.id ?? "").trim();
    if (!originalComment || !commentId) {
        t.skip("真实 comments 数据缺少可验证的 comment 或 id");
        return;
    }

    const translatedComment = `中文-${originalComment}`;

    const { result } = await runLiveResponseCase(config, {
        url: `https://api.trakt.tv/movies/${sample.traktId}/comments/all?page=1&limit=10`,
        argument: {
            backendBaseUrl: config.backendBaseUrl,
        },
        headers: createScriptRequestHeaders(config),
        body: JSON.stringify(sample.comments),
        persistentData: createUnifiedPersistentData({
            googleComments: {
                [commentId]: {
                    comment: {
                        sourceTextHash: computeStringHash(originalComment),
                        translatedText: translatedComment,
                    },
                },
            },
        }),
    });

    const payload = JSON.parse(result.body);
    const targetComment = payload.find((item) => String(item?.id ?? "") === commentId);
    assert.ok(targetComment);
    assert.equal(targetComment.comment, translatedComment);
});

test("live script: /movies/:id/sentiments 会应用缓存中的情绪翻译", async (t) => {
    const config = getLiveConfig();
    let sample;
    try {
        sample = await resolveMovieWithSentiments(config);
    } catch (error) {
        t.skip(String(error?.message ?? error));
        return;
    }

    const prosTheme = String(sample.sentiments?.aspect?.pros?.[0]?.theme ?? "").trim();
    const firstGood = String(sample.sentiments?.good?.[0]?.sentiment ?? "").trim();
    const text = String(sample.sentiments?.text ?? "").trim();
    if (!prosTheme && !firstGood && !text) {
        t.skip("真实 sentiments 数据缺少可验证文本");
        return;
    }

    const translatedProsTheme = prosTheme ? `中文-${prosTheme}` : "";
    const translatedGood = firstGood ? `中文-${firstGood}` : "";
    const translatedText = text ? `中文-${text}` : "";
    const cons = Array.isArray(sample.sentiments?.aspect?.cons) ? sample.sentiments.aspect.cons : [];
    const bad = Array.isArray(sample.sentiments?.bad) ? sample.sentiments.bad : [];
    const summary = Array.isArray(sample.sentiments?.summary) ? sample.sentiments.summary : [];
    const items = Array.isArray(sample.sentiments?.items) ? sample.sentiments.items : [];
    const analysis = String(sample.sentiments?.analysis ?? "").trim();
    const highlight = String(sample.sentiments?.highlight ?? "").trim();

    const { result } = await runLiveResponseCase(config, {
        url: `https://api.trakt.tv/movies/${sample.traktId}/sentiments`,
        argument: {
            backendBaseUrl: config.backendBaseUrl,
        },
        headers: createScriptRequestHeaders(config),
        body: JSON.stringify(sample.sentiments),
        persistentData: createUnifiedPersistentData({
            googleSentiments: {
                [`movie:${sample.traktId}`]: {
                    translation: {
                        aspect: {
                            pros: (Array.isArray(sample.sentiments?.aspect?.pros) ? sample.sentiments.aspect.pros : []).map((item, index) => {
                                const value = String(item?.theme ?? "").trim();
                                return {
                                    sourceTextHash: computeStringHash(value),
                                    translatedText: index === 0 && translatedProsTheme ? translatedProsTheme : value,
                                };
                            }),
                            cons: cons.map((item) => {
                                const value = String(item?.theme ?? "").trim();
                                return {
                                    sourceTextHash: computeStringHash(value),
                                    translatedText: value,
                                };
                            }),
                        },
                        good: (Array.isArray(sample.sentiments?.good) ? sample.sentiments.good : []).map((item, index) => {
                            const value = String(item?.sentiment ?? "").trim();
                            return {
                                sourceTextHash: computeStringHash(value),
                                translatedText: index === 0 && translatedGood ? translatedGood : value,
                            };
                        }),
                        bad: bad.map((item) => {
                            const value = String(item?.sentiment ?? "").trim();
                            return {
                                sourceTextHash: computeStringHash(value),
                                translatedText: value,
                            };
                        }),
                        summary: summary.map((item) => {
                            const value = String(item ?? "").trim();
                            return {
                                sourceTextHash: computeStringHash(value),
                                translatedText: value,
                            };
                        }),
                        analysis: {
                            sourceTextHash: computeStringHash(analysis),
                            translatedText: analysis,
                        },
                        highlight: {
                            sourceTextHash: computeStringHash(highlight),
                            translatedText: highlight,
                        },
                        items: items.map((item) => {
                            const value = String(item?.text ?? "").trim();
                            return {
                                sourceTextHash: computeStringHash(value),
                                translatedText: value,
                            };
                        }),
                        text: text
                            ? {
                                  sourceTextHash: computeStringHash(text),
                                  translatedText: translatedText,
                              }
                            : {
                                  sourceTextHash: computeStringHash(""),
                                  translatedText: "",
                              },
                    },
                },
            },
        }),
    });

    const payload = JSON.parse(result.body);
    if (translatedProsTheme) {
        assert.equal(payload.aspect.pros[0].theme, translatedProsTheme);
    }
    if (translatedGood) {
        assert.equal(payload.good[0].sentiment, translatedGood);
    }
    if (translatedText) {
        assert.equal(payload.text, translatedText);
    }
});

test("live script: /users/:id/history/episodes 在 request phase 会被放大为 limit=500", async () => {
    const config = getLiveConfig();
    const { result } = await runLiveRequestCase(config, {
        url: "https://api.trakt.tv/users/test/history/episodes?page=2&limit=10",
        headers: createScriptRequestHeaders(config),
    });

    assert.equal(result.url, "https://api.trakt.tv/users/test/history/episodes?page=2&limit=500");
});

test("live script: /shows/:id/seasons 响应会应用剧集翻译并写入 current season / link cache", async (t) => {
    const config = getLiveConfig();
    let sample;
    try {
        sample = await resolveShowEpisodeSample(config);
    } catch (error) {
        skipOnLiveSampleError(t, error);
        return;
    }
    const seasonsResponse = await fetchTraktJson(config, `/shows/${sample.traktId}/seasons?extended=episodes,full`);

    assert.equal(seasonsResponse.status, 200);

    const { result, persistentData } = await runLiveResponseCase(config, {
        url: `https://api.trakt.tv/shows/${sample.traktId}/seasons`,
        argument: {
            backendBaseUrl: config.backendBaseUrl,
        },
        headers: createScriptRequestHeaders(config),
        body: seasonsResponse.body,
        persistentData: createUnifiedPersistentData({
            persistentCurrentSeason: {
                showId: sample.traktId,
                seasonNumber: sample.seasonNumber,
            },
        }),
    });

    const payload = JSON.parse(result.body);
    assert.ok(Array.isArray(payload));
    assert.ok(payload.length > 0);
    const linkCache = parseUnifiedCache(persistentData).trakt.linkIds;
    assert.ok(linkCache);
    const episodeKey = String(sample.episode?.ids?.trakt ?? "");
    if (episodeKey) {
        assert.equal(linkCache[episodeKey].showIds.trakt, String(sample.traktId));
    }
});

test("live script: response route coverage matrix covers all response phase routes", async (t) => {
    const config = getLiveConfig();
    let movieSample;
    let showSample;
    let directMovieSample;
    let episodeSample;
    let commentsSample;
    let personCreditsSample;
    let listSample;
    try {
        movieSample = await resolveMovieWithZhTranslation(config);
        showSample = await resolvePopularShowWithZhTranslation(config);
        directMovieSample = await resolvePopularMovieWithZhTranslation(config);
        episodeSample = await resolveShowEpisodeSample(config);
        commentsSample = await resolveMovieWithComments(config);
        personCreditsSample = await resolvePersonMovieCreditsSample(config);
        listSample = await resolveListDescriptionSample(config);
    } catch (error) {
        skipOnLiveSampleError(t, error);
        return;
    }

    const wrappedMovieItems = createWrappedMovieItems(movieSample.movie);
    const _wrappedShowItems = createWrappedShowItems(showSample.show);
    const directMovieItems = [directMovieSample.movie];
    const directShowItems = [showSample.show];
    const episodeItems = createMergedHistoryEpisodeItems(episodeSample);
    const upNextItems = createUpNextItems(episodeSample);
    const recentCommentItems = createRecentCommentsItems(commentsSample.movie, commentsSample.firstComment);
    const mirPayload = createMirPayload(movieSample.movie);

    const movieTranslation = {
        [`movie:${movieSample.traktId}`]: createMediaTranslationEntry({
            translation: {
                title: "覆盖中文电影",
                overview: "覆盖中文简介",
                tagline: "覆盖中文标语",
            },
        }),
        [`movie:${directMovieSample.traktId}`]: createMediaTranslationEntry({
            translation: {
                title: "覆盖直出中文电影",
                overview: "覆盖直出中文简介",
                tagline: "覆盖直出中文标语",
            },
        }),
        [`movie:${personCreditsSample.movie.ids.trakt}`]: createMediaTranslationEntry({
            translation: {
                title: "覆盖人物作品中文电影",
                overview: "覆盖人物作品中文简介",
                tagline: "覆盖人物作品中文标语",
            },
        }),
    };
    const preferredShowTranslation = pickPreferredZhTranslation(showSample.translations);
    const showTranslation = {
        [`show:${showSample.traktId}`]: createMediaTranslationEntry({
            translation: {
                title: String(preferredShowTranslation?.title ?? showSample.show.title ?? ""),
                overview: String(preferredShowTranslation?.overview ?? showSample.show.overview ?? ""),
                tagline: String(preferredShowTranslation?.tagline ?? showSample.show.tagline ?? ""),
            },
        }),
    };
    const expectedShowTitle = String(preferredShowTranslation?.title ?? showSample.show.title ?? "");
    const episodeTranslation = createEpisodeTranslationCache(episodeSample);
    const listTranslation = {
        [String(listSample.list.ids.trakt)]: {
            description: {
                sourceTextHash: computeStringHash(String(listSample.list.description)),
                translatedText: "覆盖中文列表描述",
            },
        },
    };
    const commentTranslation = {
        [String(commentsSample.firstComment.id)]: {
            comment: {
                sourceTextHash: computeStringHash(String(commentsSample.firstComment.comment)),
                translatedText: "覆盖中文评论",
            },
        },
    };

    const responseCases = [
        {
            url: `https://api.trakt.tv/movies/${movieSample.traktId}/lists/popular`,
            body: listSample.body,
            persistentData: createUnifiedPersistentData({ googleList: listTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].description, "覆盖中文列表描述");
            },
        },
        {
            url: "https://api.trakt.tv/users/trakt/likes/lists",
            body: JSON.stringify([
                {
                    type: "list",
                    list: listSample.list,
                },
            ]),
            persistentData: createUnifiedPersistentData({ googleList: listTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].list.description, "覆盖中文列表描述");
            },
        },
        {
            url: "https://api.trakt.tv/users/trakt/lists",
            body: listSample.body,
            persistentData: createUnifiedPersistentData({ googleList: listTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].description, "覆盖中文列表描述");
            },
        },
        {
            url: "https://api.trakt.tv/users/trakt/lists/collaborations",
            body: listSample.body,
            persistentData: createUnifiedPersistentData({ googleList: listTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].description, "覆盖中文列表描述");
            },
        },
        {
            url: "https://api.trakt.tv/search/list?query=live",
            body: JSON.stringify([
                {
                    type: "list",
                    list: listSample.list,
                },
            ]),
            persistentData: createUnifiedPersistentData({ googleList: listTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].list.description, "覆盖中文列表描述");
            },
        },
        {
            url: "https://api.trakt.tv/search/person?query=tom",
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
            persistentData: createUnifiedPersistentData({
                googlePeople: JSON.parse(createPeopleTranslationCache()),
            }),
            assertPayload(payload) {
                assert.match(payload[0].person.name, /^汤姆·汉克斯/);
                assert.equal(payload[0].person.biography, "一位美国演员和电影制作人。");
            },
        },
        {
            url: "https://api.trakt.tv/lists/popular",
            body: JSON.stringify([
                {
                    like_count: 10,
                    comment_count: 2,
                    list: listSample.list,
                },
            ]),
            persistentData: createUnifiedPersistentData({ googleList: listTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].list.description, "覆盖中文列表描述");
            },
        },
        {
            url: "https://api.trakt.tv/recommendations/movies",
            body: JSON.stringify(directMovieItems),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].title, "覆盖直出中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/movies/watched/monthly",
            body: JSON.stringify(createWrappedMovieItems(movieSample.movie)),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/sync/progress/up_next_nitro",
            body: JSON.stringify(upNextItems),
            persistentData: createUnifiedPersistentData({ traktTranslation: episodeTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].progress.next_episode.title, "中文剧集标题");
            },
        },
        {
            url: "https://api.trakt.tv/sync/playback/movies",
            body: JSON.stringify(wrappedMovieItems),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/users/me/watchlist/movies/released",
            body: JSON.stringify(wrappedMovieItems),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/calendars/all/movies/2026-01-01/7",
            body: JSON.stringify(wrappedMovieItems),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/users/me/history/episodes?page=1&limit=10",
            body: JSON.stringify(episodeItems),
            persistentData: createUnifiedPersistentData({ traktTranslation: episodeTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].episode.title, "中文剧集标题");
            },
        },
        {
            url: "https://api.trakt.tv/users/me/history/movies",
            body: JSON.stringify(wrappedMovieItems),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/sync/history/episodes",
            body: JSON.stringify(episodeItems),
            persistentData: createUnifiedPersistentData({ traktTranslation: episodeTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].episode.title, "中文剧集标题");
            },
        },
        {
            url: "https://api.trakt.tv/sync/history",
            body: JSON.stringify(wrappedMovieItems),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/sync/history/movies",
            body: JSON.stringify(wrappedMovieItems),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/sync/watched/movies",
            body: JSON.stringify(wrappedMovieItems),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/users/me/watched/movies",
            body: JSON.stringify(wrappedMovieItems),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/users/me/history",
            body: JSON.stringify(wrappedMovieItems),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/users/me/collection/movies",
            body: JSON.stringify(wrappedMovieItems),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/users/me/collection/media",
            body: JSON.stringify([
                {
                    type: "movie",
                    movie: movieSample.movie,
                },
            ]),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/people/1/known_for",
            body: JSON.stringify(wrappedMovieItems),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: `https://api.trakt.tv/people/${personCreditsSample.personId}/movies`,
            body: personCreditsSample.body,
            headers: {
                "user-agent": "Rippple/1.0",
            },
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                const movie = Array.isArray(payload.cast) ? payload.cast[0]?.movie : null;
                assert.equal(movie?.title, "覆盖人物作品中文电影");
            },
        },
        {
            url: `https://api.trakt.tv/people/${personCreditsSample.personId}/shows`,
            body: JSON.stringify({
                cast: [
                    {
                        show: showSample.show,
                    },
                ],
                crew: {},
            }),
            headers: {
                "user-agent": "Rippple/1.0",
            },
            persistentData: createUnifiedPersistentData({ traktTranslation: showTranslation }),
            assertPayload(payload) {
                const show = Array.isArray(payload.cast) ? payload.cast[0]?.show : null;
                assert.equal(show?.title, expectedShowTitle);
            },
        },
        {
            url: "https://api.trakt.tv/people/this_month",
            body: JSON.stringify([
                {
                    name: "Tom Hanks",
                    biography: "An American actor and filmmaker.",
                    ids: {
                        trakt: 42,
                    },
                },
            ]),
            persistentData: createUnifiedPersistentData({
                googlePeople: JSON.parse(createPeopleTranslationCache()),
            }),
            assertPayload(payload) {
                assert.match(payload[0].name, /^汤姆·汉克斯/);
                assert.equal(payload[0].biography, "一位美国演员和电影制作人。");
            },
        },
        {
            url: "https://api.trakt.tv/users/me/mir",
            body: JSON.stringify(mirPayload),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload.first_watched.movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/users/me/following/activities",
            body: JSON.stringify(wrappedMovieItems),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/users/me/lists/1/items",
            body: JSON.stringify(wrappedMovieItems),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/users/me/lists/1/items/movie",
            body: JSON.stringify(wrappedMovieItems),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/users/me/lists/1/items/movie,show",
            body: JSON.stringify([
                {
                    type: "movie",
                    movie: movieSample.movie,
                },
            ]),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/users/me/lists/1/items/movie,show,season,episode",
            body: JSON.stringify([
                {
                    type: "movie",
                    movie: movieSample.movie,
                },
            ]),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/lists/1/items",
            body: JSON.stringify(wrappedMovieItems),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/lists/1/items/movie",
            body: JSON.stringify(wrappedMovieItems),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/lists/1/items/movie,show",
            body: JSON.stringify([
                {
                    type: "movie",
                    movie: movieSample.movie,
                },
            ]),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/lists/1/items/movie,show,episode,season",
            body: JSON.stringify([
                {
                    type: "movie",
                    movie: movieSample.movie,
                },
            ]),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/users/me/ratings/all",
            body: JSON.stringify(wrappedMovieItems),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/users/me/ratings/movies",
            body: JSON.stringify(wrappedMovieItems),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/users/me/favorites/movies",
            body: JSON.stringify(wrappedMovieItems),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/users/me/favorites",
            body: JSON.stringify([
                {
                    type: "movie",
                    movie: movieSample.movie,
                },
            ]),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/users/me/favorites/media/rank",
            body: JSON.stringify([
                {
                    type: "movie",
                    movie: movieSample.movie,
                },
            ]),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/comments/recent/movies/weekly",
            body: JSON.stringify(recentCommentItems),
            persistentData: createUnifiedPersistentData({
                traktTranslation: movieTranslation,
                googleComments: commentTranslation,
            }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
                assert.equal(payload[0].comment.comment, "覆盖中文评论");
            },
        },
        {
            url: "https://api.trakt.tv/movies/trending",
            body: JSON.stringify(wrappedMovieItems),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/media/trending",
            body: JSON.stringify([
                {
                    type: "movie",
                    movie: movieSample.movie,
                },
            ]),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/movies/recommendations",
            body: JSON.stringify(wrappedMovieItems),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/media/recommendations",
            body: JSON.stringify(wrappedMovieItems),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/media/anticipated",
            body: JSON.stringify(wrappedMovieItems),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/movies/anticipated",
            body: JSON.stringify(wrappedMovieItems),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/movies/boxoffice",
            body: JSON.stringify(directMovieItems),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].title, "覆盖直出中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/media/popular/next",
            body: JSON.stringify([
                {
                    show: {
                        title: showSample.show.title,
                        overview: showSample.show.overview,
                        first_aired: showSample.show.first_aired,
                        network: showSample.show.network,
                        tagline: showSample.show.tagline,
                        ids: showSample.show.ids,
                    },
                },
            ]),
            persistentData: createUnifiedPersistentData({ traktTranslation: showTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].show.title, expectedShowTitle);
            },
        },
        {
            url: "https://api.trakt.tv/shows/popular",
            body: JSON.stringify(directShowItems),
            persistentData: createUnifiedPersistentData({ traktTranslation: showTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].title, expectedShowTitle);
            },
        },
        {
            url: "https://api.trakt.tv/users/me/watchlist",
            body: JSON.stringify(wrappedMovieItems),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/users/me/watchlist/movies",
            body: JSON.stringify(wrappedMovieItems),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/users/me/watchlist/movie,show/rank",
            body: JSON.stringify([
                {
                    type: "movie",
                    movie: movieSample.movie,
                },
            ]),
            persistentData: createUnifiedPersistentData({ traktTranslation: movieTranslation }),
            assertPayload(payload) {
                assert.equal(payload[0].movie.title, "覆盖中文电影");
            },
        },
        {
            url: "https://api.trakt.tv/users/settings",
            body: readFixture("user-settings.json"),
            assertPayload(payload) {
                assert.equal(payload.user.vip, true);
                assert.equal(payload.account.display_ads, false);
                assert.equal(payload.browsing.watchnow.favorites.includes("sg-forward"), true);
            },
        },
        {
            url: "https://api.themoviedb.org/3/watch/providers/movie",
            body: readFixture("tmdb-provider-catalog.json"),
            headers: {
                "user-agent": "Sofa Time/1.0",
            },
            assertPayload(payload) {
                assert.equal(
                    payload.results.some((item) => item.provider_id === 2),
                    true,
                );
            },
        },
        {
            url: "https://api.themoviedb.org/3/watch/providers/tv",
            body: readFixture("tmdb-provider-catalog.json"),
            headers: {
                "user-agent": "Sofa Time/1.0",
            },
            assertPayload(payload) {
                assert.equal(
                    payload.results.some((item) => item.provider_id === 2),
                    true,
                );
            },
        },
        {
            url: "https://streaming-availability.p.rapidapi.com/shows/tt1234567",
            body: readFixture("sofa-streaming-availability.json"),
            headers: {
                "user-agent": "Sofa Time/1.0",
            },
            assertPayload(payload) {
                assert.equal(
                    payload.streamingOptions.us.some((item) => item.service.id === "forward"),
                    true,
                );
            },
        },
        {
            url: "https://streaming-availability.p.rapidapi.com/countries/us",
            body: readFixture("sofa-countries.json"),
            headers: {
                "user-agent": "Sofa Time/1.0",
            },
            assertPayload(payload) {
                assert.equal(
                    payload.services.some((item) => item.id === "forward"),
                    true,
                );
            },
        },
        {
            url: "https://api.trakt.tv/watchnow/sources",
            body: readFixture("watchnow-sources.json"),
            assertPayload(payload) {
                assert.equal(
                    payload.some((item) => Array.isArray(item.sg) && item.sg.some((source) => source.source === "forward")),
                    true,
                );
            },
        },
        {
            url: "https://api.trakt.tv/movies/123/people",
            body: readFixture("media-people-list.json"),
            persistentData: createUnifiedPersistentData({
                googlePeople: JSON.parse(createPeopleTranslationCache()),
            }),
            assertPayload(payload) {
                assert.match(payload.cast[0].person.name, /^汤姆·汉克斯/);
            },
        },
        {
            url: "https://api.trakt.tv/shows/123/people",
            body: readFixture("media-people-list.json"),
            persistentData: createUnifiedPersistentData({
                googlePeople: JSON.parse(createPeopleTranslationCache()),
            }),
            assertPayload(payload) {
                assert.match(payload.cast[0].person.name, /^汤姆·汉克斯/);
            },
        },
        {
            url: "https://api.trakt.tv/shows/123/seasons/1/episodes/2/people",
            body: readFixture("media-people-list.json"),
            persistentData: createUnifiedPersistentData({
                googlePeople: JSON.parse(createPeopleTranslationCache()),
            }),
            assertPayload(payload) {
                assert.match(payload.cast[0].person.name, /^汤姆·汉克斯/);
            },
        },
        {
            url: "https://api.trakt.tv/movies/123/comments/newest",
            body: readFixture("comments.json"),
            persistentData: createUnifiedPersistentData({
                googleComments: JSON.parse(createCommentTranslationCache()),
            }),
            assertPayload(payload) {
                assert.equal(payload[0].comment, "很棒的电影");
            },
        },
        {
            url: "https://api.trakt.tv/shows/123/comments/newest",
            body: readFixture("comments.json"),
            persistentData: createUnifiedPersistentData({
                googleComments: JSON.parse(createCommentTranslationCache()),
            }),
            assertPayload(payload) {
                assert.equal(payload[0].comment, "很棒的电影");
            },
        },
        {
            url: "https://api.trakt.tv/shows/123/seasons/1/episodes/2/comments/newest",
            body: readFixture("comments.json"),
            persistentData: createUnifiedPersistentData({
                googleComments: JSON.parse(createCommentTranslationCache()),
            }),
            assertPayload(payload) {
                assert.equal(payload[0].comment, "很棒的电影");
            },
        },
        {
            url: "https://api.trakt.tv/comments/123/replies",
            body: readFixture("comments.json"),
            persistentData: createUnifiedPersistentData({
                googleComments: JSON.parse(createCommentTranslationCache()),
            }),
            assertPayload(payload) {
                assert.equal(payload[0].comment, "很棒的电影");
            },
        },
        {
            url: "https://api.trakt.tv/movies/123/translations/zh?extended=all",
            body: readFixture("translations.json"),
            assertPayload(payload) {
                assert.equal(payload[0].country, "cn");
            },
        },
        {
            url: "https://api.trakt.tv/shows/456/translations/zh?extended=all",
            body: readFixture("translations.json"),
            assertPayload(payload) {
                assert.equal(payload[0].country, "cn");
            },
        },
        {
            url: "https://api.trakt.tv/shows/555/seasons/1/episodes/2/translations/zh?extended=all",
            body: JSON.stringify([
                {
                    language: "zh",
                    country: "cn",
                    title: "剧集中文标题",
                    overview: "剧集中文简介",
                },
            ]),
            assertPayload(payload) {
                assert.equal(payload[0].country, "cn");
            },
        },
        {
            url: "https://api.trakt.tv/movies/123/watchnow",
            body: readFixture("movie-watchnow.json"),
            persistentData: createUnifiedPersistentData({
                traktLinkIds: {
                    123: createWatchnowIdsEntry(),
                },
            }),
            assertPayload(payload) {
                assert.equal(
                    payload.us.free.some((item) => item.source === "forward"),
                    true,
                );
            },
        },
        {
            url: "https://api.trakt.tv/shows/456/watchnow",
            body: readFixture("movie-watchnow.json"),
            persistentData: createUnifiedPersistentData({
                traktLinkIds: {
                    456: createWatchnowIdsEntry({
                        ids: {
                            trakt: 456,
                            tmdb: 654,
                        },
                    }),
                },
            }),
            assertPayload(payload) {
                assert.equal(
                    payload.us.free.some((item) => item.source === "forward"),
                    true,
                );
            },
        },
        {
            url: "https://api.trakt.tv/episodes/789/watchnow",
            body: readFixture("movie-watchnow.json"),
            persistentData: createUnifiedPersistentData({
                traktLinkIds: {
                    789: createEpisodeWatchnowIdsEntry({
                        ids: {
                            trakt: 789,
                            tmdb: 9001,
                        },
                        showIds: {
                            trakt: 555,
                            tmdb: 654,
                            imdb: "tt-show",
                        },
                        seasonNumber: 1,
                        episodeNumber: 2,
                    }),
                },
            }),
            assertPayload(payload) {
                assert.equal(
                    payload.us.free.some((item) => item.source === "forward"),
                    true,
                );
            },
        },
        {
            url: "https://api.trakt.tv/shows/555/seasons",
            body: readFixture("season-list.json"),
            persistentData: createUnifiedPersistentData({
                persistentCurrentSeason: { showId: "555", seasonNumber: 1 },
                traktTranslation: {
                    "episode:555:1:1": createMediaTranslationEntry({
                        translation: {
                            title: "第一集中文",
                            overview: "第一集中文简介",
                            tagline: "第一集中文标语",
                        },
                    }),
                    "episode:555:1:2": createMediaTranslationEntry({
                        translation: {
                            title: "第二集中文",
                            overview: "第二集中文简介",
                            tagline: "第二集中文标语",
                        },
                    }),
                },
            }),
            assertPayload(payload) {
                assert.equal(
                    payload[0].episodes.some((episode) => episode.title === "第一集中文"),
                    true,
                );
            },
        },
        {
            url: "https://apiz.trakt.tv/v3/media/movie/123/info/5/version/1",
            body: readFixture("sentiments.json"),
            persistentData: createUnifiedPersistentData({
                googleSentiments: JSON.parse(createSentimentTranslationCache()),
            }),
            assertPayload(payload) {
                assert.equal(payload.aspect.pros[0].theme, "剧情");
            },
        },
        {
            url: "https://apiz.trakt.tv/v3/media/show/123/info/5/version/1",
            body: readFixture("sentiments.json"),
            persistentData: createUnifiedPersistentData({
                googleSentiments: (() => {
                    const sentiments = JSON.parse(createSentimentTranslationCache());
                    sentiments["show:123"] = sentiments["movie:123"];
                    return sentiments;
                })(),
            }),
            assertPayload(payload) {
                assert.equal(payload.aspect.pros[0].theme, "剧情");
            },
        },
        {
            url: "https://api.trakt.tv/movies/123/sentiments",
            body: readFixture("sentiments.json"),
            persistentData: createUnifiedPersistentData({
                googleSentiments: JSON.parse(createSentimentTranslationCache()),
            }),
            assertPayload(payload) {
                assert.equal(payload.aspect.pros[0].theme, "剧情");
            },
        },
        {
            url: "https://api.trakt.tv/shows/123/sentiments",
            body: readFixture("sentiments.json"),
            persistentData: createUnifiedPersistentData({
                googleSentiments: (() => {
                    const sentiments = JSON.parse(createSentimentTranslationCache());
                    sentiments["show:123"] = sentiments["movie:123"];
                    return sentiments;
                })(),
            }),
            assertPayload(payload) {
                assert.equal(payload.aspect.pros[0].theme, "剧情");
            },
        },
        {
            url: "https://api.trakt.tv/movies/123",
            body: readFixture("movie-detail.json"),
            persistentData: createUnifiedPersistentData({
                traktTranslation: {
                    "movie:123": createMediaTranslationEntry(),
                },
            }),
            assertPayload(payload) {
                assert.equal(payload.title, "中文电影");
            },
        },
        {
            url: `https://api.trakt.tv/shows/${showSample.traktId}`,
            body: JSON.stringify(showSample.show),
            persistentData: createUnifiedPersistentData({
                traktTranslation: showTranslation,
            }),
            assertPayload(payload) {
                assert.equal(payload.title, expectedShowTitle);
            },
        },
        {
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
            persistentData: createUnifiedPersistentData({
                traktTranslation: {
                    "episode:555:1:2": createMediaTranslationEntry({
                        translation: {
                            title: "第二集中文",
                            overview: "第二集中文简介",
                            tagline: "第二集中文标语",
                        },
                    }),
                },
            }),
            assertPayload(payload) {
                assert.equal(payload.title, "第二集中文");
            },
        },
        {
            url: "https://api.trakt.tv/people/42",
            body: readFixture("people-detail.json"),
            persistentData: createUnifiedPersistentData({
                googlePeople: JSON.parse(createPeopleTranslationCache()),
            }),
            assertPayload(payload) {
                assert.match(payload.name, /^汤姆·汉克斯/);
            },
        },
    ];

    const responseRoutes = createResponsePhaseRoutes();

    const matchedRouteIds = collectMatchedResponseEntryIds(
        responseRoutes,
        responseCases.map((item) => item.url),
    );
    assert.deepEqual(
        [...matchedRouteIds].sort(),
        flattenResponseRouteEntries(responseRoutes)
            .map((entry) => entry.id)
            .sort(),
    );

    for (const item of responseCases) {
        await t.test(item.url, async () => {
            const { result } = await runLiveResponseCase(config, {
                url: item.url,
                argument: {
                    backendBaseUrl: config.backendBaseUrl,
                },
                headers: {
                    ...createScriptRequestHeaders(config),
                    ...(item.headers ?? {}),
                },
                body: item.body,
                persistentData: item.persistentData,
                httpGetMocks: {
                    [`${config.backendBaseUrl}/api/trakt/translation-overrides`]: JSON.stringify({
                        shows: {},
                        movies: {},
                        episodes: {},
                    }),
                    ...(item.httpGetMocks ?? {}),
                },
            });

            const payload = JSON.parse(result.body);
            item.assertPayload(payload);
        });
    }
});

test("live script: request route coverage matrix covers all request phase routes", async (t) => {
    const config = getLiveConfig();
    const requestCases = [
        {
            url: `${WATCHNOW_REDIRECT_URL}?deeplink=infuse%3A%2F%2Fmovie%2F123`,
            argument: {
                useShortcutsJumpEnabled: true,
            },
            assertResult(result) {
                assert.equal(result.response.status, 302);
                assert.match(result.response.headers.Location, /^shortcuts:\/\/run-shortcut\?/);
            },
        },
        {
            url: "https://image.tmdb.org/t/p/w342/forward_logo.webp",
            assertResult(result) {
                assert.equal(result.response.status, 302);
                assert.equal(
                    result.response.headers.Location,
                    "https://raw.githubusercontent.com/DemoJameson/Proxy.Modules/main/trakt_simplified_chinese/images/forward_logo.webp",
                );
            },
        },
        {
            url: "https://api.trakt.tv/shows/123/seasons/2",
            assertResult(result) {
                assert.equal(Object.keys(result).length, 0);
            },
        },
        {
            url: "https://api.trakt.tv/users/test/history/episodes?page=2&limit=10",
            assertResult(result) {
                assert.equal(result.url, "https://api.trakt.tv/users/test/history/episodes?page=2&limit=500");
            },
        },
        {
            url: "https://api.trakt.tv/users/test/history?page=2&limit=10",
            headers: {
                "user-agent": "Rippple/1.0",
            },
            assertResult(result) {
                assert.equal(result.url, "https://api.trakt.tv/users/test/history?page=2&limit=100");
            },
        },
    ];

    const requestRoutes = createRequestPhaseRoutes();

    const matchedPatterns = new Set();
    requestCases.forEach((item) => {
        const url = new URL(item.url);
        const route = requestRoutes.find((entry) => entry.test({ url }));
        assert.ok(route, `No request route matched ${item.url}`);
        matchedPatterns.add(route.id);
    });
    assert.equal(matchedPatterns.size, requestRoutes.length);

    for (const item of requestCases) {
        await t.test(item.url, async () => {
            const { result } = await runLiveRequestCase(config, {
                url: item.url,
                argument: item.argument,
                headers: item.headers ? createScriptRequestHeaders(config, item.headers) : createScriptRequestHeaders(config),
            });

            item.assertResult(result);
        });
    }
});
