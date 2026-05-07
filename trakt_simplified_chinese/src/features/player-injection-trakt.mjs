import * as mediaTypes from "../shared/media-types.mjs";
import * as playerDefinitions from "../shared/player-definitions.mjs";
import * as traktLinkIds from "../shared/trakt-link-ids.mjs";
import * as traktTranslationHelper from "../shared/trakt-translation-helper.mjs";
import * as cacheUtils from "../utils/cache.mjs";
import * as commonUtils from "../utils/common.mjs";

const WATCHNOW_REDIRECT_URL = "https://proxy-modules.demojameson.de5.net/api/redirect";
const SHORTCUTS_OPENLINK_URL = `shortcuts://run-shortcut?name=${encodeURIComponent("打开链接")}&input=text&text=`;

const WATCHNOW_DEFAULT_REGION = "us";
const WATCHNOW_DEFAULT_CURRENCY = "usd";

function createSourceDefinition(source, name, color) {
    return {
        source,
        name,
        free: true,
        cinema: false,
        amazon: false,
        link_count: 99999,
        color,
        images: {
            logo: `raw.githubusercontent.com/DemoJameson/Proxy.Modules/main/trakt_simplified_chinese/images/${source}.webp`,
            logo_colorized: null,
            channel: null,
        },
    };
}

function createWatchnowLinkEntry(source, link) {
    return {
        source,
        link,
        uhd: false,
        curreny: WATCHNOW_DEFAULT_CURRENCY,
        currency: WATCHNOW_DEFAULT_CURRENCY,
        prices: {
            rent: null,
            purchase: null,
        },
    };
}

function buildWatchnowFavoriteSource(source, regionCode) {
    return `${regionCode || WATCHNOW_DEFAULT_REGION}-${source}`;
}

function buildWatchnowRedirectLink(deeplink) {
    return deeplink ? `${WATCHNOW_REDIRECT_URL}?deeplink=${encodeURIComponent(deeplink)}` : "";
}

function buildShortcutsJumpLink(deeplink) {
    return deeplink ? `${SHORTCUTS_OPENLINK_URL}${encodeURIComponent(deeplink)}` : "";
}

function fetchMediaDetail(mediaType, traktId) {
    return traktTranslationHelper.fetchMediaDetail(mediaType, traktId);
}

function ensureMediaIdsCacheEntry(linkCache, mediaType, traktId) {
    return traktLinkIds.ensureMediaIdsCacheEntry(fetchMediaDetail, (cache) => cacheUtils.saveLinkIdsCache(globalThis.$ctx.env, cache), linkCache, mediaType, traktId);
}

function ensureEpisodeShowIds(linkCache, episodeTraktId, episodeEntry) {
    return traktLinkIds.ensureEpisodeShowIds(fetchMediaDetail, (cache) => cacheUtils.saveLinkIdsCache(globalThis.$ctx.env, cache), linkCache, episodeTraktId, episodeEntry);
}

function resolveWatchnowRegion(watchnow) {
    const country = String(watchnow?.country ?? "")
        .trim()
        .toLowerCase();
    return country || WATCHNOW_DEFAULT_REGION;
}

function injectWatchnowFavoriteSources(items, regionCode) {
    const favorites = commonUtils.ensureArray(items).slice();
    const resolvedRegionCode = String(regionCode || WATCHNOW_DEFAULT_REGION)
        .trim()
        .toLowerCase();
    const filtered = favorites.filter((item) => {
        const normalized = String(item ?? "").toLowerCase();
        return !Object.values(playerDefinitions.PLAYER_TYPE).some((source) => {
            return normalized === buildWatchnowFavoriteSource(source, resolvedRegionCode);
        });
    });

    Object.values(playerDefinitions.PLAYER_TYPE)
        .slice()
        .reverse()
        .forEach((source) => {
            filtered.unshift(buildWatchnowFavoriteSource(source, resolvedRegionCode));
        });
    return filtered;
}

function filterOutCustomSources(items) {
    return commonUtils.ensureArray(items).filter((item) => {
        const source = item?.source ? String(item.source).toLowerCase() : "";
        return !Object.values(playerDefinitions.PLAYER_TYPE).includes(source);
    });
}

function injectCustomSourcesIntoList(items) {
    return Object.values(playerDefinitions.PLAYER_TYPE)
        .slice()
        .reverse()
        .map((source) => {
            const definition = playerDefinitions.PLAYER_DEFINITIONS[source];
            return createSourceDefinition(definition.type, definition.name, definition.color);
        })
        .concat(filterOutCustomSources(items));
}

function ensureWatchnowSourcesDefaultRegion(payload) {
    if (commonUtils.isNotArray(payload)) {
        return payload;
    }

    const hasDefaultRegion = payload.some((item) => {
        return commonUtils.isPlainObject(item) && commonUtils.isArray(item[WATCHNOW_DEFAULT_REGION]);
    });

    if (!hasDefaultRegion) {
        payload.push({
            [WATCHNOW_DEFAULT_REGION]: [],
        });
    }

    return payload;
}

function injectWatchnowSourcesPayload(payload) {
    payload = ensureWatchnowSourcesDefaultRegion(payload);

    if (commonUtils.isArray(payload)) {
        payload.forEach((item) => {
            if (!commonUtils.isPlainObject(item)) {
                return;
            }

            Object.keys(item).forEach((regionCode) => {
                if (commonUtils.isNotArray(item[regionCode])) {
                    return;
                }

                item[regionCode] = injectCustomSourcesIntoList(item[regionCode]);
            });
        });

        return payload;
    }

    if (!commonUtils.isPlainObject(payload)) {
        return payload;
    }

    Object.keys(payload).forEach((regionCode) => {
        if (commonUtils.isNotArray(payload[regionCode])) {
            return;
        }

        payload[regionCode] = injectCustomSourcesIntoList(payload[regionCode]);
    });

    return payload;
}

function resolveWatchnowTarget(url) {
    const normalizedPath = url.shortPathname;
    let match = normalizedPath.match(/^movies\/(\d+)\/watchnow$/);
    if (match) {
        return { mediaType: mediaTypes.MEDIA_TYPE.MOVIE, traktId: match[1] };
    }

    match = normalizedPath.match(/^shows\/(\d+)\/watchnow$/);
    if (match) {
        return { mediaType: mediaTypes.MEDIA_TYPE.SHOW, traktId: match[1] };
    }

    match = normalizedPath.match(/^episodes\/(\d+)\/watchnow$/);
    if (match) {
        return { mediaType: mediaTypes.MEDIA_TYPE.EPISODE, traktId: match[1] };
    }

    return null;
}

function buildCustomWatchnowEntries(target, watchnowContext, enabledPlayerTypes) {
    if (!target || !watchnowContext) {
        return [];
    }

    return commonUtils
        .ensureArray(enabledPlayerTypes)
        .map((source) => {
            const definition = playerDefinitions.PLAYER_DEFINITIONS[source];
            if (!definition) {
                return null;
            }

            const deeplink = playerDefinitions.buildPlayerDeeplink(source, target, watchnowContext);
            if (!deeplink) {
                return null;
            }

            const link = buildWatchnowRedirectLink(deeplink);
            return link ? createWatchnowLinkEntry(source, link) : null;
        })
        .filter(Boolean);
}

function injectCustomWatchnowEntriesIntoRegion(regionData, customEntries) {
    const nextRegion = commonUtils.ensureObject(regionData);
    const currentFree = commonUtils.ensureArray(nextRegion.free);
    nextRegion.free = customEntries.concat(filterOutCustomSources(currentFree));
    return nextRegion;
}

function ensureWatchnowAllRegions(payload, regionCodes) {
    if (!commonUtils.isPlainObject(payload)) {
        return payload;
    }

    const finalRegionCodes = Array.from(new Set(commonUtils.ensureArray(regionCodes).concat(Object.keys(payload))));
    finalRegionCodes.forEach((regionCode) => {
        const normalizedRegionCode = String(regionCode ?? "")
            .trim()
            .toLowerCase();
        if (!normalizedRegionCode) {
            return;
        }

        if (!commonUtils.isPlainObject(payload[normalizedRegionCode])) {
            payload[normalizedRegionCode] = {};
        }
    });

    return payload;
}

function injectWatchnowPayload(payload, target, watchnowContext, enabledPlayerTypes) {
    const customEntries = buildCustomWatchnowEntries(target, watchnowContext, enabledPlayerTypes);
    if (commonUtils.isNotArray(customEntries) || customEntries.length === 0) {
        return payload;
    }

    payload = ensureWatchnowAllRegions(payload, playerDefinitions.REGION_CODES);
    if (!commonUtils.isPlainObject(payload)) {
        return payload;
    }

    Object.keys(payload).forEach((regionCode) => {
        payload[regionCode] = injectCustomWatchnowEntriesIntoRegion(payload[regionCode], customEntries);
    });

    return payload;
}

async function resolveWatchnowContext(target, linkCache) {
    if (!target || !linkCache) {
        return null;
    }

    if (target.mediaType === mediaTypes.MEDIA_TYPE.MOVIE) {
        const movieEntry = await ensureMediaIdsCacheEntry(linkCache, mediaTypes.MEDIA_TYPE.MOVIE, target.traktId);
        return movieEntry?.ids && commonUtils.isNonNullish(movieEntry.ids.tmdb) ? { tmdbId: movieEntry.ids.tmdb } : null;
    }

    if (target.mediaType === mediaTypes.MEDIA_TYPE.SHOW) {
        const showEntry = await ensureMediaIdsCacheEntry(linkCache, mediaTypes.MEDIA_TYPE.SHOW, target.traktId);
        return showEntry?.ids && commonUtils.isNonNullish(showEntry.ids.tmdb) ? { tmdbId: showEntry.ids.tmdb, showTmdbId: showEntry.ids.tmdb } : null;
    }

    if (target.mediaType === mediaTypes.MEDIA_TYPE.EPISODE) {
        const episodeEntry = traktLinkIds.getLinkIdsCacheEntry(linkCache, target.traktId);
        if (!episodeEntry) {
            return null;
        }

        const showIds = await ensureEpisodeShowIds(linkCache, target.traktId, episodeEntry);
        return commonUtils.isPlainObject(showIds) && commonUtils.isNonNullish(showIds.tmdb)
            ? {
                  tmdbId: episodeEntry.ids?.tmdb,
                  showTmdbId: showIds.tmdb,
                  seasonNumber: episodeEntry.seasonNumber,
                  episodeNumber: episodeEntry.episodeNumber,
              }
            : null;
    }

    return null;
}

function injectUserSettingsPayload(data) {
    if (!data || typeof data !== "object") {
        return data;
    }

    data.user = commonUtils.ensureObject(data.user);
    data.user.vip = true;
    data.account = commonUtils.ensureObject(data.account);
    data.account.display_ads = false;
    data.browsing = commonUtils.ensureObject(data.browsing);
    data.browsing.watchnow = commonUtils.ensureObject(data.browsing.watchnow);
    data.browsing.watchnow.favorites = injectWatchnowFavoriteSources(data.browsing.watchnow.favorites, resolveWatchnowRegion(data.browsing.watchnow));
    return data;
}

function resolveDirectRedirectLocation(url) {
    try {
        const redirectUrl = new URL(WATCHNOW_REDIRECT_URL);
        const pathname = commonUtils.normalizePathname(url.pathname);
        const redirectPathname = commonUtils.normalizePathname(redirectUrl.pathname);

        if (String(url.hostname).toLowerCase() === String(redirectUrl.hostname).toLowerCase() && pathname === redirectPathname) {
            const deeplink = url.searchParams.get("deeplink");
            if (deeplink) {
                return decodeURIComponent(deeplink);
            }
        }

        if (String(url.hostname).toLowerCase() === "image.tmdb.org" && /^t\/p\/w342\/([a-z0-9_-]+)_logo\.webp$/i.test(pathname)) {
            const match = pathname.match(/^t\/p\/w342\/([a-z0-9_-]+)_logo\.webp$/i);
            if (match?.[1]) {
                return `${playerDefinitions.PLAYER_LOGO_ASSET_BASE_URL}/${match[1].toLowerCase()}_logo.webp`;
            }
        }
    } catch {
        return "";
    }

    return "";
}

function isWatchnowRedirectUrl(url) {
    try {
        const redirectUrl = new URL(WATCHNOW_REDIRECT_URL);
        return (
            String(url.hostname).toLowerCase() === String(redirectUrl.hostname).toLowerCase() &&
            commonUtils.normalizePathname(url.pathname) === commonUtils.normalizePathname(redirectUrl.pathname)
        );
    } catch {
        return false;
    }
}

async function handleWatchnow() {
    const context = globalThis.$ctx;
    const payload = JSON.parse(context.responseBody);
    const target = resolveWatchnowTarget(context.url);
    if (!target) {
        return { type: "passThrough" };
    }

    const linkCache = cacheUtils.loadLinkIdsCache(context.env);
    const watchnowContext = await resolveWatchnowContext(target, linkCache);
    return {
        type: "respond",
        body: JSON.stringify(injectWatchnowPayload(payload, target, watchnowContext, context.argument.enabledPlayerTypes)),
    };
}

async function handleWatchnowSources() {
    const payload = JSON.parse(globalThis.$ctx.responseBody);
    return {
        type: "respond",
        body: JSON.stringify(injectWatchnowSourcesPayload(payload)),
    };
}

async function handleUserSettings() {
    const data = JSON.parse(globalThis.$ctx.responseBody);
    const nextData = injectUserSettingsPayload(data);
    if (!nextData || typeof nextData !== "object") {
        return { type: "passThrough" };
    }

    return {
        type: "respond",
        body: JSON.stringify(nextData),
    };
}

async function handleDirectRedirectRequest() {
    const context = globalThis.$ctx;
    const location = resolveDirectRedirectLocation(context.url);
    if (location && context.argument.useShortcutsJumpEnabled && isWatchnowRedirectUrl(context.url)) {
        return {
            type: "redirect",
            location: buildShortcutsJumpLink(location),
        };
    }

    return location ? { type: "redirect", location } : { type: "passThrough" };
}

export { handleDirectRedirectRequest, handleUserSettings, handleWatchnow, handleWatchnowSources, WATCHNOW_REDIRECT_URL };
