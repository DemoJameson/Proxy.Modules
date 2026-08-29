import * as vercelBackendClientModule from "../outbound/vercel-backend-client.mjs";
import * as commonUtils from "../utils/common.mjs";

const PEOPLE_NAME_SOURCE = {
    TMDB: "tmdb",
    GOOGLE: "google",
};
// TMDB 命中中文名 90 天、Google 姓名 30 天、无中文名负缓存 7 天（本地与远端一致）
const TMDB_PERSON_NAME_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const GOOGLE_PERSON_NAME_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TMDB_PERSON_NAME_NOT_FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PEOPLE_LIST_ORIGINAL_NAME_KEY = "__traktOriginalName";

const peopleNameBackendWriteQueue = {};

function queuePeopleNameBackendWrite(personId, nameEntry) {
    const normalizedPersonId = String(personId ?? "").trim();
    const entry = buildPersonNameCacheEntry(nameEntry);
    if (!normalizedPersonId || !entry) {
        return;
    }
    // tmdb 优先：已排队的 tmdb 条目不被 google 覆盖；正向条目覆盖同 id 的负缓存条目
    if (entry.source === PEOPLE_NAME_SOURCE.GOOGLE && peopleNameBackendWriteQueue[normalizedPersonId]?.name?.source === PEOPLE_NAME_SOURCE.TMDB) {
        return;
    }
    peopleNameBackendWriteQueue[normalizedPersonId] = { name: entry };
}

function queuePeopleNameNotFoundBackendWrite(personId) {
    const normalizedPersonId = String(personId ?? "").trim();
    if (!normalizedPersonId || commonUtils.isPlainObject(peopleNameBackendWriteQueue[normalizedPersonId]?.name)) {
        return;
    }
    peopleNameBackendWriteQueue[normalizedPersonId] = { notFound: true };
}

function flushPeopleNameBackendWrites() {
    const keys = Object.keys(peopleNameBackendWriteQueue);
    if (keys.length === 0) {
        return;
    }
    const payload = { people: {} };
    keys.forEach((key) => {
        payload.people[key] = peopleNameBackendWriteQueue[key];
        delete peopleNameBackendWriteQueue[key];
    });
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

function getPeopleTranslationCacheEntry(cache, personId) {
    if (!cache || commonUtils.isNullish(personId)) {
        return null;
    }

    const entry = cache[String(personId)];
    return commonUtils.isPlainObject(entry) ? entry : null;
}

function isSupportedPersonNameSource(source) {
    return source === PEOPLE_NAME_SOURCE.TMDB || source === PEOPLE_NAME_SOURCE.GOOGLE;
}

function buildPersonNameCacheEntry(payload) {
    const sourceTextHash = String(payload?.sourceTextHash ?? "").trim();
    const translatedText = String(payload?.translatedText ?? "").trim();
    const source = String(payload?.source ?? "").trim();
    if (!sourceTextHash || !translatedText || !isSupportedPersonNameSource(source)) {
        return null;
    }

    return {
        sourceTextHash,
        translatedText,
        source,
    };
}

function getValidPersonNameCacheEntry(entry) {
    const nameEntry = buildPersonNameCacheEntry(entry?.name);
    if (!nameEntry) {
        return null;
    }

    // tmdb 姓名 90 天 TTL、google 姓名 30 天 TTL；缺失或过期的 expiresAt 视为失效
    const expiresAt = Number(commonUtils.ensureObject(entry?.name).expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        return null;
    }

    return nameEntry;
}

function getValidPersonNameNotFoundEntry(entry) {
    const notFound = commonUtils.ensureObject(entry?.notFound);
    const expiresAt = Number(notFound.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt > Date.now() ? notFound : null;
}

function applyPersonNameNotFoundCache(cache, personId) {
    const currentEntry = getPeopleTranslationCacheEntry(cache, personId);
    if (getValidPersonNameCacheEntry(currentEntry)?.source === PEOPLE_NAME_SOURCE.TMDB) {
        return false;
    }

    const changed = setPeopleTranslationCacheEntry(cache, personId, { notFound: true });
    queuePeopleNameNotFoundBackendWrite(personId);
    return changed;
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

    return (
        currentNameEntry.sourceTextHash !== nextNameEntry.sourceTextHash ||
        currentNameEntry.translatedText !== nextNameEntry.translatedText ||
        currentNameEntry.source !== nextNameEntry.source
    );
}

function setPeopleTranslationCacheEntry(cache, personId, payload, queueBackendName = false) {
    if (!cache || commonUtils.isNullish(personId) || !commonUtils.isPlainObject(payload)) {
        return false;
    }

    const key = String(personId);
    const currentEntry = getPeopleTranslationCacheEntry(cache, key);
    const nextEntry = commonUtils.isPlainObject(currentEntry) ? { ...currentEntry } : {};

    // TMDB 查询无中文名：写 7 天负缓存；已有有效 tmdb 姓名或未过期负缓存时跳过
    if (payload.notFound === true) {
        const hasValidTmdbName = getValidPersonNameCacheEntry(currentEntry)?.source === PEOPLE_NAME_SOURCE.TMDB;
        if (!hasValidTmdbName && !getValidPersonNameNotFoundEntry(currentEntry)) {
            nextEntry.notFound = { expiresAt: Date.now() + TMDB_PERSON_NAME_NOT_FOUND_TTL_MS };
        }
    }

    if (commonUtils.isPlainObject(payload.name)) {
        const nextNameEntry = buildPersonNameCacheEntry(payload.name);
        const currentNameEntry = getValidPersonNameCacheEntry(currentEntry);
        if (nextNameEntry && shouldUpdatePersonNameCache(currentNameEntry, nextNameEntry)) {
            const storedNameEntry = { ...nextNameEntry };
            if (storedNameEntry.source === PEOPLE_NAME_SOURCE.TMDB) {
                storedNameEntry.expiresAt = Date.now() + TMDB_PERSON_NAME_TTL_MS;
                if (commonUtils.isPlainObject(nextEntry.notFound)) {
                    delete nextEntry.notFound;
                }
            } else if (storedNameEntry.source === PEOPLE_NAME_SOURCE.GOOGLE) {
                storedNameEntry.expiresAt = Date.now() + GOOGLE_PERSON_NAME_TTL_MS;
            }
            nextEntry.name = storedNameEntry;
            if (queueBackendName) {
                queuePeopleNameBackendWrite(key, storedNameEntry);
            }
        }
    }

    if (commonUtils.isPlainObject(payload.biography)) {
        const nextBiographyEntry = {
            sourceTextHash: String(payload.biography.sourceTextHash ?? ""),
            translatedText: String(payload.biography.translatedText ?? ""),
        };
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

    return String(cachedName.sourceTextHash ?? "") === commonUtils.computeStringHash(sourceText) ? String(cachedName.translatedText) : "";
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
