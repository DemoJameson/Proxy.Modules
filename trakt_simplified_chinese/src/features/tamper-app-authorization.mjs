import * as cacheUtils from "../utils/cache.mjs";
import * as commonUtils from "../utils/common.mjs";
import * as pkceUtils from "../utils/pkce.mjs";

const TRAKT_TAMPER_CLIENT_ID = "fa21865a71b1bbf9464522c876864aa6e863df53d1f3e3fc7398394ead549787";
const TRAKT_TAMPER_REDIRECT_URI = "trakt://auth";
const TRAKT_TAMPER_AUTHORIZE_URL = "https://auth.trakt.tv/oauth/authorize";
const TRAKT_TAMPER_CALLBACK_HOST = "auth.trakt.tv";
const TRAKT_TAMPER_CALLBACK_PATH = "/api/auth/oauth2/authorize";
const TRAKT_TAMPER_STATE_TTL_MS = 5 * 60 * 1000;
// 条数上限由缓存层统一定义，保证归一化与写入用的是同一个上限
const TRAKT_TAMPER_STATE_RECORD_LIMIT = cacheUtils.TAMPER_AUTHORIZATION_RECORD_LIMIT;
// 授权流程状态与长期绑定都落在 unified cache 的 persistent.tamperAppAuthorization 里，不额外占持久化 key
// Trakt access_token 的 expires_in 为 604800 秒（7 天），绑定过期时间按它加冗余计算
const TRAKT_TAMPER_ACCESS_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TRAKT_TAMPER_BINDING_REDUNDANCY_MS = 30 * 24 * 60 * 60 * 1000;
const TRAKT_TAMPER_DEFAULT_CALLBACK_STATUS = 302;

const TRAKT_TAMPER_DISABLED_REDIRECT_SCHEMES = ["rex://", "forward://"];

function isTamperAppAuthorizationEnabled(argument) {
    return argument?.tamperAppAuthorizationEnabled === true;
}

function isTamperAppAuthorizationDisabledForRedirectUri(redirectUri) {
    const normalized = String(redirectUri ?? "")
        .trim()
        .toLowerCase();
    return TRAKT_TAMPER_DISABLED_REDIRECT_SCHEMES.some((scheme) => normalized.startsWith(scheme));
}

function normalizeCallbackStatus(response) {
    const text = String(response?.status ?? response?.statusCode ?? "").trim();
    const matched = /\b(\d{3})\b/.exec(text);
    const status = matched ? Number(matched[1]) : NaN;
    return Number.isInteger(status) && status >= 100 && status <= 599 ? status : TRAKT_TAMPER_DEFAULT_CALLBACK_STATUS;
}

function getHeaderKey(headers, name) {
    const target = String(name).toLowerCase();
    return Object.keys(commonUtils.ensureObject(headers)).find((key) => String(key).toLowerCase() === target) ?? "";
}

function getHeaderValue(headers, name) {
    const key = getHeaderKey(headers, name);
    return key ? headers[key] : null;
}

function deleteHeader(headers, name) {
    const target = String(name).toLowerCase();
    Object.keys(commonUtils.ensureObject(headers)).forEach((key) => {
        if (String(key).toLowerCase() === target) {
            delete headers[key];
        }
    });
}

function setHeader(headers, name, value) {
    deleteHeader(headers, name);
    headers[name] = value;
}

function copyHeaders(sourceHeaders) {
    const headers = {};
    Object.keys(commonUtils.ensureObject(sourceHeaders)).forEach((key) => {
        const lowerKey = String(key).toLowerCase();
        if (lowerKey === "host" || lowerKey === ":authority") {
            return;
        }
        headers[key] = sourceHeaders[key];
    });
    return headers;
}

function copyRequestHeaders(sourceHeaders) {
    const headers = copyHeaders(sourceHeaders);
    deleteHeader(headers, "content-length");
    return headers;
}

function normalizeRequestBody(body) {
    if (body === undefined || body === null) {
        return "";
    }
    if (typeof body === "string") {
        return body;
    }
    try {
        return JSON.stringify(body);
    } catch {
        return String(body);
    }
}

function decodeFormComponent(value) {
    try {
        return decodeURIComponent(String(value).replace(/\+/g, " "));
    } catch {
        return String(value);
    }
}

function parseFormBody(body) {
    const payload = {};
    String(body ?? "")
        .split("&")
        .forEach((part) => {
            if (!part) {
                return;
            }
            const separatorIndex = part.indexOf("=");
            const rawKey = separatorIndex >= 0 ? part.slice(0, separatorIndex) : part;
            const rawValue = separatorIndex >= 0 ? part.slice(separatorIndex + 1) : "";
            const key = decodeFormComponent(rawKey);
            if (key) {
                payload[key] = decodeFormComponent(rawValue);
            }
        });
    return payload;
}

function stringifyFormBody(payload) {
    return Object.entries(payload)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value ?? "")).replace(/%20/g, "+")}`)
        .join("&");
}

function detectBodyFormat(body, headers) {
    const contentType = String(getHeaderValue(headers, "content-type") ?? "").toLowerCase();
    if (contentType.includes("application/json")) {
        return "json";
    }
    if (contentType.includes("application/x-www-form-urlencoded")) {
        return "form";
    }

    const text = String(body ?? "").trim();
    if (!text) {
        return "json";
    }
    if (text.startsWith("{") || text.startsWith("[")) {
        return "json";
    }
    if (text.includes("=")) {
        return "form";
    }
    return "raw";
}

function rewriteStructuredBody(body, headers, rewrite) {
    const text = normalizeRequestBody(body);
    const format = detectBodyFormat(text, headers);

    if (format === "json") {
        if (!text.trim()) {
            const payload = {};
            rewrite(payload);
            return { format, body: JSON.stringify(payload) };
        }
        try {
            const parsed = JSON.parse(text);
            if (!commonUtils.isPlainObject(parsed)) {
                return { format: "raw", body: text };
            }
            rewrite(parsed);
            return { format, body: JSON.stringify(parsed) };
        } catch {
            return { format: "raw", body: text };
        }
    }

    if (format === "form") {
        const payload = parseFormBody(text);
        rewrite(payload);
        return { format, body: stringifyFormBody(payload) };
    }

    return { format: "raw", body: text };
}

function readStructuredBodyPayload(body, headers) {
    const text = normalizeRequestBody(body);
    const format = detectBodyFormat(text, headers);
    if (format === "json") {
        try {
            const parsed = JSON.parse(text);
            return commonUtils.isPlainObject(parsed) ? parsed : null;
        } catch {
            return null;
        }
    }
    if (format === "form") {
        return parseFormBody(text);
    }
    return null;
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceRawField(body, fieldName, value) {
    const text = String(body ?? "");
    const escaped = escapeRegExp(fieldName);
    const jsonPattern = new RegExp(`("${escaped}"\\s*:\\s*")[^"]*(")`);
    if (jsonPattern.test(text)) {
        return text.replace(jsonPattern, `$1${value}$2`);
    }

    const formPattern = new RegExp(`(^|&)${escaped}=[^&]*`);
    if (formPattern.test(text)) {
        return text.replace(formPattern, `$1${fieldName}=${encodeURIComponent(value)}`);
    }

    return text;
}

function removeRawField(body, fieldName) {
    const text = String(body ?? "");
    const escaped = escapeRegExp(fieldName);
    const jsonPattern = new RegExp(`"${escaped}"\\s*:\\s*"[^"]*"\\s*,?`, "g");
    const formPattern = new RegExp(`(^|&)${escaped}=[^&]*`, "g");
    return text.replace(jsonPattern, "").replace(formPattern, "$1").replace(/[?&]$/, "").replace(/^&/, "");
}

function rewriteClientIdBody(body, headers) {
    const structured = rewriteStructuredBody(body, headers, (payload) => {
        payload.client_id = TRAKT_TAMPER_CLIENT_ID;
    });
    if (structured.format !== "raw") {
        return structured;
    }
    return {
        ...structured,
        body: replaceRawField(structured.body, "client_id", TRAKT_TAMPER_CLIENT_ID),
    };
}

function rewriteDeviceTokenBody(body, headers) {
    const structured = rewriteStructuredBody(body, headers, (payload) => {
        payload.client_id = TRAKT_TAMPER_CLIENT_ID;
        delete payload.client_secret;
    });
    if (structured.format !== "raw") {
        return structured;
    }

    let nextBody = replaceRawField(structured.body, "client_id", TRAKT_TAMPER_CLIENT_ID);
    nextBody = removeRawField(nextBody, "client_secret");
    return { ...structured, body: nextBody };
}

function rewriteTokenBody(body, headers, codeVerifier) {
    const structured = rewriteStructuredBody(body, headers, (payload) => {
        payload.client_id = TRAKT_TAMPER_CLIENT_ID;
        payload.redirect_uri = TRAKT_TAMPER_REDIRECT_URI;

        const grantType = String(payload.grant_type ?? "").toLowerCase();
        const hasCode = commonUtils.isNonNullish(payload.code) && String(payload.code).trim() !== "";
        if (codeVerifier && (grantType === "authorization_code" || hasCode)) {
            payload.code_verifier = codeVerifier;
        }

        delete payload.client_secret;
    });

    if (structured.format !== "raw") {
        return structured;
    }

    let nextBody = replaceRawField(structured.body, "client_id", TRAKT_TAMPER_CLIENT_ID);
    nextBody = replaceRawField(nextBody, "redirect_uri", TRAKT_TAMPER_REDIRECT_URI);
    if (codeVerifier) {
        nextBody = replaceRawField(nextBody, "code_verifier", codeVerifier);
    }
    nextBody = removeRawField(nextBody, "client_secret");
    return { ...structured, body: nextBody };
}

function buildTamperHeaders(sourceHeaders, bodyFormat) {
    const headers = copyRequestHeaders(sourceHeaders);
    setHeader(headers, "trakt-api-key", TRAKT_TAMPER_CLIENT_ID);
    if (bodyFormat === "json") {
        setHeader(headers, "content-type", "application/json");
    } else if (bodyFormat === "form") {
        setHeader(headers, "content-type", "application/x-www-form-urlencoded");
    }
    return headers;
}

function rewriteUrlSearchParams(url, rewrite) {
    try {
        const nextUrl = new URL(url);
        rewrite(nextUrl.searchParams);
        return nextUrl.toString();
    } catch {
        return url;
    }
}

function isTamperStateFresh(state) {
    const createdAt = Number(state?.createdAt);
    return Number.isFinite(createdAt) && Date.now() - createdAt <= TRAKT_TAMPER_STATE_TTL_MS;
}

function isTamperBindingFresh(state) {
    const bindingExpiresAt = Number(state?.bindingExpiresAt);
    return Number.isFinite(bindingExpiresAt) && bindingExpiresAt > Date.now();
}

// 流程状态 5 分钟有效，绑定按 access_token 生命周期 + 冗余有效；两者任一有效都保留该记录
function isTamperStateAlive(state) {
    return isTamperStateFresh(state) || isTamperBindingFresh(state);
}

// 只有真正进行中的授权流程（带 PKCE challenge）才必须保留；
// 设备码写出的纯绑定记录虽然 createdAt 很新，但不属于进行中的流程
function isTamperFlowPending(state) {
    return isTamperStateFresh(state) && String(state?.codeChallenge ?? "").trim() !== "";
}

function getTamperStateRetention(state) {
    return Math.max(Number(state?.createdAt) + TRAKT_TAMPER_STATE_TTL_MS, Number(state?.bindingExpiresAt) || 0);
}

function loadTamperRecords(env) {
    try {
        // 授权状态属于鉴权关键数据，与 authTokens 一样不受 debugMode 的本地缓存禁用影响
        const store = cacheUtils.loadUnifiedCache(env, undefined, undefined, undefined, undefined, { force: true }).persistent.tamperAppAuthorization;
        return commonUtils.ensureArray(store?.records).filter((record) => commonUtils.isPlainObject(record) && isTamperStateAlive(record));
    } catch (error) {
        env.log(`Trakt tamper app authorization state load failed: ${error}`);
        return [];
    }
}

// 进行中的授权流程必须保留，否则刚发起的授权会被自己挤掉；其余按保留截止时间排序，先淘汰最没有保留价值的记录
function compareTamperRecordsForKeep(left, right) {
    const leftPending = isTamperFlowPending(left) ? 1 : 0;
    const rightPending = isTamperFlowPending(right) ? 1 : 0;
    if (leftPending !== rightPending) {
        return rightPending - leftPending;
    }
    return getTamperStateRetention(right) - getTamperStateRetention(left);
}

function pruneTamperRecords(records) {
    return records
        .filter((record) => commonUtils.isPlainObject(record) && isTamperStateAlive(record))
        .sort(compareTamperRecordsForKeep)
        .slice(0, TRAKT_TAMPER_STATE_RECORD_LIMIT);
}

function saveTamperRecords(env, records) {
    try {
        const nextStore = { records: pruneTamperRecords(records) };
        const unifiedCache = cacheUtils.loadUnifiedCache(env, undefined, undefined, undefined, undefined, { force: true });
        unifiedCache.persistent.tamperAppAuthorization = nextStore;
        cacheUtils.saveUnifiedCache(env, unifiedCache, undefined, undefined, undefined, {
            force: true,
            owner: {
                path: ["persistent", "tamperAppAuthorization"],
                value: nextStore,
            },
        });
    } catch (error) {
        env.log(`Trakt tamper app authorization state save failed: ${error}`);
    }
}

function saveTamperState(env, state) {
    const records = loadTamperRecords(env);
    const next = { ...state, createdAt: Date.now() };
    const id = String(next.id ?? "").trim();
    const index = id ? records.findIndex((record) => String(record?.id ?? "").trim() === id) : -1;
    if (index >= 0) {
        records[index] = { ...records[index], ...next };
    } else {
        records.push(next);
    }
    saveTamperRecords(env, records);
}

function updateTamperState(env, predicate, updates) {
    const records = loadTamperRecords(env);
    const index = records.findIndex((record) => isTamperStateFresh(record) && predicate(record));
    if (index < 0) {
        return false;
    }
    records[index] = { ...records[index], ...updates };
    saveTamperRecords(env, records);
    return true;
}

function findTamperState(env, predicate) {
    return loadTamperRecords(env).find(predicate) ?? null;
}

function findFreshTamperState(env, predicate) {
    return findTamperState(env, (state) => isTamperStateFresh(state) && predicate(state));
}

function isSameTamperBinding(state, clientId) {
    return String(state?.clientId ?? "").trim() === clientId;
}

function getTamperBindingExpiresAt() {
    return Date.now() + TRAKT_TAMPER_ACCESS_TOKEN_TTL_MS + TRAKT_TAMPER_BINDING_REDUNDANCY_MS;
}

function upsertTamperBinding(env, clientId) {
    const normalizedClientId = String(clientId ?? "").trim();
    if (!normalizedClientId) {
        return;
    }

    const records = loadTamperRecords(env);
    const bindingExpiresAt = getTamperBindingExpiresAt();
    const index = records.findIndex((record) => isSameTamperBinding(record, normalizedClientId));
    if (index >= 0) {
        records[index] = { ...records[index], clientId: normalizedClientId, bindingExpiresAt };
    } else {
        // 设备码流程没有授权流程记录，单独写一条只带绑定的记录
        records.push({ clientId: normalizedClientId, bindingExpiresAt, createdAt: Date.now() });
    }
    saveTamperRecords(env, records);
}

function findTamperBinding(env, clientId) {
    const normalizedClientId = String(clientId ?? "").trim();
    if (!normalizedClientId) {
        return null;
    }
    return findTamperState(env, (state) => isTamperBindingFresh(state) && isSameTamperBinding(state, normalizedClientId));
}

function isOfficialTraktClientId(clientId) {
    return String(clientId ?? "").trim() === TRAKT_TAMPER_CLIENT_ID;
}

function isAlreadyTamperedAuthorizeUrl(url) {
    return isOfficialTraktClientId(url.searchParams.get("client_id")) && url.searchParams.get("redirect_uri") === TRAKT_TAMPER_REDIRECT_URI;
}

function isTraktAuthCallbackLocation(location) {
    try {
        const url = new URL(location);
        return url.protocol === "trakt:" && String(url.hostname).toLowerCase() === "auth";
    } catch {
        return String(location ?? "").startsWith("trakt://auth");
    }
}

function appendCallbackQuery(redirectUri, location, originalState) {
    const sourceUrl = new URL(location);
    if (originalState) {
        sourceUrl.searchParams.set("state", originalState);
    } else {
        sourceUrl.searchParams.delete("state");
    }

    const query = sourceUrl.searchParams.toString();
    if (!query) {
        return redirectUri;
    }
    const separator = String(redirectUri).includes("?") ? "&" : "?";
    return `${redirectUri}${separator}${query}${sourceUrl.hash || ""}`;
}

async function handleDeviceOAuthRequest() {
    const context = globalThis.$ctx;
    const pathname = commonUtils.normalizePathname(context.url.pathname);
    const bodyPayload = readStructuredBodyPayload(context.env.request.body, context.env.request.headers);
    const originalClientId = String(
        bodyPayload?.client_id ?? context.url.searchParams.get("client_id") ?? getHeaderValue(context.env.request.headers, "trakt-api-key") ?? "",
    ).trim();
    if (isOfficialTraktClientId(originalClientId)) {
        return { type: "passThrough" };
    }

    const bodyResult =
        pathname === "oauth/device/token"
            ? rewriteDeviceTokenBody(context.env.request.body, context.env.request.headers)
            : rewriteClientIdBody(context.env.request.body, context.env.request.headers);
    const url = rewriteUrlSearchParams(context.env.request.url, (searchParams) => {
        if (searchParams.has("client_id")) {
            searchParams.set("client_id", TRAKT_TAMPER_CLIENT_ID);
        }
        if (searchParams.has("client_secret")) {
            searchParams.delete("client_secret");
        }
    });

    // 只在 device/code 阶段写一次绑定：device/token 会被 App 按 interval 反复轮询，每次整块写 unified cache 代价过高
    if (pathname === "oauth/device/code") {
        upsertTamperBinding(context.env, originalClientId);
    }

    return {
        type: "rewriteRequest",
        url,
        headers: buildTamperHeaders(context.env.request.headers, bodyResult.format),
        body: bodyResult.body,
    };
}

async function handleTokenOAuthRequest() {
    const context = globalThis.$ctx;
    const bodyPayload = readStructuredBodyPayload(context.env.request.body, context.env.request.headers);
    const code = String(bodyPayload?.code ?? context.url.searchParams.get("code") ?? "").trim();
    const grantType = String(bodyPayload?.grant_type ?? context.url.searchParams.get("grant_type") ?? "")
        .trim()
        .toLowerCase();
    const originalRedirectUri = String(bodyPayload?.redirect_uri ?? context.url.searchParams.get("redirect_uri") ?? "").trim();
    const originalClientId = String(
        bodyPayload?.client_id ?? context.url.searchParams.get("client_id") ?? getHeaderValue(context.env.request.headers, "trakt-api-key") ?? "",
    ).trim();

    if (isTamperAppAuthorizationDisabledForRedirectUri(originalRedirectUri) || isOfficialTraktClientId(originalClientId)) {
        return { type: "passThrough" };
    }

    const requiresAuthorizationCode = grantType === "authorization_code" || (!grantType && code);
    let state = null;
    if (requiresAuthorizationCode) {
        if (code) {
            state = findFreshTamperState(context.env, (entry) => String(entry.code ?? "") === code);
        }
        if (!state) {
            context.env.log("Trakt tamper app authorization token rewrite skipped: no matching authorization flow");
            return { type: "passThrough" };
        }
        upsertTamperBinding(context.env, originalClientId || state.clientId);
    } else {
        if (!findTamperBinding(context.env, originalClientId)) {
            context.env.log("Trakt tamper app authorization token rewrite skipped: no matching authorization binding");
            return { type: "passThrough" };
        }
        upsertTamperBinding(context.env, originalClientId);
    }

    const codeVerifier = requiresAuthorizationCode ? String(state?.codeVerifier ?? "").trim() : "";
    const bodyResult = rewriteTokenBody(context.env.request.body, context.env.request.headers, codeVerifier);
    const url = rewriteUrlSearchParams(context.env.request.url, (searchParams) => {
        if (searchParams.has("client_id")) {
            searchParams.set("client_id", TRAKT_TAMPER_CLIENT_ID);
        }
        if (searchParams.has("redirect_uri")) {
            searchParams.set("redirect_uri", TRAKT_TAMPER_REDIRECT_URI);
        }
        if (codeVerifier && searchParams.has("code_verifier")) {
            searchParams.set("code_verifier", codeVerifier);
        }
        if (searchParams.has("client_secret")) {
            searchParams.delete("client_secret");
        }
    });

    return {
        type: "rewriteRequest",
        url,
        headers: buildTamperHeaders(context.env.request.headers, bodyResult.format),
        body: bodyResult.body,
    };
}

async function handleOAuthRequest() {
    const context = globalThis.$ctx;
    if (!isTamperAppAuthorizationEnabled(context.argument)) {
        return { type: "passThrough" };
    }

    const pathname = commonUtils.normalizePathname(context.url.pathname);
    if (pathname === "oauth/token") {
        return handleTokenOAuthRequest();
    }
    if (pathname === "oauth/device/code" || pathname === "oauth/device/token") {
        return handleDeviceOAuthRequest();
    }
    return { type: "passThrough" };
}

async function handleAuthorizeRequest() {
    const context = globalThis.$ctx;
    if (!isTamperAppAuthorizationEnabled(context.argument)) {
        return { type: "passThrough" };
    }

    const originalUrl = new URL(context.env.request.url);
    const originalClientId = String(originalUrl.searchParams.get("client_id") ?? "").trim();
    if (isAlreadyTamperedAuthorizeUrl(originalUrl) || isOfficialTraktClientId(originalClientId)) {
        return { type: "passThrough" };
    }

    const originalRedirectUri = String(originalUrl.searchParams.get("redirect_uri") ?? "").trim();
    if (!originalRedirectUri || isTamperAppAuthorizationDisabledForRedirectUri(originalRedirectUri)) {
        return { type: "passThrough" };
    }

    const responseType = String(originalUrl.searchParams.get("response_type") ?? "").trim();
    if (responseType !== "code") {
        return { type: "passThrough" };
    }

    let pkce;
    try {
        pkce = pkceUtils.generatePkcePair();
    } catch (error) {
        context.env.log(`Trakt tamper app authorization PKCE generation failed: ${error}`);
        return { type: "passThrough" };
    }

    const originalState = originalUrl.searchParams.get("state") ?? "";
    saveTamperState(context.env, {
        id: pkce.challenge,
        clientId: originalClientId,
        redirectUri: originalRedirectUri,
        originalState,
        codeVerifier: pkce.verifier,
        codeChallenge: pkce.challenge,
    });

    const targetUrl = new URL(TRAKT_TAMPER_AUTHORIZE_URL);
    targetUrl.searchParams.set("response_type", responseType);
    targetUrl.searchParams.set("client_id", TRAKT_TAMPER_CLIENT_ID);
    targetUrl.searchParams.set("redirect_uri", TRAKT_TAMPER_REDIRECT_URI);
    targetUrl.searchParams.set("lang", "zh-hans-cn");
    targetUrl.searchParams.set("code_challenge", pkce.challenge);
    targetUrl.searchParams.set("code_challenge_method", pkce.method);
    targetUrl.searchParams.set("state", pkce.challenge);

    const scopes = new Set(
        String(originalUrl.searchParams.get("scope") ?? "")
            .split(/\s+/)
            .filter(Boolean),
    );
    scopes.add("public");
    scopes.add("offline_access");
    targetUrl.searchParams.set("scope", Array.from(scopes).join(" "));

    ["signup", "prompt"].forEach((key) => {
        const value = originalUrl.searchParams.get(key);
        if (commonUtils.isNonNullish(value) && value !== "") {
            targetUrl.searchParams.set(key, value);
        }
    });

    return {
        type: "rewriteRequest",
        url: targetUrl.toString(),
        headers: copyRequestHeaders(context.env.request.headers),
    };
}

async function handleAuthorizeCallbackResponse() {
    const context = globalThis.$ctx;
    if (!isTamperAppAuthorizationEnabled(context.argument)) {
        return { type: "passThrough" };
    }

    const responseHeaders = commonUtils.ensureObject(context.env.response?.headers);
    const location = getHeaderValue(responseHeaders, "location");
    if (!location || !isTraktAuthCallbackLocation(location)) {
        return { type: "passThrough" };
    }

    const callbackState = String(context.url.searchParams.get("state") ?? "").trim();
    const callbackChallenge = String(context.url.searchParams.get("code_challenge") ?? "").trim();
    const state = findFreshTamperState(context.env, (entry) => {
        if (callbackState && String(entry.id ?? "") === callbackState) {
            return true;
        }
        return !!callbackChallenge && String(entry.codeChallenge ?? "") === callbackChallenge;
    });
    if (!state) {
        return { type: "passThrough" };
    }

    const redirectUri = String(state.redirectUri ?? "").trim();
    if (!redirectUri) {
        return { type: "passThrough" };
    }

    let code = "";
    try {
        code = new URL(location).searchParams.get("code") ?? "";
    } catch {
        code = "";
    }
    if (code) {
        updateTamperState(context.env, (entry) => entry.id === state.id, {
            code,
            callbackAt: Date.now(),
        });
        upsertTamperBinding(context.env, state.clientId);
    }

    const nextLocation = appendCallbackQuery(redirectUri, location, String(state.originalState ?? "").trim());
    const headers = copyHeaders(responseHeaders);
    deleteHeader(headers, "location");
    setHeader(headers, "Location", nextLocation);

    const result = {
        type: "respond",
        status: normalizeCallbackStatus(context.env.response),
        headers,
    };
    if (typeof context.env.response?.body === "string") {
        result.body = context.env.response.body;
    }
    return result;
}

export {
    handleAuthorizeCallbackResponse,
    handleAuthorizeRequest,
    handleOAuthRequest,
    TRAKT_TAMPER_ACCESS_TOKEN_TTL_MS,
    TRAKT_TAMPER_AUTHORIZE_URL,
    TRAKT_TAMPER_BINDING_REDUNDANCY_MS,
    TRAKT_TAMPER_CALLBACK_HOST,
    TRAKT_TAMPER_CALLBACK_PATH,
    TRAKT_TAMPER_CLIENT_ID,
    TRAKT_TAMPER_REDIRECT_URI,
    TRAKT_TAMPER_STATE_RECORD_LIMIT,
};
