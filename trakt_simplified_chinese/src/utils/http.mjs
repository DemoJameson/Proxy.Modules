import * as commonUtils from "../utils/common.mjs";

function buildRequestHeaders(extraHeaders, useSourceHeaders) {
    const context = globalThis.$ctx;
    const headers = {};
    const sourceHeaders = context.env.request.headers;

    if (useSourceHeaders !== false) {
        Object.keys(sourceHeaders).forEach((key) => {
            if (key === "host" || key === "content-length" || key === ":authority") {
                return;
            }
            headers[key] = sourceHeaders[key];
        });
    }

    headers.accept = "application/json";

    if (commonUtils.isPlainObject(extraHeaders)) {
        Object.keys(extraHeaders).forEach((key) => {
            if (commonUtils.isNonNullish(extraHeaders[key]) && extraHeaders[key] !== "") {
                headers[key] = extraHeaders[key];
            }
        });
    }

    return headers;
}

function getResponseStatusCode(response) {
    return Number(response?.status || 0);
}

function getRequestHeaderValue(headerName) {
    if (!headerName) {
        return null;
    }

    return globalThis.$ctx.env.request.headers[String(headerName).toLowerCase()] ?? null;
}

function getHttpClient() {
    return globalThis.$ctx.env.http;
}

function get(request) {
    return getHttpClient().get(request);
}

function post(request) {
    return getHttpClient().post(request);
}

function fetchJson(url, extraHeaders, useSourceHeaders) {
    return get({
        url,
        headers: buildRequestHeaders(extraHeaders, useSourceHeaders),
    }).then((response) => {
        const statusCode = getResponseStatusCode(response);
        if (statusCode < 200 || statusCode >= 300) {
            throw new Error(`HTTP ${statusCode} for ${url}`);
        }

        try {
            return JSON.parse(response.body);
        } catch (error) {
            throw new Error(`JSON parse failed for ${url}: ${error}`);
        }
    });
}

function postJson(url, payload, extraHeaders, useSourceHeaders) {
    return post({
        url,
        headers: buildRequestHeaders(extraHeaders, useSourceHeaders),
        body: JSON.stringify(payload),
    }).then((response) => {
        const statusCode = getResponseStatusCode(response);
        if (statusCode < 200 || statusCode >= 300) {
            throw new Error(`HTTP ${statusCode} for ${url}`);
        }

        if (!response.body) {
            return {};
        }

        try {
            return JSON.parse(response.body);
        } catch (error) {
            throw new Error(`JSON parse failed for ${url}: ${error}`);
        }
    });
}

export { buildRequestHeaders, fetchJson, get, getHttpClient, getRequestHeaderValue, getResponseStatusCode, post, postJson };
