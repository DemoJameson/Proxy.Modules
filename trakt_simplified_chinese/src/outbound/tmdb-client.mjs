import * as mediaTypes from "../shared/media-types.mjs";
import * as cacheUtils from "../utils/cache.mjs";
import * as commonUtils from "../utils/common.mjs";
import * as httpUtils from "../utils/http.mjs";
import * as vercelBackendClientModule from "./vercel-backend-client.mjs";

const TMDB_API_BASE_URL = "https://api.tmdb.org/3";
const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p";

// TMDb API key 不写死在脚本里：脚本产物发布在公开仓库，硬编码等于公开。
// key 收敛到后端环境变量，由 /api/trakt/apikeys 下发，轮换时不必等用户重新拉取脚本。
// 取值顺序：单次运行内单例 → $persistentStore 缓存（代理运行时每次请求都是新的脚本上下文）→ 后端下发。
const TMDB_API_KEY_CACHE_KEY = "dj_trakt_tmdb_api_key";
const TMDB_API_KEY_TTL_MS = 24 * 60 * 60 * 1000;
// 同一次运行内重复查询后端的抑制窗口（跨请求不生效：后端一换 key 就要能立刻拿到）。
const TMDB_API_KEY_RETRY_BACKOFF_MS = 60 * 1000;
// 失效 key 拉黑的有效期。必须带过期：401/403 若来自瞬时故障（上游抖动、中间设备拦截），
// 永久拉黑会让后端下发的正确 key 再也用不上，等于该设备的海报能力彻底坏掉。
// 窗口内不拿去撞 TMDb，窗口后允许再试一次自愈；真实轮换场景不受影响（新 key 本来就不在黑名单里）。
const TMDB_API_KEY_BLACKLIST_TTL_MS = 10 * 60 * 1000;

// httpUtils.fetchJson 的错误形如 "HTTP 401 for <url>"，用于识别 key 失效并触发一次自愈重取。
const TMDB_HTTP_ERROR_STATUS_PATTERN = /^HTTP (\d{3})\b/;
const TMDB_AUTH_FAILURE_STATUS_CODES = new Set([401, 403]);

function readApiKeyCacheEntry() {
    if (cacheUtils.isLocalCacheDisabled()) {
        return null;
    }
    const cached = globalThis.$ctx?.env?.getjson?.(TMDB_API_KEY_CACHE_KEY, null);
    return commonUtils.isPlainObject(cached) ? cached : null;
}

function writeApiKeyCacheEntry(entry) {
    if (cacheUtils.isLocalCacheDisabled()) {
        return;
    }
    try {
        globalThis.$ctx?.env?.setjson?.(entry, TMDB_API_KEY_CACHE_KEY);
    } catch (error) {
        globalThis.$ctx?.env?.log?.(`Trakt TMDb api key cache save failed: ${error}`);
    }
}

// 被 TMDb 判定无效的 key：记在缓存条目里，避免"后端还没轮换完"期间每个请求都先撞一次 401。
// 只在拉黑有效期内生效，过期后同一把 key 允许再试一次（应对把瞬时 401 误判成 key 失效）。
function isBlacklistedApiKey(cached, apiKey) {
    const normalized = String(apiKey ?? "").trim();
    const blacklisted = String(cached?.invalidApiKey ?? "").trim();
    const invalidUntil = Number(cached?.invalidUntil);
    if (!normalized || !blacklisted || normalized !== blacklisted) {
        return false;
    }
    return Number.isFinite(invalidUntil) && invalidUntil > Date.now();
}

function isApiKeyBlacklisted(apiKey) {
    return isBlacklistedApiKey(readApiKeyCacheEntry(), apiKey);
}

// 过期或被拉黑的 key 都视为未命中：前者让后端轮换的 key 在 TTL 内自然收敛，后者避免复用已知失效的 key。
function readCachedApiKey() {
    const cached = readApiKeyCacheEntry();
    if (!cached) {
        return "";
    }
    const apiKey = String(cached.apiKey ?? "").trim();
    const expiresAt = Number(cached.expiresAt);
    if (!apiKey || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        return "";
    }
    return isBlacklistedApiKey(cached, apiKey) ? "" : apiKey;
}

function writeCachedApiKey(apiKey) {
    writeApiKeyCacheEntry({ apiKey, expiresAt: Date.now() + TMDB_API_KEY_TTL_MS, invalidApiKey: "", invalidUntil: 0 });
}

// key 被判失效（TMDb 401/403）：清掉缓存里的 key 并限时拉黑这个坏 key。
// 关键点是必须落到 $persistentStore —— 代理运行时每次请求都是新的脚本上下文，只清运行期状态的话，
// 下一个请求会从缓存里读回同一个坏 key，再白撞一次 401，要等 24h TTL 才恢复。
function blacklistApiKey(apiKey) {
    writeApiKeyCacheEntry({
        apiKey: "",
        expiresAt: 0,
        invalidApiKey: String(apiKey ?? "").trim(),
        invalidUntil: Date.now() + TMDB_API_KEY_BLACKLIST_TTL_MS,
    });
}

async function fetchApiKeyFromBackend() {
    const payload = await vercelBackendClientModule.fetchApiKeys();
    const apiKey = String(payload?.keys?.tmdb ?? "").trim();
    if (!apiKey) {
        throw new Error(`No TMDb api key in ${vercelBackendClientModule.resolveBackendBaseUrl()}/api/trakt/apikeys response`);
    }
    return apiKey;
}

// 取 key 的单例：并发调用共享同一次请求；失败退避，避免后端不可用时每个请求都重试。
const tmdbAuth = {
    _key: "",
    _inflight: null,
    _retryAfter: 0,
    // invalidate() 后为 true：本次运行内跳过持久化缓存直接问后端（清缓存失败时的兜底）。
    _skipCache: false,
    async ensureKey() {
        if (this._key) {
            return this._key;
        }
        if (this._inflight) {
            return this._inflight;
        }
        if (!this._skipCache) {
            const cached = readCachedApiKey();
            if (cached) {
                this._key = cached;
                return cached;
            }
        }
        // 同一次运行内的抑制窗口：并发已被 _inflight 合并，这里挡的是串行的重复查询
        if (Date.now() < this._retryAfter) {
            return "";
        }
        this._inflight = fetchApiKeyFromBackend()
            .then((apiKey) => {
                // 后端下发的还是已被 TMDb 判无效的 key：不缓存、也不拿去撞 TMDb，
                // 只压一下本次运行内的重复查询；跨请求仍会再问后端，后端一换 key 就立刻生效。
                if (isApiKeyBlacklisted(apiKey)) {
                    this._retryAfter = Date.now() + TMDB_API_KEY_RETRY_BACKOFF_MS;
                    globalThis.$ctx?.env?.log?.("Trakt TMDb api key from backend is still the blacklisted one");
                    return "";
                }
                this._key = apiKey;
                this._skipCache = false;
                writeCachedApiKey(apiKey);
                return apiKey;
            })
            .catch((error) => {
                this._retryAfter = Date.now() + TMDB_API_KEY_RETRY_BACKOFF_MS;
                globalThis.$ctx?.env?.log?.(`Trakt TMDb api key fetch failed: ${error}`);
                return "";
            })
            .finally(() => {
                this._inflight = null;
            });
        return this._inflight;
    },
    // key 被判失效（TMDb 401/403）：拉黑这个 key、清掉运行期缓存并允许立刻重取。
    // 拉黑要落到 $persistentStore，否则下一个请求会从缓存里读回同一个坏 key 再撞一次 401。
    invalidate(apiKey) {
        this._key = "";
        this._retryAfter = 0;
        this._skipCache = true;
        blacklistApiKey(apiKey);
    },
};

// 拿不到 key（后端不可用 / 未配置 / 远端缓存被禁用）时向上抛错：
// 调用方各自的 try/catch 会打日志并跳过 TMDb，从而不会把"取不到 key"写成负缓存。
async function requireApiKey() {
    const apiKey = await tmdbAuth.ensureKey();
    if (!apiKey) {
        throw new Error(`TMDb api key is unavailable from ${vercelBackendClientModule.resolveBackendBaseUrl()}/api/trakt/apikeys`);
    }
    return apiKey;
}

function getErrorMessageStatus(error) {
    return Number((TMDB_HTTP_ERROR_STATUS_PATTERN.exec(String(error?.message ?? "")) ?? [])[1]);
}

// 所有 TMDb 请求统一走这里：拼 URL 时注入 key，遇到鉴权失败立刻找后端换 key 再试一次。
async function fetchTmdbJson(buildUrl) {
    const requestWithKey = (apiKey) => httpUtils.fetchJson(buildUrl(apiKey), null, false);
    const apiKey = await requireApiKey();
    try {
        return await requestWithKey(apiKey);
    } catch (error) {
        if (!TMDB_AUTH_FAILURE_STATUS_CODES.has(getErrorMessageStatus(error))) {
            throw error;
        }
        // key 失效：拉黑这个 key（落到持久化缓存）并立刻向后端要新 key，不等 24h TTL 到期。
        tmdbAuth.invalidate(apiKey);
        const nextApiKey = await tmdbAuth.ensureKey();
        // 后端还没轮换出新 key（拿不到，或仍是同一个）：直接降级，不再白撞一次 TMDb。
        if (!nextApiKey || nextApiKey === apiKey) {
            throw error;
        }
        try {
            return await requestWithKey(nextApiKey);
        } catch (retryError) {
            // 后端换了 key 但新 key 同样无效：一并拉黑，下一个请求不再拿它撞 TMDb。
            if (TMDB_AUTH_FAILURE_STATUS_CODES.has(getErrorMessageStatus(retryError))) {
                tmdbAuth.invalidate(nextApiKey);
            }
            throw retryError;
        }
    }
}

async function hasApiKey() {
    return !!(await tmdbAuth.ensureKey());
}

async function fetchCredits(mediaType, tmdbId) {
    if (commonUtils.isNullish(tmdbId)) {
        return null;
    }

    const normalizedMediaType = mediaType === mediaTypes.MEDIA_TYPE.MOVIE ? "movie" : "tv";
    const appendField = mediaType === mediaTypes.MEDIA_TYPE.MOVIE ? "credits" : "aggregate_credits";
    return fetchTmdbJson((apiKey) => `${TMDB_API_BASE_URL}/${normalizedMediaType}/${tmdbId}?language=zh-CN&append_to_response=${appendField}&api_key=${apiKey}`);
}

async function fetchPerson(tmdbPersonId) {
    if (commonUtils.isNullish(tmdbPersonId)) {
        return null;
    }

    return fetchTmdbJson((apiKey) => `${TMDB_API_BASE_URL}/person/${tmdbPersonId}?language=zh-CN&api_key=${apiKey}`);
}

function normalizeImageLanguage(language) {
    const languages = String(language ?? "")
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter((item, index, array) => /^[a-z]{2}$/.test(item) && array.indexOf(item) === index);
    return languages.length > 0 ? languages.join(",") : "zh";
}

function normalizeDetailMediaType(mediaType) {
    if (mediaType === mediaTypes.MEDIA_TYPE.MOVIE) {
        return "movie";
    }
    if (mediaType === mediaTypes.MEDIA_TYPE.SHOW) {
        return "tv";
    }
    return "";
}

async function fetchDetails(mediaType, tmdbId) {
    if (commonUtils.isNullish(tmdbId)) {
        return null;
    }

    const normalizedMediaType = normalizeDetailMediaType(mediaType);
    if (!normalizedMediaType) {
        return null;
    }

    return fetchTmdbJson((apiKey) => `${TMDB_API_BASE_URL}/${normalizedMediaType}/${tmdbId}?api_key=${apiKey}`);
}

async function fetchDetailsWithImages(mediaType, tmdbId) {
    if (commonUtils.isNullish(tmdbId)) {
        return null;
    }

    const normalizedMediaType = normalizeDetailMediaType(mediaType);
    if (!normalizedMediaType) {
        return null;
    }

    // 不带 language 参数：附加的 images 为全量，交由客户端按偏好语言本地过滤。
    return fetchTmdbJson((apiKey) => `${TMDB_API_BASE_URL}/${normalizedMediaType}/${tmdbId}?append_to_response=images&api_key=${apiKey}`);
}

function extractTmdbImagesPayload(detailPayload) {
    const images = commonUtils.isPlainObject(detailPayload?.images) ? detailPayload.images : {};
    return {
        posters: commonUtils.ensureArray(images.posters),
        logos: commonUtils.ensureArray(images.logos),
    };
}

async function fetchImages(mediaType, tmdbId, language = "zh") {
    if (commonUtils.isNullish(tmdbId)) {
        return null;
    }

    const normalizedMediaType = normalizeDetailMediaType(mediaType);
    if (!normalizedMediaType) {
        return null;
    }

    return fetchTmdbJson(
        (apiKey) => `${TMDB_API_BASE_URL}/${normalizedMediaType}/${tmdbId}/images?language=${encodeURIComponent(normalizeImageLanguage(language))}&api_key=${apiKey}`,
    );
}

async function fetchSeasonImages(showTmdbId, seasonNumber, language = "zh") {
    if (commonUtils.isNullish(showTmdbId) || commonUtils.isNullish(seasonNumber)) {
        return null;
    }

    return fetchTmdbJson(
        (apiKey) => `${TMDB_API_BASE_URL}/tv/${showTmdbId}/season/${seasonNumber}/images?language=${encodeURIComponent(normalizeImageLanguage(language))}&api_key=${apiKey}`,
    );
}

function buildImageUrl(filePath, size = "w780") {
    const normalizedPath = String(filePath ?? "").trim();
    if (!normalizedPath) {
        return "";
    }

    return `${TMDB_IMAGE_BASE_URL}/${size}${normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`}`;
}

function resizeImageUrl(url, size = "original") {
    const normalizedUrl = String(url ?? "").trim();
    if (!normalizedUrl) {
        return "";
    }

    return normalizedUrl.includes("/t/p/original/") ? normalizedUrl.replace("/t/p/original/", `/t/p/${size}/`) : "";
}

function buildPosterImageUrl(filePath, size = "w780") {
    return buildImageUrl(filePath, size);
}

export {
    buildImageUrl,
    buildPosterImageUrl,
    extractTmdbImagesPayload,
    fetchCredits,
    fetchDetails,
    fetchDetailsWithImages,
    fetchImages,
    fetchPerson,
    fetchSeasonImages,
    hasApiKey,
    resizeImageUrl,
    TMDB_API_KEY_CACHE_KEY,
};
