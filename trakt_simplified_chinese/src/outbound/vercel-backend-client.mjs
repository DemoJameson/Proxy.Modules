import * as httpUtils from "../utils/http.mjs";

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

function postJsonWithDispatchDelay(url, payload) {
    const requestPromise = httpUtils.postJson(
        url,
        payload,
        {
            "content-type": "application/json",
        },
        false,
    );
    return delay(POST_DISPATCH_DELAY_MS).then(() => requestPromise);
}

function fetchTranslations(query) {
    if (isRemoteCacheDisabled()) {
        return Promise.resolve(null);
    }
    return httpUtils.fetchJson(`${resolveBackendBaseUrl()}/api/trakt/translations?${query}`, null, false);
}

function fetchImages(query) {
    if (isRemoteCacheDisabled()) {
        return Promise.resolve(null);
    }
    return httpUtils.fetchJson(`${resolveBackendBaseUrl()}/api/trakt/images?${query}`, null, false);
}

function fetchTranslationOverrides() {
    if (isRemoteCacheDisabled()) {
        return Promise.resolve(null);
    }
    return httpUtils.fetchJson(`${resolveBackendBaseUrl()}/api/trakt/translation-overrides`, null, false);
}

function fetchDoubanCache(query) {
    if (isRemoteCacheDisabled()) {
        return Promise.resolve(null);
    }
    return httpUtils.fetchJson(`${resolveBackendBaseUrl()}/api/trakt/credits?${query}`, null, false);
}

function fetchPeopleNames(query) {
    if (isRemoteCacheDisabled()) {
        return Promise.resolve(null);
    }
    return httpUtils.fetchJson(`${resolveBackendBaseUrl()}/api/trakt/people-names?${query}`, null, false);
}

function fetchCommentTranslations(query) {
    if (isRemoteCacheDisabled()) {
        return Promise.resolve(null);
    }
    return httpUtils.fetchJson(`${resolveBackendBaseUrl()}/api/trakt/comment-translations?${query}`, null, false);
}

function fetchListTranslations(query) {
    if (isRemoteCacheDisabled()) {
        return Promise.resolve(null);
    }
    return httpUtils.fetchJson(`${resolveBackendBaseUrl()}/api/trakt/list-translations?${query}`, null, false);
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
