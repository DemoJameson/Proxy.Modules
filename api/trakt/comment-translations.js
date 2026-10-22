const {
    CACHE_STATUS,
    getKvConfig,
    normalizeCommentTranslationEntry,
    normalizeLocale,
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

    const locale = normalizeLocale(req.query.locale);
    const { comments, cn } = await readManyCommentTranslationEntriesFromKv(kvConfig, commentIds, { locale });

    const foundCount = Object.keys(comments).length;
    const cacheStatus = foundCount === commentIds.length ? CACHE_STATUS.FOUND : CACHE_STATUS.NOT_FOUND;
    setResponseCacheHeaders(res, cacheStatus);
    const response = { comments };
    if (cn && Object.keys(cn).length > 0) {
        response.cn = { comments: cn };
    }
    res.status(200).json(response);
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

    const incomingCn = payload?.cn?.comments && typeof payload.cn.comments === "object" ? payload.cn.comments : {};
    const validCnEntries = {};
    Object.entries(incomingCn).forEach(([id, entry]) => {
        const normalizedId = /^\d+$/.test(String(id).trim()) ? String(id).trim() : "";
        if (normalizedId && normalizeCommentTranslationEntry(entry)) {
            validCnEntries[normalizedId] = entry;
        }
    });

    await writeManyCommentTranslationEntriesToKv(kvConfig, validEntries, { locale: normalizeLocale(payload?.locale), cn: validCnEntries });

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
