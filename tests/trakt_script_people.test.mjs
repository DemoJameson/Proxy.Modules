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
    parseUnifiedCache,
    readFixture,
    runResponseCase,
} from "./helpers/trakt-test-helpers.mjs";

const GOOGLE_TRANSLATE_URL = "https://translation.googleapis.com/language/translate/v2";
const TMDB_MOVIE_CREDITS_URL = "regex:^https://api\\.tmdb\\.org/3/movie/456\\?";
const TMDB_PERSON_URL = "regex:^https://api\\.tmdb\\.org/3/person/31\\?";

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

    const { result, persistentData } = await runResponseCase({
        url: "https://api.trakt.tv/people/42",
        body,
        httpPostMocks: {
            "https://translation.googleapis.com/language/translate/v2": createGoogleTranslateResponse(["汤姆·汉克斯", "一位美国演员和电影制作人。"]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.name, "汤姆·汉克斯\nTom Hanks");
    assert.equal(payload.biography, "一位美国演员和电影制作人。");

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
            [GOOGLE_TRANSLATE_URL]: createGoogleTranslateResponse(["汤姆·汉克斯：一位美国演员和电影制作人。"]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.name, "汤姆·汉克斯\nTom Hanks");
    assert.equal(payload.biography, "一位美国演员和电影制作人。");
    const googleRequestBody = httpLogs.find((entry) => entry.method === "POST" && entry.url === GOOGLE_TRANSLATE_URL)?.body ?? "";
    assert.deepEqual(new URLSearchParams(googleRequestBody).getAll("q"), ["汤姆·汉克斯：An American actor and filmmaker."]);

    const cache = parseUnifiedCache(persistentData).google.people;
    assert.equal(cache["42"].biography.sourceTextHash, computeStringHash("An American actor and filmmaker."));
    assert.equal(cache["42"].biography.translatedText, "一位美国演员和电影制作人。");
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
            [GOOGLE_TRANSLATE_URL]: createGoogleTranslateResponse(["汤姆·汉克斯：一位美国演员和电影制作人。"]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload.name, "汤姆·汉克斯\nTom Hanks");
    assert.equal(payload.biography, "一位美国演员和电影制作人。");

    const googleRequestBody = httpLogs.find((entry) => entry.method === "POST" && entry.url === GOOGLE_TRANSLATE_URL)?.body ?? "";
    assert.deepEqual(new URLSearchParams(googleRequestBody).getAll("q"), ["汤姆·汉克斯：An American actor and filmmaker."]);

    const cache = parseUnifiedCache(persistentData).google.people;
    assert.equal(cache["42"].name.translatedText, "汤姆·汉克斯");
    assert.equal(cache["42"].name.source, "tmdb");
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
            [GOOGLE_TRANSLATE_URL]: createGoogleTranslateResponse(["巩俐：华裔新加坡女演员。"]),
        },
    });

    const payload = JSON.parse(result.body);
    assert.equal(payload[0].person.name, "巩俐");
    assert.equal(payload[0].person.biography, "华裔新加坡女演员。");
    const googleRequestBody = httpLogs.find((entry) => entry.method === "POST" && entry.url === GOOGLE_TRANSLATE_URL)?.body ?? "";
    assert.deepEqual(new URLSearchParams(googleRequestBody).getAll("q"), ["巩俐：Chinese-born Singaporean actress."]);

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
