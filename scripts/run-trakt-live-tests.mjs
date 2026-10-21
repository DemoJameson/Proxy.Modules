import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DEFAULT_BACKEND_BASE_URL } from "../trakt_simplified_chinese/src/module-manifest.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_CONFIG_PATH = path.resolve(__dirname, "..", ".trakt-live-test.local.json");
const TRAKT_DEVICE_CODE_URL = "https://api.trakt.tv/oauth/device/code";
const TRAKT_DEVICE_TOKEN_URL = "https://api.trakt.tv/oauth/device/token";
const TRAKT_OAUTH_TOKEN_URL = "https://api.trakt.tv/oauth/token";
const TRAKT_VALIDATE_TOKEN_URL = "https://api.trakt.tv/users/settings";
const LIVE_TEST_FILES = ["tests/trakt_live_backend.test.mjs", "tests/trakt_live_script.test.mjs"];

function readLocalConfig() {
    if (!fs.existsSync(LOCAL_CONFIG_PATH)) {
        return {};
    }

    try {
        const raw = fs.readFileSync(LOCAL_CONFIG_PATH, "utf8");
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

function writeLocalConfig(config) {
    fs.writeFileSync(LOCAL_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function postJson(url, payload) {
    const response = await fetch(url, {
        method: "POST",
        headers: {
            accept: "application/json",
            "content-type": "application/json",
            "user-agent": "TraktLiveTestHarness/1.0",
        },
        body: JSON.stringify(payload),
    });

    const body = await response.text();
    let json = null;

    try {
        json = body ? JSON.parse(body) : null;
    } catch {
        json = null;
    }

    return {
        status: response.status,
        body,
        json,
    };
}

async function fetchWithJson(url, headers = {}) {
    const response = await fetch(url, {
        method: "GET",
        headers: {
            accept: "application/json",
            "content-type": "application/json",
            "user-agent": "TraktLiveTestHarness/1.0",
            ...headers,
        },
    });

    const body = await response.text();
    let json = null;

    try {
        json = body ? JSON.parse(body) : null;
    } catch {
        json = null;
    }

    return {
        status: response.status,
        body,
        json,
    };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitedResponse(response) {
    const errorName = String(response?.json?.error_name ?? response?.json?.error ?? "").toLowerCase();
    return Number(response?.status) === 429 || errorName === "rate_limited" || errorName === "slow_down";
}

// 用 refresh_token 换新的 access_token（Trakt 设备授权同样不再需要 client_secret）
// 返回：{ ok: true, accessToken, refreshToken } | { ok: false, transient, status }
// transient=true 表示 429/5xx/网络错误等临时失败，不能据此判定 refresh token 失效
async function refreshOAuthToken(refreshToken, traktApiKey, request = postJson) {
    const normalizedRefreshToken = String(refreshToken ?? "").trim();
    if (!normalizedRefreshToken) {
        return { ok: false, transient: false, status: 0 };
    }
    let tokenResponse;
    try {
        tokenResponse = await request(TRAKT_OAUTH_TOKEN_URL, {
            grant_type: "refresh_token",
            refresh_token: normalizedRefreshToken,
            client_id: traktApiKey,
        });
    } catch {
        return { ok: false, transient: true, status: 0 };
    }
    if (tokenResponse.status === 200 && tokenResponse.json?.access_token) {
        return {
            ok: true,
            accessToken: String(tokenResponse.json.access_token).trim(),
            refreshToken: String(tokenResponse.json.refresh_token ?? normalizedRefreshToken).trim(),
        };
    }
    const status = Number(tokenResponse.status);
    return { ok: false, transient: !(status === 400 || status === 401 || status === 403), status };
}

async function ensureOAuthToken(rl, currentConfig, traktApiKey) {
    let traktOAuthToken = String(process.env.TRAKT_OAUTH_TOKEN ?? currentConfig.TRAKT_OAUTH_TOKEN ?? "").trim();
    let traktRefreshToken = String(process.env.TRAKT_REFRESH_TOKEN ?? currentConfig.TRAKT_REFRESH_TOKEN ?? "").trim();

    if (traktOAuthToken) {
        const validateResponse = await fetchWithJson(TRAKT_VALIDATE_TOKEN_URL, {
            authorization: `Bearer ${traktOAuthToken}`,
            "trakt-api-key": traktApiKey,
            "trakt-api-version": "2",
        });

        if (validateResponse.status >= 200 && validateResponse.status < 300) {
            return { accessToken: traktOAuthToken, refreshToken: traktRefreshToken };
        }

        // 只有明确 401/403 才算 token 失效；429/5xx（例如 Cloudflare 限流）不能据此清掉已保存的 token
        if (validateResponse.status !== 401 && validateResponse.status !== 403) {
            console.log("");
            console.log(`校验 TRAKT_OAUTH_TOKEN 失败（HTTP ${validateResponse.status}），本次继续沿用已保存的 token。`);
            return { accessToken: traktOAuthToken, refreshToken: traktRefreshToken };
        }

        console.log("");
        console.log("当前保存的 TRAKT_OAUTH_TOKEN 已失效或不可用，先尝试用 refresh token 刷新。");
        traktOAuthToken = "";
    }

    if (traktRefreshToken) {
        const refreshed = await refreshOAuthToken(traktRefreshToken, traktApiKey);
        if (refreshed.ok) {
            console.log("已用 refresh token 刷新 access token。");
            return { accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken };
        }
        // 429/5xx/网络错误只跳过本次登录态用例，保留 refresh token，避免无谓地重新授权
        if (refreshed.transient) {
            console.log(`刷新 TRAKT_OAUTH_TOKEN 暂时失败（HTTP ${refreshed.status || "network"}），本次跳过登录态 live tests，refresh token 已保留。`);
            return { accessToken: "", refreshToken: traktRefreshToken };
        }
        console.log("refresh token 已失效，改为重新执行 Trakt 登录授权。");
    }

    console.log("");
    console.log("要启用已登录接口测试，需要先完成 Trakt 登录授权。");
    console.log("推荐直接在这里走设备授权登录，完成后会自动保存 access token 与 refresh token。");

    const deviceCodeResponse = await postJson(TRAKT_DEVICE_CODE_URL, {
        client_id: traktApiKey,
    });

    if (isRateLimitedResponse(deviceCodeResponse)) {
        console.log("");
        console.log("Trakt 设备授权当前被限流，先跳过登录态 live tests，仅运行非登录态用例。");
        return { accessToken: "", refreshToken: traktRefreshToken };
    }

    if (deviceCodeResponse.status < 200 || deviceCodeResponse.status >= 300 || !deviceCodeResponse.json) {
        throw new Error(`Failed to create Trakt device code: HTTP ${deviceCodeResponse.status} ${deviceCodeResponse.body}`);
    }

    const verificationUrl = String(deviceCodeResponse.json.verification_url ?? "").trim();
    const userCode = String(deviceCodeResponse.json.user_code ?? "").trim();
    const deviceCode = String(deviceCodeResponse.json.device_code ?? "").trim();
    const intervalSeconds = Number(deviceCodeResponse.json.interval ?? 5);
    const expiresInSeconds = Number(deviceCodeResponse.json.expires_in ?? 600);
    const loginUrl = verificationUrl && userCode ? `${verificationUrl.replace(/\/+$/, "")}/${encodeURIComponent(userCode)}` : verificationUrl;

    console.log("");
    console.log("请在浏览器中打开下面的 Trakt 登录链接并完成授权：");
    if (loginUrl) {
        console.log(loginUrl);
    } else if (verificationUrl) {
        console.log(verificationUrl);
    }
    if (userCode) {
        console.log(`用户码: ${userCode}`);
    }
    console.log(`请先在浏览器完成授权，然后回到这里按回车继续。后续最长等待 ${expiresInSeconds} 秒。`);
    await rl.question("完成授权后按回车开始获取 token: ");

    const startedAt = Date.now();
    while (Date.now() - startedAt < expiresInSeconds * 1000) {
        await sleep(intervalSeconds * 1000);

        // Trakt 已废弃 client_secret：设备授权只用 client_id + device code
        const tokenResponse = await postJson(TRAKT_DEVICE_TOKEN_URL, {
            code: deviceCode,
            client_id: traktApiKey,
        });

        if (tokenResponse.status === 200 && tokenResponse.json?.access_token) {
            traktOAuthToken = String(tokenResponse.json.access_token).trim();
            traktRefreshToken = String(tokenResponse.json.refresh_token ?? "").trim();
            console.log("Trakt 登录授权成功，已获取 access token。");
            return { accessToken: traktOAuthToken, refreshToken: traktRefreshToken };
        }

        const errorCode = String(tokenResponse.json?.error ?? "");
        if (errorCode === "authorization_pending" || errorCode === "slow_down") {
            continue;
        }

        if (errorCode === "access_denied") {
            throw new Error("Trakt 设备授权被拒绝（access_denied），如需重试请重新运行 npm run test:trakt:live");
        }

        // 410 Gone = device code 过期（Trakt 用空响应体返回状态码）
        if (errorCode === "expired_token" || tokenResponse.status === 410) {
            throw new Error("Trakt 设备授权已过期（device code 失效），请重新运行 npm run test:trakt:live");
        }

        // Trakt 现在对「等待用户授权」返回 400、对轮询过快返回 429，且响应体为空：
        // 没有 error 字段时按待授权处理，继续轮询直到超时
        if (!errorCode && (tokenResponse.status === 400 || tokenResponse.status === 429)) {
            continue;
        }

        if (tokenResponse.status >= 400) {
            throw new Error(`Failed to exchange Trakt device token: HTTP ${tokenResponse.status} ${tokenResponse.body}`);
        }
    }

    throw new Error("Timed out waiting for Trakt device authorization");
}

async function promptForMissingValues(currentConfig) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    try {
        let traktApiKey = String(process.env.TRAKT_API_KEY ?? currentConfig.TRAKT_API_KEY ?? "").trim();
        while (!traktApiKey) {
            traktApiKey = String(await rl.question("请输入 TRAKT_API_KEY（Trakt app 的 client_id）: ")).trim();
        }

        let backendBaseUrl = String(process.env.TRAKT_BACKEND_BASE_URL ?? currentConfig.TRAKT_BACKEND_BASE_URL ?? "").trim();
        if (!backendBaseUrl) {
            const answer = String(await rl.question(`请输入 TRAKT_BACKEND_BASE_URL，留空则使用默认值 ${DEFAULT_BACKEND_BASE_URL}: `)).trim();
            backendBaseUrl = answer || DEFAULT_BACKEND_BASE_URL;
        }
        const { accessToken: traktOAuthToken, refreshToken: traktRefreshToken } = await ensureOAuthToken(rl, currentConfig, traktApiKey);

        return {
            TRAKT_API_KEY: traktApiKey,
            TRAKT_BACKEND_BASE_URL: backendBaseUrl,
            TRAKT_OAUTH_TOKEN: traktOAuthToken,
            TRAKT_REFRESH_TOKEN: traktRefreshToken,
        };
    } finally {
        rl.close();
    }
}

function runCommand(command, args, env) {
    const result = spawnSync(command, args, {
        stdio: "inherit",
        env: {
            ...process.env,
            ...env,
        },
        cwd: path.resolve(__dirname, ".."),
    });

    if (typeof result.status === "number" && result.status !== 0) {
        process.exit(result.status);
    }

    if (result.error) {
        throw result.error;
    }
}

async function main() {
    const localConfig = readLocalConfig();
    const resolvedConfig = await promptForMissingValues(localConfig);

    const nextConfig = {
        ...localConfig,
        ...resolvedConfig,
    };
    // 没拿到新 token 时不要覆盖已保存的 token（例如设备授权被限流或用户跳过授权）
    if (!nextConfig.TRAKT_OAUTH_TOKEN && localConfig.TRAKT_OAUTH_TOKEN) {
        nextConfig.TRAKT_OAUTH_TOKEN = localConfig.TRAKT_OAUTH_TOKEN;
    }
    if (!nextConfig.TRAKT_REFRESH_TOKEN && localConfig.TRAKT_REFRESH_TOKEN) {
        nextConfig.TRAKT_REFRESH_TOKEN = localConfig.TRAKT_REFRESH_TOKEN;
    }
    writeLocalConfig(nextConfig);

    const testEnv = {
        TRAKT_API_KEY: resolvedConfig.TRAKT_API_KEY,
        TRAKT_BACKEND_BASE_URL: resolvedConfig.TRAKT_BACKEND_BASE_URL,
    };

    if (!process.env.TRAKT_API_VERSION) {
        testEnv.TRAKT_API_VERSION = "2";
    }

    if (resolvedConfig.TRAKT_OAUTH_TOKEN) {
        testEnv.TRAKT_OAUTH_TOKEN = resolvedConfig.TRAKT_OAUTH_TOKEN;
    }

    if (process.env.LIVE_TEST_ALLOW_GOOGLE_TRANSLATE) {
        testEnv.LIVE_TEST_ALLOW_GOOGLE_TRANSLATE = process.env.LIVE_TEST_ALLOW_GOOGLE_TRANSLATE;
    }

    runCommand(process.execPath, ["scripts/build-trakt.mjs"], testEnv);
    runCommand(process.execPath, ["--test", ...LIVE_TEST_FILES], testEnv);
}

const isCliEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCliEntry) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    });
}

export { refreshOAuthToken };
