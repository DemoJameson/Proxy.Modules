import * as tmdbClientModule from "../outbound/tmdb-client.mjs";
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
const IMAGE_PARTIAL_FOUND_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const IMAGE_NOT_FOUND_TTL_MS = 5 * 24 * 60 * 60 * 1000;

const DIRECT_MEDIA_TYPE_SHOW_STATUSES = ["returning series", "ended", "canceled"];

const DIRECT_MEDIA_TYPE_MOVIE_STATUSES = ["released", "post production", "in production"];

const DIRECT_MEDIA_ORIGINAL_KEY = "__directOriginal";
const SCRIPT_TRANSLATION_REQUEST_HEADER = "x-script-trakt-translation-request";
const SCRIPT_TRANSLATION_REQUEST_VALUE = "true";
const IMAGE_REGION_PRIORITY = ["cn", "sg", "tw", "hk"];
const IMAGE_FIELD = {
    POSTER: "poster",
    LOGO: "logo",
};
const POSTER_IMAGE_MODE = {
    DEFAULT: "default",
    CHINESE: "chinese",
    ORIGINAL: "original",
};
const IMAGE_BACKEND_CONFIG = {
    [mediaTypes.MEDIA_TYPE.MOVIE]: "movies",
    [mediaTypes.MEDIA_TYPE.SHOW]: "shows",
    season: "seasons",
};
const IMAGE_CACHE_GROUP_CONFIG = {
    [mediaTypes.MEDIA_TYPE.MOVIE]: "movies",
    [mediaTypes.MEDIA_TYPE.SHOW]: "shows",
    season: "seasons",
};
const IMAGE_BACKEND_GROUP_TO_MEDIA_TYPE = {
    movies: mediaTypes.MEDIA_TYPE.MOVIE,
    shows: mediaTypes.MEDIA_TYPE.SHOW,
    seasons: "season",
};
const IMAGE_FIELD_SIZE = {
    [IMAGE_FIELD.POSTER]: "w780",
    [IMAGE_FIELD.LOGO]: "w500",
};

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

function buildImageCacheLookupKey(mediaType, ref) {
    if (mediaType === "season") {
        return commonUtils.isNonNullish(ref?.showId) && commonUtils.isNonNullish(ref?.seasonNumber) ? `${ref.showId}:${ref.seasonNumber}` : "";
    }
    if ((mediaType !== mediaTypes.MEDIA_TYPE.MOVIE && mediaType !== mediaTypes.MEDIA_TYPE.SHOW) || commonUtils.isNullish(ref?.traktId)) {
        return "";
    }
    return String(ref.traktId);
}

function getPosterImageMode() {
    const mode = String(globalThis.$ctx?.argument?.posterImageMode ?? "")
        .trim()
        .toLowerCase();
    return mode === POSTER_IMAGE_MODE.CHINESE || mode === POSTER_IMAGE_MODE.ORIGINAL ? mode : POSTER_IMAGE_MODE.DEFAULT;
}

function isPosterImageReplacementUserAgent(userAgent = globalThis.$ctx?.userAgent) {
    return /^Trakt/i.test(String(userAgent ?? "").trim());
}

function shouldReplaceImages() {
    return getPosterImageMode() !== POSTER_IMAGE_MODE.DEFAULT && isPosterImageReplacementUserAgent();
}

function getImageFetchModes() {
    return shouldReplaceImages() ? [POSTER_IMAGE_MODE.CHINESE, POSTER_IMAGE_MODE.ORIGINAL] : [];
}

function normalizeImageLanguage(language) {
    const normalized = String(language ?? "")
        .trim()
        .toLowerCase()
        .replace(/_/g, "-")
        .split("-")[0];
    return /^[a-z]{2}$/.test(normalized) ? normalized : "";
}

function normalizeImageCountry(country) {
    const normalized = String(country ?? "")
        .trim()
        .toLowerCase();
    return /^[a-z]{2}$/.test(normalized) ? normalized : "";
}

function getTmdbDetailCountry(detail) {
    return normalizeImageCountry(commonUtils.ensureArray(detail?.origin_country)[0]) || normalizeImageCountry(commonUtils.ensureArray(detail?.production_countries)[0]?.iso_3166_1);
}

function buildImageCacheKey(mediaType, ref) {
    const mode = ref?.imageMode ?? getPosterImageMode();
    if (mode !== POSTER_IMAGE_MODE.CHINESE && mode !== POSTER_IMAGE_MODE.ORIGINAL) {
        return "";
    }
    const group = getImageCacheGroup(mediaType);
    const lookupKey = buildImageCacheLookupKey(mediaType, ref);
    if (!group || !lookupKey) {
        return "";
    }
    if (mode === POSTER_IMAGE_MODE.CHINESE) {
        return mediaType === "season" ? `${mediaType}:${group}:${lookupKey}` : `${mediaType}:${lookupKey}`;
    }
    return `${mode}:${group}:${lookupKey}`;
}

function getImageCacheEntry(cache, mediaType, ref) {
    const cacheKey = buildImageCacheKey(mediaType, ref);
    return cacheKey ? cache[cacheKey] : null;
}

function normalizeImageFieldEntry(entry) {
    const url = String(entry?.url ?? "").trim();
    const status =
        entry?.status === translationCache.CACHE_STATUS.FOUND && url
            ? translationCache.CACHE_STATUS.FOUND
            : entry?.status === translationCache.CACHE_STATUS.PARTIAL_FOUND && url
              ? translationCache.CACHE_STATUS.PARTIAL_FOUND
              : translationCache.CACHE_STATUS.NOT_FOUND;
    const expiresAt =
        status === translationCache.CACHE_STATUS.FOUND
            ? null
            : Number.isFinite(Number(entry?.expiresAt))
              ? Number(entry.expiresAt)
              : Date.now() + (status === translationCache.CACHE_STATUS.PARTIAL_FOUND ? IMAGE_PARTIAL_FOUND_TTL_MS : IMAGE_NOT_FOUND_TTL_MS);
    if (status !== translationCache.CACHE_STATUS.FOUND && expiresAt <= Date.now()) {
        return null;
    }
    return status === translationCache.CACHE_STATUS.FOUND || status === translationCache.CACHE_STATUS.PARTIAL_FOUND ? { status, url, expiresAt } : { status, expiresAt };
}

function storeImageCacheEntry(cache, mediaType, ref, entry) {
    const cacheKey = buildImageCacheKey(mediaType, ref);
    if (!cacheKey) {
        return null;
    }

    const current = commonUtils.ensureObject(cache[cacheKey]);
    const next = { ...current };
    [IMAGE_FIELD.POSTER, IMAGE_FIELD.LOGO].forEach((field) => {
        if (commonUtils.isPlainObject(entry?.[field])) {
            const normalizedField = normalizeImageFieldEntry(entry[field]);
            if (normalizedField) {
                next[field] = normalizedField;
            } else {
                delete next[field];
            }
        }
    });
    cache[cacheKey] = next;
    return cache[cacheKey];
}

function getApplicableImageFields(target, mediaType, ref) {
    if (mediaType === "season") {
        return commonUtils.isNonNullish(ref?.showId) &&
            commonUtils.isNonNullish(ref?.showTmdbId) &&
            commonUtils.isNonNullish(ref?.seasonNumber) &&
            commonUtils.isArray(target?.images?.poster) &&
            target.images.poster.length > 0
            ? [IMAGE_FIELD.POSTER]
            : [];
    }

    if ((mediaType !== mediaTypes.MEDIA_TYPE.MOVIE && mediaType !== mediaTypes.MEDIA_TYPE.SHOW) || commonUtils.isNullish(ref?.traktId) || commonUtils.isNullish(ref?.tmdbId)) {
        return [];
    }

    return [IMAGE_FIELD.POSTER, IMAGE_FIELD.LOGO].filter((field) => commonUtils.isArray(target?.images?.[field]) && target.images[field].length > 0);
}

function getFetchImageFields(target, mediaType, ref) {
    if (mediaType === "season") {
        return getApplicableImageFields(target, mediaType, ref);
    }

    return (mediaType === mediaTypes.MEDIA_TYPE.MOVIE || mediaType === mediaTypes.MEDIA_TYPE.SHOW) &&
        commonUtils.isNonNullish(ref?.traktId) &&
        commonUtils.isNonNullish(ref?.tmdbId)
        ? [IMAGE_FIELD.POSTER, IMAGE_FIELD.LOGO]
        : [];
}

function getImageLanguageScore(image, preference) {
    const language = String(image?.iso_639_1 ?? "")
        .trim()
        .toLowerCase();
    return language === preference.language ? 1 : 0;
}

function getImageRegionScore(image, preference) {
    const region = String(image?.iso_3166_1 ?? "")
        .trim()
        .toLowerCase();
    if (preference.mode === POSTER_IMAGE_MODE.ORIGINAL && preference.country) {
        if (region === preference.country) {
            return IMAGE_REGION_PRIORITY.length + 1;
        }
    }
    const index = IMAGE_REGION_PRIORITY.indexOf(region);
    return index >= 0 ? IMAGE_REGION_PRIORITY.length - index : 0;
}

function pickPreferredImage(images, preference) {
    return (
        commonUtils
            .ensureArray(images)
            .filter((image) => getImageLanguageScore(image, preference) > 0 && String(image?.file_path ?? "").trim())
            .sort((left, right) => {
                const languageDiff = getImageLanguageScore(right, preference) - getImageLanguageScore(left, preference);
                if (languageDiff !== 0) {
                    return languageDiff;
                }

                const regionDiff = getImageRegionScore(right, preference) - getImageRegionScore(left, preference);
                if (regionDiff !== 0) {
                    return regionDiff;
                }

                const voteAverageDiff = Number(right?.vote_average ?? 0) - Number(left?.vote_average ?? 0);
                if (voteAverageDiff !== 0) {
                    return voteAverageDiff;
                }

                return Number(right?.vote_count ?? 0) - Number(left?.vote_count ?? 0);
            })[0] ?? null
    );
}

function getPickedImageStatus(image, preference) {
    if (!image) {
        return translationCache.CACHE_STATUS.NOT_FOUND;
    }
    if (preference.mode === POSTER_IMAGE_MODE.ORIGINAL) {
        const region = normalizeImageCountry(image?.iso_3166_1);
        return !preference.country || region === preference.country ? translationCache.CACHE_STATUS.FOUND : translationCache.CACHE_STATUS.PARTIAL_FOUND;
    }
    return getImageRegionScore(image, preference) === IMAGE_REGION_PRIORITY.length ? translationCache.CACHE_STATUS.FOUND : translationCache.CACHE_STATUS.PARTIAL_FOUND;
}

function buildImageFieldEntry(image, preference) {
    const url = tmdbClientModule.buildImageUrl(image?.file_path, "original");
    if (!url) {
        return {
            status: translationCache.CACHE_STATUS.NOT_FOUND,
            expiresAt: Date.now() + IMAGE_NOT_FOUND_TTL_MS,
        };
    }
    const status = getPickedImageStatus(image, preference);
    return {
        status,
        url,
        expiresAt: status === translationCache.CACHE_STATUS.FOUND ? null : Date.now() + IMAGE_PARTIAL_FOUND_TTL_MS,
    };
}

async function resolveImagePreference(mediaType, ref) {
    const mode = ref?.imageMode ?? getPosterImageMode();
    if (mode === POSTER_IMAGE_MODE.CHINESE) {
        return { mode, language: "zh", country: "" };
    }
    if (mode !== POSTER_IMAGE_MODE.ORIGINAL) {
        return null;
    }

    let language = normalizeImageLanguage(ref?.language);
    let country = normalizeImageCountry(ref?.country);
    if (!language || !country) {
        const tmdbId = mediaType === "season" ? ref?.showTmdbId : ref?.tmdbId;
        const detailMediaType = mediaType === "season" ? mediaTypes.MEDIA_TYPE.SHOW : mediaType;
        try {
            const detail = await tmdbClientModule.fetchDetails(detailMediaType, tmdbId);
            language ||= normalizeImageLanguage(detail?.original_language);
            country ||= getTmdbDetailCountry(detail);
        } catch (error) {
            globalThis.$ctx.env.log(`Trakt TMDb image preference detail failed for key=${buildImageCacheKey(mediaType, ref)}: ${error}`);
        }
    }

    return language
        ? {
              mode,
              language,
              country,
          }
        : null;
}

function buildImageEntryFromPayload(payload, mediaType, preference, fields) {
    const requestedFields =
        mediaType === mediaTypes.MEDIA_TYPE.MOVIE || mediaType === mediaTypes.MEDIA_TYPE.SHOW
            ? [IMAGE_FIELD.POSTER, IMAGE_FIELD.LOGO]
            : commonUtils.ensureArray(fields).filter((field) => field === IMAGE_FIELD.POSTER || field === IMAGE_FIELD.LOGO);

    const entry = {};
    if (requestedFields.includes(IMAGE_FIELD.POSTER)) {
        const poster = pickPreferredImage(payload?.posters, preference);
        entry.poster = buildImageFieldEntry(poster, preference);
    }
    if (mediaType !== "season" && requestedFields.includes(IMAGE_FIELD.LOGO)) {
        const logo = pickPreferredImage(payload?.logos, preference);
        entry.logo = buildImageFieldEntry(logo, preference);
    }
    return entry;
}

async function fetchImageEntries(mediaType, ref, fields) {
    const requestedFields =
        mediaType === mediaTypes.MEDIA_TYPE.MOVIE || mediaType === mediaTypes.MEDIA_TYPE.SHOW
            ? [IMAGE_FIELD.POSTER, IMAGE_FIELD.LOGO]
            : commonUtils.ensureArray(fields).filter((field) => field === IMAGE_FIELD.POSTER || field === IMAGE_FIELD.LOGO);
    if (requestedFields.length === 0) {
        return [];
    }
    const preferences = (
        await Promise.all(
            getImageFetchModes().map(async (mode) => {
                const modeRef = { ...ref, imageMode: mode };
                try {
                    const preference = await resolveImagePreference(mediaType, modeRef);
                    return preference ? { ref: modeRef, preference, fields: requestedFields } : { ref: modeRef, preference: null, fields: requestedFields };
                } catch (error) {
                    globalThis.$ctx.env.log(`Trakt image preference failed for key=${buildImageCacheKey(mediaType, modeRef)}: ${error}`);
                    return mode === POSTER_IMAGE_MODE.ORIGINAL ? null : { ref: modeRef, preference: null, fields: requestedFields };
                }
            }),
        )
    ).filter(Boolean);
    if (preferences.length === 0) {
        return [];
    }

    const languages = preferences
        .map(({ preference }) => preference?.language)
        .filter(Boolean)
        .filter((language, index, array) => array.indexOf(language) === index);
    const payload =
        languages.length === 0
            ? null
            : mediaType === "season"
              ? await tmdbClientModule.fetchSeasonImages(ref?.showTmdbId, ref?.seasonNumber, languages.join(","))
              : await tmdbClientModule.fetchImages(mediaType, ref?.tmdbId, languages.join(","));

    return preferences.map(({ ref: modeRef, preference, fields: missingFields }) => ({
        ref: modeRef,
        entry: preference
            ? buildImageEntryFromPayload(payload, mediaType, preference, missingFields)
            : Object.fromEntries(missingFields.map((field) => [field, { status: translationCache.CACHE_STATUS.NOT_FOUND }])),
    }));
}

function applyImages(target, entry, fields) {
    let changed = false;
    commonUtils.ensureArray(fields).forEach((field) => {
        const url = tmdbClientModule.resizeImageUrl(entry?.[field]?.url, IMAGE_FIELD_SIZE[field] ?? "original");
        if (!url || !commonUtils.isArray(target?.images?.[field]) || target.images[field].length === 0 || target.images[field][0] === url) {
            return;
        }
        target.images[field][0] = url;
        changed = true;
    });
    return changed;
}

function createImageBackendState() {
    const createPendingBackendWrites = () => ({
        movies: {},
        shows: {},
        seasons: {},
    });
    return {
        pendingBackendWritesByMode: {
            [POSTER_IMAGE_MODE.CHINESE]: createPendingBackendWrites(),
            [POSTER_IMAGE_MODE.ORIGINAL]: createPendingBackendWrites(),
        },
        backendWriteBatchSize: BACKEND_WRITE_BATCH_SIZE,
    };
}

function getImageBackendGroup(mediaType) {
    return IMAGE_BACKEND_CONFIG[mediaType] ?? "";
}

function getImageCacheGroup(mediaType) {
    return IMAGE_CACHE_GROUP_CONFIG[mediaType] ?? "";
}

function getMissingImageFields(cache, mediaType, ref, fields) {
    const entry = getImageCacheEntry(cache, mediaType, ref);
    return commonUtils.ensureArray(fields).filter((field) => !entry?.[field]);
}

function getCurrentModeMissingImageFields(cache, mediaType, ref, fields) {
    return getMissingImageFields(cache, mediaType, { ...ref, imageMode: getPosterImageMode() }, fields);
}

function hasCurrentModeMissingImages(cache, targets) {
    return targets.some(({ mediaType, ref, fields }) => getCurrentModeMissingImageFields(cache, mediaType, ref, fields).length > 0);
}

async function shouldSkipCurrentOriginalImages(mediaType, ref) {
    if (getPosterImageMode() !== POSTER_IMAGE_MODE.ORIGINAL) {
        return false;
    }
    const preference = await resolveImagePreference(mediaType, { ...ref, imageMode: POSTER_IMAGE_MODE.ORIGINAL });
    return !preference || preference.language === "en";
}

function queueImageBackendWrite(backendState, mediaType, ref, entry) {
    const mode = ref?.imageMode ?? getPosterImageMode();
    const group = getImageBackendGroup(mediaType);
    const lookupKey = buildImageCacheLookupKey(mediaType, ref);
    const pendingBackendWrites = backendState.pendingBackendWritesByMode?.[mode];
    if (!pendingBackendWrites || !group || !lookupKey || !entry) {
        return;
    }
    pendingBackendWrites[group][lookupKey] = {
        ...commonUtils.ensureObject(pendingBackendWrites[group][lookupKey]),
        ...entry,
    };
    if (getImagePendingBackendWriteCount(backendState) >= backendState.backendWriteBatchSize) {
        flushImageBackendWriteBatch(backendState, backendState.backendWriteBatchSize);
    }
}

function getImagePendingBackendWriteCount(backendState) {
    return Object.values(commonUtils.ensureObject(backendState.pendingBackendWritesByMode)).reduce((modeCount, pendingBackendWrites) => {
        return (
            modeCount +
            Object.keys(commonUtils.ensureObject(pendingBackendWrites)).reduce(
                (count, group) => count + Object.keys(commonUtils.ensureObject(pendingBackendWrites[group])).length,
                0,
            )
        );
    }, 0);
}

function extractImageBackendWritePayload(backendState, mode, maxBatchSize) {
    const payload = { movies: {}, shows: {}, seasons: {} };
    const batchSize = Number(maxBatchSize) > 0 ? Number(maxBatchSize) : backendState.backendWriteBatchSize;
    const pendingBackendWrites = commonUtils.ensureObject(backendState.pendingBackendWritesByMode?.[mode]);
    let count = 0;
    for (const group of Object.keys(pendingBackendWrites)) {
        const entries = commonUtils.ensureObject(pendingBackendWrites[group]);
        for (const lookupKey of Object.keys(entries)) {
            if (count >= batchSize) {
                return payload;
            }
            payload[group][lookupKey] = entries[lookupKey];
            delete pendingBackendWrites[group][lookupKey];
            count += 1;
        }
    }
    return payload;
}

function extractMultiModeImageBackendWritePayload(backendState, maxBatchSize) {
    const payload = { modes: {} };
    const batchSize = Number(maxBatchSize) > 0 ? Number(maxBatchSize) : backendState.backendWriteBatchSize;
    let count = 0;
    for (const mode of Object.keys(commonUtils.ensureObject(backendState.pendingBackendWritesByMode))) {
        const modePayload = extractImageBackendWritePayload(backendState, mode, batchSize - count);
        const modeCount = Object.keys(modePayload.movies).length + Object.keys(modePayload.shows).length + Object.keys(modePayload.seasons).length;
        if (modeCount > 0) {
            payload.modes[mode] = modePayload;
            count += modeCount;
        }
        if (count >= batchSize) {
            break;
        }
    }
    return payload;
}

function flushImageBackendWriteBatch(backendState, maxBatchSize) {
    if (!vercelBackendClientModule.resolveBackendBaseUrl() || getImagePendingBackendWriteCount(backendState) === 0) {
        return false;
    }

    vercelBackendClientModule.postImages(extractMultiModeImageBackendWritePayload(backendState, maxBatchSize)).catch(() => {});
    return true;
}

function flushImageBackendWrites(backendState) {
    flushImageBackendWriteBatch(backendState, getImagePendingBackendWriteCount(backendState));
}

async function hydrateImagesFromBackend(cache, targets, mode = getPosterImageMode()) {
    if (!vercelBackendClientModule.resolveBackendBaseUrl()) {
        return false;
    }

    const groups = { movies: new Set(), shows: new Set(), seasons: new Set() };
    targets.forEach(({ mediaType, ref, fields }) => {
        const modeRef = { ...ref, imageMode: mode };
        if (getMissingImageFields(cache, mediaType, modeRef, fields).length === 0) {
            return;
        }
        const group = getImageBackendGroup(mediaType);
        const lookupKey = buildImageCacheLookupKey(mediaType, modeRef);
        if (group && lookupKey) {
            groups[group].add(lookupKey);
        }
    });
    const query = Object.entries(groups)
        .map(([group, ids]) =>
            ids.size > 0
                ? `${group}=${Array.from(ids)
                      .sort((left, right) => String(left).localeCompare(String(right), "en", { numeric: true }))
                      .join(",")}`
                : "",
        )
        .filter(Boolean);
    if (query.length === 0) {
        return false;
    }
    query.unshift(`mode=${encodeURIComponent(mode)}`);

    const payload = await vercelBackendClientModule.fetchImages(query.join("&"));
    let cacheChanged = false;
    Object.entries(IMAGE_BACKEND_GROUP_TO_MEDIA_TYPE).forEach(([group, mediaType]) => {
        const entries = commonUtils.ensureObject(payload?.[group]);
        Object.keys(entries).forEach((lookupKey) => {
            if (mediaType === "season") {
                const ref = {
                    showId: lookupKey.split(":")[0],
                    seasonNumber: lookupKey.split(":")[1],
                    imageMode: mode,
                };
                storeImageCacheEntry(cache, "season", ref, entries[lookupKey]);
                cacheChanged = true;
                return;
            }

            storeImageCacheEntry(cache, mediaType, { traktId: lookupKey, imageMode: mode }, entries[lookupKey]);
            cacheChanged = true;
        });
    });
    return cacheChanged;
}

async function fetchAndPersistMissingImages(cache, targets, backendState = createImageBackendState()) {
    let cacheChanged = false;
    await processInBatches(targets, async ({ mediaType, ref, fields }) => {
        if (getCurrentModeMissingImageFields(cache, mediaType, ref, fields).length === 0) {
            return;
        }
        try {
            const entries = await fetchImageEntries(mediaType, ref, fields);
            const currentMode = getPosterImageMode();
            for (const { ref: modeRef, entry } of entries) {
                if ((modeRef?.imageMode ?? currentMode) === currentMode) {
                    storeImageCacheEntry(cache, mediaType, modeRef, entry);
                    cacheChanged = true;
                }
                queueImageBackendWrite(backendState, mediaType, modeRef, entry);
            }
        } catch (error) {
            globalThis.$ctx.env.log(`Trakt image fetch failed for key=${buildImageCacheKey(mediaType, ref)}: ${error}`);
        }
    });
    return cacheChanged;
}

async function hydrateAndFetchImages(cache, targets, backendState) {
    const context = globalThis.$ctx;
    let cacheChanged = false;
    if (!hasCurrentModeMissingImages(cache, targets)) {
        return false;
    }
    try {
        const currentMode = getPosterImageMode();
        cacheChanged = (await hydrateImagesFromBackend(cache, targets, currentMode)) || cacheChanged;
        if (!hasCurrentModeMissingImages(cache, targets)) {
            return cacheChanged;
        }
    } catch (error) {
        context.env.log(`Trakt backend image cache read failed: ${error}`);
    }
    cacheChanged = (await fetchAndPersistMissingImages(cache, targets, backendState)) || cacheChanged;
    return cacheChanged;
}

async function replaceImagesInPlace(target, mediaType, ref) {
    // 不用补齐详情页无图片字段时的缓存写回
    const fields = getApplicableImageFields(target, mediaType, ref);
    if (fields.length === 0) {
        return false;
    }
    if (await shouldSkipCurrentOriginalImages(mediaType, ref)) {
        return false;
    }

    const context = globalThis.$ctx;
    const imageCache = cacheUtils.loadImageCache(context.env);
    const backendState = createImageBackendState();
    if (await hydrateAndFetchImages(imageCache, [{ mediaType, ref, fields }], backendState)) {
        cacheUtils.saveImageCache(context.env, imageCache);
    }
    flushImageBackendWrites(backendState);

    return applyImages(target, getImageCacheEntry(imageCache, mediaType, ref), fields);
}

function buildSeasonPosterRef(showId, showTmdbId, season) {
    const seasonNumber = season?.number ?? commonUtils.ensureArray(season?.episodes)[0]?.season ?? null;
    return {
        showId,
        showTmdbId,
        seasonNumber,
    };
}

async function replaceSeasonImagesInPlace(seasons, showId, showTmdbId, showLanguage = null, showCountry = null) {
    if (commonUtils.isNotArray(seasons) || commonUtils.isNullish(showId) || commonUtils.isNullish(showTmdbId)) {
        return false;
    }

    const context = globalThis.$ctx;
    const imageCache = cacheUtils.loadImageCache(context.env);
    const targets = seasons
        .map((season) => ({
            season,
            mediaType: "season",
            ref: {
                ...buildSeasonPosterRef(showId, showTmdbId, season),
                imageMode: getPosterImageMode(),
                language: showLanguage,
                country: showCountry,
            },
        }))
        .map((target) => ({
            ...target,
            fields: getFetchImageFields(target.season, target.mediaType, target.ref),
        }))
        .filter(({ fields }) => fields.length > 0);
    if (targets.length === 0 || (await shouldSkipCurrentOriginalImages("season", targets[0].ref))) {
        return false;
    }
    const seen = {};
    const missingTargets = targets.filter(({ mediaType, ref, fields }) => {
        const key = buildImageCacheKey(mediaType, ref);
        if (!key || seen[key] || getMissingImageFields(imageCache, mediaType, ref, fields).length === 0) {
            return false;
        }
        seen[key] = true;
        return true;
    });

    const backendState = createImageBackendState();
    if (await hydrateAndFetchImages(imageCache, missingTargets, backendState)) {
        cacheUtils.saveImageCache(context.env, imageCache);
    }
    flushImageBackendWrites(backendState);

    let changed = false;
    targets.forEach(({ season, mediaType, ref, fields }) => {
        changed = applyImages(season, getImageCacheEntry(imageCache, mediaType, ref), fields) || changed;
    });
    return changed;
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
            return translationCache.extractNormalizedTranslation(translationCache.normalizeTranslations(responseJson));
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
    const parsed = JSON.parse(sourceBody);
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
    createBackendState,
    fetchAndPersistMissing,
    fetchAndPersistMissingImages,
    fetchMediaDetail,
    flushBackendWrites,
    getCachedTranslation,
    getMissingRefs,
    getOverrideForTarget,
    getOverrideFromTable,
    hydrateFromBackend,
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
