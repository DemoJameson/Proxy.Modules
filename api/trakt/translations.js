const {
    getKvConfig,
    getResponseCacheStatus,
    parseEpisodeKeys,
    parseIds,
    readManyAutoGroupsFromKv,
    readJsonBody,
    sendKvNotConfigured,
    setResponseCacheHeaders,
    writeManyGroupsToKv,
} = require("./translation-cache");

async function handleGet(req, res, kvConfig) {
    if (!kvConfig) {
        sendKvNotConfigured(res);
        return;
    }

    const showIds = parseIds(req.query.shows);
    const movieIds = parseIds(req.query.movies);
    const episodeKeys = parseEpisodeKeys(req.query.episodes);

    if (showIds.length === 0 && movieIds.length === 0 && episodeKeys.length === 0) {
        res.status(400).json({ error: "Missing shows, movies, or episodes query" });
        return;
    }

    const { shows, movies, episodes } = await readManyAutoGroupsFromKv(kvConfig, {
        shows: showIds,
        movies: movieIds,
        episodes: episodeKeys,
    });

    setResponseCacheHeaders(res, getResponseCacheStatus(shows, movies, episodes));
    res.status(200).json({
        shows,
        movies,
        episodes,
    });
}

async function handlePost(req, res, kvConfig) {
    if (!kvConfig) {
        sendKvNotConfigured(res);
        return;
    }

    const payload = await readJsonBody(req);
    const shows = payload?.shows && typeof payload.shows === "object" ? payload.shows : {};
    const movies = payload?.movies && typeof payload.movies === "object" ? payload.movies : {};
    const episodes = payload?.episodes && typeof payload.episodes === "object" ? payload.episodes : {};

    await writeManyGroupsToKv(kvConfig, { shows, movies, episodes });

    res.status(200).json({
        counts: {
            shows: Object.keys(shows).length,
            movies: Object.keys(movies).length,
            episodes: Object.keys(episodes).length,
        },
    });
}

module.exports = async (req, res) => {
    const kvConfig = getKvConfig();

    try {
        if (req.method === "GET") {
            await handleGet(req, res, kvConfig);
            return;
        }

        if (req.method === "POST") {
            await handlePost(req, res, kvConfig);
            return;
        }

        res.setHeader("Allow", "GET, POST");
        res.status(405).json({ error: "Method not allowed" });
    } catch (error) {
        res.status(500).json({
            error: error instanceof Error ? error.message : String(error),
        });
    }
};
