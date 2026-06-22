import assert from "node:assert/strict";
import test from "node:test";

import {
    computeStringHash,
    createGoogleTranslateResponse,
    createHttpErrorMock,
    createHttpStatusMock,
    createInvalidJsonResponse,
    createMovieTranslationCache,
    createPeopleTranslationCache,
    createTmdbMovieCreditsResponse,
    createUnifiedPersistentData,
    createWatchnowIdsCache,
    extractDeepLxRequestTexts,
    parseUnifiedCache,
    readFixture,
    runResponseCase,
} from "./helpers/trakt-test-helpers.mjs";

const GOOGLE_TRANSLATE_URL = "https://deeplx.demojameson.de5.net/deepl";
const TMDB_MOVIE_CREDITS_URL = "regex:^https://api\\.tmdb\\.org/3/movie/456\\?";
const TMDB_PERSON_URL = "regex:^https://api\\.tmdb\\.org/3/person/31\\?";
const DOUBAN_SEARCH_TT123_MOVIE_URL = "https://frodo.douban.com/api/v2/search/suggestion?q=tt123&apikey=0ac44ae016490db2204ce0a042db2916";
const DOUBAN_SEARCH_TT456_TV_URL = "https://frodo.douban.com/api/v2/search/suggestion?q=tt456&apikey=0ac44ae016490db2204ce0a042db2916";
const DOUBAN_SEARCH_TTSEASON_TV_URL = "https://frodo.douban.com/api/v2/search/suggestion?q=ttseason201&apikey=0ac44ae016490db2204ce0a042db2916";
const DOUBAN_MOVIE_CREDITS_35517044_URL = "https://frodo.douban.com/api/v2/movie/35517044/credits_stats?start=0&count=1000&apikey=0ac44ae016490db2204ce0a042db2916";
const DOUBAN_MOVIE_CREDITS_4707205_URL = "https://frodo.douban.com/api/v2/movie/4707205/credits_stats?start=0&count=1000&apikey=0ac44ae016490db2204ce0a042db2916";
const DOUBAN_TV_SEASONS_35517044_URL = "https://frodo.douban.com/api/v2/tv/35517044/seasons?apikey=0ac44ae016490db2204ce0a042db2916";
const TRAKT_SHOW_123_DETAIL_URL = "https://api.trakt.tv/shows/123?extended=cloud9,full,watchnow";
const TRAKT_SEASON_2_EPISODE_1_URL = "https://api.trakt.tv/shows/123/seasons/2/episodes/1?extended=cloud9,full,watchnow";

function createDoubanSearchResponse(id, targetType = "movie") {
    return JSON.stringify({
        cards: [
            {
                target_id: id,
                target_type: targetType,
                target: {
                    id,
                },
            },
        ],
    });
}

function createDoubanCreditsResponse(simpleCharacter, name = "汤姆·汉克斯") {
    return JSON.stringify({
        items: [
            {
                name,
                category: "演员",
                roles: ["演员"],
                simple_character: simpleCharacter,
            },
            {
                name: "导演甲",
                category: "导演",
                roles: ["导演"],
                simple_character: "导演",
            },
        ],
    });
}

function createTraktEpisodeDetailResponse(imdb = "ttseason201") {
    return JSON.stringify({
        season: 2,
        number: 1,
        ids: {
            trakt: 201,
            imdb,
        },
    });
}

function createTraktShowDetailResponse(language = "zh", imdb = "tt456") {
    return JSON.stringify({
        title: "测试剧集",
        language,
        ids: {
            trakt: 123,
            tmdb: 456,
            imdb,
        },
    });
}

const peopleDetailGoogleFailureCases = [
    {
        name: "people detail 在 Google 翻译失败时会保留原文且不写入缓存",
        mock: createHttpErrorMock("google translate unavailable"),
    },
    {
        name: "people detail 在 Google 返回 HTTP 500 时会保留原文且不写入缓存",
        mock: createHttpStatusMock(500),
    },
    {
        name: "people detail 在 Google 返回非法 JSON 时会保留原文且不写入缓存",
        mock: createInvalidJsonResponse(),
    },
];

const mediaPeopleTmdbFallbackCases = [
    {
        name: "media people 列表在 TMDb 返回非法 JSON 时仍可回退到 Google 翻译",
        mock: createInvalidJsonResponse(),
    },
    {
        name: "media people 列表在 TMDb 返回 HTTP 500 时仍可回退到 Google 翻译",
        mock: createHttpStatusMock(500),
    },
];

test("/people/:id 会应用缓存中的中文姓名和 biography", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/people/42",
        body: readFixture("people-detail.json"),
        persistentData: createUnifiedPersistentData({
            googlePeople: JSON.parse(createPeopleTranslationCache()),
        }),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.name, "汤姆·汉克斯\nTom Hanks");
    assert.equal(payload.biography, "一位美国演员和电影制作人。");
});

test("googleTranslationEnabled=false 时 people detail 不触发 Google 翻译，仍保留缓存并允许 TMDb 姓名回退", async () => {
    const cachedPeople = JSON.parse(createPeopleTranslationCache());
    const { result, persistentData, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/people/42",
        body: readFixture("people-detail.json"),
        argument: {
            googleTranslationEnabled: false,
        },
        persistentData: createUnifiedPersistentData({
            googlePeople: cachedPeople,
        }),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.name, "汤姆·汉克斯\nTom Hanks");
    assert.equal(payload.biography, "一位美国演员和电影制作人。");
    const cache = parseUnifiedCache(persistentData).google.people;
    assert.equal(cache["42"].name.translatedText, "汤姆·汉克斯");
    assert.equal(cache["42"].biography.translatedText, "一位美国演员和电影制作人。");
    assert.equal(
        httpLogs.some((entry) => entry.method === "POST" && entry.url === GOOGLE_TRANSLATE_URL),
        false,
    );
});

test("people detail 会通过 Google 翻译未命中的姓名和 biography 并写回缓存", async () => {
    const body = JSON.stringify({
        name: "Tom Hanks",
        biography: "An American actor and filmmaker.",
        ids: {
            trakt: 42,
        },
    });

    const { result, persistentData, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/people/42",
        body,
        httpPostMocks: {
            "https://translation.googleapis.com/language/translate/v2": createGoogleTranslateResponse(["汤姆·汉克斯", "一位美国演员和电影制作人。"]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.name, "汤姆·汉克斯\nTom Hanks");
    assert.equal(payload.biography, "一位美国演员和电影制作人。");
    const googleRequestBody = httpLogs.find((entry) => entry.method === "POST" && entry.url === GOOGLE_TRANSLATE_URL)?.body ?? "";
    assert.deepEqual(extractDeepLxRequestTexts(googleRequestBody), ["Tom Hanks", "An American actor and filmmaker."]);

    const cache = parseUnifiedCache(persistentData).google.people;
    assert.equal(cache["42"].name.translatedText, "汤姆·汉克斯");
    assert.equal(cache["42"].name.sourceTextHash, computeStringHash("Tom Hanks"));
    assert.equal(cache["42"].name.source, "google");
    assert.equal(cache["42"].biography.translatedText, "一位美国演员和电影制作人。");
    assert.equal(cache["42"].biography.sourceTextHash, computeStringHash("An American actor and filmmaker."));
});

test("googleTranslationEnabled=false 时 people detail 不翻译 biography，且不触发 Google 请求", async () => {
    const { result, persistentData, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/people/42",
        body: readFixture("people-detail.json"),
        argument: {
            googleTranslationEnabled: false,
        },
        httpGetMocks: {
            [TMDB_PERSON_URL]: JSON.stringify({
                name: "汤姆·汉克斯",
            }),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.name, "汤姆·汉克斯\nTom Hanks");
    assert.equal(payload.biography, "An American actor and filmmaker.");
    assert.equal(parseUnifiedCache(persistentData).google.people["42"].biography, undefined);
    assert.equal(
        httpLogs.some((entry) => entry.method === "POST" && entry.url === GOOGLE_TRANSLATE_URL),
        false,
    );
});

test("people detail 遇到 sourceTextHash 不匹配的 biography 缓存时会忽略旧值并刷新缓存", async () => {
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/people/42",
        body: readFixture("people-detail.json"),
        persistentData: createUnifiedPersistentData({
            googlePeople: JSON.parse(
                createPeopleTranslationCache({
                    42: {
                        biography: {
                            sourceTextHash: "deadbeef",
                            translatedText: "旧简介",
                        },
                    },
                }),
            ),
        }),
        httpPostMocks: {
            "https://translation.googleapis.com/language/translate/v2": createGoogleTranslateResponse(["一位美国演员和电影制作人。"]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.name, "汤姆·汉克斯\nTom Hanks");
    assert.equal(payload.biography, "一位美国演员和电影制作人。");

    const cache = parseUnifiedCache(persistentData).google.people;
    assert.equal(cache["42"].biography.translatedText, "一位美国演员和电影制作人。");
    assert.equal(cache["42"].biography.sourceTextHash, computeStringHash("An American actor and filmmaker."));
});

test("people detail 遇到旧的 name.sourceText 缓存时会视为未命中并按新结构重建", async () => {
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/people/42",
        body: readFixture("people-detail.json"),
        persistentData: createUnifiedPersistentData({
            googlePeople: {
                42: {
                    name: {
                        sourceText: "Tom Hanks",
                        translatedText: "旧姓名",
                    },
                },
            },
        }),
        httpPostMocks: {
            [GOOGLE_TRANSLATE_URL]: createGoogleTranslateResponse(["汤姆·汉克斯", "一位美国演员和电影制作人。"]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.name, "汤姆·汉克斯\nTom Hanks");

    const cache = parseUnifiedCache(persistentData).google.people;
    assert.deepEqual(cache["42"].name, {
        sourceTextHash: computeStringHash("Tom Hanks"),
        translatedText: "汤姆·汉克斯",
        source: "google",
    });
});

test("people detail 已有 google name 缓存时，TMDb 中文名会覆盖并改写为 tmdb 来源", async () => {
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/people/42",
        body: readFixture("people-detail.json"),
        persistentData: createUnifiedPersistentData({
            googlePeople: {
                42: {
                    name: {
                        sourceTextHash: computeStringHash("Tom Hanks"),
                        translatedText: "谷歌译名",
                        source: "google",
                    },
                },
            },
        }),
        httpGetMocks: {
            [TMDB_PERSON_URL]: JSON.stringify({
                name: "汤姆·汉克斯",
            }),
        },
        httpPostMocks: {
            [GOOGLE_TRANSLATE_URL]: createGoogleTranslateResponse(["Google Name", "一位美国演员和电影制作人。"]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.name, "汤姆·汉克斯\nTom Hanks");

    const cache = parseUnifiedCache(persistentData).google.people;
    assert.deepEqual(cache["42"].name, {
        sourceTextHash: computeStringHash("Tom Hanks"),
        translatedText: "汤姆·汉克斯",
        source: "tmdb",
    });
});

test("people detail 已有 tmdb name 缓存时，Google 返回结果不能覆盖", async () => {
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/people/42",
        body: JSON.stringify({
            name: "Thomas Hanks",
            biography: "An American actor and filmmaker.",
            ids: {
                trakt: 42,
            },
        }),
        persistentData: createUnifiedPersistentData({
            googlePeople: {
                42: {
                    name: {
                        sourceTextHash: computeStringHash("Tom Hanks"),
                        translatedText: "汤姆·汉克斯",
                        source: "tmdb",
                    },
                },
            },
        }),
        httpPostMocks: {
            [GOOGLE_TRANSLATE_URL]: createGoogleTranslateResponse(["谷歌姓名", "一位美国演员和电影制作人。"]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.name, "谷歌姓名\nThomas Hanks");

    const cache = parseUnifiedCache(persistentData).google.people;
    assert.deepEqual(cache["42"].name, {
        sourceTextHash: computeStringHash("Tom Hanks"),
        translatedText: "汤姆·汉克斯",
        source: "tmdb",
    });
});

test("people detail 翻译 biography 时会用 TMDb 中文名作为 Google 语境并移除返回前缀", async () => {
    const { result, persistentData, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/people/tom-hanks?extended=full",
        body: readFixture("people-detail.json"),
        persistentData: createUnifiedPersistentData({
            googlePeople: JSON.parse(
                createPeopleTranslationCache({
                    42: {
                        name: {
                            sourceTextHash: computeStringHash("Tom Hanks"),
                            translatedText: "汤姆·汉克斯",
                            source: "tmdb",
                        },
                        biography: undefined,
                    },
                }),
            ),
        }),
        httpPostMocks: {
            [GOOGLE_TRANSLATE_URL]: createGoogleTranslateResponse(["Tom Hanks (汤姆·汉克斯)\n一位美国演员和电影制作人。"]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.name, "汤姆·汉克斯\nTom Hanks");
    assert.equal(payload.biography, "一位美国演员和电影制作人。");
    const googleRequestBody = httpLogs.find((entry) => entry.method === "POST" && entry.url === GOOGLE_TRANSLATE_URL)?.body ?? "";
    assert.deepEqual(extractDeepLxRequestTexts(googleRequestBody), ["§Tom Hanks (汤姆·汉克斯)§An American actor and filmmaker."]);

    const cache = parseUnifiedCache(persistentData).google.people;
    assert.equal(cache["42"].biography.sourceTextHash, computeStringHash("An American actor and filmmaker."));
    assert.equal(cache["42"].biography.translatedText, "一位美国演员和电影制作人。");
});

test("people detail 翻译 biography 时不会删除冒号格式语境前缀", async () => {
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/people/tom-hanks?extended=full",
        body: readFixture("people-detail.json"),
        persistentData: createUnifiedPersistentData({
            googlePeople: JSON.parse(
                createPeopleTranslationCache({
                    42: {
                        name: {
                            sourceTextHash: computeStringHash("Tom Hanks"),
                            translatedText: "汤姆·汉克斯",
                            source: "tmdb",
                        },
                        biography: undefined,
                    },
                }),
            ),
        }),
        httpPostMocks: {
            [GOOGLE_TRANSLATE_URL]: createGoogleTranslateResponse(["Tom Hanks (汤姆·汉克斯)：一位美国演员和电影制作人。"]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.biography, "Tom Hanks (汤姆·汉克斯)：一位美国演员和电影制作人。");

    const cache = parseUnifiedCache(persistentData).google.people;
    assert.equal(cache["42"].biography.translatedText, "Tom Hanks (汤姆·汉克斯)：一位美国演员和电影制作人。");
});

test("people detail 翻译 biography 时不会删除半角冒号前缀", async () => {
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/people/tom-hanks?extended=full",
        body: readFixture("people-detail.json"),
        persistentData: createUnifiedPersistentData({
            googlePeople: JSON.parse(
                createPeopleTranslationCache({
                    42: {
                        name: {
                            sourceTextHash: computeStringHash("Tom Hanks"),
                            translatedText: "汤姆·汉克斯",
                            source: "tmdb",
                        },
                        biography: undefined,
                    },
                }),
            ),
        }),
        httpPostMocks: {
            [GOOGLE_TRANSLATE_URL]: createGoogleTranslateResponse(["简介: 一位美国演员和电影制作人。"]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.biography, "简介: 一位美国演员和电影制作人。");

    const cache = parseUnifiedCache(persistentData).google.people;
    assert.equal(cache["42"].biography.translatedText, "简介: 一位美国演员和电影制作人。");
});

test("people detail 无 TMDb 姓名缓存时会先请求 TMDb 再用中文名翻译 biography", async () => {
    const { result, persistentData, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/people/tom-hanks?extended=full",
        body: readFixture("people-detail.json"),
        httpGetMocks: {
            [TMDB_PERSON_URL]: JSON.stringify({
                name: "汤姆·汉克斯",
            }),
        },
        httpPostMocks: {
            [GOOGLE_TRANSLATE_URL]: createGoogleTranslateResponse(["Tom Hanks (汤姆·汉克斯)\n一位美国演员和电影制作人。"]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.name, "汤姆·汉克斯\nTom Hanks");
    assert.equal(payload.biography, "一位美国演员和电影制作人。");

    const googleRequestBody = httpLogs.find((entry) => entry.method === "POST" && entry.url === GOOGLE_TRANSLATE_URL)?.body ?? "";
    assert.deepEqual(extractDeepLxRequestTexts(googleRequestBody), ["§Tom Hanks (汤姆·汉克斯)§An American actor and filmmaker."]);

    const cache = parseUnifiedCache(persistentData).google.people;
    assert.equal(cache["42"].name.translatedText, "汤姆·汉克斯");
    assert.equal(cache["42"].name.source, "tmdb");
    assert.equal(cache["42"].biography.translatedText, "一位美国演员和电影制作人。");
});

test("people detail 获取不到 TMDb 中文名时 biography 不添加 Google 语境", async () => {
    const { result, persistentData, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/people/tom-hanks?extended=full",
        body: readFixture("people-detail.json"),
        httpGetMocks: {
            [TMDB_PERSON_URL]: JSON.stringify({
                name: "Tom Hanks",
            }),
        },
        httpPostMocks: {
            [GOOGLE_TRANSLATE_URL]: createGoogleTranslateResponse(["汤姆·汉克斯", "一位美国演员和电影制作人。"]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.name, "汤姆·汉克斯\nTom Hanks");
    assert.equal(payload.biography, "一位美国演员和电影制作人。");

    const googleRequestBody = httpLogs.find((entry) => entry.method === "POST" && entry.url === GOOGLE_TRANSLATE_URL)?.body ?? "";
    assert.deepEqual(extractDeepLxRequestTexts(googleRequestBody), ["Tom Hanks", "An American actor and filmmaker."]);

    const cache = parseUnifiedCache(persistentData).google.people;
    assert.equal(cache["42"].name.translatedText, "汤姆·汉克斯");
    assert.equal(cache["42"].name.source, "google");
    assert.equal(cache["42"].biography.translatedText, "一位美国演员和电影制作人。");
});

test("people detail 已有 TMDb 姓名缓存和 biography 缓存时不会请求 Google", async () => {
    const { result, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/people/tom-hanks?extended=full",
        body: readFixture("people-detail.json"),
        persistentData: createUnifiedPersistentData({
            googlePeople: JSON.parse(
                createPeopleTranslationCache({
                    42: {
                        name: {
                            sourceTextHash: computeStringHash("Tom Hanks"),
                            translatedText: "汤姆·汉克斯",
                            source: "tmdb",
                        },
                    },
                }),
            ),
        }),
        httpPostMocks: {
            [GOOGLE_TRANSLATE_URL]: createGoogleTranslateResponse(["不应请求"]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.name, "汤姆·汉克斯\nTom Hanks");
    assert.equal(payload.biography, "一位美国演员和电影制作人。");
    assert.equal(
        httpLogs.some((entry) => entry.method === "POST" && entry.url === GOOGLE_TRANSLATE_URL),
        false,
    );
});

peopleDetailGoogleFailureCases.forEach(({ name, mock }) => {
    test(name, async () => {
        const body = JSON.stringify({
            name: "Tom Hanks",
            biography: "An American actor and filmmaker.",
            ids: {
                trakt: 42,
            },
        });

        const { result, persistentData } = await runResponseCase({
            url: "https://api.trakt.tv/people/42",
            body,
            httpPostMocks: {
                [GOOGLE_TRANSLATE_URL]: mock,
            },
        });

        const payload = JSON.parse(result.body);
        assert.equal(payload.name, "Tom Hanks");
        assert.equal(payload.biography, "An American actor and filmmaker.");
        assert.deepEqual(parseUnifiedCache(persistentData).google.people, {});
    });
});

test("media people 列表会应用缓存中的中文姓名", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/people",
        body: readFixture("media-people-list.json"),
        persistentData: createUnifiedPersistentData({
            googlePeople: JSON.parse(
                createPeopleTranslationCache({
                    42: {
                        biography: undefined,
                    },
                }),
            ),
        }),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.cast[0].person.name, "汤姆·汉克斯");
});

test("media people 列表会从 TMDb credits 补出中文姓名并写回缓存", async () => {
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/people",
        body: readFixture("media-people-list.json"),
        persistentData: createUnifiedPersistentData({
            traktLinkIds: JSON.parse(createWatchnowIdsCache()),
        }),
        httpGetMocks: {
            [TMDB_MOVIE_CREDITS_URL]: createTmdbMovieCreditsResponse(),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.cast[0].person.name, "汤姆·汉克斯");

    const cache = parseUnifiedCache(persistentData).google.people;
    assert.deepEqual(cache["42"].name, {
        sourceTextHash: computeStringHash("Tom Hanks"),
        translatedText: "汤姆·汉克斯",
        source: "tmdb",
    });
});

test("media people 列表会用豆瓣补全一人一角并写入缓存", async () => {
    const body = JSON.stringify({
        cast: [
            {
                person: {
                    name: "汤姆·汉克斯",
                    ids: {
                        trakt: 42,
                    },
                },
                character: "Detective",
                characters: ["Detective"],
            },
        ],
        crew: {
            directing: [
                {
                    person: {
                        name: "导演甲",
                    },
                    job: "Director",
                },
            ],
        },
    });
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/people",
        body,
        persistentData: createUnifiedPersistentData({
            traktLinkIds: {
                123: {
                    ids: {
                        trakt: 123,
                        tmdb: 456,
                        imdb: "tt123",
                    },
                    language: "zh",
                },
            },
        }),
        httpGetMocks: {
            [TMDB_MOVIE_CREDITS_URL]: createTmdbMovieCreditsResponse(),
            [DOUBAN_SEARCH_TT123_MOVIE_URL]: createDoubanSearchResponse("35517044", "movie"),
            [DOUBAN_MOVIE_CREDITS_35517044_URL]: createDoubanCreditsResponse("饰 张一昂"),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.cast[0].character, "张一昂");
    assert.deepEqual(payload.cast[0].characters, ["张一昂"]);
    assert.equal(payload.crew.directing[0].job, "Director");

    const cache = parseUnifiedCache(persistentData).douban;
    assert.equal(cache.search["movie:tt123"].id, "35517044");
    assert.deepEqual(cache.credits["35517044"].汤姆·汉克斯, ["张一昂"]);
});

test("media people 列表会处理一人多角、配音前缀和纯职位无效值", async () => {
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/people",
        body: JSON.stringify({
            cast: [
                {
                    person: {
                        name: "迈克尔·B·乔丹",
                    },
                    character: "Smoke / Stack",
                    characters: ["Smoke", "Stack"],
                },
                {
                    person: {
                        name: "小野大辅",
                    },
                    character: "Satoru Gojo (voice)",
                    characters: ["Satoru Gojo (voice)"],
                },
                {
                    person: {
                        name: "配音甲",
                    },
                    character: "Jotaro",
                    characters: ["Jotaro"],
                },
                {
                    person: {
                        name: "职位甲",
                    },
                    character: "Director",
                    characters: ["Director"],
                },
            ],
            crew: {},
        }),
        persistentData: createUnifiedPersistentData({
            traktLinkIds: {
                123: {
                    ids: {
                        trakt: 123,
                        tmdb: 456,
                        imdb: "tt123",
                    },
                    language: "ja",
                },
            },
        }),
        httpGetMocks: {
            [DOUBAN_SEARCH_TT123_MOVIE_URL]: createDoubanSearchResponse("35517044", "movie"),
            [DOUBAN_MOVIE_CREDITS_35517044_URL]: JSON.stringify({
                items: [
                    {
                        name: "迈克尔·B·乔丹",
                        category: "演员",
                        roles: ["演员"],
                        simple_character: "饰 Smoke / Stack",
                    },
                    {
                        name: "小野大辅",
                        category: "演员",
                        roles: ["演员", "配音"],
                        simple_character: "饰 五条悟",
                    },
                    {
                        name: "配音甲",
                        category: "演员",
                        roles: ["演员"],
                        simple_character: "配 空条承太郎",
                    },
                    {
                        name: "职位甲",
                        category: "演员",
                        roles: ["演员"],
                        simple_character: "配音",
                    },
                ],
            }),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.cast[0].character, "Smoke / Stack");
    assert.deepEqual(payload.cast[0].characters, ["Smoke", "Stack"]);
    assert.equal(payload.cast[1].character, "五条悟（配音）");
    assert.deepEqual(payload.cast[1].characters, ["五条悟（配音）"]);
    assert.equal(payload.cast[2].character, "空条承太郎（配音）");
    assert.deepEqual(payload.cast[2].characters, ["空条承太郎（配音）"]);
    assert.equal(payload.cast[3].character, "Director");
    assert.equal(parseUnifiedCache(persistentData).douban.credits["35517044"].职位甲, undefined);
});

test("media people 列表所有 characters 已含中文时跳过，部分中文时整体覆盖", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/people",
        body: JSON.stringify({
            cast: [
                {
                    person: {
                        name: "演员甲",
                    },
                    character: "角色甲 / Role B",
                    characters: ["角色甲", "Role B"],
                },
                {
                    person: {
                        name: "演员乙",
                    },
                    character: "角色丙",
                    characters: ["角色丙"],
                },
            ],
            crew: {},
        }),
        persistentData: createUnifiedPersistentData({
            traktLinkIds: {
                123: {
                    ids: {
                        trakt: 123,
                        tmdb: 456,
                        imdb: "tt123",
                    },
                    language: "ko",
                },
            },
            doubanSearch: {
                "movie:tt123": {
                    id: "35517044",
                    targetType: "movie",
                },
            },
            doubanCredits: {
                35517044: {
                    演员甲: ["豆瓣甲", "豆瓣乙"],
                    演员乙: ["豆瓣丙"],
                },
            },
        }),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.cast[0].character, "豆瓣甲 / 豆瓣乙");
    assert.deepEqual(payload.cast[0].characters, ["豆瓣甲", "豆瓣乙"]);
    assert.equal(payload.cast[1].character, "角色丙");
    assert.deepEqual(payload.cast[1].characters, ["角色丙"]);
});

test("show people 命中缺少 language 的 linkIds 缓存时会补 detail 后再请求豆瓣", async () => {
    const { result, httpLogs, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/shows/123/people",
        body: JSON.stringify({
            cast: [
                {
                    person: {
                        name: "任素汐",
                    },
                    character: "Hu Wenjing",
                    characters: ["Hu Wenjing"],
                },
            ],
            crew: {},
        }),
        persistentData: createUnifiedPersistentData({
            traktLinkIds: {
                123: {
                    ids: {
                        trakt: 123,
                        tmdb: 456,
                        imdb: "tt456",
                    },
                },
            },
        }),
        httpGetMocks: {
            [TRAKT_SHOW_123_DETAIL_URL]: createTraktShowDetailResponse("zh", "tt456"),
            [DOUBAN_SEARCH_TT456_TV_URL]: createDoubanSearchResponse("35517044", "tv"),
            [DOUBAN_TV_SEASONS_35517044_URL]: JSON.stringify([]),
            [DOUBAN_MOVIE_CREDITS_35517044_URL]: createDoubanCreditsResponse("饰 胡文静", "任素汐"),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.cast[0].character, "胡文静");
    assert.deepEqual(payload.cast[0].characters, ["胡文静"]);
    assert.equal(
        httpLogs.some((entry) => entry.url === TRAKT_SHOW_123_DETAIL_URL),
        true,
    );
    assert.equal(
        httpLogs.some((entry) => entry.url === DOUBAN_SEARCH_TT456_TV_URL),
        true,
    );
    const cache = parseUnifiedCache(persistentData);
    assert.equal(cache.trakt.linkIds["123"].language, "zh");
    assert.equal(cache.douban.search["tv:tt456"].id, "35517044");
});

test("show people 在豆瓣 seasons 请求失败时仍会使用主剧 credits 补全角色", async () => {
    const { result, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/shows/123/people",
        body: JSON.stringify({
            cast: [
                {
                    person: {
                        name: "任素汐",
                    },
                    character: "Hu Wenjing",
                    characters: ["Hu Wenjing"],
                },
            ],
            crew: {},
        }),
        persistentData: createUnifiedPersistentData({
            traktLinkIds: {
                123: {
                    ids: {
                        trakt: 123,
                        tmdb: 456,
                        imdb: "tt456",
                    },
                    language: "zh",
                },
            },
        }),
        httpGetMocks: {
            [DOUBAN_SEARCH_TT456_TV_URL]: createDoubanSearchResponse("35517044", "tv"),
            [DOUBAN_TV_SEASONS_35517044_URL]: createHttpErrorMock("douban seasons unavailable"),
            [DOUBAN_MOVIE_CREDITS_35517044_URL]: createDoubanCreditsResponse("饰 胡文静", "任素汐"),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.cast[0].character, "胡文静");
    assert.deepEqual(payload.cast[0].characters, ["胡文静"]);
    assert.equal(
        httpLogs.some((entry) => entry.url === DOUBAN_MOVIE_CREDITS_35517044_URL),
        true,
    );
});

test("characterTranslationEnabled=false 时不触发豆瓣补全", async () => {
    const { result, httpLogs, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/people",
        body: JSON.stringify({
            cast: [
                {
                    person: {
                        name: "汤姆·汉克斯",
                    },
                    character: "Detective",
                    characters: ["Detective"],
                },
            ],
            crew: {},
        }),
        argument: {
            characterTranslationEnabled: false,
        },
        persistentData: createUnifiedPersistentData({
            traktLinkIds: {
                123: {
                    ids: {
                        trakt: 123,
                        tmdb: 456,
                        imdb: "tt123",
                    },
                    language: "zh",
                },
            },
        }),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.cast[0].character, "Detective");
    assert.equal(
        httpLogs.some((entry) => entry.url.includes("frodo.douban.com")),
        false,
    );
    assert.deepEqual(parseUnifiedCache(persistentData).douban, {
        search: {},
        seasons: {},
        credits: {},
    });
});

test("episode people 可用已缓存 seasons 推断豆瓣季 ID 时不请求第一集 detail", async () => {
    const { result, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/shows/123/seasons/2/episodes/2/people",
        body: JSON.stringify({
            cast: [
                {
                    person: {
                        name: "汤姆·汉克斯",
                    },
                    character: "Detective",
                    characters: ["Detective"],
                },
            ],
            crew: {},
        }),
        persistentData: createUnifiedPersistentData({
            traktLinkIds: {
                123: {
                    ids: {
                        trakt: 123,
                        tmdb: 456,
                        imdb: "tt456",
                    },
                    language: "zh",
                },
            },
            doubanSearch: {
                "tv:tt456": {
                    id: "35517044",
                    targetType: "tv",
                },
            },
            doubanSeasons: {
                35517044: {
                    ids: ["4707205"],
                },
            },
            doubanCredits: {
                4707205: {
                    汤姆·汉克斯: ["第二季角色"],
                },
            },
        }),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.cast[0].character, "第二季角色");
    assert.equal(
        httpLogs.some((entry) => entry.url === TRAKT_SEASON_2_EPISODE_1_URL),
        false,
    );
});

test("episode people 无 seasons 缓存时用当前季第一集 imdb 查询豆瓣 ID", async () => {
    const { result, httpLogs, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/shows/123/seasons/2/episodes/2/people",
        body: JSON.stringify({
            cast: [
                {
                    person: {
                        name: "汤姆·汉克斯",
                    },
                    character: "Detective",
                    characters: ["Detective"],
                },
            ],
            crew: {},
        }),
        persistentData: createUnifiedPersistentData({
            traktLinkIds: {
                123: {
                    ids: {
                        trakt: 123,
                        tmdb: 456,
                        imdb: "tt456",
                    },
                    language: "zh",
                },
            },
            doubanSearch: {
                "tv:tt456": {
                    id: "35517044",
                    targetType: "tv",
                },
            },
        }),
        httpGetMocks: {
            [TRAKT_SEASON_2_EPISODE_1_URL]: createTraktEpisodeDetailResponse(),
            [DOUBAN_SEARCH_TTSEASON_TV_URL]: createDoubanSearchResponse("4707205", "tv"),
            [DOUBAN_MOVIE_CREDITS_4707205_URL]: createDoubanCreditsResponse("饰 第二季角色"),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.cast[0].character, "第二季角色");
    assert.equal(
        httpLogs.some((entry) => entry.url === TRAKT_SEASON_2_EPISODE_1_URL),
        true,
    );
    const cache = parseUnifiedCache(persistentData);
    assert.equal(cache.douban.search["tv:ttseason201"].id, "4707205");
    assert.equal(cache.trakt.linkIds["episode:first:123:2"].ids.imdb, "ttseason201");
});

test("googleTranslationEnabled=false 时 media people 列表不触发 Google 回退，但 TMDb 姓名翻译仍生效", async () => {
    const { result, persistentData, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/people",
        body: readFixture("media-people-list.json"),
        argument: {
            googleTranslationEnabled: false,
        },
        persistentData: createUnifiedPersistentData({
            traktLinkIds: JSON.parse(createWatchnowIdsCache()),
        }),
        httpGetMocks: {
            [TMDB_MOVIE_CREDITS_URL]: createTmdbMovieCreditsResponse(),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.cast[0].person.name, "汤姆·汉克斯");
    assert.equal(parseUnifiedCache(persistentData).google.people["42"].name.translatedText, "汤姆·汉克斯");
    assert.equal(parseUnifiedCache(persistentData).google.people["42"].name.source, "tmdb");
    assert.equal(
        httpLogs.some((entry) => entry.method === "POST" && entry.url === GOOGLE_TRANSLATE_URL),
        false,
    );
});

mediaPeopleTmdbFallbackCases.forEach(({ name, mock }) => {
    test(name, async () => {
        const { result, persistentData } = await runResponseCase({
            url: "https://api.trakt.tv/movies/123/people",
            body: readFixture("media-people-list.json"),
            persistentData: createUnifiedPersistentData({
                traktLinkIds: JSON.parse(createWatchnowIdsCache()),
            }),
            httpGetMocks: {
                [TMDB_MOVIE_CREDITS_URL]: mock,
            },
            httpPostMocks: {
                [GOOGLE_TRANSLATE_URL]: createGoogleTranslateResponse(["汤姆·汉克斯"]),
            },
        });

        const payload = JSON.parse(result.body);
        assert.equal(payload.cast[0].person.name, "汤姆·汉克斯");

        const cache = parseUnifiedCache(persistentData).google.people;
        assert.deepEqual(cache["42"].name, {
            sourceTextHash: computeStringHash("Tom Hanks"),
            translatedText: "汤姆·汉克斯",
            source: "google",
        });
    });
});

test("media people 列表先有 Google 缓存、后拿到 TMDb 名字时会被 TMDb 覆盖", async () => {
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/people",
        body: readFixture("media-people-list.json"),
        persistentData: createUnifiedPersistentData({
            traktLinkIds: JSON.parse(createWatchnowIdsCache()),
            googlePeople: {
                42: {
                    name: {
                        sourceTextHash: computeStringHash("Tom Hanks"),
                        translatedText: "谷歌译名",
                        source: "google",
                    },
                },
            },
        }),
        httpGetMocks: {
            [TMDB_MOVIE_CREDITS_URL]: createTmdbMovieCreditsResponse(),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.cast[0].person.name, "汤姆·汉克斯");
    assert.deepEqual(parseUnifiedCache(persistentData).google.people["42"].name, {
        sourceTextHash: computeStringHash("Tom Hanks"),
        translatedText: "汤姆·汉克斯",
        source: "tmdb",
    });
});

test("media people 列表已有 tmdb 缓存时，Google 返回不同姓名也不会覆盖", async () => {
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/people",
        body: JSON.stringify({
            cast: [
                {
                    person: {
                        name: "Thomas Hanks",
                        ids: {
                            trakt: 42,
                            tmdb: 31,
                        },
                    },
                    characters: ["Self"],
                },
            ],
            crew: {},
        }),
        argument: {
            googleTranslationEnabled: true,
        },
        persistentData: createUnifiedPersistentData({
            googlePeople: {
                42: {
                    name: {
                        sourceTextHash: computeStringHash("Tom Hanks"),
                        translatedText: "汤姆·汉克斯",
                        source: "tmdb",
                    },
                },
            },
        }),
        httpPostMocks: {
            [GOOGLE_TRANSLATE_URL]: createGoogleTranslateResponse(["谷歌姓名"]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.cast[0].person.name, "谷歌姓名");
    assert.deepEqual(parseUnifiedCache(persistentData).google.people["42"].name, {
        sourceTextHash: computeStringHash("Tom Hanks"),
        translatedText: "汤姆·汉克斯",
        source: "tmdb",
    });
});

test("media people 列表只更新姓名时会保留已有 biography 缓存", async () => {
    const { persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/people",
        body: readFixture("media-people-list.json"),
        persistentData: createUnifiedPersistentData({
            traktLinkIds: JSON.parse(createWatchnowIdsCache()),
            googlePeople: JSON.parse(
                createPeopleTranslationCache({
                    42: {
                        biography: {
                            sourceTextHash: computeStringHash("An American actor and filmmaker."),
                            translatedText: "一位美国演员和电影制作人。",
                        },
                    },
                }),
            ),
        }),
        httpGetMocks: {
            [TMDB_MOVIE_CREDITS_URL]: createTmdbMovieCreditsResponse(),
        },
    });

    const cache = parseUnifiedCache(persistentData).google.people;
    assert.equal(cache["42"].name.translatedText, "汤姆·汉克斯");
    assert.equal(cache["42"].name.source, "tmdb");
    assert.equal(cache["42"].biography.translatedText, "一位美国演员和电影制作人。");
});

test("media people 列表在 TMDb 和 Google 都失败时会保留原文且不写入缓存", async () => {
    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/movies/123/people",
        body: readFixture("media-people-list.json"),
        persistentData: createUnifiedPersistentData({
            traktLinkIds: JSON.parse(createWatchnowIdsCache()),
        }),
        httpGetMocks: {
            [TMDB_MOVIE_CREDITS_URL]: createHttpErrorMock("tmdb credits unavailable"),
        },
        httpPostMocks: {
            [GOOGLE_TRANSLATE_URL]: createHttpErrorMock("google translate unavailable"),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.cast[0].person.name, "Tom Hanks");
    assert.deepEqual(parseUnifiedCache(persistentData).google.people, {});
});

test("person media credits 列表会应用缓存中的中文翻译", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/people/42/movies",
        body: readFixture("people-credits.json"),
        headers: {
            "user-agent": "Rippple/1.0",
        },
        persistentData: createUnifiedPersistentData({
            traktTranslation: JSON.parse(createMovieTranslationCache()),
        }),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.cast[0].movie.title, "中文电影");
    assert.equal(payload.cast[0].movie.overview, "中文简介");
    assert.equal(payload.cast[0].movie.tagline, "中文标语");
});

test("person media credits 列表在普通 UA 下也会应用中文翻译", async () => {
    const { result } = await runResponseCase({
        url: "https://api.trakt.tv/people/42/movies",
        body: readFixture("people-credits.json"),
        headers: {
            "user-agent": "UnitTest/1.0",
        },
        persistentData: createUnifiedPersistentData({
            traktTranslation: JSON.parse(createMovieTranslationCache()),
        }),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.cast[0].movie.title, "中文电影");
    assert.equal(payload.cast[0].movie.overview, "中文简介");
    assert.equal(payload.cast[0].movie.tagline, "中文标语");
});

test("search person 列表会优先应用缓存中的中文姓名和 biography", async () => {
    const body = JSON.stringify([
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
    ]);

    const { result, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/search/person?extended=cloud9,full&limit=100&page=1&query=gong",
        body,
        persistentData: createUnifiedPersistentData({
            googlePeople: JSON.parse(createPeopleTranslationCache()),
        }),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].person.name, "汤姆·汉克斯");
    assert.equal(payload[0].person.biography, "一位美国演员和电影制作人。");
    assert.equal(
        httpLogs.some((entry) => entry.method === "POST" && entry.url === GOOGLE_TRANSLATE_URL),
        false,
    );
});

test("search person 列表会用 Google 翻译未命中的姓名和 biography 并写回缓存", async () => {
    const body = JSON.stringify([
        {
            type: "person",
            score: 1,
            person: {
                name: "Gong Li",
                biography: "Chinese-born Singaporean actress.",
                ids: {
                    trakt: 99,
                },
            },
        },
    ]);

    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/search/person?extended=cloud9,full&limit=100&page=1&query=gong",
        body,
        httpPostMocks: {
            [GOOGLE_TRANSLATE_URL]: [createGoogleTranslateResponse(["巩俐"]), createGoogleTranslateResponse(["华裔新加坡女演员。"])],
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].person.name, "巩俐");
    assert.equal(payload[0].person.biography, "华裔新加坡女演员。");

    const cache = parseUnifiedCache(persistentData).google.people;
    assert.deepEqual(cache["99"], {
        name: {
            sourceTextHash: computeStringHash("Gong Li"),
            translatedText: "巩俐",
            source: "google",
        },
        biography: {
            sourceTextHash: computeStringHash("Chinese-born Singaporean actress."),
            translatedText: "华裔新加坡女演员。",
        },
    });
});

test("search person 列表翻译 biography 时会用 TMDb 中文名缓存作为 Google 语境", async () => {
    const body = JSON.stringify([
        {
            type: "person",
            score: 1,
            person: {
                name: "Gong Li",
                biography: "Chinese-born Singaporean actress.",
                ids: {
                    trakt: 99,
                },
            },
        },
    ]);

    const { result, persistentData, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/search/person?extended=cloud9,full&limit=100&page=1&query=gong",
        body,
        persistentData: createUnifiedPersistentData({
            googlePeople: {
                99: {
                    name: {
                        sourceTextHash: computeStringHash("Gong Li"),
                        translatedText: "巩俐",
                        source: "tmdb",
                    },
                },
            },
        }),
        httpPostMocks: {
            [GOOGLE_TRANSLATE_URL]: createGoogleTranslateResponse(["Gong Li (巩俐)\n华裔新加坡女演员。"]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].person.name, "巩俐");
    assert.equal(payload[0].person.biography, "华裔新加坡女演员。");
    const googleRequestBody = httpLogs.find((entry) => entry.method === "POST" && entry.url === GOOGLE_TRANSLATE_URL)?.body ?? "";
    assert.deepEqual(extractDeepLxRequestTexts(googleRequestBody), ["§Gong Li (巩俐)§Chinese-born Singaporean actress."]);

    const cache = parseUnifiedCache(persistentData).google.people;
    assert.deepEqual(cache["99"], {
        name: {
            sourceTextHash: computeStringHash("Gong Li"),
            translatedText: "巩俐",
            source: "tmdb",
        },
        biography: {
            sourceTextHash: computeStringHash("Chinese-born Singaporean actress."),
            translatedText: "华裔新加坡女演员。",
        },
    });
});

test("people this_month 列表会翻译 direct person 项并优先使用本地缓存", async () => {
    const body = JSON.stringify([
        {
            name: "Tom Hanks",
            biography: "An American actor and filmmaker.",
            ids: {
                trakt: 42,
            },
        },
    ]);

    const { result, httpLogs } = await runResponseCase({
        url: "https://api.trakt.tv/people/this_month?extended=cloud9,full",
        body,
        persistentData: createUnifiedPersistentData({
            googlePeople: JSON.parse(createPeopleTranslationCache()),
        }),
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].name, "汤姆·汉克斯");
    assert.equal(payload[0].biography, "一位美国演员和电影制作人。");
    assert.equal(
        httpLogs.some((entry) => entry.method === "POST" && entry.url === GOOGLE_TRANSLATE_URL),
        false,
    );
});

test("people this_month 列表在 Google 失败时会保留原文且不写入脏缓存", async () => {
    const body = JSON.stringify([
        {
            name: "Gong Li",
            biography: "Chinese-born Singaporean actress.",
            ids: {
                trakt: 99,
            },
        },
    ]);

    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/people/this_month?extended=cloud9,full",
        body,
        httpPostMocks: {
            [GOOGLE_TRANSLATE_URL]: createHttpErrorMock("google translate unavailable"),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].name, "Gong Li");
    assert.equal(payload[0].biography, "Chinese-born Singaporean actress.");
    assert.deepEqual(parseUnifiedCache(persistentData).google.people, {});
});
