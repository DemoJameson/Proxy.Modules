import * as doubanClientModule from "../outbound/douban-client.mjs";
import * as vercelBackendClientModule from "../outbound/vercel-backend-client.mjs";
import * as mediaTypes from "../shared/media-types.mjs";
import * as cacheUtils from "../utils/cache.mjs";
import * as commonUtils from "../utils/common.mjs";

import { ensureFirstEpisodeIdsCacheEntry, resolvePeopleListMediaEntry } from "./people-link-cache.mjs";

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

function fetchDoubanSubject(query, targetType) {
    return doubanClientModule.searchSubject(query, targetType);
}

function fetchDoubanCreditsStats(doubanId) {
    return doubanClientModule.fetchCreditsStats(doubanId);
}

function fetchDoubanSeasons(doubanId) {
    return doubanClientModule.fetchSeasons(doubanId);
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

export {
    applyDoubanCharacterTranslations,
    CREDIT_CACHE_TARGET_TYPE,
    collectDoubanCreditsForPeopleTarget,
    DOUBAN_CHARACTER_LANGUAGES,
    DOUBAN_SEARCH_TARGET_TYPE,
    deriveDoubanCacheKey,
    ensureDoubanCreditEntry,
    fetchDoubanCacheEntry,
    fetchDoubanCreditsStats,
    fetchDoubanSeasons,
    fetchDoubanSubject,
    flushDoubanBackendWrites,
    formatDoubanCharacterForCastItem,
    getCastItemCurrentCharacters,
    getDoubanCreditEntry,
    getDoubanSeasonIds,
    INVALID_DOUBAN_CHARACTER_VALUES,
    inferEpisodeDoubanIdFromCreditEntry,
    isDoubanActorItem,
    isTraktVoiceCastItem,
    mergeDoubanCredits,
    normalizeDoubanCreditsPayload,
    normalizeDoubanLanguage,
    normalizeDoubanName,
    normalizeDoubanSeasonIds,
    normalizeVoiceSuffixInCast,
    normalizeVoiceSuffixInCastItem,
    normalizeVoiceSuffixInCharacter,
    queueDoubanBackendWrite,
    resetDoubanBackendWriteQueue,
    resolveDoubanCacheTarget,
    resolveDoubanCreditsForIds,
    resolveDoubanSubject,
    shouldSkipDoubanCharacterReplacement,
    shouldTranslateCharactersForLanguage,
    splitDoubanCharacters,
    TRAKT_VOICE_CHARACTER_PATTERN,
    toCreditCacheTargetType,
    toDoubanSearchTargetType,
};
