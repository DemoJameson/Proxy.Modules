import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const doubanHandler = require("../api/trakt/credits.js");

const DOUBAN_TTL_SECONDS = 30 * 24 * 60 * 60;
const CREDIT_MOVIE_123 = "trakt:credit:movies:123";
const CREDIT_TV_456 = "trakt:credit:shows:456";

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

function createKvFetch(store) {
    return async (url, init = {}) => {
        const parsed = new URL(url);
        const path = parsed.pathname;

        if (path === "/pipeline") {
            const commands = JSON.parse(init.body || "[]");
            store.pipelineRequests = [...(store.pipelineRequests || []), commands];
            const results = [];
            for (const command of commands) {
                const [name, key, , _arg4] = command;
                if (name === "JSON.MSET") {
                    store.msetCommands = [...(store.msetCommands || []), command];
                    for (let index = 1; index < command.length; index += 3) {
                        store.set(command[index], jsonValue(JSON.parse(command[index + 2])));
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
                } else if (name === "EXPIRE") {
                    store.expireCommands = [...(store.expireCommands || []), command];
                    results.push(store.has(key) ? 1 : 0);
                } else {
                    results.push(null);
                }
            }
            return {
                ok: true,
                json: async () => results.map((result) => ({ result })),
            };
        }

        return {
            ok: false,
            status: 404,
            json: async () => ({ error: "not found" }),
        };
    };
}

function restoreEnv(name, value) {
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}

async function withBackend(store, callback, options = {}) {
    const previousFetch = globalThis.fetch;
    const previousKvUrl = process.env.KV_REST_API_URL;
    const previousKvToken = process.env.KV_REST_API_TOKEN;

    globalThis.fetch = createKvFetch(store);
    if (options.kvUrl === null) {
        delete process.env.KV_REST_API_URL;
        delete process.env.KV_REST_API_TOKEN;
    } else {
        process.env.KV_REST_API_URL = "https://kv.example";
        process.env.KV_REST_API_TOKEN = "test-kv-token";
    }

    try {
        await callback();
    } finally {
        globalThis.fetch = previousFetch;
        restoreEnv("KV_REST_API_URL", previousKvUrl);
        restoreEnv("KV_REST_API_TOKEN", previousKvToken);
    }
}

async function invoke(req) {
    const res = createResponse();
    await doubanHandler(
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

function seedDouban(store, key, value) {
    store.set(key, jsonValue(value));
}

test("douban GET 批量读取 movie/tv 命中并设置 FOUND 缓存头", async () => {
    const store = new Map();
    const movieEntry = {
        subject: { id: "35517044", targetType: "movies" },
        credits: { 汤姆·汉克斯: ["张一昂"] },
    };
    const tvEntry = {
        subject: { id: "4707205", targetType: "shows" },
        seasons: { ids: ["s1", "s2"] },
        credits: { 王骁: ["张三"] },
    };
    seedDouban(store, CREDIT_MOVIE_123, movieEntry);
    seedDouban(store, CREDIT_TV_456, tvEntry);

    await withBackend(store, async () => {
        const res = await invoke({
            method: "GET",
            query: {
                movies: "123",
                shows: "456",
            },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, {
            movies: {
                123: movieEntry,
            },
            shows: {
                456: tvEntry,
            },
        });
        assert.deepEqual(res.headers["Cache-Control"], "public, max-age=300");
        assert.deepEqual(store.mgetCommands, [["JSON.MGET", CREDIT_MOVIE_123, CREDIT_TV_456, "$"]]);
    });
});

test("douban GET 全部未命中时返回空对象并设置 NOT_FOUND 缓存头", async () => {
    const store = new Map();

    await withBackend(store, async () => {
        const res = await invoke({
            method: "GET",
            query: {
                movies: "999",
                shows: "888",
            },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, {
            movies: {},
            shows: {},
        });
        assert.deepEqual(res.headers["Cache-Control"], "public, max-age=0, must-revalidate");
    });
});

test("douban POST 写入 movie/tv 后再 GET 命中，并对每个 key 设置 30 天 EXPIRE", async () => {
    const store = new Map();
    const movieEntry = {
        subject: { id: "35517044", targetType: "movies" },
        credits: { 汤姆·汉克斯: ["张一昂"] },
    };
    const tvEntry = {
        subject: { id: "4707205", targetType: "shows" },
        seasons: { ids: ["s1", "s2"] },
    };
    const moviePayload = { 123: movieEntry };
    const tvPayload = { 456: tvEntry };

    await withBackend(store, async () => {
        const res = await invoke({
            method: "POST",
            body: {
                movies: moviePayload,
                shows: tvPayload,
            },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, {
            counts: {
                movies: 1,
                shows: 1,
            },
        });

        // read-modify-write：先 GET 现有 entry（空），再 MSET 写入
        assert.equal(store.pipelineRequests.length, 2);
        assert.deepEqual(store.mgetCommands, [["JSON.MGET", CREDIT_MOVIE_123, CREDIT_TV_456, "$"]]);
        assert.deepEqual(
            store.msetCommands.map((command) => command[0]),
            ["JSON.MSET", "JSON.MSET"],
        );
        assert.deepEqual(store.msetCommands, [
            ["JSON.MSET", CREDIT_MOVIE_123, "$", JSON.stringify(movieEntry)],
            ["JSON.MSET", CREDIT_TV_456, "$", JSON.stringify(tvEntry)],
        ]);
        assert.deepEqual(store.expireCommands, [
            ["EXPIRE", CREDIT_MOVIE_123, DOUBAN_TTL_SECONDS],
            ["EXPIRE", CREDIT_TV_456, DOUBAN_TTL_SECONDS],
        ]);

        const getRes = await invoke({
            method: "GET",
            query: {
                movies: "123",
                shows: "456",
            },
        });
        assert.equal(getRes.statusCode, 200);
        assert.deepEqual(getRes.jsonBody.movies, moviePayload);
        assert.deepEqual(getRes.jsonBody.shows, tvPayload);
    });
});

test("douban GET movie/tv 项用数字 ID 校验，非法项被忽略", async () => {
    const store = new Map();
    seedDouban(store, CREDIT_MOVIE_123, { subject: { id: "35517044", targetType: "movies" } });

    await withBackend(store, async () => {
        const res = await invoke({
            method: "GET",
            query: {
                movies: "abc,123",
            },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody.movies, {
            123: { subject: { id: "35517044", targetType: "movies" } },
        });
        assert.deepEqual(store.mgetCommands, [["JSON.MGET", CREDIT_MOVIE_123, "$"]]);
    });
});

test("douban GET 缺少 query 参数返回 400", async () => {
    const store = new Map();

    await withBackend(store, async () => {
        const res = await invoke({ method: "GET", query: {} });
        assert.equal(res.statusCode, 400);
    });
});

test("douban 接口在 KV 未配置时返回 500", async () => {
    const store = new Map();

    await withBackend(
        store,
        async () => {
            const res = await invoke({
                method: "GET",
                query: { movies: "123" },
            });
            assert.equal(res.statusCode, 500);
        },
        { kvUrl: null },
    );
});

test("douban POST 仅接受对象子结构，空 body 不写 KV", async () => {
    const store = new Map();

    await withBackend(store, async () => {
        const res = await invoke({
            method: "POST",
            body: { movies: null, shows: "not-an-object" },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, { counts: { movies: 0, shows: 0 } });
        assert.equal(store.msetCommands, undefined);
        assert.equal(store.expireCommands, undefined);
    });
});

test("douban POST partial 字段不覆盖已存的其他字段", async () => {
    const store = new Map();
    const existingMovie = {
        subject: { id: "35517044", targetType: "movies" },
        seasons: { ids: ["s1"] },
    };
    seedDouban(store, CREDIT_MOVIE_123, existingMovie);

    await withBackend(store, async () => {
        const res = await invoke({
            method: "POST",
            body: {
                movies: { 123: { credits: { 汤姆·汉克斯: ["张一昂"] } } },
            },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, { counts: { movies: 1, shows: 0 } });

        // read-modify-write：先 GET 现有 entry，merge incoming.credits 后 MSET 完整 entry
        assert.deepEqual(store.mgetCommands, [["JSON.MGET", CREDIT_MOVIE_123, "$"]]);
        assert.deepEqual(store.msetCommands, [
            [
                "JSON.MSET",
                CREDIT_MOVIE_123,
                "$",
                JSON.stringify({
                    subject: { id: "35517044", targetType: "movies" },
                    seasons: { ids: ["s1"] },
                    credits: { 汤姆·汉克斯: ["张一昂"] },
                }),
            ],
        ]);

        const getRes = await invoke({
            method: "GET",
            query: { movies: "123" },
        });
        assert.deepEqual(getRes.jsonBody.movies, {
            123: {
                subject: { id: "35517044", targetType: "movies" },
                seasons: { ids: ["s1"] },
                credits: { 汤姆·汉克斯: ["张一昂"] },
            },
        });
    });
});

test("douban POST 完整 entry（三字段齐全）跳过 GET 直接整体写", async () => {
    const store = new Map();
    const completeEntry = {
        subject: { id: "35517044", targetType: "movies" },
        seasons: { ids: ["s1", "s2"] },
        credits: { 汤姆·汉克斯: ["张一昂"] },
    };

    await withBackend(store, async () => {
        const res = await invoke({
            method: "POST",
            body: { movies: { 123: completeEntry } },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, { counts: { movies: 1, shows: 0 } });

        // 完整 entry 跳过 GET，只发一次 write pipeline
        assert.equal(store.mgetCommands, undefined);
        assert.equal(store.pipelineRequests.length, 1);
        assert.deepEqual(store.msetCommands, [["JSON.MSET", CREDIT_MOVIE_123, "$", JSON.stringify(completeEntry)]]);
        assert.deepEqual(store.expireCommands, [["EXPIRE", CREDIT_MOVIE_123, DOUBAN_TTL_SECONDS]]);

        const getRes = await invoke({ method: "GET", query: { movies: "123" } });
        assert.deepEqual(getRes.jsonBody.movies, { 123: completeEntry });
    });
});

test("douban POST 混合完整与 partial entry 时只对 partial 发 GET", async () => {
    const store = new Map();
    // 已存 456 的 subject+seasons，incoming 只补 credits（partial），应 merge 不覆盖
    const existingTv = {
        subject: { id: "4707205", targetType: "shows" },
        seasons: { ids: ["s1"] },
    };
    seedDouban(store, CREDIT_TV_456, existingTv);

    const completeMovie = {
        subject: { id: "35517044", targetType: "movies" },
        seasons: { ids: ["s1"] },
        credits: { 汤姆·汉克斯: ["张一昂"] },
    };

    await withBackend(store, async () => {
        const res = await invoke({
            method: "POST",
            body: {
                movies: { 123: completeMovie },
                shows: { 456: { credits: { 王骁: ["张三"] } } },
            },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, { counts: { movies: 1, shows: 1 } });

        // 只对 partial（shows:456）发 GET，完整（movies:123）跳过
        assert.deepEqual(store.mgetCommands, [["JSON.MGET", CREDIT_TV_456, "$"]]);
        // movie 整体写，tv merge 后整体写
        assert.deepEqual(store.msetCommands, [
            ["JSON.MSET", CREDIT_MOVIE_123, "$", JSON.stringify(completeMovie)],
            [
                "JSON.MSET",
                CREDIT_TV_456,
                "$",
                JSON.stringify({
                    subject: { id: "4707205", targetType: "shows" },
                    seasons: { ids: ["s1"] },
                    credits: { 王骁: ["张三"] },
                }),
            ],
        ]);

        const getRes = await invoke({
            method: "GET",
            query: { movies: "123", shows: "456" },
        });
        assert.deepEqual(getRes.jsonBody.movies, { 123: completeMovie });
        assert.deepEqual(getRes.jsonBody.shows, {
            456: {
                subject: { id: "4707205", targetType: "shows" },
                seasons: { ids: ["s1"] },
                credits: { 王骁: ["张三"] },
            },
        });
    });
});

test("douban GET 丢弃 subject.targetType 与键 targetType 不一致的 entry", async () => {
    const store = new Map();
    seedDouban(store, CREDIT_MOVIE_123, {
        subject: { id: "35517044", targetType: "shows" },
        credits: { 汤姆·汉克斯: ["张一昂"] },
    });

    await withBackend(store, async () => {
        const res = await invoke({
            method: "GET",
            query: { movies: "123" },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, { movies: {}, shows: {} });
        assert.deepEqual(res.headers["Cache-Control"], "public, max-age=0, must-revalidate");
    });
});

test("douban GET 在 subject 缺少 targetType 时保留 entry", async () => {
    const store = new Map();
    const entry = { subject: { id: "35517044" }, credits: { 王骁: ["张三"] } };
    seedDouban(store, CREDIT_MOVIE_123, entry);

    await withBackend(store, async () => {
        const res = await invoke({
            method: "GET",
            query: { movies: "123" },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody.movies, { 123: entry });
    });
});

test("getJsonValue helper 读取已存豆瓣条目", () => {
    const store = new Map();
    seedDouban(store, CREDIT_MOVIE_123, { subject: { id: "35517044", targetType: "movies" } });
    assert.deepEqual(getJsonValue(store, CREDIT_MOVIE_123), { subject: { id: "35517044", targetType: "movies" } });
    assert.equal(getJsonValue(store, "trakt:credit:movies:999"), null);
});
