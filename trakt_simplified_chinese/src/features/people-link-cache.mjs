import * as traktApiClientModule from "../outbound/trakt-api-client.mjs";
import * as mediaTypes from "../shared/media-types.mjs";
import * as traktLinkIds from "../shared/trakt-link-ids.mjs";
import * as mediaTranslationHelper from "../shared/trakt-translation-helper.mjs";
import * as cacheUtils from "../utils/cache.mjs";
import * as commonUtils from "../utils/common.mjs";

function ensurePeopleMediaIdsCacheEntry(linkCache, mediaType, traktId, options = {}) {
    return traktLinkIds.ensureMediaIdsCacheEntry(
        (requestMediaType, requestTraktId) => mediaTranslationHelper.fetchMediaDetail(requestMediaType, requestTraktId),
        (cache) => cacheUtils.saveLinkIdsCache(globalThis.$ctx.env, cache),
        linkCache,
        mediaType,
        traktId,
        options,
    );
}

function fetchTraktEpisodeDetail(ref) {
    return traktApiClientModule.fetchEpisodeDetail(ref);
}

async function resolvePeopleListTmdbId(target, linkCache) {
    if (!target || !linkCache) {
        return null;
    }

    if (target.mediaType === mediaTypes.MEDIA_TYPE.MOVIE || target.mediaType === mediaTypes.MEDIA_TYPE.SHOW) {
        const entry = await ensurePeopleMediaIdsCacheEntry(linkCache, target.mediaType, target.traktId);
        return commonUtils.isNonNullish(entry?.ids?.tmdb) ? entry.ids.tmdb : null;
    }

    if (target.mediaType === mediaTypes.MEDIA_TYPE.EPISODE) {
        const showEntry = await ensurePeopleMediaIdsCacheEntry(linkCache, mediaTypes.MEDIA_TYPE.SHOW, target.showTraktId);
        return commonUtils.isNonNullish(showEntry?.ids?.tmdb) ? showEntry.ids.tmdb : null;
    }

    return null;
}

async function resolvePeopleListMediaEntry(target, linkCache) {
    if (!target || !linkCache) {
        return null;
    }

    const options = { requiredIdFields: ["tmdb", "imdb"], requiredFields: ["language"] };
    if (target.mediaType === mediaTypes.MEDIA_TYPE.MOVIE || target.mediaType === mediaTypes.MEDIA_TYPE.SHOW) {
        return ensurePeopleMediaIdsCacheEntry(linkCache, target.mediaType, target.traktId, options);
    }

    if (target.mediaType === mediaTypes.MEDIA_TYPE.EPISODE) {
        // Use the show entry itself, not an episode showIds snapshot, so detail lookup can provide language.
        return ensurePeopleMediaIdsCacheEntry(linkCache, mediaTypes.MEDIA_TYPE.SHOW, target.showTraktId, options);
    }

    return null;
}

async function ensureFirstEpisodeIdsCacheEntry(linkCache, target) {
    if (!linkCache || !target || target.mediaType !== mediaTypes.MEDIA_TYPE.EPISODE || commonUtils.isNullish(target.showTraktId) || commonUtils.isNullish(target.seasonNumber)) {
        return null;
    }

    const cacheKey = `episode:first:${target.showTraktId}:${target.seasonNumber}`;
    const cached = traktLinkIds.getLinkIdsCacheEntry(linkCache, cacheKey);
    if (commonUtils.isPlainObject(cached?.ids) && commonUtils.isNonNullish(cached.ids.imdb)) {
        return cached;
    }

    const payload = await fetchTraktEpisodeDetail({
        showId: target.showTraktId,
        seasonNumber: target.seasonNumber,
        episodeNumber: 1,
    });
    if (!commonUtils.isPlainObject(payload)) {
        return null;
    }

    traktLinkIds.setLinkIdsCacheEntry(linkCache, cacheKey, {
        ids: payload.ids,
        showIds: { trakt: target.showTraktId },
        seasonNumber: payload?.season ?? target.seasonNumber,
        episodeNumber: payload?.number ?? 1,
    });
    cacheUtils.saveLinkIdsCache(globalThis.$ctx.env, linkCache);
    return traktLinkIds.getLinkIdsCacheEntry(linkCache, cacheKey);
}

export { ensureFirstEpisodeIdsCacheEntry, ensurePeopleMediaIdsCacheEntry, fetchTraktEpisodeDetail, resolvePeopleListMediaEntry, resolvePeopleListTmdbId };
