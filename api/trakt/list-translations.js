const {
    CACHE_STATUS,
    getKvConfig,
    normalizeListTranslationEntry,
    parseIds,
    readJsonBody,
    readManyListTranslationEntriesFromKv,
    sendKvNotConfigured,
    setResponseCacheHeaders,
    writeManyListTranslationEntriesToKv,
} = require("./translation-cache");

async function handleGet(req, res, kvConfig) {
    if (!kvConfig) {
        sendKvNotConfigured(res);
        return;
    }

    const listIds = parseIds(req.query.lists);
    if (listIds.length === 0) {
        res.status(400).json({ error: "Missing lists query" });
        return;
    }

    const { lists } = await readManyListTranslationEntriesFromKv(kvConfig, listIds);

    // 区分完整/部分命中：部分命中说明客户端即将回写缺失条目，CDN 不能长缓存
    const foundCount = Object.keys(lists).length;
    const cacheStatus = foundCount === 0 ? CACHE_STATUS.NOT_FOUND : foundCount >= listIds.length ? CACHE_STATUS.FOUND : CACHE_STATUS.PARTIAL_FOUND;
    setResponseCacheHeaders(res, cacheStatus);
    res.status(200).json({ lists });
}

async function handlePost(req, res, kvConfig) {
    if (!kvConfig) {
        sendKvNotConfigured(res);
        return;
    }

    const payload = await readJsonBody(req);
    const incomingLists = payload?.lists && typeof payload.lists === "object" ? payload.lists : {};

    // 仅接受合法片单翻译条目，非法条目直接跳过
    const validEntries = {};
    Object.entries(incomingLists).forEach(([id, entry]) => {
        const normalizedId = /^\d+$/.test(String(id).trim()) ? String(id).trim() : "";
        if (normalizedId && normalizeListTranslationEntry(entry)) {
            validEntries[normalizedId] = entry;
        }
    });

    await writeManyListTranslationEntriesToKv(kvConfig, validEntries);

    res.status(200).json({
        counts: {
            lists: Object.keys(validEntries).length,
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
