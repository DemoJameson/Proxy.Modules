const {
    CACHE_STATUS,
    PARTIAL_FOUND_TTL_SECONDS,
    NOT_FOUND_TTL_SECONDS,
    MEDIA_TYPES,
    TRANSLATION_OVERRIDES_KEY,
    normalizeAutoEntryForWrite,
    normalizeEntry,
    normalizeTranslationOverrideEntry,
    normalizeTranslationOverridesStore,
    createEmptyTranslationOverridesStore,
    mergeEntries,
} = require("./normalize");

const { jsonGetManyKv, jsonGetPairKv, pttlManyKv, pipelineKv, parseRedisJsonValue } = require("./kv-client");

function buildCacheKey(mediaType, lookupKey) {
    return `trakt:translation:${mediaType}:${lookupKey}`;
}

function buildOverrideCacheKey(mediaType, lookupKey) {
    return `${TRANSLATION_OVERRIDES_KEY}:${mediaType}:${lookupKey}`;
}

function buildTranslationOverridesKey() {
    return TRANSLATION_OVERRIDES_KEY;
}

function hasCachePair(pair) {
    return !!(pair && (pair.autoEntry || pair.override || pair.effectiveEntry));
}

function parseCachedEntry(value) {
    const parsed = parseRedisJsonValue(value);
    if (!parsed) {
        return null;
    }

    return normalizeEntry(parsed);
}

function parseCachedTranslationOverridesStore(value) {
    const parsed = parseRedisJsonValue(value);
    return parsed ? normalizeTranslationOverridesStore(parsed) : createEmptyTranslationOverridesStore();
}

function getExpiresAtFromTtl(ttlMs, now = Date.now()) {
    const ttl = Number(ttlMs);
    return Number.isFinite(ttl) && ttl > 0 ? now + ttl : null;
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

module.exports = {
    buildCacheKey,
    buildOverrideCacheKey,
    buildTranslationOverridesKey,
    hasCachePair,
    parseCachedEntry,
    parseCachedTranslationOverridesStore,
    getExpiresAtFromTtl,
    readManyEffectiveFromKv,
    readManyAutoFromKv,
    readManyAutoGroupsFromKv,
    readCachePairsFromKv,
    readCachePairFromKv,
    buildWriteManyCommands,
    writeManyToKv,
    writeManyGroupsToKv,
    writeTranslationOverrideEntryToKv,
    readAllTranslationOverridesFromKv,
    deleteCacheEntriesFromKv,
    getIdFromCacheKey,
};
