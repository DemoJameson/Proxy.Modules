const {
    getKvConfig,
    getResponseCacheStatus,
    parseIds,
    parseSeasonKeys,
    readJsonBody,
    readManyImageGroupsFromKv,
    sendKvNotConfigured,
    setResponseCacheHeaders,
    writeManyImageGroupsToKv,
} = require("./translation-cache");

async function handleGet(req, res, kvConfig) {
    if (!kvConfig) {
        sendKvNotConfigured(res);
        return;
    }

    const showIds = parseIds(req.query.shows);
    const movieIds = parseIds(req.query.movies);
    const seasonKeys = parseSeasonKeys(req.query.seasons);
    const mode = req.query.mode;

    if (showIds.length === 0 && movieIds.length === 0 && seasonKeys.length === 0) {
        res.status(400).json({ error: "Missing shows, movies, or seasons query" });
        return;
    }

    const { shows, movies, seasons } = await readManyImageGroupsFromKv(kvConfig, {
        mode,
        shows: showIds,
        movies: movieIds,
        seasons: seasonKeys,
    });

    setResponseCacheHeaders(res, getResponseCacheStatus(shows, movies, seasons));
    res.status(200).json({
        shows,
        movies,
        seasons,
    });
}

async function handlePost(req, res, kvConfig) {
    if (!kvConfig) {
        sendKvNotConfigured(res);
        return;
    }

    const payload = await readJsonBody(req);
    const modes = payload?.modes && typeof payload.modes === "object" ? payload.modes : {};

    await writeManyImageGroupsToKv(kvConfig, { modes });

    res.status(200).json({
        counts: {
            shows: Object.values(modes).reduce((count, groups) => count + Object.keys(groups?.shows || {}).length, 0),
            movies: Object.values(modes).reduce((count, groups) => count + Object.keys(groups?.movies || {}).length, 0),
            seasons: Object.values(modes).reduce((count, groups) => count + Object.keys(groups?.seasons || {}).length, 0),
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
