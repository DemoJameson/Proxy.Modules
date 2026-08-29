import * as traktApiClientModule from "../outbound/trakt-api-client.mjs";
import * as cacheUtils from "../utils/cache.mjs";
import * as commonUtils from "../utils/common.mjs";

import {
    applyImages,
    buildImageCacheKey,
    createImageBackendState,
    fetchAndPersistMissingImages,
    flushImageBackendWrites,
    getApplicableImageFields,
    getFetchImageFields,
    getImageCacheEntry,
    getPosterImageMode,
    hydrateAndFetchImages,
    isPosterImageReplacementUserAgent,
    replaceImagesInPlace,
    replaceSeasonImagesInPlace,
    shouldReplaceImages,
    shouldSkipCurrentOriginalImages,
} from "./media-image-replacement.mjs";
import {
    BACKEND_FETCH_MIN_REFS,
    BACKEND_WRITE_BATCH_SIZE,
    buildEpisodeCompositeKey,
    buildMediaCacheLookupKey,
    buildSeasonCompositeKey,
    createBackendState,
    createMediaCollection,
    ensureDetailTranslation,
    fetchAndPersistMissing,
    fetchBulkTranslationsForMissing,
    fetchDirectTranslation,
    flushBackendWrites,
    getCachedTranslation,
    getMissingRefs,
    getOverrideGroupName,
    hydrateFromBackend,
    isDetailTranslationIncomplete,
    isScriptInitiatedTranslationRequest,
    loadTranslationOverrides,
    MEDIA_CONFIG,
    PREFERRED_TRANSLATION_LANGUAGE,
    queueBackendWrite,
    SEASON_EPISODE_TRANSLATION_LIMIT,
    storeTranslationEntry,
    TRAKT_DIRECT_TRANSLATION_MAX_REFS,
} from "./media-translation-backend.mjs";
import * as mediaTypes from "./media-types.mjs";
import * as translationCache from "./translation-cache.mjs";

const DIRECT_MEDIA_TYPE_SHOW_STATUSES = ["returning series", "ended", "canceled"];

const DIRECT_MEDIA_TYPE_MOVIE_STATUSES = ["released", "post production", "in production"];

const DIRECT_MEDIA_ORIGINAL_KEY = "__directOriginal";

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
        const normalizedValue = translationCache.normalizeTranslationText(translationOverrides[field]);
        if (!translationCache.isEmptyTranslationValue(normalizedValue)) {
            target[field] = normalizedValue;
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

function applyOverrideToTranslations(items, override) {
    if (!override) {
        return items;
    }

    const cnTranslation = translationCache.pickCnTranslation(items);
    if (!cnTranslation) {
        return items;
    }

    applyOverrideToTarget(cnTranslation, override);
    return translationCache.normalizeTranslations(items);
}

function fetchMediaDetail(mediaType, traktId) {
    return traktApiClientModule.fetchMediaDetail(mediaType, traktId);
}

function fetchEpisodeDetail(ref) {
    return traktApiClientModule.fetchEpisodeDetail(ref);
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
        episodeTraktId: episode?.ids?.trakt ?? null,
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
        tmdbId: target?.ids?.tmdb ?? null,
        imageMode: getPosterImageMode(),
        language: target?.language ?? null,
        country: target?.country ?? null,
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

function collectImageTargets(items, mediaConfig) {
    const seen = {};
    const targets = [];
    items.forEach((item) => {
        Object.keys(mediaConfig).forEach((mediaType) => {
            const target = getItemMediaTarget(item, mediaType);
            const ref = buildMediaRef(item, mediaType);
            const fields = getFetchImageFields(target, mediaType, ref);
            const key = buildImageCacheKey(mediaType, ref);
            if (key && fields.length > 0 && !seen[key]) {
                seen[key] = true;
                targets.push({ mediaType, ref, fields });
            }
        });
    });
    return targets;
}

async function filterReplaceableImageTargets(targets) {
    const skippedKeys = {};
    const filteredTargets = [];
    for (const target of targets) {
        const key = buildImageCacheKey(target.mediaType, target.ref);
        if (await shouldSkipCurrentOriginalImages(target.mediaType, target.ref)) {
            if (key) {
                skippedKeys[key] = true;
            }
            continue;
        }
        filteredTargets.push(target);
    }
    return { skippedKeys, targets: filteredTargets };
}

function applyImagesToItems(items, cache, mediaConfig, skippedKeys = {}) {
    items.forEach((item) => {
        Object.keys(mediaConfig).forEach((mediaType) => {
            const target = getItemMediaTarget(item, mediaType);
            const ref = buildMediaRef(item, mediaType);
            const fields = getApplicableImageFields(target, mediaType, ref);
            const key = buildImageCacheKey(mediaType, ref);
            if (fields.length > 0 && !skippedKeys[key]) {
                applyImages(target, getImageCacheEntry(cache, mediaType, ref), fields);
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

function wrapDirectMediaItems(arr, _mediaConfig) {
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

async function translateMediaItemsInPlace(items, bodyOverride) {
    void bodyOverride;
    if (commonUtils.isNotArray(items) || items.length === 0) {
        return items;
    }

    const context = globalThis.$ctx;
    const backendState = createBackendState(MEDIA_CONFIG);

    const cache = cacheUtils.loadCache(context.env);
    const refsByType = collectMediaRefs(items, MEDIA_CONFIG);
    const shouldReplaceMediaImages = shouldReplaceImages();
    const imageCache = shouldReplaceMediaImages ? cacheUtils.loadImageCache(context.env) : {};
    const imageBackendState = shouldReplaceMediaImages ? createImageBackendState() : null;
    let skippedImageKeys = {};
    const imageTargets = shouldReplaceMediaImages ? collectImageTargets(items, MEDIA_CONFIG) : [];
    const imageReplacementPromise = shouldReplaceMediaImages
        ? (async () => {
              const { skippedKeys, targets } = await filterReplaceableImageTargets(imageTargets);
              skippedImageKeys = skippedKeys;
              return hydrateAndFetchImages(imageCache, targets, imageBackendState);
          })().catch((error) => {
              context.env.log(`Trakt image replacement failed: ${error}`);
              return false;
          })
        : Promise.resolve(false);

    let cacheChanged = await hydrateFromBackend(cache, refsByType, MEDIA_CONFIG, backendState);

    const bulkResult = await fetchBulkTranslationsForMissing(cache, refsByType, backendState);
    cacheChanged = bulkResult.cacheChanged || cacheChanged;

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

    if (await imageReplacementPromise) {
        cacheUtils.saveImageCache(context.env, imageCache);
    }
    if (imageBackendState) {
        flushImageBackendWrites(imageBackendState);
    }

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
    if (shouldReplaceMediaImages) {
        applyImagesToItems(items, imageCache, MEDIA_CONFIG, skippedImageKeys);
    }
    return items;
}

async function translateWrapperItems(bodyOverride) {
    const sourceBody = commonUtils.isNonNullish(bodyOverride) ? bodyOverride : globalThis.$ctx.responseBody;
    const parsed = commonUtils.parseJsonBody(sourceBody);
    if (commonUtils.isNotArray(parsed) || parsed.length === 0) {
        return { type: "respond", body: sourceBody };
    }
    await translateMediaItemsInPlace(parsed, sourceBody);
    return { type: "respond", body: JSON.stringify(parsed) };
}

export {
    applyOverrideToTarget,
    applyOverrideToTranslations,
    applyTranslation,
    BACKEND_FETCH_MIN_REFS,
    BACKEND_WRITE_BATCH_SIZE,
    buildEpisodeCompositeKey,
    buildMediaCacheLookupKey,
    buildSeasonCompositeKey,
    createBackendState,
    ensureDetailTranslation,
    fetchAndPersistMissing,
    fetchAndPersistMissingImages,
    fetchBulkTranslationsForMissing,
    fetchDirectTranslation,
    fetchEpisodeDetail,
    fetchMediaDetail,
    flushBackendWrites,
    getCachedTranslation,
    getMissingRefs,
    getOverrideForTarget,
    getOverrideFromTable,
    hydrateFromBackend,
    isDetailTranslationIncomplete,
    isPosterImageReplacementUserAgent,
    isScriptInitiatedTranslationRequest,
    loadTranslationOverrides,
    MEDIA_CONFIG,
    PREFERRED_TRANSLATION_LANGUAGE,
    queueBackendWrite,
    replaceImagesInPlace,
    replaceSeasonImagesInPlace,
    resolveMediaDetailTarget,
    resolveSeasonListTarget,
    resolveTranslationRequestTarget,
    SEASON_EPISODE_TRANSLATION_LIMIT,
    shouldReplaceImages,
    storeTranslationEntry,
    TRAKT_DIRECT_TRANSLATION_MAX_REFS,
    translateMediaItemsInPlace,
    translateWrapperItems,
    unwrapDirectMediaItems,
    wrapDirectMediaItems,
};
