import * as commonUtils from "../utils/common.mjs";

import * as mediaTypes from "./media-types.mjs";

const ALLOWED_ID_FIELDS = ["trakt", "tmdb", "imdb"];

function normalizeIds(ids) {
    const source = commonUtils.ensureObject(ids);
    const normalized = {};
    ALLOWED_ID_FIELDS.forEach((field) => {
        if (commonUtils.isNonNullish(source[field])) {
            normalized[field] = source[field];
        }
    });
    return Object.keys(normalized).length > 0 ? normalized : null;
}

function getLinkIdsCacheEntry(cache, traktId) {
    if (!cache || commonUtils.isNullish(traktId)) {
        return null;
    }

    const entry = cache[String(traktId)];
    return commonUtils.isPlainObject(entry) ? entry : null;
}

function mergeLinkIdsCacheEntry(currentEntry, nextEntry) {
    const current = commonUtils.ensureObject(currentEntry);
    const incoming = commonUtils.ensureObject(nextEntry);
    const merged = {};
    const mergedIds = normalizeIds({ ...commonUtils.ensureObject(current.ids), ...commonUtils.ensureObject(incoming.ids) });
    const mergedShowIds = normalizeIds({ ...commonUtils.ensureObject(current.showIds), ...commonUtils.ensureObject(incoming.showIds) });

    if (mergedIds) {
        merged.ids = mergedIds;
    }

    if (mergedShowIds) {
        merged.showIds = mergedShowIds;
    }

    if (commonUtils.isNonNullish(incoming.seasonNumber)) {
        merged.seasonNumber = Number(incoming.seasonNumber);
    } else if (commonUtils.isNonNullish(current.seasonNumber)) {
        merged.seasonNumber = Number(current.seasonNumber);
    }

    if (commonUtils.isNonNullish(incoming.episodeNumber)) {
        merged.episodeNumber = Number(incoming.episodeNumber);
    } else if (commonUtils.isNonNullish(current.episodeNumber)) {
        merged.episodeNumber = Number(current.episodeNumber);
    }

    if (commonUtils.isNonNullish(incoming.language)) {
        merged.language = incoming.language;
    } else if (commonUtils.isNonNullish(current.language)) {
        merged.language = current.language;
    }

    if (commonUtils.isNonNullish(incoming.country)) {
        merged.country = incoming.country;
    } else if (commonUtils.isNonNullish(current.country)) {
        merged.country = current.country;
    }

    const incomingTitle = String(incoming.title ?? "").trim();
    const currentTitle = String(current.title ?? "").trim();
    if (incomingTitle) {
        merged.title = incomingTitle;
    } else if (currentTitle) {
        merged.title = currentTitle;
    }

    return merged;
}

function setLinkIdsCacheEntry(cache, traktId, entry) {
    if (!cache || commonUtils.isNullish(traktId) || !commonUtils.isPlainObject(entry)) {
        return false;
    }

    const key = String(traktId);
    const current = getLinkIdsCacheEntry(cache, key);
    const next = mergeLinkIdsCacheEntry(current, entry);
    const previousJson = current ? JSON.stringify(current) : "";
    const nextJson = JSON.stringify(next);

    if (previousJson === nextJson) {
        return false;
    }

    cache[key] = next;
    return true;
}

function buildFallbackShowIds(showTraktId, linkCache) {
    if (commonUtils.isNullish(showTraktId)) {
        return null;
    }

    const showEntry = getLinkIdsCacheEntry(linkCache, showTraktId);
    if (commonUtils.isPlainObject(showEntry?.ids)) {
        return normalizeIds(showEntry.ids);
    }

    return {
        trakt: showTraktId,
    };
}

function cacheMediaIdsFromDetailResponse(linkCache, mediaType, ref, data) {
    if (!linkCache || !data || typeof data !== "object") {
        return false;
    }

    if (mediaType === mediaTypes.MEDIA_TYPE.MOVIE || mediaType === mediaTypes.MEDIA_TYPE.SHOW) {
        const traktId = data?.ids?.trakt ?? null;
        return setLinkIdsCacheEntry(linkCache, traktId, {
            ids: normalizeIds(data.ids),
            language: data?.language ?? null,
            country: data?.country ?? null,
            title: data?.title ?? null,
        });
    }

    if (mediaType === mediaTypes.MEDIA_TYPE.EPISODE) {
        const episodeTraktId = data?.ids?.trakt ?? null;
        if (commonUtils.isNullish(episodeTraktId)) {
            return false;
        }

        return setLinkIdsCacheEntry(linkCache, episodeTraktId, {
            ids: normalizeIds(data.ids),
            showIds: buildFallbackShowIds(ref?.showId, linkCache),
            seasonNumber: commonUtils.isNonNullish(data.season) ? data.season : ref?.seasonNumber,
            episodeNumber: commonUtils.isNonNullish(data.number) ? data.number : ref?.episodeNumber,
        });
    }

    return false;
}

function cacheEpisodeIdsFromSeasonList(linkCache, showId, seasons) {
    if (!linkCache || commonUtils.isNotArray(seasons)) {
        return false;
    }

    let changed = false;
    const showIds = buildFallbackShowIds(showId, linkCache);

    seasons.forEach((season) => {
        const episodes = commonUtils.ensureArray(season?.episodes);
        episodes.forEach((episode) => {
            const episodeTraktId = episode?.ids?.trakt ?? null;
            if (commonUtils.isNullish(episodeTraktId)) {
                return;
            }

            if (
                setLinkIdsCacheEntry(linkCache, episodeTraktId, {
                    ids: normalizeIds(episode.ids),
                    showIds: commonUtils.cloneObject(showIds),
                    seasonNumber: episode?.season ?? null,
                    episodeNumber: episode?.number ?? null,
                })
            ) {
                changed = true;
            }
        });
    });

    return changed;
}

function hasRequiredIds(entry, requiredIdFields = ["tmdb"]) {
    if (!commonUtils.isPlainObject(entry?.ids)) {
        return false;
    }

    return commonUtils.ensureArray(requiredIdFields).every((field) => commonUtils.isNonNullish(entry.ids[field]));
}

function hasRequiredFields(entry, requiredFields = []) {
    if (!commonUtils.isPlainObject(entry)) {
        return false;
    }

    return commonUtils.ensureArray(requiredFields).every((field) => String(entry[field] ?? "").trim());
}

async function ensureMediaIdsCacheEntry(fetchMediaDetail, saveLinkIdsCache, linkCache, mediaType, traktId, options = {}) {
    if (!linkCache || commonUtils.isNullish(traktId)) {
        return null;
    }

    let entry = getLinkIdsCacheEntry(linkCache, traktId);
    if (hasRequiredIds(entry, options.requiredIdFields) && hasRequiredFields(entry, options.requiredFields)) {
        return entry;
    }

    const payload = await fetchMediaDetail(mediaType, traktId);
    if (commonUtils.isPlainObject(payload)) {
        setLinkIdsCacheEntry(linkCache, traktId, {
            ids: normalizeIds(payload.ids),
            language: payload?.language ?? null,
            country: payload?.country ?? null,
            title: payload?.title ?? null,
        });
        saveLinkIdsCache(linkCache);
        entry = getLinkIdsCacheEntry(linkCache, traktId);
    }

    return entry;
}

async function ensureEpisodeShowIds(fetchMediaDetail, saveLinkIdsCache, linkCache, episodeTraktId, episodeEntry) {
    if (!linkCache || commonUtils.isNullish(episodeTraktId) || !episodeEntry || !commonUtils.isPlainObject(episodeEntry.showIds)) {
        return commonUtils.isPlainObject(episodeEntry?.showIds) ? episodeEntry.showIds : null;
    }

    if (commonUtils.isNonNullish(episodeEntry.showIds.tmdb) || commonUtils.isNullish(episodeEntry.showIds.trakt)) {
        return episodeEntry.showIds;
    }

    const showEntry = await ensureMediaIdsCacheEntry(fetchMediaDetail, saveLinkIdsCache, linkCache, mediaTypes.MEDIA_TYPE.SHOW, episodeEntry.showIds.trakt);
    if (!showEntry || !commonUtils.isPlainObject(showEntry.ids)) {
        return episodeEntry.showIds;
    }

    setLinkIdsCacheEntry(linkCache, episodeTraktId, {
        showIds: commonUtils.cloneObject(showEntry.ids),
    });
    saveLinkIdsCache(linkCache);
    return showEntry.ids;
}

export { cacheEpisodeIdsFromSeasonList, cacheMediaIdsFromDetailResponse, ensureEpisodeShowIds, ensureMediaIdsCacheEntry, getLinkIdsCacheEntry, setLinkIdsCacheEntry };
