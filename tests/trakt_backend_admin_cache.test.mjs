import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const translationsHandler = require("../api/trakt/translations.js");
const imagesHandler = require("../api/trakt/images.js");
const adminHandler = require("../api/trakt/translations/admin.js");
const translationOverridesHandler = require("../api/trakt/translation-overrides.js");

import { createPipelineResponse, getJsonValue, jsonValue } from "./helpers/kv-rest-mock.mjs";

const AUTO_MOVIE_123 = "trakt:translation:movies:123";
const TRANSLATION_OVERRIDES_KEY = "trakt:translation:overrides";
const AUTO_MOVIE_456 = "trakt:translation:movies:456";
const AUTO_EPISODE_123_1_2 = "trakt:translation:episodes:123:1:2";
const CHINESE_IMAGE_MOVIE_123 = "trakt:image:chinese:movies:123";
const CHINESE_IMAGE_SHOW_555 = "trakt:image:chinese:shows:555";
const CHINESE_IMAGE_SEASON_555_1 = "trakt:image:chinese:seasons:555:1";
const ORIGINAL_IMAGE_MOVIE_123 = "trakt:image:original:movies:123";
const LEGACY_CHINESE_IMAGE_MOVIE_123 = "trakt:image:movies:123";
const LEGACY_ORIGINAL_IMAGE_MOVIE_123 = "original:movies:123";

function createResponse() {
    return {
        headers: {},
        statusCode: 200,
        jsonBody: null,
        setHeader(name, value) {
            this.headers[name] = value;
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.jsonBody = body;
            return this;
        },
    };
}

function createKvFetch(store) {
    return async (url, init = {}) => {
        const parsed = new URL(url);
        const path = parsed.pathname;

        if (parsed.hostname === "api.trakt.tv" && path.startsWith("/search/")) {
            const traktType = path.split("/").pop();
            store.traktSearchRequests = [
                ...(store.traktSearchRequests || []),
                {
                    type: traktType,
                    query: parsed.searchParams.get("query"),
                    limit: parsed.searchParams.get("limit"),
                    apiKey: init.headers?.["trakt-api-key"],
                    apiVersion: init.headers?.["trakt-api-version"],
                    userAgent: init.headers?.["user-agent"],
                },
            ];
            if (store.traktSearchStatus) {
                return {
                    ok: false,
                    status: store.traktSearchStatus,
                    text: async () => store.traktSearchBody || "",
                    json: async () => ({ error: store.traktSearchBody || "trakt error" }),
                };
            }
            const results = store.traktSearchResults?.[traktType] || [];
            return {
                ok: true,
                text: async () => JSON.stringify(results),
                json: async () => results,
            };
        }

        if (path === "/pipeline") {
            return createPipelineResponse(store, init);
        }

        if (path.startsWith("/scan/")) {
            const parts = path.split("/").map((part) => decodeURIComponent(part));
            const cursor = Number.parseInt(parts[2] || "0", 10) || 0;
            const matchIndex = parts.indexOf("match");
            const countIndex = parts.indexOf("count");
            const match = matchIndex >= 0 ? parts[matchIndex + 1] || "" : parsed.searchParams.get("match") || "";
            const count = countIndex >= 0 ? Number.parseInt(parts[countIndex + 1] || "10", 10) || 10 : 10;
            const prefix = match.endsWith("*") ? match.slice(0, -1) : match;
            const keys = Array.from(store.keys()).filter((key) => key.startsWith(prefix));
            const nextCursor = cursor + count >= keys.length ? "0" : String(cursor + count);
            return {
                ok: true,
                json: async () => ({ result: [nextCursor, keys.slice(cursor, cursor + count)] }),
            };
        }

        return {
            ok: false,
            status: 404,
            json: async () => ({ error: "not found" }),
        };
    };
}

function getOverrideEntry(store, mediaType, id) {
    return getJsonValue(store, TRANSLATION_OVERRIDES_KEY)?.[mediaType]?.[id] || null;
}

async function withBackend(store, callback, options = {}) {
    const previousFetch = globalThis.fetch;
    const previousKvUrl = process.env.KV_REST_API_URL;
    const previousKvToken = process.env.KV_REST_API_TOKEN;
    const previousAdminToken = process.env.ADMIN_TOKEN;
    const previousTraktApiKey = process.env.TRAKT_API_KEY;

    globalThis.fetch = createKvFetch(store);
    process.env.KV_REST_API_URL = "https://kv.example";
    process.env.KV_REST_API_TOKEN = "test-kv-token";
    if (options.adminToken === undefined) {
        process.env.ADMIN_TOKEN = "test-admin-token";
    } else if (options.adminToken === null) {
        delete process.env.ADMIN_TOKEN;
    } else {
        process.env.ADMIN_TOKEN = options.adminToken;
    }
    if (options.traktApiKey === undefined) {
        process.env.TRAKT_API_KEY = "test-trakt-api-key";
    } else if (options.traktApiKey === null) {
        delete process.env.TRAKT_API_KEY;
    } else {
        process.env.TRAKT_API_KEY = options.traktApiKey;
    }

    try {
        await callback();
    } finally {
        globalThis.fetch = previousFetch;
        restoreEnv("KV_REST_API_URL", previousKvUrl);
        restoreEnv("KV_REST_API_TOKEN", previousKvToken);
        restoreEnv("ADMIN_TOKEN", previousAdminToken);
        restoreEnv("TRAKT_API_KEY", previousTraktApiKey);
    }
}

function restoreEnv(name, value) {
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}

function seedAuto(store, key, translation, status = 1, options = {}) {
    const value = {
        status,
        translation,
    };
    if (Object.hasOwn(options, "expiresAt")) {
        value.expiresAt = options.expiresAt;
    }
    store.set(key, jsonValue(value));
}

function seedAutoEntry(store, key, entry) {
    store.set(key, jsonValue(entry));
}

function seedOverride(store, mediaType, id, translation) {
    const current = getJsonValue(store, TRANSLATION_OVERRIDES_KEY) || {
        shows: {},
        movies: {},
        episodes: {},
    };
    store.set(
        TRANSLATION_OVERRIDES_KEY,
        jsonValue({
            ...current,
            [mediaType]: {
                ...current[mediaType],
                [id]: {
                    translation,
                    updatedAt: 1710000000000,
                },
            },
        }),
    );
}

function seedOverrideEntry(store, mediaType, id, entry) {
    const current = getJsonValue(store, TRANSLATION_OVERRIDES_KEY) || {
        shows: {},
        movies: {},
        episodes: {},
    };
    store.set(
        TRANSLATION_OVERRIDES_KEY,
        jsonValue({
            ...current,
            [mediaType]: {
                ...current[mediaType],
                [id]: entry,
            },
        }),
    );
}

async function invoke(handler, req) {
    const res = createResponse();
    await handler(
        {
            method: "GET",
            query: {},
            headers: {},
            ...req,
        },
        res,
    );
    return res;
}

function adminHeaders(token = "test-admin-token") {
    return {
        authorization: `Bearer ${token}`,
    };
}

test("backend translations GET returns auto entries while translation-overrides endpoint returns override table", async () => {
    const store = new Map();
    seedAuto(store, AUTO_MOVIE_123, {
        title: "自动标题",
        overview: "自动简介",
        tagline: "自动标语",
    });
    seedOverride(store, "movies", "123", {
        title: "人工标题",
        tagline: "人工标语",
    });

    await withBackend(store, async () => {
        const res = await invoke(translationsHandler, {
            method: "GET",
            query: { movies: "123" },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, {
            shows: {},
            movies: {
                123: {
                    status: 1,
                    translation: {
                        title: "自动标题",
                        overview: "自动简介",
                        tagline: "自动标语",
                    },
                },
            },
            episodes: {},
        });
        assert.equal("autoEntry" in res.jsonBody.movies["123"], false);
        assert.equal("override" in res.jsonBody.movies["123"], false);
        assert.deepEqual(store.mgetCommands, [["JSON.MGET", AUTO_MOVIE_123, "$"]]);
        assert.equal(store.getCommands, undefined);

        const overrideRes = await invoke(translationOverridesHandler, {
            method: "GET",
        });
        assert.equal(overrideRes.statusCode, 200);
        assert.equal(overrideRes.headers["Cache-Control"], "public, max-age=60");
        assert.equal(overrideRes.headers["CDN-Cache-Control"], "public, s-maxage=300");
        assert.equal(overrideRes.headers["Vercel-CDN-Cache-Control"], "public, s-maxage=300");
        assert.deepEqual(overrideRes.jsonBody.movies["123"], {
            cn: {
                translation: {
                    title: "人工标题",
                    tagline: "人工标语",
                },
            },
            updatedAt: 1710000000000,
        });
    });
});

test("backend images GET 批量读取 movie/show/season 图片缓存", async () => {
    const store = new Map();
    store.set(
        CHINESE_IMAGE_MOVIE_123,
        jsonValue({
            poster: {
                status: 1,
                url: "https://image.tmdb.org/t/p/original/movie.jpg",
            },
            logo: {
                status: 1,
                url: "https://image.tmdb.org/t/p/original/movie-logo.png",
            },
        }),
    );
    store.set(
        CHINESE_IMAGE_SHOW_555,
        jsonValue({
            poster: {
                status: 3,
            },
        }),
    );
    store.set(
        CHINESE_IMAGE_SEASON_555_1,
        jsonValue({
            poster: {
                status: 1,
                url: "https://image.tmdb.org/t/p/original/season.jpg",
            },
        }),
    );

    await withBackend(store, async () => {
        const res = await invoke(imagesHandler, {
            query: {
                movies: "123",
                shows: "555",
                seasons: "555:1",
            },
        });

        assert.equal(res.statusCode, 200);
        assert.equal(res.jsonBody.movies["123"].poster.url, "https://image.tmdb.org/t/p/original/movie.jpg");
        assert.equal(res.jsonBody.movies["123"].logo.url, "https://image.tmdb.org/t/p/original/movie-logo.png");
        assert.equal(res.jsonBody.shows["555"].poster.status, 3);
        assert.ok(Number.isFinite(res.jsonBody.shows["555"].poster.expiresAt));
        assert.equal(res.jsonBody.seasons["555:1"].poster.url, "https://image.tmdb.org/t/p/original/season.jpg");
        assert.deepEqual(store.mgetCommands[0], ["JSON.MGET", CHINESE_IMAGE_SHOW_555, CHINESE_IMAGE_MOVIE_123, CHINESE_IMAGE_SEASON_555_1, "$"]);
    });
});

test("backend images GET 硬切后不读取旧图片缓存 key", async () => {
    const store = new Map();
    store.set(
        LEGACY_CHINESE_IMAGE_MOVIE_123,
        jsonValue({
            poster: {
                status: 1,
                url: "https://image.tmdb.org/t/p/original/legacy-chinese.jpg",
            },
        }),
    );
    store.set(
        LEGACY_ORIGINAL_IMAGE_MOVIE_123,
        jsonValue({
            poster: {
                status: 1,
                url: "https://image.tmdb.org/t/p/original/legacy-original.jpg",
            },
        }),
    );

    await withBackend(store, async () => {
        const chineseRes = await invoke(imagesHandler, {
            query: {
                movies: "123",
                mode: "chinese",
            },
        });
        const originalRes = await invoke(imagesHandler, {
            query: {
                movies: "123",
                mode: "original",
            },
        });

        assert.equal(chineseRes.statusCode, 200);
        assert.deepEqual(chineseRes.jsonBody.movies, {});
        assert.equal(originalRes.statusCode, 200);
        assert.deepEqual(originalRes.jsonBody.movies, {});
        assert.deepEqual(store.mgetCommands, [
            ["JSON.MGET", CHINESE_IMAGE_MOVIE_123, "$"],
            ["JSON.MGET", ORIGINAL_IMAGE_MOVIE_123, "$"],
        ]);
    });
});

test("backend images GET 过滤已过期的 poster/logo 字段", async () => {
    const store = new Map();
    store.set(
        CHINESE_IMAGE_MOVIE_123,
        jsonValue({
            cn: {
                poster: { status: 3, expiresAt: Date.now() - 1000 },
                logo: { status: 1, url: "https://image.tmdb.org/t/p/original/movie-logo.png", expiresAt: null },
            },
        }),
    );

    await withBackend(store, async () => {
        const res = await invoke(imagesHandler, {
            query: {
                movies: "123",
                mode: "chinese",
            },
        });

        assert.equal(res.statusCode, 200);
        assert.equal(res.jsonBody.movies["123"].poster, undefined);
        assert.equal(res.jsonBody.movies["123"].logo.url, "https://image.tmdb.org/t/p/original/movie-logo.png");
    });
});

test("backend images POST 写入 FOUND/NOT_FOUND 并在数据里记录 3 天过期时间", async () => {
    const store = new Map();

    await withBackend(store, async () => {
        const res = await invoke(imagesHandler, {
            method: "POST",
            body: {
                modes: {
                    chinese: {
                        movies: {
                            123: {
                                poster: {
                                    status: 1,
                                    url: "https://image.tmdb.org/t/p/original/movie.jpg",
                                },
                                logo: {
                                    status: 3,
                                },
                            },
                        },
                        seasons: {
                            "555:1": {
                                poster: {
                                    status: 3,
                                },
                            },
                        },
                    },
                    original: {
                        movies: {
                            123: {
                                poster: {
                                    status: 1,
                                    url: "https://image.tmdb.org/t/p/original/original-movie.jpg",
                                },
                            },
                        },
                    },
                },
            },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody.counts, {
            shows: 0,
            movies: 2,
            seasons: 1,
        });
        assert.equal(store.pipelineRequests.length, 1);
        assert.equal(store.evalCommands.length, 1);
        assert.equal(store.mgetCommands.length, 1);
        assert.equal(store.msetCommands.length, 1);
        assert.equal(store.setCommands, undefined);
        assert.equal(getJsonValue(store, CHINESE_IMAGE_MOVIE_123).cn.poster.url, "https://image.tmdb.org/t/p/original/movie.jpg");
        assert.equal(getJsonValue(store, CHINESE_IMAGE_MOVIE_123).cn.logo.status, 3);
        assert.ok(Number.isFinite(getJsonValue(store, CHINESE_IMAGE_MOVIE_123).cn.logo.expiresAt));
        assert.equal(getJsonValue(store, CHINESE_IMAGE_SEASON_555_1).cn.poster.status, 3);
        assert.ok(Number.isFinite(getJsonValue(store, CHINESE_IMAGE_SEASON_555_1).cn.poster.expiresAt));
        assert.equal(getJsonValue(store, ORIGINAL_IMAGE_MOVIE_123).cn.poster.url, "https://image.tmdb.org/t/p/original/original-movie.jpg");
        // 不再发送 EXPIRE，过期时间写在 poster/logo 字段内
        assert.equal(store.expireCommands, undefined);
    });
});

test("backend images POST 为 PARTIAL_FOUND 记录 30 天过期时间，NOT_FOUND 优先", async () => {
    const store = new Map();

    await withBackend(store, async () => {
        const res = await invoke(imagesHandler, {
            method: "POST",
            body: {
                modes: {
                    chinese: {
                        movies: {
                            123: {
                                poster: {
                                    status: 1,
                                    url: "https://image.tmdb.org/t/p/original/movie.jpg",
                                },
                                logo: {
                                    status: 2,
                                    url: "https://image.tmdb.org/t/p/original/logo.png",
                                },
                            },
                        },
                        seasons: {
                            "555:1": {
                                poster: {
                                    status: 2,
                                    url: "https://image.tmdb.org/t/p/original/season.jpg",
                                },
                            },
                        },
                        shows: {
                            555: {
                                poster: {
                                    status: 2,
                                    url: "https://image.tmdb.org/t/p/original/show.jpg",
                                },
                                logo: {
                                    status: 3,
                                },
                            },
                        },
                    },
                },
            },
        });

        assert.equal(res.statusCode, 200);
        assert.equal(getJsonValue(store, CHINESE_IMAGE_MOVIE_123).cn.logo.status, 2);
        assert.ok(Number.isFinite(getJsonValue(store, CHINESE_IMAGE_MOVIE_123).cn.logo.expiresAt));
        assert.equal(store.expireCommands, undefined);
    });
});

test("backend images POST 在全部字段 FOUND 时 expiresAt 为 null", async () => {
    const store = new Map();

    await withBackend(store, async () => {
        const res = await invoke(imagesHandler, {
            method: "POST",
            body: {
                modes: {
                    chinese: {
                        movies: {
                            123: {
                                poster: {
                                    status: 1,
                                    url: "https://image.tmdb.org/t/p/original/movie.jpg",
                                },
                                logo: {
                                    status: 1,
                                    url: "https://image.tmdb.org/t/p/original/logo.png",
                                },
                            },
                        },
                    },
                },
            },
        });

        assert.equal(res.statusCode, 200);
        assert.equal(store.persistCommands, undefined);
        assert.equal(
            (store.expireCommands || []).some((command) => command[1] === CHINESE_IMAGE_MOVIE_123),
            false,
        );
    });
});

test("backend translations GET reads many entries with JSON.MGET", async () => {
    const store = new Map();
    seedAuto(store, "trakt:translation:shows:123", {
        title: "批量剧集标题",
        overview: null,
        tagline: null,
    });
    seedAuto(store, AUTO_MOVIE_123, {
        title: "批量电影标题",
        overview: null,
        tagline: null,
    });
    seedAuto(store, AUTO_EPISODE_123_1_2, {
        title: "批量剧集单集标题",
        overview: null,
        tagline: null,
    });

    await withBackend(store, async () => {
        const res = await invoke(translationsHandler, {
            method: "GET",
            query: {
                shows: "123,404",
                movies: "123,456",
                episodes: "123:1:2,999:1:1",
            },
        });

        assert.equal(res.statusCode, 200);
        assert.equal(res.jsonBody.shows["123"].translation.title, "批量剧集标题");
        assert.equal(res.jsonBody.movies["123"].translation.title, "批量电影标题");
        assert.equal(res.jsonBody.episodes["123:1:2"].translation.title, "批量剧集单集标题");
        assert.equal(res.jsonBody.movies["456"], undefined);
        assert.equal(store.mgetCommands.length, 1);
        assert.deepEqual(store.mgetCommands[0], [
            "JSON.MGET",
            "trakt:translation:shows:123",
            "trakt:translation:shows:404",
            "trakt:translation:movies:123",
            "trakt:translation:movies:456",
            "trakt:translation:episodes:123:1:2",
            "trakt:translation:episodes:999:1:1",
            "$",
        ]);
        assert.equal(store.getCommands, undefined);
    });
});

test("backend translations GET reads Upstash pipeline array response", async () => {
    const store = new Map();
    seedAuto(store, AUTO_MOVIE_123, {
        title: "Upstash 标题",
        overview: "Upstash 简介",
        tagline: null,
    });

    await withBackend(store, async () => {
        const res = await invoke(translationsHandler, {
            method: "GET",
            query: { movies: "123" },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody.movies, {
            123: {
                status: 1,
                translation: {
                    title: "Upstash 标题",
                    overview: "Upstash 简介",
                    tagline: null,
                },
            },
        });
    });
});

test("backend translations 往返保留 complete 标记", async () => {
    const store = new Map();

    await withBackend(store, async () => {
        const postRes = await invoke(translationsHandler, {
            method: "POST",
            body: {
                movies: {
                    123: {
                        status: 1,
                        translation: {
                            title: "完整标题",
                            overview: "完整简介",
                            tagline: null,
                        },
                        complete: true,
                    },
                },
            },
        });

        assert.equal(postRes.statusCode, 200);
        assert.equal(getJsonValue(store, AUTO_MOVIE_123).cn.complete, true);

        const getRes = await invoke(translationsHandler, {
            method: "GET",
            query: { movies: "123" },
        });

        assert.equal(getRes.statusCode, 200);
        assert.equal(getRes.jsonBody.movies["123"].complete, true);
    });
});

test("backend POST keeps writing auto cache while override stays separate", async () => {
    const store = new Map();
    seedAuto(store, AUTO_MOVIE_123, {
        title: "旧自动标题",
        overview: "旧自动简介",
        tagline: null,
    });
    seedOverride(store, "movies", "123", {
        title: "锁定标题",
    });

    await withBackend(store, async () => {
        const postRes = await invoke(translationsHandler, {
            method: "POST",
            body: {
                movies: {
                    123: {
                        status: 1,
                        translation: {
                            title: "新自动标题",
                            overview: "新自动简介",
                            tagline: "新自动标语",
                        },
                    },
                },
            },
        });

        assert.equal(postRes.statusCode, 200);
        assert.deepEqual(postRes.jsonBody.counts, {
            shows: 0,
            movies: 1,
            episodes: 0,
        });
        assert.equal(getJsonValue(store, AUTO_MOVIE_123).cn.translation.title, "新自动标题");
        assert.equal(store.pipelineRequests.length, 1);
        assert.equal(store.evalCommands.length, 1);
        assert.equal(store.mgetCommands.length, 1);
        assert.equal(store.msetCommands.length, 1);
        // 真实 KV 要求 JSON 值序列化成字符串、清空根字段用字符串 "null"
        assert.deepEqual(store.msetCommands, [
            [
                "JSON.MSET",
                AUTO_MOVIE_123,
                "$.cn",
                JSON.stringify({
                    status: 1,
                    translation: {
                        title: "新自动标题",
                        overview: "新自动简介",
                        tagline: "新自动标语",
                    },
                    expiresAt: null,
                }),
                AUTO_MOVIE_123,
                "$.status",
                "null",
                AUTO_MOVIE_123,
                "$.translation",
                "null",
                AUTO_MOVIE_123,
                "$.complete",
                "null",
                AUTO_MOVIE_123,
                "$.expiresAt",
                "null",
            ],
        ]);
        assert.equal(store.setCommands, undefined);
        assert.equal(store.persistCommands, undefined);

        const getRes = await invoke(translationsHandler, {
            method: "GET",
            query: { movies: "123" },
        });

        assert.equal(getRes.jsonBody.movies["123"].translation.title, "新自动标题");
        assert.equal(getRes.jsonBody.movies["123"].translation.overview, "新自动简介");
        assert.equal(getRes.jsonBody.movies["123"].translation.tagline, "新自动标语");

        const overrideRes = await invoke(translationOverridesHandler, {
            method: "GET",
        });
        assert.equal(overrideRes.jsonBody.movies["123"].cn.translation.title, "锁定标题");
    });
});

test("backend POST writes grouped auto entries with JSON.MSET and stores expiresAt in data", async () => {
    const store = new Map();

    await withBackend(store, async () => {
        const postRes = await invoke(translationsHandler, {
            method: "POST",
            body: {
                shows: {
                    101: {
                        status: 1,
                        translation: {
                            title: "完整剧集标题",
                            overview: null,
                            tagline: null,
                        },
                    },
                },
                movies: {
                    201: {
                        status: 2,
                        translation: {
                            title: "部分电影标题",
                            overview: null,
                            tagline: null,
                        },
                    },
                    202: {
                        status: 1,
                        translation: {
                            title: "完整电影标题",
                            overview: null,
                            tagline: null,
                        },
                    },
                },
                episodes: {
                    "301:1:1": {
                        status: 3,
                        translation: null,
                    },
                },
            },
        });

        assert.equal(postRes.statusCode, 200);
        assert.deepEqual(postRes.jsonBody.counts, {
            shows: 1,
            movies: 2,
            episodes: 1,
        });
        assert.equal(store.pipelineRequests.length, 1);
        assert.equal(store.evalCommands.length, 1);
        assert.equal(store.mgetCommands.length, 1);
        assert.equal(store.msetCommands.length, 1);
        assert.deepEqual(
            store.msetCommands.map((command) => command[0]),
            ["JSON.MSET"],
        );
        assert.equal(store.persistCommands, undefined);
        // 不再发送 EXPIRE：过期时间只写在数据字段里
        assert.equal(store.expireCommands, undefined);
        assert.equal(store.pttlCommands, undefined);
        // 新 key 直接写 $ 根文档，不再逐 key 发送 JSON.SET NX
        assert.equal(store.setCommands, undefined);
        const rootPaths = [];
        for (let index = 1; index < store.msetCommands[0].length; index += 3) {
            rootPaths.push(store.msetCommands[0][index + 1]);
        }
        assert.deepEqual(rootPaths, ["$", "$", "$", "$"]);
        assert.equal(getJsonValue(store, "trakt:translation:shows:101").cn.expiresAt, null);
        assert.equal(getJsonValue(store, "trakt:translation:movies:202").cn.translation.title, "完整电影标题");
        assert.equal(getJsonValue(store, "trakt:translation:movies:202").cn.expiresAt, null);
        assert.equal(getJsonValue(store, "trakt:translation:episodes:301:1:1").cn.status, 3);
        assert.ok(Number.isFinite(getJsonValue(store, "trakt:translation:movies:201").cn.expiresAt));
        assert.ok(Number.isFinite(getJsonValue(store, "trakt:translation:episodes:301:1:1").cn.expiresAt));
    });
});

test("backend POST batches existing and new keys into one JSON.MSET", async () => {
    const store = new Map();
    seedAuto(store, AUTO_MOVIE_123, {
        title: "旧标题",
        overview: null,
        tagline: null,
    });

    await withBackend(store, async () => {
        const res = await invoke(translationsHandler, {
            method: "POST",
            body: {
                movies: {
                    123: {
                        status: 1,
                        translation: {
                            title: "更新标题",
                            overview: null,
                            tagline: null,
                        },
                    },
                    456: {
                        status: 1,
                        translation: {
                            title: "新增标题",
                            overview: null,
                            tagline: null,
                        },
                    },
                },
            },
        });

        assert.equal(res.statusCode, 200);
        assert.equal(store.pipelineRequests.length, 1);
        assert.equal(store.evalCommands.length, 1);
        assert.equal(store.mgetCommands.length, 1);
        assert.equal(store.msetCommands.length, 1);
        assert.equal(store.setCommands, undefined);

        const writes = [];
        const command = store.msetCommands[0];
        for (let index = 1; index < command.length; index += 3) {
            writes.push({ key: command[index], path: command[index + 1] });
        }
        assert.ok(writes.some((write) => write.key === AUTO_MOVIE_123 && write.path === "$.cn"));
        assert.ok(writes.some((write) => write.key === AUTO_MOVIE_456 && write.path === "$"));
        assert.equal(getJsonValue(store, AUTO_MOVIE_123).cn.translation.title, "更新标题");
        assert.equal(getJsonValue(store, AUTO_MOVIE_456).cn.translation.title, "新增标题");
    });
});

test("backend POST EVAL 只发送字符串/数字参数且新 key 写根文档", async () => {
    const store = new Map();

    await withBackend(store, async () => {
        const res = await invoke(translationsHandler, {
            method: "POST",
            body: {
                movies: {
                    123: {
                        status: 1,
                        translation: {
                            title: "参数形态标题",
                        },
                    },
                },
            },
        });

        assert.equal(res.statusCode, 200);
        // 真实 Upstash/Vercel KV 不接受对象或原始 null 参数：任一参数非法整条请求 400
        store.pipelineRequests.flat().forEach((command) => {
            command.slice(1).forEach((arg) => {
                assert.ok(typeof arg === "string" || typeof arg === "number", `命令参数必须是字符串或数字：${JSON.stringify(arg)}`);
            });
        });
        assert.equal(store.pipelineRequests.length, 1);
        assert.equal(store.evalCommands.length, 1);
        assert.equal(store.mgetCommands.length, 1);
        assert.equal(store.setCommands, undefined);
        assert.equal(store.msetCommands.length, 1);
        assert.equal(store.msetCommands[0][1], AUTO_MOVIE_123);
        assert.equal(store.msetCommands[0][2], "$");
        assert.equal(JSON.parse(store.msetCommands[0][3]).cn.translation.title, "参数形态标题");
        assert.equal(getJsonValue(store, AUTO_MOVIE_123).cn.translation.title, "参数形态标题");
    });
});

test("admin item, PUT, and clear fallback use the same effective merge rules", async () => {
    const store = new Map();
    seedAuto(
        store,
        AUTO_MOVIE_123,
        {
            title: "自动标题",
            overview: "自动简介",
            tagline: "自动标语",
        },
        1,
        { expiresAt: Date.now() + 86400000 },
    );

    await withBackend(store, async () => {
        const putRes = await invoke(adminHandler, {
            method: "PUT",
            headers: adminHeaders(),
            body: {
                type: "movies",
                id: "123",
                translation: {
                    title: "人工标题",
                    overview: "人工简介",
                    tagline: null,
                },
            },
        });

        assert.equal(putRes.statusCode, 200);
        assert.ok(Number.isFinite(putRes.jsonBody.autoEntry.expiresAt));
        assert.equal(putRes.jsonBody.effectiveEntry.translation.title, "人工标题");
        assert.equal(putRes.jsonBody.effectiveEntry.translation.overview, "人工简介");
        assert.equal(putRes.jsonBody.effectiveEntry.translation.tagline, "自动标语");
        assert.equal("source" in putRes.jsonBody.override, false);
        // 接口返回的是当前地区的投影 {translation}，存储形态（cn/tw/hk）由 getOverrideEntry 断言
        assert.deepEqual(putRes.jsonBody.override.translation, {
            title: "人工标题",
            overview: "人工简介",
        });
        assert.equal(store.pttlCommands, undefined);
        assert.equal(getJsonValue(store, AUTO_MOVIE_123).expiresAt, putRes.jsonBody.autoEntry.expiresAt);
        assert.ok(store.setCommands.some(([command, key]) => command === "JSON.SET" && key === TRANSLATION_OVERRIDES_KEY));
        assert.equal("source" in getOverrideEntry(store, "movies", "123"), false);
        assert.deepEqual(getOverrideEntry(store, "movies", "123").cn.translation, {
            title: "人工标题",
            overview: "人工简介",
        });
        // 写入后只保留 cn/tw/hk 字段，不再有旧的根字段 translation
        assert.equal("translation" in getOverrideEntry(store, "movies", "123"), false);

        const itemRes = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: {
                action: "item",
                type: "movies",
                id: "123",
            },
        });

        assert.equal(itemRes.statusCode, 200);
        assert.equal(itemRes.jsonBody.autoEntry.translation.title, "自动标题");
        assert.ok(Number.isFinite(itemRes.jsonBody.autoEntry.expiresAt));
        assert.equal(itemRes.jsonBody.override.translation.title, "人工标题");
        assert.equal(itemRes.jsonBody.override.translation.overview, "人工简介");
        assert.equal(itemRes.jsonBody.effectiveEntry.translation.title, "人工标题");
        assert.equal(store.pttlCommands, undefined);

        const clearPutRes = await invoke(adminHandler, {
            method: "PUT",
            headers: adminHeaders(),
            body: {
                type: "movies",
                id: "123",
                translation: {},
            },
        });

        assert.equal(clearPutRes.statusCode, 200);
        assert.equal(getOverrideEntry(store, "movies", "123"), null);
        assert.equal(clearPutRes.jsonBody.override, null);
        assert.equal(clearPutRes.jsonBody.effectiveEntry.translation.title, "自动标题");

        const unlockedRes = await invoke(translationsHandler, {
            method: "GET",
            query: { movies: "123" },
        });

        assert.equal(unlockedRes.jsonBody.movies["123"].translation.title, "自动标题");
    });
});

test("admin PUT/DELETE 按地区写入不会互相覆盖或留下根字段", async () => {
    const store = new Map();
    seedAuto(store, AUTO_MOVIE_123, {
        title: "自动标题",
    });

    await withBackend(store, async () => {
        const putCn = await invoke(adminHandler, {
            method: "PUT",
            headers: adminHeaders(),
            body: {
                type: "movies",
                id: "123",
                locale: "cn",
                translation: { title: "简体标题" },
            },
        });
        assert.equal(putCn.statusCode, 200);
        assert.deepEqual(getOverrideEntry(store, "movies", "123").cn.translation, { title: "简体标题" });
        assert.equal("translation" in getOverrideEntry(store, "movies", "123"), false, "cn 写入不应留下根字段");

        // 已有 cn 覆盖时写 tw：cn 必须保留，且不产生根字段
        const putTw = await invoke(adminHandler, {
            method: "PUT",
            headers: adminHeaders(),
            body: {
                type: "movies",
                id: "123",
                locale: "tw",
                translation: { title: "台灣標題" },
            },
        });
        assert.equal(putTw.statusCode, 200);
        const afterPutTw = getOverrideEntry(store, "movies", "123");
        assert.deepEqual(afterPutTw.cn.translation, { title: "简体标题" }, "写 tw 不应改动 cn");
        assert.deepEqual(afterPutTw.tw.translation, { title: "台灣標題" });
        assert.equal("translation" in afterPutTw, false, "写 tw 不应留下根字段");

        // 删除 tw：cn 必须保留
        const deleteTw = await invoke(adminHandler, {
            method: "DELETE",
            headers: adminHeaders(),
            query: {
                type: "movies",
                id: "123",
                target: "override",
                locale: "tw",
            },
        });
        assert.equal(deleteTw.statusCode, 200);
        const afterDeleteTw = getOverrideEntry(store, "movies", "123");
        assert.deepEqual(afterDeleteTw.cn.translation, { title: "简体标题" }, "删除 tw 不应影响 cn");
        assert.equal(afterDeleteTw.tw, undefined);

        // 再写 hk，然后删除 cn：hk 必须保留，cn 与根字段都不得残留
        await invoke(adminHandler, {
            method: "PUT",
            headers: adminHeaders(),
            body: {
                type: "movies",
                id: "123",
                locale: "hk",
                translation: { title: "香港標題" },
            },
        });
        const deleteCn = await invoke(adminHandler, {
            method: "DELETE",
            headers: adminHeaders(),
            query: {
                type: "movies",
                id: "123",
                target: "override",
                locale: "cn",
            },
        });
        assert.equal(deleteCn.statusCode, 200);
        const afterDeleteCn = getOverrideEntry(store, "movies", "123");
        assert.equal(afterDeleteCn.cn, undefined, "删除 cn 后不应保留 cn");
        assert.equal("translation" in afterDeleteCn, false, "删除 cn 后不应留下根字段");
        assert.deepEqual(afterDeleteCn.hk.translation, { title: "香港標題" }, "删除 cn 不应影响 hk");
    });
});

test("admin item skips PTTL when auto entry already has expiresAt", async () => {
    const store = new Map();
    seedAuto(
        store,
        AUTO_MOVIE_123,
        {
            title: "新格式标题",
            overview: null,
            tagline: null,
        },
        1,
        { expiresAt: null },
    );

    await withBackend(store, async () => {
        const itemRes = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: {
                action: "item",
                type: "movies",
                id: "123",
            },
        });

        assert.equal(itemRes.statusCode, 200);
        assert.equal(itemRes.jsonBody.autoEntry.translation.title, "新格式标题");
        assert.equal(itemRes.jsonBody.autoEntry.expiresAt, null);
        assert.equal(store.pttlCommands, undefined);
    });
});

test("backend translations GET omits override when no override exists", async () => {
    const store = new Map();
    seedAuto(store, AUTO_MOVIE_123, {
        title: "只有自动标题",
        overview: null,
        tagline: null,
    });

    await withBackend(store, async () => {
        const res = await invoke(translationsHandler, {
            method: "GET",
            query: { movies: "123" },
        });

        assert.equal(res.statusCode, 200);
        assert.equal("override" in res.jsonBody.movies["123"], false);
    });
});

test("admin list searches numeric ids directly and titles through Trakt ids", async () => {
    const store = new Map();
    store.traktSearchResults = {
        movie: [
            { type: "movie", movie: { ids: { trakt: 123 } } },
            { type: "movie", movie: { ids: { trakt: 999 } } },
        ],
    };
    seedAuto(store, AUTO_MOVIE_123, {
        title: "自动宇宙标题",
        overview: "简介",
        tagline: null,
    });
    seedOverride(store, "movies", "123", {
        title: "人工银河标题",
    });
    seedAuto(store, AUTO_MOVIE_456, {
        title: "另一部电影",
        overview: null,
        tagline: null,
    });
    seedAuto(store, "trakt:translation:movies:789", {
        title: "编号 456 彩蛋",
        overview: null,
        tagline: null,
    });

    await withBackend(store, async () => {
        const idRes = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: {
                action: "list",
                type: "movies",
                q: "456",
            },
        });
        assert.equal(idRes.statusCode, 200);
        assert.deepEqual(
            idRes.jsonBody.items.map((item) => item.id),
            ["456"],
        );

        const titleRes = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: {
                action: "list",
                type: "movies",
                q: "银河",
            },
        });
        assert.equal(titleRes.statusCode, 200);
        assert.deepEqual(
            titleRes.jsonBody.items.map((item) => item.id),
            ["123"],
        );
        assert.equal(titleRes.jsonBody.items[0].effectiveEntry.translation.title, "人工银河标题");
        assert.equal(titleRes.jsonBody.cursor, "0");
        assert.deepEqual(store.traktSearchRequests[0], {
            type: "movie",
            query: "银河",
            limit: "3",
            apiKey: "test-trakt-api-key",
            apiVersion: "2",
            userAgent: "Proxy.Modules Admin Translation Search/1.0",
        });
        assert.equal(store.searchCommands, undefined);
        assert.ok(store.getCommands.some(([command, key]) => command === "JSON.GET" && key === TRANSLATION_OVERRIDES_KEY));
        assert.equal(store.pttlCommands, undefined);

        store.traktSearchResults = { movie: [] };
        const keyRes = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: {
                action: "list",
                type: "movies",
                q: "translation:movies:456",
            },
        });
        assert.deepEqual(
            keyRes.jsonBody.items.map((item) => item.id),
            [],
        );

        const titleContainingIdRes = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: {
                action: "list",
                type: "movies",
                q: "789",
            },
        });
        assert.deepEqual(
            titleContainingIdRes.jsonBody.items.map((item) => item.id),
            ["789"],
        );
    });
});

test("admin list searches exact numeric ids across all media types", async () => {
    const store = new Map();
    seedAuto(store, AUTO_MOVIE_123, {
        title: "共同 ID 电影",
        overview: null,
        tagline: null,
    });
    seedAuto(store, "trakt:translation:shows:123", {
        title: "共同 ID 剧集",
        overview: null,
        tagline: null,
    });
    seedAuto(store, AUTO_EPISODE_123_1_2, {
        title: "共同 ID 单集",
        overview: null,
        tagline: null,
    });

    await withBackend(store, async () => {
        const res = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: {
                action: "list",
                type: "all",
                q: "123",
            },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(
            res.jsonBody.items.map((item) => `${item.type}:${item.id}`),
            ["shows:123", "movies:123"],
        );
    });
});

test("admin list searches episode ids directly", async () => {
    const store = new Map();
    seedAuto(store, "trakt:translation:episodes:99999003:1:1", {
        title: "后端测试单集标题",
        overview: null,
        tagline: null,
    });

    await withBackend(store, async () => {
        const episodeRes = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: {
                action: "list",
                type: "episodes",
                q: "99999003:1:1",
            },
        });

        assert.equal(episodeRes.statusCode, 200);
        assert.deepEqual(
            episodeRes.jsonBody.items.map((item) => `${item.type}:${item.id}`),
            ["episodes:99999003:1:1"],
        );

        const allRes = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: {
                action: "list",
                type: "all",
                q: "99999003:1:1",
            },
        });

        assert.deepEqual(
            allRes.jsonBody.items.map((item) => `${item.type}:${item.id}`),
            ["episodes:99999003:1:1"],
        );
    });
});

test("admin title search resolves Trakt ids and reads matching Redis entries", async () => {
    const store = new Map();
    store.traktSearchResults = {
        "movie,show": [
            { type: "movie", movie: { ids: { trakt: 123 } } },
            { type: "show", show: { ids: { trakt: 123 } } },
            { type: "movie", movie: { ids: { trakt: 456 } } },
            { type: "movie", movie: { ids: { trakt: 789 } } },
        ],
    };
    seedAuto(store, AUTO_MOVIE_123, {
        title: "标题搜索电影",
        overview: null,
        tagline: null,
    });
    seedAuto(store, "trakt:translation:movies:789", {
        title: "第三个标题搜索电影",
        overview: null,
        tagline: null,
    });
    seedAuto(store, "trakt:translation:shows:123", {
        title: "标题搜索剧集",
        overview: null,
        tagline: null,
    });

    await withBackend(store, async () => {
        const allRes = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: {
                action: "list",
                type: "all",
                q: "银河",
            },
        });

        assert.equal(allRes.statusCode, 200);
        assert.deepEqual(
            allRes.jsonBody.items.map((item) => `${item.type}:${item.id}`),
            ["movies:123", "shows:123"],
        );
        assert.deepEqual(
            store.traktSearchRequests.map((request) => ({
                type: request.type,
                query: request.query,
                limit: request.limit,
                apiKey: request.apiKey,
                apiVersion: request.apiVersion,
                userAgent: request.userAgent,
            })),
            [
                {
                    type: "movie,show",
                    query: "银河",
                    limit: "3",
                    apiKey: "test-trakt-api-key",
                    apiVersion: "2",
                    userAgent: "Proxy.Modules Admin Translation Search/1.0",
                },
            ],
        );
        assert.equal(store.searchCommands, undefined);
    });
});

test("admin title search follows media type mapping", async () => {
    const store = new Map();
    store.traktSearchResults = {
        movie: [{ type: "movie", movie: { ids: { trakt: 123 } } }],
        show: [{ type: "show", show: { ids: { trakt: 123 } } }],
    };
    seedAuto(store, AUTO_MOVIE_123, {
        title: "电影标题",
        overview: null,
        tagline: null,
    });
    seedAuto(store, "trakt:translation:shows:123", {
        title: "剧集标题",
        overview: null,
        tagline: null,
    });

    await withBackend(store, async () => {
        const showRes = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: {
                action: "list",
                type: "shows",
                q: "银河",
            },
        });
        assert.equal(showRes.statusCode, 200);
        assert.deepEqual(
            showRes.jsonBody.items.map((item) => `${item.type}:${item.id}`),
            ["shows:123"],
        );
        assert.deepEqual(
            store.traktSearchRequests.map((request) => request.type),
            ["show"],
        );

        const episodeRes = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: {
                action: "list",
                type: "episodes",
                q: "银河",
            },
        });
        assert.equal(episodeRes.statusCode, 200);
        assert.deepEqual(episodeRes.jsonBody.items, []);
        assert.deepEqual(
            store.traktSearchRequests.map((request) => request.type),
            ["show"],
        );
    });
});

test("admin title search requires TRAKT_API_KEY while numeric ids do not", async () => {
    const store = new Map();
    seedAuto(store, AUTO_MOVIE_123, {
        title: "缺少 Key 电影",
        overview: null,
        tagline: null,
    });

    await withBackend(
        store,
        async () => {
            const numericRes = await invoke(adminHandler, {
                method: "GET",
                headers: adminHeaders(),
                query: {
                    action: "list",
                    type: "movies",
                    q: "123",
                },
            });
            assert.equal(numericRes.statusCode, 200);
            assert.deepEqual(
                numericRes.jsonBody.items.map((item) => item.id),
                ["123"],
            );

            const titleRes = await invoke(adminHandler, {
                method: "GET",
                headers: adminHeaders(),
                query: {
                    action: "list",
                    type: "movies",
                    q: "缺少 Key",
                },
            });
            assert.equal(titleRes.statusCode, 500);
            assert.equal(titleRes.jsonBody.error, "TRAKT_API_KEY is not configured for title search.");
            assert.equal(store.traktSearchRequests, undefined);
        },
        { traktApiKey: null },
    );
});

test("admin title search explains Trakt auth failures", async () => {
    const store = new Map();
    store.traktSearchStatus = 403;
    store.traktSearchBody = "Forbidden";

    await withBackend(store, async () => {
        const res = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: {
                action: "list",
                type: "movies",
                q: "银河",
            },
        });

        assert.equal(res.statusCode, 500);
        assert.equal(res.jsonBody.error, "Trakt search HTTP 403. Check TRAKT_API_KEY is the Trakt app client id.: Forbidden");
    });
});

test("admin list returns lightweight cursor for loading more", async () => {
    const store = new Map();
    for (const id of ["101", "102", "103", "104", "105", "106", "107", "108", "109", "110", "111"]) {
        seedAuto(store, `trakt:translation:movies:${id}`, {
            title: `分页电影 ${id}`,
            overview: null,
            tagline: null,
        });
    }

    await withBackend(store, async () => {
        const firstPageRes = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: {
                action: "list",
                type: "movies",
                limit: "2",
            },
        });

        assert.equal(firstPageRes.statusCode, 200);
        assert.deepEqual(
            firstPageRes.jsonBody.items.map((item) => item.id),
            ["101", "102"],
        );
        assert.notEqual(firstPageRes.jsonBody.cursor, "0");
        assert.equal(firstPageRes.jsonBody.total, undefined);
        assert.equal(firstPageRes.jsonBody.totalPages, undefined);

        const secondPageRes = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: {
                action: "list",
                type: "movies",
                limit: "2",
                cursor: firstPageRes.jsonBody.cursor,
            },
        });

        assert.equal(secondPageRes.statusCode, 200);
        assert.deepEqual(
            secondPageRes.jsonBody.items.map((item) => item.id),
            ["103", "104"],
        );

        const defaultLimitRes = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: {
                action: "list",
                type: "movies",
            },
        });

        assert.equal(defaultLimitRes.statusCode, 200);
        assert.equal(defaultLimitRes.jsonBody.items.length, 11);
        assert.equal(defaultLimitRes.jsonBody.limit, 100);
        assert.equal(defaultLimitRes.jsonBody.cursor, "0");
        assert.deepEqual(store.mgetCommands.slice(-1), [
            [
                "JSON.MGET",
                "trakt:translation:movies:101",
                "trakt:translation:movies:102",
                "trakt:translation:movies:103",
                "trakt:translation:movies:104",
                "trakt:translation:movies:105",
                "trakt:translation:movies:106",
                "trakt:translation:movies:107",
                "trakt:translation:movies:108",
                "trakt:translation:movies:109",
                "trakt:translation:movies:110",
                "trakt:translation:movies:111",
                "$",
            ],
        ]);
        assert.ok(store.getCommands.some(([command, key]) => command === "JSON.GET" && key === TRANSLATION_OVERRIDES_KEY));
    });
});

test("admin list hides load-more cursor when one filtered item is found", async () => {
    const store = new Map();
    for (let id = 1000; id < 1150; id += 1) {
        seedAuto(store, `trakt:translation:movies:${id}`, {
            title: `未覆盖电影 ${id}`,
            overview: null,
            tagline: null,
        });
    }
    seedOverride(store, "movies", "999", {
        title: "唯一覆盖标题",
    });

    await withBackend(store, async () => {
        const res = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: {
                action: "list",
                type: "movies",
                override: "overridden",
                limit: "100",
            },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(
            res.jsonBody.items.map((item) => item.id),
            ["999"],
        );
        assert.equal(res.jsonBody.cursor, "0");
    });
});

test("admin search returns empty for non-id queries without Search commands", async () => {
    const store = new Map();
    seedAuto(store, "trakt:translation:movies:abc123", {
        title: "abc123 标题命中",
        overview: null,
        tagline: null,
    });
    seedAuto(store, AUTO_MOVIE_123, {
        title: "银河.点号标题",
        overview: null,
        tagline: null,
    });

    await withBackend(store, async () => {
        const textRes = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: {
                action: "list",
                type: "movies",
                q: "abc123",
            },
        });
        assert.equal(textRes.statusCode, 200);
        assert.deepEqual(textRes.jsonBody.items, []);
        assert.equal(textRes.jsonBody.cursor, "0");

        const titleRes = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: {
                action: "list",
                type: "movies",
                q: "银河.",
            },
        });
        assert.equal(titleRes.statusCode, 200);
        assert.deepEqual(titleRes.jsonBody.items, []);
        assert.equal(titleRes.jsonBody.cursor, "0");
        assert.equal(store.searchCommands, undefined);
        assert.equal(store.scanCommands, undefined);
    });
});

test("admin search reads exact numeric ids without scanning titles", async () => {
    const store = new Map();
    for (let index = 1; index <= 80; index += 1) {
        const id = String(1000 + index);
        seedAuto(store, `trakt:translation:movies:${id}`, {
            title: index === 80 ? "深层银河命中" : `普通电影 ${id}`,
            overview: null,
            tagline: null,
        });
    }

    await withBackend(store, async () => {
        const res = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: {
                action: "list",
                type: "movies",
                limit: "2",
                q: "1080",
            },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(
            res.jsonBody.items.map((item) => item.id),
            ["1080"],
        );
        assert.equal(store.searchCommands, undefined);
        assert.equal(store.scanCommands, undefined);
    });
});

test("backend ignores old string JSON cache values", async () => {
    const store = new Map();
    store.set(AUTO_MOVIE_123, JSON.stringify({ status: 1, translation: { title: "旧字符串标题", overview: null, tagline: null } }));

    await withBackend(store, async () => {
        const res = await invoke(translationsHandler, {
            method: "GET",
            query: { movies: "123" },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody.movies, {});
    });
});

test("admin rebuild search index action is no longer supported", async () => {
    const store = new Map();

    await withBackend(store, async () => {
        const res = await invoke(adminHandler, {
            method: "POST",
            headers: adminHeaders(),
            query: {
                action: "rebuild-search-index",
            },
        });

        assert.equal(res.statusCode, 400);
        assert.equal(res.jsonBody.error, "Invalid action");
    });
});

test("admin delete override falls back to auto and delete all clears both namespaces", async () => {
    const store = new Map();
    seedAuto(store, AUTO_MOVIE_123, {
        title: "自动标题",
        overview: "自动简介",
        tagline: null,
    });
    seedOverride(store, "movies", "123", {
        title: "人工标题",
    });

    await withBackend(store, async () => {
        const deleteOverrideRes = await invoke(adminHandler, {
            method: "DELETE",
            headers: adminHeaders(),
            query: {
                type: "movies",
                id: "123",
                target: "override",
            },
        });

        assert.equal(deleteOverrideRes.statusCode, 200);
        assert.equal(getOverrideEntry(store, "movies", "123"), null);
        assert.equal(deleteOverrideRes.jsonBody.effectiveEntry.translation.title, "自动标题");

        seedOverride(store, "movies", "123", {
            title: "人工标题",
        });

        const searchOverrideRes = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: {
                action: "list",
                type: "movies",
                q: "123",
            },
        });
        assert.deepEqual(
            searchOverrideRes.jsonBody.items.map((item) => item.id),
            ["123"],
        );

        const deleteAllRes = await invoke(adminHandler, {
            method: "DELETE",
            headers: adminHeaders(),
            query: {
                type: "movies",
                id: "123",
                target: "all",
            },
        });

        assert.equal(deleteAllRes.statusCode, 200);
        // auto 清理用 JSON.DEL：对不存在的 key/字段返回 0，不会像 JSON.MSET 一样报错
        assert.deepEqual(store.delCommands, [
            ["JSON.DEL", AUTO_MOVIE_123, "$.cn"],
            ["JSON.DEL", AUTO_MOVIE_123, "$.status"],
            ["JSON.DEL", AUTO_MOVIE_123, "$.translation"],
            ["JSON.DEL", AUTO_MOVIE_123, "$.complete"],
            ["JSON.DEL", AUTO_MOVIE_123, "$.expiresAt"],
        ]);
        assert.deepEqual(getJsonValue(store, AUTO_MOVIE_123), {});
        assert.equal(getOverrideEntry(store, "movies", "123"), null);
        assert.equal(deleteAllRes.jsonBody.effectiveEntry, null);

        const searchDeletedRes = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: {
                action: "list",
                type: "movies",
                q: "123",
            },
        });

        assert.deepEqual(searchDeletedRes.jsonBody.items, []);
    });
});

test("admin auth rejects missing token, wrong token, and missing ADMIN_TOKEN", async () => {
    await withBackend(new Map(), async () => {
        const missingHeaderRes = await invoke(adminHandler, {
            method: "GET",
            query: {
                action: "list",
                type: "movies",
            },
        });
        assert.equal(missingHeaderRes.statusCode, 401);
        assert.equal(missingHeaderRes.jsonBody.error, "Unauthorized");

        const wrongTokenRes = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders("wrong-token"),
            query: {
                action: "list",
                type: "movies",
            },
        });
        assert.equal(wrongTokenRes.statusCode, 401);
        assert.equal(wrongTokenRes.jsonBody.error, "Unauthorized");
    });

    await withBackend(
        new Map(),
        async () => {
            const notConfiguredRes = await invoke(adminHandler, {
                method: "GET",
                headers: adminHeaders(),
                query: {
                    action: "list",
                    type: "movies",
                },
            });
            assert.equal(notConfiguredRes.statusCode, 401);
            assert.equal(notConfiguredRes.jsonBody.error, "ADMIN_TOKEN is not configured");
        },
        {
            adminToken: null,
        },
    );
});

test("admin 覆盖按地区读写：tw 覆盖只影响 tw 地区", async () => {
    const store = new Map();
    seedAuto(store, AUTO_MOVIE_123, {
        title: "自动标题",
        overview: "自动简介",
        tagline: null,
    });

    await withBackend(store, async () => {
        const putRes = await invoke(adminHandler, {
            method: "PUT",
            headers: adminHeaders(),
            body: {
                type: "movies",
                id: "123",
                locale: "tw",
                translation: {
                    title: "台灣覆蓋",
                },
            },
        });

        assert.equal(putRes.statusCode, 200);
        assert.equal(getOverrideEntry(store, "movies", "123").tw.translation.title, "台灣覆蓋");

        const twItem = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: {
                action: "item",
                type: "movies",
                id: "123",
                locale: "tw",
            },
        });
        assert.equal(twItem.jsonBody.override.translation.title, "台灣覆蓋");
        assert.equal(twItem.jsonBody.effectiveEntry.translation.title, "台灣覆蓋");

        const cnItem = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: {
                action: "item",
                type: "movies",
                id: "123",
            },
        });
        assert.equal(cnItem.jsonBody.override, null);
        assert.equal(cnItem.jsonBody.effectiveEntry.translation.title, "自动标题");
    });
});

test("admin 列表浏览（搜索框留空）按所选地区投影", async () => {
    const store = new Map();
    store.set(
        AUTO_MOVIE_123,
        jsonValue({
            cn: { status: 1, translation: { title: "简体标题" } },
            tw: { status: 1, translation: { title: "台灣標題" } },
        }),
    );

    await withBackend(store, async () => {
        const cnList = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: { action: "list", type: "movies" },
        });
        assert.equal(cnList.jsonBody.items[0].effectiveEntry.translation.title, "简体标题");

        const twList = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: { action: "list", type: "movies", locale: "tw" },
        });
        assert.equal(twList.jsonBody.items[0].effectiveEntry.translation.title, "台灣標題");
    });
});

test("cn 读取在混合文档（根字段 + tw）下回退根字段", async () => {
    const store = new Map();
    store.set(
        AUTO_MOVIE_123,
        jsonValue({
            status: 1,
            translation: { title: "简体标题" },
            tw: { status: 1, translation: { title: "台灣標題" } },
        }),
    );

    await withBackend(store, async () => {
        const cnRes = await invoke(translationsHandler, {
            method: "GET",
            query: { movies: "123" },
        });
        assert.equal(cnRes.statusCode, 200);
        assert.equal(cnRes.jsonBody.movies["123"].translation.title, "简体标题");

        const twRes = await invoke(translationsHandler, {
            method: "GET",
            query: { movies: "123", locale: "tw" },
        });
        assert.equal(twRes.jsonBody.movies["123"].translation.title, "台灣標題");
    });
});

test("图片 cn 读取在混合文档（根 poster + tw）下回退根字段", async () => {
    const store = new Map();
    store.set(
        CHINESE_IMAGE_MOVIE_123,
        jsonValue({
            poster: { status: 1, url: "https://image.tmdb.org/t/p/original/cn-poster.jpg" },
            tw: { poster: { status: 1, url: "https://image.tmdb.org/t/p/original/tw-poster.jpg" } },
        }),
    );

    await withBackend(store, async () => {
        const cnRes = await invoke(imagesHandler, {
            query: { movies: "123", mode: "chinese" },
        });
        assert.equal(cnRes.statusCode, 200);
        assert.equal(cnRes.jsonBody.movies["123"].poster.url, "https://image.tmdb.org/t/p/original/cn-poster.jpg");

        const twRes = await invoke(imagesHandler, {
            query: { movies: "123", mode: "chinese", locale: "tw" },
        });
        assert.equal(twRes.jsonBody.movies["123"].poster.url, "https://image.tmdb.org/t/p/original/tw-poster.jpg");
    });
});

test("图片读取未传 locale 时按 cn 兜底", async () => {
    const store = new Map();
    store.set(
        CHINESE_IMAGE_MOVIE_123,
        jsonValue({
            cn: { poster: { status: 1, url: "https://image.tmdb.org/t/p/original/cn-poster.jpg" } },
            tw: { poster: { status: 1, url: "https://image.tmdb.org/t/p/original/tw-poster.jpg" } },
        }),
    );

    await withBackend(store, async () => {
        const imageStore = require("../lib/trakt-cache/image-store.js");
        const entries = await imageStore.readManyImageGroupsFromKv({ url: "https://kv.example", token: "test-kv-token" }, { mode: "chinese", movies: ["123"] });
        assert.equal(entries.movies["123"].poster.url, "https://image.tmdb.org/t/p/original/cn-poster.jpg");
    });
});

test("admin 覆盖投影不把 cn 覆盖回退到 tw", async () => {
    const store = new Map();
    seedAutoEntry(store, AUTO_MOVIE_123, {
        cn: { status: 1, translation: { title: "大陆自动标题", overview: "大陆自动简介" } },
        tw: { status: 1, translation: { title: "泰德拉索：錯棚教練趣事多", overview: "台灣原生簡介" } },
    });
    seedOverrideEntry(store, "movies", "123", {
        cn: { translation: { title: "足球教练", overview: "管理员修订简介" } },
        updatedAt: 1710000000000,
    });

    await withBackend(store, async () => {
        const twItem = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: {
                action: "item",
                type: "movies",
                id: "123",
                locale: "tw",
            },
        });
        assert.equal(twItem.statusCode, 200);
        assert.equal(twItem.jsonBody.override, null);
        assert.equal(twItem.jsonBody.effectiveEntry.translation.title, "泰德拉索：錯棚教練趣事多");
        assert.equal(twItem.jsonBody.effectiveEntry.translation.overview, "台灣原生簡介");
        assert.equal(twItem.jsonBody.overrideEntry.cn.translation.title, "足球教练");

        const twList = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: {
                action: "list",
                type: "movies",
                locale: "tw",
                override: "overridden",
            },
        });
        assert.deepEqual(
            twList.jsonBody.items.map((item) => item.id),
            [],
        );

        const cnItem = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: {
                action: "item",
                type: "movies",
                id: "123",
                locale: "cn",
            },
        });
        assert.equal(cnItem.jsonBody.override.translation.title, "足球教练");
        assert.equal(cnItem.jsonBody.effectiveEntry.translation.title, "足球教练");
    });
});

test("admin 覆盖投影按地区生效并返回原始 overrideEntry", async () => {
    const store = new Map();
    seedAutoEntry(store, AUTO_MOVIE_123, {
        cn: { status: 1, translation: { title: "大陆自动标题", overview: "大陆自动简介" } },
        tw: { status: 1, translation: { title: "台灣自動標題", overview: "台灣自動簡介" } },
    });
    seedOverrideEntry(store, "movies", "123", {
        cn: { translation: { overview: "大陆覆盖简介" } },
        tw: { translation: { title: "泰德拉索：錯棚教練趣事多" } },
        updatedAt: 1710000000000,
    });

    await withBackend(store, async () => {
        const twItem = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: {
                action: "item",
                type: "movies",
                id: "123",
                locale: "tw",
            },
        });
        assert.deepEqual(twItem.jsonBody.override.translation, { title: "泰德拉索：錯棚教練趣事多" });
        assert.equal(twItem.jsonBody.effectiveEntry.translation.title, "泰德拉索：錯棚教練趣事多");
        assert.equal(twItem.jsonBody.effectiveEntry.translation.overview, "台灣自動簡介");
        assert.deepEqual(twItem.jsonBody.overrideEntry, {
            cn: { translation: { overview: "大陆覆盖简介" } },
            tw: { translation: { title: "泰德拉索：錯棚教練趣事多" } },
            updatedAt: 1710000000000,
        });

        const cnItem = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: {
                action: "item",
                type: "movies",
                id: "123",
                locale: "cn",
            },
        });
        assert.deepEqual(cnItem.jsonBody.override.translation, { overview: "大陆覆盖简介" });
        assert.equal(cnItem.jsonBody.effectiveEntry.translation.title, "大陆自动标题");
        assert.equal(cnItem.jsonBody.effectiveEntry.translation.overview, "大陆覆盖简介");
    });
});

test("admin 覆盖投影把与 cn 相同的 tw 值视为伪覆盖并忽略", async () => {
    const store = new Map();
    seedAutoEntry(store, AUTO_MOVIE_123, {
        cn: { status: 1, translation: { title: "足球教练", overview: "大陆自动简介" } },
        tw: { status: 1, translation: { title: "泰德拉索：錯棚教練趣事多", overview: "台灣原生簡介" } },
    });
    seedOverrideEntry(store, "movies", "123", {
        cn: { translation: { title: "足球教练" } },
        tw: { translation: { title: "足球教练" } },
        updatedAt: 1710000000000,
    });

    await withBackend(store, async () => {
        const twItem = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: {
                action: "item",
                type: "movies",
                id: "123",
                locale: "tw",
            },
        });

        assert.equal(twItem.statusCode, 200);
        assert.equal(twItem.jsonBody.override, null);
        assert.equal(twItem.jsonBody.effectiveEntry.translation.title, "泰德拉索：錯棚教練趣事多");
        assert.equal(twItem.jsonBody.overrideEntry.tw.translation.title, "足球教练");

        const twList = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: {
                action: "list",
                type: "movies",
                locale: "tw",
                override: "overridden",
            },
        });
        assert.deepEqual(
            twList.jsonBody.items.map((item) => item.id),
            [],
        );

        const cnItem = await invoke(adminHandler, {
            method: "GET",
            headers: adminHeaders(),
            query: {
                action: "item",
                type: "movies",
                id: "123",
                locale: "cn",
            },
        });
        assert.equal(cnItem.jsonBody.override.translation.title, "足球教练");
        assert.equal(cnItem.jsonBody.effectiveEntry.translation.title, "足球教练");
    });
});
