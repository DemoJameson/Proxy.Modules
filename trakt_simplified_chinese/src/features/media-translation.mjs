import * as chineseLocaleModule from "../shared/chinese-script-converter.mjs";
import * as mediaTypes from "../shared/media-types.mjs";
import * as traktLinkIds from "../shared/trakt-link-ids.mjs";
import * as traktTranslationHelper from "../shared/trakt-translation-helper.mjs";
import * as translationCache from "../shared/translation-cache.mjs";
import * as cacheUtils from "../utils/cache.mjs";
import * as commonUtils from "../utils/common.mjs";
import * as googleFallbackTranslation from "./google-fallback-translation.mjs";

function isFieldOverridden(override, field) {
    return traktTranslationHelper.hasOverrideField(override, field);
}

// 官方 Trakt App 的 UA 以 Trakt 开头（与海报替换的 UA 判断保持一致）
function isTraktAppUserAgent(userAgent) {
    return /^Trakt/i.test(String(userAgent ?? "").trim());
}

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
    const parsed = commonUtils.parseJsonBody(sourceBody);
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

async function handleWrapperMediaObject() {
    const context = globalThis.$ctx;
    const sourceBody = context.responseBody;
    const parsed = commonUtils.parseJsonBody(sourceBody);
    if (!commonUtils.isPlainObject(parsed) || (!parsed.show && !parsed.episode && !parsed.movie)) {
        return { type: "respond", body: sourceBody };
    }

    const wrapped = [parsed];
    await traktTranslationHelper.translateMediaItemsInPlace(wrapped, sourceBody);
    return { type: "respond", body: JSON.stringify(wrapped[0]) };
}

async function handleMediaDetail() {
    const context = globalThis.$ctx;
    const data = commonUtils.parseJsonBody(context.responseBody);
    if (!commonUtils.isPlainObject(data)) {
        return { type: "passThrough" };
    }

    const seasonInfoMatch = context.url.shortPathname.match(/^shows\/(\d+)\/seasons\/(\d+)\/info$/);
    const isSeasonInfo = !!seasonInfoMatch;

    let mediaType;
    if (isSeasonInfo) {
        mediaType = mediaTypes.MEDIA_TYPE.SEASON;
    } else if (context.url.shortPathname.includes("/seasons/")) {
        mediaType = mediaTypes.MEDIA_TYPE.EPISODE;
    } else if (context.url.shortPathname.startsWith("shows/")) {
        mediaType = mediaTypes.MEDIA_TYPE.SHOW;
    } else {
        mediaType = mediaTypes.MEDIA_TYPE.MOVIE;
    }

    let ref;
    if (isSeasonInfo && commonUtils.isNonNullish(data?.ids?.trakt)) {
        ref = {
            mediaType: mediaTypes.MEDIA_TYPE.SEASON,
            showId: seasonInfoMatch[1],
            seasonNumber: Number(seasonInfoMatch[2]),
            traktId: data.ids.trakt,
        };
    } else {
        ref = traktTranslationHelper.resolveMediaDetailTarget(context.url, data, mediaType);
    }
    if (!ref || !traktTranslationHelper.buildMediaCacheLookupKey(mediaType, ref)) {
        return { type: "passThrough" };
    }

    const linkCache = cacheUtils.loadLinkIdsCache(context.env);
    if (traktLinkIds.cacheMediaIdsFromDetailResponse(linkCache, mediaType, ref, data)) {
        cacheUtils.saveLinkIdsCache(context.env, linkCache);
    }

    const cache = cacheUtils.loadCache(context.env);
    // 官方 Trakt App 进入详情页后会自行请求 /translations/zh（由响应阶段的 handleTranslations 负责缓存），
    // 无需脚本代劳；其它 Trakt 兼容客户端不会请求该接口，这里按需补全（后端缓存 → 直查 Trakt）
    if (!isTraktAppUserAgent(context.userAgent)) {
        const backendState = traktTranslationHelper.createBackendState(traktTranslationHelper.MEDIA_CONFIG);
        let cacheChanged = false;
        try {
            cacheChanged = await traktTranslationHelper.ensureDetailTranslation(
                cache,
                mediaType,
                {
                    ...ref,
                    availableTranslations: commonUtils.isArray(data?.available_translations) ? data.available_translations : null,
                },
                backendState,
            );
        } catch (error) {
            context.env.log(`Trakt detail translation fetch failed: ${error}`);
        }
        if (cacheChanged) {
            cacheUtils.saveCache(context.env, cache);
        }
        traktTranslationHelper.flushBackendWrites(backendState);
    }
    traktTranslationHelper.applyTranslation(context.userAgent, data, traktTranslationHelper.getCachedTranslation(cache, mediaType, ref), mediaType);

    let override = null;
    try {
        override = await traktTranslationHelper.getOverrideForTarget(context.env, ref);
        traktTranslationHelper.applyOverrideToTarget(data, override);
    } catch (error) {
        context.env.log(`Trakt backend override read failed: ${error}`);
    }

    const fallbackPromise = googleFallbackTranslation.applyUncachedGoogleTranslation(context, [
        { target: data, field: "overview", skip: isFieldOverridden(override, "overview") },
        { target: data, field: "tagline", skip: isFieldOverridden(override, "tagline") },
    ]);
    if (traktTranslationHelper.shouldReplaceImages()) {
        await traktTranslationHelper.replaceImagesInPlace(data, mediaType, {
            ...ref,
            tmdbId: data?.ids?.tmdb ?? null,
            imageMode: context.argument.posterImageMode,
            language: data?.language ?? null,
            country: data?.country ?? null,
        });
    }
    await fallbackPromise;

    return { type: "respond", body: JSON.stringify(data) };
}

async function handleTranslations() {
    const context = globalThis.$ctx;
    const arr = commonUtils.parseJsonBody(context.responseBody);
    if (commonUtils.isNotArray(arr) || arr.length === 0) {
        return { type: "passThrough" };
    }

    const target = traktTranslationHelper.resolveTranslationRequestTarget(context.url);
    const locale = chineseLocaleModule.resolveChineseLocale();
    const merged = translationCache.normalizeTranslations(translationCache.sortTranslations(arr, traktTranslationHelper.resolvePreferredTranslationLanguage(locale)), locale);

    if (!traktTranslationHelper.isScriptInitiatedTranslationRequest() && target && traktTranslationHelper.buildMediaCacheLookupKey(target.mediaType, target)) {
        const normalized = translationCache.extractNormalizedTranslation(merged);
        const cache = cacheUtils.loadCache(context.env);
        const cachedEntry = traktTranslationHelper.getCachedTranslation(cache, target.mediaType, target);
        const shouldUpdateCache =
            !cachedEntry || cachedEntry.status !== normalized.status || !translationCache.areTranslationsEqual(cachedEntry.translation, normalized.translation);

        if (shouldUpdateCache) {
            const completeEntry = { ...normalized, complete: true };
            traktTranslationHelper.storeTranslationEntry(cache, target.mediaType, target, completeEntry);
            cacheUtils.saveCache(context.env, cache);

            const backendState = traktTranslationHelper.createBackendState(traktTranslationHelper.MEDIA_CONFIG);
            // App 自己请求 /translations/zh 时同样顺带折叠 cn 数据，避免 tw/hk 用户写出的后端条目缺少 cn 槽位
            traktTranslationHelper.queueBackendWrite(backendState, target.mediaType, target, completeEntry, translationCache.buildCnFoldEntry(merged, locale));
            try {
                traktTranslationHelper.flushBackendWrites(backendState);
            } catch (error) {
                context.env.log(`Trakt backend cache write failed: ${error}`);
            }
        }

        try {
            traktTranslationHelper.applyOverrideToTranslations(merged, await traktTranslationHelper.getOverrideForTarget(context.env, target));
        } catch (error) {
            context.env.log(`Trakt backend override read failed: ${error}`);
        }
    }

    return { type: "respond", body: JSON.stringify(merged) };
}

async function handleSeasonEpisodesList() {
    const context = globalThis.$ctx;
    const target = traktTranslationHelper.resolveSeasonListTarget(context.url);
    const seasons = commonUtils.parseJsonBody(context.responseBody);
    if (!target || commonUtils.isNotArray(seasons) || seasons.length === 0) {
        return { type: "passThrough" };
    }

    const linkCache = cacheUtils.loadLinkIdsCache(context.env);
    if (traktLinkIds.cacheEpisodeIdsFromSeasonList(linkCache, target.showId, seasons)) {
        cacheUtils.saveLinkIdsCache(context.env, linkCache);
    }
    const shouldReplaceSeasonImages =
        traktTranslationHelper.shouldReplaceImages() && seasons.some((season) => commonUtils.isArray(season?.images?.poster) && season.images.poster.length > 0);
    const cachedShowEntry = shouldReplaceSeasonImages ? traktLinkIds.getLinkIdsCacheEntry(linkCache, target.showId) : null;
    let showTmdbId = cachedShowEntry?.ids?.tmdb ?? null;
    let showLanguage = cachedShowEntry?.language ?? null;
    let showCountry = cachedShowEntry?.country ?? null;
    const shouldFetchShowDetailForSeasonImages =
        shouldReplaceSeasonImages &&
        (commonUtils.isNullish(showTmdbId) || (context.argument.posterImageMode === "original" && (commonUtils.isNullish(showLanguage) || commonUtils.isNullish(showCountry))));
    if (shouldFetchShowDetailForSeasonImages) {
        try {
            const showEntry = commonUtils.isNullish(showTmdbId)
                ? await traktLinkIds.ensureMediaIdsCacheEntry(
                      traktTranslationHelper.fetchMediaDetail,
                      (cache) => cacheUtils.saveLinkIdsCache(context.env, cache),
                      linkCache,
                      mediaTypes.MEDIA_TYPE.SHOW,
                      target.showId,
                  )
                : await traktTranslationHelper.fetchMediaDetail(mediaTypes.MEDIA_TYPE.SHOW, target.showId).then((payload) => {
                      if (traktLinkIds.cacheMediaIdsFromDetailResponse(linkCache, mediaTypes.MEDIA_TYPE.SHOW, target, payload)) {
                          cacheUtils.saveLinkIdsCache(context.env, linkCache);
                      }
                      return traktLinkIds.getLinkIdsCacheEntry(linkCache, target.showId);
                  });
            showTmdbId = showEntry?.ids?.tmdb ?? null;
            showLanguage = showEntry?.language ?? null;
            showCountry = showEntry?.country ?? null;
        } catch (error) {
            context.env.log(`Trakt show TMDb id lookup failed for show=${target.showId}: ${error}`);
        }
    }

    const seasonImagePromise = shouldReplaceSeasonImages
        ? traktTranslationHelper.replaceSeasonImagesInPlace(seasons, target.showId, showTmdbId, showLanguage, showCountry).catch((error) => {
              context.env.log(`Trakt season image replacement failed for show=${target.showId}: ${error}`);
              return false;
          })
        : Promise.resolve(false);

    const currentSeasonNumber = cacheUtils.getCurrentSeason(context.env, target.showId);
    const targetSeason = seasons.find((item) => {
        return commonUtils.ensureArray(item?.episodes).some((episode) => Number(episode?.season) === currentSeasonNumber);
    });

    const backendState = traktTranslationHelper.createBackendState(traktTranslationHelper.MEDIA_CONFIG);

    const cache = cacheUtils.loadCache(context.env);
    const allSeasonRefs = seasons
        .filter((season) => commonUtils.isNonNullish(season?.number))
        .map((season) => ({
            mediaType: mediaTypes.MEDIA_TYPE.SEASON,
            showId: target.showId,
            seasonNumber: season.number,
            backendLookupKey: traktTranslationHelper.buildSeasonCompositeKey(target.showId, season.number),
        }))
        .filter((ref) => !!traktTranslationHelper.buildMediaCacheLookupKey(mediaTypes.MEDIA_TYPE.SEASON, ref));

    const allEpisodeRefs = targetSeason
        ? seasons
              .flatMap((item) => {
                  return commonUtils.ensureArray(item?.episodes).map((episode) => ({
                      mediaType: mediaTypes.MEDIA_TYPE.EPISODE,
                      showId: target.showId,
                      seasonNumber: episode?.season ?? null,
                      episodeNumber: episode?.number ?? null,
                      episodeTraktId: episode?.ids?.trakt ?? null,
                      backendLookupKey: traktTranslationHelper.buildEpisodeCompositeKey(target.showId, episode?.season ?? null, episode?.number ?? null),
                      sourceTitle: episode?.title ?? null,
                      availableTranslations: commonUtils.isArray(episode?.available_translations) ? episode.available_translations : null,
                      seasonFirstAired: item?.first_aired ?? null,
                      episodeFirstAired: episode?.first_aired ?? null,
                  }));
              })
              .filter((ref) => !!traktTranslationHelper.buildMediaCacheLookupKey(mediaTypes.MEDIA_TYPE.EPISODE, ref))
        : [];

    let cacheChanged = await traktTranslationHelper.hydrateFromBackend(
        cache,
        { show: [], movie: [], season: allSeasonRefs, episode: allEpisodeRefs },
        traktTranslationHelper.MEDIA_CONFIG,
        backendState,
    );

    const missingSeasonRefs = traktTranslationHelper.getMissingRefs(cache, mediaTypes.MEDIA_TYPE.SEASON, allSeasonRefs);
    cacheChanged = (await traktTranslationHelper.fetchAndPersistMissing(cache, mediaTypes.MEDIA_TYPE.SEASON, missingSeasonRefs, backendState)) || cacheChanged;

    if (targetSeason) {
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

        const bulkResult = await traktTranslationHelper.fetchBulkTranslationsForMissing(cache, { show: [], movie: [], episode: prioritizedEpisodeRefs }, backendState);
        cacheChanged = bulkResult.cacheChanged || cacheChanged;
        const remainingEpisodeRefs = traktTranslationHelper.getMissingRefs(cache, mediaTypes.MEDIA_TYPE.EPISODE, prioritizedEpisodeRefs);
        cacheChanged = (await traktTranslationHelper.fetchAndPersistMissing(cache, mediaTypes.MEDIA_TYPE.EPISODE, remainingEpisodeRefs, backendState)) || cacheChanged;
    }

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
        const seasonRef = allSeasonRefs.find((ref) => ref.seasonNumber === season.number);
        if (seasonRef) {
            traktTranslationHelper.applyTranslation(
                context.userAgent,
                season,
                traktTranslationHelper.getCachedTranslation(cache, mediaTypes.MEDIA_TYPE.SEASON, seasonRef),
                mediaTypes.MEDIA_TYPE.SEASON,
            );
            traktTranslationHelper.applyOverrideToTarget(season, traktTranslationHelper.getOverrideFromTable(overridesTable, seasonRef));
        }

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
    const fallbackFieldTargets = [];
    seasons.forEach((season) => {
        const seasonRef = allSeasonRefs.find((ref) => ref.seasonNumber === season.number);
        if (seasonRef) {
            fallbackFieldTargets.push({
                target: season,
                field: "overview",
                skip: isFieldOverridden(traktTranslationHelper.getOverrideFromTable(overridesTable, seasonRef), "overview"),
            });
        }

        commonUtils.ensureArray(season?.episodes).forEach((episode) => {
            const ref = {
                mediaType: mediaTypes.MEDIA_TYPE.EPISODE,
                showId: target.showId,
                seasonNumber: episode?.season ?? null,
                episodeNumber: episode?.number ?? null,
            };
            fallbackFieldTargets.push({
                target: episode,
                field: "overview",
                skip: isFieldOverridden(traktTranslationHelper.getOverrideFromTable(overridesTable, ref), "overview"),
            });
        });
    });
    await Promise.all([googleFallbackTranslation.applyUncachedGoogleTranslation(context, fallbackFieldTargets), seasonImagePromise]);

    try {
        return { type: "respond", body: JSON.stringify(seasons) };
    } finally {
        cacheUtils.clearCurrentSeason(context.env);
    }
}

async function handleMonthlyReview() {
    const data = commonUtils.parseJsonBody(globalThis.$ctx.responseBody);
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

export {
    handleCurrentSeasonRequest,
    handleDirectMediaList,
    handleMediaDetail,
    handleMonthlyReview,
    handleSeasonEpisodesList,
    handleTranslations,
    handleWrapperMediaList,
    handleWrapperMediaObject,
};
