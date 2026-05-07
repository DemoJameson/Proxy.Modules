import * as commentsTranslationHandler from "./features/comments-translation.mjs";
import * as historyEpisodesMergedByShowHandler from "./features/history-episodes-merged-by-show.mjs";
import * as listsTranslationHandler from "./features/lists-translation.mjs";
import * as mediaTranslationHandler from "./features/media-translation.mjs";
import * as peopleTranslationHandler from "./features/people-translation.mjs";
import * as playerInjectionSofaTimeHandler from "./features/player-injection-sofatime.mjs";
import * as playerInjectionTraktHandler from "./features/player-injection-trakt.mjs";
import * as sentimentsTranslationHandler from "./features/sentiments-translation.mjs";
import { createRoute, dispatchRoutes } from "./shared/route.mjs";

function createResponsePhaseRoutes() {
    return [
        createRoute({ pattern: /^(movies|shows)\/[^/]+\/lists\/[^/]+(\/[^/]+)?$/i, id: "media.lists.typeSort", handler: listsTranslationHandler.handleList }),
        createRoute({ pattern: /^users\/[^/]+\/likes\/lists$/i, id: "users.likes.lists", handler: listsTranslationHandler.handleList }),
        createRoute({ pattern: /^users\/[^/]+\/lists\/collaborations$/i, id: "users.lists.collaborations", handler: listsTranslationHandler.handleList }),
        createRoute({ pattern: /^users\/[^/]+\/lists$/i, id: "users.lists.index", handler: listsTranslationHandler.handleList }),
        createRoute({ pattern: /^search\/list$/i, id: "search.list", handler: listsTranslationHandler.handleList }),
        createRoute({ pattern: /^lists\/(trending|popular)$/i, id: "lists.trendingOrPopular", handler: listsTranslationHandler.handleList }),

        createRoute({ pattern: /^recommendations\/(shows|movies)$/i, id: "recommendations.showsOrMovies", handler: mediaTranslationHandler.handleDirectMediaList }),
        createRoute({ pattern: /^(shows|movies|media)\/popular$/i, id: "directMedia.popular", handler: mediaTranslationHandler.handleDirectMediaList }),
        createRoute({ pattern: /^(shows|movies)\/[^/]+\/related$/i, id: "directMedia.related", handler: mediaTranslationHandler.handleDirectMediaList }),
        createRoute({ pattern: /^movies\/boxoffice$/i, id: "movies.boxoffice", handler: mediaTranslationHandler.handleDirectMediaList }),

        createRoute({ pattern: /^(shows|movies|media)\/popular\/next$/i, id: "wrapperMedia.popularNext", handler: mediaTranslationHandler.handleWrapperMediaList }),
        createRoute({ pattern: /^(shows|movies)\/watched\/monthly$/i, id: "media.watched.monthly", handler: mediaTranslationHandler.handleWrapperMediaList }),
        createRoute({ pattern: /^sync\/progress\/up_next_nitro$/i, id: "sync.progress.upNextNitro", handler: mediaTranslationHandler.handleWrapperMediaList }),
        createRoute({ pattern: /^sync\/playback\/movies$/i, id: "sync.playback.movies", handler: mediaTranslationHandler.handleWrapperMediaList }),
        createRoute({
            pattern: /^users\/[^/]+\/watchlist\/(shows|movies)\/released(\/desc)?$/i,
            id: "users.watchlist.released",
            handler: mediaTranslationHandler.handleWrapperMediaList,
        }),
        createRoute({
            pattern: /^calendars\/(my\/(shows|movies)|all\/(movies|dvd|shows(\/(new|premieres|finales))?))\/\d{4}-\d{2}-\d{2}\/\d+$/i,
            id: "calendars.entries",
            handler: mediaTranslationHandler.handleWrapperMediaList,
        }),
        createRoute({ pattern: /^users\/[^/]+\/history\/movies$/i, id: "users.history.movies", handler: mediaTranslationHandler.handleWrapperMediaList }),
        createRoute({ pattern: /^sync\/history\/(movies|shows)$/i, id: "sync.history.media", handler: mediaTranslationHandler.handleWrapperMediaList }),
        createRoute({ pattern: /^sync\/history$/i, id: "sync.history.all", handler: mediaTranslationHandler.handleWrapperMediaList }),
        createRoute({ pattern: /^sync\/watched\/(shows|movies)$/i, id: "sync.watched.media", handler: mediaTranslationHandler.handleWrapperMediaList }),
        createRoute({ pattern: /^users\/[^/]+\/watched\/(shows|movies)$/i, id: "users.watched.media", handler: mediaTranslationHandler.handleWrapperMediaList }),
        createRoute({ pattern: /^users\/[^/]+\/history$/i, id: "users.history.all", handler: mediaTranslationHandler.handleWrapperMediaList }),
        createRoute({
            pattern: /^users\/[^/]+\/collection\/(shows|movies|episodes)$/i,
            id: "users.collection.mediaTyped",
            handler: mediaTranslationHandler.handleWrapperMediaList,
        }),
        createRoute({ pattern: /^users\/[^/]+\/collection\/media$/i, id: "users.collection.media", handler: mediaTranslationHandler.handleWrapperMediaList }),
        createRoute({ pattern: /^people\/[^/]+\/known_for$/i, id: "people.knownFor", handler: mediaTranslationHandler.handleWrapperMediaList }),
        createRoute({ pattern: /^users\/[^/]+\/following\/activities$/i, id: "users.following.activities", handler: mediaTranslationHandler.handleWrapperMediaList }),
        createRoute({ pattern: /^users\/[^/]+\/lists\/\d+\/items$/i, id: "users.listItems.all", handler: mediaTranslationHandler.handleWrapperMediaList }),
        createRoute({
            pattern: /^users\/[^/]+\/lists\/\d+\/items\/(?:movie|show|season|episode)(?:,(?:movie|show|season|episode))*$/i,
            id: "users.listItems.filtered",
            handler: mediaTranslationHandler.handleWrapperMediaList,
        }),
        createRoute({ pattern: /^lists\/\d+\/items$/i, id: "lists.items.all", handler: mediaTranslationHandler.handleWrapperMediaList }),
        createRoute({
            pattern: /^lists\/\d+\/items\/(?:movie|show|season|episode)(?:,(?:movie|show|season|episode))*$/i,
            id: "lists.items.filtered",
            handler: mediaTranslationHandler.handleWrapperMediaList,
        }),
        createRoute({ pattern: /^users\/[^/]+\/ratings\/all$/i, id: "users.ratings.all", handler: mediaTranslationHandler.handleWrapperMediaList }),
        createRoute({ pattern: /^users\/[^/]+\/ratings\/(movies|shows|episodes)$/i, id: "users.ratings.mediaTyped", handler: mediaTranslationHandler.handleWrapperMediaList }),
        createRoute({ pattern: /^users\/[^/]+\/favorites\/media(\/[^/]+)?$/i, id: "users.favorites.media", handler: mediaTranslationHandler.handleWrapperMediaList }),
        createRoute({
            pattern: /^users\/[^/]+\/favorites\/(shows|movies)(\/[^/]+)?$/i,
            id: "users.favorites.mediaTyped",
            handler: mediaTranslationHandler.handleWrapperMediaList,
        }),
        createRoute({ pattern: /^users\/[^/]+\/favorites$/i, id: "users.favorites.all", handler: mediaTranslationHandler.handleWrapperMediaList }),
        createRoute({ pattern: /^(shows|movies|media)\/trending$/i, id: "media.trending", handler: mediaTranslationHandler.handleWrapperMediaList }),
        createRoute({ pattern: /^(shows|movies|media)\/recommendations$/i, id: "media.recommendations", handler: mediaTranslationHandler.handleWrapperMediaList }),
        createRoute({ pattern: /^(shows|movies|media)\/anticipated$/i, id: "media.anticipated", handler: mediaTranslationHandler.handleWrapperMediaList }),
        createRoute({ pattern: /^users\/[^/]+\/watchlist\/movie,show(\/[^/]+)?$/i, id: "users.watchlist.mixed", handler: mediaTranslationHandler.handleWrapperMediaList }),
        createRoute({
            pattern: /^users\/[^/]+\/watchlist\/(shows|movies)(\/(?!released$)[^/]+)?$/i,
            id: "users.watchlist.showsOrMovies",
            handler: mediaTranslationHandler.handleWrapperMediaList,
        }),
        createRoute({ pattern: /^users\/[^/]+\/watchlist$/i, id: "users.watchlist.all", handler: mediaTranslationHandler.handleWrapperMediaList }),

        createRoute({
            pattern: /^(users\/[^/]+\/history\/episodes(\/\d+)?|sync\/history\/episodes)$/i,
            id: "history.episodes.mergeByShow",
            handler: historyEpisodesMergedByShowHandler.handleMergedHistoryEpisodeList,
        }),

        createRoute({ pattern: /^people\/[^/]+\/(movies|shows)$/i, id: "people.mediaCredits", handler: peopleTranslationHandler.handlePersonMediaCreditsList }),
        createRoute({ pattern: /^search\/person$/i, id: "search.person", handler: peopleTranslationHandler.handlePeopleSearchList }),
        createRoute({ pattern: /^people\/this_month$/i, id: "people.thisMonth", handler: peopleTranslationHandler.handlePeopleSearchList }),

        createRoute({ pattern: /^users\/[^/]+\/mir$/i, id: "users.mir", handler: mediaTranslationHandler.handleMonthlyReview }),

        createRoute({
            pattern: /^comments\/recent\/(all|shows|movies|episodes)\/(all|weekly|monthly|yearly)$/i,
            id: "comments.recent",
            handler: commentsTranslationHandler.handleRecentCommentsList,
        }),

        createRoute({ pattern: /^users\/settings$/i, id: "users.settings", handler: playerInjectionTraktHandler.handleUserSettings }),

        createRoute({
            pattern: /^3\/watch\/providers\/(movie|tv)$/i,
            id: "tmdb.watchProviders",
            host: /^api\.themoviedb\.org$/i,
            handler: playerInjectionSofaTimeHandler.handleTmdbProviderCatalog,
        }),
        createRoute({
            pattern: /^shows\/tt\d+$/i,
            id: "streamingAvailability.showByImdb",
            host: /^streaming-availability\.p\.rapidapi\.com$/i,
            handler: playerInjectionSofaTimeHandler.handleSofaTimeStreamingAvailability,
        }),
        createRoute({
            id: "streamingAvailability.countries",
            host: /^streaming-availability\.p\.rapidapi\.com$/i,
            pattern: /^countries\/[a-z]{2}$/i,
            handler: playerInjectionSofaTimeHandler.handleSofaTimeCountries,
        }),

        createRoute({ pattern: /^watchnow\/sources$/i, id: "watchnow.sources", handler: playerInjectionTraktHandler.handleWatchnowSources }),
        createRoute({ pattern: /^(movies|shows)\/[^/]+\/people$/i, id: "media.people", handler: peopleTranslationHandler.handleMediaPeopleList }),
        createRoute({
            pattern: /^shows\/[^/]+\/seasons\/\d+\/episodes\/\d+\/people$/i,
            id: "shows.episode.people",
            handler: peopleTranslationHandler.handleMediaPeopleList,
        }),

        createRoute({ pattern: /^(movies|shows)\/[^/]+\/comments\/[^/]+$/i, id: "media.comments", handler: commentsTranslationHandler.handleComments }),
        createRoute({
            pattern: /^shows\/[^/]+\/seasons\/\d+\/episodes\/\d+\/comments\/[^/]+$/i,
            id: "shows.episode.comments",
            handler: commentsTranslationHandler.handleComments,
        }),
        createRoute({ pattern: /^comments\/\d+\/replies$/i, id: "comments.replies", handler: commentsTranslationHandler.handleComments }),

        createRoute({ pattern: /^(movies|shows)\/\d+\/translations\/zh$/i, id: "media.translations.zh", handler: mediaTranslationHandler.handleTranslations }),
        createRoute({
            pattern: /^shows\/\d+\/seasons\/\d+\/episodes\/\d+\/translations\/zh$/i,
            id: "shows.episode.translations.zh",
            handler: mediaTranslationHandler.handleTranslations,
        }),

        createRoute({ pattern: /^(movies|shows)\/\d+\/watchnow$/i, id: "media.watchnow", handler: playerInjectionTraktHandler.handleWatchnow }),
        createRoute({ pattern: /^episodes\/\d+\/watchnow$/i, id: "episodes.watchnow", handler: playerInjectionTraktHandler.handleWatchnow }),

        createRoute({ pattern: /^shows\/[^/]+\/seasons$/i, id: "shows.seasons", handler: mediaTranslationHandler.handleSeasonEpisodesList }),

        createRoute({
            pattern: /^(v3\/)?media\/(movie|show)\/\d+\/info\/\d+\/version\/\d+$/i,
            id: "media.proxySentiments",
            handler: sentimentsTranslationHandler.handleSentiments,
        }),
        createRoute({ pattern: /^(shows|movies)\/\d+\/sentiments$/i, id: "media.sentiments", handler: sentimentsTranslationHandler.handleSentiments }),

        createRoute({
            pattern: /^shows\/(?!popular$|trending$|recommendations$|anticipated$|watched$)[^/]+$/i,
            id: "shows.summary",
            handler: mediaTranslationHandler.handleMediaDetail,
        }),
        createRoute({
            pattern: /^movies\/(?!popular$|trending$|recommendations$|anticipated$|watched$|boxoffice$)[^/]+$/i,
            id: "movies.summary",
            handler: mediaTranslationHandler.handleMediaDetail,
        }),
        createRoute({ pattern: /^shows\/[^/]+\/seasons\/\d+\/episodes\/\d+$/i, id: "shows.episode.summary", handler: mediaTranslationHandler.handleMediaDetail }),
        createRoute({ pattern: /^people\/[a-z0-9-]+$/i, id: "people.summary", handler: peopleTranslationHandler.handlePeopleDetail }),
    ];
}

function handleResponse() {
    return dispatchRoutes(createResponsePhaseRoutes);
}

export { createResponsePhaseRoutes, handleResponse };
