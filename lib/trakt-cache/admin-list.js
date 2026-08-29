const { CACHE_STATUS, MEDIA_TYPES } = require("./normalize");

const { scanManyKvKeys } = require("./kv-client");

const { buildCacheKey, buildOverrideCacheKey, hasCachePair, getIdFromCacheKey, readAllTranslationOverridesFromKv, readCachePairsFromKv } = require("./translation-store");

function getDirectSearchId(query) {
    const normalized = String(query || "")
        .normalize("NFKC")
        .trim();
    return /^\d+$/.test(normalized) ? normalized : "";
}

function getDirectSearchEntries(query, types) {
    const normalized = String(query || "")
        .normalize("NFKC")
        .trim();
    if (/^\d+$/.test(normalized)) {
        return types.map((type) => ({ type, id: normalized }));
    }
    if (/^\d+:\d+:\d+$/.test(normalized) && types.includes("episodes")) {
        return [{ type: "episodes", id: normalized }];
    }
    return [];
}

function getTraktSearchTarget(types) {
    const hasMovies = types.includes("movies");
    const hasShows = types.includes("shows");
    if (hasMovies && hasShows) {
        return {
            traktType: "movie,show",
            mediaTypes: new Set(["movies", "shows"]),
        };
    }
    if (hasMovies) {
        return { traktType: "movie", mediaTypes: new Set(["movies"]) };
    }
    if (hasShows) {
        return { traktType: "show", mediaTypes: new Set(["shows"]) };
    }
    return null;
}

function getTraktSearchEntry(result, allowedMediaTypes) {
    const resultType = result && typeof result === "object" ? result.type : "";
    const mediaType = resultType === "movie" ? "movies" : resultType === "show" ? "shows" : "";
    if (!mediaType || !allowedMediaTypes.has(mediaType)) {
        return null;
    }

    const media = result[resultType];
    const id = media && typeof media === "object" ? media.ids?.trakt : null;
    const normalizedId = Number.isFinite(id) || typeof id === "string" ? String(id) : "";
    return normalizedId ? { type: mediaType, id: normalizedId } : null;
}

async function searchTraktTitleIds(queryText, types) {
    const target = getTraktSearchTarget(types);
    if (!target) {
        return [];
    }

    const apiKey = String(process.env.TRAKT_API_KEY || "").trim();
    if (!apiKey) {
        throw new Error("TRAKT_API_KEY is not configured for title search.");
    }

    const url = new URL(`https://api.trakt.tv/search/${target.traktType}`);
    url.searchParams.set("query", queryText);
    url.searchParams.set("limit", "3");
    const response = await fetch(url, {
        headers: {
            accept: "application/json",
            "trakt-api-key": apiKey,
            "trakt-api-version": "2",
            "user-agent": "Proxy.Modules Admin Translation Search/1.0",
        },
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => "");
        const suffix = detail ? `: ${detail.slice(0, 200)}` : "";
        if (response.status === 401 || response.status === 403) {
            throw new Error(`Trakt search HTTP ${response.status}. Check TRAKT_API_KEY is the Trakt app client id.${suffix}`);
        }
        throw new Error(`Trakt search HTTP ${response.status}${suffix}`);
    }
    const body = await response.json();
    const candidates = Array.isArray(body) ? body.map((result) => getTraktSearchEntry(result, target.mediaTypes)).filter(Boolean) : [];

    const entries = [];
    const seen = new Set();
    for (const entry of candidates) {
        const seenKey = `${entry.type}:${entry.id}`;
        if (!seen.has(seenKey)) {
            seen.add(seenKey);
            entries.push(entry);
            if (entries.length >= 3) {
                break;
            }
        }
    }
    return entries;
}

function matchesTextQuery(item, query) {
    if (!query) {
        return true;
    }

    const directId = getDirectSearchId(query);
    return !!directId && item.id === directId;
}

function matchesOverrideFilter(item, override) {
    if (!override || override === "all") {
        return true;
    }

    const hasOverride = !!(item.override?.translation && Object.keys(item.override.translation).length > 0);
    return override === "overridden" ? hasOverride : override === "original" ? !hasOverride : true;
}

function matchesStatusFilter(item, status) {
    if (!status || status === "all") {
        return true;
    }

    const entryStatus = item.effectiveEntry ? item.effectiveEntry.status : CACHE_STATUS.NOT_FOUND;
    if (status === "found") {
        return entryStatus === CACHE_STATUS.FOUND;
    }
    if (status === "not_found") {
        return entryStatus === CACHE_STATUS.NOT_FOUND;
    }
    if (status === "partial_found") {
        return entryStatus === CACHE_STATUS.PARTIAL_FOUND;
    }
    return true;
}

function clampListLimit(value) {
    const parsed = Number.parseInt(String(value || "100"), 10);
    if (!Number.isFinite(parsed)) {
        return 100;
    }
    return Math.min(Math.max(parsed, 1), 100);
}

function parseAdminListCursor(value, types) {
    const raw = value === undefined || value === null || value === "" ? "0" : String(value);
    if (raw === "0") {
        return {
            ...Object.fromEntries(types.map((type) => [type, { autoCursor: "0", overrideCursor: "0" }])),
            __pending: [],
        };
    }

    try {
        const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
        return {
            ...Object.fromEntries(
                types.map((type) => [
                    type,
                    {
                        autoCursor: parsed[type]?.autoCursor || "0",
                        overrideCursor: parsed[type]?.overrideCursor || "0",
                    },
                ]),
            ),
            __pending: Array.isArray(parsed.__pending) ? parsed.__pending : [],
        };
    } catch {
        return {
            ...Object.fromEntries(types.map((type) => [type, { autoCursor: "0", overrideCursor: "0" }])),
            __pending: [],
        };
    }
}

function formatAdminListCursor(cursorByType, types, pendingEntries = []) {
    const normalized = Object.fromEntries(
        types.map((type) => [
            type,
            {
                autoCursor: cursorByType[type]?.autoCursor || "0",
                overrideCursor: cursorByType[type]?.overrideCursor || "0",
            },
        ]),
    );
    const pending = pendingEntries.filter((entry) => entry && types.includes(entry.type) && entry.id);
    if (pending.length === 0 && Object.values(normalized).every((cursor) => cursor.autoCursor === "0" && cursor.overrideCursor === "0")) {
        return "0";
    }
    return Buffer.from(JSON.stringify({ ...normalized, __pending: pending }), "utf8").toString("base64url");
}

function compareAdminSearchEntries(left, right) {
    const typeDelta = MEDIA_TYPES.indexOf(left.type) - MEDIA_TYPES.indexOf(right.type);
    if (typeDelta !== 0) {
        return typeDelta;
    }
    return left.id.localeCompare(right.id, "en", { numeric: true });
}

async function listCacheItemsFromKv(config, options) {
    const types = options.type === "all" ? MEDIA_TYPES : [options.type];
    const limit = clampListLimit(options.limit);
    const queryText = String(options.q || "").trim();
    const directSearchEntries = getDirectSearchEntries(queryText, types);
    if (directSearchEntries.length > 0) {
        const idEntries = directSearchEntries;
        const pairs = await readCachePairsFromKv(config, idEntries);
        const items = idEntries
            .map((entry, index) => ({
                id: entry.id,
                type: entry.type,
                autoKey: buildCacheKey(entry.type, entry.id),
                overrideKey: buildOverrideCacheKey(entry.type, entry.id),
                ...pairs[index],
            }))
            .filter(hasCachePair)
            .filter((item) => matchesOverrideFilter(item, options.override || "all"))
            .filter((item) => matchesStatusFilter(item, options.status || "all"))
            .sort(compareAdminSearchEntries)
            .slice(0, limit);

        return {
            items,
            cursor: "0",
            limit,
        };
    }

    if (queryText) {
        const idEntries = await searchTraktTitleIds(queryText, types);
        const pairs = await readCachePairsFromKv(config, idEntries);
        const items = idEntries
            .map((entry, index) => ({
                id: entry.id,
                type: entry.type,
                autoKey: buildCacheKey(entry.type, entry.id),
                overrideKey: buildOverrideCacheKey(entry.type, entry.id),
                ...pairs[index],
            }))
            .filter(hasCachePair)
            .filter((item) => matchesOverrideFilter(item, options.override || "all"))
            .filter((item) => matchesStatusFilter(item, options.status || "all"))
            .slice(0, limit);

        return {
            items,
            cursor: "0",
            limit,
        };
    }

    const cursorByType = parseAdminListCursor(options.cursor, types);
    const scanLimit = limit + 1;
    const translationOverrides = await readAllTranslationOverridesFromKv(config);
    const scanRequests = types.map((type) => {
        const cursor = cursorByType[type] || {
            autoCursor: "0",
            overrideCursor: "0",
        };
        return {
            type,
            cursor: cursor.autoCursor,
            pattern: `${buildCacheKey(type, "")}*`,
            count: scanLimit,
        };
    });
    const scanResults = await scanManyKvKeys(config, scanRequests);
    const scanEntries = scanRequests.map((request, index) => ({
        type: request.type,
        autoScan: scanResults[index] || { cursor: "0", keys: [] },
    }));

    const idEntries = [];
    const seen = new Set();
    const pendingEntries = (cursorByType.__pending || []).filter((entry) => entry && types.includes(entry.type) && entry.id);
    for (const entry of pendingEntries) {
        const seenKey = `${entry.type}:${entry.id}`;
        if (!seen.has(seenKey)) {
            seen.add(seenKey);
            idEntries.push({ type: entry.type, id: entry.id });
        }
    }
    for (const type of types) {
        for (const id of Object.keys(translationOverrides[type] || {})) {
            const seenKey = `${type}:${id}`;
            if (!seen.has(seenKey)) {
                seen.add(seenKey);
                idEntries.push({ type, id });
            }
        }
    }
    for (const { type, autoScan } of scanEntries) {
        for (const key of autoScan.keys) {
            const id = getIdFromCacheKey(key, type);
            const seenKey = `${type}:${id}`;
            if (id && !seen.has(seenKey)) {
                seen.add(seenKey);
                idEntries.push({ type, id });
            }
        }
    }

    const pairs = await readCachePairsFromKv(config, idEntries);
    const candidates = idEntries
        .map((entry, index) => ({
            entry,
            item: {
                id: entry.id,
                type: entry.type,
                autoKey: buildCacheKey(entry.type, entry.id),
                overrideKey: buildOverrideCacheKey(entry.type, entry.id),
                ...pairs[index],
            },
        }))
        .filter(({ item }) => matchesTextQuery(item, options.q || ""))
        .filter(({ item }) => matchesOverrideFilter(item, options.override || "all"))
        .filter(({ item }) => matchesStatusFilter(item, options.status || "all"));
    const items = candidates.slice(0, limit).map(({ item }) => item);
    const nextPendingEntries = candidates.slice(limit).map(({ entry }) => entry);
    const nextCursorByType = Object.fromEntries(
        scanEntries.map(({ type, autoScan }) => [
            type,
            {
                autoCursor: autoScan.cursor,
                overrideCursor: "0",
            },
        ]),
    );
    return {
        items,
        cursor: nextPendingEntries.length > 0 ? formatAdminListCursor(nextCursorByType, types, nextPendingEntries) : "0",
        limit,
    };
}

module.exports = {
    getDirectSearchId,
    getDirectSearchEntries,
    searchTraktTitleIds,
    listCacheItemsFromKv,
};
