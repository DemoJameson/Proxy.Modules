const {
    CACHE_STATUS,
    DOUBAN_TARGET_TYPES,
    getKvConfig,
    mergeCreditEntriesByField,
    parseIds,
    readManyCreditEntriesFromKv,
    readJsonBody,
    sendKvNotConfigured,
    setResponseCacheHeaders,
    splitCreditEntriesByCompleteness,
    writeManyCreditEntriesToKv,
} = require("./translation-cache");

function hasAnyCreditHit(entries) {
    return DOUBAN_TARGET_TYPES.some((type) => {
        const items = entries?.[type] && typeof entries[type] === "object" ? entries[type] : {};
        return Object.keys(items).length > 0;
    });
}

async function handleGet(req, res, kvConfig) {
    if (!kvConfig) {
        sendKvNotConfigured(res);
        return;
    }

    const movieIds = parseIds(req.query.movies);
    const showIds = parseIds(req.query.shows);

    if (movieIds.length === 0 && showIds.length === 0) {
        res.status(400).json({ error: "Missing movies or shows query" });
        return;
    }

    const { movies, shows } = await readManyCreditEntriesFromKv(kvConfig, {
        movies: movieIds,
        shows: showIds,
    });

    const entries = { movies, shows };
    setResponseCacheHeaders(res, hasAnyCreditHit(entries) ? CACHE_STATUS.FOUND : CACHE_STATUS.NOT_FOUND);
    res.status(200).json(entries);
}

async function handlePost(req, res, kvConfig) {
    if (!kvConfig) {
        sendKvNotConfigured(res);
        return;
    }

    const payload = await readJsonBody(req);
    const incomingMovie = payload?.movies && typeof payload.movies === "object" ? payload.movies : {};
    const incomingShow = payload?.shows && typeof payload.shows === "object" ? payload.shows : {};

    // 完整 entry（subject+seasons+credits 齐全）直接整体写，partial entry 才 GET merge，避免覆盖且减少 KV 调用
    const movieSplit = splitCreditEntriesByCompleteness(incomingMovie);
    const showSplit = splitCreditEntriesByCompleteness(incomingShow);

    const existingEntries = await readManyCreditEntriesFromKv(kvConfig, {
        movies: Object.keys(movieSplit.partial),
        shows: Object.keys(showSplit.partial),
    });

    const movies = {
        ...movieSplit.complete,
        ...mergeCreditEntriesByField(existingEntries.movies, movieSplit.partial),
    };
    const shows = {
        ...showSplit.complete,
        ...mergeCreditEntriesByField(existingEntries.shows, showSplit.partial),
    };

    await writeManyCreditEntriesToKv(kvConfig, { movies, shows });

    res.status(200).json({
        counts: {
            movies: Object.keys(movies).length,
            shows: Object.keys(shows).length,
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
