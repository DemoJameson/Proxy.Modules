import * as traktApiClientModule from "../outbound/trakt-api-client.mjs";
import * as vercelBackendClientModule from "../outbound/vercel-backend-client.mjs";
import * as cacheUtils from "../utils/cache.mjs";
import * as commonUtils from "../utils/common.mjs";
import * as httpUtils from "../utils/http.mjs";

import * as chineseLocale from "./chinese-script-converter.mjs";
import * as mediaTypes from "./media-types.mjs";
import { TRAKT_TAMPER_CLIENT_ID } from "./tamper-app-constants.mjs";
import * as translationCache from "./translation-cache.mjs";

const MEDIA_CONFIG = {
    [mediaTypes.MEDIA_TYPE.SHOW]: {
        buildTranslationPath(ref) {
            return commonUtils.isNonNullish(ref?.traktId) ? `/shows/${ref.traktId}/translations/zh?extended=all` : "";
        },
    },
    [mediaTypes.MEDIA_TYPE.MOVIE]: {
        buildTranslationPath(ref) {
            return commonUtils.isNonNullish(ref?.traktId) ? `/movies/${ref.traktId}/translations/zh?extended=all` : "";
        },
    },
    [mediaTypes.MEDIA_TYPE.EPISODE]: {
        buildTranslationPath(ref) {
            return ref && commonUtils.isNonNullish(ref.showId) && commonUtils.isNonNullish(ref.seasonNumber) && commonUtils.isNonNullish(ref.episodeNumber)
                ? `/shows/${ref.showId}/seasons/${ref.seasonNumber}/episodes/${ref.episodeNumber}/translations/zh?extended=all`
                : "";
        },
    },
    [mediaTypes.MEDIA_TYPE.SEASON]: {
        buildTranslationPath(ref) {
            return ref && commonUtils.isNonNullish(ref.showId) && commonUtils.isNonNullish(ref.seasonNumber)
                ? `/shows/${ref.showId}/seasons/${ref.seasonNumber}/translations/zh?extended=all`
                : "";
        },
    },
};

const REQUEST_BATCH_SIZE = 10;
const SEASON_EPISODE_TRANSLATION_LIMIT = 200;
const TRAKT_DIRECT_TRANSLATION_MAX_REFS = 200;
const TRAKT_BULK_TRANSLATION_MAX_REFS = 1000;
const PREFERRED_TRANSLATION_LANGUAGE = "zh-CN";
const PREFERRED_TRANSLATION_LANGUAGE_BY_LOCALE = {
    cn: "zh-CN",
    tw: "zh-TW",
    hk: "zh-HK",
};

function resolvePreferredTranslationLanguage(locale = chineseLocale.resolveChineseLocale()) {
    return PREFERRED_TRANSLATION_LANGUAGE_BY_LOCALE[chineseLocale.normalizeChineseLocale(locale)] ?? PREFERRED_TRANSLATION_LANGUAGE;
}
const BACKEND_FETCH_MIN_REFS = 3;
const BACKEND_WRITE_BATCH_SIZE = 50;
const TRANSLATION_OVERRIDES_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

const TRANSLATION_NOT_FOUND_TTL_MS = 1 * 24 * 60 * 60 * 1000;
const BULK_API_MAX_IDS_PER_CATEGORY = 100;
const BULK_API_MIN_REFS = 10;
const BULK_API_COUNTRIES = ["cn", "sg", "tw", "hk"];

// 后端在 tw/hk 目标缺失时回带的 cn 数据：写回时一并合并到 cn 桶
const translationCnHints = {};

function buildBackendHintKey(mediaType, ref) {
    const lookupKey = buildMediaCacheLookupKey(mediaType, ref);
    return lookupKey ? `${mediaType}:${lookupKey}` : "";
}

const SCRIPT_TRANSLATION_REQUEST_HEADER = "x-script-trakt-translation-request";
const SCRIPT_TRANSLATION_REQUEST_VALUE = "true";

function buildTranslationCacheEntry(status, translation, complete = false) {
    const entry = translation ? { status, translation } : { status };
    return complete ? { ...entry, complete: true } : entry;
}

function getOverrideGroupName(mediaType) {
    if (mediaType === mediaTypes.MEDIA_TYPE.MOVIE) {
        return "movies";
    }
    if (mediaType === mediaTypes.MEDIA_TYPE.SHOW) {
        return "shows";
    }
    if (mediaType === mediaTypes.MEDIA_TYPE.EPISODE) {
        return "episodes";
    }
    if (mediaType === mediaTypes.MEDIA_TYPE.SEASON) {
        return "shows";
    }
    return "";
}

function normalizeTranslationOverridesPayload(payload, fetchedAt = Date.now()) {
    return {
        fetchedAt,
        shows: commonUtils.ensureObject(payload?.shows),
        movies: commonUtils.ensureObject(payload?.movies),
        episodes: commonUtils.ensureObject(payload?.episodes),
    };
}

async function loadTranslationOverrides(env) {
    const cached = cacheUtils.loadTranslationOverridesCache(env);
    if (!vercelBackendClientModule.resolveBackendBaseUrl()) {
        return cached;
    }

    const refreshInterval = TRANSLATION_OVERRIDES_REFRESH_INTERVAL_MS;
    if (Date.now() - Number(cached.fetchedAt || 0) < refreshInterval) {
        return cached;
    }

    try {
        const payload = await vercelBackendClientModule.fetchTranslationOverrides();
        const next = normalizeTranslationOverridesPayload(payload);
        cacheUtils.saveTranslationOverridesCache(env, next);
        return next;
    } catch (error) {
        if (cached.fetchedAt > 0) {
            return cached;
        }
        throw error;
    }
}

function buildEpisodeCompositeKey(showId, seasonNumber, episodeNumber) {
    if (commonUtils.isNullish(showId) || commonUtils.isNullish(seasonNumber) || commonUtils.isNullish(episodeNumber)) {
        return "";
    }
    return `${showId}:${seasonNumber}:${episodeNumber}`;
}

function buildSeasonCompositeKey(showId, seasonNumber) {
    if (commonUtils.isNullish(showId) || commonUtils.isNullish(seasonNumber)) {
        return "";
    }
    return `${showId}:${seasonNumber}`;
}

function buildMediaCacheLookupKey(mediaType, ref) {
    if (!ref || typeof ref !== "object") {
        return "";
    }
    if (mediaType === mediaTypes.MEDIA_TYPE.EPISODE) {
        return buildEpisodeCompositeKey(ref.showId, ref.seasonNumber, ref.episodeNumber);
    }
    if (mediaType === mediaTypes.MEDIA_TYPE.SEASON) {
        return buildSeasonCompositeKey(ref.showId, ref.seasonNumber);
    }
    return commonUtils.isNonNullish(ref.traktId) ? String(ref.traktId) : "";
}

const MEDIA_TRANSLATION_GROUP = {
    [mediaTypes.MEDIA_TYPE.MOVIE]: "movies",
    [mediaTypes.MEDIA_TYPE.SHOW]: "shows",
    [mediaTypes.MEDIA_TYPE.EPISODE]: "episodes",
    [mediaTypes.MEDIA_TYPE.SEASON]: "shows",
};

// 本地缓存与 Redis V2 对齐：translation:<group>:<lookupKey>:<locale>
function buildMediaCacheKey(mediaType, ref) {
    const lookupKey = buildMediaCacheLookupKey(mediaType, ref);
    const group = MEDIA_TRANSLATION_GROUP[mediaType] || "";
    return lookupKey && group ? cacheUtils.buildLocaleCacheKey(`translation:${group}:${lookupKey}`) : "";
}

// 相同条目不重复标记缓存变更：status/complete/translation 一致即视为相同。
// 负缓存的 expiresAt 承载 TTL：未过期视为相同；已过期必须重写刷新 TTL，
// 否则会陷入"过期→重取→判同→不保存→再过期"的循环。
function isSameStoredTranslationEntry(current, next) {
    if (!commonUtils.isPlainObject(current)) {
        return false;
    }
    if (current.status !== next.status || (current.complete === true) !== (next.complete === true)) {
        return false;
    }
    if (!translationCache.areTranslationsEqual(current.translation, next.translation)) {
        return false;
    }
    const expiresAt = Number(current.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= Date.now()) {
        return false;
    }
    if (next.status === translationCache.CACHE_STATUS.NOT_FOUND || next.status === translationCache.CACHE_STATUS.PARTIAL_FOUND) {
        return Number.isFinite(expiresAt) && expiresAt > Date.now();
    }
    return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function storeTranslationEntry(cache, mediaType, ref, entry) {
    const cacheKey = buildMediaCacheKey(mediaType, ref);
    if (!cacheKey) {
        return null;
    }
    const translation = translationCache.normalizeTranslationPayload(entry?.translation ?? null, chineseLocale.resolveChineseLocale());
    // normalizeTranslationPayload 保留 null 字段，落盘前剥离空值，与加载期归一化的产出形状保持一致
    const canonicalTranslation = translation ? Object.fromEntries(Object.entries(translation).filter(([, value]) => !translationCache.isEmptyTranslationValue(value))) : null;
    const status = translationCache.normalizeTranslationStatus(entry?.status);
    const complete = entry?.complete === true;
    const storedEntry =
        (status === translationCache.CACHE_STATUS.FOUND || status === translationCache.CACHE_STATUS.PARTIAL_FOUND) && canonicalTranslation
            ? buildTranslationCacheEntry(status, canonicalTranslation, complete)
            : buildTranslationCacheEntry(translationCache.CACHE_STATUS.NOT_FOUND, canonicalTranslation, complete);
    const now = Date.now();
    const providedExpiresAt = Number(entry?.expiresAt);
    storedEntry.expiresAt =
        Number.isFinite(providedExpiresAt) && providedExpiresAt > 0
            ? providedExpiresAt
            : storedEntry.status === translationCache.CACHE_STATUS.NOT_FOUND
              ? now + TRANSLATION_NOT_FOUND_TTL_MS
              : storedEntry.status === translationCache.CACHE_STATUS.PARTIAL_FOUND
                ? now + cacheUtils.TRANSLATION_PARTIAL_FOUND_TTL_MS
                : now + cacheUtils.FOUND_TTL_MS;
    const current = cache[cacheKey];
    if (isSameStoredTranslationEntry(current, storedEntry)) {
        return current;
    }
    cache[cacheKey] = storedEntry;
    return storedEntry;
}

function getCachedTranslation(cache, mediaType, ref) {
    const cacheKey = buildMediaCacheKey(mediaType, ref);
    if (!cacheKey) {
        return null;
    }
    const entry = cache[cacheKey];
    const expiresAt = Number(entry?.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= Date.now()) {
        return null;
    }
    return entry ?? null;
}

function hasZhAvailableTranslation(availableTranslations) {
    return (
        commonUtils.isArray(availableTranslations) &&
        availableTranslations.some((language) => {
            return String(language ?? "").toLowerCase() === "zh";
        })
    );
}

function shouldSkipTranslationLookup(ref) {
    const availableTranslations = commonUtils.ensureArray(ref?.availableTranslations);
    return !!(availableTranslations.length > 0 && !hasZhAvailableTranslation(availableTranslations));
}

function getMissingRefs(cache, mediaType, refs) {
    return refs.filter((ref) => {
        return ref && buildMediaCacheLookupKey(mediaType, ref) && !shouldSkipTranslationLookup(ref) && !getCachedTranslation(cache, mediaType, ref);
    });
}

function createBackendState(mediaConfig) {
    return {
        backendFetchMinRefs: BACKEND_FETCH_MIN_REFS,
        backendWriteBatchSize: BACKEND_WRITE_BATCH_SIZE,
        mediaConfig,
        pendingBackendWrites: Object.keys(mediaConfig).reduce((map, mediaType) => {
            map[mediaType] = {};
            return map;
        }, {}),
        pendingCnWrites: Object.keys(mediaConfig).reduce((map, mediaType) => {
            map[mediaType] = {};
            return map;
        }, {}),
    };
}

function getMediaBackendField(mediaType) {
    return `${mediaType}s`;
}

function compareBackendFieldIds(mediaType, left, right) {
    if (mediaType === mediaTypes.MEDIA_TYPE.EPISODE) {
        const leftEpisode = parseEpisodeLookupKey(left);
        const rightEpisode = parseEpisodeLookupKey(right);
        if (leftEpisode && rightEpisode) {
            const showDiff = Number(leftEpisode.showId) - Number(rightEpisode.showId);
            if (showDiff !== 0) {
                return showDiff;
            }

            const seasonDiff = Number(leftEpisode.seasonNumber) - Number(rightEpisode.seasonNumber);
            if (seasonDiff !== 0) {
                return seasonDiff;
            }

            return Number(leftEpisode.episodeNumber) - Number(rightEpisode.episodeNumber);
        }
    }

    if (mediaType === mediaTypes.MEDIA_TYPE.SEASON) {
        const leftSeason = parseSeasonLookupKey(left);
        const rightSeason = parseSeasonLookupKey(right);
        if (leftSeason && rightSeason) {
            const showDiff = Number(leftSeason.showId) - Number(rightSeason.showId);
            if (showDiff !== 0) {
                return showDiff;
            }
            return Number(leftSeason.seasonNumber) - Number(rightSeason.seasonNumber);
        }
    }

    const leftNumber = Number(left);
    const rightNumber = Number(right);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
        return leftNumber - rightNumber;
    }

    return String(left).localeCompare(String(right));
}

function getBackendFieldIds(mediaType, refs) {
    return refs
        .map((ref) => {
            if (commonUtils.isNonNullish(ref?.backendLookupKey)) {
                return String(ref.backendLookupKey);
            }
            if (commonUtils.isNonNullish(ref?.traktId)) {
                return String(ref.traktId);
            }
            return "";
        })
        .filter(Boolean)
        .sort((left, right) => compareBackendFieldIds(mediaType, left, right));
}

function parseEpisodeLookupKey(value) {
    const match = String(value ?? "").match(/^(\d+):(\d+):(\d+)$/);
    return match
        ? {
              mediaType: mediaTypes.MEDIA_TYPE.EPISODE,
              showId: match[1],
              seasonNumber: match[2],
              episodeNumber: match[3],
          }
        : { traktId: value };
}

function parseSeasonLookupKey(value) {
    const match = String(value ?? "").match(/^(\d+):(\d+)$/);
    return match
        ? {
              mediaType: mediaTypes.MEDIA_TYPE.SEASON,
              showId: match[1],
              seasonNumber: match[2],
          }
        : { traktId: value };
}

async function fetchTranslationsFromBackend(backendState, cache, refsByType) {
    if (!vercelBackendClientModule.resolveBackendBaseUrl()) {
        return false;
    }

    const totalRefs = Object.keys(backendState.mediaConfig).reduce((count, mediaType) => {
        return count + commonUtils.ensureArray(refsByType?.[mediaType]).length;
    }, 0);
    if (totalRefs <= backendState.backendFetchMinRefs) {
        return false;
    }

    const query = [];
    Object.keys(backendState.mediaConfig).forEach((mediaType) => {
        const ids = getBackendFieldIds(mediaType, commonUtils.ensureArray(refsByType?.[mediaType]));
        if (ids.length > 0) {
            query.push(`${getMediaBackendField(mediaType)}=${ids.join(",")}`);
        }
    });
    if (query.length === 0) {
        return false;
    }

    const payload = await vercelBackendClientModule.fetchTranslations(query.join("&"));
    const cnPayload = commonUtils.ensureObject(payload?.cn);
    Object.keys(backendState.mediaConfig).forEach((mediaType) => {
        const cnEntries = commonUtils.ensureObject(cnPayload[getMediaBackendField(mediaType)]);
        Object.keys(cnEntries).forEach((id) => {
            translationCnHints[`${mediaType}:${id}`] = cnEntries[id];
        });
    });
    let cacheChanged = false;
    Object.keys(backendState.mediaConfig).forEach((mediaType) => {
        const entries = commonUtils.ensureObject(payload?.[getMediaBackendField(mediaType)]);
        Object.keys(entries).forEach((id) => {
            let ref;
            if (mediaType === mediaTypes.MEDIA_TYPE.EPISODE) {
                ref = parseEpisodeLookupKey(id);
            } else if (mediaType === mediaTypes.MEDIA_TYPE.SEASON) {
                ref = parseSeasonLookupKey(id);
            } else {
                ref = { traktId: id };
            }
            cacheChanged = !!storeTranslationEntry(cache, mediaType, ref, entries[id]) || cacheChanged;
        });
    });
    return cacheChanged;
}

function getPendingBackendWriteCount(backendState) {
    return Object.keys(backendState.pendingBackendWrites).reduce((count, mediaType) => {
        return count + Object.keys(commonUtils.ensureObject(backendState.pendingBackendWrites[mediaType])).length;
    }, 0);
}

// 只有存在 cn fallback 时才带上 cn 段。
// 批次被截断时也必须先挂载，否则循环里已消费掉的 cn 提示会随 return 一起丢失
function attachCnFoldPayload(payload, cnPayload) {
    if (Object.values(cnPayload).some((entries) => Object.keys(entries).length > 0)) {
        payload.cn = cnPayload;
    }
    return payload;
}

function extractBackendWritePayload(backendState, maxBatchSize) {
    const payload = {};
    const batchSize = Number(maxBatchSize) > 0 ? Number(maxBatchSize) : backendState.backendWriteBatchSize;
    let count = 0;

    Object.keys(backendState.mediaConfig).forEach((mediaType) => {
        payload[getMediaBackendField(mediaType)] = {};
    });

    const cnPayload = {};
    Object.keys(backendState.mediaConfig).forEach((mediaType) => {
        cnPayload[getMediaBackendField(mediaType)] = {};
    });

    for (const mediaType of Object.keys(backendState.mediaConfig)) {
        const entries = commonUtils.ensureObject(backendState.pendingBackendWrites[mediaType]);
        for (const lookupKey of Object.keys(entries)) {
            if (count >= batchSize) {
                return attachCnFoldPayload(payload, cnPayload);
            }
            payload[getMediaBackendField(mediaType)][lookupKey] = entries[lookupKey];
            const cnEntry = commonUtils.ensureObject(backendState.pendingCnWrites[mediaType])[lookupKey];
            if (cnEntry) {
                cnPayload[getMediaBackendField(mediaType)][lookupKey] = cnEntry;
                delete backendState.pendingCnWrites[mediaType][lookupKey];
            }
            delete backendState.pendingBackendWrites[mediaType][lookupKey];
            count += 1;
        }
    }

    return attachCnFoldPayload(payload, cnPayload);
}

function flushBackendWriteBatch(backendState, maxBatchSize) {
    if (!vercelBackendClientModule.resolveBackendBaseUrl() || getPendingBackendWriteCount(backendState) === 0) {
        return false;
    }

    vercelBackendClientModule.postTranslations(extractBackendWritePayload(backendState, maxBatchSize)).catch(() => {});
    return true;
}

function queueBackendWrite(backendState, mediaType, ref, entry, cnEntry) {
    const lookupKey = buildMediaCacheLookupKey(mediaType, ref);
    if (!lookupKey) {
        return;
    }
    backendState.pendingBackendWrites[mediaType][lookupKey] = entry;
    const hintKey = buildBackendHintKey(mediaType, ref);
    const cnData = cnEntry ?? (hintKey ? translationCnHints[hintKey] : null);
    if (cnData) {
        backendState.pendingCnWrites[mediaType][lookupKey] = cnData;
        if (hintKey) {
            delete translationCnHints[hintKey];
        }
    }
    if (getPendingBackendWriteCount(backendState) >= backendState.backendWriteBatchSize) {
        flushBackendWriteBatch(backendState, backendState.backendWriteBatchSize);
    }
}

function flushBackendWrites(backendState) {
    flushBackendWriteBatch(backendState, getPendingBackendWriteCount(backendState));
}

function isScriptInitiatedTranslationRequest() {
    return String(httpUtils.getRequestHeaderValue(SCRIPT_TRANSLATION_REQUEST_HEADER) ?? "").toLowerCase() === SCRIPT_TRANSLATION_REQUEST_VALUE;
}

function fetchDirectTranslation(mediaType, ref) {
    const traktId = commonUtils.isNonNullish(ref?.traktId) ? ref.traktId : null;
    if (!buildMediaCacheLookupKey(mediaType, ref)) {
        throw new Error(`Missing translation lookup metadata for mediaType=${mediaType}, traktId=${traktId}`);
    }

    return traktApiClientModule
        .fetchTranslationPayload(mediaType, ref, {
            [SCRIPT_TRANSLATION_REQUEST_HEADER]: SCRIPT_TRANSLATION_REQUEST_VALUE,
        })
        .then((responseJson) => {
            if (!responseJson) {
                return {
                    status: translationCache.CACHE_STATUS.NOT_FOUND,
                    translation: null,
                };
            }
            const normalizedItems = translationCache.normalizeTranslations(responseJson);
            const locale = chineseLocale.resolveChineseLocale();
            const entry = translationCache.extractNormalizedTranslation(normalizedItems, locale);
            // cn 槽位来自同一次上游响应：tw/hk 请求顺带折叠 cn，保持后端 cn 数据完整
            return { ...entry, cn: translationCache.buildCnFoldEntry(normalizedItems, locale) };
        });
}

function isDetailTranslationIncomplete(entry) {
    if (!entry) {
        return true;
    }
    if (entry.complete === true) {
        return false;
    }
    // 负缓存（NOT_FOUND）也视为不完整：详情页访问时强制重新请求中文翻译，使其有机会自愈
    if (entry.status === translationCache.CACHE_STATUS.NOT_FOUND) {
        return true;
    }
    const translation = entry.translation;
    if (!translation) {
        return false;
    }
    return translationCache.TRANSLATION_FIELDS.some((field) => field !== "title" && translationCache.isEmptyTranslationValue(translation[field]));
}

function mergeDetailTranslationEntries(cachedEntry, directResult) {
    const mergedFields = {};
    translationCache.TRANSLATION_FIELDS.forEach((field) => {
        mergedFields[field] = directResult?.translation?.[field] ?? cachedEntry?.translation?.[field] ?? null;
    });
    const translation = translationCache.normalizeTranslationPayload(mergedFields);
    return {
        status: translationCache.deriveTranslationStatus(translation),
        translation,
        complete: true,
    };
}

// 兼容客户端（非官方 Trakt App）不会自行请求 /translations/zh，详情页在这里按需补全：
// 先读后端缓存，未命中再直查 Trakt，并写回本地与后端缓存
async function ensureDetailTranslation(cache, mediaType, ref, backendState) {
    if (!ref || !buildMediaCacheLookupKey(mediaType, ref) || shouldSkipTranslationLookup(ref)) {
        return false;
    }

    let detailRef;
    if (mediaType === mediaTypes.MEDIA_TYPE.EPISODE) {
        detailRef = { ...ref, backendLookupKey: buildEpisodeCompositeKey(ref.showId, ref.seasonNumber, ref.episodeNumber) };
    } else if (mediaType === mediaTypes.MEDIA_TYPE.SEASON) {
        detailRef = { ...ref, backendLookupKey: buildSeasonCompositeKey(ref.showId, ref.seasonNumber) };
    } else {
        detailRef = ref;
    }
    if (!isDetailTranslationIncomplete(getCachedTranslation(cache, mediaType, detailRef))) {
        return false;
    }

    try {
        const hydrated = await fetchTranslationsFromBackend({ ...backendState, backendFetchMinRefs: 0 }, cache, {
            [mediaType]: [detailRef],
        });
        if (hydrated && !isDetailTranslationIncomplete(getCachedTranslation(cache, mediaType, detailRef))) {
            return true;
        }
    } catch (error) {
        globalThis.$ctx.env.log(`Trakt backend cache read failed: ${error}`);
    }

    const directResult = await fetchDirectTranslation(mediaType, detailRef);
    const mergedEntry = mergeDetailTranslationEntries(getCachedTranslation(cache, mediaType, detailRef), directResult);
    storeTranslationEntry(cache, mediaType, detailRef, mergedEntry);
    // directResult.cn 是 tw/hk 直查时从同一次上游响应派生的 cn 折叠数据
    queueBackendWrite(backendState, mediaType, detailRef, mergedEntry, directResult?.cn ?? null);
    return true;
}

function createMediaCollection(mediaConfig) {
    return Object.keys(mediaConfig).reduce((collection, mediaType) => {
        collection[mediaType] = [];
        return collection;
    }, {});
}

async function processInBatches(items, worker) {
    for (let i = 0; i < items.length; i += REQUEST_BATCH_SIZE) {
        await Promise.all(items.slice(i, i + REQUEST_BATCH_SIZE).map((item) => worker(item)));
    }
}

async function hydrateFromBackend(cache, refsByType, mediaConfig, vercelBackendClient) {
    const context = globalThis.$ctx;
    try {
        const missingRefsByType = createMediaCollection(mediaConfig);
        Object.keys(mediaConfig).forEach((mediaType) => {
            missingRefsByType[mediaType] = getMissingRefs(cache, mediaType, refsByType[mediaType] ?? []);
        });
        return await fetchTranslationsFromBackend(vercelBackendClient, cache, missingRefsByType);
    } catch (error) {
        context.env.log(`Trakt backend cache read failed: ${error}`);
        return false;
    }
}

async function fetchAndPersistMissing(cache, mediaType, refs, vercelBackendClient) {
    let cacheChanged = false;
    await processInBatches(refs, async (ref) => {
        try {
            const merged = await fetchDirectTranslation(mediaType, ref);
            const completeEntry = { ...merged, complete: true };
            cacheChanged = !!storeTranslationEntry(cache, mediaType, ref, completeEntry) || cacheChanged;
            queueBackendWrite(vercelBackendClient, mediaType, ref, completeEntry, merged.cn);
        } catch (error) {
            globalThis.$ctx.env.log(`Trakt translation fetch failed for key=${buildMediaCacheLookupKey(mediaType, ref)}: ${error}`);
        }
    });
    return cacheChanged;
}

function getBulkApiIdForRef(mediaType, ref) {
    if (!ref) {
        return null;
    }
    if (mediaType === mediaTypes.MEDIA_TYPE.EPISODE) {
        return commonUtils.isNonNullish(ref.episodeTraktId) ? String(ref.episodeTraktId) : null;
    }
    return commonUtils.isNonNullish(ref.traktId) ? String(ref.traktId) : null;
}

function chunkArray(arr, size) {
    const chunkSize = Number(size) > 0 ? Number(size) : 1;
    const result = [];
    const source = commonUtils.ensureArray(arr);
    for (let i = 0; i < source.length; i += chunkSize) {
        result.push(source.slice(i, i + chunkSize));
    }
    return result;
}

function mergeBulkResultsByRegion(resultsByRegion) {
    const merged = {};
    const regionMap = commonUtils.ensureObject(resultsByRegion);
    Object.keys(regionMap).forEach((region) => {
        const response = regionMap[region];
        if (!commonUtils.isPlainObject(response)) {
            return;
        }
        Object.keys(mediaTypes.MEDIA_TYPE).forEach((typeKey) => {
            const mediaType = mediaTypes.MEDIA_TYPE[typeKey];
            const entries = commonUtils.ensureObject(response[mediaType]);
            Object.keys(entries).forEach((id) => {
                const title = entries[id]?.title;
                if (commonUtils.isNonNullish(title)) {
                    const entryKey = `${mediaType}:${id}`;
                    if (!commonUtils.isPlainObject(merged[entryKey])) {
                        merged[entryKey] = {};
                    }
                    merged[entryKey][region] = title;
                }
            });
        });
    });
    return merged;
}

function pickBestBulkTitle(titlesByRegion, locale = chineseLocale.resolveChineseLocale()) {
    if (!commonUtils.isPlainObject(titlesByRegion)) {
        return null;
    }
    for (const region of translationCache.getRegionPreference(locale)) {
        const title = titlesByRegion[region];
        if (translationCache.containsChineseText(title)) {
            return translationCache.normalizeTranslationFieldValue("title", title, locale, {
                fromSimplified: chineseLocale.isSimplifiedSourceRegion(region),
            });
        }
    }
    return null;
}

async function fetchBulkTranslationsForMissing(cache, refsByType, backendState) {
    let cacheChanged = false;
    let processedCount = 0;
    try {
        const context = globalThis.$ctx;
        const mediaConfig = backendState?.mediaConfig ?? MEDIA_CONFIG;
        const idToRefByType = {};
        const bulkableByType = {};
        let totalBulkable = 0;

        Object.keys(mediaConfig).forEach((mediaType) => {
            const missingRefs = getMissingRefs(cache, mediaType, commonUtils.ensureArray(refsByType?.[mediaType]));
            const idToRef = {};
            const bulkableRefs = [];
            missingRefs.forEach((ref) => {
                const bulkId = getBulkApiIdForRef(mediaType, ref);
                if (bulkId) {
                    idToRef[bulkId] = ref;
                    bulkableRefs.push(ref);
                }
            });
            idToRefByType[mediaType] = idToRef;
            bulkableByType[mediaType] = bulkableRefs;
            totalBulkable += bulkableRefs.length;
        });

        if (totalBulkable === 0 || totalBulkable <= BULK_API_MIN_REFS) {
            return { cacheChanged, processedCount };
        }

        // bulk 接口 (/v3/intl/bulk) 需要 OAuth，公开接口的源请求可能不带 Authorization
        // 此时从 authTokens 缓存读取对应 apiKey 的 token；若仍无则回退到 per-item /translations/zh（仅需 api-key）
        const apiKey = String(httpUtils.getRequestHeaderValue("trakt-api-key") ?? "").trim();
        let authorizationHeader = String(httpUtils.getRequestHeaderValue("authorization") ?? "").trim();
        if (!authorizationHeader && apiKey) {
            try {
                authorizationHeader = cacheUtils.getAuthToken(context.env, apiKey);
            } catch (error) {
                context.env.log(`Trakt auth token cache load failed: ${error}`);
            }
        }
        if (!authorizationHeader) {
            context.env.log("Trakt bulk translation skipped: no Authorization header and no cached token");
            return { cacheChanged, processedCount };
        }

        const extraHeaders = {
            [SCRIPT_TRANSLATION_REQUEST_HEADER]: SCRIPT_TRANSLATION_REQUEST_VALUE,
            authorization: authorizationHeader,
        };
        // 篡改流程签发的 token 属于官方 App：bulk 出站请求必须带官方 client id，否则 Trakt 会按 client_id/token 不匹配拒绝
        const bearerToken = /^Bearer\s+(\S+)/i.exec(authorizationHeader)?.[1] ?? "";
        if (bearerToken && cacheUtils.getTamperTokenByAccessToken(context.env, bearerToken)) {
            extraHeaders["trakt-api-key"] = TRAKT_TAMPER_CLIENT_ID;
        }

        let remainingBudget = TRAKT_BULK_TRANSLATION_MAX_REFS;
        const chunksByType = {};
        let maxChunks = 0;

        Object.keys(mediaConfig).forEach((mediaType) => {
            const bulkableRefs = bulkableByType[mediaType];
            if (remainingBudget <= 0 || bulkableRefs.length === 0) {
                chunksByType[mediaType] = [];
                return;
            }
            const budgetForType = Math.min(bulkableRefs.length, remainingBudget);
            remainingBudget -= budgetForType;
            processedCount += budgetForType;
            const ids = bulkableRefs
                .slice(0, budgetForType)
                .map((ref) => getBulkApiIdForRef(mediaType, ref))
                .map((id) => Number(id))
                .sort((a, b) => a - b)
                .map((id) => String(id));
            const chunks = chunkArray(ids, BULK_API_MAX_IDS_PER_CATEGORY);
            chunksByType[mediaType] = chunks;
            if (chunks.length > maxChunks) {
                maxChunks = chunks.length;
            }
        });

        const processChunk = async (chunkIndex) => {
            const idsByType = {};
            const refsInChunkByType = {};
            Object.keys(mediaConfig).forEach((mediaType) => {
                const chunks = chunksByType[mediaType];
                const chunk = chunks[chunkIndex];
                if (!chunk || chunk.length === 0) {
                    return;
                }
                idsByType[mediaType] = chunk;
                refsInChunkByType[mediaType] = chunk.map((id) => idToRefByType[mediaType][id]).filter(Boolean);
            });

            const hasAnyIds = Object.keys(idsByType).some((mediaType) => commonUtils.ensureArray(idsByType[mediaType]).length > 0);
            if (!hasAnyIds) {
                return;
            }

            const resultsByRegion = {};
            await Promise.all(
                BULK_API_COUNTRIES.map(async (country) => {
                    try {
                        const response = await traktApiClientModule.fetchBulkTranslations(idsByType, country, extraHeaders);
                        resultsByRegion[country] = response;
                    } catch (error) {
                        context.env.log(`Trakt bulk translation fetch failed for country=${country}: ${error}`);
                        resultsByRegion[country] = null;
                    }
                }),
            );

            // 任一 region 请求失败（无 token / 5xx / 超时）时，无法确认确实没有中文翻译，
            // 此时不能下 NOT_FOUND 结论，否则会把上游实际有中文的条目误判为 NOT_FOUND 并负缓存。
            // 仅当所有 region 都成功返回且确实无标题时，才负缓存为 NOT_FOUND。
            const anyRegionFailed = BULK_API_COUNTRIES.some((country) => resultsByRegion[country] == null);

            const merged = mergeBulkResultsByRegion(resultsByRegion);
            Object.keys(mediaConfig).forEach((mediaType) => {
                commonUtils.ensureArray(refsInChunkByType[mediaType]).forEach((ref) => {
                    const bulkId = getBulkApiIdForRef(mediaType, ref);
                    if (!bulkId) {
                        return;
                    }
                    const titlesByRegion = merged[`${mediaType}:${bulkId}`];
                    const locale = chineseLocale.resolveChineseLocale();
                    const bestTitle = pickBestBulkTitle(titlesByRegion, locale);
                    const cnTitle = locale === chineseLocale.CHINESE_LOCALE.CN ? null : pickBestBulkTitle(titlesByRegion, chineseLocale.CHINESE_LOCALE.CN);
                    if (!bestTitle) {
                        if (anyRegionFailed) {
                            // 抓取失败：保持 missing，交给逐条 /translations/zh 路径回源，避免误判 NOT_FOUND
                            return;
                        }
                        const entry = { status: translationCache.CACHE_STATUS.NOT_FOUND };
                        if (storeTranslationEntry(cache, mediaType, ref, entry)) {
                            cacheChanged = true;
                        }
                        queueBackendWrite(backendState, mediaType, ref, entry);
                        return;
                    }
                    const entry = {
                        status: translationCache.CACHE_STATUS.PARTIAL_FOUND,
                        translation: { title: bestTitle },
                    };
                    const cnEntry = cnTitle ? { status: translationCache.CACHE_STATUS.PARTIAL_FOUND, translation: { title: cnTitle } } : null;
                    if (storeTranslationEntry(cache, mediaType, ref, entry)) {
                        cacheChanged = true;
                    }
                    queueBackendWrite(backendState, mediaType, ref, entry, cnEntry);
                });
            });
        };

        const chunkIndices = Array.from({ length: maxChunks }, (_, index) => index);
        const BULK_CHUNK_CONCURRENCY = 2;
        for (let startIndex = 0; startIndex < chunkIndices.length; startIndex += BULK_CHUNK_CONCURRENCY) {
            const batch = chunkIndices.slice(startIndex, startIndex + BULK_CHUNK_CONCURRENCY);
            await Promise.all(batch.map((chunkIndex) => processChunk(chunkIndex)));
        }
    } catch (error) {
        globalThis.$ctx.env.log(`Trakt bulk translation fetch failed: ${error}`);
    }
    return { cacheChanged, processedCount };
}

export {
    BACKEND_FETCH_MIN_REFS,
    BACKEND_WRITE_BATCH_SIZE,
    BULK_API_COUNTRIES,
    BULK_API_MAX_IDS_PER_CATEGORY,
    BULK_API_MIN_REFS,
    buildEpisodeCompositeKey,
    buildMediaCacheKey,
    buildMediaCacheLookupKey,
    buildSeasonCompositeKey,
    buildTranslationCacheEntry,
    chunkArray,
    compareBackendFieldIds,
    createBackendState,
    createMediaCollection,
    ensureDetailTranslation,
    extractBackendWritePayload,
    fetchAndPersistMissing,
    fetchBulkTranslationsForMissing,
    fetchDirectTranslation,
    fetchTranslationsFromBackend,
    flushBackendWriteBatch,
    flushBackendWrites,
    getBackendFieldIds,
    getBulkApiIdForRef,
    getCachedTranslation,
    getMediaBackendField,
    getMissingRefs,
    getOverrideGroupName,
    getPendingBackendWriteCount,
    hasZhAvailableTranslation,
    hydrateFromBackend,
    isDetailTranslationIncomplete,
    isScriptInitiatedTranslationRequest,
    loadTranslationOverrides,
    MEDIA_CONFIG,
    mergeBulkResultsByRegion,
    normalizeTranslationOverridesPayload,
    PREFERRED_TRANSLATION_LANGUAGE,
    PREFERRED_TRANSLATION_LANGUAGE_BY_LOCALE,
    parseEpisodeLookupKey,
    parseSeasonLookupKey,
    pickBestBulkTitle,
    processInBatches,
    queueBackendWrite,
    REQUEST_BATCH_SIZE,
    resolvePreferredTranslationLanguage,
    SCRIPT_TRANSLATION_REQUEST_HEADER,
    SCRIPT_TRANSLATION_REQUEST_VALUE,
    SEASON_EPISODE_TRANSLATION_LIMIT,
    shouldSkipTranslationLookup,
    storeTranslationEntry,
    TRAKT_BULK_TRANSLATION_MAX_REFS,
    TRAKT_DIRECT_TRANSLATION_MAX_REFS,
    TRANSLATION_NOT_FOUND_TTL_MS,
    TRANSLATION_OVERRIDES_REFRESH_INTERVAL_MS,
};
