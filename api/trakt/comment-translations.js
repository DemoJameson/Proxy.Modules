const {
    CACHE_STATUS,
    getKvConfig,
    normalizeCommentTranslationEntry,
    parseIds,
    readManyCommentTranslationEntriesFromKv,
    readJsonBody,
    sendKvNotConfigured,
    setResponseCacheHeaders,
    writeManyCommentTranslationEntriesToKv,
} = require("./translation-cache");

async function handleGet(req, res, kvConfig) {
    if (!kvConfig) {
        sendKvNotConfigured(res);
        return;
    }

    const commentIds = parseIds(req.query.comments);
    if (commentIds.length === 0) {
        res.status(400).json({ error: "Missing comments query" });
        return;
    }

    const { comments } = await readManyCommentTranslationEntriesFromKv(kvConfig, commentIds);

    setResponseCacheHeaders(res, Object.keys(comments).length > 0 ? CACHE_STATUS.FOUND : CACHE_STATUS.NOT_FOUND);
    res.status(200).json({ comments });
}

async function handlePost(req, res, kvConfig) {
    if (!kvConfig) {
        sendKvNotConfigured(res);
        return;
    }

    const payload = await readJsonBody(req);
    const incomingComments = payload?.comments && typeof payload.comments === "object" ? payload.comments : {};

    // 仅接受合法评论翻译条目，非法条目直接跳过
    const validEntries = {};
    Object.entries(incomingComments).forEach(([id, entry]) => {
        const normalizedId = /^\d+$/.test(String(id).trim()) ? String(id).trim() : "";
        if (normalizedId && normalizeCommentTranslationEntry(entry)) {
            validEntries[normalizedId] = entry;
        }
    });

    await writeManyCommentTranslationEntriesToKv(kvConfig, validEntries);

    res.status(200).json({
        counts: {
            comments: Object.keys(validEntries).length,
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
