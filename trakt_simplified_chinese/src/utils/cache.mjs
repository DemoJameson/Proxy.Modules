import * as translationCache from "../shared/translation-cache.mjs";
import * as commonUtils from "../utils/common.mjs";

const UNIFIED_CACHE_KEY = "dj_trakt_unified_cache";
const UNIFIED_CACHE_REV_KEY = "dj_trakt_unified_cache_rev";
const UNIFIED_CACHE_SCHEMA_VERSION = 9;
const UNIFIED_CACHE_MAX_BYTES = 2 * 1024 * 1024;
const GOOGLE_PEOPLE_CACHE_MAX_BYTES = 512 * 1024;
const LINK_ID_FIELDS = ["trakt", "tmdb", "imdb"];
const UNIFIED_CACHE_SNAPSHOT_RETRY_LIMIT = 3;
const PRUNE_PRIORITY = {
    "google.comments": 1,
    "google.sentiments": 1,
    "google.list": 1,
    "trakt.image.not_found": 2,
    "trakt.image.partial_found": 3,
    "trakt.image.found": 4,
    "trakt.translation.not_found": 5,
    "trakt.translation.partial_found": 6,
    "trakt.translation.found": 7,
    "douban.search": 7,
    "douban.seasons": 7,
    "douban.credits": 7,
    "trakt.linkIds": 8,
    "google.people": 9,
};

function buildFieldTranslationCacheKey(id) {
    return commonUtils.isNullish(id) ? "" : String(id);
}

function estimatePrunableEntryBytes(env, key, entry) {
    const serialized = env.toStr({ [key]: entry }, "");
    return serialized ? Math.max(serialized.length - 2, 0) : 0;
}

function normalizeIdSubset(ids) {
    const source = commonUtils.ensureObject(ids);
    const normalized = {};
    LINK_ID_FIELDS.forEach((field) => {
        if (commonUtils.isNonNullish(source[field])) {
            normalized[field] = source[field];
        }
    });
    return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeHashedTranslationEntry(entry) {
    const sourceTextHash = String(entry?.sourceTextHash ?? "").trim();
    const translatedText = String(entry?.translatedText ?? "").trim();
    return sourceTextHash && translatedText ? { sourceTextHash, translatedText } : null;
}

function normalizePersonTranslationEntry(entry) {
    const source = commonUtils.ensureObject(entry);
    const normalized = {};
    const name = commonUtils.isPlainObject(source.name) ? source.name : null;
    const normalizedName = normalizeHashedTranslationEntry(name);
    if (normalizedName && (name.source === "google" || name.source === "tmdb")) {
        normalized.name = {
            ...normalizedName,
            source: name.source,
        };
    }

    const biography = normalizeHashedTranslationEntry(source.biography);
    if (biography) {
        normalized.biography = biography;
    }

    return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeMediaTranslationValue(translation) {
    const normalized = translationCache.normalizeTranslationPayload(translation);
    if (!normalized) {
        return null;
    }

    return Object.fromEntries(Object.entries(normalized).filter(([, value]) => !translationCache.isEmptyTranslationValue(value)));
}

function normalizeMediaTranslationEntry(entry) {
    const status =
        entry?.status === translationCache.CACHE_STATUS.FOUND
            ? translationCache.CACHE_STATUS.FOUND
            : entry?.status === translationCache.CACHE_STATUS.PARTIAL_FOUND
              ? translationCache.CACHE_STATUS.PARTIAL_FOUND
              : translationCache.CACHE_STATUS.NOT_FOUND;
    const translation = normalizeMediaTranslationValue(entry?.translation);
    if (!translation) {
        return {
            status: translationCache.CACHE_STATUS.NOT_FOUND,
        };
    }

    return {
        status,
        translation,
    };
}

function normalizeImageField(entry) {
    const status =
        entry?.status === translationCache.CACHE_STATUS.FOUND
            ? translationCache.CACHE_STATUS.FOUND
            : entry?.status === translationCache.CACHE_STATUS.PARTIAL_FOUND
              ? translationCache.CACHE_STATUS.PARTIAL_FOUND
              : translationCache.CACHE_STATUS.NOT_FOUND;
    const url = String(entry?.url ?? "").trim();
    const expiresAt = entry?.expiresAt === null ? null : Number(entry?.expiresAt);
    if (status === translationCache.CACHE_STATUS.FOUND && url) {
        return {
            status,
            url,
            expiresAt: null,
        };
    }
    if (status === translationCache.CACHE_STATUS.PARTIAL_FOUND && url && Number.isFinite(expiresAt) && expiresAt > Date.now()) {
        return {
            status,
            url,
            expiresAt,
        };
    }
    if (status === translationCache.CACHE_STATUS.NOT_FOUND && Number.isFinite(expiresAt) && expiresAt > Date.now()) {
        return {
            status,
            expiresAt,
        };
    }

    return null;
}

function normalizeImageEntry(entry) {
    const source = commonUtils.ensureObject(entry);
    const normalized = {};
    ["poster", "logo"].forEach((field) => {
        if (commonUtils.isPlainObject(source[field])) {
            const normalizedField = normalizeImageField(source[field]);
            if (normalizedField) {
                normalized[field] = normalizedField;
            }
        }
    });
    return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeSentimentTranslationEntry(entry) {
    const translation = commonUtils.isPlainObject(entry?.translation) ? entry.translation : commonUtils.isPlainObject(entry) ? entry : null;
    return translation && Object.keys(translation).length > 0 ? { translation } : null;
}

function normalizeHistoryShowsEntry(entry) {
    const source = commonUtils.ensureObject(entry);
    const shows = Object.fromEntries(
        Object.entries(commonUtils.ensureObject(source.shows)).filter(([showId, value]) => {
            return !!String(showId).trim() && value === true;
        }),
    );
    return Object.keys(shows).length > 0 ? { shows } : null;
}

function normalizeDoubanSearchEntry(entry) {
    const id = String(entry?.id ?? "").trim();
    const targetType = String(entry?.targetType ?? "")
        .trim()
        .toLowerCase();
    return id && targetType ? { id, targetType } : null;
}

function normalizeStringArray(value) {
    return commonUtils
        .ensureArray(value)
        .map((item) => String(item ?? "").trim())
        .filter((item, index, array) => item && array.indexOf(item) === index);
}

function normalizeDoubanSeasonsEntry(entry) {
    const ids = normalizeStringArray(commonUtils.isPlainObject(entry) ? entry.ids : entry);
    return ids.length > 0 ? { ids } : null;
}

function normalizeDoubanCreditsEntry(entry) {
    const normalized = {};
    Object.entries(commonUtils.ensureObject(entry)).forEach(([name, roles]) => {
        const normalizedName = String(name ?? "").trim();
        const normalizedRoles = normalizeStringArray(roles);
        if (normalizedName && normalizedRoles.length > 0) {
            normalized[normalizedName] = normalizedRoles;
        }
    });
    return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeDoubanCache(cache) {
    const source = commonUtils.ensureObject(cache);
    return {
        search: normalizeEntryMap(source.search, normalizeDoubanSearchEntry),
        seasons: normalizeEntryMap(source.seasons, normalizeDoubanSeasonsEntry),
        credits: normalizeEntryMap(source.credits, normalizeDoubanCreditsEntry),
    };
}

function normalizeLinkIdsEntry(entry) {
    const source = commonUtils.ensureObject(entry);
    const normalized = {};
    const ids = normalizeIdSubset(source.ids);
    if (ids) {
        normalized.ids = ids;
    }

    const showIds = normalizeIdSubset(source.showIds);
    const seasonNumber = Number(source.seasonNumber);
    const episodeNumber = Number(source.episodeNumber);
    const hasEpisodeContext = !!showIds && Number.isFinite(seasonNumber) && Number.isFinite(episodeNumber);
    if (hasEpisodeContext) {
        normalized.showIds = showIds;
        normalized.seasonNumber = seasonNumber;
        normalized.episodeNumber = episodeNumber;
    }

    const language = String(source.language ?? "").trim();
    if (language) {
        normalized.language = language;
    }

    const country = String(source.country ?? "").trim();
    if (country) {
        normalized.country = country;
    }

    return ids ? normalized : null;
}

function normalizeEntryMap(cache, normalizeEntry) {
    return Object.fromEntries(
        Object.entries(commonUtils.ensureObject(cache))
            .map(([key, entry]) => {
                const normalizedEntry = normalizeEntry(entry);
                return normalizedEntry ? [key, normalizedEntry] : null;
            })
            .filter(Boolean),
    );
}

function getHashedFieldTranslation(cache, id, field, sourceText) {
    const cacheKey = buildFieldTranslationCacheKey(id);
    if (!cacheKey) {
        return "";
    }

    const entry = cache?.[cacheKey];
    const fieldEntry = commonUtils.isPlainObject(entry?.[field]) ? entry[field] : null;
    return fieldEntry && String(fieldEntry.sourceTextHash ?? "") === commonUtils.computeStringHash(sourceText) ? String(fieldEntry.translatedText ?? "").trim() : "";
}

function setHashedFieldTranslation(cache, id, field, sourceText, translatedText) {
    const cacheKey = buildFieldTranslationCacheKey(id);
    const normalizedTranslation = String(translatedText ?? "").trim();
    if (!cacheKey || !normalizedTranslation) {
        return false;
    }

    const currentEntry = commonUtils.isPlainObject(cache?.[cacheKey]) ? cache[cacheKey] : {};
    const nextFieldEntry = {
        sourceTextHash: commonUtils.computeStringHash(sourceText),
        translatedText: normalizedTranslation,
    };
    const currentFieldEntry = commonUtils.isPlainObject(currentEntry[field]) ? currentEntry[field] : null;
    if (currentFieldEntry && currentFieldEntry.sourceTextHash === nextFieldEntry.sourceTextHash && currentFieldEntry.translatedText === nextFieldEntry.translatedText) {
        return false;
    }

    const nextEntry = {
        ...currentEntry,
        [field]: nextFieldEntry,
    };
    cache[cacheKey] = nextEntry;
    return true;
}

function createEmptyUnifiedCache(schemaVersion = UNIFIED_CACHE_SCHEMA_VERSION, maxBytes = UNIFIED_CACHE_MAX_BYTES) {
    return {
        version: schemaVersion,
        rev: Date.now(),
        maxBytes,
        trakt: {
            translation: {},
            linkIds: {},
            image: {},
        },
        google: {
            comments: {},
            sentiments: {},
            people: {},
            list: {},
        },
        douban: {
            search: {},
            seasons: {},
            credits: {},
        },
        persistent: {
            currentSeason: null,
            historyShows: {},
            translationOverrides: {
                fetchedAt: 0,
                shows: {},
                movies: {},
                episodes: {},
            },
        },
    };
}

function normalizeTranslationOverrides(cache) {
    const source = commonUtils.ensureObject(cache);
    const normalizeGroup = (group) => {
        const entries = commonUtils.ensureObject(group);
        return Object.fromEntries(
            Object.entries(entries)
                .map(([key, entry]) => [key, commonUtils.ensureObject(entry, null)])
                .filter(([, entry]) => entry && commonUtils.isPlainObject(entry.translation)),
        );
    };

    return {
        fetchedAt: Number.isFinite(Number(source.fetchedAt)) ? Number(source.fetchedAt) : 0,
        shows: normalizeGroup(source.shows),
        movies: normalizeGroup(source.movies),
        episodes: normalizeGroup(source.episodes),
    };
}

function normalizeRevlessEntryMap(cache) {
    return normalizeEntryMap(cache, (entry) => {
        return commonUtils.isPlainObject(entry) ? Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "rev")) : null;
    });
}

function normalizeUnifiedCache(rawCache, schemaVersion = UNIFIED_CACHE_SCHEMA_VERSION, maxBytes = UNIFIED_CACHE_MAX_BYTES) {
    const cache = commonUtils.isPlainObject(rawCache) ? rawCache : {};
    const nextCache = createEmptyUnifiedCache(schemaVersion, maxBytes);

    nextCache.rev = Number.isFinite(Number(cache.rev)) ? Number(cache.rev) : nextCache.rev;
    nextCache.maxBytes = Number.isFinite(Number(cache.maxBytes)) ? Number(cache.maxBytes) : maxBytes;

    const traktCache = commonUtils.ensureObject(cache.trakt);
    nextCache.trakt.translation = normalizeEntryMap(traktCache.translation, normalizeMediaTranslationEntry);
    nextCache.trakt.linkIds = normalizeEntryMap(traktCache.linkIds, normalizeLinkIdsEntry);
    nextCache.trakt.image = normalizeEntryMap(traktCache.image, normalizeImageEntry);

    const googleCache = commonUtils.ensureObject(cache.google);
    nextCache.google.comments = normalizeEntryMap(googleCache.comments, (entry) => {
        const normalized = {};
        Object.entries(commonUtils.ensureObject(entry)).forEach(([field, value]) => {
            const normalizedField = normalizeHashedTranslationEntry(value);
            if (normalizedField) {
                normalized[field] = normalizedField;
            }
        });
        return Object.keys(normalized).length > 0 ? normalized : null;
    });
    nextCache.google.sentiments = normalizeEntryMap(googleCache.sentiments, normalizeSentimentTranslationEntry);
    nextCache.google.people = normalizeEntryMap(googleCache.people, normalizePersonTranslationEntry);
    nextCache.google.list = normalizeEntryMap(googleCache.list, (entry) => {
        const normalized = {};
        Object.entries(commonUtils.ensureObject(entry)).forEach(([field, value]) => {
            const normalizedField = normalizeHashedTranslationEntry(value);
            if (normalizedField) {
                normalized[field] = normalizedField;
            }
        });
        return Object.keys(normalized).length > 0 ? normalized : null;
    });

    nextCache.douban = normalizeDoubanCache(cache.douban);

    const persistentCache = commonUtils.ensureObject(cache.persistent);
    nextCache.persistent.currentSeason = commonUtils.isPlainObject(persistentCache.currentSeason) ? persistentCache.currentSeason : null;
    nextCache.persistent.historyShows = normalizeEntryMap(persistentCache.historyShows, normalizeHistoryShowsEntry);
    nextCache.persistent.translationOverrides = normalizeTranslationOverrides(persistentCache.translationOverrides);

    return nextCache;
}

function estimateCacheBytes(env, value) {
    const serialized = env.toStr(value, "");
    return serialized ? serialized.length : 0;
}

function estimateEntryMapBytes(env, entries) {
    return Object.entries(commonUtils.ensureObject(entries)).reduce((total, [key, entry]) => total + estimatePrunableEntryBytes(env, key, entry), 0);
}

function readUnifiedCacheRev(env, unifiedCacheRevKey = UNIFIED_CACHE_REV_KEY) {
    const rev = Number(env.getjson(unifiedCacheRevKey, 0));
    return Number.isFinite(rev) && rev > 0 ? rev : 0;
}

function readBodyRev(cache) {
    const rev = Number(cache?.rev);
    return Number.isFinite(rev) && rev > 0 ? rev : 0;
}

function buildNextUnifiedCacheRev(currentRev) {
    const rev = Number(currentRev);
    const now = Date.now();
    return Number.isFinite(rev) && rev >= now ? rev + 1 : now;
}

function getUnifiedCacheMemo(env) {
    const memo = env?.__traktUnifiedCacheMemo;
    return commonUtils.isPlainObject(memo) ? memo : null;
}

function setUnifiedCacheMemo(env, cache, loadedRev, snapshotConsistent = true) {
    env.__traktUnifiedCacheMemo = {
        cache,
        loadedRev,
        snapshotConsistent,
    };
}

function loadUnifiedCacheSnapshot(
    env,
    unifiedCacheKey = UNIFIED_CACHE_KEY,
    unifiedCacheSchemaVersion = UNIFIED_CACHE_SCHEMA_VERSION,
    unifiedCacheMaxBytes = UNIFIED_CACHE_MAX_BYTES,
    unifiedCacheRevKey = UNIFIED_CACHE_REV_KEY,
    retryCount = 0,
) {
    const rawCache = env.getjson(unifiedCacheKey, null);
    const sidecarRev = readUnifiedCacheRev(env, unifiedCacheRevKey);
    if (!commonUtils.isPlainObject(rawCache)) {
        return {
            rawCache,
            normalizedCache: null,
            bodyRev: 0,
            sidecarRev,
            loadedRev: 0,
            isValid: false,
            needsRepair: false,
            snapshotConsistent: false,
        };
    }

    if (Number(rawCache.version) !== unifiedCacheSchemaVersion) {
        const resetCache = createEmptyUnifiedCache(unifiedCacheSchemaVersion, unifiedCacheMaxBytes);
        return {
            rawCache,
            normalizedCache: resetCache,
            bodyRev: readBodyRev(resetCache),
            sidecarRev,
            loadedRev: sidecarRev,
            isValid: true,
            needsRepair: true,
            snapshotConsistent: true,
        };
    }

    const normalizedCache = normalizeUnifiedCache(rawCache, unifiedCacheSchemaVersion, unifiedCacheMaxBytes);
    const bodyRev = readBodyRev(normalizedCache);
    if (bodyRev < sidecarRev && retryCount + 1 < UNIFIED_CACHE_SNAPSHOT_RETRY_LIMIT) {
        return loadUnifiedCacheSnapshot(env, unifiedCacheKey, unifiedCacheSchemaVersion, unifiedCacheMaxBytes, unifiedCacheRevKey, retryCount + 1);
    }

    if (bodyRev > sidecarRev) {
        env.setjson(bodyRev, unifiedCacheRevKey);
        return {
            rawCache,
            normalizedCache,
            bodyRev,
            sidecarRev: bodyRev,
            loadedRev: bodyRev,
            isValid: true,
            needsRepair: env.toStr(rawCache, "") !== env.toStr(normalizedCache, ""),
            snapshotConsistent: true,
        };
    }

    return {
        rawCache,
        normalizedCache,
        bodyRev,
        sidecarRev,
        loadedRev: bodyRev,
        isValid: true,
        needsRepair: env.toStr(rawCache, "") !== env.toStr(normalizedCache, ""),
        snapshotConsistent: bodyRev === sidecarRev,
    };
}

function persistUnifiedCache(
    env,
    cache,
    unifiedCacheKey = UNIFIED_CACHE_KEY,
    unifiedCacheSchemaVersion = UNIFIED_CACHE_SCHEMA_VERSION,
    unifiedCacheMaxBytes = UNIFIED_CACHE_MAX_BYTES,
    unifiedCacheRevKey = UNIFIED_CACHE_REV_KEY,
    baseRev = 0,
) {
    const nextCache = pruneUnifiedCacheToLimit(env, cache, unifiedCacheSchemaVersion, unifiedCacheMaxBytes);
    const nextRev = buildNextUnifiedCacheRev(baseRev);
    nextCache.rev = nextRev;
    env.setjson(nextCache, unifiedCacheKey);
    env.setjson(nextRev, unifiedCacheRevKey);
    setUnifiedCacheMemo(env, nextCache, nextRev, true);
    return nextCache;
}

function applyOwnedBucket(unifiedCache, owner) {
    if (!owner || !Array.isArray(owner.path) || owner.path.length === 0) {
        return;
    }

    let target = unifiedCache;
    for (let index = 0; index < owner.path.length - 1; index += 1) {
        const key = owner.path[index];
        target[key] = commonUtils.ensureObject(target[key]);
        target = target[key];
    }
    target[owner.path[owner.path.length - 1]] = owner.value;
}

function deletePrunableEntry(cache, target) {
    if (!target) {
        return;
    }

    delete cache[target.scope][target.bucket][target.key];
}

function sortPrunableEntries(entries) {
    return entries.sort((a, b) => {
        if (a.priority !== b.priority) {
            return a.priority - b.priority;
        }
        return b.estimatedBytes - a.estimatedBytes;
    });
}

function buildPrunableEntries(env, cache) {
    const prunableEntries = [];

    Object.entries(commonUtils.ensureObject(cache.google.comments)).forEach(([key, entry]) => {
        prunableEntries.push({
            scope: "google",
            bucket: "comments",
            key,
            priority: PRUNE_PRIORITY["google.comments"],
            estimatedBytes: estimatePrunableEntryBytes(env, key, entry),
        });
    });
    Object.entries(commonUtils.ensureObject(cache.google.sentiments)).forEach(([key, entry]) => {
        prunableEntries.push({
            scope: "google",
            bucket: "sentiments",
            key,
            priority: PRUNE_PRIORITY["google.sentiments"],
            estimatedBytes: estimatePrunableEntryBytes(env, key, entry),
        });
    });
    Object.entries(commonUtils.ensureObject(cache.google.list)).forEach(([key, entry]) => {
        prunableEntries.push({
            scope: "google",
            bucket: "list",
            key,
            priority: PRUNE_PRIORITY["google.list"],
            estimatedBytes: estimatePrunableEntryBytes(env, key, entry),
        });
    });
    Object.entries(commonUtils.ensureObject(cache.google.people)).forEach(([key, entry]) => {
        prunableEntries.push({
            scope: "google",
            bucket: "people",
            key,
            priority: PRUNE_PRIORITY["google.people"],
            estimatedBytes: estimatePrunableEntryBytes(env, key, entry),
        });
    });
    Object.entries(commonUtils.ensureObject(cache.douban.search)).forEach(([key, entry]) => {
        prunableEntries.push({
            scope: "douban",
            bucket: "search",
            key,
            priority: PRUNE_PRIORITY["douban.search"],
            estimatedBytes: estimatePrunableEntryBytes(env, key, entry),
        });
    });
    Object.entries(commonUtils.ensureObject(cache.douban.seasons)).forEach(([key, entry]) => {
        prunableEntries.push({
            scope: "douban",
            bucket: "seasons",
            key,
            priority: PRUNE_PRIORITY["douban.seasons"],
            estimatedBytes: estimatePrunableEntryBytes(env, key, entry),
        });
    });
    Object.entries(commonUtils.ensureObject(cache.douban.credits)).forEach(([key, entry]) => {
        prunableEntries.push({
            scope: "douban",
            bucket: "credits",
            key,
            priority: PRUNE_PRIORITY["douban.credits"],
            estimatedBytes: estimatePrunableEntryBytes(env, key, entry),
        });
    });
    Object.entries(commonUtils.ensureObject(cache.trakt.linkIds)).forEach(([key, entry]) => {
        prunableEntries.push({
            scope: "trakt",
            bucket: "linkIds",
            key,
            priority: PRUNE_PRIORITY["trakt.linkIds"],
            estimatedBytes: estimatePrunableEntryBytes(env, key, entry),
        });
    });
    Object.entries(commonUtils.ensureObject(cache.trakt.image)).forEach(([key, entry]) => {
        const fields = Object.values(commonUtils.ensureObject(entry));
        const hasNotFound = fields.some((field) => field?.status === translationCache.CACHE_STATUS.NOT_FOUND);
        const hasPartialFound = fields.some((field) => field?.status === translationCache.CACHE_STATUS.PARTIAL_FOUND);
        const status = hasNotFound ? "not_found" : hasPartialFound ? "partial_found" : "found";
        prunableEntries.push({
            scope: "trakt",
            bucket: "image",
            key,
            priority: PRUNE_PRIORITY[`trakt.image.${status}`],
            estimatedBytes: estimatePrunableEntryBytes(env, key, entry),
        });
    });
    Object.entries(commonUtils.ensureObject(cache.trakt.translation)).forEach(([key, entry]) => {
        const status =
            entry?.status === translationCache.CACHE_STATUS.FOUND ? "found" : entry?.status === translationCache.CACHE_STATUS.PARTIAL_FOUND ? "partial_found" : "not_found";
        prunableEntries.push({
            scope: "trakt",
            bucket: "translation",
            key,
            priority: PRUNE_PRIORITY[`trakt.translation.${status}`],
            estimatedBytes: estimatePrunableEntryBytes(env, key, entry),
        });
    });

    return sortPrunableEntries(prunableEntries);
}

function prunePeopleCacheToQuota(env, cache, maxBytes = GOOGLE_PEOPLE_CACHE_MAX_BYTES) {
    const limit = Number(maxBytes);
    if (!Number.isFinite(limit) || limit <= 0) {
        cache.google.people = {};
        return;
    }

    const peopleEntries = sortPrunableEntries(
        Object.entries(commonUtils.ensureObject(cache.google.people)).map(([key, entry]) => ({
            scope: "google",
            bucket: "people",
            key,
            priority: PRUNE_PRIORITY["google.people"],
            estimatedBytes: estimatePrunableEntryBytes(env, key, entry),
        })),
    );

    let estimatedBytes = estimateEntryMapBytes(env, cache.google.people);
    while (estimatedBytes > limit && peopleEntries.length > 0) {
        const target = peopleEntries.shift();
        deletePrunableEntry(cache, target);
        estimatedBytes = Math.max(estimatedBytes - target.estimatedBytes, 0);
    }

    while (estimateEntryMapBytes(env, cache.google.people) > limit && peopleEntries.length > 0) {
        deletePrunableEntry(cache, peopleEntries.shift());
    }
}

function pruneUnifiedCacheToLimit(env, cache, schemaVersion = UNIFIED_CACHE_SCHEMA_VERSION, maxBytes = UNIFIED_CACHE_MAX_BYTES) {
    const nextCache = normalizeUnifiedCache(cache, schemaVersion, maxBytes);
    const limit = Number.isFinite(Number(nextCache.maxBytes)) ? Number(nextCache.maxBytes) : maxBytes;

    prunePeopleCacheToQuota(env, nextCache);

    const prunableEntries = buildPrunableEntries(env, nextCache);

    let estimatedBytes = estimateCacheBytes(env, nextCache);
    while (estimatedBytes > limit && prunableEntries.length > 0) {
        const target = prunableEntries.shift();
        deletePrunableEntry(nextCache, target);
        estimatedBytes = Math.max(estimatedBytes - target.estimatedBytes, 0);
    }

    while (estimateCacheBytes(env, nextCache) > limit && prunableEntries.length > 0) {
        deletePrunableEntry(nextCache, prunableEntries.shift());
    }

    return nextCache;
}

function loadUnifiedCache(
    env,
    unifiedCacheKey = UNIFIED_CACHE_KEY,
    unifiedCacheSchemaVersion = UNIFIED_CACHE_SCHEMA_VERSION,
    unifiedCacheMaxBytes = UNIFIED_CACHE_MAX_BYTES,
    unifiedCacheRevKey = UNIFIED_CACHE_REV_KEY,
) {
    const memo = getUnifiedCacheMemo(env);
    if (memo?.cache) {
        return memo.cache;
    }

    try {
        const snapshot = loadUnifiedCacheSnapshot(env, unifiedCacheKey, unifiedCacheSchemaVersion, unifiedCacheMaxBytes, unifiedCacheRevKey);
        if (!snapshot.isValid) {
            const nextCache = createEmptyUnifiedCache(unifiedCacheSchemaVersion, unifiedCacheMaxBytes);
            persistUnifiedCache(env, nextCache, unifiedCacheKey, unifiedCacheSchemaVersion, unifiedCacheMaxBytes, unifiedCacheRevKey, snapshot.sidecarRev);
            return nextCache;
        }

        if (snapshot.needsRepair) {
            const latestRev = readUnifiedCacheRev(env, unifiedCacheRevKey);
            if (snapshot.snapshotConsistent && latestRev === snapshot.loadedRev) {
                persistUnifiedCache(env, snapshot.normalizedCache, unifiedCacheKey, unifiedCacheSchemaVersion, unifiedCacheMaxBytes, unifiedCacheRevKey, latestRev);
                return snapshot.normalizedCache;
            }
        }

        setUnifiedCacheMemo(env, snapshot.normalizedCache, snapshot.loadedRev, snapshot.snapshotConsistent);
        return snapshot.normalizedCache;
    } catch (error) {
        env.log(`Trakt unified cache load failed: ${error}`);
        const nextCache = createEmptyUnifiedCache(unifiedCacheSchemaVersion, unifiedCacheMaxBytes);
        persistUnifiedCache(env, nextCache, unifiedCacheKey, unifiedCacheSchemaVersion, unifiedCacheMaxBytes, unifiedCacheRevKey, readUnifiedCacheRev(env, unifiedCacheRevKey));
        return nextCache;
    }
}

function saveUnifiedCache(
    env,
    cache,
    unifiedCacheKey = UNIFIED_CACHE_KEY,
    unifiedCacheSchemaVersion = UNIFIED_CACHE_SCHEMA_VERSION,
    unifiedCacheMaxBytes = UNIFIED_CACHE_MAX_BYTES,
    options = {},
) {
    try {
        const unifiedCacheRevKey = options.unifiedCacheRevKey ?? UNIFIED_CACHE_REV_KEY;
        const latestRev = readUnifiedCacheRev(env, unifiedCacheRevKey);
        const memo = getUnifiedCacheMemo(env);
        const loadedRev = Number(memo?.loadedRev ?? 0);
        const canPersistDirectly = memo?.snapshotConsistent === true && latestRev === loadedRev;
        if (!canPersistDirectly && options.owner) {
            const latestSnapshot = loadUnifiedCacheSnapshot(env, unifiedCacheKey, unifiedCacheSchemaVersion, unifiedCacheMaxBytes, unifiedCacheRevKey);
            const latestCache = latestSnapshot.isValid ? latestSnapshot.normalizedCache : createEmptyUnifiedCache(unifiedCacheSchemaVersion, unifiedCacheMaxBytes);
            applyOwnedBucket(latestCache, options.owner);
            persistUnifiedCache(
                env,
                latestCache,
                unifiedCacheKey,
                unifiedCacheSchemaVersion,
                unifiedCacheMaxBytes,
                unifiedCacheRevKey,
                Math.max(latestRev, latestSnapshot.loadedRev),
            );
            return;
        }

        persistUnifiedCache(env, cache, unifiedCacheKey, unifiedCacheSchemaVersion, unifiedCacheMaxBytes, unifiedCacheRevKey, latestRev);
    } catch (error) {
        env.log(`Trakt unified cache save failed: ${error}`);
    }
}

function loadCache(env) {
    return commonUtils.ensureObject(loadUnifiedCache(env).trakt.translation);
}

function saveCache(env, cache) {
    const normalizedCache = commonUtils.ensureObject(cache);
    const unifiedCache = loadUnifiedCache(env);
    unifiedCache.trakt.translation = normalizedCache;
    saveUnifiedCache(env, unifiedCache, UNIFIED_CACHE_KEY, UNIFIED_CACHE_SCHEMA_VERSION, UNIFIED_CACHE_MAX_BYTES, {
        owner: {
            path: ["trakt", "translation"],
            value: normalizedCache,
        },
    });
}

function loadHistoryShowsCache(env) {
    return commonUtils.ensureObject(loadUnifiedCache(env).persistent.historyShows);
}

function saveHistoryShowsCache(env, cache) {
    const normalizedCache = normalizeEntryMap(cache, normalizeHistoryShowsEntry);
    const unifiedCache = loadUnifiedCache(env);
    unifiedCache.persistent.historyShows = normalizedCache;
    saveUnifiedCache(env, unifiedCache, UNIFIED_CACHE_KEY, UNIFIED_CACHE_SCHEMA_VERSION, UNIFIED_CACHE_MAX_BYTES, {
        owner: {
            path: ["persistent", "historyShows"],
            value: normalizedCache,
        },
    });
}

function loadLinkIdsCache(env) {
    return commonUtils.ensureObject(loadUnifiedCache(env).trakt.linkIds);
}

function saveLinkIdsCache(env, cache) {
    const normalizedCache = normalizeEntryMap(cache, normalizeLinkIdsEntry);
    const unifiedCache = loadUnifiedCache(env);
    unifiedCache.trakt.linkIds = normalizedCache;
    saveUnifiedCache(env, unifiedCache, UNIFIED_CACHE_KEY, UNIFIED_CACHE_SCHEMA_VERSION, UNIFIED_CACHE_MAX_BYTES, {
        owner: {
            path: ["trakt", "linkIds"],
            value: normalizedCache,
        },
    });
}

function loadImageCache(env) {
    return commonUtils.ensureObject(loadUnifiedCache(env).trakt.image);
}

function saveImageCache(env, cache) {
    const normalizedCache = normalizeEntryMap(cache, normalizeImageEntry);
    const unifiedCache = loadUnifiedCache(env);
    unifiedCache.trakt.image = normalizedCache;
    saveUnifiedCache(env, unifiedCache, UNIFIED_CACHE_KEY, UNIFIED_CACHE_SCHEMA_VERSION, UNIFIED_CACHE_MAX_BYTES, {
        owner: {
            path: ["trakt", "image"],
            value: normalizedCache,
        },
    });
}

function loadPosterCache(env) {
    return commonUtils.ensureObject(loadImageCache(env));
}

function savePosterCache(env, cache) {
    saveImageCache(env, Object.fromEntries(Object.entries(commonUtils.ensureObject(cache)).map(([key, entry]) => [key, { poster: entry?.poster ?? entry }])));
}

function loadTranslationOverridesCache(env) {
    return normalizeTranslationOverrides(loadUnifiedCache(env).persistent.translationOverrides);
}

function saveTranslationOverridesCache(env, cache) {
    const normalizedCache = normalizeTranslationOverrides(cache);
    const unifiedCache = loadUnifiedCache(env);
    unifiedCache.persistent.translationOverrides = normalizedCache;
    saveUnifiedCache(env, unifiedCache, UNIFIED_CACHE_KEY, UNIFIED_CACHE_SCHEMA_VERSION, UNIFIED_CACHE_MAX_BYTES, {
        owner: {
            path: ["persistent", "translationOverrides"],
            value: normalizedCache,
        },
    });
}

function loadCommentTranslationCache(env) {
    return commonUtils.ensureObject(loadUnifiedCache(env).google.comments);
}

function saveCommentTranslationCache(env, cache) {
    const unifiedCache = loadUnifiedCache(env);
    const normalizedCache = normalizeUnifiedCache({ google: { comments: cache } }, unifiedCache.version, unifiedCache.maxBytes).google.comments;
    unifiedCache.google.comments = normalizedCache;
    saveUnifiedCache(env, unifiedCache, UNIFIED_CACHE_KEY, UNIFIED_CACHE_SCHEMA_VERSION, UNIFIED_CACHE_MAX_BYTES, {
        owner: {
            path: ["google", "comments"],
            value: normalizedCache,
        },
    });
}

function loadSentimentTranslationCache(env) {
    return commonUtils.ensureObject(loadUnifiedCache(env).google.sentiments);
}

function saveSentimentTranslationCache(env, cache) {
    const normalizedCache = normalizeEntryMap(cache, normalizeSentimentTranslationEntry);
    const unifiedCache = loadUnifiedCache(env);
    unifiedCache.google.sentiments = normalizedCache;
    saveUnifiedCache(env, unifiedCache, UNIFIED_CACHE_KEY, UNIFIED_CACHE_SCHEMA_VERSION, UNIFIED_CACHE_MAX_BYTES, {
        owner: {
            path: ["google", "sentiments"],
            value: normalizedCache,
        },
    });
}

function loadPeopleTranslationCache(env) {
    return commonUtils.ensureObject(loadUnifiedCache(env).google.people);
}

function savePeopleTranslationCache(env, cache) {
    const normalizedCache = normalizeEntryMap(cache, normalizePersonTranslationEntry);
    const unifiedCache = loadUnifiedCache(env);
    unifiedCache.google.people = normalizedCache;
    saveUnifiedCache(env, unifiedCache, UNIFIED_CACHE_KEY, UNIFIED_CACHE_SCHEMA_VERSION, UNIFIED_CACHE_MAX_BYTES, {
        owner: {
            path: ["google", "people"],
            value: normalizedCache,
        },
    });
}

function loadDoubanCache(env) {
    return normalizeDoubanCache(loadUnifiedCache(env).douban);
}

function saveDoubanCache(env, cache) {
    const normalizedCache = normalizeDoubanCache(cache);
    const unifiedCache = loadUnifiedCache(env);
    unifiedCache.douban = normalizedCache;
    saveUnifiedCache(env, unifiedCache, UNIFIED_CACHE_KEY, UNIFIED_CACHE_SCHEMA_VERSION, UNIFIED_CACHE_MAX_BYTES, {
        owner: {
            path: ["douban"],
            value: normalizedCache,
        },
    });
}

function loadListTranslationCache(env) {
    return commonUtils.ensureObject(loadUnifiedCache(env).google.list);
}

function saveListTranslationCache(env, cache) {
    const unifiedCache = loadUnifiedCache(env);
    const normalizedCache = normalizeUnifiedCache({ google: { list: cache } }, unifiedCache.version, unifiedCache.maxBytes).google.list;
    unifiedCache.google.list = normalizedCache;
    saveUnifiedCache(env, unifiedCache, UNIFIED_CACHE_KEY, UNIFIED_CACHE_SCHEMA_VERSION, UNIFIED_CACHE_MAX_BYTES, {
        owner: {
            path: ["google", "list"],
            value: normalizedCache,
        },
    });
}

function setCurrentSeason(env, showId, seasonNumber) {
    if (commonUtils.isNullish(showId) || commonUtils.isNullish(seasonNumber)) {
        return;
    }

    const unifiedCache = loadUnifiedCache(env);
    const nextCurrentSeason = {
        showId: String(showId),
        seasonNumber: Number(seasonNumber),
    };
    unifiedCache.persistent.currentSeason = {
        ...nextCurrentSeason,
    };
    saveUnifiedCache(env, unifiedCache, UNIFIED_CACHE_KEY, UNIFIED_CACHE_SCHEMA_VERSION, UNIFIED_CACHE_MAX_BYTES, {
        owner: {
            path: ["persistent", "currentSeason"],
            value: nextCurrentSeason,
        },
    });
}

function clearCurrentSeason(env) {
    const unifiedCache = loadUnifiedCache(env);
    unifiedCache.persistent.currentSeason = null;
    saveUnifiedCache(env, unifiedCache, UNIFIED_CACHE_KEY, UNIFIED_CACHE_SCHEMA_VERSION, UNIFIED_CACHE_MAX_BYTES, {
        owner: {
            path: ["persistent", "currentSeason"],
            value: null,
        },
    });
}

function getCurrentSeason(env, showId) {
    if (commonUtils.isNullish(showId)) {
        return 1;
    }

    try {
        const cache = loadUnifiedCache(env).persistent.currentSeason;
        return commonUtils.isPlainObject(cache) &&
            commonUtils.isNonNullish(cache.showId) &&
            commonUtils.isNonNullish(cache.seasonNumber) &&
            String(cache.showId) === String(showId) &&
            Number.isFinite(Number(cache.seasonNumber))
            ? Number(cache.seasonNumber)
            : 1;
    } catch (error) {
        env.log(`Trakt current season cache load failed: ${error}`);
        return 1;
    }
}

export {
    buildFieldTranslationCacheKey,
    clearCurrentSeason,
    createEmptyUnifiedCache,
    GOOGLE_PEOPLE_CACHE_MAX_BYTES,
    getCurrentSeason,
    getHashedFieldTranslation,
    loadCache,
    loadCommentTranslationCache,
    loadDoubanCache,
    loadHistoryShowsCache,
    loadImageCache,
    loadLinkIdsCache,
    loadListTranslationCache,
    loadPeopleTranslationCache,
    loadPosterCache,
    loadSentimentTranslationCache,
    loadTranslationOverridesCache,
    loadUnifiedCache,
    normalizeRevlessEntryMap,
    normalizeTranslationOverrides,
    normalizeUnifiedCache,
    pruneUnifiedCacheToLimit,
    saveCache,
    saveCommentTranslationCache,
    saveDoubanCache,
    saveHistoryShowsCache,
    saveImageCache,
    saveLinkIdsCache,
    saveListTranslationCache,
    savePeopleTranslationCache,
    savePosterCache,
    saveSentimentTranslationCache,
    saveTranslationOverridesCache,
    saveUnifiedCache,
    setCurrentSeason,
    setHashedFieldTranslation,
    UNIFIED_CACHE_KEY,
    UNIFIED_CACHE_MAX_BYTES,
    UNIFIED_CACHE_REV_KEY,
    UNIFIED_CACHE_SCHEMA_VERSION,
};
