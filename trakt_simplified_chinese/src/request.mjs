import * as historyEpisodesMergedByShowHandler from "./features/history-episodes-merged-by-show.mjs";
import * as mediaTranslationHandler from "./features/media-translation.mjs";
import * as playerInjectionTraktHandler from "./features/player-injection-trakt.mjs";
import * as routeUtils from "./shared/route.mjs";

const { createRoute, dispatchRoutes } = routeUtils;
const WATCHNOW_REDIRECT_HOST_PATTERN = new RegExp(`^${new URL(playerInjectionTraktHandler.WATCHNOW_REDIRECT_URL).hostname.replaceAll(".", "\\.")}$`, "i");

function createRequestPhaseRoutes() {
    return [
        createRoute({
            id: "redirect.direct",
            host: WATCHNOW_REDIRECT_HOST_PATTERN,
            pattern: /^api\/redirect$/,
            handler: playerInjectionTraktHandler.handleDirectRedirectRequest,
        }),
        createRoute({
            id: "redirect.tmdbLogo",
            host: /^image\.tmdb\.org$/i,
            pattern: /^t\/p\/w342\/[a-z0-9_-]+_logo\.webp$/i,
            handler: playerInjectionTraktHandler.handleDirectRedirectRequest,
        }),
        createRoute({
            id: "tmdb.image.webp",
            host: /^image\.tmdb\.org$/i,
            pattern: /^t\/p\/.+/,
            handler: playerInjectionTraktHandler.handleTmdbImageWebpRequest,
        }),
        createRoute({
            id: "media.currentSeason",
            pattern: /^shows\/[^/]+\/seasons\/\d+$/,
            handler: mediaTranslationHandler.handleCurrentSeasonRequest,
        }),
        createRoute({
            id: "history.episodes.mergeByShow.rewrite",
            pattern: /^(?:users\/[^/]+\/history\/episodes|sync\/history\/episodes)$/,
            handler: historyEpisodesMergedByShowHandler.handleMergedHistoryEpisodesRewriteRequest,
        }),
    ];
}

function handleRequest() {
    return dispatchRoutes(createRequestPhaseRoutes);
}

export { createRequestPhaseRoutes, handleRequest };
