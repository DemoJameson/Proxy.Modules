import { Env } from "../../scripts/vendor/Env.module.mjs";

import * as argumentConfig from "./argument.mjs";
import { TRAKT_SCRIPT_TITLE } from "./module-manifest.mjs";
import * as requestPhase from "./request.mjs";
import * as responsePhase from "./response.mjs";
import * as cacheUtils from "./utils/cache.mjs";
import * as commonUtils from "./utils/common.mjs";

function isRequestPhase(env) {
    return typeof env.response === "undefined";
}

// QX 两种请求脚本（request-header / request-body）的 url 改写都不能安全跨域：
// 同域 url 生效，跨域 url 会被半套用（Host 换掉但 path/query 保持原样，Trakt 直接回 403）。
// path 是两者都可靠支持的字段（路径+query，不能换域名），因此 QX 统一转换成 path；
// 同域改写可无损表达，跨域改写保持 url 并告警，由调用方避免这种场景。
function buildRequestRewritePayload(env, normalized) {
    const targetUrl = String(normalized.url ?? "");
    if (!env.isQuanX()) {
        return { url: targetUrl };
    }

    try {
        const target = new URL(targetUrl);
        const current = new URL(env.request.url);
        if (target.origin === current.origin) {
            return { path: `${target.pathname}${target.search}${target.hash}` };
        }
    } catch (error) {
        env.log(`Trakt request rewrite url parse failed: ${error}`);
    }

    env.log(`Trakt request rewrite keeps cross-origin url on QX: ${targetUrl}`);
    return { url: targetUrl };
}

function applyResult(env, result) {
    const normalized = result && typeof result === "object" ? result : { type: "passThrough" };

    if (normalized.type === "rewriteRequest") {
        const payload = buildRequestRewritePayload(env, normalized);
        if (Object.hasOwn(normalized, "headers")) {
            payload.headers = normalized.headers;
        }
        if (Object.hasOwn(normalized, "body")) {
            payload.body = normalized.body;
        }
        env.done(payload);
        return;
    }

    if (normalized.type === "redirect") {
        env.done({
            response: {
                status: 302,
                headers: {
                    Location: normalized.location,
                },
            },
        });
        return;
    }

    if (normalized.type === "respond") {
        const payload = {};
        if (Object.hasOwn(normalized, "body")) {
            payload.body = normalized.body;
        }
        if (Object.hasOwn(normalized, "status")) {
            payload.status = normalized.status;
        }
        if (Object.hasOwn(normalized, "headers")) {
            payload.headers = normalized.headers;
        }
        env.done(payload);
        return;
    }

    env.done({});
}

async function runTraktScript() {
    const env = new Env(TRAKT_SCRIPT_TITLE);
    const argument = argumentConfig.parseArgument(env);
    const url = new URL(env.request.url);
    url.shortPathname = commonUtils.normalizePathname(url.pathname);

    globalThis.$ctx = {
        env,
        url,
        userAgent: String(env.request.headers["user-agent"] ?? "").trim(),
        responseBody: typeof env.response?.body === "string" ? env.response.body : "",
        argument,
    };

    try {
        const apiKey = String(env.request.headers["trakt-api-key"] ?? "").trim();
        const authorization = String(env.request.headers.authorization ?? "").trim();
        if (apiKey && authorization) {
            cacheUtils.saveAuthToken(env, apiKey, authorization);
        }
    } catch (error) {
        env.log(`Trakt auth token cache save failed: ${error}`);
    }

    try {
        const result = isRequestPhase(env) ? await requestPhase.handleRequest() : await responsePhase.handleResponse();
        applyResult(env, result);
    } catch (error) {
        env.log(`Trakt script error: ${error}`);
        env.done({});
    } finally {
        delete globalThis.$ctx;
    }
}

(async () => {
    await runTraktScript();
})();

export { applyResult, runTraktScript, TRAKT_SCRIPT_TITLE };
