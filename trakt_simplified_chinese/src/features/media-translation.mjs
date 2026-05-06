import * as mediaTypes from "../shared/media-types.mjs";
import * as traktLinkIds from "../shared/trakt-link-ids.mjs";
import * as traktTranslationHelper from "../shared/trakt-translation-helper.mjs";
import * as translationCache from "../shared/translation-cache.mjs";
import * as cacheUtils from "../utils/cache.mjs";
import * as commonUtils from "../utils/common.mjs";

async function handleCurrentSeasonRequest() {
    const context = globalThis.$ctx;
    const match = context.url.shortPathname.match(/^shows\/(\d+)\/seasons\/(\d+)$/);
    if (!match) {
        return { type: "passThrough" };
    }

    cacheUtils.setCurrentSeason(context.env, match[1], Number(match[2]));
    return { type: "passThrough" };
}

async function handleDirectMediaList() {
    const context = globalThis.$ctx;
    const sourceBody = context.responseBody;
    const parsed = JSON.parse(sourceBody);
    if (commonUtils.isNotArray(parsed) || parsed.length === 0) {
        return { type: "respond", body: sourceBody };
    }
    const wrappedItems = traktTranslationHelper.wrapDirectMediaItems(parsed, traktTranslationHelper.MEDIA_CONFIG);
    await traktTranslationHelper.translateMediaItemsInPlace(wrappedItems, sourceBody);
    return { type: "respond", body: JSON.stringify(traktTranslationHelper.unwrapDirectMediaItems(wrappedItems, traktTranslationHelper.MEDIA_CONFIG)) };
}

async function handleWrapperMediaList() {
    return traktTranslationHelper.translateWrapperItems();
}

async function handleMediaDetail() {
    const context = globalThis.$ctx;
    const data = JSON.parse(context.responseBody);
    if (!commonUtils.isPlainObject(data)) {
        return { type: "passThrough" };
    }

    const mediaType = context.url.shortPathname.includes("/seasons/")
        ? mediaTypes.MEDIA_TYPE.EPISODE
        : context.url.shortPathname.startsWith("shows/")
          ? mediaTypes.MEDIA_TYPE.SHOW
          : mediaTypes.MEDIA_TYPE.MOVIE;
    const ref = traktTranslationHelper.resolveMediaDetailTarget(context.url, data, mediaType);
    if (!ref || !traktTranslationHelper.buildMediaCacheLookupKey(mediaType, ref)) {
        return { type: "passThrough" };
    }

    const linkCache = cacheUtils.loadLinkIdsCache(context.env);
    if (traktLinkIds.cacheMediaIdsFromDetailResponse(linkCache, mediaType, ref, data)) {
        cacheUtils.saveLinkIdsCache(context.env, linkCache);
    }

    const cache = cacheUtils.loadCache(context.env);
    traktTranslationHelper.applyTranslation(context.userAgent, data, traktTranslationHelper.getCachedTranslation(cache, mediaType, ref), mediaType);

    try {
        traktTranslationHelper.applyOverrideToTarget(data, await traktTranslationHelper.getOverrideForTarget(context.env, ref));
    } catch (error) {
        context.env.log(`Trakt backend override read failed: ${error}`);
    }

    return { type: "respond", body: JSON.stringify(data) };
}

async function handleTranslations() {
    const context = globalThis.$ctx;
    const arr = JSON.parse(context.responseBody);
    if (commonUtils.isNotArray(arr) || arr.length === 0) {
        return { type: "passThrough" };
    }

    const target = traktTranslationHelper.resolveTranslationRequestTarget(context.url);
    const merged = translationCache.normalizeTranslations(translationCache.sortTranslations(arr, traktTranslationHelper.PREFERRED_TRANSLATION_LANGUAGE), {
        mediaType: target?.mediaType,
    });

    if (!traktTranslationHelper.isScriptInitiatedTranslationRequest() && target && traktTranslationHelper.buildMediaCacheLookupKey(target.mediaType, target)) {
        const normalized = translationCache.extractNormalizedTranslation(merged);
        const cache = cacheUtils.loadCache(context.env);
        const cachedEntry = traktTranslationHelper.getCachedTranslation(cache, target.mediaType, target);
        const shouldUpdateCache =
            !cachedEntry || cachedEntry.status !== normalized.status || !translationCache.areTranslationsEqual(cachedEntry.translation, normalized.translation);

        if (shouldUpdateCache) {
            traktTranslationHelper.storeTranslationEntry(cache, target.mediaType, target, normalized);
            cacheUtils.saveCache(context.env, cache);

            const backendState = traktTranslationHelper.createBackendState(traktTranslationHelper.MEDIA_CONFIG);
            traktTranslationHelper.queueBackendWrite(backendState, target.mediaType, target, normalized);
            try {
                traktTranslationHelper.flushBackendWrites(backendState);
            } catch (error) {
                context.env.log(`Trakt backend cache write failed: ${error}`);
            }
        }

        try {
            traktTranslationHelper.applyOverrideToTranslations(merged, await traktTranslationHelper.getOverrideForTarget(context.env, target), target.mediaType);
        } catch (error) {
            context.env.log(`Trakt backend override read failed: ${error}`);
        }
    }

    return { type: "respond", body: JSON.stringify(merged) };
}

async function handleSeasonEpisodesList() {
    const context = globalThis.$ctx;
    const target = traktTranslationHelper.resolveSeasonListTarget(context.url);
    const seasons = JSON.parse(context.responseBody);
    if (!target || commonUtils.isNotArray(seasons) || seasons.length === 0) {
        return { type: "passThrough" };
    }

    const linkCache = cacheUtils.loadLinkIdsCache(context.env);
    if (traktLinkIds.cacheEpisodeIdsFromSeasonList(linkCache, target.showId, seasons)) {
        cacheUtils.saveLinkIdsCache(context.env, linkCache);
    }

    const currentSeasonNumber = cacheUtils.getCurrentSeason(context.env, target.showId);
    const targetSeason = seasons.find((item) => {
        return commonUtils.ensureArray(item?.episodes).some((episode) => Number(episode?.season) === currentSeasonNumber);
    });
    if (!targetSeason) {
        return { type: "passThrough" };
    }

    const backendState = traktTranslationHelper.createBackendState(traktTranslationHelper.MEDIA_CONFIG);

    const cache = cacheUtils.loadCache(context.env);
    const allEpisodeRefs = seasons
        .flatMap((item) => {
            return commonUtils.ensureArray(item?.episodes).map((episode) => ({
                mediaType: mediaTypes.MEDIA_TYPE.EPISODE,
                showId: target.showId,
                seasonNumber: episode?.season ?? null,
                episodeNumber: episode?.number ?? null,
                backendLookupKey: traktTranslationHelper.buildEpisodeCompositeKey(target.showId, episode?.season ?? null, episode?.number ?? null),
                sourceTitle: episode?.title ?? null,
                availableTranslations: commonUtils.isArray(episode?.available_translations) ? episode.available_translations : null,
                seasonFirstAired: item?.first_aired ?? null,
                episodeFirstAired: episode?.first_aired ?? null,
            }));
        })
        .filter((ref) => !!traktTranslationHelper.buildMediaCacheLookupKey(mediaTypes.MEDIA_TYPE.EPISODE, ref));

    let cacheChanged = await traktTranslationHelper.hydrateFromBackend(cache, { show: [], movie: [], episode: allEpisodeRefs }, traktTranslationHelper.MEDIA_CONFIG, backendState);

    const missingEpisodeRefs = traktTranslationHelper.getMissingRefs(cache, mediaTypes.MEDIA_TYPE.EPISODE, allEpisodeRefs).filter((ref) => {
        return commonUtils.isNonNullish(ref?.seasonFirstAired) && commonUtils.isNonNullish(ref?.episodeFirstAired);
    });
    const prioritizedEpisodeRefs = missingEpisodeRefs
        .map((ref, index) => ({ ref, index }))
        .sort((left, right) => {
            const leftSeason = Number(left.ref?.seasonNumber);
            const rightSeason = Number(right.ref?.seasonNumber);
            const leftBucket = leftSeason === currentSeasonNumber ? 0 : leftSeason > currentSeasonNumber ? 1 : 2;
            const rightBucket = rightSeason === currentSeasonNumber ? 0 : rightSeason > currentSeasonNumber ? 1 : 2;
            if (leftBucket !== rightBucket) {
                return leftBucket - rightBucket;
            }
            if (leftBucket === 2 && leftSeason !== rightSeason) {
                return rightSeason - leftSeason;
            }
            if (leftSeason !== rightSeason) {
                return leftSeason - rightSeason;
            }
            return left.index - right.index;
        })
        .map((item) => item.ref)
        .slice(0, traktTranslationHelper.SEASON_EPISODE_TRANSLATION_LIMIT);

    cacheChanged = (await traktTranslationHelper.fetchAndPersistMissing(cache, mediaTypes.MEDIA_TYPE.EPISODE, prioritizedEpisodeRefs, backendState)) || cacheChanged;
    if (cacheChanged) {
        cacheUtils.saveCache(context.env, cache);
    }
    traktTranslationHelper.flushBackendWrites(backendState);

    let overridesTable = null;
    try {
        overridesTable = await traktTranslationHelper.loadTranslationOverrides(context.env);
    } catch (error) {
        context.env.log(`Trakt backend override read failed: ${error}`);
    }

    seasons.forEach((season) => {
        commonUtils.ensureArray(season?.episodes).forEach((episode) => {
            const ref = {
                mediaType: mediaTypes.MEDIA_TYPE.EPISODE,
                showId: target.showId,
                seasonNumber: episode?.season ?? null,
                episodeNumber: episode?.number ?? null,
            };
            traktTranslationHelper.applyTranslation(
                context.userAgent,
                episode,
                traktTranslationHelper.getCachedTranslation(cache, mediaTypes.MEDIA_TYPE.EPISODE, ref),
                mediaTypes.MEDIA_TYPE.EPISODE,
            );
            traktTranslationHelper.applyOverrideToTarget(episode, traktTranslationHelper.getOverrideFromTable(overridesTable, ref));
        });
    });

    try {
        return { type: "respond", body: JSON.stringify(seasons) };
    } finally {
        cacheUtils.clearCurrentSeason(context.env);
    }
}

async function handleMonthlyReview() {
    const data = JSON.parse(globalThis.$ctx.responseBody);
    const firstWatched = data?.first_watched;
    if (!commonUtils.isPlainObject(data) || !commonUtils.isPlainObject(firstWatched) || (!firstWatched.show && !firstWatched.movie && !firstWatched.episode)) {
        return { type: "passThrough" };
    }

    const wrapped = [{ ...firstWatched }];
    await traktTranslationHelper.translateMediaItemsInPlace(wrapped, JSON.stringify(wrapped));
    const translatedItem = commonUtils.isArray(wrapped) ? wrapped[0] : null;
    if (!translatedItem || typeof translatedItem !== "object") {
        return { type: "passThrough" };
    }

    Object.keys(traktTranslationHelper.MEDIA_CONFIG).forEach((mediaType) => {
        if (firstWatched[mediaType] && translatedItem[mediaType]) {
            firstWatched[mediaType] = translatedItem[mediaType];
        }
    });
    return { type: "respond", body: JSON.stringify(data) };
}

export { handleCurrentSeasonRequest, handleDirectMediaList, handleMediaDetail, handleMonthlyReview, handleSeasonEpisodesList, handleTranslations, handleWrapperMediaList };
