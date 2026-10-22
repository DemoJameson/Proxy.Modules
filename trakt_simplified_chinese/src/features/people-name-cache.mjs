import * as vercelBackendClientModule from "../outbound/vercel-backend-client.mjs";
import * as cacheUtils from "../utils/cache.mjs";
import * as commonUtils from "../utils/common.mjs";

const PEOPLE_NAME_SOURCE = {
    TMDB: "tmdb",
    GOOGLE: "google",
};
const TMDB_PERSON_NAME_TTL_MS = cacheUtils.PERSON_NAME_TMDB_TTL_MS;
const GOOGLE_PERSON_NAME_TTL_MS = cacheUtils.PERSON_NAME_GOOGLE_TTL_MS;
const TMDB_PERSON_NAME_NOT_FOUND_TTL_MS = cacheUtils.PERSON_NAME_TMDB_MISSING_TTL_MS;
const PEOPLE_LIST_ORIGINAL_NAME_KEY = "__traktOriginalName";

const peopleNameBackendWriteQueue = {};
// 后端读取时回带的 cn 数据：写回时一并合并到当前 locale 条目
const peopleNameCnHints = {};

function isSupportedPersonNameSource(source) {
    return source === PEOPLE_NAME_SOURCE.TMDB || source === PEOPLE_NAME_SOURCE.GOOGLE;
}

function buildPersonNameCacheEntry(payload) {
    const name = String(payload?.name ?? "").trim();
    const sourceTextHash = String(payload?.sourceTextHash ?? "").trim();
    const source = String(payload?.source ?? "").trim();
    if (!name || !sourceTextHash || !isSupportedPersonNameSource(source)) {
        return null;
    }
    return {
        name,
        sourceTextHash,
        source,
        ...(payload?.tmdbMissing === true ? { tmdbMissing: true } : {}),
    };
}

function getDefaultExpiresAt(source, tmdbMissing, now = Date.now()) {
    if (tmdbMissing) {
        return now + TMDB_PERSON_NAME_NOT_FOUND_TTL_MS;
    }
    return now + (source === PEOPLE_NAME_SOURCE.GOOGLE ? GOOGLE_PERSON_NAME_TTL_MS : TMDB_PERSON_NAME_TTL_MS);
}

function isEntryFresh(entry, now = Date.now()) {
    const expiresAt = Number(entry?.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt > now;
}

function queuePeopleNameBackendWrite(personId, nameEntry) {
    const normalizedPersonId = String(personId ?? "").trim();
    const entry = buildPersonNameCacheEntry(nameEntry);
    if (!normalizedPersonId || !entry) {
        return;
    }
    const current = peopleNameBackendWriteQueue[normalizedPersonId];
    // tmdb 优先：已排队的 tmdb 条目不被 google 覆盖；tmdb 缺失标记继续保留
    if (entry.source === PEOPLE_NAME_SOURCE.GOOGLE && current?.source === PEOPLE_NAME_SOURCE.TMDB) {
        return;
    }
    const tmdbMissing = entry.source !== PEOPLE_NAME_SOURCE.TMDB && (entry.tmdbMissing === true || current?.tmdbMissing === true);
    peopleNameBackendWriteQueue[normalizedPersonId] = {
        status: cacheUtils.PERSON_NAME_STATUS.FOUND,
        name: entry.name,
        sourceTextHash: entry.sourceTextHash,
        source: entry.source,
        expiresAt: getDefaultExpiresAt(entry.source, tmdbMissing),
        ...(tmdbMissing ? { tmdbMissing: true } : {}),
    };
}

function queuePeopleNameNotFoundBackendWrite(personId) {
    const normalizedPersonId = String(personId ?? "").trim();
    if (!normalizedPersonId) {
        return;
    }
    const current = peopleNameBackendWriteQueue[normalizedPersonId];
    if (current?.source === PEOPLE_NAME_SOURCE.TMDB) {
        return;
    }
    const hasName = current?.status === cacheUtils.PERSON_NAME_STATUS.FOUND && !!current?.name;
    const currentExpiresAt = Number(current?.expiresAt);
    const missingExpiresAt = Date.now() + TMDB_PERSON_NAME_NOT_FOUND_TTL_MS;
    peopleNameBackendWriteQueue[normalizedPersonId] = {
        status: hasName ? cacheUtils.PERSON_NAME_STATUS.FOUND : cacheUtils.PERSON_NAME_STATUS.NOT_FOUND,
        ...(hasName
            ? {
                  name: current.name,
                  sourceTextHash: current.sourceTextHash,
                  source: current.source,
              }
            : {}),
        expiresAt: Number.isFinite(currentExpiresAt) && currentExpiresAt > Date.now() ? Math.min(currentExpiresAt, missingExpiresAt) : missingExpiresAt,
        tmdbMissing: true,
    };
}

function flushPeopleNameBackendWrites() {
    const keys = Object.keys(peopleNameBackendWriteQueue);
    if (keys.length === 0) {
        return;
    }
    const payload = { people: {} };
    const cnPayload = { people: {} };
    keys.forEach((key) => {
        payload.people[key] = peopleNameBackendWriteQueue[key];
        delete peopleNameBackendWriteQueue[key];
        if (commonUtils.isPlainObject(peopleNameCnHints[key])) {
            cnPayload.people[key] = peopleNameCnHints[key];
            delete peopleNameCnHints[key];
        }
    });
    if (Object.keys(cnPayload.people).length > 0) {
        payload.cn = cnPayload;
    }
    if (vercelBackendClientModule.resolveBackendBaseUrl()) {
        vercelBackendClientModule.postPeopleNames(payload).catch(() => {});
    }
}

function normalizeBackendPeopleIds(personIds) {
    return commonUtils
        .ensureArray(personIds)
        .map((id) => String(id ?? "").trim())
        .filter(Boolean)
        .filter((id, index, array) => array.indexOf(id) === index)
        .sort((left, right) => Number(left) - Number(right));
}

async function hydratePeopleNamesFromBackend(cache, personIds) {
    if (!vercelBackendClientModule.resolveBackendBaseUrl()) {
        return false;
    }

    const ids = normalizeBackendPeopleIds(personIds);
    if (ids.length === 0) {
        return false;
    }

    try {
        const payload = await vercelBackendClientModule.fetchPeopleNames(`people=${ids.join(",")}`);
        const cnEntries = commonUtils.ensureObject(payload?.cn?.people);
        Object.entries(cnEntries).forEach(([personId, entry]) => {
            if (commonUtils.isPlainObject(entry)) {
                peopleNameCnHints[personId] = entry;
            }
        });
        const entries = commonUtils.ensureObject(payload?.people);
        let changed = false;
        Object.entries(entries).forEach(([personId, entry]) => {
            changed = setPeopleTranslationCacheEntry(cache, personId, entry) || changed;
        });
        return changed;
    } catch (error) {
        globalThis.$ctx?.env?.log?.(`Trakt people name backend cache read failed: ${error}`);
        return false;
    }
}

// 本地人物名缓存与 Redis V2 对齐：person:name:<personId>:<locale>
function buildPeopleTranslationCacheKey(personId) {
    return commonUtils.isNullish(personId) ? "" : cacheUtils.buildLocaleCacheKey(`person:name:${String(personId)}`);
}

function getPeopleTranslationCacheEntryByKey(cache, cacheKey) {
    const entry = cacheKey ? cache?.[cacheKey] : null;
    return commonUtils.isPlainObject(entry) ? entry : null;
}

function getPeopleTranslationCacheEntry(cache, personId) {
    if (!cache || commonUtils.isNullish(personId)) {
        return null;
    }
    return getPeopleTranslationCacheEntryByKey(cache, buildPeopleTranslationCacheKey(personId));
}

function getValidPersonNameCacheEntry(entry) {
    if (entry?.status !== cacheUtils.PERSON_NAME_STATUS.FOUND || !isEntryFresh(entry)) {
        return null;
    }
    return buildPersonNameCacheEntry(entry);
}

function getValidPersonNameNotFoundEntry(entry) {
    const hasTmdbMissingStatus =
        entry?.status === cacheUtils.PERSON_NAME_STATUS.NOT_FOUND ||
        (entry?.status === cacheUtils.PERSON_NAME_STATUS.FOUND && entry?.source !== PEOPLE_NAME_SOURCE.TMDB && entry?.tmdbMissing === true);
    return hasTmdbMissingStatus && entry?.tmdbMissing === true && isEntryFresh(entry) ? entry : null;
}

function shouldUpdatePersonNameCache(currentNameEntry, nextNameEntry) {
    if (!nextNameEntry) {
        return false;
    }
    if (!currentNameEntry) {
        return true;
    }
    if (currentNameEntry.source === PEOPLE_NAME_SOURCE.GOOGLE && nextNameEntry.source === PEOPLE_NAME_SOURCE.TMDB) {
        return true;
    }
    if (currentNameEntry.source === PEOPLE_NAME_SOURCE.TMDB && nextNameEntry.source === PEOPLE_NAME_SOURCE.GOOGLE) {
        return false;
    }
    return currentNameEntry.sourceTextHash !== nextNameEntry.sourceTextHash || currentNameEntry.name !== nextNameEntry.name || currentNameEntry.source !== nextNameEntry.source;
}

function applyPersonNameNotFoundCache(cache, personId) {
    const currentEntry = getPeopleTranslationCacheEntry(cache, personId);
    if (getValidPersonNameCacheEntry(currentEntry)?.source === PEOPLE_NAME_SOURCE.TMDB) {
        return false;
    }

    const changed = setPeopleTranslationCacheEntry(cache, personId, {
        status: cacheUtils.PERSON_NAME_STATUS.NOT_FOUND,
        expiresAt: Date.now() + TMDB_PERSON_NAME_NOT_FOUND_TTL_MS,
        tmdbMissing: true,
    });
    const currentNameEntry = getValidPersonNameCacheEntry(getPeopleTranslationCacheEntry(cache, personId));
    if (currentNameEntry) {
        queuePeopleNameBackendWrite(personId, currentNameEntry);
    }
    queuePeopleNameNotFoundBackendWrite(personId);
    return changed;
}

function setPeopleTranslationCacheEntry(cache, personId, payload, queueBackendName = false) {
    if (!cache || commonUtils.isNullish(personId) || !commonUtils.isPlainObject(payload)) {
        return false;
    }

    const key = buildPeopleTranslationCacheKey(personId);
    if (!key) {
        return false;
    }
    const currentEntry = getPeopleTranslationCacheEntryByKey(cache, key);
    const nextEntry = commonUtils.isPlainObject(currentEntry) ? { ...currentEntry } : {};
    const currentNameEntry = getValidPersonNameCacheEntry(currentEntry);
    const incomingStatus =
        payload.status === cacheUtils.PERSON_NAME_STATUS.FOUND
            ? cacheUtils.PERSON_NAME_STATUS.FOUND
            : payload.status === cacheUtils.PERSON_NAME_STATUS.NOT_FOUND
              ? cacheUtils.PERSON_NAME_STATUS.NOT_FOUND
              : null;
    const now = Date.now();

    if (incomingStatus === cacheUtils.PERSON_NAME_STATUS.FOUND) {
        const nextNameEntry = buildPersonNameCacheEntry(payload);
        const providedExpiresAt = Number(payload.expiresAt);
        if (nextNameEntry) {
            const tmdbMissing = nextNameEntry.source !== PEOPLE_NAME_SOURCE.TMDB && (payload.tmdbMissing === true || currentEntry?.tmdbMissing === true);
            const defaultExpiresAt = getDefaultExpiresAt(nextNameEntry.source, tmdbMissing, now);
            const nextExpiresAt = Number.isFinite(providedExpiresAt) && providedExpiresAt > now ? Math.min(providedExpiresAt, defaultExpiresAt) : defaultExpiresAt;
            const shouldUpdate =
                shouldUpdatePersonNameCache(currentNameEntry, nextNameEntry) || (Number.isFinite(providedExpiresAt) && providedExpiresAt !== Number(currentEntry?.expiresAt));
            if (shouldUpdate) {
                nextEntry.status = cacheUtils.PERSON_NAME_STATUS.FOUND;
                nextEntry.name = nextNameEntry.name;
                nextEntry.sourceTextHash = nextNameEntry.sourceTextHash;
                nextEntry.source = nextNameEntry.source;
                nextEntry.expiresAt = nextExpiresAt;
                if (tmdbMissing) {
                    nextEntry.tmdbMissing = true;
                } else {
                    delete nextEntry.tmdbMissing;
                }
                if (queueBackendName) {
                    queuePeopleNameBackendWrite(personId, { ...nextNameEntry, ...(tmdbMissing ? { tmdbMissing: true } : {}) });
                }
            }
        }
    } else if (incomingStatus === cacheUtils.PERSON_NAME_STATUS.NOT_FOUND) {
        const providedExpiresAt = Number(payload.expiresAt);
        const defaultExpiresAt = now + TMDB_PERSON_NAME_NOT_FOUND_TTL_MS;
        const nextExpiresAt = Number.isFinite(providedExpiresAt) && providedExpiresAt > now ? providedExpiresAt : defaultExpiresAt;
        if (currentNameEntry?.source === PEOPLE_NAME_SOURCE.TMDB) {
            // TMDB 已经命中中文名时，后到的 TMDB miss 不能覆盖它
        } else if (currentNameEntry) {
            nextEntry.status = cacheUtils.PERSON_NAME_STATUS.FOUND;
            nextEntry.name = currentNameEntry.name;
            nextEntry.sourceTextHash = currentNameEntry.sourceTextHash;
            nextEntry.source = currentNameEntry.source;
            nextEntry.expiresAt = Math.min(nextExpiresAt, Number(currentEntry.expiresAt) || nextExpiresAt);
            nextEntry.tmdbMissing = true;
        } else {
            nextEntry.status = cacheUtils.PERSON_NAME_STATUS.NOT_FOUND;
            delete nextEntry.name;
            delete nextEntry.sourceTextHash;
            delete nextEntry.source;
            nextEntry.expiresAt = nextExpiresAt;
            nextEntry.tmdbMissing = true;
        }
        if (queueBackendName) {
            queuePeopleNameNotFoundBackendWrite(personId);
        }
    }

    if (commonUtils.isPlainObject(payload.biography)) {
        const nextBiographyEntry = {
            sourceTextHash: String(payload.biography.sourceTextHash ?? ""),
            translatedText: String(payload.biography.translatedText ?? ""),
        };
        if (!nextEntry.status) {
            nextEntry.status = cacheUtils.PERSON_NAME_STATUS.NOT_FOUND;
            nextEntry.expiresAt = now + GOOGLE_PERSON_NAME_TTL_MS;
        }
        if (JSON.stringify(commonUtils.ensureObject(currentEntry?.biography)) !== JSON.stringify(nextBiographyEntry)) {
            nextEntry.biography = nextBiographyEntry;
        }
    }

    if (currentEntry && JSON.stringify(currentEntry) === JSON.stringify(nextEntry)) {
        return false;
    }
    cache[key] = nextEntry;
    return true;
}

function getPersonTranslationCacheKeys(person) {
    const ids = commonUtils.ensureObject(person?.ids);
    const keys = [];
    if (commonUtils.isNonNullish(ids.trakt)) {
        keys.push(String(ids.trakt));
    }
    return keys;
}

function getCachedPersonNameTranslation(entry, sourceText) {
    const cachedName = getValidPersonNameCacheEntry(entry);
    if (!cachedName) {
        return "";
    }
    return String(cachedName.sourceTextHash ?? "") === commonUtils.computeStringHash(sourceText) ? String(cachedName.name) : "";
}

function getCachedTmdbPersonNameTranslation(entry, sourceText) {
    const cachedName = getValidPersonNameCacheEntry(entry);
    if (cachedName?.source !== PEOPLE_NAME_SOURCE.TMDB) {
        return "";
    }
    return getCachedPersonNameTranslation(entry, sourceText);
}

function buildPersonNameDisplay(sourceText, translatedText) {
    const original = String(sourceText ?? "").trim();
    const translated = String(translatedText ?? "").trim();
    if (!original) {
        return translated;
    }
    if (!translated || translated === original) {
        return original;
    }
    return `${translated}\n${original}`;
}

function rememberPeopleListOriginalName(person, originalName) {
    if (!commonUtils.isPlainObject(person) || !originalName) {
        return;
    }
    Object.defineProperty(person, PEOPLE_LIST_ORIGINAL_NAME_KEY, {
        value: originalName,
        configurable: true,
        enumerable: false,
        writable: true,
    });
}

function getPeopleListOriginalName(person) {
    const originalName = String(person?.[PEOPLE_LIST_ORIGINAL_NAME_KEY] ?? "").trim();
    return originalName || String(person?.name ?? "").trim();
}

function getCachedPersonBiographyTranslation(entry, sourceText) {
    const cachedBiography = commonUtils.ensureObject(entry?.biography);
    if (!cachedBiography.translatedText) {
        return "";
    }
    return String(cachedBiography.sourceTextHash ?? "") === commonUtils.computeStringHash(sourceText) ? String(cachedBiography.translatedText) : "";
}

export {
    applyPersonNameNotFoundCache,
    buildPeopleTranslationCacheKey,
    buildPersonNameCacheEntry,
    buildPersonNameDisplay,
    flushPeopleNameBackendWrites,
    GOOGLE_PERSON_NAME_TTL_MS,
    getCachedPersonBiographyTranslation,
    getCachedPersonNameTranslation,
    getCachedTmdbPersonNameTranslation,
    getPeopleListOriginalName,
    getPeopleTranslationCacheEntry,
    getPersonTranslationCacheKeys,
    getValidPersonNameCacheEntry,
    getValidPersonNameNotFoundEntry,
    hydratePeopleNamesFromBackend,
    isSupportedPersonNameSource,
    normalizeBackendPeopleIds,
    PEOPLE_LIST_ORIGINAL_NAME_KEY,
    PEOPLE_NAME_SOURCE,
    queuePeopleNameBackendWrite,
    queuePeopleNameNotFoundBackendWrite,
    rememberPeopleListOriginalName,
    setPeopleTranslationCacheEntry,
    shouldUpdatePersonNameCache,
    TMDB_PERSON_NAME_NOT_FOUND_TTL_MS,
    TMDB_PERSON_NAME_TTL_MS,
};
