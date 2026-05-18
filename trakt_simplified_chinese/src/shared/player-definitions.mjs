import * as commonUtils from "../utils/common.mjs";

import * as mediaTypes from "./media-types.mjs";

const PLAYER_TYPE = {
    EPLAYERX: "eplayerx",
    FORWARD: "forward",
    INFUSE: "infuse",
};

// biome-ignore format: keep region codes compact for module readability.
const REGION_CODES = [
    "AD", "AE", "AG", "AL", "AO", "AR", "AT", "AU", "AZ", "BA", "BB", "BE", "BF", "BG", "BH", "BM", "BO", "BR", "BS", "BY",
    "BZ", "CA", "CD", "CH", "CI", "CL", "CM", "CO", "CR", "CU", "CV", "CY", "CZ", "DE", "DK", "DO", "DZ", "EC", "EE", "EG",
    "ES", "FI", "FJ", "FR", "GB", "GF", "GG", "GH", "GI", "GQ", "GR", "GT", "GY", "HK", "HN", "HR", "HU", "ID", "IE", "IL",
    "IN", "IQ", "IS", "IT", "JM", "JO", "JP", "KE", "KR", "KW", "LB", "LC", "LI", "LT", "LU", "LV", "LY", "MA", "MC", "MD",
    "ME", "MG", "MK", "ML", "MT", "MU", "MW", "MX", "MY", "MZ", "NE", "NG", "NI", "NL", "NO", "NZ", "OM", "PA", "PE", "PF",
    "PG", "PH", "PK", "PL", "PS", "PT", "PY", "QA", "RO", "RS", "RU", "SA", "SC", "SE", "SG", "SI", "SK", "SM", "SN", "SV",
    "TC", "TD", "TH", "TN", "TR", "TT", "TW", "TZ", "UA", "UG", "US", "UY", "VA", "VE", "XK", "YE", "ZA", "ZM", "ZW",
];

const PLAYER_LOGO_ASSET_BASE_URL = "https://raw.githubusercontent.com/DemoJameson/Proxy.Modules/main/trakt_simplified_chinese/images";

const PLAYER_DEFINITIONS = {
    [PLAYER_TYPE.EPLAYERX]: {
        type: PLAYER_TYPE.EPLAYERX,
        name: "EplayerX",
        homePage: "https://apps.apple.com/cn/app/eplayerx/id6747369377",
        logo: "eplayerx_logo.webp",
        color: "#33c1c0",
    },
    [PLAYER_TYPE.FORWARD]: {
        type: PLAYER_TYPE.FORWARD,
        name: "Forward",
        homePage: "https://apps.apple.com/cn/app/forward/id6503940939",
        logo: "forward_logo.webp",
        color: "#000000",
    },
    [PLAYER_TYPE.INFUSE]: {
        type: PLAYER_TYPE.INFUSE,
        name: "Infuse",
        homePage: "https://firecore.com/infuse",
        logo: "infuse_logo.webp",
        color: "#ff8000",
    },
};

const PLAYER_LAUNCHERS = {
    [PLAYER_TYPE.EPLAYERX]: buildEplayerXDeeplink,
    [PLAYER_TYPE.FORWARD]: buildForwardDeeplink,
    [PLAYER_TYPE.INFUSE]: buildInfuseDeeplink,
};

function buildInfuseDeeplink(target, deeplinkContext) {
    if (!target || !deeplinkContext) {
        return "";
    }

    if (target.mediaType === mediaTypes.MEDIA_TYPE.MOVIE && commonUtils.isNonNullish(deeplinkContext.tmdbId)) {
        return `infuse://movie/${deeplinkContext.tmdbId}`;
    }

    if (target.mediaType === mediaTypes.MEDIA_TYPE.SHOW && commonUtils.isNonNullish(deeplinkContext.tmdbId)) {
        return `infuse://series/${deeplinkContext.tmdbId}`;
    }

    if (
        target.mediaType === mediaTypes.MEDIA_TYPE.EPISODE &&
        commonUtils.isNonNullish(deeplinkContext.showTmdbId) &&
        commonUtils.isNonNullish(deeplinkContext.seasonNumber) &&
        commonUtils.isNonNullish(deeplinkContext.episodeNumber)
    ) {
        return `infuse://series/${deeplinkContext.showTmdbId}-${deeplinkContext.seasonNumber}-${deeplinkContext.episodeNumber}`;
    }

    return "";
}

function buildForwardDeeplink(target, deeplinkContext) {
    if (!target || !deeplinkContext) {
        return "";
    }

    const baseUrl = "https://fwds.cc/tmdb";

    if (target.mediaType === mediaTypes.MEDIA_TYPE.MOVIE && commonUtils.isNonNullish(deeplinkContext.tmdbId)) {
        return `${baseUrl}?type=movie&id=${deeplinkContext.tmdbId}`;
    }

    if (
        (target.mediaType === mediaTypes.MEDIA_TYPE.SHOW || target.mediaType === mediaTypes.MEDIA_TYPE.EPISODE) &&
        commonUtils.isNonNullish(deeplinkContext.showTmdbId ?? deeplinkContext.tmdbId)
    ) {
        const link = `${baseUrl}?type=tv&id=${deeplinkContext.showTmdbId ?? deeplinkContext.tmdbId}`;
        if (commonUtils.isNonNullish(deeplinkContext.seasonNumber)) {
            const seasonLink = `${link}&season=${deeplinkContext.seasonNumber}`;
            if (commonUtils.isNonNullish(deeplinkContext.episodeNumber)) {
                return `${seasonLink}&episode=${deeplinkContext.episodeNumber}`;
            }
            return seasonLink;
        }
        return link;
    }

    return "";
}

function buildEplayerXDeeplink(target, deeplinkContext) {
    if (!target || !deeplinkContext) {
        return "";
    }

    const baseUrl = "https://eplayerx.com/tmdb-info/detail";

    if (target.mediaType === mediaTypes.MEDIA_TYPE.MOVIE && commonUtils.isNonNullish(deeplinkContext.tmdbId)) {
        return `${baseUrl}?type=movie&id=${deeplinkContext.tmdbId}`;
    }

    if (
        (target.mediaType === mediaTypes.MEDIA_TYPE.SHOW || target.mediaType === mediaTypes.MEDIA_TYPE.EPISODE) &&
        commonUtils.isNonNullish(deeplinkContext.showTmdbId ?? deeplinkContext.tmdbId)
    ) {
        const link = `${baseUrl}?type=tv&id=${deeplinkContext.showTmdbId ?? deeplinkContext.tmdbId}`;
        if (commonUtils.isNonNullish(deeplinkContext.seasonNumber)) {
            const seasonLink = `${link}&traktSeason=${deeplinkContext.seasonNumber}`;
            if (commonUtils.isNonNullish(deeplinkContext.episodeNumber)) {
                return `${seasonLink}&traktEpisode=${deeplinkContext.episodeNumber}`;
            }
            return seasonLink;
        }
        return link;
    }

    return "";
}

function buildPlayerDeeplink(source, target, deeplinkContext) {
    const builder = PLAYER_LAUNCHERS[source];
    return typeof builder === "function" ? builder(target, deeplinkContext) : "";
}

export { buildPlayerDeeplink, PLAYER_DEFINITIONS, PLAYER_LAUNCHERS, PLAYER_LOGO_ASSET_BASE_URL, PLAYER_TYPE, REGION_CODES };
