import * as httpUtils from "../utils/http.mjs";
import * as scriptUserAgent from "../utils/script-user-agent.mjs";

const DEFAULT_BACKEND_BASE_URL = "https://proxy-modules.demojameson.de5.net";
// 发出 POST 请求后等待 100ms，尽量确保请求已被代理运行时真正发出
const POST_DISPATCH_DELAY_MS = 100;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRemoteCacheDisabled() {
    const mode = globalThis.$ctx?.argument?.debugMode;
    return mode === "disableRemote" || mode === "disableAll";
}

function resolveBackendBaseUrl() {
    // 空白输入回退默认值，保证本函数永不返回空字符串
    return String(globalThis.$ctx.argument?.backendBaseUrl || DEFAULT_BACKEND_BASE_URL).trim() || DEFAULT_BACKEND_BASE_URL;
}

// 后端请求不沿用源请求头，这里单独补上脚本 UA，便于后端区分请求来源与脚本版本
function buildBackendHeaders(extraHeaders = {}) {
    return {
        ...extraHeaders,
        "user-agent": scriptUserAgent.buildScriptUserAgent(extraHeaders["user-agent"]),
    };
}

function fetchBackendJson(url) {
    return httpUtils.fetchJson(url, buildBackendHeaders(), false);
}

function postJsonWithDispatchDelay(url, payload) {
    const requestPromise = httpUtils.postJson(url, payload, buildBackendHeaders({ "content-type": "application/json" }), false);
    return delay(POST_DISPATCH_DELAY_MS).then(() => requestPromise);
}

function fetchTranslations(query) {
    if (isRemoteCacheDisabled()) {
        return Promise.resolve(null);
    }
    return fetchBackendJson(`${resolveBackendBaseUrl()}/api/trakt/translations?${query}`);
}

function fetchImages(query) {
    if (isRemoteCacheDisabled()) {
        return Promise.resolve(null);
    }
    return fetchBackendJson(`${resolveBackendBaseUrl()}/api/trakt/images?${query}`);
}

function fetchTranslationOverrides() {
    if (isRemoteCacheDisabled()) {
        return Promise.resolve(null);
    }
    return fetchBackendJson(`${resolveBackendBaseUrl()}/api/trakt/translation-overrides`);
}

function fetchDoubanCache(query) {
    if (isRemoteCacheDisabled()) {
        return Promise.resolve(null);
    }
    return fetchBackendJson(`${resolveBackendBaseUrl()}/api/trakt/credits?${query}`);
}

function fetchPeopleNames(query) {
    if (isRemoteCacheDisabled()) {
        return Promise.resolve(null);
    }
    return fetchBackendJson(`${resolveBackendBaseUrl()}/api/trakt/people-names?${query}`);
}

function fetchCommentTranslations(query) {
    if (isRemoteCacheDisabled()) {
        return Promise.resolve(null);
    }
    return fetchBackendJson(`${resolveBackendBaseUrl()}/api/trakt/comment-translations?${query}`);
}

function fetchListTranslations(query) {
    if (isRemoteCacheDisabled()) {
        return Promise.resolve(null);
    }
    return fetchBackendJson(`${resolveBackendBaseUrl()}/api/trakt/list-translations?${query}`);
}

function postTranslations(payload) {
    if (isRemoteCacheDisabled()) {
        return Promise.resolve();
    }
    return postJsonWithDispatchDelay(`${resolveBackendBaseUrl()}/api/trakt/translations`, payload);
}

function postImages(payload) {
    if (isRemoteCacheDisabled()) {
        return Promise.resolve();
    }
    return postJsonWithDispatchDelay(`${resolveBackendBaseUrl()}/api/trakt/images`, payload);
}

function postDoubanCache(payload) {
    if (isRemoteCacheDisabled()) {
        return Promise.resolve();
    }
    return postJsonWithDispatchDelay(`${resolveBackendBaseUrl()}/api/trakt/credits`, payload);
}

function postPeopleNames(payload) {
    if (isRemoteCacheDisabled()) {
        return Promise.resolve();
    }
    return postJsonWithDispatchDelay(`${resolveBackendBaseUrl()}/api/trakt/people-names`, payload);
}

function postCommentTranslations(payload) {
    if (isRemoteCacheDisabled()) {
        return Promise.resolve();
    }
    return postJsonWithDispatchDelay(`${resolveBackendBaseUrl()}/api/trakt/comment-translations`, payload);
}

function postListTranslations(payload) {
    if (isRemoteCacheDisabled()) {
        return Promise.resolve();
    }
    return postJsonWithDispatchDelay(`${resolveBackendBaseUrl()}/api/trakt/list-translations`, payload);
}

export {
    DEFAULT_BACKEND_BASE_URL,
    fetchCommentTranslations,
    fetchDoubanCache,
    fetchImages,
    fetchListTranslations,
    fetchPeopleNames,
    fetchTranslationOverrides,
    fetchTranslations,
    postCommentTranslations,
    postDoubanCache,
    postImages,
    postListTranslations,
    postPeopleNames,
    postTranslations,
    resolveBackendBaseUrl,
};
