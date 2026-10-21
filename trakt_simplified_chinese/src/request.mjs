import * as historyEpisodesMergedByShowHandler from "./features/history-episodes-merged-by-show.mjs";
import * as mediaTranslationHandler from "./features/media-translation.mjs";
import * as playerInjectionTraktHandler from "./features/player-injection-trakt.mjs";
import * as tamperAppAuthorizationHandler from "./features/tamper-app-authorization.mjs";
import * as routeUtils from "./shared/route.mjs";

const { createRoute, dispatchRoutes } = routeUtils;
const WATCHNOW_REDIRECT_HOST_PATTERN = new RegExp(`^${new URL(playerInjectionTraktHandler.WATCHNOW_REDIRECT_URL).hostname.replaceAll(".", "\\.")}$`, "i");

function createRequestPhaseRoutes() {
    return [
        createRoute({
            id: "oauth.client",
            host: /^apiz?\.trakt\.tv$/i,
            pattern: /^oauth\/(?:device\/code|device\/token|token)$/,
            handler: tamperAppAuthorizationHandler.handleOAuthRequest,
        }),
        createRoute({
            id: "oauth.auth.client",
            host: /^auth\.trakt\.tv$/i,
            pattern: /^oauth\/token$/,
            handler: tamperAppAuthorizationHandler.handleOAuthRequest,
        }),
        createRoute({
            id: "oauth.web.client",
            host: /^trakt\.tv$/i,
            pattern: /^oauth\/token$/,
            handler: tamperAppAuthorizationHandler.handleOAuthRequest,
        }),
        createRoute({
            id: "oauth.authorize.trakt",
            host: /^trakt\.tv$/i,
            pattern: /^oauth\/authorize$/,
            handler: tamperAppAuthorizationHandler.handleAuthorizeRequest,
        }),
        createRoute({
            id: "oauth.authorize.auth",
            host: /^auth\.trakt\.tv$/i,
            pattern: /^oauth\/authorize$/,
            handler: tamperAppAuthorizationHandler.handleAuthorizeRequest,
        }),
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

async function handleRequest() {
    const result = await dispatchRoutes(createRequestPhaseRoutes);
    return tamperAppAuthorizationHandler.applyTraktApiKeyRewrite(result);
}

export { createRequestPhaseRoutes, handleRequest };
