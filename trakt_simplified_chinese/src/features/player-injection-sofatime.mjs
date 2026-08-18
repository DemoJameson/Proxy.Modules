import * as mediaTypes from "../shared/media-types.mjs";
import * as playerDefinitions from "../shared/player-definitions.mjs";
import * as commonUtils from "../utils/common.mjs";
import * as httpUtils from "../utils/http.mjs";

const TMDB_PROVIDER_ID_BY_SOURCE = {
    [playerDefinitions.PLAYER_TYPE.EPLAYERX]: 1,
    [playerDefinitions.PLAYER_TYPE.FORWARD]: 2,
    [playerDefinitions.PLAYER_TYPE.INFUSE]: 3,
};

function createZeroPriorityMap(regionCodes) {
    return commonUtils.ensureArray(regionCodes).reduce((acc, regionCode) => {
        const code = String(regionCode ?? "")
            .trim()
            .toUpperCase();
        if (code) {
            acc[code] = 0;
        }
        return acc;
    }, {});
}

const TMDB_PROVIDER_LIST_ENTRIES = Object.values(playerDefinitions.PLAYER_TYPE).map((source) => {
    const definition = playerDefinitions.PLAYER_DEFINITIONS[source];
    return {
        display_priorities: createZeroPriorityMap(playerDefinitions.REGION_CODES),
        display_priority: 0,
        logo_path: `/${definition.logo}`,
        provider_name: definition.name,
        provider_id: TMDB_PROVIDER_ID_BY_SOURCE[source],
    };
});

function isSofaTimeRequest() {
    return /^Sofa(?:\s|%20)Time/i.test(String(httpUtils.getRequestHeaderValue("user-agent") ?? "").trim());
}

function resolveTmdbDetailTarget(url) {
    const match = commonUtils.normalizePathname(url?.pathname).match(/^3\/(tv|movie)\/(\d+)$/i);
    if (!match) {
        return null;
    }

    const isShow = match[1].toLowerCase() === "tv";
    const tmdbId = Number(match[2]);
    if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
        return null;
    }

    return {
        mediaType: isShow ? mediaTypes.MEDIA_TYPE.SHOW : mediaTypes.MEDIA_TYPE.MOVIE,
        tmdbId,
        showTmdbId: isShow ? tmdbId : null,
    };
}

function createTmdbWatchProviderEntry(source) {
    const definition = playerDefinitions.PLAYER_DEFINITIONS[source];
    if (!definition) {
        return null;
    }

    return {
        logo_path: `/${definition.logo}`,
        provider_id: TMDB_PROVIDER_ID_BY_SOURCE[source],
        provider_name: definition.name,
        display_priority: 1,
    };
}

function injectTmdbWatchProviders(payload, source, target) {
    const watchProviders = commonUtils.isPlainObject(payload?.["watch/providers"]) ? payload["watch/providers"] : null;
    if (!watchProviders) {
        return false;
    }

    const deeplink = playerDefinitions.buildPlayerDeeplink(source, target, {
        tmdbId: target.tmdbId,
        showTmdbId: commonUtils.isNonNullish(target.showTmdbId) ? target.showTmdbId : null,
    });
    if (!deeplink) {
        return false;
    }

    const entry = createTmdbWatchProviderEntry(source);
    if (!entry) {
        return false;
    }

    const results = commonUtils.isPlainObject(watchProviders.results) ? watchProviders.results : {};
    const regionCodes = Object.keys(results).length > 0 ? Object.keys(results) : playerDefinitions.REGION_CODES;
    regionCodes.forEach((regionCode) => {
        const regionKey = String(regionCode ?? "");
        const regionEntry = commonUtils.isPlainObject(results[regionKey]) ? results[regionKey] : {};
        delete regionEntry.buy;
        delete regionEntry.rent;
        delete regionEntry.free;
        delete regionEntry.ads;
        regionEntry.link = deeplink;
        regionEntry.flatrate = [commonUtils.cloneObject(entry)];
        results[regionKey] = regionEntry;
    });
    watchProviders.results = results;
    return true;
}

function injectTmdbProviderCatalog(payload, orderedPlayerTypes) {
    if (!commonUtils.isPlainObject(payload)) {
        return payload;
    }

    const results = commonUtils.ensureArray(payload.results).slice();
    const filteredResults = results.filter((item) => {
        const providerId = item?.provider_id ? Number(item.provider_id) : NaN;
        const providerName = item?.provider_name ? String(item.provider_name).toLowerCase() : "";
        return !TMDB_PROVIDER_LIST_ENTRIES.some((entry) => {
            return providerId === entry.provider_id || providerName === String(entry.provider_name).toLowerCase();
        });
    });

    const entriesBySource = Object.fromEntries(Object.values(playerDefinitions.PLAYER_TYPE).map((source, index) => [source, TMDB_PROVIDER_LIST_ENTRIES[index]]));
    const playerEntries = commonUtils
        .ensureArray(orderedPlayerTypes)
        .map((source) => entriesBySource[source])
        .filter(Boolean)
        .map((entry) => commonUtils.cloneObject(entry));
    payload.results = [...playerEntries, ...filteredResults];
    return payload;
}

async function handleTmdbProviderCatalog() {
    if (!isSofaTimeRequest()) {
        return { type: "passThrough" };
    }

    const payload = JSON.parse(globalThis.$ctx.responseBody);
    const orderedPlayerTypes = globalThis.$ctx.argument?.orderedPlayerTypes;
    return {
        type: "respond",
        body: JSON.stringify(injectTmdbProviderCatalog(payload, orderedPlayerTypes)),
    };
}

async function handleTmdbDetailWatchProviders() {
    const context = globalThis.$ctx;
    if (!isSofaTimeRequest()) {
        return { type: "passThrough" };
    }

    const appendToResponse = String(context.url?.searchParams?.get("append_to_response") ?? "");
    if (!appendToResponse.toLowerCase().includes("watch/providers")) {
        return { type: "passThrough" };
    }

    const target = resolveTmdbDetailTarget(context.url);
    if (!target) {
        return { type: "passThrough" };
    }

    const source = commonUtils.ensureArray(context.argument?.enabledPlayerTypes)[0];
    if (!source) {
        return { type: "passThrough" };
    }

    const payload = JSON.parse(context.responseBody);
    if (!injectTmdbWatchProviders(payload, source, target)) {
        return { type: "passThrough" };
    }

    return {
        type: "respond",
        body: JSON.stringify(payload),
    };
}

export { handleTmdbDetailWatchProviders, handleTmdbProviderCatalog };
