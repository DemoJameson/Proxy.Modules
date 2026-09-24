import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const apiKeysHandler = require("../api/trakt/apikeys.js");

const TEST_TMDB_API_KEY = "server-tmdb-api-key";
const SCRIPT_USER_AGENT = "Trakt/1.0 TraktSimplifiedChinese/2609242020";

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

async function withEnv(env, callback) {
    const previous = process.env.TMDB_API_KEY;
    if (env.TMDB_API_KEY === undefined) {
        delete process.env.TMDB_API_KEY;
    } else {
        process.env.TMDB_API_KEY = env.TMDB_API_KEY;
    }

    try {
        return await callback();
    } finally {
        if (previous === undefined) {
            delete process.env.TMDB_API_KEY;
        } else {
            process.env.TMDB_API_KEY = previous;
        }
    }
}

function runRequest(method, userAgent) {
    const req = {
        method,
        query: {},
        headers: userAgent ? { "user-agent": userAgent } : {},
    };
    const res = createResponse();
    return { res, promise: apiKeysHandler(req, res) };
}

test("GET 携带脚本 UA 时下发已配置的 TMDb key，并禁用中间层缓存", async () => {
    await withEnv({ TMDB_API_KEY: TEST_TMDB_API_KEY }, async () => {
        const { res, promise } = runRequest("GET", SCRIPT_USER_AGENT);
        await promise;

        assert.equal(res.statusCode, 200);
        assert.equal(res.headers["Cache-Control"], "no-store");
        assert.deepEqual(res.jsonBody, { keys: { tmdb: TEST_TMDB_API_KEY } });
    });
});

test("未携带脚本 UA 时返回 403，不下发 key", async () => {
    await withEnv({ TMDB_API_KEY: TEST_TMDB_API_KEY }, async () => {
        const browser = runRequest("GET", "Mozilla/5.0 (Macintosh)");
        await browser.promise;
        assert.equal(browser.res.statusCode, 403);
        assert.equal(browser.res.jsonBody.keys, undefined);

        const empty = runRequest("GET", "");
        await empty.promise;
        assert.equal(empty.res.statusCode, 403);
    });
});

test("未配置 TMDB_API_KEY 时返回 500 并提示配置项", async () => {
    await withEnv({ TMDB_API_KEY: undefined }, async () => {
        const { res, promise } = runRequest("GET", SCRIPT_USER_AGENT);
        await promise;

        assert.equal(res.statusCode, 500);
        assert.match(String(res.jsonBody.error), /TMDB_API_KEY/);
    });
});

test("空白 TMDB_API_KEY 视为未配置", async () => {
    await withEnv({ TMDB_API_KEY: "   " }, async () => {
        const { res, promise } = runRequest("GET", SCRIPT_USER_AGENT);
        await promise;

        assert.equal(res.statusCode, 500);
    });
});

test("非 GET 方法返回 405", async () => {
    await withEnv({ TMDB_API_KEY: TEST_TMDB_API_KEY }, async () => {
        const { res, promise } = runRequest("POST", SCRIPT_USER_AGENT);
        await promise;

        assert.equal(res.statusCode, 405);
        assert.equal(res.headers.Allow, "GET");
    });
});
