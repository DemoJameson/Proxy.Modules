import assert from "node:assert/strict";
import test from "node:test";

import { fetchJson, getLiveConfig } from "./helpers/trakt-live-test-helpers.mjs";

const LIVE_BACKEND_USER_AGENT = "TraktLiveTestHarness/1.0 TraktSimplifiedChinese/9999999999";

function createBackendUrl(config, query = "") {
    const suffix = query ? `?${query}` : "";
    return `${config.backendBaseUrl}/api/trakt/translations${suffix}`;
}

test("live backend: 缺少查询参数时返回 400", async () => {
    const config = getLiveConfig();
    const response = await fetchJson(createBackendUrl(config), {
        headers: { "user-agent": LIVE_BACKEND_USER_AGENT },
    });

    assert.equal(response.status, 400);
    assert.equal(response.json.error, "Missing shows, movies, or episodes query");
});

test("live backend: POST 写入后可以 GET 读回 shows/movies/episodes 缓存", async () => {
    const config = getLiveConfig();
    const payload = {
        shows: {
            99999001: {
                status: 1,
                translation: {
                    title: "后端测试剧集标题",
                    overview: "后端测试剧集简介",
                    tagline: "后端测试剧集标语",
                },
            },
        },
        movies: {
            99999002: {
                status: 2,
                translation: {
                    title: "后端测试电影标题",
                    overview: null,
                    tagline: null,
                },
            },
        },
        episodes: {
            "99999003:1:1": {
                status: 3,
                translation: null,
            },
        },
    };

    const postResponse = await fetchJson(createBackendUrl(config), {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "user-agent": LIVE_BACKEND_USER_AGENT,
        },
        body: JSON.stringify(payload),
    });

    assert.equal(postResponse.status, 200);
    assert.deepEqual(postResponse.json.counts, {
        shows: 1,
        movies: 1,
        episodes: 1,
    });

    const getResponse = await fetchJson(createBackendUrl(config, "shows=99999001&movies=99999002&episodes=99999003:1:1"), {
        headers: { "user-agent": LIVE_BACKEND_USER_AGENT },
    });

    assert.equal(getResponse.status, 200);
    assert.equal(getResponse.json.shows["99999001"].status, 1);
    assert.equal(getResponse.json.shows["99999001"].translation.title, "后端测试剧集标题");
    assert.equal(getResponse.json.movies["99999002"].status, 2);
    assert.equal(getResponse.json.movies["99999002"].translation.title, "后端测试电影标题");
    assert.equal(getResponse.json.episodes["99999003:1:1"].status, 3);
    assert.equal(getResponse.json.episodes["99999003:1:1"].translation, null);
});

test("live backend: 非脚本 UA 访问缓存接口返回 403", async () => {
    const config = getLiveConfig();
    const response = await fetchJson(createBackendUrl(config, "movies=99999002"), {
        headers: { "user-agent": "Mozilla/5.0 (Macintosh)" },
    });

    assert.equal(response.status, 403);
    assert.equal(response.json.error, "Forbidden");
    assert.match(String(response.headers["cache-control"] || ""), /no-store/i);
    assert.equal(response.headers.vary, undefined);
});
