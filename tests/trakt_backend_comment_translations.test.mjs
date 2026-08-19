import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const commentTranslationsHandler = require("../api/trakt/comment-translations.js");

const COMMENT_TRANSLATION_42 = "trakt:comment-translation:42";
const COMMENT_TRANSLATION_99 = "trakt:comment-translation:99";
const COMMENT_TRANSLATION_TTL_SECONDS = 90 * 24 * 60 * 60;

function createCommentTranslationEntry(sourceTextHash = "hash-1", translatedText = "很棒的电影") {
    return {
        comment: {
            sourceTextHash,
            translatedText,
        },
    };
}

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

function createKvFetch(store) {
    return async (url, init = {}) => {
        const parsed = new URL(url);
        const path = parsed.pathname;

        if (path === "/pipeline") {
            const commands = JSON.parse(init.body || "[]");
            store.pipelineRequests = [...(store.pipelineRequests || []), commands];
            const results = [];
            for (const command of commands) {
                const [name, key] = command;
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
    await commentTranslationsHandler(
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

test("comment-translations GET 命中时返回评论翻译条目并设置 FOUND 缓存头", async () => {
    const store = new Map();
    const entry = createCommentTranslationEntry();
    store.set(COMMENT_TRANSLATION_42, jsonValue(entry));

    await withBackend(store, async () => {
        const res = await invoke({
            method: "GET",
            query: {
                comments: "42",
            },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, {
            comments: {
                42: entry,
            },
        });
        assert.deepEqual(res.headers["Cache-Control"], "public, max-age=300");
        assert.deepEqual(store.mgetCommands, [["JSON.MGET", COMMENT_TRANSLATION_42, "$"]]);
    });
});

test("comment-translations GET 全部未命中时返回空对象并设置 NOT_FOUND 缓存头", async () => {
    const store = new Map();

    await withBackend(store, async () => {
        const res = await invoke({
            method: "GET",
            query: {
                comments: "42,99",
            },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, {
            comments: {},
        });
        assert.deepEqual(res.headers["Cache-Control"], "public, max-age=0, must-revalidate");
    });
});

test("comment-translations GET 用数字 ID 校验，非法项被忽略", async () => {
    const store = new Map();
    store.set(COMMENT_TRANSLATION_42, jsonValue(createCommentTranslationEntry()));

    await withBackend(store, async () => {
        const res = await invoke({
            method: "GET",
            query: {
                comments: "abc,42",
            },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, {
            comments: {
                42: createCommentTranslationEntry(),
            },
        });
        assert.deepEqual(store.mgetCommands, [["JSON.MGET", COMMENT_TRANSLATION_42, "$"]]);
    });
});

test("comment-translations GET 丢弃缺字段的存储条目", async () => {
    const store = new Map();
    store.set(COMMENT_TRANSLATION_42, jsonValue(createCommentTranslationEntry()));
    store.set(COMMENT_TRANSLATION_99, jsonValue({ comment: { sourceTextHash: "", translatedText: "缺哈希" } }));

    await withBackend(store, async () => {
        const res = await invoke({
            method: "GET",
            query: {
                comments: "42,99",
            },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, {
            comments: {
                42: createCommentTranslationEntry(),
            },
        });
        assert.deepEqual(res.headers["Cache-Control"], "public, max-age=300");
    });
});

test("comment-translations GET 缺少 query 参数返回 400", async () => {
    const store = new Map();

    await withBackend(store, async () => {
        const res = await invoke({ method: "GET", query: {} });
        assert.equal(res.statusCode, 400);
    });
});

test("comment-translations 接口在 KV 未配置时返回 500", async () => {
    const store = new Map();

    await withBackend(
        store,
        async () => {
            const res = await invoke({
                method: "GET",
                query: { comments: "42" },
            });
            assert.equal(res.statusCode, 500);
        },
        { kvUrl: null },
    );
});

test("comment-translations POST 写入合法条目并设置 90 天 EXPIRE，再 GET 命中", async () => {
    const store = new Map();
    const entry42 = createCommentTranslationEntry("hash-1", "很棒的电影");
    const entry99 = createCommentTranslationEntry("hash-2", "期待下一季");

    await withBackend(store, async () => {
        const res = await invoke({
            method: "POST",
            body: {
                comments: {
                    42: entry42,
                    99: entry99,
                },
            },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, {
            counts: {
                comments: 2,
            },
        });

        // 单条 pipeline 内一条 JSON.MSET 携带多个 key 三元组，每条 key 一个 90 天 EXPIRE
        assert.equal(store.pipelineRequests.length, 1);
        assert.deepEqual(store.msetCommands, [["JSON.MSET", COMMENT_TRANSLATION_42, "$", JSON.stringify(entry42), COMMENT_TRANSLATION_99, "$", JSON.stringify(entry99)]]);
        assert.deepEqual(store.expireCommands, [
            ["EXPIRE", COMMENT_TRANSLATION_42, COMMENT_TRANSLATION_TTL_SECONDS],
            ["EXPIRE", COMMENT_TRANSLATION_99, COMMENT_TRANSLATION_TTL_SECONDS],
        ]);

        const getRes = await invoke({
            method: "GET",
            query: { comments: "42,99" },
        });
        assert.deepEqual(getRes.jsonBody, {
            comments: {
                42: entry42,
                99: entry99,
            },
        });
    });
});

test("comment-translations POST 跳过缺字段与非法 ID 的条目", async () => {
    const store = new Map();

    await withBackend(store, async () => {
        const res = await invoke({
            method: "POST",
            body: {
                comments: {
                    42: createCommentTranslationEntry("hash-1", "很棒的电影"),
                    44: { comment: { sourceTextHash: "hash-1" } },
                    abc: createCommentTranslationEntry("hash-1", "非法ID"),
                    45: "not-an-object",
                },
            },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, {
            counts: {
                comments: 1,
            },
        });
        assert.deepEqual(store.msetCommands, [["JSON.MSET", COMMENT_TRANSLATION_42, "$", JSON.stringify(createCommentTranslationEntry("hash-1", "很棒的电影"))]]);
        assert.deepEqual(store.expireCommands, [["EXPIRE", COMMENT_TRANSLATION_42, COMMENT_TRANSLATION_TTL_SECONDS]]);
    });
});

test("comment-translations POST 空 body 不写 KV", async () => {
    const store = new Map();

    await withBackend(store, async () => {
        const res = await invoke({
            method: "POST",
            body: {},
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, { counts: { comments: 0 } });
        assert.equal(store.msetCommands, undefined);
        assert.equal(store.pipelineRequests, undefined);
    });
});

test("comment-translations POST 非 comments 结构 body 不写 KV", async () => {
    const store = new Map();

    await withBackend(store, async () => {
        const res = await invoke({
            method: "POST",
            body: { comments: "not-an-object" },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, { counts: { comments: 0 } });
        assert.equal(store.msetCommands, undefined);
    });
});

test("comment-translations 不支持的方法返回 405", async () => {
    const store = new Map();

    await withBackend(store, async () => {
        const res = await invoke({ method: "DELETE" });
        assert.equal(res.statusCode, 405);
        assert.deepEqual(res.headers.Allow, "GET, POST");
    });
});
