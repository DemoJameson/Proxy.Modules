import * as httpUtils from "../utils/http.mjs";

const DEFAULT_BACKEND_BASE_URL = "https://proxy-modules.demojameson.de5.net";

function resolveBackendBaseUrl() {
    return String(globalThis.$ctx.argument?.backendBaseUrl || DEFAULT_BACKEND_BASE_URL).trim();
}

function fetchTranslations(query) {
    return httpUtils.fetchJson(`${resolveBackendBaseUrl()}/api/trakt/translations?${query}`, null, false);
}

function fetchImages(query) {
    return httpUtils.fetchJson(`${resolveBackendBaseUrl()}/api/trakt/images?${query}`, null, false);
}

function fetchTranslationOverrides() {
    return httpUtils.fetchJson(`${resolveBackendBaseUrl()}/api/trakt/translation-overrides`, null, false);
}

function fetchDoubanCache(query) {
    return httpUtils.fetchJson(`${resolveBackendBaseUrl()}/api/trakt/credits?${query}`, null, false);
}

function fetchPeopleNames(query) {
    return httpUtils.fetchJson(`${resolveBackendBaseUrl()}/api/trakt/people-names?${query}`, null, false);
}

function postTranslations(payload) {
    return httpUtils.postJson(
        `${resolveBackendBaseUrl()}/api/trakt/translations`,
        payload,
        {
            "content-type": "application/json",
        },
        false,
    );
}

function postImages(payload) {
    return httpUtils.postJson(
        `${resolveBackendBaseUrl()}/api/trakt/images`,
        payload,
        {
            "content-type": "application/json",
        },
        false,
    );
}

function postDoubanCache(payload) {
    return httpUtils.postJson(
        `${resolveBackendBaseUrl()}/api/trakt/credits`,
        payload,
        {
            "content-type": "application/json",
        },
        false,
    );
}

function postPeopleNames(payload) {
    return httpUtils.postJson(
        `${resolveBackendBaseUrl()}/api/trakt/people-names`,
        payload,
        {
            "content-type": "application/json",
        },
        false,
    );
}

export {
    DEFAULT_BACKEND_BASE_URL,
    fetchDoubanCache,
    fetchImages,
    fetchPeopleNames,
    fetchTranslationOverrides,
    fetchTranslations,
    postDoubanCache,
    postImages,
    postPeopleNames,
    postTranslations,
    resolveBackendBaseUrl,
};
