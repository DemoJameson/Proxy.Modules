import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { createPipelineResponse, jsonValue } from "./helpers/kv-rest-mock.mjs";

const require = createRequire(import.meta.url);
const commentTranslationsHandler = require("../api/trakt/comment-translations.js");

const COMMENT_TRANSLATION_42 = "trakt:comment-translation:42";
const COMMENT_TRANSLATION_99 = "trakt:comment-translation:99";

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

// cn 写入：$.cn 折叠 + 清空旧根字段，全部在同一条原子 JSON.MSET 内；不再 EXPIRE
function collectCnWrite(store, rootFields) {
    assert.equal(store.mgetCommands.length, 1);
    assert.equal(store.msetCommands.length, 1);
    const command = store.msetCommands[0];
    assert.equal(command[0], "JSON.MSET");
    const written = {};
    for (let index = 1; index < command.length; index += 3) {
        const key = command[index];
        const path = command[index + 1];
        const value = command[index + 2];
        if (path === "$") {
            const doc = JSON.parse(value);
            written[key] = doc.cn;
            rootFields.forEach((field) => {
                assert.equal(Object.hasOwn(doc, field), false, `新 key 根文档不应包含旧根字段：${field}`);
            });
        } else if (path === "$.cn") {
            written[key] = JSON.parse(value);
        } else {
            assert.ok(rootFields.includes(path.replace(`$.`, ``)), `只应清空旧根字段：${path}`);
            assert.equal(value, "null", `${path} 应以 JSON null 清空`);
        }
    }
    assert.equal(store.setCommands, undefined);
    assert.equal(store.expireCommands, undefined);
    assert.equal(store.pttlCommands, undefined);
    return written;
}

function withoutExpiresAt(entry) {
    const copy = { ...entry };
    delete copy.expiresAt;
    return copy;
}

function createKvFetch(store) {
    return async (url, init = {}) => {
        const parsed = new URL(url);
        const path = parsed.pathname;

        if (path === "/pipeline") {
            return createPipelineResponse(store, init);
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
        assert.deepEqual(res.headers["Cache-Control"], "public, max-age=60");
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

test("comment-translations POST 写入合法条目并在数据里记录 90 天过期时间，再 GET 命中", async () => {
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

        assert.equal(store.pipelineRequests.length, 2);
        const written = collectCnWrite(store, ["comment"]);
        Object.entries(written).forEach(([, entry]) => {
            assert.ok(Number.isFinite(entry.expiresAt), "90 天过期时间应写入数据");
        });
        assert.deepEqual(written[COMMENT_TRANSLATION_42].comment, entry42.comment);
        assert.deepEqual(written[COMMENT_TRANSLATION_99].comment, entry99.comment);

        const getRes = await invoke({
            method: "GET",
            query: { comments: "42,99" },
        });
        assert.deepEqual(withoutExpiresAt(getRes.jsonBody.comments["42"]), entry42);
        assert.deepEqual(withoutExpiresAt(getRes.jsonBody.comments["99"]), entry99);
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
        const written = collectCnWrite(store, ["comment"]);
        assert.deepEqual(written[COMMENT_TRANSLATION_42].comment, createCommentTranslationEntry("hash-1", "很棒的电影").comment);
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
