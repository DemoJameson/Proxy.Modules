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
};

const REQUEST_BATCH_SIZE = 10;
const SEASON_EPISODE_TRANSLATION_LIMIT = 10;
const TRAKT_DIRECT_TRANSLATION_MAX_REFS = 200;
const PREFERRED_TRANSLATION_LANGUAGE = "zh-CN";
const BACKEND_FETCH_MIN_REFS = 3;
const BACKEND_WRITE_BATCH_SIZE = 50;
const TRANSLATION_OVERRIDES_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TRANSLATION_OVERRIDES_REFRESH_INTERVAL_MS_DEBUG = 0;

const DIRECT_MEDIA_TYPE_SHOW_STATUSES = ["returning series", "ended", "canceled"];

const DIRECT_MEDIA_TYPE_MOVIE_STATUSES = ["released", "post production", "in production"];

const DIRECT_MEDIA_ORIGINAL_KEY = "__directOriginal";
const SCRIPT_TRANSLATION_REQUEST_HEADER = "x-script-trakt-translation-request";
const SCRIPT_TRANSLATION_REQUEST_VALUE = "true";

function buildTranslationCacheEntry(status, translation) {
    return translation ? { status, translation } : { status };
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

    const refreshInterval = globalThis.$ctx.argument?.debugEnabled ? TRANSLATION_OVERRIDES_REFRESH_INTERVAL_MS_DEBUG : TRANSLATION_OVERRIDES_REFRESH_INTERVAL_MS;
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

function buildMediaCacheLookupKey(mediaType, ref) {
    if (!ref || typeof ref !== "object") {
        return "";
    }
    if (mediaType === mediaTypes.MEDIA_TYPE.EPISODE) {
        return buildEpisodeCompositeKey(ref.showId, ref.seasonNumber, ref.episodeNumber);
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
    const status =
        entry?.status === translationCache.CACHE_STATUS.FOUND
            ? translationCache.CACHE_STATUS.FOUND
            : entry?.status === translationCache.CACHE_STATUS.PARTIAL_FOUND
              ? translationCache.CACHE_STATUS.PARTIAL_FOUND
              : translationCache.CACHE_STATUS.NOT_FOUND;
    cache[cacheKey] =
        (status === translationCache.CACHE_STATUS.FOUND || status === translationCache.CACHE_STATUS.PARTIAL_FOUND) && translation
            ? buildTranslationCacheEntry(status, translation)
            : buildTranslationCacheEntry(translationCache.CACHE_STATUS.NOT_FOUND, translation);
    return cache[cacheKey];
}

function getCachedTranslation(cache, mediaType, ref) {
    const cacheKey = buildMediaCacheKey(mediaType, ref);
    return cacheKey ? cache[cacheKey] : null;
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
              backendLookupKey: match[0],
          }
        : null;
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
            const ref = mediaType === mediaTypes.MEDIA_TYPE.EPISODE ? parseEpisodeLookupKey(id) : { traktId: id };
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
            return translationCache.extractNormalizedTranslation(
                translationCache.normalizeTranslations(responseJson, {
                    mediaType,
                    sourceTitle: ref?.sourceTitle,
                }),
            );
        });
}

function applyEpisodePlaceholderTitle(userAgent, target) {
    if (!target) {
        return;
    }
    const episodeNumber = translationCache.extractEpisodePlaceholderNumber(target.title);
    if (commonUtils.isNullish(episodeNumber)) {
        return;
    }

    const generatedTitle = `第${episodeNumber}集`;
    target.title = generatedTitle;
    if (/^Rippple/i.test(userAgent)) {
        target.original_title = generatedTitle;
    }
}

function applyTranslation(userAgent, target, entry, mediaType = null) {
    if (!target) {
        return;
    }
    if (mediaType === mediaTypes.MEDIA_TYPE.EPISODE) {
        applyEpisodePlaceholderTitle(userAgent, target);
    }
    const translation = entry?.translation;
    if (!translation) {
        return;
    }
    if (translation.title) {
        target.title = translation.title;
        if (/^Rippple/i.test(userAgent)) {
            target.original_title = translation.title;
        }
    }
    if (translation.overview) {
        target.overview = translation.overview;
    }
    if (translation.tagline) {
        target.tagline = translation.tagline;
    }
}

function applyOverrideToTranslationObject(target, translationOverrides) {
    if (!target || !translationOverrides) {
        return target;
    }

    translationCache.TRANSLATION_FIELDS.forEach((field) => {
        if (!translationCache.isEmptyTranslationValue(translationOverrides[field])) {
            target[field] = translationOverrides[field];
        }
    });

    return target;
}

function getOverrideFromTable(table, target) {
    if (!target) {
        return null;
    }

    const groupName = getOverrideGroupName(target.mediaType);
    const lookupKey = buildMediaCacheLookupKey(target.mediaType, target);
    if (!groupName || !lookupKey) {
        return null;
    }

    const entries = commonUtils.ensureObject(table?.[groupName]);
    const override = entries[lookupKey];
    return override && typeof override === "object" ? override : null;
}

async function getOverrideForTarget(env, target) {
    return getOverrideFromTable(await loadTranslationOverrides(env), target);
}

function applyOverrideToTarget(target, override) {
    return applyOverrideToTranslationObject(target, commonUtils.ensureObject(override?.translation));
}

function applyOverrideToTranslations(items, override, mediaType) {
    if (!override) {
        return items;
    }

    const cnTranslation = translationCache.pickCnTranslation(items);
    if (!cnTranslation) {
        return items;
    }

    applyOverrideToTarget(cnTranslation, override);
    return translationCache.normalizeTranslations(items, { mediaType });
}

function fetchMediaDetail(mediaType, traktId) {
    return traktApiClientModule.fetchMediaDetail(mediaType, traktId);
}

function resolveTranslationRequestTarget(url) {
    const path = url.shortPathname;
    let match = path.match(/^shows\/(\d+)\/translations\/zh$/);
    if (match) {
        return { mediaType: mediaTypes.MEDIA_TYPE.SHOW, traktId: match[1] };
    }
    match = path.match(/^movies\/(\d+)\/translations\/zh$/);
    if (match) {
        return { mediaType: mediaTypes.MEDIA_TYPE.MOVIE, traktId: match[1] };
    }
    match = path.match(/^shows\/(\d+)\/seasons\/(\d+)\/episodes\/(\d+)\/translations\/zh$/);
    return match
        ? {
              mediaType: mediaTypes.MEDIA_TYPE.EPISODE,
              showId: match[1],
              seasonNumber: match[2],
              episodeNumber: match[3],
          }
        : null;
}

function resolveMediaDetailTarget(url, data, mediaType) {
    if (mediaType === mediaTypes.MEDIA_TYPE.EPISODE) {
        const match = url.shortPathname.match(/^shows\/(\d+)\/seasons\/(\d+)\/episodes\/(\d+)$/);
        return match
            ? {
                  mediaType: mediaTypes.MEDIA_TYPE.EPISODE,
                  showId: match[1],
                  seasonNumber: match[2],
                  episodeNumber: match[3],
              }
            : null;
    }
    return commonUtils.isNonNullish(data?.ids?.trakt) ? { mediaType, traktId: data.ids.trakt } : null;
}

function resolveSeasonListTarget(url) {
    const match = url.shortPathname.match(/^shows\/(\d+)\/seasons$/);
    return match ? { showId: match[1] } : null;
}

function createMediaCollection(mediaConfig) {
    return Object.keys(mediaConfig).reduce((collection, mediaType) => {
        collection[mediaType] = [];
        return collection;
    }, {});
}

function collectUniqueRef(target, seen, ref) {
    const key = ref?.mediaType ? buildMediaCacheLookupKey(ref.mediaType, ref) : "";
    if (key && !seen[key]) {
        seen[key] = true;
        target.push(ref);
    }
}

function getItemMediaTarget(item, mediaType) {
    if (mediaType === mediaTypes.MEDIA_TYPE.EPISODE) {
        return item?.episode ?? item?.progress?.next_episode ?? null;
    }
    return item?.[mediaType] ?? null;
}

function buildEpisodeRef(item, episode) {
    const showId = item?.show?.ids?.trakt ?? null;
    const seasonNumber = episode?.season ?? null;
    const episodeNumber = episode?.number ?? null;
    if (commonUtils.isNullish(showId) || commonUtils.isNullish(seasonNumber) || commonUtils.isNullish(episodeNumber)) {
        return null;
    }
    return {
        mediaType: mediaTypes.MEDIA_TYPE.EPISODE,
        showId,
        seasonNumber,
        episodeNumber,
        backendLookupKey: buildEpisodeCompositeKey(showId, seasonNumber, episodeNumber),
        sourceTitle: episode?.title ?? null,
        availableTranslations: commonUtils.isArray(episode.available_translations) ? episode.available_translations : null,
    };
}

function buildMediaRef(item, mediaType) {
    if (mediaType === mediaTypes.MEDIA_TYPE.EPISODE) {
        return buildEpisodeRef(item, getItemMediaTarget(item, mediaType));
    }
    const target = getItemMediaTarget(item, mediaType);
    const traktId = target?.ids?.trakt ?? null;
    if (commonUtils.isNullish(traktId)) {
        return null;
    }
    return {
        mediaType,
        traktId,
        backendLookupKey: String(traktId),
        availableTranslations: commonUtils.isArray(target.available_translations) ? target.available_translations : null,
    };
}

function collectMediaRefs(arr, mediaConfig) {
    const seenRefsByType = createMediaCollection(mediaConfig);
    const refsByType = createMediaCollection(mediaConfig);
    arr.forEach((item) => {
        Object.keys(mediaConfig).forEach((mediaType) => {
            collectUniqueRef(refsByType[mediaType], seenRefsByType[mediaType], buildMediaRef(item, mediaType));
        });
    });
    return refsByType;
}

function applyTranslationsToItems(arr, cache, mediaConfig, applyTranslationFn) {
    arr.forEach((item) => {
        Object.keys(mediaConfig).forEach((mediaType) => {
            const target = getItemMediaTarget(item, mediaType);
            const ref = buildMediaRef(item, mediaType);
            if (ref) {
                applyTranslationFn(target, getCachedTranslation(cache, mediaType, ref), ref);
            }
        });
    });
}

function resolveDirectMediaTypeFromItem(item) {
    if (!commonUtils.isPlainObject(item) || commonUtils.isNullish(item?.ids?.trakt)) {
        return null;
    }
    if (
        commonUtils.isNonNullish(item.first_aired) ||
        commonUtils.isNonNullish(item.network) ||
        commonUtils.isPlainObject(item.airs) ||
        commonUtils.isNonNullish(item.aired_episodes)
    ) {
        return mediaTypes.MEDIA_TYPE.SHOW;
    }
    if (commonUtils.isNonNullish(item.released)) {
        return mediaTypes.MEDIA_TYPE.MOVIE;
    }
    const normalizedStatus = String(item.status ?? "")
        .trim()
        .toLowerCase();
    if (DIRECT_MEDIA_TYPE_SHOW_STATUSES.includes(normalizedStatus)) {
        return mediaTypes.MEDIA_TYPE.SHOW;
    }
    if (DIRECT_MEDIA_TYPE_MOVIE_STATUSES.includes(normalizedStatus)) {
        return mediaTypes.MEDIA_TYPE.MOVIE;
    }
    return commonUtils.isNonNullish(item.tagline) ? mediaTypes.MEDIA_TYPE.MOVIE : null;
}

function wrapDirectMediaItems(arr, mediaConfig) {
    const wrapped = [];
    for (const item of arr) {
        const type = resolveDirectMediaTypeFromItem(item);
        wrapped.push(type ? { [type]: item } : { [DIRECT_MEDIA_ORIGINAL_KEY]: item });
    }
    return wrapped;
}

function unwrapDirectMediaItems(arr, mediaConfig) {
    return arr.map((item) => {
        for (const mediaType of Object.keys(mediaConfig)) {
            if (item?.[mediaType]) {
                return item[mediaType];
            }
        }
        return item?.[DIRECT_MEDIA_ORIGINAL_KEY] ?? item;
    });
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
            cacheChanged = !!storeTranslationEntry(cache, mediaType, ref, merged) || cacheChanged;
            queueBackendWrite(vercelBackendClient, mediaType, ref, merged);
        } catch (error) {
            globalThis.$ctx.env.log(`Trakt translation fetch failed for key=${buildMediaCacheLookupKey(mediaType, ref)}: ${error}`);
        }
    });
    return cacheChanged;
}

async function translateMediaItemsInPlace(items, bodyOverride) {
    void bodyOverride;
    if (commonUtils.isNotArray(items) || items.length === 0) {
        return items;
    }

    const context = globalThis.$ctx;
    const backendState = createBackendState(MEDIA_CONFIG);

    const cache = cacheUtils.loadCache(context.env);
    const refsByType = collectMediaRefs(items, MEDIA_CONFIG);
    let cacheChanged = await hydrateFromBackend(cache, refsByType, MEDIA_CONFIG, backendState);

    let remainingDirectTranslationBudget = TRAKT_DIRECT_TRANSLATION_MAX_REFS;
    for (const mediaType of Object.keys(MEDIA_CONFIG)) {
        if (remainingDirectTranslationBudget <= 0) {
            break;
        }
        const missingRefs = getMissingRefs(cache, mediaType, refsByType[mediaType]).slice(0, remainingDirectTranslationBudget);
        remainingDirectTranslationBudget -= missingRefs.length;
        cacheChanged = (await fetchAndPersistMissing(cache, mediaType, missingRefs, backendState)) || cacheChanged;
    }

    if (cacheChanged) {
        cacheUtils.saveCache(context.env, cache);
    }
    flushBackendWrites(backendState);
    let overridesTable = null;
    try {
        overridesTable = await loadTranslationOverrides(context.env);
    } catch (error) {
        context.env.log(`Trakt backend override read failed: ${error}`);
    }
    applyTranslationsToItems(items, cache, MEDIA_CONFIG, (target, entry, ref) => {
        applyTranslation(context.userAgent, target, entry, ref.mediaType);
        applyOverrideToTarget(target, getOverrideFromTable(overridesTable, ref));
    });
    return items;
}

async function translateWrapperItems(bodyOverride) {
    const sourceBody = commonUtils.isNonNullish(bodyOverride) ? bodyOverride : globalThis.$ctx.responseBody;
    const parsed = JSON.parse(sourceBody);
    if (commonUtils.isNotArray(parsed) || parsed.length === 0) {
        return { type: "respond", body: sourceBody };
    }
    await translateMediaItemsInPlace(parsed, sourceBody);
    return { type: "respond", body: JSON.stringify(parsed) };
}

export {
    MEDIA_CONFIG,
    PREFERRED_TRANSLATION_LANGUAGE,
    SEASON_EPISODE_TRANSLATION_LIMIT,
    TRAKT_DIRECT_TRANSLATION_MAX_REFS,
    BACKEND_FETCH_MIN_REFS,
    BACKEND_WRITE_BATCH_SIZE,
    applyTranslation,
    applyOverrideToTarget,
    applyOverrideToTranslations,
    buildEpisodeCompositeKey,
    buildMediaCacheLookupKey,
    createBackendState,
    fetchAndPersistMissing,
    fetchMediaDetail,
    flushBackendWrites,
    getCachedTranslation,
    getMissingRefs,
    getOverrideFromTable,
    getOverrideForTarget,
    hydrateFromBackend,
    isScriptInitiatedTranslationRequest,
    loadTranslationOverrides,
    queueBackendWrite,
    resolveMediaDetailTarget,
    resolveSeasonListTarget,
    resolveTranslationRequestTarget,
    storeTranslationEntry,
    translateMediaItemsInPlace,
    translateWrapperItems,
    unwrapDirectMediaItems,
    wrapDirectMediaItems,
};
