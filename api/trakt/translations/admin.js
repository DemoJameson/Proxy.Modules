const {
    deleteCacheEntriesFromKv,
    getKvConfig,
    isSupportedMediaType,
    listCacheItemsFromKv,
    readCachePairFromKv,
    readJsonBody,
    sendKvNotConfigured,
    writeTranslationOverrideEntryToKv,
} = require("../translation-cache");

function getHeader(req, name) {
    const headers = req.headers || {};
    return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || "";
}

function authorizeAdmin(req, res) {
    const token = process.env.ADMIN_TOKEN || "";
    if (!token) {
        res.status(401).json({ error: "ADMIN_TOKEN is not configured" });
        return false;
    }

    if (getHeader(req, "authorization") !== `Bearer ${token}`) {
        res.status(401).json({ error: "Unauthorized" });
        return false;
    }

    return true;
}

function getSingleValue(value) {
    return Array.isArray(value) ? value[0] : value;
}

function getType(req) {
    return String(getSingleValue(req.query.type) || "movies");
}

function getOverrideFilter(req) {
    return String(getSingleValue(req.query.override) || "all");
}

function sendBadRequest(res, error) {
    res.status(400).json({ error });
}

function handleAuth(_req, res) {
    res.status(200).json({ ok: true });
}

function hasAnyOverrideField(translation) {
    return !!(translation && typeof translation === "object" && Object.values(translation).some((value) => value !== undefined && value !== null && value !== ""));
}

async function handleList(req, res, kvConfig) {
    const type = getType(req);
    if (type !== "all" && !isSupportedMediaType(type)) {
        sendBadRequest(res, "Invalid type");
        return;
    }

    const result = await listCacheItemsFromKv(kvConfig, {
        type,
        cursor: getSingleValue(req.query.cursor),
        limit: getSingleValue(req.query.limit),
        q: String(getSingleValue(req.query.q) || ""),
        override: getOverrideFilter(req),
        status: String(getSingleValue(req.query.status) || "all"),
    });

    res.status(200).json({
        type,
        ...result,
    });
}

async function handleItem(req, res, kvConfig) {
    const type = getType(req);
    const id = String(getSingleValue(req.query.id) || "").trim();
    if (!isSupportedMediaType(type)) {
        sendBadRequest(res, "Invalid type");
        return;
    }
    if (!id) {
        sendBadRequest(res, "Missing id");
        return;
    }

    res.status(200).json({
        type,
        id,
        ...(await readCachePairFromKv(kvConfig, type, id, { hydrateMissingExpiresAt: true })),
    });
}

async function handlePut(req, res, kvConfig) {
    const body = await readJsonBody(req);
    const type = String(body.type || "movies");
    const id = String(body.id || "").trim();
    if (!isSupportedMediaType(type)) {
        sendBadRequest(res, "Invalid type");
        return;
    }
    if (!id) {
        sendBadRequest(res, "Missing id");
        return;
    }

    if (!hasAnyOverrideField(body.translation)) {
        await deleteCacheEntriesFromKv(kvConfig, type, id, "override");
        res.status(200).json({
            type,
            id,
            ...(await readCachePairFromKv(kvConfig, type, id, { hydrateMissingExpiresAt: true })),
        });
        return;
    }

    const override = await writeTranslationOverrideEntryToKv(kvConfig, type, id, {
        translation: body.translation,
    });
    const pair = await readCachePairFromKv(kvConfig, type, id, { hydrateMissingExpiresAt: true });

    res.status(200).json({
        type,
        id,
        override,
        ...pair,
    });
}

async function handleDelete(req, res, kvConfig) {
    const type = getType(req);
    const id = String(getSingleValue(req.query.id) || "").trim();
    const target = String(getSingleValue(req.query.target) || "override");
    if (!isSupportedMediaType(type)) {
        sendBadRequest(res, "Invalid type");
        return;
    }
    if (!id) {
        sendBadRequest(res, "Missing id");
        return;
    }
    if (!["override", "auto", "all"].includes(target)) {
        sendBadRequest(res, "Invalid target");
        return;
    }

    const deleted = await deleteCacheEntriesFromKv(kvConfig, type, id, target);
    res.status(200).json({
        type,
        id,
        target,
        deleted,
        ...(await readCachePairFromKv(kvConfig, type, id, { hydrateMissingExpiresAt: true })),
    });
}

module.exports = async (req, res) => {
    try {
        if (!authorizeAdmin(req, res)) {
            return;
        }

        if (req.method === "GET") {
            const action = String(getSingleValue(req.query.action) || "list");
            if (action === "auth") {
                handleAuth(req, res);
                return;
            }
        }

        const kvConfig = getKvConfig();
        if (!kvConfig) {
            sendKvNotConfigured(res);
            return;
        }

        if (req.method === "GET") {
            const action = String(getSingleValue(req.query.action) || "list");
            if (action === "list") {
                await handleList(req, res, kvConfig);
                return;
            }
            if (action === "item") {
                await handleItem(req, res, kvConfig);
                return;
            }
            sendBadRequest(res, "Invalid action");
            return;
        }

        if (req.method === "PUT") {
            await handlePut(req, res, kvConfig);
            return;
        }

        if (req.method === "DELETE") {
            await handleDelete(req, res, kvConfig);
            return;
        }

        if (req.method === "POST") {
            sendBadRequest(res, "Invalid action");
            return;
        }

        res.setHeader("Allow", "GET, PUT, DELETE, POST");
        res.status(405).json({ error: "Method not allowed" });
    } catch (error) {
        res.status(500).json({
            error: error instanceof Error ? error.message : String(error),
        });
    }
};
