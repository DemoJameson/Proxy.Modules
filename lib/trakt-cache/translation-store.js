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

const { jsonGetManyKv, jsonGetPairKv, pipelineKv, parseRedisJsonValue } = require("./kv-client");

const { buildLocaleWriteCommands, normalizeLocale, pickLocaleEntry } = require("./locale");

// 旧结构（根字段平铺）判定：status 为 1/2/3
function hasTranslationRootData(doc) {
    return !!doc && typeof doc === "object" && (doc.status === 1 || doc.status === 2 || doc.status === 3);
}

const TRANSLATION_ROOT_FIELDS = ["status", "translation", "complete", "expiresAt"];

function projectAutoEntry(value, locale, now = Date.now()) {
    const doc = parseRedisJsonValue(value);
    const { entry } = pickLocaleEntry(doc, locale, { hasRootData: hasTranslationRootData, now });
    return entry ? normalizeEntry(entry) : null;
}

// 覆盖文档条目：cn/tw/hk 各存一份 translation（旧文档的根字段 translation 等价 cn，读取时兜底）
// 投影按地区生效，tw/hk 不回退 cn；与 cn 相同的本地区值视为伪覆盖并忽略，与脚本 resolveOverrideField 一致
function pickOverrideForLocale(entry, locale) {
    if (!entry || typeof entry !== "object") {
        return null;
    }
    const normalizedLocale = normalizeLocale(locale);
    const cnTranslation = entry.cn?.translation ?? entry.translation;
    const translation = OVERRIDE_FIELDS.reduce((result, field) => {
        let value;
        if (normalizedLocale === "cn") {
            value = cnTranslation?.[field];
        } else {
            const localizedValue = entry[normalizedLocale]?.translation?.[field];
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
        const autoEntry = projectAutoEntry(autoResults[index], options.locale);
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

    const autoResults = await jsonGetManyKv(
        config,
        ids.map((id) => buildCacheKey(mediaType, id)),
    );
    const entries = {};
    ids.forEach((id, index) => {
        const autoEntry = projectAutoEntry(autoResults[index], options.locale);
        if (autoEntry) {
            entries[id] = autoEntry;
        }
    });
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
            mediaType,
            id,
            key: buildCacheKey(mediaType, id),
        }));
    });
    const results = await jsonGetManyKv(
        config,
        refs.map((ref) => ref.key),
    );
    const entries = createEmptyTranslationOverridesStore();
    // cn 提示：旧结构文档在 tw/hk 请求下回带根字段数据，供客户端写入时原子折叠
    const cnHints = createEmptyTranslationOverridesStore();
    const now = Date.now();
    refs.forEach((ref, index) => {
        const doc = parseRedisJsonValue(results[index]);
        const { entry, cnData } = pickLocaleEntry(doc, options.locale, { hasRootData: hasTranslationRootData, now });
        if (entry) {
            entries[ref.mediaType][ref.id] = normalizeEntry(entry);
        }
        if (cnData) {
            cnHints[ref.mediaType][ref.id] = normalizeEntry(cnData);
        }
    });
    return { ...entries, cn: cnHints };
}

async function readCachePairsFromKv(config, entries, options = {}) {
    if (!config || entries.length === 0) {
        return [];
    }

    const autoKeys = entries.map((entry) => buildCacheKey(entry.type, entry.id));
    const [autoResults, translationOverrides] = await Promise.all([jsonGetManyKv(config, autoKeys), readAllTranslationOverridesFromKv(config)]);

    return entries.map((entry, index) => {
        const autoEntry = projectAutoEntry(autoResults[index], options.locale);
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

    const autoKey = buildCacheKey(mediaType, id);
    const [[autoValue], translationOverrides] = await Promise.all([jsonGetPairKv(config, [autoKey]), readAllTranslationOverridesFromKv(config)]);
    const autoEntry = projectAutoEntry(autoValue, options.locale);
    const overrideEntry = translationOverrides[mediaType]?.[id] ?? null;
    const override = pickOverrideForLocale(overrideEntry, options.locale);

    return {
        effectiveEntry: autoEntry || overrideEntry ? mergeEntries(autoEntry, overrideEntry, normalizeLocale(options.locale)) : null,
        autoEntry,
        override,
        overrideEntry,
    };
}

// 过期时间写进数据字段 expiresAt（FOUND 为 null），不再发送 EXPIRE
function buildWriteManyCommands(mediaType, entriesById, options = {}) {
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
    return buildLocaleWriteCommands(items, { rootFields: TRANSLATION_ROOT_FIELDS });
}

async function writeManyToKv(config, mediaType, entriesById, options = {}) {
    if (!config) {
        return;
    }

    const commands = buildWriteManyCommands(mediaType, entriesById, options);

    if (commands.length === 0) {
        return;
    }

    await pipelineKv(config, commands);
}

async function writeManyGroupsToKv(config, groupsByMediaType, options = {}) {
    if (!config) {
        return;
    }

    const cnGroups = options.cn && typeof options.cn === "object" ? options.cn : {};
    const commands = Object.entries(groupsByMediaType).flatMap(([mediaType, entriesById]) =>
        buildWriteManyCommands(mediaType, entriesById || {}, { ...options, cn: cnGroups[mediaType] || {} }),
    );
    if (commands.length === 0) {
        return;
    }

    await pipelineKv(config, commands);
}

// 本次写入的字段：优先取目标地区槽位；兼容管理端旧 payload（根字段 translation 表示"本次地区的字段"）
function pickOverrideWriteFields(entry, locale) {
    const source = entry && typeof entry === "object" ? entry : {};
    const localized = source[locale]?.translation;
    if (localized && typeof localized === "object") {
        return localized;
    }
    return source.translation && typeof source.translation === "object" ? source.translation : null;
}

async function writeTranslationOverrideEntryToKv(config, mediaType, id, entry, options = {}) {
    const override = normalizeTranslationOverrideEntry(entry);
    const locale = normalizeLocale(options.locale);
    const fields = pickOverrideWriteFields(entry, locale);
    const translationOverrides = await readAllTranslationOverridesFromKv(config);
    const currentEntry = translationOverrides[mediaType]?.[id];
    const nextEntry = { ...(currentEntry && typeof currentEntry === "object" ? currentEntry : {}) };
    if (locale === "cn") {
        nextEntry.cn = { translation: fields ?? nextEntry.cn?.translation ?? nextEntry.translation };
        // 旧文档的根字段随写入迁移到 cn
        delete nextEntry.translation;
    } else {
        nextEntry[locale] = { translation: fields ?? nextEntry[locale]?.translation };
    }
    const nextStore = normalizeTranslationOverridesStore({
        ...translationOverrides,
        [mediaType]: {
            ...translationOverrides[mediaType],
            [id]: nextEntry,
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

async function deleteCacheEntriesFromKv(config, mediaType, id, target, options = {}) {
    const locale = normalizeLocale(options.locale);
    const commands = [];
    let deleted = 0;
    if (target === "auto" || target === "all") {
        // JSON.DEL 对不存在的 key/字段返回 0，不会像对缺失 key 的 JSON.MSET 那样报错
        const key = buildCacheKey(mediaType, id);
        if (locale === "cn") {
            ["$.cn", ...TRANSLATION_ROOT_FIELDS.map((field) => `$.${field}`)].forEach((jsonPath) => {
                commands.push(["JSON.DEL", key, jsonPath]);
            });
        } else {
            commands.push(["JSON.DEL", key, `$.${locale}`]);
        }
        deleted += 1;
    }
    if (target === "override" || target === "all") {
        const translationOverrides = await readAllTranslationOverridesFromKv(config);
        if (translationOverrides[mediaType] && Object.hasOwn(translationOverrides[mediaType], id)) {
            const currentEntry = translationOverrides[mediaType][id] || {};
            const nextEntry = { ...currentEntry };
            if (locale === "cn") {
                delete nextEntry.cn;
                // 旧文档残留的根字段一并清掉
                delete nextEntry.translation;
            } else {
                delete nextEntry[locale];
            }
            const entries = Object.fromEntries(Object.entries(translationOverrides[mediaType]).filter(([entryId]) => entryId !== id));
            if (Object.keys(nextEntry).length > 0) {
                entries[id] = nextEntry;
            }
            const nextStore = normalizeTranslationOverridesStore({
                ...translationOverrides,
                [mediaType]: entries,
            });
            commands.push(["JSON.SET", buildTranslationOverridesKey(), "$", JSON.stringify(nextStore)]);
            deleted += 1;
        }
    }

    if (commands.length === 0) {
        return 0;
    }

    await pipelineKv(config, commands);
    return deleted;
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
