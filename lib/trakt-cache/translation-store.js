const {
    MEDIA_TYPES,
    OVERRIDE_FIELDS,
    TRANSLATION_OVERRIDES_KEY,
    isEmptyTranslationValue,
    normalizeAutoEntryForWrite,
    normalizeEntry,
    normalizeTranslationOverrideEntry,
    normalizeTranslationOverridesStore,
    createEmptyTranslationOverridesStore,
    mergeEntries,
} = require("./normalize");

const { delKv, hdelKv, hgetallKv, hmgetKv, hsetKv, parseRedisJsonValue } = require("./kv-client");

const { buildLocaleKey, normalizeLocale, readLocaleEntriesFromKv, writeLocaleEntriesToKv } = require("./locale");

function buildCacheKey(mediaType, lookupKey) {
    return `translation:${mediaType}:${lookupKey}`;
}

function buildCacheKeyForLocale(mediaType, lookupKey, locale) {
    return buildLocaleKey(buildCacheKey(mediaType, lookupKey), locale);
}

function buildCacheKeyPattern(mediaType, locale) {
    return `translation:${mediaType}:*:${normalizeLocale(locale)}`;
}

function buildTranslationOverridesKey() {
    return TRANSLATION_OVERRIDES_KEY;
}

function buildOverrideField(mediaType, lookupKey, locale) {
    return `${mediaType}:${String(lookupKey ?? "").trim()}:${normalizeLocale(locale)}`;
}

const OVERRIDE_ID_PATTERNS = {
    // 脚本把季级覆盖归到 shows 组，ID 形如 `{showId}:{seasonNumber}`
    shows: /^\d+(?::\d+)?$/,
    movies: /^\d+$/,
    episodes: /^\d+:\d+:\d+$/,
};

function isValidOverrideId(mediaType, id) {
    const normalizedId = String(id || "").trim();
    const pattern = OVERRIDE_ID_PATTERNS[mediaType];
    return !!pattern && pattern.test(normalizedId);
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

function getExpiresAtFromTtl(ttlMs, now = Date.now()) {
    const ttl = Number(ttlMs);
    return Number.isFinite(ttl) && ttl > 0 ? now + ttl : null;
}

// 覆盖条目按地区投影；tw/hk 不回退 cn，与脚本侧规则保持一致。
function pickOverrideForLocale(entry, locale) {
    if (!entry || typeof entry !== "object") {
        return null;
    }
    const normalizedLocale = normalizeLocale(locale);
    const cnEntry = Object.hasOwn(entry, "cn") ? entry.cn : null;
    const cnTranslation = cnEntry?.translation;
    const translation = OVERRIDE_FIELDS.reduce((result, field) => {
        let value;
        if (normalizedLocale === "cn") {
            value = cnTranslation?.[field];
        } else {
            const localizedEntry = Object.hasOwn(entry, normalizedLocale) ? entry[normalizedLocale] : null;
            const localizedValue = localizedEntry?.translation?.[field];
            const cnValue = cnTranslation?.[field];
            value = !isEmptyTranslationValue(localizedValue) && (isEmptyTranslationValue(cnValue) || localizedValue !== cnValue) ? localizedValue : undefined;
        }
        if (!isEmptyTranslationValue(value)) {
            result[field] = value;
        }
        return result;
    }, {});
    return Object.keys(translation).length > 0 ? { translation } : null;
}

function parseOverrideValue(value) {
    const parsed = parseRedisJsonValue(value);
    if (!parsed || typeof parsed !== "object" || !Object.hasOwn(parsed, "translation") || !parsed.translation || typeof parsed.translation !== "object") {
        return null;
    }
    return {
        translation: parsed.translation,
        updatedAt: Number.isFinite(Number(parsed.updatedAt)) ? Number(parsed.updatedAt) : undefined,
    };
}

function parseOverrideField(field) {
    const parts = String(field || "").split(":");
    if (parts.length < 3) {
        return null;
    }
    const locale = parts.pop();
    const mediaType = parts.shift();
    const id = parts.join(":").trim();
    if (!MEDIA_TYPES.includes(mediaType) || !["cn", "tw", "hk"].includes(locale) || !isValidOverrideId(mediaType, id)) {
        return null;
    }
    return { mediaType, id, locale };
}

async function readTranslationOverrideEntryFromKv(config, mediaType, id) {
    if (!config || !MEDIA_TYPES.includes(mediaType) || !isValidOverrideId(mediaType, id)) {
        return null;
    }

    const fields = ["cn", "tw", "hk"].map((locale) => buildOverrideField(mediaType, id, locale));
    const values = await hmgetKv(config, buildTranslationOverridesKey(), fields);
    const entry = Object.create(null);
    let latestUpdatedAt = 0;
    fields.forEach((field, index) => {
        const locale = ["cn", "tw", "hk"][index];
        const parsed = parseOverrideValue(values[field]);
        if (!parsed) {
            return;
        }
        entry[locale] = { translation: parsed.translation };
        if (parsed.updatedAt) {
            latestUpdatedAt = Math.max(latestUpdatedAt, parsed.updatedAt);
        }
    });
    if (Object.keys(entry).length === 0) {
        return null;
    }
    if (latestUpdatedAt > 0) {
        entry.updatedAt = latestUpdatedAt;
    }
    return normalizeTranslationOverrideEntry(entry);
}

async function readAllTranslationOverridesFromKv(config) {
    if (!config) {
        return createEmptyTranslationOverridesStore();
    }

    const hash = await hgetallKv(config, buildTranslationOverridesKey());
    const entriesByType = Object.fromEntries(MEDIA_TYPES.map((mediaType) => [mediaType, Object.create(null)]));
    Object.entries(hash).forEach(([field, value]) => {
        const parsedField = parseOverrideField(field);
        const parsedValue = parseOverrideValue(value);
        if (!parsedField || !parsedValue) {
            return;
        }
        const current = Object.hasOwn(entriesByType[parsedField.mediaType], parsedField.id) ? entriesByType[parsedField.mediaType][parsedField.id] : Object.create(null);
        current[parsedField.locale] = { translation: parsedValue.translation };
        if (parsedValue.updatedAt) {
            current.updatedAt = Math.max(Number(current.updatedAt) || 0, parsedValue.updatedAt);
        }
        entriesByType[parsedField.mediaType][parsedField.id] = current;
    });
    return normalizeTranslationOverridesStore(entriesByType);
}

async function readManyEffectiveFromKv(config, mediaType, ids, options = {}) {
    if (!config || ids.length === 0) {
        return {};
    }

    const [autoEntries, translationOverrides] = await Promise.all([readManyAutoFromKv(config, mediaType, ids, options), readAllTranslationOverridesFromKv(config)]);
    const entries = {};
    ids.forEach((id) => {
        const autoEntry = autoEntries[id] || null;
        const override = translationOverrides[mediaType]?.[id] || null;
        if (autoEntry || override) {
            entries[id] = {
                ...mergeEntries(autoEntry, override, normalizeLocale(options.locale)),
                ...(options.includeOverride === true && override ? { override } : {}),
            };
        }
    });
    return entries;
}

async function readManyAutoFromKv(config, mediaType, ids, options = {}) {
    if (!config || ids.length === 0) {
        return {};
    }

    const refs = ids.map((id) => ({ id, key: buildCacheKey(mediaType, id) }));
    const { entries } = await readLocaleEntriesFromKv(config, refs, { locale: options.locale });
    return entries;
}

async function readManyAutoGroupsFromKv(config, groupsByMediaType, options = {}) {
    const empty = createEmptyTranslationOverridesStore();
    if (!config) {
        return { ...empty, cn: empty };
    }

    const refs = MEDIA_TYPES.flatMap((mediaType) => {
        const ids = groupsByMediaType[mediaType] || [];
        return ids.map((id) => ({
            id: `${mediaType}:${id}`,
            key: buildCacheKey(mediaType, id),
        }));
    });
    const { entries: rawEntries, cnHints: rawCnHints } = await readLocaleEntriesFromKv(config, refs, { locale: options.locale });
    const entries = createEmptyTranslationOverridesStore();
    const cnHints = createEmptyTranslationOverridesStore();
    MEDIA_TYPES.forEach((mediaType) => {
        (groupsByMediaType[mediaType] || []).forEach((id) => {
            const key = `${mediaType}:${id}`;
            if (rawEntries[key]) {
                entries[mediaType][id] = normalizeEntry(rawEntries[key]);
            }
            if (rawCnHints[key]) {
                cnHints[mediaType][id] = normalizeEntry(rawCnHints[key]);
            }
        });
    });
    return { ...entries, cn: cnHints };
}

async function readCachePairsFromKv(config, entries, options = {}) {
    if (!config || entries.length === 0) {
        return [];
    }

    const refs = entries.map((entry, index) => ({ id: String(index), key: buildCacheKey(entry.type, entry.id) }));
    const [{ entries: autoEntries }, translationOverrides] = await Promise.all([
        readLocaleEntriesFromKv(config, refs, { locale: options.locale }),
        readAllTranslationOverridesFromKv(config),
    ]);

    return entries.map((entry, index) => {
        const rawAutoEntry = autoEntries[String(index)] || null;
        const autoEntry = rawAutoEntry ? normalizeEntry(rawAutoEntry) : null;
        const overrideEntry = translationOverrides[entry.type]?.[entry.id] ?? null;
        const override = pickOverrideForLocale(overrideEntry, options.locale);
        return {
            effectiveEntry: autoEntry || overrideEntry ? mergeEntries(autoEntry, overrideEntry, normalizeLocale(options.locale)) : null,
            autoEntry,
            override,
            overrideEntry,
        };
    });
}

async function readCachePairFromKv(config, mediaType, id, options = {}) {
    if (!config || !id) {
        return {
            effectiveEntry: null,
            autoEntry: null,
            override: null,
            overrideEntry: null,
        };
    }

    const [{ entries }, overrideEntry] = await Promise.all([
        readLocaleEntriesFromKv(config, [{ id, key: buildCacheKey(mediaType, id) }], { locale: options.locale }),
        readTranslationOverrideEntryFromKv(config, mediaType, id),
    ]);
    const autoEntry = entries[id] ? normalizeEntry(entries[id]) : null;
    const override = pickOverrideForLocale(overrideEntry, options.locale);
    return {
        effectiveEntry: autoEntry || overrideEntry ? mergeEntries(autoEntry, overrideEntry, normalizeLocale(options.locale)) : null,
        autoEntry,
        override,
        overrideEntry,
    };
}

function buildWriteManyItems(mediaType, entriesById, options = {}) {
    const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
    const locale = normalizeLocale(options.locale);
    const cnById = options.cn && typeof options.cn === "object" ? options.cn : {};
    const items = [];
    Object.entries(entriesById).forEach(([id, rawEntry]) => {
        const key = buildCacheKey(mediaType, id);
        if (!key) {
            return;
        }
        const entry = normalizeAutoEntryForWrite(rawEntry, now);
        const cnData = cnById[id] ? normalizeAutoEntryForWrite(cnById[id], now) : null;
        items.push({ key, locale, entry, cnData });
    });
    return items;
}

async function writeManyToKv(config, mediaType, entriesById, options = {}) {
    if (!config) {
        return;
    }
    await writeLocaleEntriesToKv(config, buildWriteManyItems(mediaType, entriesById, options));
}

async function writeManyGroupsToKv(config, groupsByMediaType, options = {}) {
    if (!config) {
        return;
    }
    const cnGroups = options.cn && typeof options.cn === "object" ? options.cn : {};
    const items = Object.entries(groupsByMediaType).flatMap(([mediaType, entriesById]) =>
        buildWriteManyItems(mediaType, entriesById || {}, { ...options, cn: cnGroups[mediaType] || {} }),
    );
    await writeLocaleEntriesToKv(config, items);
}

function pickOverrideWriteFields(entry, locale) {
    const source = entry && typeof entry === "object" ? entry : {};
    const localized = Object.hasOwn(source, locale) ? source[locale]?.translation : null;
    return localized && typeof localized === "object" ? localized : null;
}

async function writeTranslationOverrideEntryToKv(config, mediaType, id, entry, options = {}) {
    if (!MEDIA_TYPES.includes(mediaType) || !isValidOverrideId(mediaType, id)) {
        return null;
    }
    const override = normalizeTranslationOverrideEntry(entry);
    const locale = normalizeLocale(options.locale);
    const fields = pickOverrideWriteFields(entry, locale);
    if (!fields || Object.keys(fields).length === 0) {
        await hdelKv(config, buildTranslationOverridesKey(), [buildOverrideField(mediaType, id, locale)]);
        return null;
    }
    await hsetKv(config, buildTranslationOverridesKey(), {
        [buildOverrideField(mediaType, id, locale)]: {
            translation: fields,
            updatedAt: override.updatedAt,
        },
    });
    return override;
}

async function deleteCacheEntriesFromKv(config, mediaType, id, target, options = {}) {
    if (!MEDIA_TYPES.includes(mediaType) || !isValidOverrideId(mediaType, id)) {
        return 0;
    }
    const locale = normalizeLocale(options.locale);
    let deleted = 0;
    if (target === "auto" || target === "all") {
        await delKv(config, [buildCacheKeyForLocale(mediaType, id, locale)]);
        deleted += 1;
    }
    if (target === "override" || target === "all") {
        deleted += await hdelKv(config, buildTranslationOverridesKey(), [buildOverrideField(mediaType, id, locale)]);
    }
    return deleted;
}

function getIdFromCacheKey(key, mediaType, locale) {
    const prefix = buildCacheKey(mediaType, "");
    const suffix = `:${normalizeLocale(locale)}`;
    if (key.startsWith(prefix) && key.endsWith(suffix)) {
        const id = key.slice(prefix.length, -suffix.length).trim();
        return isValidOverrideId(mediaType, id) ? id : "";
    }
    return "";
}

module.exports = {
    buildCacheKey,
    buildCacheKeyForLocale,
    buildCacheKeyPattern,
    buildOverrideField,
    isValidOverrideId,
    buildTranslationOverridesKey,
    hasCachePair,
    parseCachedEntry,
    getExpiresAtFromTtl,
    readManyEffectiveFromKv,
    readManyAutoFromKv,
    readManyAutoGroupsFromKv,
    readCachePairsFromKv,
    readCachePairFromKv,
    buildWriteManyItems,
    writeManyToKv,
    writeManyGroupsToKv,
    writeTranslationOverrideEntryToKv,
    readTranslationOverrideEntryFromKv,
    readAllTranslationOverridesFromKv,
    deleteCacheEntriesFromKv,
    getIdFromCacheKey,
};
