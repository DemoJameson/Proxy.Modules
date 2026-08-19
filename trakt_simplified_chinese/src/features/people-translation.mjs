import * as doubanClientModule from "../outbound/douban-client.mjs";
import * as googleTranslateClient from "../outbound/google-translate-client.mjs";
import * as tmdbClientModule from "../outbound/tmdb-client.mjs";
import * as traktApiClientModule from "../outbound/trakt-api-client.mjs";
import * as vercelBackendClientModule from "../outbound/vercel-backend-client.mjs";
import * as googleTranslationContext from "../shared/google-translation-context.mjs";
import * as googleTranslationPipeline from "../shared/google-translation-pipeline.mjs";
import * as mediaTypes from "../shared/media-types.mjs";
import * as traktLinkIds from "../shared/trakt-link-ids.mjs";
import * as mediaTranslationHelper from "../shared/trakt-translation-helper.mjs";
import * as cacheUtils from "../utils/cache.mjs";
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
const DOUBAN_CHARACTER_LANGUAGES = new Set(["zh", "ja", "ko"]);
const DOUBAN_SEARCH_TARGET_TYPE = {
    MOVIE: "movie",
    TV: "tv",
};
const CREDIT_CACHE_TARGET_TYPE = {
    MOVIE: "movies",
    TV: "shows",
};
const TRAKT_VOICE_CHARACTER_PATTERN = /(?:\((?:voice|voix|voz|声|配音)\)|（(?:voice|voix|voz|声|配音)）)/i;
const INVALID_DOUBAN_CHARACTER_VALUES = new Set(["导演", "演员", "配音", "制片人", "制片", "编剧", "摄影", "美术", "剪辑", "音乐", "副导演", "动作指导", "视觉特效"]);

function toDoubanSearchTargetType(cacheTargetType) {
    const normalized = String(cacheTargetType ?? "")
        .trim()
        .toLowerCase();
    return normalized === CREDIT_CACHE_TARGET_TYPE.MOVIE ? DOUBAN_SEARCH_TARGET_TYPE.MOVIE : DOUBAN_SEARCH_TARGET_TYPE.TV;
}

function toCreditCacheTargetType(doubanTargetType) {
    const normalized = String(doubanTargetType ?? "")
        .trim()
        .toLowerCase();
    return normalized === DOUBAN_SEARCH_TARGET_TYPE.MOVIE ? CREDIT_CACHE_TARGET_TYPE.MOVIE : CREDIT_CACHE_TARGET_TYPE.TV;
}

const doubanBackendWriteQueue = {
    movies: {},
    shows: {},
};

function resetDoubanBackendWriteQueue() {
    doubanBackendWriteQueue.movies = {};
    doubanBackendWriteQueue.shows = {};
}

function queueDoubanBackendWrite(targetType, traktId, value) {
    if (!value) {
        return;
    }
    const normalizedTargetType = String(targetType ?? "")
        .trim()
        .toLowerCase();
    const normalizedTraktId = String(traktId ?? "").trim();
    if (!normalizedTargetType || !normalizedTraktId || !commonUtils.isPlainObject(value)) {
        return;
    }
    doubanBackendWriteQueue[normalizedTargetType][normalizedTraktId] = {
        ...doubanBackendWriteQueue[normalizedTargetType][normalizedTraktId],
        ...value,
    };
}

function flushDoubanBackendWrites() {
    const payload = {
        movies: { ...doubanBackendWriteQueue.movies },
        shows: { ...doubanBackendWriteQueue.shows },
    };
    resetDoubanBackendWriteQueue();
    const hasWrites = Object.keys(payload.movies).length > 0 || Object.keys(payload.shows).length > 0;
    if (hasWrites && vercelBackendClientModule.resolveBackendBaseUrl()) {
        vercelBackendClientModule.postDoubanCache(payload).catch(() => {});
    }
}

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

function fetchDoubanCacheEntry(targetType, traktId) {
    if (!vercelBackendClientModule.resolveBackendBaseUrl()) {
        return Promise.resolve(null);
    }
    const normalizedTargetType = String(targetType ?? "")
        .trim()
        .toLowerCase();
    const normalizedTraktId = String(traktId ?? "").trim();
    if (!normalizedTargetType || !normalizedTraktId) {
        return Promise.resolve(null);
    }
    return vercelBackendClientModule
        .fetchDoubanCache(`${normalizedTargetType}=${normalizedTraktId}`)
        .then((payload) => {
            if (!commonUtils.isPlainObject(payload)) {
                return null;
            }
            const entry = payload[normalizedTargetType]?.[normalizedTraktId];
            return commonUtils.isPlainObject(entry) ? entry : null;
        })
        .catch(() => null);
}

function ensurePeopleMediaIdsCacheEntry(linkCache, mediaType, traktId, options = {}) {
    return traktLinkIds.ensureMediaIdsCacheEntry(
        (requestMediaType, requestTraktId) => mediaTranslationHelper.fetchMediaDetail(requestMediaType, requestTraktId),
        (cache) => cacheUtils.saveLinkIdsCache(globalThis.$ctx.env, cache),
        linkCache,
        mediaType,
        traktId,
        options,
    );
}

function fetchTmdbCredits(mediaType, tmdbId) {
    return tmdbClientModule.fetchCredits(mediaType, tmdbId);
}

function fetchTmdbPerson(tmdbPersonId) {
    return tmdbClientModule.fetchPerson(tmdbPersonId);
}

function fetchDoubanSubject(query, targetType) {
    return doubanClientModule.searchSubject(query, targetType);
}

function fetchDoubanCreditsStats(doubanId) {
    return doubanClientModule.fetchCreditsStats(doubanId);
}

function fetchDoubanSeasons(doubanId) {
    return doubanClientModule.fetchSeasons(doubanId);
}

function fetchTraktEpisodeDetail(ref) {
    return traktApiClientModule.fetchEpisodeDetail(ref);
}

function translateTextsWithGoogle(texts, sourceLanguage) {
    return googleTranslateClient.translateTextsWithGoogle(texts, sourceLanguage);
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

function resolvePeopleDetailTarget(data) {
    const traktId = data?.ids?.trakt;
    if (commonUtils.isNonNullish(traktId)) {
        return String(traktId);
    }

    const match = globalThis.$ctx.url.shortPathname.match(/^people\/(\d+)$/i);
    return match?.[1] ? String(match[1]) : "";
}

function resolvePeopleListTarget() {
    const normalizedPath = globalThis.$ctx.url.shortPathname;
    let match = normalizedPath.match(/^movies\/(\d+)\/people$/);
    if (match) {
        return { mediaType: mediaTypes.MEDIA_TYPE.MOVIE, traktId: match[1] };
    }

    match = normalizedPath.match(/^shows\/(\d+)\/people$/);
    if (match) {
        return { mediaType: mediaTypes.MEDIA_TYPE.SHOW, traktId: match[1] };
    }

    match = normalizedPath.match(/^shows\/(\d+)\/seasons\/(\d+)\/episodes\/(\d+)\/people$/);
    return match
        ? {
              mediaType: mediaTypes.MEDIA_TYPE.EPISODE,
              showTraktId: match[1],
              seasonNumber: Number(match[2]),
              episodeNumber: Number(match[3]),
          }
        : null;
}

function deriveDoubanCacheKey(targetType, traktId) {
    const normalizedTargetType = String(targetType ?? "")
        .trim()
        .toLowerCase();
    const normalizedTraktId = String(traktId ?? "").trim();
    if (!normalizedTargetType || !normalizedTraktId) {
        return "";
    }
    return `${normalizedTargetType}:${normalizedTraktId}`;
}

function resolveDoubanCacheTarget(target) {
    if (!target) {
        return null;
    }
    if (target.mediaType === mediaTypes.MEDIA_TYPE.MOVIE) {
        return { targetType: CREDIT_CACHE_TARGET_TYPE.MOVIE, traktId: String(target.traktId ?? "").trim() };
    }
    if (target.mediaType === mediaTypes.MEDIA_TYPE.SHOW) {
        return { targetType: CREDIT_CACHE_TARGET_TYPE.TV, traktId: String(target.traktId ?? "").trim() };
    }
    if (target.mediaType === mediaTypes.MEDIA_TYPE.EPISODE) {
        return { targetType: CREDIT_CACHE_TARGET_TYPE.TV, traktId: String(target.showTraktId ?? "").trim() };
    }
    return null;
}

function getDoubanCreditEntry(cache, targetType, traktId) {
    const cacheKey = deriveDoubanCacheKey(targetType, traktId);
    if (!cacheKey) {
        return null;
    }
    const entry = cache?.[cacheKey];
    return commonUtils.isPlainObject(entry) ? entry : null;
}

function ensureDoubanCreditEntry(cache, targetType, traktId) {
    const cacheKey = deriveDoubanCacheKey(targetType, traktId);
    if (!cacheKey) {
        return null;
    }
    if (!commonUtils.isPlainObject(cache[cacheKey])) {
        cache[cacheKey] = { expiresAt: Date.now() + cacheUtils.DOUBAN_CACHE_TTL_MS };
    }
    return cache[cacheKey];
}

function normalizeDoubanName(name) {
    return String(name ?? "").trim();
}

function normalizeDoubanLanguage(language) {
    return String(language ?? "")
        .trim()
        .toLowerCase();
}

function shouldTranslateCharactersForLanguage(language) {
    return DOUBAN_CHARACTER_LANGUAGES.has(normalizeDoubanLanguage(language));
}

function isDoubanActorItem(item) {
    if (String(item?.category ?? "").trim() === "演员" || commonUtils.ensureArray(item?.roles).some((role) => String(role ?? "").trim() === "演员")) {
        return true;
    }

    const simpleCharacter = String(item?.simple_character ?? "").trim();
    return /^配\s*\S+/.test(simpleCharacter) && splitDoubanCharacters(simpleCharacter).length > 0;
}

function splitDoubanCharacters(value) {
    const raw = String(value ?? "").trim();
    if (!raw || INVALID_DOUBAN_CHARACTER_VALUES.has(raw)) {
        return [];
    }

    const prefixMatch = raw.match(/^([饰配])\s*(.+)$/);
    const prefix = prefixMatch?.[1] ?? "";
    const characterText = (prefixMatch?.[2] ?? raw).trim();
    if (!characterText || INVALID_DOUBAN_CHARACTER_VALUES.has(characterText)) {
        return [];
    }

    return characterText
        .split(/\s*(?:\/|／|、|,|，)\s*/g)
        .map((item) => item.trim())
        .filter((item) => item && !INVALID_DOUBAN_CHARACTER_VALUES.has(item))
        .map((item) => (prefix === "配" ? `${item}（配音）` : item))
        .filter((item, index, array) => array.indexOf(item) === index);
}

function normalizeDoubanCreditsPayload(payload) {
    const credits = {};
    commonUtils.ensureArray(payload?.items).forEach((item) => {
        if (!isDoubanActorItem(item)) {
            return;
        }

        const name = normalizeDoubanName(item?.name);
        const characters = splitDoubanCharacters(item?.simple_character);
        if (!name || characters.length === 0) {
            return;
        }

        const current = commonUtils.ensureArray(credits[name]);
        credits[name] = current.concat(characters).filter((character, index, array) => array.indexOf(character) === index);
    });
    return credits;
}

function mergeDoubanCredits(left, right) {
    const merged = { ...commonUtils.ensureObject(left) };
    Object.entries(commonUtils.ensureObject(right)).forEach(([name, characters]) => {
        const normalizedName = normalizeDoubanName(name);
        const normalizedCharacters = commonUtils
            .ensureArray(characters)
            .map((character) => String(character ?? "").trim())
            .filter(Boolean);
        if (!normalizedName || normalizedCharacters.length === 0) {
            return;
        }

        merged[normalizedName] = commonUtils
            .ensureArray(merged[normalizedName])
            .concat(normalizedCharacters)
            .filter((character, index, array) => character && array.indexOf(character) === index);
    });
    return merged;
}

function normalizeDoubanSeasonIds(payload) {
    return commonUtils
        .ensureArray(payload)
        .filter((item) => {
            const type = String(item?.type ?? "")
                .trim()
                .toLowerCase();
            const subtype = String(item?.subtype ?? "")
                .trim()
                .toLowerCase();
            return type === "tv" || subtype === "tv";
        })
        .map((item) => String(item?.id ?? "").trim())
        .filter((id, index, array) => id && array.indexOf(id) === index);
}

async function resolveDoubanSubject(cache, query, targetType, traktId) {
    const normalizedQuery = String(query ?? "").trim();
    const normalizedTargetType = String(targetType ?? "")
        .trim()
        .toLowerCase();
    const normalizedTraktId = String(traktId ?? "").trim();
    if (!normalizedQuery || !normalizedTargetType || !normalizedTraktId) {
        return { subject: null, changed: false };
    }

    let entry = getDoubanCreditEntry(cache, normalizedTargetType, normalizedTraktId);
    if (entry?.subject?.id) {
        return { subject: entry.subject, changed: false };
    }

    const backendEntry = await fetchDoubanCacheEntry(normalizedTargetType, normalizedTraktId);
    if (backendEntry?.subject?.id) {
        entry = ensureDoubanCreditEntry(cache, normalizedTargetType, normalizedTraktId);
        if (backendEntry.subject) {
            entry.subject = backendEntry.subject;
        }
        if (backendEntry.seasons) {
            entry.seasons = backendEntry.seasons;
        }
        if (backendEntry.credits) {
            entry.credits = backendEntry.credits;
        }
        return { subject: backendEntry.subject, changed: true };
    }

    const subject = await fetchDoubanSubject(normalizedQuery, toDoubanSearchTargetType(normalizedTargetType));
    const normalizedSubject =
        commonUtils.isPlainObject(subject) && String(subject?.id ?? "").trim() ? { ...subject, targetType: toCreditCacheTargetType(subject.targetType) } : null;
    if (!normalizedSubject) {
        return { subject: null, changed: false };
    }
    entry = ensureDoubanCreditEntry(cache, normalizedTargetType, normalizedTraktId);
    entry.subject = normalizedSubject;
    queueDoubanBackendWrite(normalizedTargetType, normalizedTraktId, { subject: normalizedSubject });
    return { subject: normalizedSubject, changed: true };
}

async function getDoubanSeasonIds(cache, doubanId, targetType, traktId, { allowFetch = true } = {}) {
    const key = String(doubanId ?? "").trim();
    if (!key) {
        return { ids: [], changed: false };
    }

    let entry = getDoubanCreditEntry(cache, targetType, traktId);
    const cachedIds = commonUtils.ensureArray(entry?.seasons?.ids).filter(Boolean);
    if (cachedIds.length > 0) {
        return { ids: cachedIds, changed: false };
    }

    if (!allowFetch) {
        return { ids: [], changed: false };
    }

    const payload = await fetchDoubanSeasons(key);
    const ids = normalizeDoubanSeasonIds(payload);
    if (ids.length === 0) {
        return { ids: [], changed: false };
    }

    entry = ensureDoubanCreditEntry(cache, targetType, traktId);
    entry.seasons = { ids };
    queueDoubanBackendWrite(targetType, traktId, { seasons: { ids } });
    return { ids, changed: true };
}

async function resolveDoubanCreditsForIds(cache, doubanIds, targetType, traktId) {
    const ids = commonUtils
        .ensureArray(doubanIds)
        .map((id) => String(id ?? "").trim())
        .filter(Boolean);
    if (ids.length === 0) {
        return { credits: {}, changed: false };
    }

    let entry = getDoubanCreditEntry(cache, targetType, traktId);
    const existingCredits = commonUtils.ensureObject(entry?.credits);
    if (Object.keys(existingCredits).length > 0) {
        return { credits: existingCredits, changed: false };
    }

    let mergedCredits = {};
    for (const doubanId of ids) {
        try {
            const payload = await fetchDoubanCreditsStats(doubanId);
            const credits = normalizeDoubanCreditsPayload(payload);
            mergedCredits = mergeDoubanCredits(mergedCredits, credits);
        } catch (error) {
            globalThis.$ctx?.env?.log?.(`Trakt Douban credits fetch failed for ${doubanId}: ${error}`);
        }
    }

    if (Object.keys(mergedCredits).length === 0) {
        return { credits: {}, changed: false };
    }

    entry = ensureDoubanCreditEntry(cache, targetType, traktId);
    entry.credits = mergedCredits;
    queueDoubanBackendWrite(targetType, traktId, { credits: mergedCredits });
    return { credits: mergedCredits, changed: true };
}

function inferEpisodeDoubanIdFromCreditEntry(creditEntry, showDoubanId, seasonNumber) {
    const normalizedSeasonNumber = Number(seasonNumber);
    const normalizedShowDoubanId = String(showDoubanId ?? "").trim();
    if (!normalizedShowDoubanId || !Number.isFinite(normalizedSeasonNumber) || normalizedSeasonNumber < 1) {
        return "";
    }

    if (normalizedSeasonNumber === 1) {
        return normalizedShowDoubanId;
    }

    const seasonIds = commonUtils.ensureArray(creditEntry?.seasons?.ids);
    return String(seasonIds[normalizedSeasonNumber - 2] ?? "").trim();
}

function collectPeopleCollectionItems(data) {
    return commonUtils.ensureArray(data).reduce((items, entry) => {
        if (commonUtils.isPlainObject(entry?.person)) {
            items.push({ person: entry.person });
            return items;
        }

        if (commonUtils.isPlainObject(entry) && commonUtils.isPlainObject(entry.ids) && String(entry.name ?? "").trim()) {
            items.push({ person: entry });
        }

        return items;
    }, []);
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

function buildBiographyGoogleContextLine(originalName, translatedName) {
    const sourceName = String(originalName ?? "").trim();
    const localizedName = String(translatedName ?? "").trim();
    return sourceName && localizedName ? googleTranslationContext.buildContextLine(sourceName, localizedName) : "";
}

function buildBiographyGoogleSourceText(originalBiography, originalName, translatedName) {
    const biography = String(originalBiography ?? "").trim();
    return googleTranslationContext.buildSourceText(biography, buildBiographyGoogleContextLine(originalName, translatedName));
}

function removeBiographyGoogleContext(translatedBiography) {
    return googleTranslationContext.removeContextLine(translatedBiography);
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

function buildTmdbCastNameMap(tmdbPayload) {
    const nameMap = {};
    const cast =
        commonUtils.ensureArray(tmdbPayload?.credits?.cast).length > 0
            ? commonUtils.ensureArray(tmdbPayload?.credits?.cast)
            : commonUtils.ensureArray(tmdbPayload?.aggregate_credits?.cast);
    const crew =
        commonUtils.ensureArray(tmdbPayload?.credits?.crew).length > 0
            ? commonUtils.ensureArray(tmdbPayload?.credits?.crew)
            : commonUtils.ensureArray(tmdbPayload?.aggregate_credits?.crew);

    cast.concat(crew).forEach((item) => {
        const personId = item?.id;
        const name = String(item?.name ?? "").trim();
        if (commonUtils.isNullish(personId) || !name) {
            return;
        }

        nameMap[String(personId)] = name;
    });
    return nameMap;
}

function collectPeopleListPersonItems(data) {
    if (!commonUtils.isPlainObject(data)) {
        return [];
    }

    const crewItems = commonUtils.isPlainObject(data.crew) ? Object.keys(data.crew).reduce((items, key) => items.concat(commonUtils.ensureArray(data.crew[key])), []) : [];

    return commonUtils.ensureArray(data.cast).concat(crewItems);
}

function applyPeopleListCachedNameTranslations(data, cache) {
    if (!commonUtils.isPlainObject(data) || !commonUtils.isPlainObject(cache)) {
        return { changed: false, hasMissing: false };
    }

    let changed = false;
    let hasMissing = false;
    collectPeopleListPersonItems(data).forEach((item) => {
        const person = item?.person;
        if (!commonUtils.isPlainObject(person)) {
            return;
        }

        const originalName = String(person.name ?? "").trim();
        if (!originalName) {
            return;
        }

        rememberPeopleListOriginalName(person, originalName);

        const cacheEntries = getPersonTranslationCacheKeys(person)
            .map((personKey) => getPeopleTranslationCacheEntry(cache, personKey))
            .filter(Boolean);
        const cachedName = cacheEntries.map((entry) => getCachedPersonNameTranslation(entry, originalName)).find(Boolean);
        const hasUpgradeableGoogleCache =
            commonUtils.isNonNullish(person?.ids?.tmdb) &&
            cacheEntries.some((entry) => {
                return getValidPersonNameCacheEntry(entry)?.source === PEOPLE_NAME_SOURCE.GOOGLE;
            });
        // 有效负缓存表示 TMDB 已确认无中文名，无需再查
        const hasValidNotFound = cacheEntries.some((entry) => getValidPersonNameNotFoundEntry(entry));

        if (cachedName) {
            if (cachedName !== originalName) {
                person.name = cachedName;
                changed = true;
            }
            if (hasUpgradeableGoogleCache && !hasValidNotFound) {
                hasMissing = true;
            }
            return;
        }

        if (commonUtils.isNonNullish(person?.ids?.tmdb) && !hasValidNotFound) {
            hasMissing = true;
        }
    });

    return { changed, hasMissing };
}

function collectPeopleListMissingTmdbNameIds(data, cache) {
    if (!commonUtils.isPlainObject(data) || !commonUtils.isPlainObject(cache)) {
        return [];
    }

    // 与 applyPeopleListCachedNameTranslations 的 hasMissing 判定保持一致：
    // 有 tmdb id 且（无 hash 匹配的缓存姓名，或缓存为 google 来源可升级为 tmdb），且无有效负缓存
    return collectPeopleListPersonItems(data).reduce((ids, item) => {
        const person = item?.person;
        if (!commonUtils.isPlainObject(person) || commonUtils.isNullish(person?.ids?.tmdb)) {
            return ids;
        }

        const originalName = String(person.name ?? "").trim();
        if (!originalName) {
            return ids;
        }

        const cacheEntries = getPersonTranslationCacheKeys(person)
            .map((personKey) => getPeopleTranslationCacheEntry(cache, personKey))
            .filter(Boolean);
        const hasValidNotFound = cacheEntries.some((entry) => getValidPersonNameNotFoundEntry(entry));
        if (hasValidNotFound) {
            return ids;
        }

        const hasCachedName = cacheEntries.map((entry) => getCachedPersonNameTranslation(entry, originalName)).some(Boolean);
        const hasUpgradeableGoogleCache = cacheEntries.some((entry) => getValidPersonNameCacheEntry(entry)?.source === PEOPLE_NAME_SOURCE.GOOGLE);
        if (hasCachedName && !hasUpgradeableGoogleCache) {
            return ids;
        }

        return ids.concat(getPersonTranslationCacheKeys(person));
    }, []);
}

function applyPeopleListCastNameTranslations(data, tmdbCastNameMap, cache) {
    if (!commonUtils.isPlainObject(data) || !commonUtils.isPlainObject(tmdbCastNameMap)) {
        return false;
    }

    let changed = false;
    collectPeopleListPersonItems(data).forEach((item) => {
        const person = item?.person;
        const personTmdbId = person?.ids?.tmdb;
        if (!commonUtils.isPlainObject(person) || commonUtils.isNullish(personTmdbId)) {
            return;
        }

        const translatedName = String(tmdbCastNameMap[String(personTmdbId)] ?? "").trim();
        if (!translatedName || !commonUtils.containsChineseCharacter(translatedName)) {
            // TMDB 已查询但该人物无中文名：写 7 天负缓存（本地 + 远端）
            getPersonTranslationCacheKeys(person).forEach((personKey) => {
                changed = applyPersonNameNotFoundCache(cache, personKey) || changed;
            });
            return;
        }

        const originalName = getPeopleListOriginalName(person);
        if (!originalName) {
            return;
        }

        if (String(person.name ?? "").trim() !== translatedName) {
            person.name = translatedName;
            changed = true;
        }

        const tmdbNameEntry = {
            sourceTextHash: commonUtils.computeStringHash(originalName),
            translatedText: translatedName,
            source: PEOPLE_NAME_SOURCE.TMDB,
        };
        getPersonTranslationCacheKeys(person).forEach((personKey) => {
            changed = setPeopleTranslationCacheEntry(cache, personKey, { name: tmdbNameEntry }, true) || changed;
        });
    });

    return changed;
}

function collectPeopleListGoogleNameTranslationTargets(data, cache) {
    if (!commonUtils.isPlainObject(data) || !commonUtils.isPlainObject(cache)) {
        return [];
    }

    return collectPeopleListPersonItems(data).reduce((targets, item) => {
        const person = item?.person;
        if (!commonUtils.isPlainObject(person)) {
            return targets;
        }

        const originalName = String(person.name ?? "").trim();
        if (!originalName) {
            return targets;
        }

        const cachedName = getPersonTranslationCacheKeys(person)
            .map((personKey) => getCachedPersonNameTranslation(getPeopleTranslationCacheEntry(cache, personKey), originalName))
            .find(Boolean);

        if (!cachedName) {
            targets.push({ person, originalName });
        }

        return targets;
    }, []);
}

function applyPeopleListGoogleNameTranslations(translationTargets, translatedTexts, cache) {
    let changed = false;
    const normalizedTranslatedTexts = commonUtils.ensureArray(translatedTexts);
    commonUtils.ensureArray(translationTargets).forEach((target, index) => {
        const person = target?.person;
        const originalName = String(target?.originalName ?? getPeopleListOriginalName(person)).trim();
        const translatedName = String(normalizedTranslatedTexts[index] ?? "").trim();
        if (!commonUtils.isPlainObject(person) || !originalName || !translatedName || translatedName === originalName || !commonUtils.containsChineseCharacter(translatedName)) {
            return;
        }

        if (String(person.name ?? "").trim() !== originalName) {
            return;
        }

        person.name = translatedName;
        changed = true;

        getPersonTranslationCacheKeys(person).forEach((personKey) => {
            setPeopleTranslationCacheEntry(
                cache,
                personKey,
                {
                    name: {
                        sourceTextHash: commonUtils.computeStringHash(originalName),
                        translatedText: translatedName,
                        source: PEOPLE_NAME_SOURCE.GOOGLE,
                    },
                },
                true,
            );
        });
    });

    return changed;
}

function getCastItemCurrentCharacters(castItem) {
    const characters = commonUtils
        .ensureArray(castItem?.characters)
        .map((item) => String(item ?? "").trim())
        .filter(Boolean);
    if (characters.length > 0) {
        return characters;
    }

    const character = String(castItem?.character ?? "").trim();
    return character ? [character] : [];
}

function shouldSkipDoubanCharacterReplacement(castItem) {
    const characters = getCastItemCurrentCharacters(castItem);
    return characters.length > 0 && characters.every((character) => commonUtils.containsChineseCharacter(character));
}

function isTraktVoiceCastItem(castItem) {
    return getCastItemCurrentCharacters(castItem).some((character) => TRAKT_VOICE_CHARACTER_PATTERN.test(character));
}

function formatDoubanCharacterForCastItem(character, castItem) {
    const normalizedCharacter = String(character ?? "").trim();
    if (!normalizedCharacter || !isTraktVoiceCastItem(castItem) || /（配音）$/.test(normalizedCharacter)) {
        return normalizedCharacter;
    }

    return `${normalizedCharacter}（配音）`;
}

function normalizeVoiceSuffixInCharacter(character) {
    return String(character ?? "").replace(/\s*\(voice\)/gi, "（配音）");
}

function normalizeVoiceSuffixInCastItem(castItem) {
    if (!commonUtils.isPlainObject(castItem)) {
        return false;
    }
    let changed = false;
    const characters = commonUtils.ensureArray(castItem.characters);
    if (characters.length > 0) {
        const normalized = characters.map((item) => normalizeVoiceSuffixInCharacter(item));
        if (JSON.stringify(normalized) !== JSON.stringify(characters)) {
            castItem.characters = normalized;
            changed = true;
        }
    }
    const character = String(castItem.character ?? "");
    const normalizedCharacter = normalizeVoiceSuffixInCharacter(character);
    if (normalizedCharacter !== character) {
        castItem.character = normalizedCharacter;
        changed = true;
    }
    return changed;
}

function normalizeVoiceSuffixInCast(data) {
    if (!commonUtils.isPlainObject(data)) {
        return false;
    }
    let changed = false;
    commonUtils.ensureArray(data.cast).forEach((castItem) => {
        changed = normalizeVoiceSuffixInCastItem(castItem) || changed;
    });
    return changed;
}

function applyDoubanCharacterTranslations(data, credits) {
    if (!commonUtils.isPlainObject(data) || !commonUtils.isPlainObject(credits)) {
        return false;
    }

    let changed = false;
    commonUtils.ensureArray(data.cast).forEach((castItem) => {
        const personName = normalizeDoubanName(castItem?.person?.name);
        const characters = commonUtils
            .ensureArray(credits[personName])
            .map((character) => String(character ?? "").trim())
            .map((character) => formatDoubanCharacterForCastItem(character, castItem))
            .filter(Boolean);
        if (!personName || characters.length === 0 || shouldSkipDoubanCharacterReplacement(castItem)) {
            return;
        }

        const nextCharacters = characters.filter((character, index, array) => array.indexOf(character) === index);
        const nextCharacter = nextCharacters.join(" / ");
        if (JSON.stringify(commonUtils.ensureArray(castItem.characters)) !== JSON.stringify(nextCharacters)) {
            castItem.characters = nextCharacters;
            changed = true;
        }
        if (String(castItem.character ?? "") !== nextCharacter) {
            castItem.character = nextCharacter;
            changed = true;
        }
    });
    return changed;
}

function applyPeopleCollectionCachedTranslations(data, cache) {
    if (!commonUtils.isPlainObject(cache)) {
        return { changed: false, nameTargets: [], biographyTargets: [] };
    }

    let changed = false;
    const nameTargets = [];
    const biographyTargets = [];

    collectPeopleCollectionItems(data).forEach((item) => {
        const person = item?.person;
        if (!commonUtils.isPlainObject(person)) {
            return;
        }

        const personKeys = getPersonTranslationCacheKeys(person);
        const cacheEntries = personKeys.map((personKey) => getPeopleTranslationCacheEntry(cache, personKey)).filter(Boolean);
        const originalName = String(person.name ?? "").trim();
        const originalBiography = String(person.biography ?? "").trim();

        if (originalName) {
            const cachedName = cacheEntries.map((entry) => getCachedPersonNameTranslation(entry, originalName)).find(Boolean);
            if (cachedName) {
                if (person.name !== cachedName) {
                    person.name = cachedName;
                    changed = true;
                }
            } else if (!commonUtils.containsChineseCharacter(originalName) && personKeys.length > 0) {
                nameTargets.push({ person, originalName, personKeys });
            }
        }

        if (originalBiography) {
            const cachedBiography = cacheEntries.map((entry) => getCachedPersonBiographyTranslation(entry, originalBiography)).find(Boolean);
            if (cachedBiography) {
                if (person.biography !== cachedBiography) {
                    person.biography = cachedBiography;
                    changed = true;
                }
            } else if (!commonUtils.containsChineseCharacter(originalBiography) && personKeys.length > 0) {
                const contextName = cacheEntries.map((entry) => getCachedTmdbPersonNameTranslation(entry, originalName)).find(Boolean) ?? "";
                biographyTargets.push({ person, originalName, originalBiography, personKeys, contextName });
            }
        }
    });

    return { changed, nameTargets, biographyTargets };
}

function collectPeopleCollectionMissingTmdbNameIds(data, cache) {
    if (!commonUtils.isPlainObject(cache)) {
        return [];
    }

    return collectPeopleCollectionItems(data).reduce((ids, item) => {
        const person = item?.person;
        if (!commonUtils.isPlainObject(person) || commonUtils.isNullish(person?.ids?.tmdb)) {
            return ids;
        }

        const originalName = String(person.name ?? "").trim();
        if (!originalName) {
            return ids;
        }

        const personKeys = getPersonTranslationCacheKeys(person);
        if (personKeys.length === 0) {
            return ids;
        }

        const hasCachedName = personKeys.map((personKey) => getCachedPersonNameTranslation(getPeopleTranslationCacheEntry(cache, personKey), originalName)).some(Boolean);
        const hasValidNotFound = personKeys.some((personKey) => getValidPersonNameNotFoundEntry(getPeopleTranslationCacheEntry(cache, personKey)));
        if (hasCachedName || hasValidNotFound) {
            return ids;
        }

        return ids.concat(personKeys);
    }, []);
}

async function applyPeopleCollectionGoogleNameTranslations(translationTargets, cache) {
    const result = await googleTranslationPipeline.translateTextFieldTargets(
        commonUtils.ensureArray(translationTargets).map((target) => {
            const person = target?.person;
            const originalName = String(target?.originalName ?? "").trim();
            return {
                sourceLanguage: "en",
                sourceText: originalName,
                shouldAcceptTranslation(translatedName) {
                    return (
                        commonUtils.isPlainObject(person) &&
                        originalName &&
                        translatedName &&
                        translatedName !== originalName &&
                        commonUtils.containsChineseCharacter(translatedName)
                    );
                },
                setCachedTranslation(translatedName) {
                    let changed = false;
                    commonUtils.ensureArray(target?.personKeys).forEach((personKey) => {
                        changed =
                            setPeopleTranslationCacheEntry(
                                cache,
                                personKey,
                                {
                                    name: {
                                        sourceTextHash: commonUtils.computeStringHash(originalName),
                                        translatedText: translatedName,
                                        source: PEOPLE_NAME_SOURCE.GOOGLE,
                                    },
                                },
                                true,
                            ) || changed;
                    });
                    return changed;
                },
                applyTranslation(translatedName) {
                    if (!commonUtils.isPlainObject(person) || person.name === translatedName) {
                        return false;
                    }

                    person.name = translatedName;
                    return true;
                },
            };
        }),
        {
            logFailure(language, error) {
                globalThis.$ctx.env.log(`Trakt people collection Google name translation failed for language=${language}: ${error}`);
            },
        },
    );

    return result.changed;
}

async function applyPeopleCollectionGoogleBiographyTranslations(translationTargets, cache) {
    const result = await googleTranslationPipeline.translateTextFieldTargets(
        commonUtils.ensureArray(translationTargets).map((target) => {
            const person = target?.person;
            const originalBiography = String(target?.originalBiography ?? "").trim();
            const originalName = String(target?.originalName ?? "").trim();
            const contextName = String(target?.contextName ?? "").trim();
            return {
                sourceLanguage: "en",
                sourceText: buildBiographyGoogleSourceText(originalBiography, originalName, contextName),
                shouldAcceptTranslation(translatedBiography) {
                    return commonUtils.isPlainObject(person) && originalBiography && removeBiographyGoogleContext(translatedBiography);
                },
                setCachedTranslation(translatedBiography) {
                    const normalizedBiography = removeBiographyGoogleContext(translatedBiography);
                    let changed = false;
                    commonUtils.ensureArray(target?.personKeys).forEach((personKey) => {
                        changed =
                            setPeopleTranslationCacheEntry(cache, personKey, {
                                biography: {
                                    sourceTextHash: commonUtils.computeStringHash(originalBiography),
                                    translatedText: normalizedBiography,
                                },
                            }) || changed;
                    });
                    return changed;
                },
                applyTranslation(translatedBiography) {
                    const normalizedBiography = removeBiographyGoogleContext(translatedBiography);
                    if (!commonUtils.isPlainObject(person) || !normalizedBiography || person.biography === normalizedBiography) {
                        return false;
                    }

                    person.biography = normalizedBiography;
                    return true;
                },
            };
        }),
        {
            logFailure(language, error) {
                globalThis.$ctx.env.log(`Trakt people collection Google biography translation failed for language=${language}: ${error}`);
            },
        },
    );

    return result.changed;
}

async function resolvePeopleListTmdbId(target, linkCache) {
    if (!target || !linkCache) {
        return null;
    }

    if (target.mediaType === mediaTypes.MEDIA_TYPE.MOVIE || target.mediaType === mediaTypes.MEDIA_TYPE.SHOW) {
        const entry = await ensurePeopleMediaIdsCacheEntry(linkCache, target.mediaType, target.traktId);
        return commonUtils.isNonNullish(entry?.ids?.tmdb) ? entry.ids.tmdb : null;
    }

    if (target.mediaType === mediaTypes.MEDIA_TYPE.EPISODE) {
        const showEntry = await ensurePeopleMediaIdsCacheEntry(linkCache, mediaTypes.MEDIA_TYPE.SHOW, target.showTraktId);
        return commonUtils.isNonNullish(showEntry?.ids?.tmdb) ? showEntry.ids.tmdb : null;
    }

    return null;
}

async function resolvePeopleListMediaEntry(target, linkCache) {
    if (!target || !linkCache) {
        return null;
    }

    const options = { requiredIdFields: ["tmdb", "imdb"], requiredFields: ["language"] };
    if (target.mediaType === mediaTypes.MEDIA_TYPE.MOVIE || target.mediaType === mediaTypes.MEDIA_TYPE.SHOW) {
        return ensurePeopleMediaIdsCacheEntry(linkCache, target.mediaType, target.traktId, options);
    }

    if (target.mediaType === mediaTypes.MEDIA_TYPE.EPISODE) {
        // Use the show entry itself, not an episode showIds snapshot, so detail lookup can provide language.
        return ensurePeopleMediaIdsCacheEntry(linkCache, mediaTypes.MEDIA_TYPE.SHOW, target.showTraktId, options);
    }

    return null;
}

async function ensureFirstEpisodeIdsCacheEntry(linkCache, target) {
    if (!linkCache || !target || target.mediaType !== mediaTypes.MEDIA_TYPE.EPISODE || commonUtils.isNullish(target.showTraktId) || commonUtils.isNullish(target.seasonNumber)) {
        return null;
    }

    const cacheKey = `episode:first:${target.showTraktId}:${target.seasonNumber}`;
    const cached = traktLinkIds.getLinkIdsCacheEntry(linkCache, cacheKey);
    if (commonUtils.isPlainObject(cached?.ids) && commonUtils.isNonNullish(cached.ids.imdb)) {
        return cached;
    }

    const payload = await fetchTraktEpisodeDetail({
        showId: target.showTraktId,
        seasonNumber: target.seasonNumber,
        episodeNumber: 1,
    });
    if (!commonUtils.isPlainObject(payload)) {
        return null;
    }

    traktLinkIds.setLinkIdsCacheEntry(linkCache, cacheKey, {
        ids: payload.ids,
        showIds: { trakt: target.showTraktId },
        seasonNumber: payload?.season ?? target.seasonNumber,
        episodeNumber: payload?.number ?? 1,
    });
    cacheUtils.saveLinkIdsCache(globalThis.$ctx.env, linkCache);
    return traktLinkIds.getLinkIdsCacheEntry(linkCache, cacheKey);
}

async function collectDoubanCreditsForPeopleTarget(target, linkCache, doubanCache) {
    resetDoubanBackendWriteQueue();
    const cacheTarget = resolveDoubanCacheTarget(target);
    if (!cacheTarget) {
        return { credits: {}, changed: false };
    }
    const { targetType, traktId } = cacheTarget;

    const mediaEntry = await resolvePeopleListMediaEntry(target, linkCache);
    if (!mediaEntry || !shouldTranslateCharactersForLanguage(mediaEntry.language)) {
        return { credits: {}, changed: false };
    }

    let changed = false;
    const imdbId = String(mediaEntry?.ids?.imdb ?? "").trim();
    if (!imdbId) {
        return { credits: {}, changed: false };
    }

    const subjectResult = await resolveDoubanSubject(doubanCache, imdbId, targetType, traktId);
    changed = subjectResult.changed || changed;
    const creditEntry = getDoubanCreditEntry(doubanCache, targetType, traktId);
    const mainDoubanId = String(creditEntry?.subject?.id ?? "").trim();
    if (!mainDoubanId) {
        flushDoubanBackendWrites();
        return { credits: {}, changed };
    }

    let doubanIds = [];
    if (target.mediaType === mediaTypes.MEDIA_TYPE.MOVIE) {
        doubanIds = [mainDoubanId];
    } else if (target.mediaType === mediaTypes.MEDIA_TYPE.SHOW) {
        let seasonResult = { ids: [], changed: false };
        try {
            seasonResult = await getDoubanSeasonIds(doubanCache, mainDoubanId, targetType, traktId);
        } catch (error) {
            globalThis.$ctx.env.log(`Trakt media people Douban seasons lookup failed: ${error}`);
        }
        changed = seasonResult.changed || changed;
        doubanIds = [mainDoubanId].concat(seasonResult.ids).filter((id, index, array) => id && array.indexOf(id) === index);
    } else if (target.mediaType === mediaTypes.MEDIA_TYPE.EPISODE) {
        const inferredDoubanId = inferEpisodeDoubanIdFromCreditEntry(creditEntry, mainDoubanId, target.seasonNumber);
        if (inferredDoubanId) {
            doubanIds = [inferredDoubanId];
        } else {
            const firstEpisodeEntry = await ensureFirstEpisodeIdsCacheEntry(linkCache, target);
            const firstEpisodeImdbId = String(firstEpisodeEntry?.ids?.imdb ?? "").trim();
            if (firstEpisodeImdbId) {
                try {
                    const firstEpisodeSubject = await fetchDoubanSubject(firstEpisodeImdbId, DOUBAN_SEARCH_TARGET_TYPE.TV);
                    const firstEpisodeDoubanId = String(firstEpisodeSubject?.id ?? "").trim();
                    if (firstEpisodeDoubanId) {
                        doubanIds = [firstEpisodeDoubanId];
                    }
                } catch (error) {
                    globalThis.$ctx.env.log(`Trakt episode Douban subject lookup failed: ${error}`);
                }
            }
        }
    }

    const creditsResult = await resolveDoubanCreditsForIds(doubanCache, doubanIds, targetType, traktId);
    changed = creditsResult.changed || changed;

    flushDoubanBackendWrites();
    return { credits: creditsResult.credits, changed };
}

function buildPeopleListTmdbMediaType(target) {
    if (!target) {
        return null;
    }

    return target.mediaType === mediaTypes.MEDIA_TYPE.MOVIE ? mediaTypes.MEDIA_TYPE.MOVIE : mediaTypes.MEDIA_TYPE.SHOW;
}

async function handleMediaPeopleList() {
    const context = globalThis.$ctx;
    const data = JSON.parse(context.responseBody);
    if (!commonUtils.isPlainObject(data)) {
        return { type: "passThrough" };
    }

    const target = resolvePeopleListTarget();
    if (!target) {
        return { type: "passThrough" };
    }

    const cache = cacheUtils.loadPeopleTranslationCache(context.env);
    const missingTmdbNameIds = collectPeopleListMissingTmdbNameIds(data, cache);
    let cacheChanged = false;
    if (missingTmdbNameIds.length > 0) {
        cacheChanged = await hydratePeopleNamesFromBackend(cache, missingTmdbNameIds);
    }
    const cachedResult = applyPeopleListCachedNameTranslations(data, cache);

    try {
        const googleTargets = context.argument.googleTranslationEnabled ? collectPeopleListGoogleNameTranslationTargets(data, cache) : [];
        const googlePromise =
            cachedResult.hasMissing && googleTargets.length > 0
                ? translateTextsWithGoogle(
                      googleTargets.map((item) => item.originalName),
                      "en",
                  )
                : Promise.resolve([]);
        const tmdbPromise = (async () => {
            if (!cachedResult.hasMissing) {
                return null;
            }
            const linkCache = cacheUtils.loadLinkIdsCache(context.env);
            const tmdbId = await resolvePeopleListTmdbId(target, linkCache);
            const tmdbMediaType = buildPeopleListTmdbMediaType(target);
            if (commonUtils.isNullish(tmdbId) || !tmdbMediaType) {
                return null;
            }

            return fetchTmdbCredits(tmdbMediaType, tmdbId);
        })();
        const doubanPromise = (async () => {
            if (context.argument.characterTranslationEnabled === false) {
                return null;
            }

            const linkCache = cacheUtils.loadLinkIdsCache(context.env);
            const doubanCache = cacheUtils.loadDoubanCache(context.env);
            const result = await collectDoubanCreditsForPeopleTarget(target, linkCache, doubanCache);
            if (result.changed) {
                cacheUtils.saveDoubanCache(context.env, doubanCache);
            }
            return result.credits;
        })();

        const [tmdbResult, googleResult, doubanResult] = await Promise.allSettled([tmdbPromise, googlePromise, doubanPromise]);
        let changed = cacheChanged;

        if (tmdbResult.status === "fulfilled" && tmdbResult.value) {
            const tmdbCastNameMap = buildTmdbCastNameMap(tmdbResult.value);
            changed = applyPeopleListCastNameTranslations(data, tmdbCastNameMap, cache) || changed;
        } else if (tmdbResult.status === "rejected") {
            context.env.log(`Trakt media people TMDb translation failed: ${tmdbResult.reason}`);
        }

        if (googleResult.status === "fulfilled") {
            changed = applyPeopleListGoogleNameTranslations(googleTargets, googleResult.value, cache) || changed;
        } else {
            context.env.log(`Trakt media people Google translation failed: ${googleResult.reason}`);
        }

        if (doubanResult.status === "fulfilled" && doubanResult.value) {
            changed = applyDoubanCharacterTranslations(data, doubanResult.value) || changed;
        } else if (doubanResult.status === "rejected") {
            context.env.log(`Trakt media people Douban character translation failed: ${doubanResult.reason}`);
        }

        if (context.argument.characterTranslationEnabled !== false) {
            changed = normalizeVoiceSuffixInCast(data) || changed;
        }

        if (changed) {
            cacheUtils.savePeopleTranslationCache(context.env, cache);
        }
        flushPeopleNameBackendWrites();
        return { type: "respond", body: JSON.stringify(data) };
    } catch (error) {
        context.env.log(`Trakt media people translation failed: ${error}`);
        return { type: "respond", body: JSON.stringify(data) };
    }
}

async function handlePersonMediaCreditsList() {
    const data = JSON.parse(globalThis.$ctx.responseBody);
    if (!commonUtils.isPlainObject(data)) {
        return { type: "passThrough" };
    }

    const crewItems = commonUtils.isPlainObject(data.crew) ? Object.keys(data.crew).reduce((items, key) => items.concat(commonUtils.ensureArray(data.crew[key])), []) : [];
    const items = commonUtils.ensureArray(data.cast).concat(crewItems);

    if (items.length === 0) {
        return { type: "passThrough" };
    }

    await mediaTranslationHelper.translateMediaItemsInPlace(items);
    return { type: "respond", body: JSON.stringify(data) };
}

async function handlePeopleSearchList() {
    const context = globalThis.$ctx;
    const data = JSON.parse(context.responseBody);
    if (!Array.isArray(data)) {
        return { type: "passThrough" };
    }

    const cache = cacheUtils.loadPeopleTranslationCache(context.env);
    const missingTmdbNameIds = collectPeopleCollectionMissingTmdbNameIds(data, cache);
    let hydratedChanged = false;
    if (missingTmdbNameIds.length > 0) {
        hydratedChanged = await hydratePeopleNamesFromBackend(cache, missingTmdbNameIds);
    }
    const cachedResult = applyPeopleCollectionCachedTranslations(data, cache);
    let changed = cachedResult.changed || hydratedChanged;

    try {
        const nameTargets = context.argument.googleTranslationEnabled ? cachedResult.nameTargets : [];
        const biographyTargets = context.argument.googleTranslationEnabled ? cachedResult.biographyTargets : [];
        if (nameTargets.length === 0 && biographyTargets.length === 0) {
            if (changed) {
                cacheUtils.savePeopleTranslationCache(context.env, cache);
            }
            flushPeopleNameBackendWrites();
            return { type: "respond", body: JSON.stringify(data) };
        }

        const [nameResult, biographyResult] = await Promise.allSettled([
            nameTargets.length > 0 ? applyPeopleCollectionGoogleNameTranslations(nameTargets, cache) : Promise.resolve(false),
            biographyTargets.length > 0 ? applyPeopleCollectionGoogleBiographyTranslations(biographyTargets, cache) : Promise.resolve(false),
        ]);

        if (nameResult.status === "fulfilled") {
            changed = nameResult.value || changed;
        } else {
            context.env.log(`Trakt people collection Google name translation failed: ${nameResult.reason}`);
        }

        if (biographyResult.status === "fulfilled") {
            changed = biographyResult.value || changed;
        } else {
            context.env.log(`Trakt people collection Google biography translation failed: ${biographyResult.reason}`);
        }

        if (changed) {
            cacheUtils.savePeopleTranslationCache(context.env, cache);
        }
        flushPeopleNameBackendWrites();
        return { type: "respond", body: JSON.stringify(data) };
    } catch (error) {
        context.env.log(`Trakt people collection translation failed: ${error}`);
        flushPeopleNameBackendWrites();
        return { type: "respond", body: JSON.stringify(data) };
    }
}

async function handlePeopleDetail() {
    const context = globalThis.$ctx;
    const data = JSON.parse(context.responseBody);
    if (!commonUtils.isPlainObject(data)) {
        return { type: "passThrough" };
    }

    const personId = resolvePeopleDetailTarget(data);
    if (!personId) {
        return { type: "passThrough" };
    }

    const cache = cacheUtils.loadPeopleTranslationCache(context.env);
    const initialCacheEntry = getPeopleTranslationCacheEntry(cache, personId);
    const shouldHydrateTmdbName =
        commonUtils.isNonNullish(data?.ids?.tmdb) &&
        getValidPersonNameCacheEntry(initialCacheEntry)?.source !== PEOPLE_NAME_SOURCE.TMDB &&
        !getValidPersonNameNotFoundEntry(initialCacheEntry);
    let cacheChanged = false;
    if (shouldHydrateTmdbName) {
        cacheChanged = await hydratePeopleNamesFromBackend(cache, [personId]);
    }
    const cacheEntry = getPeopleTranslationCacheEntry(cache, personId);
    const nextCacheEntry = {};
    const originalName = String(data.name ?? "").trim();
    const originalBiography = String(data.biography ?? "").trim();
    const cachedName = originalName ? getCachedPersonNameTranslation(cacheEntry, originalName) : "";
    const cachedNameEntry = getValidPersonNameCacheEntry(cacheEntry);
    let biographyContextName = originalName ? getCachedTmdbPersonNameTranslation(cacheEntry, originalName) : "";
    const cachedBiography = originalBiography ? getCachedPersonBiographyTranslation(cacheEntry, originalBiography) : "";

    if (cachedName) {
        data.name = buildPersonNameDisplay(originalName, cachedName);
        nextCacheEntry.name = {
            sourceTextHash: commonUtils.computeStringHash(originalName),
            translatedText: cachedName,
            source: cachedNameEntry?.source,
        };
    }

    if (cachedBiography) {
        data.biography = cachedBiography;
        nextCacheEntry.biography = {
            sourceTextHash: commonUtils.computeStringHash(originalBiography),
            translatedText: cachedBiography,
        };
    }

    const shouldFetchTmdbName =
        originalName && commonUtils.isNonNullish(data?.ids?.tmdb) && cachedNameEntry?.source !== PEOPLE_NAME_SOURCE.TMDB && !getValidPersonNameNotFoundEntry(cacheEntry);
    const namePromise = shouldFetchTmdbName ? fetchTmdbPerson(data.ids.tmdb) : null;
    let hasTranslatedName = !!cachedName;
    if (namePromise) {
        try {
            const translatedName = String((await namePromise)?.name ?? "").trim();
            if (translatedName && commonUtils.containsChineseCharacter(translatedName)) {
                data.name = buildPersonNameDisplay(originalName, translatedName);
                nextCacheEntry.name = {
                    sourceTextHash: commonUtils.computeStringHash(originalName),
                    translatedText: translatedName,
                    source: PEOPLE_NAME_SOURCE.TMDB,
                };
                biographyContextName = translatedName;
                hasTranslatedName = true;
            } else {
                // TMDB 查询完成但无中文名：写 7 天负缓存（本地 + 远端）
                cacheChanged = applyPersonNameNotFoundCache(cache, personId) || cacheChanged;
            }
        } catch (error) {
            context.env.log(`Trakt people name translation failed for ${personId}: ${error}`);
        }
    }

    const googleTranslationTargets = [];
    const hasMatchingTmdbName = !!getCachedTmdbPersonNameTranslation(cacheEntry, originalName);
    const shouldFetchGoogleName = context.argument.googleTranslationEnabled && originalName && !hasTranslatedName && !hasMatchingTmdbName;
    const shouldFetchGoogleBiography = context.argument.googleTranslationEnabled && originalBiography && !cachedBiography;
    if (shouldFetchGoogleName) {
        googleTranslationTargets.push({ field: "name", sourceText: originalName });
    }
    if (shouldFetchGoogleBiography) {
        googleTranslationTargets.push({
            field: "biography",
            sourceText: buildBiographyGoogleSourceText(originalBiography, originalName, biographyContextName),
        });
    }
    const googlePromise =
        googleTranslationTargets.length > 0
            ? translateTextsWithGoogle(
                  googleTranslationTargets.map((target) => target.sourceText),
                  "en",
              )
            : null;

    if (googlePromise) {
        try {
            const googleResult = await googlePromise;
            const googleTranslations = commonUtils.ensureArray(googleResult);
            googleTranslationTargets.forEach((target, index) => {
                if (target.field === "name") {
                    const translatedName = String(googleTranslations[index] ?? "").trim();
                    if (!cachedName && !hasTranslatedName && translatedName && commonUtils.containsChineseCharacter(translatedName)) {
                        data.name = buildPersonNameDisplay(originalName, translatedName);
                        nextCacheEntry.name = {
                            sourceTextHash: commonUtils.computeStringHash(originalName),
                            translatedText: translatedName,
                            source: PEOPLE_NAME_SOURCE.GOOGLE,
                        };
                    }
                    return;
                }

                if (target.field === "biography") {
                    const translatedBiography = removeBiographyGoogleContext(googleTranslations[index]);
                    if (!cachedBiography && translatedBiography) {
                        data.biography = translatedBiography;
                        nextCacheEntry.biography = {
                            sourceTextHash: commonUtils.computeStringHash(originalBiography),
                            translatedText: translatedBiography,
                        };
                    }
                }
            });
        } catch (error) {
            context.env.log(`Trakt people Google translation failed for ${personId}: ${error}`);
        }
    }

    const nextCacheChanged = Object.keys(nextCacheEntry).length > 0 && setPeopleTranslationCacheEntry(cache, personId, nextCacheEntry, true);
    if (cacheChanged || nextCacheChanged) {
        cacheUtils.savePeopleTranslationCache(context.env, cache);
    }
    flushPeopleNameBackendWrites();

    return { type: "respond", body: JSON.stringify(data) };
}

export { handleMediaPeopleList, handlePeopleDetail, handlePeopleSearchList, handlePersonMediaCreditsList };
