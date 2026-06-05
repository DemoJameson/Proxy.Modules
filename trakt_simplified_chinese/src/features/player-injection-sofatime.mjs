import * as sofaTimeClientModule from "../outbound/sofatime-client.mjs";
import * as mediaTypes from "../shared/media-types.mjs";
import * as playerDefinitions from "../shared/player-definitions.mjs";
import * as commonUtils from "../utils/common.mjs";
import * as httpUtils from "../utils/http.mjs";

const FILM_SHOW_RATINGS_RAPIDAPI_HOST = "film-show-ratings.p.rapidapi.com";
const SOFA_TIME_COUNTRY_SERVICE_TYPES = {
    addon: true,
    buy: true,
    rent: true,
    free: true,
    subscription: true,
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
        provider_id: {
            [playerDefinitions.PLAYER_TYPE.EPLAYERX]: 1,
            [playerDefinitions.PLAYER_TYPE.FORWARD]: 2,
            [playerDefinitions.PLAYER_TYPE.INFUSE]: 3,
        }[source],
    };
});

function buildCustomPlayerImageSet(logoName) {
    return {
        lightThemeImage: `${playerDefinitions.PLAYER_LOGO_ASSET_BASE_URL}/${logoName}`,
        darkThemeImage: `${playerDefinitions.PLAYER_LOGO_ASSET_BASE_URL}/${logoName}`,
        whiteImage: `${playerDefinitions.PLAYER_LOGO_ASSET_BASE_URL}/${logoName}`,
    };
}

function createSofaTimeTemplate(definition) {
    return {
        service: {
            id: definition.type,
            name: definition.name,
            homePage: definition.homePage,
            themeColorCode: definition.color,
            imageSet: buildCustomPlayerImageSet(definition.logo),
        },
        type: "subscription",
        link: "",
        videoLink: "",
        quality: "hd",
        audios: [],
        subtitles: [],
        expiresSoon: false,
        availableSince: 0,
    };
}

function createSofaTimeCountryService(definition) {
    return {
        id: definition.type,
        name: definition.name,
        homePage: definition.homePage,
        themeColorCode: definition.color,
        imageSet: buildCustomPlayerImageSet(definition.logo),
        streamingOptionTypes: { ...SOFA_TIME_COUNTRY_SERVICE_TYPES },
        addons: [],
    };
}

function buildFilmShowRatingsHeaders() {
    const headers = {
        accept: "application/json",
        "x-rapidapi-host": FILM_SHOW_RATINGS_RAPIDAPI_HOST,
    };
    ["x-rapidapi-key", "x-rapidapi-ua", "user-agent", "accept-language", "accept-encoding"].forEach((headerName) => {
        const value = httpUtils.getRequestHeaderValue(headerName);
        if (value) {
            headers[headerName] = value;
        }
    });
    return headers;
}

function isSofaTimeRequest() {
    return /^Sofa(?:\s|%20)Time/i.test(String(httpUtils.getRequestHeaderValue("user-agent") ?? "").trim());
}

function resolveStreamingAvailabilityImdbId(url) {
    if (String(url?.hostname ?? "").toLowerCase() !== "streaming-availability.p.rapidapi.com") {
        return "";
    }

    const match = commonUtils.normalizePathname(url?.pathname).match(/^shows\/(tt\d+)$/i);
    return match?.[1] ?? "";
}

function isStreamingAvailabilityCountriesRequest(url) {
    return String(url?.hostname ?? "").toLowerCase() === "streaming-availability.p.rapidapi.com" && /^countries\/[a-z]{2}$/i.test(commonUtils.normalizePathname(url?.pathname));
}

function isStreamingAvailabilityShowRequest(url) {
    return String(url?.hostname ?? "").toLowerCase() === "streaming-availability.p.rapidapi.com" && /^shows\/tt\d+$/i.test(commonUtils.normalizePathname(url?.pathname));
}

function resolveStreamingAvailabilityTmdbTarget(payload, fallbackTarget) {
    const tmdbValue = payload?.tmdbId ? String(payload.tmdbId).trim() : "";
    const match = tmdbValue.match(/^(movie|tv)\/(\d+)$/i);
    if (!match) {
        return fallbackTarget;
    }

    const tmdbType = match[1].toLowerCase();
    const tmdbId = Number(match[2]);
    return {
        mediaType: tmdbType === "movie" ? mediaTypes.MEDIA_TYPE.MOVIE : mediaTypes.MEDIA_TYPE.SHOW,
        imdbId: fallbackTarget?.imdbId ?? "",
        tmdbId,
        showTmdbId: tmdbType === "tv" ? tmdbId : null,
    };
}

function resolveFilmShowRatingsMediaType(type) {
    const normalizedType = String(type ?? "")
        .trim()
        .toLowerCase();
    if (normalizedType === "show") {
        return mediaTypes.MEDIA_TYPE.SHOW;
    }
    if (normalizedType === "film") {
        return mediaTypes.MEDIA_TYPE.MOVIE;
    }
    return "";
}

async function resolveTmdbTargetByImdb(target) {
    const imdbId = String(target?.imdbId ?? "").trim();
    if (!imdbId) {
        return target;
    }

    try {
        const payload = await sofaTimeClientModule.fetchByImdbId(imdbId, buildFilmShowRatingsHeaders());
        const resolvedMediaType = resolveFilmShowRatingsMediaType(payload?.result?.type);
        const tmdbId = Number(payload?.result?.ids?.TMDB);
        if (!resolvedMediaType || !Number.isFinite(tmdbId) || tmdbId <= 0) {
            return target;
        }

        if (target?.mediaType === mediaTypes.MEDIA_TYPE.EPISODE && resolvedMediaType === mediaTypes.MEDIA_TYPE.SHOW) {
            return {
                ...target,
                mediaType: mediaTypes.MEDIA_TYPE.EPISODE,
                showTmdbId: tmdbId,
            };
        }

        if (resolvedMediaType === mediaTypes.MEDIA_TYPE.SHOW) {
            return {
                ...target,
                mediaType: mediaTypes.MEDIA_TYPE.SHOW,
                tmdbId,
                showTmdbId: tmdbId,
            };
        }

        if (resolvedMediaType === mediaTypes.MEDIA_TYPE.MOVIE) {
            return {
                ...target,
                mediaType: mediaTypes.MEDIA_TYPE.MOVIE,
                tmdbId,
            };
        }
    } catch (error) {
        globalThis.$ctx.env.log(`Film Show Ratings lookup failed for ${imdbId}: ${error}`);
    }

    return target;
}

function createSofaTimeStreamingOption(source, target) {
    const definition = playerDefinitions.PLAYER_DEFINITIONS[source];
    if (!definition || !target || commonUtils.isNullish(target.tmdbId)) {
        return null;
    }

    const context = {
        tmdbId: target.tmdbId,
        showTmdbId: commonUtils.isNonNullish(target.showTmdbId) ? target.showTmdbId : null,
    };
    const deeplink = playerDefinitions.buildPlayerDeeplink(source, target, context);
    if (!deeplink) {
        return null;
    }

    const option = createSofaTimeTemplate(definition);
    option.link = deeplink;
    option.videoLink = deeplink;
    return option;
}

function createSofaTimeStreamingOptionsByRegion(enabledPlayerTypes, regionCode, target) {
    void regionCode;
    return enabledPlayerTypes.map((source) => createSofaTimeStreamingOption(source, target)).filter(Boolean);
}

function rewriteStreamingOptionsMap(enabledPlayerTypes, target, streamingTarget) {
    if (!commonUtils.isPlainObject(target)) {
        return;
    }

    const streamingOptions = commonUtils.isPlainObject(target.streamingOptions) ? target.streamingOptions : {};
    const finalRegionCodes = Object.keys(streamingOptions).length > 0 ? Object.keys(streamingOptions) : playerDefinitions.REGION_CODES;
    finalRegionCodes.forEach((regionCode) => {
        const options = createSofaTimeStreamingOptionsByRegion(enabledPlayerTypes, regionCode, streamingTarget);
        if (options.length > 0) {
            streamingOptions[String(regionCode ?? "").toLowerCase()] = options;
        }
    });
    target.streamingOptions = streamingOptions;
}

async function injectSofaTimeStreamingAvailabilityPayload(enabledPlayerTypes, payload, requestUrl, statusCode) {
    const imdbId = resolveStreamingAvailabilityImdbId(requestUrl);
    if (!imdbId) {
        return {
            handled: false,
            payload,
        };
    }

    const target = { imdbId };
    let streamingTarget;

    if (statusCode >= 400) {
        streamingTarget = await resolveTmdbTargetByImdb(target);
    } else {
        streamingTarget = resolveStreamingAvailabilityTmdbTarget(payload, target);
    }

    if (commonUtils.isNonNullish(streamingTarget?.tmdbId) && streamingTarget?.mediaType === mediaTypes.MEDIA_TYPE.SHOW) {
        payload.tmdbId = `tv/${streamingTarget.tmdbId}`;
    }
    if (commonUtils.isNonNullish(streamingTarget?.tmdbId) && streamingTarget?.mediaType === mediaTypes.MEDIA_TYPE.MOVIE) {
        payload.tmdbId = `movie/${streamingTarget.tmdbId}`;
    }

    rewriteStreamingOptionsMap(enabledPlayerTypes, payload, streamingTarget);
    commonUtils.ensureArray(payload.seasons).forEach((season) => {
        if (!commonUtils.isPlainObject(season)) {
            return;
        }

        rewriteStreamingOptionsMap(enabledPlayerTypes, season, streamingTarget);
        commonUtils.ensureArray(season.episodes).forEach((episode) => {
            if (commonUtils.isPlainObject(episode)) {
                rewriteStreamingOptionsMap(enabledPlayerTypes, episode, streamingTarget);
            }
        });
    });

    return {
        handled: true,
        payload,
    };
}

function injectSofaTimeCountryServices(payload) {
    if (!commonUtils.isPlainObject(payload)) {
        return payload;
    }

    const services = commonUtils.ensureArray(payload.services).slice();
    const filteredServices = services.filter((service) => {
        const id = service?.id ? String(service.id).toLowerCase() : "";
        return !Object.values(playerDefinitions.PLAYER_TYPE).includes(id);
    });

    Object.values(playerDefinitions.PLAYER_TYPE)
        .slice()
        .reverse()
        .forEach((source) => {
            filteredServices.unshift(createSofaTimeCountryService(playerDefinitions.PLAYER_DEFINITIONS[source]));
        });
    payload.services = filteredServices;
    return payload;
}

function injectTmdbProviderCatalog(payload) {
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

    TMDB_PROVIDER_LIST_ENTRIES.slice()
        .reverse()
        .forEach((entry) => {
            filteredResults.unshift(commonUtils.cloneObject(entry));
        });
    payload.results = filteredResults;
    return payload;
}

async function handleTmdbProviderCatalog() {
    if (!isSofaTimeRequest()) {
        return { type: "passThrough" };
    }

    const payload = JSON.parse(globalThis.$ctx.responseBody);
    return {
        type: "respond",
        body: JSON.stringify(injectTmdbProviderCatalog(payload)),
    };
}

async function handleSofaTimeStreamingAvailabilityRequest() {
    const context = globalThis.$ctx;
    if (!isSofaTimeRequest() || !isStreamingAvailabilityShowRequest(context.url)) {
        return { type: "passThrough" };
    }

    if (!context.url.searchParams.has("country")) {
        return { type: "passThrough" };
    }

    const rewrittenUrl = new URL(context.env.request.url);
    rewrittenUrl.searchParams.delete("country");

    return {
        type: "rewriteRequest",
        url: rewrittenUrl.toString(),
    };
}

async function handleSofaTimeCountries() {
    const context = globalThis.$ctx;
    if (!isSofaTimeRequest()) {
        return { type: "passThrough" };
    }

    if (!isStreamingAvailabilityCountriesRequest(context.url)) {
        return { type: "passThrough" };
    }

    const payload = JSON.parse(context.responseBody);
    return {
        type: "respond",
        body: JSON.stringify(injectSofaTimeCountryServices(payload)),
    };
}

async function handleSofaTimeStreamingAvailability() {
    const context = globalThis.$ctx;
    if (!isSofaTimeRequest()) {
        return { type: "passThrough" };
    }

    const statusCode = Number(context.env.response.status || 0);
    const payload = commonUtils.ensureObject(context.env.toObj(context.responseBody));
    const result = await injectSofaTimeStreamingAvailabilityPayload(context.argument.enabledPlayerTypes, payload, context.url, statusCode);
    if (!result.handled) {
        return { type: "passThrough" };
    }

    if (statusCode >= 400 && commonUtils.isNonNullish(result.payload.tmdbId)) {
        return {
            type: "respond",
            status: 200,
            body: JSON.stringify(result.payload),
        };
    }

    return {
        type: "respond",
        body: JSON.stringify(result.payload),
    };
}

export { handleSofaTimeCountries, handleSofaTimeStreamingAvailability, handleSofaTimeStreamingAvailabilityRequest, handleTmdbProviderCatalog };
