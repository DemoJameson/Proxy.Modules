import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const peopleNamesHandler = require("../api/trakt/people-names.js");

const PERSON_NAME_42 = "trakt:person-name:42";
const PERSON_NAME_99 = "trakt:person-name:99";
const PERSON_NAME_TTL_SECONDS = 90 * 24 * 60 * 60;
const PERSON_NAME_GOOGLE_TTL_SECONDS = 30 * 24 * 60 * 60;
const PERSON_NAME_NOT_FOUND_TTL_SECONDS = 7 * 24 * 60 * 60;

function createPersonNameEntry(sourceTextHash = "hash-1", translatedText = "汤姆·汉克斯", source = "tmdb") {
    return {
        name: {
            sourceTextHash,
            translatedText,
            source,
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
    await peopleNamesHandler(
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

test("people-names GET 命中时返回 tmdb 姓名条目并设置 FOUND 缓存头", async () => {
    const store = new Map();
    const entry = createPersonNameEntry();
    store.set(PERSON_NAME_42, jsonValue(entry));

    await withBackend(store, async () => {
        const res = await invoke({
            method: "GET",
            query: {
                people: "42",
            },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, {
            people: {
                42: entry,
            },
        });
        assert.deepEqual(res.headers["Cache-Control"], "public, max-age=300");
        assert.deepEqual(store.mgetCommands, [["JSON.MGET", PERSON_NAME_42, "$"]]);
    });
});

test("people-names GET 全部未命中时返回空对象并设置 NOT_FOUND 缓存头", async () => {
    const store = new Map();

    await withBackend(store, async () => {
        const res = await invoke({
            method: "GET",
            query: {
                people: "42,99",
            },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, {
            people: {},
        });
        assert.deepEqual(res.headers["Cache-Control"], "public, max-age=0, must-revalidate");
    });
});

test("people-names GET 用数字 ID 校验，非法项被忽略", async () => {
    const store = new Map();
    store.set(PERSON_NAME_42, jsonValue(createPersonNameEntry()));

    await withBackend(store, async () => {
        const res = await invoke({
            method: "GET",
            query: {
                people: "abc,42",
            },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, {
            people: {
                42: createPersonNameEntry(),
            },
        });
        assert.deepEqual(store.mgetCommands, [["JSON.MGET", PERSON_NAME_42, "$"]]);
    });
});

test("people-names GET 返回 google 来源条目并丢弃缺字段的存储条目", async () => {
    const store = new Map();
    const googleEntry = createPersonNameEntry("hash-1", "谷歌译名", "google");
    store.set(PERSON_NAME_42, jsonValue(googleEntry));
    store.set(PERSON_NAME_99, jsonValue({ name: { sourceTextHash: "", translatedText: "汤姆·汉克斯", source: "tmdb" } }));

    await withBackend(store, async () => {
        const res = await invoke({
            method: "GET",
            query: {
                people: "42,99",
            },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, {
            people: {
                42: googleEntry,
            },
        });
        assert.deepEqual(res.headers["Cache-Control"], "public, max-age=300");
    });
});

test("people-names GET 缺少 query 参数返回 400", async () => {
    const store = new Map();

    await withBackend(store, async () => {
        const res = await invoke({ method: "GET", query: {} });
        assert.equal(res.statusCode, 400);
    });
});

test("people-names 接口在 KV 未配置时返回 500", async () => {
    const store = new Map();

    await withBackend(
        store,
        async () => {
            const res = await invoke({
                method: "GET",
                query: { people: "42" },
            });
            assert.equal(res.statusCode, 500);
        },
        { kvUrl: null },
    );
});

test("people-names POST 写入合法 tmdb 条目并设置 90 天 EXPIRE，再 GET 命中", async () => {
    const store = new Map();
    const entry42 = createPersonNameEntry("hash-1", "汤姆·汉克斯");
    const entry99 = createPersonNameEntry("hash-2", "巩俐");

    await withBackend(store, async () => {
        const res = await invoke({
            method: "POST",
            body: {
                people: {
                    42: entry42,
                    99: entry99,
                },
            },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, {
            counts: {
                people: 2,
            },
        });

        // 单条 pipeline 内一条 JSON.MSET 携带多个 key 三元组，每条 key 一个 90 天 EXPIRE
        assert.equal(store.pipelineRequests.length, 1);
        assert.deepEqual(store.msetCommands, [["JSON.MSET", PERSON_NAME_42, "$", JSON.stringify(entry42), PERSON_NAME_99, "$", JSON.stringify(entry99)]]);
        assert.deepEqual(store.expireCommands, [
            ["EXPIRE", PERSON_NAME_42, PERSON_NAME_TTL_SECONDS],
            ["EXPIRE", PERSON_NAME_99, PERSON_NAME_TTL_SECONDS],
        ]);

        const getRes = await invoke({
            method: "GET",
            query: { people: "42,99" },
        });
        assert.deepEqual(getRes.jsonBody, {
            people: {
                42: entry42,
                99: entry99,
            },
        });
    });
});

test("people-names POST 写入负缓存条目并设置 7 天 EXPIRE", async () => {
    const store = new Map();

    await withBackend(store, async () => {
        const res = await invoke({
            method: "POST",
            body: {
                people: {
                    42: { notFound: true },
                },
            },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, {
            counts: {
                people: 1,
            },
        });
        assert.deepEqual(store.msetCommands, [["JSON.MSET", PERSON_NAME_42, "$", JSON.stringify({ notFound: true })]]);
        assert.deepEqual(store.expireCommands, [["EXPIRE", PERSON_NAME_42, PERSON_NAME_NOT_FOUND_TTL_SECONDS]]);

        const getRes = await invoke({
            method: "GET",
            query: { people: "42" },
        });
        assert.deepEqual(getRes.jsonBody, {
            people: {
                42: { notFound: true },
            },
        });
        assert.deepEqual(getRes.headers["Cache-Control"], "public, max-age=300");
    });
});

test("people-names POST 混合姓名与负缓存条目时分别设置 TTL", async () => {
    const store = new Map();
    const entry42 = createPersonNameEntry();

    await withBackend(store, async () => {
        const res = await invoke({
            method: "POST",
            body: {
                people: {
                    42: entry42,
                    99: { notFound: true },
                },
            },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, {
            counts: {
                people: 2,
            },
        });
        assert.deepEqual(store.msetCommands, [["JSON.MSET", PERSON_NAME_42, "$", JSON.stringify(entry42), PERSON_NAME_99, "$", JSON.stringify({ notFound: true })]]);
        assert.deepEqual(store.expireCommands, [
            ["EXPIRE", PERSON_NAME_42, PERSON_NAME_TTL_SECONDS],
            ["EXPIRE", PERSON_NAME_99, PERSON_NAME_NOT_FOUND_TTL_SECONDS],
        ]);
    });
});

test("people-names POST 接受 google 条目并设置 30 天 EXPIRE", async () => {
    const store = new Map();
    const googleEntry = createPersonNameEntry("hash-1", "谷歌译名", "google");

    await withBackend(store, async () => {
        const res = await invoke({
            method: "POST",
            body: {
                people: {
                    42: googleEntry,
                },
            },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, {
            counts: {
                people: 1,
            },
        });
        assert.deepEqual(store.msetCommands, [["JSON.MSET", PERSON_NAME_42, "$", JSON.stringify(googleEntry)]]);
        assert.deepEqual(store.expireCommands, [["EXPIRE", PERSON_NAME_42, PERSON_NAME_GOOGLE_TTL_SECONDS]]);
    });
});

test("people-names POST 跳过缺字段与非法 ID 的条目", async () => {
    const store = new Map();

    await withBackend(store, async () => {
        const res = await invoke({
            method: "POST",
            body: {
                people: {
                    42: createPersonNameEntry("hash-1", "汤姆·汉克斯"),
                    44: { name: { sourceTextHash: "hash-1", source: "tmdb" } },
                    abc: createPersonNameEntry("hash-1", "非法ID"),
                    45: "not-an-object",
                },
            },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, {
            counts: {
                people: 1,
            },
        });
        assert.deepEqual(store.msetCommands, [["JSON.MSET", PERSON_NAME_42, "$", JSON.stringify(createPersonNameEntry("hash-1", "汤姆·汉克斯"))]]);
        assert.deepEqual(store.expireCommands, [["EXPIRE", PERSON_NAME_42, PERSON_NAME_TTL_SECONDS]]);
    });
});

test("people-names POST 空 body 不写 KV", async () => {
    const store = new Map();

    await withBackend(store, async () => {
        const res = await invoke({
            method: "POST",
            body: {},
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, { counts: { people: 0 } });
        assert.equal(store.msetCommands, undefined);
        assert.equal(store.pipelineRequests, undefined);
    });
});

test("people-names POST 非 people 结构 body 不写 KV", async () => {
    const store = new Map();

    await withBackend(store, async () => {
        const res = await invoke({
            method: "POST",
            body: { people: "not-an-object" },
        });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.jsonBody, { counts: { people: 0 } });
        assert.equal(store.msetCommands, undefined);
    });
});
