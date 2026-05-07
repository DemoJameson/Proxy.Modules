import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runScriptLive } from "./run-script-live.mjs";

const TRAKT_BASE_URL = "https://api.trakt.tv";
const GOOGLE_TRANSLATE_HOST = "translation.googleapis.com";
const LIVE_HTTP_USER_AGENT = "TraktLiveTestHarness/1.0";
const LIVE_REQUEST_BATCH_SIZE = 10;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_CONFIG_PATH = path.resolve(__dirname, "..", "..", ".trakt-live-test.local.json");

function readSavedLiveConfig() {
    if (!fs.existsSync(LOCAL_CONFIG_PATH)) {
        return {};
    }

    try {
        const raw = fs.readFileSync(LOCAL_CONFIG_PATH, "utf8");
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

function getRequiredEnv(name) {
    const savedConfig = readSavedLiveConfig();
    const value = String(process.env[name] ?? savedConfig[name] ?? "").trim();
    assert.notEqual(value, "", `Missing required environment variable: ${name}`);
    return value;
}

function getOptionalEnv(name) {
    const savedConfig = readSavedLiveConfig();
    const value = String(process.env[name] ?? savedConfig[name] ?? "").trim();
    return value || "";
}

function getLiveConfig() {
    return {
        traktApiKey: getRequiredEnv("TRAKT_API_KEY"),
        traktApiVersion: getOptionalEnv("TRAKT_API_VERSION") || "2",
        backendBaseUrl: getRequiredEnv("TRAKT_BACKEND_BASE_URL").replace(/\/+$/, ""),
        traktOAuthToken: getOptionalEnv("TRAKT_OAUTH_TOKEN"),
        allowGoogleTranslate: /^true$/i.test(getOptionalEnv("LIVE_TEST_ALLOW_GOOGLE_TRANSLATE")),
    };
}

function hasOAuthToken(config) {
    return !!String(config?.traktOAuthToken ?? "").trim();
}

function createTraktHeaders(config, extraHeaders = {}) {
    const headers = {
        accept: "application/json",
        "content-type": "application/json",
        "trakt-api-key": config.traktApiKey,
        "trakt-api-version": config.traktApiVersion,
        ...extraHeaders,
    };

    if (config.traktOAuthToken) {
        headers.authorization = `Bearer ${config.traktOAuthToken}`;
    }

    return headers;
}

async function fetchText(url, init = {}) {
    const headers = {
        "user-agent": LIVE_HTTP_USER_AGENT,
        ...(init.headers ?? {}),
    };

    const response = await fetch(url, {
        ...init,
        headers,
    });
    const body = await response.text();
    return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body,
    };
}

async function fetchJson(url, init = {}) {
    const response = await fetchText(url, init);
    return {
        ...response,
        json: response.body ? JSON.parse(response.body) : null,
    };
}

async function fetchTraktJson(config, pathname, extraHeaders = {}) {
    return fetchJson(`${TRAKT_BASE_URL}${pathname}`, {
        headers: createTraktHeaders(config, extraHeaders),
    });
}

async function findFirstInBatches(items, batchSize, resolver) {
    const normalizedItems = Array.isArray(items) ? items : [];
    const normalizedBatchSize = Math.max(1, Number(batchSize) || 1);

    for (let index = 0; index < normalizedItems.length; index += normalizedBatchSize) {
        const batch = normalizedItems.slice(index, index + normalizedBatchSize);
        const results = await Promise.all(batch.map((item) => resolver(item)));
        const matchedIndex = results.findIndex((result) => result !== null && result !== undefined);
        if (matchedIndex !== -1) {
            return results[matchedIndex];
        }
    }

    return null;
}

function findFirstNestedEpisode(seasons, showId) {
    for (const season of Array.isArray(seasons) ? seasons : []) {
        for (const episode of Array.isArray(season?.episodes) ? season.episodes : []) {
            const seasonNumber = Number(season?.number);
            const episodeNumber = Number(episode?.number);
            const normalizedShowId = String(showId ?? "");

            if (normalizedShowId && Number.isFinite(seasonNumber) && Number.isFinite(episodeNumber)) {
                return {
                    showId: normalizedShowId,
                    seasonNumber,
                    episodeNumber,
                    episode,
                };
            }
        }
    }

    return null;
}

async function resolveMovieWithZhTranslation(config) {
    const trending = await fetchTraktJson(config, "/movies/trending?page=1&limit=10");
    assert.equal(trending.status, 200, "Failed to resolve trending movies");

    const matched = await findFirstInBatches(trending.json, LIVE_REQUEST_BATCH_SIZE, async (item) => {
        const traktId = String(item?.movie?.ids?.trakt ?? "");
        if (!traktId) {
            return null;
        }

        const translations = await fetchTraktJson(config, `/movies/${traktId}/translations/zh?extended=all`);
        if (translations.status === 200 && Array.isArray(translations.json) && translations.json.length > 0) {
            return {
                traktId,
                movie: item.movie,
                translations: translations.json,
            };
        }
        return null;
    });

    if (matched) {
        return matched;
    }

    throw new Error("Could not find a trending movie with zh translations");
}

async function resolveMovieWithWatchnow(config) {
    const trending = await fetchTraktJson(config, "/movies/trending?page=1&limit=10");
    assert.equal(trending.status, 200, "Failed to resolve trending movies");

    const matched = await findFirstInBatches(trending.json, LIVE_REQUEST_BATCH_SIZE, async (item) => {
        const traktId = String(item?.movie?.ids?.trakt ?? "");
        if (!traktId) {
            return null;
        }

        const watchnow = await fetchTraktJson(config, `/movies/${traktId}/watchnow`);
        if (watchnow.status === 401) {
            throw new Error("Trakt watchnow live test is unauthorized for the current token");
        }
        if (watchnow.status !== 200 || !watchnow.json || typeof watchnow.json !== "object") {
            return null;
        }

        const hasAnySources = Object.values(watchnow.json).some((group) => {
            return group && typeof group === "object" && Object.values(group).some((items) => Array.isArray(items));
        });

        if (hasAnySources) {
            return {
                traktId,
                movie: item.movie,
                watchnow: watchnow.json,
            };
        }
        return null;
    });

    if (matched) {
        return matched;
    }

    throw new Error("Could not find a trending movie with watchnow sources");
}

async function resolveShowEpisodeSample(config) {
    const trending = await fetchTraktJson(config, "/shows/trending?page=1&limit=10");
    assert.equal(trending.status, 200, "Failed to resolve trending shows");

    const matched = await findFirstInBatches(trending.json, LIVE_REQUEST_BATCH_SIZE, async (item) => {
        const traktId = String(item?.show?.ids?.trakt ?? "");
        if (!traktId) {
            return null;
        }

        const seasons = await fetchTraktJson(config, `/shows/${traktId}/seasons?extended=episodes,full`);
        if (seasons.status !== 200) {
            return null;
        }

        const firstEpisode = findFirstNestedEpisode(seasons.json, traktId);
        if (firstEpisode) {
            return {
                traktId,
                show: item.show,
                ...firstEpisode,
            };
        }
        return null;
    });

    if (matched) {
        return matched;
    }

    throw new Error("Could not find a trending show with nested episode data");
}

async function resolvePopularShowWithZhTranslation(config) {
    const popular = await fetchJson("https://apiz.trakt.tv/shows/popular?extended=cloud9,full&limit=100&local_name=%E7%83%AD%E9%97%A8%E5%89%A7%E9%9B%86&page=1&ratings=80-100", {
        headers: createTraktHeaders(config),
    });
    assert.equal(popular.status, 200, "Failed to resolve apiz popular shows");

    const matched = await findFirstInBatches(popular.json, LIVE_REQUEST_BATCH_SIZE, async (item) => {
        const targetShow = item?.show && typeof item.show === "object" ? item.show : item;
        const traktId = String(targetShow?.ids?.trakt ?? "");
        if (!traktId) {
            return null;
        }

        const translations = await fetchTraktJson(config, `/shows/${traktId}/translations/zh?extended=all`);
        if (translations.status === 200 && Array.isArray(translations.json) && translations.json.length > 0) {
            return {
                traktId,
                show: targetShow,
                listBody: popular.body,
                translations: translations.json,
            };
        }
        return null;
    });

    if (matched) {
        return matched;
    }

    throw new Error("Could not find a popular show with zh translations from apiz popular list");
}

async function resolvePopularMovieWithZhTranslation(config) {
    const popular = await fetchJson("https://apiz.trakt.tv/movies/popular?extended=cloud9,full&limit=100&local_name=%E7%83%AD%E9%97%A8%E7%94%B5%E5%BD%B1&page=1&ratings=80-100", {
        headers: createTraktHeaders(config),
    });
    assert.equal(popular.status, 200, "Failed to resolve apiz popular movies");

    const matched = await findFirstInBatches(popular.json, LIVE_REQUEST_BATCH_SIZE, async (item) => {
        const targetMovie = item?.movie && typeof item.movie === "object" ? item.movie : item;
        const traktId = String(targetMovie?.ids?.trakt ?? "");
        if (!traktId) {
            return null;
        }

        const translations = await fetchTraktJson(config, `/movies/${traktId}/translations/zh?extended=all`);
        if (translations.status === 200 && Array.isArray(translations.json) && translations.json.length > 0) {
            return {
                traktId,
                movie: targetMovie,
                listBody: popular.body,
                translations: translations.json,
            };
        }
        return null;
    });

    if (matched) {
        return matched;
    }

    throw new Error("Could not find a popular movie with zh translations from apiz popular list");
}

async function resolveMovieWithPeople(config) {
    const trending = await fetchTraktJson(config, "/movies/trending?page=1&limit=10");
    assert.equal(trending.status, 200, "Failed to resolve trending movies");

    const matched = await findFirstInBatches(trending.json, LIVE_REQUEST_BATCH_SIZE, async (item) => {
        const traktId = String(item?.movie?.ids?.trakt ?? "");
        if (!traktId) {
            return null;
        }

        const people = await fetchTraktJson(config, `/movies/${traktId}/people`);
        if (people.status !== 200 || !people.json || typeof people.json !== "object") {
            return null;
        }

        const firstPerson = Array.isArray(people.json.cast) ? people.json.cast[0]?.person : null;
        const personId = String(firstPerson?.ids?.trakt ?? "");
        if (!personId || !String(firstPerson?.name ?? "").trim()) {
            return null;
        }

        const detail = await fetchTraktJson(config, `/people/${personId}`);
        if (detail.status !== 200 || !detail.json || typeof detail.json !== "object") {
            return null;
        }

        return {
            traktId,
            movie: item.movie,
            people: people.json,
            person: firstPerson,
            personId,
            personDetail: detail.json,
        };
    });

    if (matched) {
        return matched;
    }

    throw new Error("Could not find a trending movie with people data");
}

async function resolveMovieWithComments(config) {
    const trending = await fetchTraktJson(config, "/movies/trending?page=1&limit=10");
    assert.equal(trending.status, 200, "Failed to resolve trending movies");

    const matched = await findFirstInBatches(trending.json, LIVE_REQUEST_BATCH_SIZE, async (item) => {
        const traktId = String(item?.movie?.ids?.trakt ?? "");
        if (!traktId) {
            return null;
        }

        const comments = await fetchTraktJson(config, `/movies/${traktId}/comments/all?page=1&limit=10`);
        if (comments.status !== 200 || !Array.isArray(comments.json) || comments.json.length === 0) {
            return null;
        }

        const firstComment = comments.json.find((comment) => {
            return String(comment?.comment ?? "").trim() && String(comment?.language ?? "").toLowerCase() !== "zh";
        });
        if (!firstComment?.id) {
            return null;
        }

        return {
            traktId,
            movie: item.movie,
            comments: comments.json,
            firstComment,
        };
    });

    if (matched) {
        return matched;
    }

    throw new Error("Could not find a trending movie with comments");
}

async function resolveMovieWithSentiments(config) {
    const trending = await fetchTraktJson(config, "/movies/trending?page=1&limit=10");
    assert.equal(trending.status, 200, "Failed to resolve trending movies");

    const matched = await findFirstInBatches(trending.json, LIVE_REQUEST_BATCH_SIZE, async (item) => {
        const traktId = String(item?.movie?.ids?.trakt ?? "");
        if (!traktId) {
            return null;
        }

        const sentiments = await fetchTraktJson(config, `/movies/${traktId}/sentiments`);
        if (sentiments.status !== 200 || !sentiments.json || typeof sentiments.json !== "object") {
            return null;
        }

        const hasTranslatableText = !!(
            String(sentiments.json?.aspect?.pros?.[0]?.theme ?? "").trim() ||
            String(sentiments.json?.good?.[0]?.sentiment ?? "").trim() ||
            String(sentiments.json?.text ?? "").trim()
        );
        if (!hasTranslatableText) {
            return null;
        }

        return {
            traktId,
            movie: item.movie,
            sentiments: sentiments.json,
        };
    });

    if (matched) {
        return matched;
    }

    throw new Error("Could not find a trending movie with sentiments");
}

function createScriptRequestHeaders(config, extraHeaders = {}) {
    return createTraktHeaders(config, {
        "user-agent": LIVE_HTTP_USER_AGENT,
        ...extraHeaders,
    });
}

async function runLiveResponseCase(config, input) {
    const allowRealHttpHosts = ["api.trakt.tv", "apiz.trakt.tv", new URL(config.backendBaseUrl).hostname];

    if (config.allowGoogleTranslate) {
        allowRealHttpHosts.push(GOOGLE_TRANSLATE_HOST);
    }

    return runScriptLive({
        allowRealHttpHosts,
        ...input,
    });
}

async function runLiveRequestCase(config, input) {
    return runLiveResponseCase(config, {
        hasResponse: false,
        ...input,
    });
}

export {
    createScriptRequestHeaders,
    createTraktHeaders,
    fetchJson,
    fetchText,
    fetchTraktJson,
    getLiveConfig,
    hasOAuthToken,
    resolveMovieWithComments,
    resolveMovieWithPeople,
    resolveMovieWithSentiments,
    resolveMovieWithWatchnow,
    resolveMovieWithZhTranslation,
    resolvePopularMovieWithZhTranslation,
    resolvePopularShowWithZhTranslation,
    resolveShowEpisodeSample,
    runLiveRequestCase,
    runLiveResponseCase,
};
