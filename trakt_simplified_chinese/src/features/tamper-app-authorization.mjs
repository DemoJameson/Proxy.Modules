import * as chineseLocale from "../shared/chinese-script-converter.mjs";
import { TRAKT_TAMPER_CLIENT_ID, TRAKT_TAMPER_EXEMPT_CLIENT_IDS } from "../shared/tamper-app-constants.mjs";
import * as cacheUtils from "../utils/cache.mjs";

// Trakt 授权页语言按地区
const TAMPER_AUTHORIZE_LANG_BY_LOCALE = {
    cn: "zh-hans-cn",
    tw: "zh-hant-tw",
    hk: "zh-hant-hk",
};

import * as commonUtils from "../utils/common.mjs";
import * as pkceUtils from "../utils/pkce.mjs";

const TRAKT_TAMPER_REDIRECT_URI = "trakt://auth";
const TRAKT_TAMPER_AUTHORIZE_URL = "https://auth.trakt.tv/oauth/authorize";
const TRAKT_TAMPER_CALLBACK_HOST = "auth.trakt.tv";
const TRAKT_TAMPER_CALLBACK_PATH = "/api/auth/oauth2/authorize";
const TRAKT_TAMPER_STATE_TTL_MS = 5 * 60 * 1000;
// 条数上限由缓存层统一定义，保证归一化与写入用的是同一个上限
const TRAKT_TAMPER_STATE_RECORD_LIMIT = cacheUtils.TAMPER_AUTHORIZATION_RECORD_LIMIT;
// 授权流程状态、篡改签发的 token 与待回写标记落在独立持久化 key 里，不随 unified cache 版本升级被清空
// Trakt access_token 的 expires_in 为 604800 秒（7 天），响应缺省时按它兜底
const TRAKT_TAMPER_ACCESS_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TRAKT_TAMPER_TOKEN_RECORD_LIMIT = cacheUtils.TAMPER_AUTHORIZATION_TOKEN_LIMIT;
// Trakt device_code 的 expires_in 为 600 秒，标记按同样时长保留，避免轮询期间反复写缓存
const TRAKT_TAMPER_DEVICE_FLOW_TTL_MS = 10 * 60 * 1000;
// 需要与 token 响应关联的 pending 类型
const TRAKT_TAMPER_TOKEN_PENDING_KINDS = new Set(["authorization_code", "refresh_token", "device_code"]);
const TRAKT_TAMPER_DEFAULT_CALLBACK_STATUS = 302;

// 这些 App 用自定义 scheme 回调并依赖自己的 client 校验授权，篡改会让它们直接失效
const TRAKT_TAMPER_DISABLED_REDIRECT_SCHEMES = ["rex://", "forward://", "reflix://"];

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

function getBearerAccessToken(headers) {
    const match = /^Bearer\s+(\S+)/i.exec(String(getHeaderValue(headers, "authorization") ?? "").trim());
    return match ? match[1] : "";
}

// token 响应阶段可能因平台拿不到请求体而漏记；只要该 client 还有刚发起的篡改授权记录，
// 就用请求里的 Bearer access token 补一条 token 记录，避免存量授权一直无法改写 trakt-api-key
function backfillTamperTokenFromFlowState(context, accessToken) {
    const clientId = String(getHeaderValue(context.env.request.headers, "trakt-api-key") ?? "").trim();
    if (!clientId || isOfficialTraktClientId(clientId)) {
        return false;
    }
    const state = findFreshTamperState(context.env, (entry) => String(entry.clientId ?? "").trim() === clientId);
    if (!state) {
        return false;
    }
    saveTamperToken(context.env, { accessToken, clientId });
    return true;
}

// 非认证流程（如 sync/history）只要带的 Bearer access token 命中篡改流程签发的 token 记录，就换成篡改应用的 client_id
function shouldRewriteTraktApiKey(context) {
    if (!isTamperAppAuthorizationEnabled(context?.argument)) {
        return false;
    }
    if (!/^apiz?\.trakt\.tv$/i.test(String(context?.url?.hostname ?? "").toLowerCase())) {
        return false;
    }
    const pathname = commonUtils.normalizePathname(context.url.pathname);
    if (pathname.startsWith("oauth/")) {
        return false;
    }

    const accessToken = getBearerAccessToken(context.env.request.headers);
    if (!accessToken) {
        return false;
    }
    if (findTamperTokenByAccessToken(context.env, accessToken)) {
        return true;
    }
    return backfillTamperTokenFromFlowState(context, accessToken);
}

// 这里只改写 trakt-api-key、不动请求体，必须原样保留 content-length 等长度头：
// QX 只对 body 相关重写自动处理长度/编码头，header-only 重写会原样使用返回的头，
// 去掉 content-length 会让带 body 的 POST 变成没有请求体
function buildTraktApiHeaders(sourceHeaders) {
    const headers = copyHeaders(sourceHeaders);
    setHeader(headers, "trakt-api-key", TRAKT_TAMPER_CLIENT_ID);
    return headers;
}

// 与既有路由结果合并：路由已改写 URL/body 时只补 trakt-api-key，避免覆盖它们的 header 处理
function applyTraktApiKeyRewrite(result) {
    const context = globalThis.$ctx;
    if (!shouldRewriteTraktApiKey(context)) {
        return result;
    }

    const tamperHeaders = buildTraktApiHeaders(context.env.request.headers);
    if (result?.type === "rewriteRequest") {
        const headers = { ...tamperHeaders, ...commonUtils.ensureObject(result.headers) };
        setHeader(headers, "trakt-api-key", TRAKT_TAMPER_CLIENT_ID);
        return { ...result, headers };
    }
    if (!result || result.type === "passThrough") {
        return { type: "rewriteRequest", url: context.env.request.url, headers: tamperHeaders };
    }
    return result;
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

// QX 的请求脚本与响应脚本共享 sessionIndex，用它可以把响应精确关联回发起它的那次请求
function getSessionIndex(env) {
    const candidates = [env?.request?.sessionIndex, env?.response?.sessionIndex];
    for (const candidate of candidates) {
        const normalized = String(candidate ?? "").trim();
        if (normalized) {
            return normalized;
        }
    }
    return "";
}

function isTamperStateFresh(state) {
    const createdAt = Number(state?.createdAt);
    return Number.isFinite(createdAt) && Date.now() - createdAt <= TRAKT_TAMPER_STATE_TTL_MS;
}

// pending 支持独立 expiresAt：device_code 需要覆盖 Trakt 的 expires_in，其余 pending 仍按流程 TTL 兜底
function isTamperPendingFresh(pending) {
    const expiresAt = Number(pending?.expiresAt);
    if (Number.isFinite(expiresAt)) {
        return expiresAt > Date.now();
    }
    return isTamperStateFresh(pending);
}

function normalizeTamperStore(value) {
    const source = commonUtils.ensureObject(value);
    return {
        records: commonUtils.ensureArray(source.records).filter((record) => commonUtils.isPlainObject(record)),
        tokens: commonUtils.ensureArray(source.tokens).filter((record) => commonUtils.isPlainObject(record)),
        pending: commonUtils.ensureArray(source.pending).filter((record) => commonUtils.isPlainObject(record)),
    };
}

function loadTamperStore(env) {
    try {
        // 授权状态属于鉴权关键数据，与 authTokens 一样不受 debugMode 的本地缓存禁用影响
        const store = cacheUtils.loadTamperAuthorization(env);
        const normalized = normalizeTamperStore(store);
        return {
            records: normalized.records.filter((record) => isTamperStateFresh(record)),
            tokens: normalized.tokens.filter((record) => String(record.accessToken ?? "").trim()),
            pending: normalized.pending.filter((record) => isTamperPendingFresh(record)),
        };
    } catch (error) {
        env.log(`Trakt tamper app authorization state load failed: ${error}`);
        return { records: [], tokens: [], pending: [] };
    }
}

function pruneTamperRecords(records) {
    return records
        .filter((record) => commonUtils.isPlainObject(record) && isTamperStateFresh(record))
        .sort((left, right) => Number(right.createdAt) - Number(left.createdAt))
        .slice(0, TRAKT_TAMPER_STATE_RECORD_LIMIT);
}

// access_token 过期不代表 refresh_token 失效，因此只有「无 refresh_token 且 access_token 已过期」的记录才优先淘汰
function isTamperTokenDead(record) {
    const hasRefreshToken = String(record?.refreshToken ?? "").trim() !== "";
    const expiresAt = Number(record?.expiresAt);
    return !hasRefreshToken && Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function pruneTamperTokens(tokens) {
    return tokens
        .filter((record) => commonUtils.isPlainObject(record) && String(record.accessToken ?? "").trim())
        .sort((left, right) => {
            const leftDead = isTamperTokenDead(left) ? 1 : 0;
            const rightDead = isTamperTokenDead(right) ? 1 : 0;
            if (leftDead !== rightDead) {
                return leftDead - rightDead;
            }
            return Number(right.createdAt) - Number(left.createdAt);
        })
        .slice(0, TRAKT_TAMPER_TOKEN_RECORD_LIMIT);
}

function pruneTamperPending(pending) {
    return pending
        .filter((record) => commonUtils.isPlainObject(record) && isTamperPendingFresh(record))
        .sort((left, right) => Number(right.createdAt) - Number(left.createdAt))
        .slice(0, TRAKT_TAMPER_STATE_RECORD_LIMIT);
}

function saveTamperStore(env, store) {
    try {
        const nextStore = {
            records: pruneTamperRecords(commonUtils.ensureArray(store?.records)),
            tokens: pruneTamperTokens(commonUtils.ensureArray(store?.tokens)),
            pending: pruneTamperPending(commonUtils.ensureArray(store?.pending)),
        };
        cacheUtils.saveTamperAuthorization(env, nextStore);
    } catch (error) {
        env.log(`Trakt tamper app authorization state save failed: ${error}`);
    }
}

function updateTamperStore(env, updater) {
    const store = loadTamperStore(env);
    const nextStore = updater(store) ?? store;
    saveTamperStore(env, nextStore);
    return nextStore;
}

function saveTamperState(env, state) {
    const next = { ...state, createdAt: Date.now() };
    const id = String(next.id ?? "").trim();
    updateTamperStore(env, (store) => {
        const records = store.records.slice();
        const index = id ? records.findIndex((record) => String(record?.id ?? "").trim() === id) : -1;
        if (index >= 0) {
            records[index] = { ...records[index], ...next };
        } else {
            records.push(next);
        }
        return { ...store, records };
    });
}

function updateTamperState(env, predicate, updates) {
    let updated = false;
    updateTamperStore(env, (store) => {
        const records = store.records.slice();
        const index = records.findIndex((record) => isTamperStateFresh(record) && predicate(record));
        if (index < 0) {
            return store;
        }
        records[index] = { ...records[index], ...updates };
        updated = true;
        return { ...store, records };
    });
    return updated;
}

function findTamperState(env, predicate) {
    return loadTamperStore(env).records.find(predicate) ?? null;
}

function findFreshTamperState(env, predicate) {
    return findTamperState(env, (state) => isTamperStateFresh(state) && predicate(state));
}

function findTamperToken(env, predicate) {
    return loadTamperStore(env).tokens.find(predicate) ?? null;
}

function findTamperTokenByAccessToken(env, accessToken) {
    // 与 bulk 出站请求共用缓存层实现，避免两处 token 命中逻辑漂移
    return cacheUtils.getTamperTokenByAccessToken(env, accessToken);
}

function findTamperTokenByRefreshToken(env, refreshToken) {
    const normalized = String(refreshToken ?? "").trim();
    if (!normalized) {
        return null;
    }
    return findTamperToken(env, (record) => String(record.refreshToken ?? "").trim() === normalized);
}

function saveTamperToken(env, { accessToken, refreshToken, clientId, expiresAt, previousRefreshToken }) {
    const normalizedAccessToken = String(accessToken ?? "").trim();
    if (!normalizedAccessToken) {
        return;
    }
    const normalizedRefreshToken = String(refreshToken ?? "").trim();
    const normalizedPreviousRefreshToken = String(previousRefreshToken ?? "").trim();
    updateTamperStore(env, (store) => {
        const tokens = store.tokens.filter((record) => {
            if (normalizedPreviousRefreshToken && String(record.refreshToken ?? "").trim() === normalizedPreviousRefreshToken) {
                return false;
            }
            return String(record.accessToken ?? "").trim() !== normalizedAccessToken;
        });
        const normalizedClientId = String(clientId ?? "").trim();
        tokens.push({
            accessToken: normalizedAccessToken,
            refreshToken: normalizedRefreshToken,
            clientId: normalizedClientId,
            expiresAt: Number.isFinite(Number(expiresAt)) ? Number(expiresAt) : Date.now() + TRAKT_TAMPER_ACCESS_TOKEN_TTL_MS,
            createdAt: Date.now(),
        });
        return { ...store, tokens };
    });
}

function saveTamperPending(env, pending) {
    const kind = String(pending?.kind ?? "").trim();
    const id = String(pending?.id ?? "").trim();
    if (!kind || !id) {
        return;
    }
    const expiresAt = Number(pending?.expiresAt);
    const sessionIndex = getSessionIndex(env);
    const next = {
        ...pending,
        kind,
        id,
        createdAt: Date.now(),
        expiresAt: Number.isFinite(expiresAt) && expiresAt > Date.now() ? expiresAt : Date.now() + TRAKT_TAMPER_STATE_TTL_MS,
        ...(sessionIndex ? { sessionIndex } : {}),
    };
    updateTamperStore(env, (store) => {
        const pendingList = store.pending.filter((entry) => !(String(entry.kind ?? "").trim() === kind && String(entry.id ?? "").trim() === id));
        pendingList.push(next);
        return { ...store, pending: pendingList };
    });
}

function findTamperPending(env, predicate) {
    return loadTamperStore(env).pending.find(predicate) ?? null;
}

function removeTamperPending(env, predicate) {
    updateTamperStore(env, (store) => ({ ...store, pending: store.pending.filter((entry) => !predicate(entry)) }));
}

// QX 的请求头脚本拿不到请求体，只能靠「该 client 已经由篡改流程签发过 token」或「存在进行中的授权流程」判断
function hasTamperTokenForClient(env, clientId) {
    const normalizedClientId = String(clientId ?? "").trim();
    if (!normalizedClientId) {
        return false;
    }
    return !!findTamperToken(env, (record) => String(record.clientId ?? "").trim() === normalizedClientId);
}

function isOfficialTraktClientId(clientId) {
    return String(clientId ?? "").trim() === TRAKT_TAMPER_CLIENT_ID;
}

// 这些 client 的授权不计入 Trakt 授权数量限制，篡改没有收益，直接放行
function isTamperAppAuthorizationExemptClientId(clientId) {
    const normalizedClientId = String(clientId ?? "").trim();
    return !!normalizedClientId && TRAKT_TAMPER_EXEMPT_CLIENT_IDS.includes(normalizedClientId);
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
    if (isOfficialTraktClientId(originalClientId) || isTamperAppAuthorizationExemptClientId(originalClientId)) {
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

    // device/code 只标记一次流程，device_code 由响应阶段从响应体里取；device/token 轮询不再写缓存
    if (pathname === "oauth/device/code") {
        saveTamperPending(context.env, {
            kind: "device_flow",
            id: "device-flow",
            clientId: originalClientId,
            expiresAt: Date.now() + TRAKT_TAMPER_DEVICE_FLOW_TTL_MS,
        });
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
    const refreshToken = String(bodyPayload?.refresh_token ?? context.url.searchParams.get("refresh_token") ?? "").trim();
    const grantType = String(bodyPayload?.grant_type ?? context.url.searchParams.get("grant_type") ?? "")
        .trim()
        .toLowerCase();
    const originalRedirectUri = String(bodyPayload?.redirect_uri ?? context.url.searchParams.get("redirect_uri") ?? "").trim();
    const originalClientId = String(
        bodyPayload?.client_id ?? context.url.searchParams.get("client_id") ?? getHeaderValue(context.env.request.headers, "trakt-api-key") ?? "",
    ).trim();

    if (
        isTamperAppAuthorizationDisabledForRedirectUri(originalRedirectUri) ||
        isOfficialTraktClientId(originalClientId) ||
        isTamperAppAuthorizationExemptClientId(originalClientId)
    ) {
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
        saveTamperPending(context.env, {
            kind: "authorization_code",
            id: code,
            clientId: originalClientId || state.clientId,
        });
    } else {
        // refresh 只按 refresh_token 命中：token 记录里存有篡改流程签发的 refresh_token
        if (!refreshToken || !findTamperTokenByRefreshToken(context.env, refreshToken)) {
            context.env.log("Trakt tamper app authorization token rewrite skipped: no matching refresh token");
            return { type: "passThrough" };
        }
        saveTamperPending(context.env, {
            kind: "refresh_token",
            id: refreshToken,
            clientId: originalClientId,
        });
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
    // QX 的 script-request-body 只能返回 body，trakt-api-key 需要并行的 script-request-header 规则补写；
    // 那次调用拿不到请求体，只回 url/headers，绝不回 body，避免把真实请求体覆盖成残缺内容
    if (context.env.request.body === undefined || context.env.request.body === null) {
        return handleOAuthHeaderOnlyRequest(pathname);
    }
    if (pathname === "oauth/token") {
        return handleTokenOAuthRequest();
    }
    if (pathname === "oauth/device/code" || pathname === "oauth/device/token") {
        return handleDeviceOAuthRequest();
    }
    return { type: "passThrough" };
}

function handleOAuthHeaderOnlyRequest(pathname) {
    const context = globalThis.$ctx;
    const originalClientId = String(context.url.searchParams.get("client_id") ?? getHeaderValue(context.env.request.headers, "trakt-api-key") ?? "").trim();
    // 识别不出第三方 client（或本来就是官方 client、豁免 client）时不补写，避免把无关请求改坏
    if (!originalClientId || isOfficialTraktClientId(originalClientId) || isTamperAppAuthorizationExemptClientId(originalClientId)) {
        return { type: "passThrough" };
    }
    if (isTamperAppAuthorizationDisabledForRedirectUri(context.url.searchParams.get("redirect_uri"))) {
        return { type: "passThrough" };
    }
    // oauth/token 的 redirect_uri 一般只在 body 里，header 阶段判断不了它是否属于禁用篡改的应用；
    // 只有确认这是篡改流程（刚发起的授权流程，或该 client 已由篡改流程签发过 token）才补写
    if (pathname === "oauth/token") {
        const hasFlowState = !!findFreshTamperState(context.env, (entry) => String(entry.clientId ?? "").trim() === originalClientId);
        if (!hasFlowState && !hasTamperTokenForClient(context.env, originalClientId)) {
            return { type: "passThrough" };
        }
    }
    // QX 的 script-request-body 会丢弃返回的 url，把参数放在 query 里的 App 只能在这次调用里改写
    const url = rewriteUrlSearchParams(context.env.request.url, (searchParams) => {
        if (searchParams.has("client_id")) {
            searchParams.set("client_id", TRAKT_TAMPER_CLIENT_ID);
        }
        if (searchParams.has("client_secret")) {
            searchParams.delete("client_secret");
        }
        if (searchParams.has("redirect_uri")) {
            searchParams.set("redirect_uri", TRAKT_TAMPER_REDIRECT_URI);
        }
    });
    return {
        type: "rewriteRequest",
        url,
        headers: buildTamperHeaders(context.env.request.headers, null),
    };
}

async function handleAuthorizeRequest() {
    const context = globalThis.$ctx;
    if (!isTamperAppAuthorizationEnabled(context.argument)) {
        return { type: "passThrough" };
    }

    const originalUrl = new URL(context.env.request.url);
    const originalClientId = String(originalUrl.searchParams.get("client_id") ?? "").trim();
    if (isAlreadyTamperedAuthorizeUrl(originalUrl) || isOfficialTraktClientId(originalClientId) || isTamperAppAuthorizationExemptClientId(originalClientId)) {
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
    targetUrl.searchParams.set("lang", TAMPER_AUTHORIZE_LANG_BY_LOCALE[chineseLocale.resolveChineseLocale()] ?? "zh-hans-cn");
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

// 响应阶段能拿到的 client 线索：query 里的 client_id 与请求头 trakt-api-key（QX 的响应脚本拿不到 $request.body）
function getRequestClientId(context) {
    const queryClientId = String(context.url.searchParams.get("client_id") ?? "").trim();
    if (queryClientId) {
        return queryClientId;
    }
    return String(getHeaderValue(context.env.request?.headers, "trakt-api-key") ?? "").trim();
}

// 兜底匹配只认与请求路径对应的 pending 类型：device_code 只对应 device/token，authorization_code / refresh_token 只对应 token
function getTamperResponsePendingKinds(pathname) {
    if (pathname === "oauth/device/token") {
        return ["device_code"];
    }
    if (pathname === "oauth/token") {
        return ["authorization_code", "refresh_token"];
    }
    return [];
}

// 拿不到 sessionIndex 与请求体时的兜底：优先按「路径对应的 pending 类型」与「client 一致」匹配，
// 否则会把别的 App（禁用篡改的 rex/forward、官方 App、未拦截授权的 App）的 token 响应误记成篡改流程签发的 token；
// 请求阶段改写后，平台给响应脚本的 client 线索可能已经是官方 client id，此时原始 client 不可知，只能退回唯一候选
function findTamperFallbackPending(pendings, { pathname, clientId }) {
    const kinds = getTamperResponsePendingKinds(pathname);
    if (kinds.length === 0) {
        return null;
    }
    const candidates = pendings.filter((entry) => kinds.includes(String(entry.kind ?? "").trim()));
    if (candidates.length === 0) {
        return null;
    }
    const normalizedClientId = String(clientId ?? "").trim();
    if (normalizedClientId && !isOfficialTraktClientId(normalizedClientId)) {
        const sameClient = candidates.filter((entry) => String(entry.clientId ?? "").trim() === normalizedClientId);
        return sameClient.length === 1 ? sameClient[0] : null;
    }
    return candidates.length === 1 ? candidates[0] : null;
}

function parseTamperResponsePayload(body) {
    try {
        const parsed = JSON.parse(String(body ?? ""));
        return commonUtils.isPlainObject(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

// 响应阶段：device/code 写入 device_code pending；token 响应把篡改流程签发的 access/refresh token 明文写进 token 记录
function handleOAuthResponse() {
    const context = globalThis.$ctx;
    if (!isTamperAppAuthorizationEnabled(context.argument)) {
        return { type: "passThrough" };
    }

    const responsePayload = parseTamperResponsePayload(context.env.response?.body);
    const deviceCode = String(responsePayload?.device_code ?? "").trim();
    if (deviceCode) {
        // device/code 的响应优先按 sessionIndex 关联回它自己的请求，避免并发授权时串号
        const sessionIndex = getSessionIndex(context.env);
        const flow =
            (sessionIndex
                ? findTamperPending(context.env, (entry) => String(entry.kind ?? "").trim() === "device_flow" && String(entry.sessionIndex ?? "").trim() === sessionIndex)
                : null) ?? findTamperPending(context.env, (entry) => String(entry.kind ?? "").trim() === "device_flow");
        if (!flow) {
            return { type: "passThrough" };
        }
        const deviceExpiresIn = Number(responsePayload.expires_in);
        saveTamperPending(context.env, {
            kind: "device_code",
            id: deviceCode,
            clientId: flow.clientId,
            expiresAt: Date.now() + (Number.isFinite(deviceExpiresIn) && deviceExpiresIn > 0 ? deviceExpiresIn * 1000 : TRAKT_TAMPER_DEVICE_FLOW_TTL_MS),
        });
        removeTamperPending(context.env, (entry) => String(entry.kind ?? "").trim() === "device_flow");
        return { type: "passThrough" };
    }

    const tokenPendings = loadTamperStore(context.env).pending.filter((entry) => TRAKT_TAMPER_TOKEN_PENDING_KINDS.has(String(entry.kind ?? "").trim()));
    const accessToken = String(responsePayload?.access_token ?? "").trim();
    if (!accessToken) {
        const errorCode = String(responsePayload?.error ?? "").trim();
        if (errorCode && tokenPendings.length > 0) {
            context.env.log(`Trakt tamper app authorization token exchange failed: ${errorCode}`);
        }
        return { type: "passThrough" };
    }

    const requestPayload = readStructuredBodyPayload(context.env.request.body, context.env.request.headers);
    const code = String(requestPayload?.code ?? context.url.searchParams.get("code") ?? "").trim();
    const refreshToken = String(requestPayload?.refresh_token ?? context.url.searchParams.get("refresh_token") ?? "").trim();

    // QX 的请求/响应脚本共享 sessionIndex，优先按它精确命中；Loon/Surge 没有 sessionIndex 时仍按请求体匹配
    const sessionIndex = getSessionIndex(context.env);
    const sessionPending = sessionIndex ? tokenPendings.find((entry) => String(entry.sessionIndex ?? "").trim() === sessionIndex) : null;
    const bodyPending = tokenPendings.find((entry) => {
        const kind = String(entry.kind ?? "").trim();
        const id = String(entry.id ?? "").trim();
        if (refreshToken && kind === "refresh_token" && id === refreshToken) {
            return true;
        }
        return !!code && (kind === "authorization_code" || kind === "device_code") && id === code;
    });
    const exactPending = sessionPending ?? bodyPending;
    // 既没有 sessionIndex 也拿不到 $request.body 的平台（QX）：按「路径对应的 pending 类型 + client」兜底匹配
    const fallbackPending = exactPending
        ? null
        : findTamperFallbackPending(tokenPendings, {
              pathname: commonUtils.normalizePathname(context.url.pathname),
              clientId: getRequestClientId(context),
          });
    const pending = exactPending ?? fallbackPending;
    if (!pending) {
        if (tokenPendings.length > 0) {
            context.env.log("Trakt tamper app authorization response skipped: pending exists but does not match the token response");
        }
        return { type: "passThrough" };
    }
    if (!exactPending) {
        context.env.log("Trakt tamper app authorization response matched a fresh pending by request path and client without the request body");
    }

    const pendingKind = String(pending.kind ?? "").trim();
    const previousRefreshToken = pendingKind === "refresh_token" ? String(pending.id ?? "").trim() : refreshToken;
    const expiresIn = Number(responsePayload.expires_in);
    const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : Date.now() + TRAKT_TAMPER_ACCESS_TOKEN_TTL_MS;
    saveTamperToken(context.env, {
        accessToken,
        refreshToken: String(responsePayload.refresh_token ?? "").trim() || previousRefreshToken,
        clientId: pending.clientId,
        expiresAt,
        previousRefreshToken,
    });
    removeTamperPending(context.env, (entry) => entry.kind === pending.kind && entry.id === pending.id);

    return { type: "passThrough" };
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
    applyTraktApiKeyRewrite,
    handleAuthorizeCallbackResponse,
    handleAuthorizeRequest,
    handleOAuthRequest,
    handleOAuthResponse,
    TRAKT_TAMPER_ACCESS_TOKEN_TTL_MS,
    TRAKT_TAMPER_AUTHORIZE_URL,
    TRAKT_TAMPER_CALLBACK_HOST,
    TRAKT_TAMPER_CALLBACK_PATH,
    TRAKT_TAMPER_CLIENT_ID,
    TRAKT_TAMPER_EXEMPT_CLIENT_IDS,
    TRAKT_TAMPER_REDIRECT_URI,
    TRAKT_TAMPER_STATE_RECORD_LIMIT,
    TRAKT_TAMPER_TOKEN_RECORD_LIMIT,
};
