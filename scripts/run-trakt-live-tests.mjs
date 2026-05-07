import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { DEFAULT_BACKEND_BASE_URL } from "../trakt_simplified_chinese/src/module-manifest.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_CONFIG_PATH = path.resolve(__dirname, "..", ".trakt-live-test.local.json");
const TRAKT_DEVICE_CODE_URL = "https://api.trakt.tv/oauth/device/code";
const TRAKT_DEVICE_TOKEN_URL = "https://api.trakt.tv/oauth/device/token";
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

async function ensureOAuthToken(rl, currentConfig, traktApiKey, traktClientSecret) {
    let traktOAuthToken = String(process.env.TRAKT_OAUTH_TOKEN ?? currentConfig.TRAKT_OAUTH_TOKEN ?? "").trim();

    if (traktOAuthToken) {
        const validateResponse = await fetchWithJson(TRAKT_VALIDATE_TOKEN_URL, {
            authorization: `Bearer ${traktOAuthToken}`,
            "trakt-api-key": traktApiKey,
            "trakt-api-version": "2",
        });

        if (validateResponse.status >= 200 && validateResponse.status < 300) {
            return {
                TRAKT_OAUTH_TOKEN: traktOAuthToken,
                TRAKT_CLIENT_SECRET: traktClientSecret,
            };
        }

        console.log("");
        console.log("当前保存的 TRAKT_OAUTH_TOKEN 已失效或不可用，将重新执行 Trakt 登录授权。");
        traktOAuthToken = "";
    }

    if (traktOAuthToken) {
        return {
            TRAKT_OAUTH_TOKEN: traktOAuthToken,
            TRAKT_CLIENT_SECRET: traktClientSecret,
        };
    }

    console.log("");
    console.log("要启用已登录接口测试，需要先完成 Trakt 登录授权。");
    console.log("推荐直接在这里走设备授权登录，完成后会自动保存 access token。");

    if (!traktClientSecret) {
        return {
            TRAKT_OAUTH_TOKEN: "",
            TRAKT_CLIENT_SECRET: "",
        };
    }

    const deviceCodeResponse = await postJson(TRAKT_DEVICE_CODE_URL, {
        client_id: traktApiKey,
    });

    if (isRateLimitedResponse(deviceCodeResponse)) {
        console.log("");
        console.log("Trakt 设备授权当前被限流，先跳过登录态 live tests，仅运行非登录态用例。");
        return {
            TRAKT_OAUTH_TOKEN: "",
            TRAKT_CLIENT_SECRET: traktClientSecret,
        };
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

        const tokenResponse = await postJson(TRAKT_DEVICE_TOKEN_URL, {
            code: deviceCode,
            client_id: traktApiKey,
            client_secret: traktClientSecret,
        });

        if (tokenResponse.status === 200 && tokenResponse.json?.access_token) {
            traktOAuthToken = String(tokenResponse.json.access_token).trim();
            console.log("Trakt 登录授权成功，已获取 access token。");
            return {
                TRAKT_OAUTH_TOKEN: traktOAuthToken,
                TRAKT_CLIENT_SECRET: traktClientSecret,
            };
        }

        const errorCode = String(tokenResponse.json?.error ?? "");
        if (errorCode === "authorization_pending" || errorCode === "slow_down") {
            continue;
        }

        if (errorCode === "access_denied" || errorCode === "expired_token") {
            throw new Error(`Trakt device auth failed: ${errorCode}`);
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

        let traktClientSecret = String(process.env.TRAKT_CLIENT_SECRET ?? currentConfig.TRAKT_CLIENT_SECRET ?? "").trim();
        if (!traktClientSecret) {
            traktClientSecret = String(await rl.question("请输入 TRAKT_CLIENT_SECRET，留空则跳过登录态接口测试: ")).trim();
        }

        let backendBaseUrl = String(process.env.TRAKT_BACKEND_BASE_URL ?? currentConfig.TRAKT_BACKEND_BASE_URL ?? "").trim();
        if (!backendBaseUrl) {
            const answer = String(await rl.question(`请输入 TRAKT_BACKEND_BASE_URL，留空则使用默认值 ${DEFAULT_BACKEND_BASE_URL}: `)).trim();
            backendBaseUrl = answer || DEFAULT_BACKEND_BASE_URL;
        }
        const oauthConfig = await ensureOAuthToken(rl, currentConfig, traktApiKey, traktClientSecret);

        return {
            TRAKT_API_KEY: traktApiKey,
            TRAKT_BACKEND_BASE_URL: backendBaseUrl,
            TRAKT_OAUTH_TOKEN: oauthConfig.TRAKT_OAUTH_TOKEN,
            TRAKT_CLIENT_SECRET: oauthConfig.TRAKT_CLIENT_SECRET,
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

    writeLocalConfig({
        ...localConfig,
        ...resolvedConfig,
    });

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

    if (resolvedConfig.TRAKT_CLIENT_SECRET) {
        testEnv.TRAKT_CLIENT_SECRET = resolvedConfig.TRAKT_CLIENT_SECRET;
    }

    if (process.env.LIVE_TEST_ALLOW_GOOGLE_TRANSLATE) {
        testEnv.LIVE_TEST_ALLOW_GOOGLE_TRANSLATE = process.env.LIVE_TEST_ALLOW_GOOGLE_TRANSLATE;
    }

    runCommand(process.execPath, ["scripts/build-trakt.mjs"], testEnv);
    runCommand(process.execPath, ["--test", ...LIVE_TEST_FILES], testEnv);
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
