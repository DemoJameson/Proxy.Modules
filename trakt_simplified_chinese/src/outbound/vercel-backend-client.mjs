import * as chineseLocale from "../shared/chinese-script-converter.mjs";
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

function currentLocale() {
    return chineseLocale.resolveChineseLocale();
}

// cn 是历史默认值：不追加参数，保持与旧后端/旧测试完全一致的请求形态
function withLocaleQuery(query, locale = currentLocale()) {
    const normalized = locale || "cn";
    if (normalized === "cn") {
        return query;
    }
    return `${query}${query ? "&" : ""}locale=${normalized}`;
}

function withLocalePayload(payload, locale = currentLocale()) {
    const base = payload && typeof payload === "object" ? payload : {};
    const normalized = locale || "cn";
    return normalized === "cn" ? base : { ...base, locale: normalized };
}

function fetchTranslations(query) {
    if (isRemoteCacheDisabled()) {
        return Promise.resolve(null);
    }
    return fetchBackendJson(`${resolveBackendBaseUrl()}/api/trakt/translations?${withLocaleQuery(query)}`);
}

// 下发第三方 API key（当前只有 TMDb）。刻意不受 debugMode 的远端开关影响：
// disableRemote / disableAll 禁的是"缓存"，而 key 属于配置下发 —— 跟着一起禁会让海报、人名翻译直接消失。
function fetchApiKeys() {
    return fetchBackendJson(`${resolveBackendBaseUrl()}/api/trakt/apikeys`);
}

function fetchImages(query, locale) {
    if (isRemoteCacheDisabled()) {
        return Promise.resolve(null);
    }
    return fetchBackendJson(`${resolveBackendBaseUrl()}/api/trakt/images?${withLocaleQuery(query, locale)}`);
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
    return fetchBackendJson(`${resolveBackendBaseUrl()}/api/trakt/people-names?${withLocaleQuery(query)}`);
}

function fetchCommentTranslations(query) {
    if (isRemoteCacheDisabled()) {
        return Promise.resolve(null);
    }
    return fetchBackendJson(`${resolveBackendBaseUrl()}/api/trakt/comment-translations?${withLocaleQuery(query)}`);
}

function fetchListTranslations(query) {
    if (isRemoteCacheDisabled()) {
        return Promise.resolve(null);
    }
    return fetchBackendJson(`${resolveBackendBaseUrl()}/api/trakt/list-translations?${withLocaleQuery(query)}`);
}

function postTranslations(payload) {
    if (isRemoteCacheDisabled()) {
        return Promise.resolve();
    }
    return postJsonWithDispatchDelay(`${resolveBackendBaseUrl()}/api/trakt/translations`, withLocalePayload(payload));
}

function postImages(payload, locale) {
    if (isRemoteCacheDisabled()) {
        return Promise.resolve();
    }
    return postJsonWithDispatchDelay(`${resolveBackendBaseUrl()}/api/trakt/images`, withLocalePayload(payload, locale));
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
    return postJsonWithDispatchDelay(`${resolveBackendBaseUrl()}/api/trakt/people-names`, withLocalePayload(payload));
}

function postCommentTranslations(payload) {
    if (isRemoteCacheDisabled()) {
        return Promise.resolve();
    }
    return postJsonWithDispatchDelay(`${resolveBackendBaseUrl()}/api/trakt/comment-translations`, withLocalePayload(payload));
}

function postListTranslations(payload) {
    if (isRemoteCacheDisabled()) {
        return Promise.resolve();
    }
    return postJsonWithDispatchDelay(`${resolveBackendBaseUrl()}/api/trakt/list-translations`, withLocalePayload(payload));
}

export {
    DEFAULT_BACKEND_BASE_URL,
    fetchApiKeys,
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
