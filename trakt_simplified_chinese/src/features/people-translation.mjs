import * as doubanClientModule from "../outbound/douban-client.mjs";
import * as googleTranslateClient from "../outbound/google-translate-client.mjs";
import * as tmdbClientModule from "../outbound/tmdb-client.mjs";
import * as traktApiClientModule from "../outbound/trakt-api-client.mjs";
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
const PEOPLE_LIST_ORIGINAL_NAME_KEY = "__traktOriginalName";
const DOUBAN_CHARACTER_LANGUAGES = new Set(["zh", "ja", "ko"]);
const DOUBAN_SEARCH_TARGET_TYPE = {
    MOVIE: "movie",
    TV: "tv",
};
const TRAKT_VOICE_CHARACTER_PATTERN = /(?:\((?:voice|voix|voz|声|配音)\)|（(?:voice|voix|voz|声|配音)）)/i;
const INVALID_DOUBAN_CHARACTER_VALUES = new Set(["导演", "演员", "配音", "制片人", "制片", "编剧", "摄影", "美术", "剪辑", "音乐", "副导演", "动作指导", "视觉特效"]);

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
    return buildPersonNameCacheEntry(entry?.name);
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

function setPeopleTranslationCacheEntry(cache, personId, payload) {
    if (!cache || commonUtils.isNullish(personId) || !commonUtils.isPlainObject(payload)) {
        return false;
    }

    const key = String(personId);
    const currentEntry = getPeopleTranslationCacheEntry(cache, key);
    const nextEntry = commonUtils.isPlainObject(currentEntry) ? { ...currentEntry } : {};

    if (commonUtils.isPlainObject(payload.name)) {
        const nextNameEntry = buildPersonNameCacheEntry(payload.name);
        const currentNameEntry = getValidPersonNameCacheEntry(currentEntry);
        if (nextNameEntry && shouldUpdatePersonNameCache(currentNameEntry, nextNameEntry)) {
            nextEntry.name = nextNameEntry;
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

function normalizeDoubanCacheKey(...parts) {
    return parts.map((part) => String(part ?? "").trim()).join(":");
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

function getDoubanSearchCacheEntry(cache, query, targetType) {
    const entry = cache?.search?.[normalizeDoubanCacheKey(targetType, query)];
    return commonUtils.isPlainObject(entry) ? entry : null;
}

function setDoubanSearchCacheEntry(cache, query, targetType, subject) {
    const id = String(subject?.id ?? "").trim();
    const normalizedTargetType = String(subject?.targetType ?? targetType ?? "")
        .trim()
        .toLowerCase();
    if (!id || !normalizedTargetType) {
        return false;
    }

    cache.search[normalizeDoubanCacheKey(targetType, query)] = {
        id,
        targetType: normalizedTargetType,
    };
    return true;
}

async function resolveDoubanSubject(cache, query, targetType) {
    const normalizedQuery = String(query ?? "").trim();
    const normalizedTargetType = String(targetType ?? "")
        .trim()
        .toLowerCase();
    if (!normalizedQuery || !normalizedTargetType) {
        return { subject: null, changed: false };
    }

    const cached = getDoubanSearchCacheEntry(cache, normalizedQuery, normalizedTargetType);
    if (cached) {
        return { subject: cached, changed: false };
    }

    const subject = await fetchDoubanSubject(normalizedQuery, normalizedTargetType);
    const changed = setDoubanSearchCacheEntry(cache, normalizedQuery, normalizedTargetType, subject);
    return { subject, changed };
}

async function getDoubanCredits(cache, doubanId) {
    const key = String(doubanId ?? "").trim();
    if (!key) {
        return { credits: {}, changed: false };
    }

    const cached = cache?.credits?.[key];
    if (commonUtils.isPlainObject(cached)) {
        return { credits: cached, changed: false };
    }

    const payload = await fetchDoubanCreditsStats(key);
    const credits = normalizeDoubanCreditsPayload(payload);
    if (Object.keys(credits).length === 0) {
        return { credits: {}, changed: false };
    }

    cache.credits[key] = credits;
    return { credits, changed: true };
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

async function getDoubanSeasonIds(cache, doubanId, { allowFetch = true } = {}) {
    const key = String(doubanId ?? "").trim();
    if (!key) {
        return { ids: [], changed: false };
    }

    const cached = cache?.seasons?.[key];
    if (commonUtils.isPlainObject(cached)) {
        return { ids: commonUtils.ensureArray(cached.ids), changed: false };
    }

    if (!allowFetch) {
        return { ids: [], changed: false };
    }

    const payload = await fetchDoubanSeasons(key);
    const ids = normalizeDoubanSeasonIds(payload);
    if (ids.length === 0) {
        return { ids: [], changed: false };
    }

    cache.seasons[key] = { ids };
    return { ids, changed: true };
}

function inferEpisodeDoubanIdFromCachedSeasons(cache, showDoubanId, seasonNumber) {
    const normalizedSeasonNumber = Number(seasonNumber);
    const normalizedShowDoubanId = String(showDoubanId ?? "").trim();
    if (!normalizedShowDoubanId || !Number.isFinite(normalizedSeasonNumber) || normalizedSeasonNumber < 1) {
        return "";
    }

    if (normalizedSeasonNumber === 1) {
        return normalizedShowDoubanId;
    }

    const cached = cache?.seasons?.[normalizedShowDoubanId];
    const seasonIds = commonUtils.ensureArray(cached?.ids);
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

        if (cachedName) {
            if (cachedName !== originalName) {
                person.name = cachedName;
                changed = true;
            }
            if (hasUpgradeableGoogleCache) {
                hasMissing = true;
            }
            return;
        }

        if (commonUtils.isNonNullish(person?.ids?.tmdb)) {
            hasMissing = true;
        }
    });

    return { changed, hasMissing };
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

        getPersonTranslationCacheKeys(person).forEach((personKey) => {
            changed =
                setPeopleTranslationCacheEntry(cache, personKey, {
                    name: {
                        sourceTextHash: commonUtils.computeStringHash(originalName),
                        translatedText: translatedName,
                        source: PEOPLE_NAME_SOURCE.TMDB,
                    },
                }) || changed;
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
            setPeopleTranslationCacheEntry(cache, personKey, {
                name: {
                    sourceTextHash: commonUtils.computeStringHash(originalName),
                    translatedText: translatedName,
                    source: PEOPLE_NAME_SOURCE.GOOGLE,
                },
            });
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
                            setPeopleTranslationCacheEntry(cache, personKey, {
                                name: {
                                    sourceTextHash: commonUtils.computeStringHash(originalName),
                                    translatedText: translatedName,
                                    source: PEOPLE_NAME_SOURCE.GOOGLE,
                                },
                            }) || changed;
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

async function resolveDoubanIdsForPeopleTarget(target, linkCache, doubanCache) {
    const mediaEntry = await resolvePeopleListMediaEntry(target, linkCache);
    if (!mediaEntry || !shouldTranslateCharactersForLanguage(mediaEntry.language)) {
        return { ids: [], changed: false };
    }

    let changed = false;
    const imdbId = String(mediaEntry?.ids?.imdb ?? "").trim();
    const targetType = target.mediaType === mediaTypes.MEDIA_TYPE.MOVIE ? DOUBAN_SEARCH_TARGET_TYPE.MOVIE : DOUBAN_SEARCH_TARGET_TYPE.TV;
    const mainSubjectResult = await resolveDoubanSubject(doubanCache, imdbId, targetType);
    changed = mainSubjectResult.changed || changed;
    const mainDoubanId = String(mainSubjectResult.subject?.id ?? "").trim();
    // Episode season inference intentionally starts from the show Douban ID; if the show subject cannot be resolved, there is no cached seasons key to infer from.
    if (!mainDoubanId) {
        return { ids: [], changed };
    }

    if (target.mediaType === mediaTypes.MEDIA_TYPE.MOVIE) {
        return { ids: [mainDoubanId], changed };
    }

    if (target.mediaType === mediaTypes.MEDIA_TYPE.SHOW) {
        let seasonResult = { ids: [], changed: false };
        try {
            seasonResult = await getDoubanSeasonIds(doubanCache, mainDoubanId);
        } catch (error) {
            globalThis.$ctx.env.log(`Trakt media people Douban seasons lookup failed: ${error}`);
        }
        changed = seasonResult.changed || changed;
        return {
            ids: [mainDoubanId].concat(seasonResult.ids).filter((id, index, array) => id && array.indexOf(id) === index),
            changed,
        };
    }

    const inferredDoubanId = inferEpisodeDoubanIdFromCachedSeasons(doubanCache, mainDoubanId, target.seasonNumber);
    if (inferredDoubanId) {
        return { ids: [inferredDoubanId], changed };
    }

    const firstEpisodeEntry = await ensureFirstEpisodeIdsCacheEntry(linkCache, target);
    const firstEpisodeImdbId = String(firstEpisodeEntry?.ids?.imdb ?? "").trim();
    const firstEpisodeSubjectResult = await resolveDoubanSubject(doubanCache, firstEpisodeImdbId, DOUBAN_SEARCH_TARGET_TYPE.TV);
    changed = firstEpisodeSubjectResult.changed || changed;
    const firstEpisodeDoubanId = String(firstEpisodeSubjectResult.subject?.id ?? "").trim();
    return { ids: firstEpisodeDoubanId ? [firstEpisodeDoubanId] : [], changed };
}

async function collectDoubanCreditsForPeopleTarget(target, linkCache, doubanCache) {
    const doubanIdsResult = await resolveDoubanIdsForPeopleTarget(target, linkCache, doubanCache);
    let changed = doubanIdsResult.changed;
    let credits = {};
    for (const doubanId of doubanIdsResult.ids) {
        const creditsResult = await getDoubanCredits(doubanCache, doubanId);
        changed = creditsResult.changed || changed;
        credits = mergeDoubanCredits(credits, creditsResult.credits);
    }
    return { credits, changed };
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
        let changed = false;

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

        if (changed) {
            cacheUtils.savePeopleTranslationCache(context.env, cache);
        }
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
    const cachedResult = applyPeopleCollectionCachedTranslations(data, cache);
    let changed = cachedResult.changed;

    try {
        const nameTargets = context.argument.googleTranslationEnabled ? cachedResult.nameTargets : [];
        const biographyTargets = context.argument.googleTranslationEnabled ? cachedResult.biographyTargets : [];
        if (nameTargets.length === 0 && biographyTargets.length === 0) {
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
        return { type: "respond", body: JSON.stringify(data) };
    } catch (error) {
        context.env.log(`Trakt people collection translation failed: ${error}`);
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

    const shouldFetchTmdbName = originalName && commonUtils.isNonNullish(data?.ids?.tmdb) && cachedNameEntry?.source !== PEOPLE_NAME_SOURCE.TMDB;
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

    if (Object.keys(nextCacheEntry).length > 0 && setPeopleTranslationCacheEntry(cache, personId, nextCacheEntry)) {
        cacheUtils.savePeopleTranslationCache(context.env, cache);
    }

    return { type: "respond", body: JSON.stringify(data) };
}

export { handleMediaPeopleList, handlePeopleDetail, handlePeopleSearchList, handlePersonMediaCreditsList };
