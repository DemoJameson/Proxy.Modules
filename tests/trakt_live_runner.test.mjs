// live runner：用 refresh_token 刷新 access_token（不触发真实网络）
import assert from "node:assert/strict";
import test from "node:test";
import { refreshOAuthToken } from "../scripts/run-trakt-live-tests.mjs";

test("live runner：用 refresh token 换新 access token", async () => {
    const calls = [];
    const result = await refreshOAuthToken("refresh-1", "client-1", async (url, payload) => {
        calls.push({ url, payload });
        return { status: 200, json: { access_token: "access-2", refresh_token: "refresh-2" } };
    });

    assert.deepEqual(result, { ok: true, accessToken: "access-2", refreshToken: "refresh-2" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.trakt.tv/oauth/token");
    assert.deepEqual(calls[0].payload, {
        grant_type: "refresh_token",
        refresh_token: "refresh-1",
        client_id: "client-1",
    });
});

test("live runner：refresh 响应缺少新 refresh token 时保留旧值", async () => {
    const result = await refreshOAuthToken("refresh-1", "client-1", async () => ({ status: 200, json: { access_token: "access-2" } }));
    assert.deepEqual(result, { ok: true, accessToken: "access-2", refreshToken: "refresh-1" });
});

test("live runner：refresh token 失效（400/401/403）判定为永久失败", async () => {
    for (const status of [400, 401, 403]) {
        const result = await refreshOAuthToken("refresh-1", "client-1", async () => ({ status, json: { error: "invalid_grant" } }));
        assert.deepEqual(result, { ok: false, transient: false, status });
    }
});

test("live runner：429/5xx/网络错误判定为临时失败（不触发重新授权）", async () => {
    for (const status of [429, 500, 503]) {
        const result = await refreshOAuthToken("refresh-1", "client-1", async () => ({ status, json: {} }));
        assert.deepEqual(result, { ok: false, transient: true, status });
    }

    const network = await refreshOAuthToken("refresh-1", "client-1", async () => {
        throw new TypeError("fetch failed");
    });
    assert.deepEqual(network, { ok: false, transient: true, status: 0 });
});

test("live runner：空 refresh token 不发起请求", async () => {
    let called = false;
    const result = await refreshOAuthToken("", "client-1", async () => {
        called = true;
        return { status: 200, json: { access_token: "access-2" } };
    });
    assert.deepEqual(result, { ok: false, transient: false, status: 0 });
    assert.equal(called, false);
});
