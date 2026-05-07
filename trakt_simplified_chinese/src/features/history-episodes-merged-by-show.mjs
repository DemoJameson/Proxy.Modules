import { URL } from "@nsnanocat/url";

import * as mediaTranslationHelper from "../shared/trakt-translation-helper.mjs";
import * as cacheUtils from "../utils/cache.mjs";
import * as commonUtils from "../utils/common.mjs";

const HISTORY_EPISODES_LIMIT = 500;
const RIPPPLE_HISTORY_MIN_LIMIT = 100;

function buildMinimumLimitRequestUrl(url, minimumLimit) {
    const normalizedMinimumLimit = Number(minimumLimit);
    const fallbackUrlStr = String(url.href);
    if (!Number.isFinite(normalizedMinimumLimit) || normalizedMinimumLimit <= 0) {
        return fallbackUrlStr;
    }

    try {
        const nextUrl = new URL(fallbackUrlStr);
        const currentLimit = Number(nextUrl.searchParams.get("limit"));
        if (!Number.isFinite(currentLimit) || currentLimit < normalizedMinimumLimit) {
            nextUrl.searchParams.set("limit", String(normalizedMinimumLimit));
        }

        return nextUrl.toString();
    } catch {
        return fallbackUrlStr;
    }
}

function isHistoryEpisodesListUrl(url) {
    return /^(?:users\/[^/]+\/history\/episodes|sync\/history\/episodes)$/.test(url.shortPathname);
}

function isBrowserUserAgent() {
    const userAgent = globalThis.$ctx.userAgent;
    return !!userAgent && /mozilla\/5\.0/i.test(userAgent);
}

function isRipppleUserAgent() {
    return /^Rippple/i.test(globalThis.$ctx.userAgent);
}

function isRipppleHistoryListUrl(url) {
    return /^users\/[^/]+\/history$/.test(url.shortPathname);
}

function shouldMergeHistoryEpisodesByShow(url) {
    const context = globalThis.$ctx;
    const resolvedUrl = url ?? context.url;
    return context.argument.historyEpisodesMergedByShow && !isBrowserUserAgent() && isHistoryEpisodesListUrl(resolvedUrl);
}

function shouldApplyRipppleHistoryLimit(url) {
    const resolvedUrl = url ?? globalThis.$ctx.url;
    return isRipppleUserAgent() && isRipppleHistoryListUrl(resolvedUrl);
}

function buildMergedHistoryEpisodesRequestUrl(url, shouldApply) {
    return shouldApply ? buildMinimumLimitRequestUrl(url, HISTORY_EPISODES_LIMIT) : String(url.href);
}

function buildRipppleHistoryRequestUrl(url, shouldApply) {
    return shouldApply ? buildMinimumLimitRequestUrl(url, RIPPPLE_HISTORY_MIN_LIMIT) : String(url.href);
}

function getHistoryShowBucketKey(url) {
    const searchParams = url?.searchParams;
    const queryEntries = searchParams && typeof searchParams.entries === "function" ? Array.from(searchParams.entries()) : [];
    const query = queryEntries
        .filter(([key]) => key !== "page" && key !== "limit")
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join("&");

    const pathname = url.shortPathname;
    return `${url.origin}${pathname ? `/${pathname}` : ""}${query ? `?${query}` : ""}`;
}

function getHistoryPageNumber(url) {
    const page = Number(url.searchParams.get("page"));
    return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
}

function getHistoryEpisodeShowKey(item) {
    const showId = item?.show?.ids?.trakt ?? null;
    return commonUtils.isNonNullish(showId) ? String(showId) : "";
}

function getHistoryEpisodeSortKey(item) {
    const episode = item?.episode ?? null;
    return {
        season: Number.isFinite(Number(episode?.season)) ? Number(episode.season) : -1,
        number: Number.isFinite(Number(episode?.number)) ? Number(episode.number) : -1,
    };
}

function filterHistoryEpisodesAcrossPages(arr, url, cache) {
    if (commonUtils.isNotArray(arr) || arr.length === 0 || !isHistoryEpisodesListUrl(url)) {
        return arr;
    }

    const nextCache = commonUtils.ensureObject(cache);
    const bucketKey = getHistoryShowBucketKey(url);
    const pageNumber = getHistoryPageNumber(url);
    if (pageNumber === 1) {
        delete nextCache[bucketKey];
    }

    const bucket = commonUtils.ensureObject(nextCache[bucketKey], { shows: {} });
    const cachedShows = commonUtils.ensureObject(bucket.shows);
    const filtered = arr.filter((item) => {
        const showKey = getHistoryEpisodeShowKey(item);
        return !showKey || pageNumber === 1 || !cachedShows[showKey];
    });

    filtered.forEach((item) => {
        const showKey = getHistoryEpisodeShowKey(item);
        if (showKey && !cachedShows[showKey]) {
            cachedShows[showKey] = true;
        }
    });

    bucket.shows = cachedShows;
    nextCache[bucketKey] = bucket;
    return {
        filtered,
        cache: nextCache,
    };
}

function mergeHistoryEpisodesByShow(arr) {
    if (commonUtils.isNotArray(arr) || arr.length === 0) {
        return commonUtils.ensureArray(arr);
    }

    const latestByShow = {};
    arr.forEach((item) => {
        const showKey = getHistoryEpisodeShowKey(item);
        if (!showKey) {
            return;
        }

        const current = latestByShow[showKey];
        if (!current) {
            latestByShow[showKey] = item;
            return;
        }

        const itemSortKey = getHistoryEpisodeSortKey(item);
        const currentSortKey = getHistoryEpisodeSortKey(current);
        if (itemSortKey.season > currentSortKey.season || (itemSortKey.season === currentSortKey.season && itemSortKey.number > currentSortKey.number)) {
            latestByShow[showKey] = item;
            return;
        }

        if (itemSortKey.season === currentSortKey.season && itemSortKey.number === currentSortKey.number) {
            const itemTimestamp = Date.parse(item?.watched_at ?? item?.listed_at ?? "");
            const currentTimestamp = Date.parse(current?.watched_at ?? current?.listed_at ?? "");
            if (Number.isFinite(itemTimestamp) && Number.isFinite(currentTimestamp) && itemTimestamp > currentTimestamp) {
                latestByShow[showKey] = item;
                return;
            }

            const itemHistoryId = item?.id ? Number(item.id) : 0;
            const currentHistoryId = current?.id ? Number(current.id) : 0;
            if (itemHistoryId > currentHistoryId) {
                latestByShow[showKey] = item;
            }
        }
    });

    return arr.filter((item) => {
        const showKey = getHistoryEpisodeShowKey(item);
        return showKey ? latestByShow[showKey] === item : true;
    });
}

function filterHistoryPagesWithCache(arr, url) {
    const context = globalThis.$ctx;
    const resolvedUrl = url ?? context.url;
    const result = filterHistoryEpisodesAcrossPages(arr, resolvedUrl, cacheUtils.loadHistoryShowsCache(context.env));
    if (result?.cache && result?.filtered) {
        cacheUtils.saveHistoryShowsCache(context.env, result.cache);
        return result.filtered;
    }

    return arr;
}

function processMergedHistoryEpisodeListBody(sourceBody, url) {
    const context = globalThis.$ctx;
    const resolvedUrl = url ?? context.url;
    if (!shouldMergeHistoryEpisodesByShow(resolvedUrl)) {
        return sourceBody;
    }

    try {
        return JSON.stringify(filterHistoryPagesWithCache(mergeHistoryEpisodesByShow(JSON.parse(sourceBody)), resolvedUrl));
    } catch (error) {
        context.env.log(`Trakt history episodes merge-by-show failed: ${error}`);
        return sourceBody;
    }
}

async function handleMergedHistoryEpisodesRewriteRequest() {
    const context = globalThis.$ctx;
    const isRippple = isRipppleHistoryListUrl(context.url);
    const shouldApply = isRippple ? shouldApplyRipppleHistoryLimit(context.url) : shouldMergeHistoryEpisodesByShow(context.url);
    if (!shouldApply) {
        return { type: "passThrough" };
    }
    return {
        type: "rewriteRequest",
        url: (isRippple ? buildRipppleHistoryRequestUrl : buildMergedHistoryEpisodesRequestUrl)(context.url, true),
    };
}

async function handleMergedHistoryEpisodeList() {
    const context = globalThis.$ctx;
    const historyBody = processMergedHistoryEpisodeListBody(context.responseBody, context.url);

    return mediaTranslationHelper.translateWrapperItems(historyBody);
}

export { handleMergedHistoryEpisodeList, handleMergedHistoryEpisodesRewriteRequest, shouldApplyRipppleHistoryLimit, shouldMergeHistoryEpisodesByShow };
