import { Env } from "../../scripts/vendor/Env.module.mjs";

import * as argumentConfig from "./argument.mjs";
import { TRAKT_SCRIPT_TITLE } from "./module-manifest.mjs";
import * as requestPhase from "./request.mjs";
import * as responsePhase from "./response.mjs";
import * as commonUtils from "./utils/common.mjs";

function isRequestPhase(env) {
    return typeof env.response === "undefined";
}

function applyResult(env, result) {
    const normalized = result && typeof result === "object" ? result : { type: "passThrough" };

    if (normalized.type === "rewriteRequest") {
        env.done({ url: normalized.url });
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
