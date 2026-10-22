import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { invoke, SCRIPT_USER_AGENT, seedString, withBackend } from "./helpers/backend-v2.mjs";

const require = createRequire(import.meta.url);
const translationsHandler = require("../api/trakt/translations.js");
const imagesHandler = require("../api/trakt/images.js");
const creditsHandler = require("../api/trakt/credits.js");
const peopleNamesHandler = require("../api/trakt/people-names.js");
const commentTranslationsHandler = require("../api/trakt/comment-translations.js");
const listTranslationsHandler = require("../api/trakt/list-translations.js");
const overridesHandler = require("../api/trakt/translation-overrides.js");
const adminHandler = require("../api/trakt/translations/admin.js");
const redirectHandler = require("../api/redirect.js");
const middleware = require("../middleware.js");
const vercelConfig = require("../vercel.json");

const SCRIPT_ENDPOINTS = [
    ["translations", translationsHandler, { query: { movies: "123" } }],
    ["images", imagesHandler, { query: { movies: "123" } }],
    ["credits", creditsHandler, { query: { movies: "123" } }],
    ["people-names", peopleNamesHandler, { query: { people: "42" } }],
    ["comment-translations", commentTranslationsHandler, { query: { comments: "42" } }],
    ["list-translations", listTranslationsHandler, { query: { lists: "42" } }],
    ["translation-overrides", overridesHandler, {}],
];

const SCRIPT_PATHS = SCRIPT_ENDPOINTS.map(([name]) => `/api/trakt/${name}`).concat("/api/trakt/apikeys");

test("Vercel Middleware 只匹配脚本接口，不锁管理后台和公开重定向", () => {
    assert.equal(vercelConfig.proxy.entrypoint, "middleware.js");
    assert.deepEqual([...vercelConfig.proxy.matcher].sort(), [...SCRIPT_PATHS].sort());
    assert.equal(
        vercelConfig.proxy.matcher.some((path) => path.includes("/admin")),
        false,
    );
    assert.equal(vercelConfig.proxy.matcher.includes("/api/redirect"), false);
    assert.equal(middleware.default, middleware);
});

test("所有脚本缓存接口在非脚本 UA 下统一返回 403", async () => {
    const store = new Map();

    await withBackend(store, async () => {
        for (const [name, handler, request] of SCRIPT_ENDPOINTS) {
            const res = await invoke(handler, {
                ...request,
                headers: { "user-agent": "Mozilla/5.0 (Macintosh)" },
            });

            assert.equal(res.statusCode, 403, `${name} 应拒绝浏览器 UA`);
            assert.equal(res.jsonBody.error, "Forbidden", `${name} 应返回统一错误`);
            assert.equal(res.headers["Cache-Control"], "no-store", `${name} 的 403 不得被 CDN 缓存`);
            assert.equal(res.headers.Vary, undefined, `${name} 不应按 UA 拆分缓存`);
        }
    });
});

test("脚本缓存接口接受构建版本 UA，且成功响应不按版本拆分缓存", async () => {
    await withBackend(new Map(), async () => {
        for (const [name, handler, request] of SCRIPT_ENDPOINTS) {
            const res = await invoke(handler, {
                ...request,
                headers: { "user-agent": `Trakt/1.0 ${SCRIPT_USER_AGENT}` },
            });

            assert.equal(res.statusCode, 200, `${name} 应接受脚本 UA`);
            assert.equal(res.headers.Vary, undefined, `${name} 不应按 UA 拆分缓存`);
        }
    });
});

test("translation 接口在接受脚本 UA 时正常返回缓存内容", async () => {
    const store = new Map();
    seedString(store, "translation:movies:123:cn", {
        status: 1,
        translation: { title: "标题", overview: null, tagline: null },
        expiresAt: Date.now() + 60_000,
    });

    await withBackend(store, async () => {
        const res = await invoke(translationsHandler, {
            query: { movies: "123" },
            headers: { "user-agent": `Trakt/1.0 ${SCRIPT_USER_AGENT}` },
        });

        assert.equal(res.statusCode, 200);
        assert.equal(res.jsonBody.movies["123"].translation.title, "标题");
    });
});

test("UA 版本必须是数字，未知版本字符串仍然拒绝", async () => {
    await withBackend(new Map(), async () => {
        const res = await invoke(translationsHandler, {
            query: { movies: "123" },
            headers: { "user-agent": "TraktSimplifiedChinese/unknown" },
        });

        assert.equal(res.statusCode, 403);
    });
});

test("管理后台继续只校验 Bearer，不额外要求脚本 UA", async () => {
    await withBackend(new Map(), async () => {
        const res = await invoke(adminHandler, {
            headers: { authorization: "Bearer wrong" },
        });

        assert.equal(res.statusCode, 401);
        assert.notEqual(res.statusCode, 403);
    });
});

test("公开重定向接口不受脚本 UA 锁影响", async () => {
    const res = await invoke(redirectHandler, {
        query: { deeplink: "infuse://movie/123" },
        headers: { "user-agent": "Mozilla/5.0 (Macintosh)" },
    });

    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.Location, "infuse://movie/123");
});

test("Middleware 在缓存前拒绝非脚本 UA，并返回不可缓存的 403", async () => {
    const response = middleware(
        new Request("https://backend.example/api/trakt/translations?movies=123", {
            headers: { "user-agent": "Mozilla/5.0 (Macintosh)" },
        }),
    );

    assert.equal(response.status, 403);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(await response.json(), { error: "Forbidden" });
});

test("Middleware 允许脚本 UA 继续使用共享 CDN 缓存", async () => {
    const response = middleware(
        new Request("https://backend.example/api/trakt/translations?movies=123", {
            headers: { "user-agent": `Trakt/1.0 ${SCRIPT_USER_AGENT}` },
        }),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-middleware-next"), "1");
    assert.equal(response.headers.get("Vary"), null);
});
