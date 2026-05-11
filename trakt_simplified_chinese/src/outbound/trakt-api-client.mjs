import * as mediaTypes from "../shared/media-types.mjs";
import * as commonUtils from "../utils/common.mjs";
import * as httpUtils from "../utils/http.mjs";

function resolveTraktApiBaseUrl() {
    const origin = String(globalThis.$ctx.url?.origin ?? "");
    return /^https:\/\/apiz?\.trakt\.tv$/i.test(origin) ? origin : "";
}

function buildTranslationUrl(mediaType, ref) {
    const traktApiBaseUrl = resolveTraktApiBaseUrl();
    if (!traktApiBaseUrl) {
        return "";
    }
    if (mediaType === mediaTypes.MEDIA_TYPE.SHOW && commonUtils.isNonNullish(ref?.traktId)) {
        return `${traktApiBaseUrl}/shows/${ref.traktId}/translations/zh?extended=all`;
    }
    if (mediaType === mediaTypes.MEDIA_TYPE.MOVIE && commonUtils.isNonNullish(ref?.traktId)) {
        return `${traktApiBaseUrl}/movies/${ref.traktId}/translations/zh?extended=all`;
    }
    if (
        mediaType === mediaTypes.MEDIA_TYPE.EPISODE &&
        commonUtils.isNonNullish(ref?.showId) &&
        commonUtils.isNonNullish(ref?.seasonNumber) &&
        commonUtils.isNonNullish(ref?.episodeNumber)
    ) {
        return `${traktApiBaseUrl}/shows/${ref.showId}/seasons/${ref.seasonNumber}/episodes/${ref.episodeNumber}/translations/zh?extended=all`;
    }
    return "";
}

function buildMediaDetailUrl(mediaType, traktId) {
    const traktApiBaseUrl = resolveTraktApiBaseUrl();
    if (!traktApiBaseUrl || commonUtils.isNullish(traktId)) {
        return "";
    }
    if (mediaType === mediaTypes.MEDIA_TYPE.MOVIE) {
        return `${traktApiBaseUrl}/movies/${traktId}?extended=cloud9,full,watchnow`;
    }
    if (mediaType === mediaTypes.MEDIA_TYPE.SHOW) {
        return `${traktApiBaseUrl}/shows/${traktId}?extended=cloud9,full,watchnow`;
    }
    return "";
}

function buildEpisodeDetailUrl(ref) {
    const traktApiBaseUrl = resolveTraktApiBaseUrl();
    if (!traktApiBaseUrl || commonUtils.isNullish(ref?.showId) || commonUtils.isNullish(ref?.seasonNumber) || commonUtils.isNullish(ref?.episodeNumber)) {
        return "";
    }

    return `${traktApiBaseUrl}/shows/${ref.showId}/seasons/${ref.seasonNumber}/episodes/${ref.episodeNumber}?extended=cloud9,full,watchnow`;
}

async function fetchTranslationPayload(mediaType, ref, extraHeaders) {
    const url = buildTranslationUrl(mediaType, ref);
    const payload = await httpUtils.get({
        url,
        headers: httpUtils.buildRequestHeaders(extraHeaders),
    });
    const statusCode = httpUtils.getResponseStatusCode(payload);
    if (statusCode < 200 || statusCode >= 300) {
        throw new Error(`HTTP ${statusCode} for ${url}`);
    }

    const responseBody = commonUtils.isNullish(payload?.body) ? "" : String(payload.body);
    if (!responseBody.trim()) {
        return null;
    }

    try {
        return JSON.parse(responseBody);
    } catch (e) {
        throw new Error(`JSON parse failed for ${url}: ${e}`);
    }
}

function fetchMediaDetail(mediaType, traktId) {
    const url = buildMediaDetailUrl(mediaType, traktId);
    return url ? httpUtils.fetchJson(url) : Promise.resolve(null);
}

function fetchEpisodeDetail(ref) {
    const url = buildEpisodeDetailUrl(ref);
    return url ? httpUtils.fetchJson(url) : Promise.resolve(null);
}

export { fetchEpisodeDetail, fetchMediaDetail, fetchTranslationPayload };
