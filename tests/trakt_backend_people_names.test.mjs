import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { createPipelineResponse, getJsonValue, jsonValue } from "./helpers/kv-rest-mock.mjs";

const require = createRequire(import.meta.url);
const peopleNamesHandler = require("../api/trakt/people-names.js");

const PERSON_NAME_42 = "trakt:person-name:42";
const PERSON_NAME_99 = "trakt:person-name:99";

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

// cn 写入：$.cn 折叠 + 清空旧根字段，全部在同一条原子 JSON.MSET 内；不再 EXPIRE
function expectCnPersonNameWrite(store, expectedById) {
    assert.equal(store.msetCommands.length, 1);
    const command = store.msetCommands[0];
    assert.equal(command[0], "JSON.MSET");
    const written = {};
    for (let index = 1; index < command.length; index += 3) {
        const key = command[index];
        const path = command[index + 1];
        const value = command[index + 2];
        if (path === "$.cn") {
            written[key] = JSON.parse(value);
        } else {
            assert.equal(value, "null", `${path} 应以 JSON null 清空`);
        }
    }
    assert.deepEqual(Object.keys(written).sort(), Object.keys(expectedById).sort());
    Object.entries(expectedById).forEach(([key, expected]) => {
        const entry = written[key];
        if (expected.name) {
            assert.equal(entry.name.sourceTextHash, expected.name.sourceTextHash);
            assert.equal(entry.name.translatedText, expected.name.translatedText);
            assert.equal(entry.name.source, expected.name.source);
            assert.ok(Number.isFinite(entry.name.expiresAt), "tmdb/google 姓名应写入 expiresAt");
        } else {
            assert.ok(Number.isFinite(entry.notFound.expiresAt), "负缓存应写入 expiresAt");
        }
    });
    assert.equal(store.expireCommands, undefined);
    assert.equal(store.pttlCommands, undefined);
    return written;
}

function withoutPersonNameExpiresAt(entry) {
    if (entry?.name) {
        const { expiresAt, ...name } = entry.name;
        return { name };
    }
    if (entry?.notFound) {
        const { expiresAt, ...notFound } = entry.notFound;
        return { notFound };
    }
    return entry;
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
        assert.deepEqual(res.headers["Cache-Control"], "public, max-age=60");
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
        // 请求 2 条仅命中 1 条：部分命中仅允许 60 秒短缓存
        assert.deepEqual(res.headers["Cache-Control"], "public, max-age=60");
        assert.deepEqual(res.headers["Vercel-CDN-Cache-Control"], "public, s-maxage=60");
    });
});

test("people-names GET 部分命中时使用 PARTIAL_FOUND 短缓存头", async () => {
    const store = new Map();
    store.set(PERSON_NAME_42, jsonValue(createPersonNameEntry()));

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
                42: createPersonNameEntry(),
            },
        });
        assert.deepEqual(res.headers["Cache-Control"], "public, max-age=60");
        assert.deepEqual(res.headers["CDN-Cache-Control"], "public, s-maxage=60");
        assert.deepEqual(res.headers["Vercel-CDN-Cache-Control"], "public, s-maxage=60");
    });
});

test("people-names GET 完整命中时使用 FOUND 长缓存头", async () => {
    const store = new Map();
    const entry42 = createPersonNameEntry("hash-1", "汤姆·汉克斯");
    const entry99 = createPersonNameEntry("hash-2", "巩俐");
    store.set(PERSON_NAME_42, jsonValue(entry42));
    store.set(PERSON_NAME_99, jsonValue(entry99));

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
                42: entry42,
                99: entry99,
            },
        });
        assert.deepEqual(res.headers["Cache-Control"], "public, max-age=300");
        assert.deepEqual(res.headers["Vercel-CDN-Cache-Control"], "public, s-maxage=86400");
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

test("people-names POST 写入合法 tmdb 条目并在数据里记录 90 天过期时间，再 GET 命中", async () => {
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

        // 单条 pipeline 内一条 JSON.MSET 携带多个 key 三元组，过期时间写在数据字段里
        assert.equal(store.pipelineRequests.length, 1);
        expectCnPersonNameWrite(store, { [PERSON_NAME_42]: entry42, [PERSON_NAME_99]: entry99 });

        const getRes = await invoke({
            method: "GET",
            query: { people: "42,99" },
        });
        assert.deepEqual(withoutPersonNameExpiresAt(getRes.jsonBody.people["42"]), entry42);
        assert.deepEqual(withoutPersonNameExpiresAt(getRes.jsonBody.people["99"]), entry99);
    });
});

test("people-names POST 写入负缓存条目并记录 7 天过期时间", async () => {
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
        expectCnPersonNameWrite(store, { [PERSON_NAME_42]: { notFound: true } });

        const getRes = await invoke({
            method: "GET",
            query: { people: "42" },
        });
        // 线上形状保持 { notFound: true }（过期时间只在存储侧），客户端据此写本地 7 天负缓存
        assert.deepEqual(getRes.jsonBody.people["42"], { notFound: true });
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
        expectCnPersonNameWrite(store, { [PERSON_NAME_42]: entry42, [PERSON_NAME_99]: { notFound: true } });
    });
});

test("people-names POST 接受 google 条目并记录 30 天过期时间", async () => {
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
        expectCnPersonNameWrite(store, { [PERSON_NAME_42]: googleEntry });
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
        expectCnPersonNameWrite(store, { [PERSON_NAME_42]: createPersonNameEntry("hash-1", "汤姆·汉克斯") });
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

test("people-names POST 带 cn 折叠数据时写入 $.cn 并清空旧根字段", async () => {
    const store = new Map();
    const cnEntry = createPersonNameEntry("hash-cn", "汤姆·汉克斯");
    const twEntry = createPersonNameEntry("hash-tw", "湯姆·漢克斯");
    store.set(PERSON_NAME_42, jsonValue(cnEntry));

    await withBackend(store, async () => {
        const res = await invoke({
            method: "POST",
            body: {
                locale: "tw",
                people: { 42: twEntry },
                cn: { people: { 42: cnEntry } },
            },
        });

        assert.equal(res.statusCode, 200);
        const stored = getJsonValue(store, PERSON_NAME_42);
        assert.equal(stored.cn.name.translatedText, "汤姆·汉克斯");
        assert.equal(stored.tw.name.translatedText, "湯姆·漢克斯");
        assert.equal(stored.name, null, "旧根字段应以 JSON null 清空");
    });
});

test("people-names 旧格式 {notFound:true} 负缓存可读取，tw 请求回带 cn 提示", async () => {
    const store = new Map();
    store.set(PERSON_NAME_42, jsonValue({ notFound: true }));

    await withBackend(store, async () => {
        const cnRes = await invoke({ method: "GET", query: { people: "42" } });
        assert.deepEqual(cnRes.jsonBody.people["42"], { notFound: true });

        const twRes = await invoke({ method: "GET", query: { people: "42", locale: "tw" } });
        assert.deepEqual(twRes.jsonBody.people, {});
        assert.deepEqual(twRes.jsonBody.cn.people["42"], { notFound: true });
    });
});
