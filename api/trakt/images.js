const {
    getKvConfig,
    getResponseCacheStatus,
    normalizeLocale,
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

    const locale = normalizeLocale(req.query.locale);
    const { shows, movies, seasons, cn } = await readManyImageGroupsFromKv(kvConfig, {
        mode,
        locale,
        shows: showIds,
        movies: movieIds,
        seasons: seasonKeys,
    });

    setResponseCacheHeaders(res, getResponseCacheStatus({ shows, movies, seasons }, { shows: showIds.length, movies: movieIds.length, seasons: seasonKeys.length }));
    const response = { shows, movies, seasons };
    if (cn && Object.keys(cn.shows).length + Object.keys(cn.movies).length + Object.keys(cn.seasons).length > 0) {
        response.cn = cn;
    }
    res.status(200).json(response);
}

async function handlePost(req, res, kvConfig) {
    if (!kvConfig) {
        sendKvNotConfigured(res);
        return;
    }

    const payload = await readJsonBody(req);
    const modes = payload?.modes && typeof payload.modes === "object" ? payload.modes : {};

    await writeManyImageGroupsToKv(kvConfig, { locale: normalizeLocale(payload?.locale), modes, cn: payload?.cn });

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
