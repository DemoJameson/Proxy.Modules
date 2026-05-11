const CACHE_STATUS = {
    FOUND: 1,
    PARTIAL_FOUND: 2,
    NOT_FOUND: 3,
};

const OVERRIDE_FIELDS = ["title", "overview", "tagline"];
const MEDIA_TYPES = ["shows", "movies", "episodes"];
const IMAGE_GROUPS = ["shows", "movies", "seasons"];
const IMAGE_FIELDS = ["poster", "logo"];
const TRANSLATION_OVERRIDES_KEY = "trakt:translation:overrides";
const PARTIAL_FOUND_TTL_SECONDS = 30 * 24 * 60 * 60;
const NOT_FOUND_TTL_SECONDS = 5 * 24 * 60 * 60;

const RESPONSE_CACHE_HEADERS = {
    [CACHE_STATUS.FOUND]: {
        "Cache-Control": "public, max-age=300",
        "CDN-Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
        "Vercel-CDN-Cache-Control": "public, s-maxage=86400, stale-while-revalidate=86400",
    },
    [CACHE_STATUS.PARTIAL_FOUND]: {
        "Cache-Control": "public, max-age=300",
        "CDN-Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
        "Vercel-CDN-Cache-Control": "public, s-maxage=86400, stale-while-revalidate=86400",
    },
    [CACHE_STATUS.NOT_FOUND]: {
        "Cache-Control": "public, max-age=0, must-revalidate",
        "CDN-Cache-Control": "public, s-maxage=60, stale-while-revalidate=600",
        "Vercel-CDN-Cache-Control": "public, s-maxage=600, stale-while-revalidate=600",
    },
};

function parseIds(value) {
    if (!value) {
        return [];
    }

    const parts = Array.isArray(value) ? value.join(",").split(",") : String(value).split(",");
    const unique = new Set();

    for (const part of parts) {
        const normalized = String(part).trim();
        if (!/^\d+$/.test(normalized)) {
            continue;
        }
        unique.add(normalized);
    }

    return Array.from(unique);
}

function parseEpisodeKeys(value) {
    if (!value) {
        return [];
    }

    const parts = Array.isArray(value) ? value.join(",").split(",") : String(value).split(",");
    const unique = new Set();

    for (const part of parts) {
        const normalized = String(part).trim();
        if (!/^\d+:\d+:\d+$/.test(normalized)) {
            continue;
        }
        unique.add(normalized);
    }

    return Array.from(unique);
}

function parseSeasonKeys(value) {
    if (!value) {
        return [];
    }

    const parts = Array.isArray(value) ? value.join(",").split(",") : String(value).split(",");
    const unique = new Set();

    for (const part of parts) {
        const normalized = String(part).trim();
        if (!/^\d+:\d+$/.test(normalized)) {
            continue;
        }
        unique.add(normalized);
    }

    return Array.from(unique);
}

function isSupportedMediaType(type) {
    return MEDIA_TYPES.includes(type);
}

function isEmptyTranslationValue(value) {
    return value === undefined || value === null || value === "";
}

function hasUsefulTranslation(translation) {
    return !!(translation && (!isEmptyTranslationValue(translation.title) || !isEmptyTranslationValue(translation.overview) || !isEmptyTranslationValue(translation.tagline)));
}

function normalizeTranslation(translation, emptyAsNull = true) {
    if (!translation || typeof translation !== "object") {
        return emptyAsNull ? null : { title: null, overview: null, tagline: null };
    }

    const normalized = {
        title: isEmptyTranslationValue(translation.title) ? null : translation.title,
        overview: isEmptyTranslationValue(translation.overview) ? null : translation.overview,
        tagline: isEmptyTranslationValue(translation.tagline) ? null : translation.tagline,
    };

    return emptyAsNull && !hasUsefulTranslation(normalized) ? null : normalized;
}

function normalizeEntry(entry) {
    if (!entry || typeof entry !== "object") {
        return {
            status: CACHE_STATUS.NOT_FOUND,
            translation: null,
        };
    }

    const normalized = {
        status: entry.status === CACHE_STATUS.FOUND ? CACHE_STATUS.FOUND : entry.status === CACHE_STATUS.PARTIAL_FOUND ? CACHE_STATUS.PARTIAL_FOUND : CACHE_STATUS.NOT_FOUND,
        translation: normalizeTranslation(entry.translation, true),
    };

    if (Object.hasOwn(entry, "expiresAt")) {
        if (entry.expiresAt === null || Number.isFinite(entry.expiresAt)) {
            normalized.expiresAt = entry.expiresAt;
        }
    }

    return normalized;
}

function normalizeImageField(entry, now = Date.now()) {
    const status = entry?.status === CACHE_STATUS.FOUND ? CACHE_STATUS.FOUND : entry?.status === CACHE_STATUS.PARTIAL_FOUND ? CACHE_STATUS.PARTIAL_FOUND : CACHE_STATUS.NOT_FOUND;
    const url = String(entry?.url || "").trim();
    if (status === CACHE_STATUS.FOUND && url) {
        return { status, url, expiresAt: null };
    }
    if (status === CACHE_STATUS.PARTIAL_FOUND && url) {
        const expiresAt = Number.isFinite(Number(entry?.expiresAt)) ? Number(entry.expiresAt) : now + PARTIAL_FOUND_TTL_SECONDS * 1000;
        return { status, url, expiresAt };
    }
    const expiresAt = Number.isFinite(Number(entry?.expiresAt)) ? Number(entry.expiresAt) : now + NOT_FOUND_TTL_SECONDS * 1000;
    return { status: CACHE_STATUS.NOT_FOUND, expiresAt };
}

function normalizeImageEntry(entry, now = Date.now()) {
    const source = entry && typeof entry === "object" ? entry : {};
    const normalized = {};
    IMAGE_FIELDS.forEach((field) => {
        if (source[field] && typeof source[field] === "object") {
            normalized[field] = normalizeImageField(source[field], now);
        }
    });
    return Object.keys(normalized).length > 0 ? normalized : null;
}

function getWriteExpiresAt(status, now = Date.now()) {
    if (status === CACHE_STATUS.PARTIAL_FOUND) {
        return now + PARTIAL_FOUND_TTL_SECONDS * 1000;
    }
    if (status === CACHE_STATUS.NOT_FOUND) {
        return now + NOT_FOUND_TTL_SECONDS * 1000;
    }
    return null;
}

function normalizeAutoEntryForWrite(entry, now = Date.now()) {
    const normalized = normalizeEntry(entry);
    return {
        ...normalized,
        expiresAt: getWriteExpiresAt(normalized.status, now),
    };
}

function normalizeTranslationOverrideFields(translation) {
    const source = translation && typeof translation === "object" ? translation : {};
    const normalized = OVERRIDE_FIELDS.reduce((result, field) => {
        if (!isEmptyTranslationValue(source[field])) {
            result[field] = source[field];
        }
        return result;
    }, {});
    return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeTranslationOverrideEntry(entry, now = Date.now()) {
    const source = entry && typeof entry === "object" ? entry : {};
    return {
        translation: normalizeTranslationOverrideFields(source.translation),
        updatedAt: Number.isFinite(source.updatedAt) ? source.updatedAt : now,
    };
}

function createEmptyTranslationOverridesStore() {
    return {
        shows: {},
        movies: {},
        episodes: {},
    };
}

function normalizeTranslationOverridesStore(value) {
    const source = value && typeof value === "object" ? value : {};
    return Object.fromEntries(
        MEDIA_TYPES.map((mediaType) => {
            const entries = source[mediaType] && typeof source[mediaType] === "object" ? source[mediaType] : {};
            const normalizedEntries = Object.fromEntries(
                Object.entries(entries)
                    .map(([id, entry]) => [id, normalizeTranslationOverrideEntry(entry)])
                    .filter(([, entry]) => entry.translation),
            );
            return [mediaType, normalizedEntries];
        }),
    );
}

function mergeEntries(autoEntry, override) {
    const auto = autoEntry ? normalizeEntry(autoEntry) : null;
    const normalizedOverride = override ? normalizeTranslationOverrideEntry(override) : null;
    const autoTranslation = auto?.translation ? auto.translation : {};
    const translationOverrides = normalizedOverride?.translation ? normalizedOverride.translation : {};

    const translation = OVERRIDE_FIELDS.reduce((result, field) => {
        const overrideValue = translationOverrides[field];
        result[field] = !isEmptyTranslationValue(overrideValue) ? overrideValue : autoTranslation[field] || null;
        return result;
    }, {});

    return {
        status: hasUsefulTranslation(translation) ? CACHE_STATUS.FOUND : CACHE_STATUS.NOT_FOUND,
        translation: hasUsefulTranslation(translation) ? translation : null,
    };
}

function getKvConfig() {
    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
    const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

    if (!url || !token) {
        return null;
    }

    return {
        url: url.replace(/\/+$/, ""),
        token,
    };
}

function sendKvNotConfigured(res) {
    res.status(500).json({
        error: "KV is not configured. Set KV_REST_API_URL and KV_REST_API_TOKEN, or UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
    });
}

async function kvRequest(config, path, init) {
    const response = await fetch(`${config.url}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${config.token}`,
            "Content-Type": "application/json",
            ...(init?.headers ? init.headers : {}),
        },
    });

    if (!response.ok) {
        throw new Error(`KV HTTP ${response.status}`);
    }

    return response.json();
}

function buildCacheKey(mediaType, lookupKey) {
    return `trakt:translation:${mediaType}:${lookupKey}`;
}

function buildImageCacheKey(group, lookupKey) {
    return buildImageCacheKeyForMode("chinese", group, lookupKey);
}

function normalizeImageCacheMode(mode) {
    const normalized = String(mode || "")
        .trim()
        .toLowerCase();
    return normalized === "original" ? "original" : "chinese";
}

function buildImageCacheKeyForMode(mode, group, lookupKey) {
    const normalizedMode = normalizeImageCacheMode(mode);
    const normalizedGroup = IMAGE_GROUPS.includes(group) ? group : "";
    const normalizedLookupKey = String(lookupKey || "").trim();
    if (!normalizedGroup || !normalizedLookupKey) {
        return "";
    }
    return `trakt:image:${normalizedMode}:${normalizedGroup}:${normalizedLookupKey}`;
}

function buildOverrideCacheKey(mediaType, lookupKey) {
    return `${TRANSLATION_OVERRIDES_KEY}:${mediaType}:${lookupKey}`;
}

function buildTranslationOverridesKey() {
    return TRANSLATION_OVERRIDES_KEY;
}

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
        return { traktType: "movie,show", mediaTypes: new Set(["movies", "shows"]) };
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

function hasCachePair(pair) {
    return !!(pair && (pair.autoEntry || pair.override || pair.effectiveEntry));
}

function parseRedisJsonValue(value) {
    if (value === undefined || value === null || value === "") {
        return null;
    }

    let parsed = value;
    if (typeof parsed === "string") {
        try {
            parsed = JSON.parse(parsed);
        } catch {
            return null;
        }
    }

    if (Array.isArray(parsed)) {
        return parsed.length > 0 ? parsed[0] : null;
    }

    return parsed && typeof parsed === "object" ? parsed : null;
}

function parseCachedEntry(value) {
    const parsed = parseRedisJsonValue(value);
    if (!parsed) {
        return null;
    }

    return normalizeEntry(parsed);
}

function parseCachedImageEntry(value) {
    const parsed = parseRedisJsonValue(value);
    return parsed ? normalizeImageEntry(parsed) : null;
}

function parseCachedTranslationOverridesStore(value) {
    const parsed = parseRedisJsonValue(value);
    return parsed ? normalizeTranslationOverridesStore(parsed) : createEmptyTranslationOverridesStore();
}

function getExpiresAtFromTtl(ttlMs, now = Date.now()) {
    const ttl = Number(ttlMs);
    return Number.isFinite(ttl) && ttl > 0 ? now + ttl : null;
}

function getResponseCacheStatus(...groups) {
    let hasEntries = false;
    let hasPartialFound = false;

    for (const group of groups) {
        for (const entry of Object.values(group || {})) {
            hasEntries = true;
            if (!entry || typeof entry !== "object") {
                return CACHE_STATUS.NOT_FOUND;
            }

            const statuses = Number.isFinite(entry.status)
                ? [entry.status]
                : Object.values(entry)
                      .map((field) => field?.status)
                      .filter(Number.isFinite);
            if (statuses.length === 0 || statuses.includes(CACHE_STATUS.NOT_FOUND)) {
                return CACHE_STATUS.NOT_FOUND;
            }

            if (statuses.includes(CACHE_STATUS.PARTIAL_FOUND)) {
                hasPartialFound = true;
            }
        }
    }

    if (!hasEntries) {
        return CACHE_STATUS.NOT_FOUND;
    }

    return hasPartialFound ? CACHE_STATUS.PARTIAL_FOUND : CACHE_STATUS.FOUND;
}

function setResponseCacheHeaders(res, status) {
    const headers = RESPONSE_CACHE_HEADERS[status] || RESPONSE_CACHE_HEADERS[CACHE_STATUS.NOT_FOUND];
    Object.entries(headers).forEach(([key, value]) => {
        res.setHeader(key, value);
    });
}

async function jsonGetManyKv(config, keys) {
    if (!config || keys.length === 0) {
        return [];
    }

    const [result] = await pipelineKv(config, [["JSON.MGET", ...keys, "$"]]);
    return Array.isArray(result) ? result : [];
}

async function jsonGetPairKv(config, keys) {
    if (!config || keys.length === 0) {
        return [];
    }

    return pipelineKv(
        config,
        keys.map((key) => ["JSON.GET", key, "$"]),
    );
}

async function pttlManyKv(config, keys) {
    if (!config || keys.length === 0) {
        return [];
    }

    return pipelineKv(
        config,
        keys.map((key) => ["PTTL", key]),
    );
}

async function pipelineKv(config, commands) {
    if (!config || commands.length === 0) {
        return [];
    }

    const payload = await kvRequest(config, "/pipeline", {
        method: "POST",
        body: JSON.stringify(commands),
    });
    if (!Array.isArray(payload)) {
        throw new Error("KV pipeline returned non-array response");
    }

    return payload.map((item) => {
        if (!item || typeof item !== "object") {
            throw new Error("KV pipeline returned invalid command response");
        }
        if ("error" in item) {
            throw new Error(`KV pipeline command failed: ${item.error}`);
        }
        if (!("result" in item)) {
            throw new Error("KV pipeline command response is missing result");
        }
        return item.result;
    });
}

async function scanManyKvKeys(config, requests) {
    if (!config || requests.length === 0) {
        return [];
    }

    const results = await pipelineKv(
        config,
        requests.map((request) => ["SCAN", request.cursor, "MATCH", request.pattern, "COUNT", request.count]),
    );
    return results.map((result) => parseScanResult(result));
}

async function readManyEffectiveFromKv(config, mediaType, ids, options = {}) {
    if (!config || ids.length === 0) {
        return {};
    }

    const autoKeys = ids.map((id) => buildCacheKey(mediaType, id));
    const [autoResults, translationOverrides] = await Promise.all([jsonGetManyKv(config, autoKeys), readAllTranslationOverridesFromKv(config)]);
    const entries = {};

    ids.forEach((id, index) => {
        const autoEntry = parseCachedEntry(autoResults[index]);
        const override = translationOverrides[mediaType]?.[id] || null;
        if (autoEntry || override) {
            entries[id] = {
                ...mergeEntries(autoEntry, override),
                ...(options.includeOverride === true && override ? { override } : {}),
            };
        }
    });

    return entries;
}

async function readManyAutoFromKv(config, mediaType, ids) {
    if (!config || ids.length === 0) {
        return {};
    }

    const autoResults = await jsonGetManyKv(
        config,
        ids.map((id) => buildCacheKey(mediaType, id)),
    );
    const entries = {};
    ids.forEach((id, index) => {
        const autoEntry = parseCachedEntry(autoResults[index]);
        if (autoEntry) {
            entries[id] = autoEntry;
        }
    });
    return entries;
}

async function readManyAutoGroupsFromKv(config, groupsByMediaType) {
    if (!config) {
        return createEmptyTranslationOverridesStore();
    }

    const refs = MEDIA_TYPES.flatMap((mediaType) => {
        const ids = groupsByMediaType[mediaType] || [];
        return ids.map((id) => ({ mediaType, id, key: buildCacheKey(mediaType, id) }));
    });
    const results = await jsonGetManyKv(
        config,
        refs.map((ref) => ref.key),
    );
    const entries = createEmptyTranslationOverridesStore();
    refs.forEach((ref, index) => {
        const autoEntry = parseCachedEntry(results[index]);
        if (autoEntry) {
            entries[ref.mediaType][ref.id] = autoEntry;
        }
    });
    return entries;
}

async function readManyImageGroupsFromKv(config, groupsByGroup) {
    if (!config) {
        return Object.fromEntries(IMAGE_GROUPS.map((group) => [group, {}]));
    }

    const refs = IMAGE_GROUPS.flatMap((group) => {
        const ids = groupsByGroup[group] || [];
        return ids.map((id) => ({ group, id, key: buildImageCacheKeyForMode(groupsByGroup.mode, group, id) }));
    });
    const results = await jsonGetManyKv(
        config,
        refs.map((ref) => ref.key),
    );
    const entries = Object.fromEntries(IMAGE_GROUPS.map((group) => [group, {}]));
    refs.forEach((ref, index) => {
        const imageEntry = parseCachedImageEntry(results[index]);
        if (imageEntry) {
            entries[ref.group][ref.id] = imageEntry;
        }
    });
    return entries;
}

async function readCachePairsFromKv(config, entries) {
    if (!config || entries.length === 0) {
        return [];
    }

    const autoKeys = entries.map((entry) => buildCacheKey(entry.type, entry.id));
    const [autoResults, translationOverrides] = await Promise.all([jsonGetManyKv(config, autoKeys), readAllTranslationOverridesFromKv(config)]);

    return entries.map((entry, index) => {
        const autoEntry = parseCachedEntry(autoResults[index]);
        const override = translationOverrides[entry.type]?.[entry.id] || null;
        return {
            effectiveEntry: autoEntry || override ? mergeEntries(autoEntry, override) : null,
            autoEntry,
            override,
        };
    });
}

async function readCachePairFromKv(config, mediaType, id, options = {}) {
    if (!config || !id) {
        return {
            effectiveEntry: null,
            autoEntry: null,
            override: null,
        };
    }

    const autoKey = buildCacheKey(mediaType, id);
    const [[autoValue], translationOverrides] = await Promise.all([jsonGetPairKv(config, [autoKey]), readAllTranslationOverridesFromKv(config)]);
    let autoEntry = parseCachedEntry(autoValue);
    if (options.hydrateMissingExpiresAt === true && autoEntry && !Object.hasOwn(autoEntry, "expiresAt")) {
        const [autoTtl] = await pttlManyKv(config, [autoKey]);
        const expiresAt = getExpiresAtFromTtl(autoTtl);
        autoEntry = {
            ...autoEntry,
            expiresAt,
        };
        await pipelineKv(config, [["JSON.SET", autoKey, "$", JSON.stringify(autoEntry)]]);
    }
    const override = translationOverrides[mediaType]?.[id] || null;

    return {
        effectiveEntry: autoEntry || override ? mergeEntries(autoEntry, override) : null,
        autoEntry,
        override,
    };
}

function buildWriteManyCommands(mediaType, entriesById) {
    const msetArgs = [];
    const ttlCommands = [];
    const now = Date.now();
    Object.entries(entriesById).forEach(([id, rawEntry]) => {
        const entry = normalizeAutoEntryForWrite(rawEntry, now);
        const key = buildCacheKey(mediaType, id);
        msetArgs.push(key, "$", JSON.stringify(entry));
        if (entry.status === CACHE_STATUS.FOUND) {
            return;
        }

        const ttl = entry.status === CACHE_STATUS.PARTIAL_FOUND ? PARTIAL_FOUND_TTL_SECONDS : NOT_FOUND_TTL_SECONDS;
        ttlCommands.push(["EXPIRE", key, ttl]);
    });
    return msetArgs.length > 0 ? [["JSON.MSET", ...msetArgs], ...ttlCommands] : [];
}

async function writeManyToKv(config, mediaType, entriesById) {
    if (!config) {
        return;
    }

    const commands = buildWriteManyCommands(mediaType, entriesById);

    if (commands.length === 0) {
        return;
    }

    await pipelineKv(config, commands);
}

async function writeManyGroupsToKv(config, groupsByMediaType) {
    if (!config) {
        return;
    }

    const commands = Object.entries(groupsByMediaType).flatMap(([mediaType, entriesById]) => buildWriteManyCommands(mediaType, entriesById || {}));
    if (commands.length === 0) {
        return;
    }

    await pipelineKv(config, commands);
}

function buildWriteManyImageCommands(group, entriesById, mode = "chinese") {
    const msetArgs = [];
    const ttlCommands = [];
    const now = Date.now();
    Object.entries(entriesById).forEach(([id, rawEntry]) => {
        const entry = normalizeImageEntry(rawEntry, now);
        if (!entry) {
            return;
        }
        const key = buildImageCacheKeyForMode(mode, group, id);
        if (!key) {
            return;
        }
        msetArgs.push(key, "$", JSON.stringify(entry));
        const fields = Object.values(entry);
        const hasNotFound = fields.some((field) => field?.status === CACHE_STATUS.NOT_FOUND);
        const hasPartialFound = fields.some((field) => field?.status === CACHE_STATUS.PARTIAL_FOUND);
        if (hasNotFound) {
            ttlCommands.push(["EXPIRE", key, NOT_FOUND_TTL_SECONDS]);
        } else if (hasPartialFound) {
            ttlCommands.push(["EXPIRE", key, PARTIAL_FOUND_TTL_SECONDS]);
        }
    });
    return msetArgs.length > 0 ? [["JSON.MSET", ...msetArgs], ...ttlCommands] : [];
}

async function writeManyImageGroupsToKv(config, groupsByGroup) {
    if (!config) {
        return;
    }

    const modes = groupsByGroup?.modes && typeof groupsByGroup.modes === "object" ? groupsByGroup.modes : null;
    const commands = (modes ? Object.entries(modes) : []).flatMap(([mode, groups]) =>
        Object.entries(groups || {}).flatMap(([group, entriesById]) => (IMAGE_GROUPS.includes(group) ? buildWriteManyImageCommands(group, entriesById || {}, mode) : [])),
    );
    if (commands.length === 0) {
        return;
    }

    await pipelineKv(config, commands);
}

async function writeTranslationOverrideEntryToKv(config, mediaType, id, entry) {
    const override = normalizeTranslationOverrideEntry(entry);
    const translationOverrides = await readAllTranslationOverridesFromKv(config);
    const nextStore = normalizeTranslationOverridesStore({
        ...translationOverrides,
        [mediaType]: {
            ...translationOverrides[mediaType],
            [id]: override,
        },
    });
    await pipelineKv(config, [["JSON.SET", buildTranslationOverridesKey(), "$", JSON.stringify(nextStore)]]);
    return override;
}

async function readAllTranslationOverridesFromKv(config) {
    if (!config) {
        return createEmptyTranslationOverridesStore();
    }

    const [value] = await jsonGetPairKv(config, [buildTranslationOverridesKey()]);
    return parseCachedTranslationOverridesStore(value);
}

async function deleteCacheEntriesFromKv(config, mediaType, id, target) {
    const commands = [];
    if (target === "auto" || target === "all") {
        commands.push(["DEL", buildCacheKey(mediaType, id)]);
    }
    if (target === "override" || target === "all") {
        const translationOverrides = await readAllTranslationOverridesFromKv(config);
        if (translationOverrides[mediaType] && Object.hasOwn(translationOverrides[mediaType], id)) {
            const nextStore = normalizeTranslationOverridesStore({
                ...translationOverrides,
                [mediaType]: Object.fromEntries(Object.entries(translationOverrides[mediaType]).filter(([entryId]) => entryId !== id)),
            });
            commands.push(["JSON.SET", buildTranslationOverridesKey(), "$", JSON.stringify(nextStore)]);
        }
    }

    if (commands.length === 0) {
        return 0;
    }

    await pipelineKv(config, commands);
    return commands.length;
}

function parseScanResult(result) {
    if (Array.isArray(result)) {
        return {
            cursor: String(result[0] || "0"),
            keys: Array.isArray(result[1]) ? result[1] : [],
        };
    }

    if (result && typeof result === "object") {
        return {
            cursor: String(result.cursor || result.nextCursor || "0"),
            keys: Array.isArray(result.keys) ? result.keys : [],
        };
    }

    return {
        cursor: "0",
        keys: [],
    };
}

function getIdFromCacheKey(key, mediaType) {
    const autoPrefix = buildCacheKey(mediaType, "");
    const overridePrefix = buildOverrideCacheKey(mediaType, "");
    if (key.startsWith(autoPrefix)) {
        return key.slice(autoPrefix.length);
    }
    if (key.startsWith(overridePrefix)) {
        return key.slice(overridePrefix.length);
    }
    return "";
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
        const cursor = cursorByType[type] || { autoCursor: "0", overrideCursor: "0" };
        return {
            type,
            cursor: cursor.autoCursor,
            pattern: `${buildCacheKey(type, "")}*`,
            count: scanLimit,
        };
    });
    const scanResults = await scanManyKvKeys(config, scanRequests);
    const scanEntries = scanRequests.map((request, index) => ({ type: request.type, autoScan: scanResults[index] || { cursor: "0", keys: [] } }));

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

async function readJsonBody(req) {
    if (req.body && typeof req.body === "object") {
        return req.body;
    }

    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }

    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? JSON.parse(raw) : {};
}

module.exports = {
    CACHE_STATUS,
    OVERRIDE_FIELDS,
    TRANSLATION_OVERRIDES_KEY,
    MEDIA_TYPES,
    IMAGE_GROUPS,
    buildCacheKey,
    buildImageCacheKey,
    buildImageCacheKeyForMode,
    buildOverrideCacheKey,
    buildTranslationOverridesKey,
    deleteCacheEntriesFromKv,
    getKvConfig,
    getResponseCacheStatus,
    isSupportedMediaType,
    listCacheItemsFromKv,
    normalizeTranslationOverrideEntry,
    parseEpisodeKeys,
    parseIds,
    parseSeasonKeys,
    readAllTranslationOverridesFromKv,
    readManyAutoFromKv,
    readManyAutoGroupsFromKv,
    readManyImageGroupsFromKv,
    readCachePairFromKv,
    readJsonBody,
    readManyEffectiveFromKv,
    sendKvNotConfigured,
    setResponseCacheHeaders,
    writeTranslationOverrideEntryToKv,
    writeManyGroupsToKv,
    writeManyImageGroupsToKv,
    writeManyToKv,
};
