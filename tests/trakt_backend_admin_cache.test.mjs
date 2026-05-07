import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const translationsHandler = require("../api/trakt/translations.js");
const adminHandler = require("../api/trakt/translations/admin.js");
const translationOverridesHandler = require("../api/trakt/translation-overrides.js");

const AUTO_MOVIE_123 = "trakt:translation:movies:123";
const TRANSLATION_OVERRIDES_KEY = "trakt:translation:overrides";
const AUTO_MOVIE_456 = "trakt:translation:movies:456";
const AUTO_EPISODE_123_1_2 = "trakt:translation:episodes:123:1:2";

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
            const commands = JSON.parse(init.body || "[]");
            store.pipelineRequests = [...(store.pipelineRequests || []), commands];
            const results = [];
            for (const command of commands) {
                const [name, key, , arg4] = command;
                if (name === "SEARCH.QUERY") {
                    store.searchCommands = [...(store.searchCommands || []), command];
                    results.push(null);
                } else if (name === "JSON.SET") {
                    store.setCommands = [...(store.setCommands || []), command];
                    store.set(key, jsonValue(JSON.parse(arg4)));
                    results.push("OK");
                } else if (name === "JSON.MSET") {
                    store.msetCommands = [...(store.msetCommands || []), command];
                    for (let index = 1; index < command.length; index += 3) {
                        const itemKey = command[index];
                        const value = command[index + 2];
                        store.set(itemKey, jsonValue(JSON.parse(value)));
                    }
                    results.push("OK");
                } else if (name === "JSON.MGET") {
                    store.mgetCommands = [...(store.mgetCommands || []), command];
                    const keys = command.slice(1, -1);
                    results.push(
                        keys.map((itemKey) => {
                            const stored = store.get(itemKey);
                            return stored && stored.__redisJson === true ? [stored.value] : null;
                        }),
                    );
                } else if (name === "JSON.GET") {
                    store.getCommands = [...(store.getCommands || []), command];
                    const stored = store.get(key);
                    results.push(stored && stored.__redisJson === true ? [stored.value] : null);
                } else if (name === "EXPIRE") {
                    store.expireCommands = [...(store.expireCommands || []), command];
                    store.ttlByKey = store.ttlByKey || new Map();
                    store.ttlByKey.set(key, Number(command[2]) * 1000);
                    results.push(store.has(key) ? 1 : 0);
                } else if (name === "PERSIST") {
                    store.persistCommands = [...(store.persistCommands || []), command];
                    if (store.ttlByKey) {
                        store.ttlByKey.delete(key);
                    }
                    results.push(store.has(key) ? 1 : 0);
                } else if (name === "PTTL") {
                    store.pttlCommands = [...(store.pttlCommands || []), command];
                    const ttl = store.ttlByKey ? store.ttlByKey.get(key) : undefined;
                    results.push(store.has(key) ? (Number.isFinite(ttl) ? ttl : -1) : -2);
                } else if (name === "DEL") {
                    if (store.ttlByKey) {
                        store.ttlByKey.delete(key);
                    }
                    results.push(store.delete(key) ? 1 : 0);
                } else {
                    results.push(null);
                }
            }
            return {
                ok: true,
                json: async () => results.map((result) => ({ result })),
            };
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

function jsonValue(value) {
    return {
        __redisJson: true,
        value,
    };
}

function getJsonValue(store, key) {
    const stored = store.get(key);
    return stored && stored.__redisJson === true ? stored.value : null;
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
        assert.deepEqual(overrideRes.jsonBody.movies["123"], {
            translation: {
                title: "人工标题",
                tagline: "人工标语",
            },
            updatedAt: 1710000000000,
        });
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
        assert.equal(store.mgetCommands.length, 3);
        assert.deepEqual(store.mgetCommands[0], ["JSON.MGET", "trakt:translation:shows:123", "trakt:translation:shows:404", "$"]);
        assert.deepEqual(store.mgetCommands[1], ["JSON.MGET", "trakt:translation:movies:123", "trakt:translation:movies:456", "$"]);
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
        assert.equal(getJsonValue(store, AUTO_MOVIE_123).translation.title, "新自动标题");
        assert.equal(store.pipelineRequests.length, 1);
        assert.deepEqual(store.msetCommands, [
            [
                "JSON.MSET",
                AUTO_MOVIE_123,
                "$",
                JSON.stringify({
                    status: 1,
                    translation: {
                        title: "新自动标题",
                        overview: "新自动简介",
                        tagline: "新自动标语",
                    },
                    expiresAt: null,
                }),
            ],
        ]);
        assert.equal(store.persistCommands, undefined);
        assert.equal(store.setCommands, undefined);

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
        assert.equal(overrideRes.jsonBody.movies["123"].translation.title, "锁定标题");
    });
});

test("backend POST writes grouped auto entries with JSON.MSET and keeps TTL rules", async () => {
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
        assert.deepEqual(
            store.msetCommands.map((command) => command[0]),
            ["JSON.MSET", "JSON.MSET", "JSON.MSET"],
        );
        assert.equal(store.persistCommands, undefined);
        assert.deepEqual(store.expireCommands, [
            ["EXPIRE", "trakt:translation:movies:201", 2592000],
            ["EXPIRE", "trakt:translation:episodes:301:1:1", 604800],
        ]);
        assert.equal(store.setCommands, undefined);
        assert.equal(getJsonValue(store, "trakt:translation:shows:101").expiresAt, null);
        assert.equal(getJsonValue(store, "trakt:translation:movies:202").translation.title, "完整电影标题");
        assert.equal(getJsonValue(store, "trakt:translation:movies:202").expiresAt, null);
        assert.equal(getJsonValue(store, "trakt:translation:episodes:301:1:1").status, 3);
        assert.ok(Number.isFinite(getJsonValue(store, "trakt:translation:movies:201").expiresAt));
        assert.ok(Number.isFinite(getJsonValue(store, "trakt:translation:episodes:301:1:1").expiresAt));
    });
});

test("admin item, PUT, and clear fallback use the same effective merge rules", async () => {
    const store = new Map();
    seedAuto(store, AUTO_MOVIE_123, {
        title: "自动标题",
        overview: "自动简介",
        tagline: "自动标语",
    });
    store.ttlByKey = new Map([[AUTO_MOVIE_123, 12345]]);

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
        assert.deepEqual(putRes.jsonBody.override.translation, {
            title: "人工标题",
            overview: "人工简介",
        });
        assert.deepEqual(store.pttlCommands, [["PTTL", AUTO_MOVIE_123]]);
        assert.equal(getJsonValue(store, AUTO_MOVIE_123).expiresAt, putRes.jsonBody.autoEntry.expiresAt);
        assert.ok(store.setCommands.some(([command, key]) => command === "JSON.SET" && key === AUTO_MOVIE_123));
        assert.equal("source" in getOverrideEntry(store, "movies", "123"), false);
        assert.deepEqual(getOverrideEntry(store, "movies", "123").translation, {
            title: "人工标题",
            overview: "人工简介",
        });

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
        assert.deepEqual(store.pttlCommands, [["PTTL", AUTO_MOVIE_123]]);

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
        assert.equal(store.has(AUTO_MOVIE_123), false);
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
