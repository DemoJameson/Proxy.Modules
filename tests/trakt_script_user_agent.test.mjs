import assert from "node:assert/strict";
import test from "node:test";

import { buildScriptUserAgent, getScriptVersion } from "../trakt_simplified_chinese/src/utils/script-user-agent.mjs";

import { createHttpStatusMock, createUnifiedPersistentData, runResponseCase } from "./helpers/trakt-test-helpers.mjs";

const TEST_BACKEND_BASE_URL = "https://backend.example";
const TEST_DIRECT_TRANSLATION_URL = "https://api.trakt.tv/movies/123/translations/zh?extended=all";
const TEST_SCRIPT_VERSION = "2609231530";
const BACKEND_REQUEST_PATTERN = new RegExp(`^${TEST_BACKEND_BASE_URL}/api/trakt/`);
const SCRIPT_UA_PREFIX = "TraktSimplifiedChinese/";

function withScriptVersion(version, callback) {
    const previous = globalThis.__SCRIPT_BUILD_VERSION__;
    globalThis.__SCRIPT_BUILD_VERSION__ = version;

    try {
        return callback();
    } finally {
        if (previous === undefined) {
            delete globalThis.__SCRIPT_BUILD_VERSION__;
        } else {
            globalThis.__SCRIPT_BUILD_VERSION__ = previous;
        }
    }
}

// 走一次真实响应链路，让产物脚本发出后端请求，再从 $httpClient 日志里检查 UA
async function runScriptOutboundCase() {
    return runResponseCase({
        url: "https://api.trakt.tv/movies/trending",
        body: JSON.stringify([
            {
                watchers: 1,
                movie: {
                    title: "Original Title",
                    overview: "Original Overview",
                    tagline: "Original Tagline",
                    ids: { trakt: 123 },
                    available_translations: ["zh"],
                },
            },
        ]),
        argument: { backendBaseUrl: TEST_BACKEND_BASE_URL },
        httpGetMocks: {
            [TEST_DIRECT_TRANSLATION_URL]: createHttpStatusMock(200, "[]"),
        },
    });
}

// 海报替换链路会打到自建后端与 TMDb（详情页不再直查翻译，Trakt API 由 runScriptOutboundCase 覆盖）
async function runPosterReplacementCase() {
    return runResponseCase({
        url: "https://api.trakt.tv/movies/123",
        body: JSON.stringify({
            title: "Original Title",
            overview: "Original Overview",
            tagline: "Original Tagline",
            ids: { trakt: 123, tmdb: 456 },
            language: "en",
            country: "US",
            available_translations: ["en", "zh"],
            images: {
                poster: ["https://walter.trakt.tv/images/movies/000/000/123/posters/original.jpg"],
                logo: ["https://walter.trakt.tv/images/movies/000/000/123/logos/original.png"],
            },
        }),
        argument: { backendBaseUrl: TEST_BACKEND_BASE_URL, posterImageMode: "cn" },
        persistentData: createUnifiedPersistentData(),
    });
}

test("未注入构建版本时 UA 版本号回退为 unknown", () => {
    assert.equal(getScriptVersion(), "unknown");
    assert.equal(buildScriptUserAgent(), "TraktSimplifiedChinese/unknown");
});

test("已有 UA 时把脚本 UA 追加在其后", () => {
    withScriptVersion(TEST_SCRIPT_VERSION, () => {
        assert.equal(buildScriptUserAgent(), `TraktSimplifiedChinese/${TEST_SCRIPT_VERSION}`);
        assert.equal(buildScriptUserAgent("Trakt/2.0"), `Trakt/2.0 TraktSimplifiedChinese/${TEST_SCRIPT_VERSION}`);
        assert.equal(buildScriptUserAgent("  Rippple/1.0  "), `Rippple/1.0 TraktSimplifiedChinese/${TEST_SCRIPT_VERSION}`);
        assert.equal(buildScriptUserAgent(""), `TraktSimplifiedChinese/${TEST_SCRIPT_VERSION}`);
    });
});

test("产物请求自建后端时携带脚本 UA，版本号与产物头部生成时间一致", async () => {
    const { httpLogs } = await runScriptOutboundCase();
    const backendRequests = httpLogs.filter((log) => BACKEND_REQUEST_PATTERN.test(log.url));

    assert.ok(backendRequests.length > 0, "应至少发出一次后端请求");

    for (const log of backendRequests) {
        const userAgent = String(log.headers?.["user-agent"] ?? "");
        assert.match(userAgent, new RegExp(`^${SCRIPT_UA_PREFIX}\\d{10}$`), `${log.url} 的 UA 应为 TraktSimplifiedChinese/<10 位版本号>`);
    }
});

test("只有自建后端请求带脚本 UA，Trakt API 与 TMDb 请求不受影响", async () => {
    // 海报链路覆盖 TMDb + 自建后端；列表直查链路覆盖 Trakt API + 自建后端
    const posterRun = await runPosterReplacementCase();
    const listRun = await runScriptOutboundCase();
    const httpLogs = [...posterRun.httpLogs, ...listRun.httpLogs];
    const backendRequests = httpLogs.filter((log) => BACKEND_REQUEST_PATTERN.test(log.url));
    const externalRequests = httpLogs.filter((log) => !BACKEND_REQUEST_PATTERN.test(log.url));

    assert.ok(backendRequests.length > 0, "应至少发出一次后端请求");
    for (const log of backendRequests) {
        assert.match(String(log.headers?.["user-agent"] ?? ""), new RegExp(`^${SCRIPT_UA_PREFIX}\\d{10}$`), `${log.url} 的 UA 应为 TraktSimplifiedChinese/<版本号>`);
    }

    // 该链路确实会打到 Trakt API 与 TMDb，断言才有意义
    const externalHosts = new Set(externalRequests.map((log) => new URL(log.url).hostname));
    assert.ok(externalHosts.has("api.trakt.tv"), `应覆盖 Trakt API，实际域名：${[...externalHosts].join(", ")}`);
    assert.ok(externalHosts.has("api.tmdb.org"), `应覆盖 TMDb，实际域名：${[...externalHosts].join(", ")}`);

    for (const log of externalRequests) {
        assert.equal(String(log.headers?.["user-agent"] ?? "").includes(SCRIPT_UA_PREFIX), false, `${log.url} 不应带上脚本 UA`);
    }
});
