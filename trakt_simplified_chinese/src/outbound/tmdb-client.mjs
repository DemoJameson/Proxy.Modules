import * as mediaTypes from "../shared/media-types.mjs";
import * as commonUtils from "../utils/common.mjs";
import * as httpUtils from "../utils/http.mjs";

const TMDB_API_BASE_URL = "https://api.tmdb.org/3";
const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p";
const TMDB_API_KEY = "a0a4d50000eeb10604c5f9342c8b3f62";

function fetchCredits(mediaType, tmdbId) {
    if (commonUtils.isNullish(tmdbId)) {
        return Promise.resolve(null);
    }

    const normalizedMediaType = mediaType === mediaTypes.MEDIA_TYPE.MOVIE ? "movie" : "tv";
    const appendField = mediaType === mediaTypes.MEDIA_TYPE.MOVIE ? "credits" : "aggregate_credits";
    return httpUtils.fetchJson(`${TMDB_API_BASE_URL}/${normalizedMediaType}/${tmdbId}?language=zh-CN&append_to_response=${appendField}&api_key=${TMDB_API_KEY}`, null, false);
}

function fetchPerson(tmdbPersonId) {
    if (commonUtils.isNullish(tmdbPersonId)) {
        return Promise.resolve(null);
    }

    return httpUtils.fetchJson(`${TMDB_API_BASE_URL}/person/${tmdbPersonId}?language=zh-CN&api_key=${TMDB_API_KEY}`, null, false);
}

function normalizeImageLanguage(language) {
    const languages = String(language ?? "")
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter((item, index, array) => /^[a-z]{2}$/.test(item) && array.indexOf(item) === index);
    return languages.length > 0 ? languages.join(",") : "zh";
}

function normalizeDetailMediaType(mediaType) {
    if (mediaType === mediaTypes.MEDIA_TYPE.MOVIE) {
        return "movie";
    }
    if (mediaType === mediaTypes.MEDIA_TYPE.SHOW) {
        return "tv";
    }
    return "";
}

function fetchDetails(mediaType, tmdbId) {
    if (commonUtils.isNullish(tmdbId)) {
        return Promise.resolve(null);
    }

    const normalizedMediaType = normalizeDetailMediaType(mediaType);
    if (!normalizedMediaType) {
        return Promise.resolve(null);
    }

    return httpUtils.fetchJson(`${TMDB_API_BASE_URL}/${normalizedMediaType}/${tmdbId}?api_key=${TMDB_API_KEY}`, null, false);
}

function fetchDetailsWithImages(mediaType, tmdbId) {
    if (commonUtils.isNullish(tmdbId)) {
        return Promise.resolve(null);
    }

    const normalizedMediaType = normalizeDetailMediaType(mediaType);
    if (!normalizedMediaType) {
        return Promise.resolve(null);
    }

    // 不带 language 参数：附加的 images 为全量，交由客户端按偏好语言本地过滤。
    return httpUtils.fetchJson(`${TMDB_API_BASE_URL}/${normalizedMediaType}/${tmdbId}?append_to_response=images&api_key=${TMDB_API_KEY}`, null, false);
}

function extractTmdbImagesPayload(detailPayload) {
    const images = commonUtils.isPlainObject(detailPayload?.images) ? detailPayload.images : {};
    return {
        posters: commonUtils.ensureArray(images.posters),
        logos: commonUtils.ensureArray(images.logos),
    };
}

function fetchImages(mediaType, tmdbId, language = "zh") {
    if (commonUtils.isNullish(tmdbId)) {
        return Promise.resolve(null);
    }

    const normalizedMediaType = normalizeDetailMediaType(mediaType);
    if (!normalizedMediaType) {
        return Promise.resolve(null);
    }

    return httpUtils.fetchJson(
        `${TMDB_API_BASE_URL}/${normalizedMediaType}/${tmdbId}/images?language=${encodeURIComponent(normalizeImageLanguage(language))}&api_key=${TMDB_API_KEY}`,
        null,
        false,
    );
}

function fetchSeasonImages(showTmdbId, seasonNumber, language = "zh") {
    if (commonUtils.isNullish(showTmdbId) || commonUtils.isNullish(seasonNumber)) {
        return Promise.resolve(null);
    }

    return httpUtils.fetchJson(
        `${TMDB_API_BASE_URL}/tv/${showTmdbId}/season/${seasonNumber}/images?language=${encodeURIComponent(normalizeImageLanguage(language))}&api_key=${TMDB_API_KEY}`,
        null,
        false,
    );
}

function buildImageUrl(filePath, size = "w780") {
    const normalizedPath = String(filePath ?? "").trim();
    if (!normalizedPath) {
        return "";
    }

    return `${TMDB_IMAGE_BASE_URL}/${size}${normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`}`;
}

function resizeImageUrl(url, size = "original") {
    const normalizedUrl = String(url ?? "").trim();
    if (!normalizedUrl) {
        return "";
    }

    return normalizedUrl.includes("/t/p/original/") ? normalizedUrl.replace("/t/p/original/", `/t/p/${size}/`) : "";
}

function buildPosterImageUrl(filePath, size = "w780") {
    return buildImageUrl(filePath, size);
}

export {
    buildImageUrl,
    buildPosterImageUrl,
    extractTmdbImagesPayload,
    fetchCredits,
    fetchDetails,
    fetchDetailsWithImages,
    fetchImages,
    fetchPerson,
    fetchSeasonImages,
    resizeImageUrl,
};
