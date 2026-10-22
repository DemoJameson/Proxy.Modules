const { authorizeScriptRequest } = require("../../lib/trakt-cache/script-auth");
const {
    CACHE_STATUS,
    getKvConfig,
    normalizeLocale,
    normalizePersonNameEntry,
    parseIds,
    readManyPersonNameEntriesFromKv,
    readJsonBody,
    sendKvNotConfigured,
    setResponseCacheHeaders,
    writeManyPersonNameEntriesToKv,
} = require("./translation-cache");

async function handleGet(req, res, kvConfig) {
    if (!kvConfig) {
        sendKvNotConfigured(res);
        return;
    }

    const peopleIds = parseIds(req.query.people);
    if (peopleIds.length === 0) {
        res.status(400).json({ error: "Missing people query" });
        return;
    }

    const locale = normalizeLocale(req.query.locale);
    const { people, cn } = await readManyPersonNameEntriesFromKv(kvConfig, peopleIds, { locale });

    const foundCount = Object.values(people).filter((entry) => entry?.status === CACHE_STATUS.FOUND).length;
    const cacheStatus = foundCount === peopleIds.length ? CACHE_STATUS.FOUND : CACHE_STATUS.NOT_FOUND;
    setResponseCacheHeaders(res, cacheStatus);
    const response = { people };
    if (cn && Object.keys(cn).length > 0) {
        response.cn = { people: cn };
    }
    res.status(200).json(response);
}

async function handlePost(req, res, kvConfig) {
    if (!kvConfig) {
        sendKvNotConfigured(res);
        return;
    }

    const payload = await readJsonBody(req);
    const incomingPeople = payload?.people && typeof payload.people === "object" ? payload.people : {};

    // 仅接受新的人名 provider 结构，非法条目直接跳过
    const validEntries = {};
    Object.entries(incomingPeople).forEach(([id, entry]) => {
        const normalizedId = /^\d+$/.test(String(id).trim()) ? String(id).trim() : "";
        if (normalizedId && normalizePersonNameEntry(entry)) {
            validEntries[normalizedId] = entry;
        }
    });

    const incomingCn = payload?.cn?.people && typeof payload.cn.people === "object" ? payload.cn.people : {};
    const validCnEntries = {};
    Object.entries(incomingCn).forEach(([id, entry]) => {
        const normalizedId = /^\d+$/.test(String(id).trim()) ? String(id).trim() : "";
        if (normalizedId && normalizePersonNameEntry(entry)) {
            validCnEntries[normalizedId] = entry;
        }
    });

    await writeManyPersonNameEntriesToKv(kvConfig, validEntries, { locale: normalizeLocale(payload?.locale), cn: validCnEntries });

    res.status(200).json({
        counts: {
            people: Object.keys(validEntries).length,
        },
    });
}

module.exports = async (req, res) => {
    if (!authorizeScriptRequest(req, res)) {
        return;
    }

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
