import * as traktApiClientModule from "../outbound/trakt-api-client.mjs";
import * as vercelBackendClientModule from "../outbound/vercel-backend-client.mjs";
import * as cacheUtils from "../utils/cache.mjs";
import * as commonUtils from "../utils/common.mjs";
import * as httpUtils from "../utils/http.mjs";

import * as mediaTypes from "./media-types.mjs";
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
const BACKEND_FETCH_MIN_REFS = 3;
const BACKEND_WRITE_BATCH_SIZE = 50;
const TRANSLATION_OVERRIDES_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

const TRANSLATION_NOT_FOUND_TTL_MS = 1 * 24 * 60 * 60 * 1000;
const BULK_API_MAX_IDS_PER_CATEGORY = 100;
const BULK_API_MIN_REFS = 10;
const BULK_API_COUNTRIES = ["cn", "sg", "tw", "hk"];

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

function buildMediaCacheKey(mediaType, ref) {
    const lookupKey = buildMediaCacheLookupKey(mediaType, ref);
    return lookupKey ? `${mediaType}:${lookupKey}` : "";
}

function storeTranslationEntry(cache, mediaType, ref, entry) {
    const cacheKey = buildMediaCacheKey(mediaType, ref);
    if (!cacheKey) {
        return null;
    }
    const translation = translationCache.normalizeTranslationPayload(entry?.translation ?? null);
    const status = translationCache.normalizeTranslationStatus(entry?.status);
    const complete = entry?.complete === true;
    const storedEntry =
        (status === translationCache.CACHE_STATUS.FOUND || status === translationCache.CACHE_STATUS.PARTIAL_FOUND) && translation
            ? buildTranslationCacheEntry(status, translation, complete)
            : buildTranslationCacheEntry(translationCache.CACHE_STATUS.NOT_FOUND, translation, complete);
    if (storedEntry.status === translationCache.CACHE_STATUS.NOT_FOUND) {
        storedEntry.expiresAt = Date.now() + TRANSLATION_NOT_FOUND_TTL_MS;
    }
    cache[cacheKey] = storedEntry;
    return cache[cacheKey];
}

function getCachedTranslation(cache, mediaType, ref) {
    const cacheKey = buildMediaCacheKey(mediaType, ref);
    if (!cacheKey) {
        return null;
    }
    const entry = cache[cacheKey];
    if (entry?.status === translationCache.CACHE_STATUS.NOT_FOUND) {
        const expiresAt = Number(entry.expiresAt);
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
            return null;
        }
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

function extractBackendWritePayload(backendState, maxBatchSize) {
    const payload = {};
    const batchSize = Number(maxBatchSize) > 0 ? Number(maxBatchSize) : backendState.backendWriteBatchSize;
    let count = 0;

    Object.keys(backendState.mediaConfig).forEach((mediaType) => {
        payload[getMediaBackendField(mediaType)] = {};
    });

    for (const mediaType of Object.keys(backendState.mediaConfig)) {
        const entries = commonUtils.ensureObject(backendState.pendingBackendWrites[mediaType]);
        for (const lookupKey of Object.keys(entries)) {
            if (count >= batchSize) {
                return payload;
            }
            payload[getMediaBackendField(mediaType)][lookupKey] = entries[lookupKey];
            delete backendState.pendingBackendWrites[mediaType][lookupKey];
            count += 1;
        }
    }

    return payload;
}

function flushBackendWriteBatch(backendState, maxBatchSize) {
    if (!vercelBackendClientModule.resolveBackendBaseUrl() || getPendingBackendWriteCount(backendState) === 0) {
        return false;
    }

    vercelBackendClientModule.postTranslations(extractBackendWritePayload(backendState, maxBatchSize)).catch(() => {});
    return true;
}

function queueBackendWrite(backendState, mediaType, ref, entry) {
    const lookupKey = buildMediaCacheLookupKey(mediaType, ref);
    if (!lookupKey) {
        return;
    }
    backendState.pendingBackendWrites[mediaType][lookupKey] = entry;
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
            return translationCache.extractNormalizedTranslation(translationCache.normalizeTranslations(responseJson));
        });
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
            queueBackendWrite(vercelBackendClient, mediaType, ref, completeEntry);
        } catch (error) {
            globalThis.$ctx.env.log(`Trakt translation fetch failed for key=${buildMediaCacheLookupKey(mediaType, ref)}: ${error}`);
        }
    });
    return cacheChanged;
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
    queueBackendWrite(backendState, mediaType, detailRef, mergedEntry);
    return true;
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

function pickBestBulkTitle(titlesByRegion) {
    if (!commonUtils.isPlainObject(titlesByRegion)) {
        return null;
    }
    for (const region of BULK_API_COUNTRIES) {
        const title = titlesByRegion[region];
        if (translationCache.containsChineseText(title)) {
            return translationCache.normalizeTranslationFieldValue("title", title);
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
                    const bestTitle = pickBestBulkTitle(titlesByRegion);
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
                    if (storeTranslationEntry(cache, mediaType, ref, entry)) {
                        cacheChanged = true;
                    }
                    queueBackendWrite(backendState, mediaType, ref, entry);
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
    mergeDetailTranslationEntries,
    normalizeTranslationOverridesPayload,
    PREFERRED_TRANSLATION_LANGUAGE,
    parseEpisodeLookupKey,
    parseSeasonLookupKey,
    pickBestBulkTitle,
    processInBatches,
    queueBackendWrite,
    REQUEST_BATCH_SIZE,
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
