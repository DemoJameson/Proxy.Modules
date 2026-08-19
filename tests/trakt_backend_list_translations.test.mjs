import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const listTranslationsHandler = require("../api/trakt/list-translations.js");

const LIST_TRANSLATION_42 = "trakt:list-translation:42";
const LIST_TRANSLATION_99 = "trakt:list-translation:99";
const LIST_TRANSLATION_TTL_SECONDS = 90 * 24 * 60 * 60;

function createListTranslationEntry(sourceTextHash = "hash-1", translatedText = "最佳影片合集") {
    return {
        description: {
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
    await listTranslationsHandler(
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

test("list-translations GET 完整命中时返回片单翻译条目并设置 FOUND 缓存头", async () => {
    const store = new Map();
    const entry42 = createListTranslationEntry("hash-1", "最佳影片合集");
    const entry99 = createListTranslationEntry("hash-2", "年度佳剧清单");
    store.set(LIST_TRANSLATION_42, jsonValue(entry42));
    store.set(LIST_TRANSLATION_99, jsonValue(entry99));

    await withBackend(store, async () => {
        const res = await invoke({
            method: "GET",
            query: {
                lists: "42,99",
            },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, {
            lists: {
                42: entry42,
                99: entry99,
            },
        });
        assert.deepEqual(res.headers["Cache-Control"], "public, max-age=300");
        assert.deepEqual(store.mgetCommands, [["JSON.MGET", LIST_TRANSLATION_42, LIST_TRANSLATION_99, "$"]]);
    });
});

test("list-translations GET 部分命中时使用 PARTIAL_FOUND 短缓存头", async () => {
    const store = new Map();
    store.set(LIST_TRANSLATION_42, jsonValue(createListTranslationEntry()));

    await withBackend(store, async () => {
        const res = await invoke({
            method: "GET",
            query: {
                lists: "42,99",
            },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, {
            lists: {
                42: createListTranslationEntry(),
            },
        });
        // 部分命中说明客户端即将回写缺失条目，CDN 不能长缓存
        assert.deepEqual(res.headers["Cache-Control"], "public, max-age=60");
        assert.deepEqual(res.headers["Vercel-CDN-Cache-Control"], "public, s-maxage=60, stale-while-revalidate=600");
    });
});

test("list-translations GET 全部未命中时返回空对象并设置 NOT_FOUND 缓存头", async () => {
    const store = new Map();

    await withBackend(store, async () => {
        const res = await invoke({
            method: "GET",
            query: {
                lists: "42,99",
            },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, {
            lists: {},
        });
        assert.deepEqual(res.headers["Cache-Control"], "public, max-age=0, must-revalidate");
    });
});

test("list-translations GET 用数字 ID 校验，非法项被忽略", async () => {
    const store = new Map();
    store.set(LIST_TRANSLATION_42, jsonValue(createListTranslationEntry()));

    await withBackend(store, async () => {
        const res = await invoke({
            method: "GET",
            query: {
                lists: "abc,42",
            },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, {
            lists: {
                42: createListTranslationEntry(),
            },
        });
        assert.deepEqual(store.mgetCommands, [["JSON.MGET", LIST_TRANSLATION_42, "$"]]);
    });
});

test("list-translations GET 丢弃全字段无效的存储条目", async () => {
    const store = new Map();
    store.set(LIST_TRANSLATION_42, jsonValue(createListTranslationEntry()));
    store.set(LIST_TRANSLATION_99, jsonValue({ name: { sourceTextHash: "", translatedText: "缺哈希" }, description: "not-an-object" }));

    await withBackend(store, async () => {
        const res = await invoke({
            method: "GET",
            query: {
                lists: "42,99",
            },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, {
            lists: {
                42: createListTranslationEntry(),
            },
        });
    });
});

test("list-translations GET 缺少 query 参数返回 400", async () => {
    const store = new Map();

    await withBackend(store, async () => {
        const res = await invoke({ method: "GET", query: {} });
        assert.equal(res.statusCode, 400);
    });
});

test("list-translations 接口在 KV 未配置时返回 500", async () => {
    const store = new Map();

    await withBackend(
        store,
        async () => {
            const res = await invoke({
                method: "GET",
                query: { lists: "42" },
            });
            assert.equal(res.statusCode, 500);
        },
        { kvUrl: null },
    );
});

test("list-translations POST 写入合法条目并设置 90 天 EXPIRE，再 GET 命中", async () => {
    const store = new Map();
    const entry42 = { name: { sourceTextHash: "hash-n1", translatedText: "科幻经典" }, description: { sourceTextHash: "hash-1", translatedText: "最佳科幻影片合集" } };
    const entry99 = createListTranslationEntry("hash-2", "年度佳剧清单");

    await withBackend(store, async () => {
        const res = await invoke({
            method: "POST",
            body: {
                lists: {
                    42: entry42,
                    99: entry99,
                },
            },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, {
            counts: {
                lists: 2,
            },
        });

        // 单条 pipeline 内一条 JSON.MSET 携带多个 key 三元组，每条 key 一个 90 天 EXPIRE
        assert.equal(store.pipelineRequests.length, 1);
        assert.deepEqual(store.msetCommands, [["JSON.MSET", LIST_TRANSLATION_42, "$", JSON.stringify(entry42), LIST_TRANSLATION_99, "$", JSON.stringify(entry99)]]);
        assert.deepEqual(store.expireCommands, [
            ["EXPIRE", LIST_TRANSLATION_42, LIST_TRANSLATION_TTL_SECONDS],
            ["EXPIRE", LIST_TRANSLATION_99, LIST_TRANSLATION_TTL_SECONDS],
        ]);

        const getRes = await invoke({
            method: "GET",
            query: { lists: "42,99" },
        });
        assert.deepEqual(getRes.jsonBody, {
            lists: {
                42: entry42,
                99: entry99,
            },
        });
    });
});

test("list-translations POST 跳过缺字段与非法 ID 的条目", async () => {
    const store = new Map();

    await withBackend(store, async () => {
        const res = await invoke({
            method: "POST",
            body: {
                lists: {
                    42: createListTranslationEntry("hash-1", "最佳影片合集"),
                    44: { description: { sourceTextHash: "hash-1" } },
                    abc: createListTranslationEntry("hash-1", "非法ID"),
                    45: "not-an-object",
                },
            },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, {
            counts: {
                lists: 1,
            },
        });
        assert.deepEqual(store.msetCommands, [["JSON.MSET", LIST_TRANSLATION_42, "$", JSON.stringify(createListTranslationEntry("hash-1", "最佳影片合集"))]]);
        assert.deepEqual(store.expireCommands, [["EXPIRE", LIST_TRANSLATION_42, LIST_TRANSLATION_TTL_SECONDS]]);
    });
});

test("list-translations POST 空 body 不写 KV", async () => {
    const store = new Map();

    await withBackend(store, async () => {
        const res = await invoke({
            method: "POST",
            body: {},
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, { counts: { lists: 0 } });
        assert.equal(store.msetCommands, undefined);
        assert.equal(store.pipelineRequests, undefined);
    });
});

test("list-translations 不支持的方法返回 405", async () => {
    const store = new Map();

    await withBackend(store, async () => {
        const res = await invoke({ method: "DELETE" });
        assert.equal(res.statusCode, 405);
        assert.deepEqual(res.headers.Allow, "GET, POST");
    });
});
