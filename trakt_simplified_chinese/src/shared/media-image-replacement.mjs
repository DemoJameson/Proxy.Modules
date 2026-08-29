import * as tmdbClientModule from "../outbound/tmdb-client.mjs";
import * as vercelBackendClientModule from "../outbound/vercel-backend-client.mjs";
import * as cacheUtils from "../utils/cache.mjs";
import * as commonUtils from "../utils/common.mjs";

import { BACKEND_WRITE_BATCH_SIZE, processInBatches } from "./media-translation-backend.mjs";
import * as mediaTypes from "./media-types.mjs";
import * as translationCache from "./translation-cache.mjs";

const IMAGE_PARTIAL_FOUND_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const IMAGE_NOT_FOUND_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const IMAGE_PREFERENCE_DETAIL_MEMO_TTL_MS = 30 * 1000;
const IMAGE_PREFERENCE_DETAIL_MEMO_LIMIT = 200;

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

const IMAGE_PREFERENCE_DETAIL_MEMO = new Map();
const IMAGE_PREFERENCE_DETAIL_EMPTY = Object.freeze({ original_language: undefined, origin_country: [], production_countries: [] });

// memo 值是进行中的 Promise：并发同 key 调用（如多季列表共享同一 show 详情）只发一次请求；Promise 永不 reject，失败以 EMPTY 负缓存。
function readImagePreferenceDetailMemo(detailMediaType, tmdbId) {
    const memoKey = `${detailMediaType}:${tmdbId}`;
    const entry = IMAGE_PREFERENCE_DETAIL_MEMO.get(memoKey);
    if (!entry) {
        return null;
    }
    if (entry.expiresAt <= Date.now()) {
        IMAGE_PREFERENCE_DETAIL_MEMO.delete(memoKey);
        return null;
    }
    return entry.promise;
}

function writeImagePreferenceDetailMemo(detailMediaType, tmdbId, promise) {
    const memoKey = `${detailMediaType}:${tmdbId}`;
    if (!IMAGE_PREFERENCE_DETAIL_MEMO.has(memoKey) && IMAGE_PREFERENCE_DETAIL_MEMO.size >= IMAGE_PREFERENCE_DETAIL_MEMO_LIMIT) {
        IMAGE_PREFERENCE_DETAIL_MEMO.delete(IMAGE_PREFERENCE_DETAIL_MEMO.keys().next().value);
    }
    IMAGE_PREFERENCE_DETAIL_MEMO.set(memoKey, { promise, expiresAt: Date.now() + IMAGE_PREFERENCE_DETAIL_MEMO_TTL_MS });
    return promise;
}

function createImagePreferenceDetailSnapshot(detail) {
    return {
        original_language: detail?.original_language,
        origin_country: commonUtils.ensureArray(detail?.origin_country),
        production_countries: commonUtils.ensureArray(detail?.production_countries),
    };
}

async function fetchImagePreferenceDetail(detailMediaType, tmdbId) {
    const cached = readImagePreferenceDetailMemo(detailMediaType, tmdbId);
    if (cached) {
        return cached;
    }
    return writeImagePreferenceDetailMemo(
        detailMediaType,
        tmdbId,
        (async () => {
            try {
                const detail = await tmdbClientModule.fetchDetails(detailMediaType, tmdbId);
                return createImagePreferenceDetailSnapshot(detail);
            } catch (error) {
                // 失败也负缓存：同一次运行内不重试必败的详情请求（合并请求失败回退时同样受益）。
                globalThis.$ctx.env.log(`Trakt TMDb image preference detail failed for key=${detailMediaType}:${tmdbId}: ${error}`);
                return IMAGE_PREFERENCE_DETAIL_EMPTY;
            }
        })(),
    );
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
        const detail = await fetchImagePreferenceDetail(detailMediaType, tmdbId);
        language ||= normalizeImageLanguage(detail?.original_language);
        country ||= getTmdbDetailCountry(detail);
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

function needsMergedImageDetail(mediaType, ref) {
    if (mediaType !== mediaTypes.MEDIA_TYPE.MOVIE && mediaType !== mediaTypes.MEDIA_TYPE.SHOW) {
        return false;
    }
    // 与 resolveImagePreference 的补查条件一致：ref 自带 language+country 或偏好已记忆化时，无需详情，保持单独图片请求。
    if (normalizeImageLanguage(ref?.language) && normalizeImageCountry(ref?.country)) {
        return false;
    }
    return !readImagePreferenceDetailMemo(mediaType, ref?.tmdbId);
}

async function loadMergedImageDetail(mediaType, ref) {
    try {
        const detail = await tmdbClientModule.fetchDetailsWithImages(mediaType, ref?.tmdbId);
        if (!detail) {
            writeImagePreferenceDetailMemo(mediaType, ref?.tmdbId, Promise.resolve(IMAGE_PREFERENCE_DETAIL_EMPTY));
            return null;
        }
        writeImagePreferenceDetailMemo(mediaType, ref?.tmdbId, Promise.resolve(createImagePreferenceDetailSnapshot(detail)));
        return tmdbClientModule.extractTmdbImagesPayload(detail);
    } catch (error) {
        writeImagePreferenceDetailMemo(mediaType, ref?.tmdbId, Promise.resolve(IMAGE_PREFERENCE_DETAIL_EMPTY));
        globalThis.$ctx.env.log(`Trakt TMDb merged detail images failed for key=${buildImageCacheKey(mediaType, ref)}: ${error}`);
        return null;
    }
}

async function fetchImageEntries(mediaType, ref, fields) {
    const requestedFields =
        mediaType === mediaTypes.MEDIA_TYPE.MOVIE || mediaType === mediaTypes.MEDIA_TYPE.SHOW
            ? [IMAGE_FIELD.POSTER, IMAGE_FIELD.LOGO]
            : commonUtils.ensureArray(fields).filter((field) => field === IMAGE_FIELD.POSTER || field === IMAGE_FIELD.LOGO);
    if (requestedFields.length === 0) {
        return [];
    }

    // 仅当 original 偏好必须补查 TMDb 详情时才改用合并请求一次拿回详情与图片；其余场景维持单独图片 API。
    let mergedImagesPayload = null;
    if (needsMergedImageDetail(mediaType, ref)) {
        mergedImagesPayload = await loadMergedImageDetail(mediaType, ref);
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

    let payload = null;
    if (mergedImagesPayload) {
        payload = mergedImagesPayload;
    } else {
        const languages = preferences
            .map(({ preference }) => preference?.language)
            .filter(Boolean)
            .filter((language, index, array) => array.indexOf(language) === index);
        payload =
            languages.length === 0
                ? null
                : mediaType === "season"
                  ? await tmdbClientModule.fetchSeasonImages(ref?.showTmdbId, ref?.seasonNumber, languages.join(","))
                  : await tmdbClientModule.fetchImages(mediaType, ref?.tmdbId, languages.join(","));
    }

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

export {
    applyImages,
    buildImageCacheKey,
    buildImageCacheLookupKey,
    buildImageEntryFromPayload,
    buildSeasonPosterRef,
    createImageBackendState,
    extractImageBackendWritePayload,
    extractMultiModeImageBackendWritePayload,
    fetchAndPersistMissingImages,
    fetchImageEntries,
    flushImageBackendWriteBatch,
    flushImageBackendWrites,
    getApplicableImageFields,
    getCurrentModeMissingImageFields,
    getFetchImageFields,
    getImageBackendGroup,
    getImageCacheEntry,
    getImageCacheGroup,
    getImageFetchModes,
    getImageLanguageScore,
    getImagePendingBackendWriteCount,
    getImageRegionScore,
    getMissingImageFields,
    getPickedImageStatus,
    getPosterImageMode,
    getTmdbDetailCountry,
    hasCurrentModeMissingImages,
    hydrateAndFetchImages,
    hydrateImagesFromBackend,
    IMAGE_BACKEND_CONFIG,
    IMAGE_BACKEND_GROUP_TO_MEDIA_TYPE,
    IMAGE_CACHE_GROUP_CONFIG,
    IMAGE_FIELD,
    IMAGE_FIELD_SIZE,
    IMAGE_NOT_FOUND_TTL_MS,
    IMAGE_PARTIAL_FOUND_TTL_MS,
    IMAGE_REGION_PRIORITY,
    isPosterImageReplacementUserAgent,
    normalizeImageCountry,
    normalizeImageFieldEntry,
    normalizeImageLanguage,
    POSTER_IMAGE_MODE,
    pickPreferredImage,
    queueImageBackendWrite,
    replaceImagesInPlace,
    replaceSeasonImagesInPlace,
    resolveImagePreference,
    shouldReplaceImages,
    shouldSkipCurrentOriginalImages,
    storeImageCacheEntry,
};
