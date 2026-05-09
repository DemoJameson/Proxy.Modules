import * as googleTranslateClient from "../outbound/google-translate-client.mjs";
import * as tmdbClientModule from "../outbound/tmdb-client.mjs";
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
const BIOGRAPHY_CONTEXT_SEPARATOR = "：";

function ensurePeopleMediaIdsCacheEntry(linkCache, mediaType, traktId) {
    return traktLinkIds.ensureMediaIdsCacheEntry(
        (requestMediaType, requestTraktId) => mediaTranslationHelper.fetchMediaDetail(requestMediaType, requestTraktId),
        (cache) => cacheUtils.saveLinkIdsCache(globalThis.$ctx.env, cache),
        linkCache,
        mediaType,
        traktId,
    );
}

function fetchTmdbCredits(mediaType, tmdbId) {
    return tmdbClientModule.fetchCredits(mediaType, tmdbId);
}

function fetchTmdbPerson(tmdbPersonId) {
    return tmdbClientModule.fetchPerson(tmdbPersonId);
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

function buildBiographyGoogleSourceText(originalBiography, contextName) {
    const biography = String(originalBiography ?? "").trim();
    const name = String(contextName ?? "").trim();
    return biography && name ? `${name}${BIOGRAPHY_CONTEXT_SEPARATOR}${biography}` : biography;
}

function removeBiographyGoogleContext(translatedBiography, contextName) {
    const biography = String(translatedBiography ?? "").trim();
    const name = String(contextName ?? "").trim();
    if (!biography || !name) {
        return biography;
    }

    if (!biography.startsWith(name)) {
        return biography;
    }

    return biography
        .slice(name.length)
        .replace(/^\s*[：:，,。.]?\s*/, "")
        .trim();
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
                biographyTargets.push({ person, originalBiography, personKeys, contextName });
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
            const contextName = String(target?.contextName ?? "").trim();
            return {
                sourceLanguage: "en",
                sourceText: buildBiographyGoogleSourceText(originalBiography, contextName),
                shouldAcceptTranslation(translatedBiography) {
                    return commonUtils.isPlainObject(person) && originalBiography && removeBiographyGoogleContext(translatedBiography, contextName);
                },
                setCachedTranslation(translatedBiography) {
                    const normalizedBiography = removeBiographyGoogleContext(translatedBiography, contextName);
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
                    const normalizedBiography = removeBiographyGoogleContext(translatedBiography, contextName);
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
        if (!cachedResult.hasMissing) {
            return { type: "respond", body: JSON.stringify(data) };
        }

        const googleTargets = context.argument.googleTranslationEnabled ? collectPeopleListGoogleNameTranslationTargets(data, cache) : [];
        const googlePromise =
            googleTargets.length > 0
                ? translateTextsWithGoogle(
                      googleTargets.map((item) => item.originalName),
                      "en",
                  )
                : Promise.resolve([]);
        const tmdbPromise = (async () => {
            const linkCache = cacheUtils.loadLinkIdsCache(context.env);
            const tmdbId = await resolvePeopleListTmdbId(target, linkCache);
            const tmdbMediaType = buildPeopleListTmdbMediaType(target);
            if (commonUtils.isNullish(tmdbId) || !tmdbMediaType) {
                return null;
            }

            return fetchTmdbCredits(tmdbMediaType, tmdbId);
        })();

        const [tmdbResult, googleResult] = await Promise.allSettled([tmdbPromise, googlePromise]);
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
    const biographyContextName = originalName ? getCachedTmdbPersonNameTranslation(cacheEntry, originalName) : "";
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
    const googleTranslationTargets = [];
    const hasMatchingTmdbName = !!getCachedTmdbPersonNameTranslation(cacheEntry, originalName);
    const shouldFetchGoogleName = context.argument.googleTranslationEnabled && originalName && !cachedName && !hasMatchingTmdbName;
    const shouldFetchGoogleBiography = context.argument.googleTranslationEnabled && originalBiography && !cachedBiography;
    if (shouldFetchGoogleName) {
        googleTranslationTargets.push({ field: "name", sourceText: originalName });
    }
    if (shouldFetchGoogleBiography) {
        googleTranslationTargets.push({
            field: "biography",
            sourceText: buildBiographyGoogleSourceText(originalBiography, biographyContextName),
        });
    }
    const googlePromise =
        googleTranslationTargets.length > 0
            ? translateTextsWithGoogle(
                  googleTranslationTargets.map((target) => target.sourceText),
                  "en",
              )
            : null;

    const [nameResult, googleResult] = await Promise.allSettled([namePromise ?? Promise.resolve(null), googlePromise ?? Promise.resolve(null)]);

    let hasTranslatedName = !!cachedName;
    if (namePromise) {
        if (nameResult.status === "fulfilled") {
            const translatedName = String(nameResult.value?.name ?? "").trim();
            if (translatedName && commonUtils.containsChineseCharacter(translatedName)) {
                data.name = buildPersonNameDisplay(originalName, translatedName);
                nextCacheEntry.name = {
                    sourceTextHash: commonUtils.computeStringHash(originalName),
                    translatedText: translatedName,
                    source: PEOPLE_NAME_SOURCE.TMDB,
                };
                hasTranslatedName = true;
            }
        } else {
            context.env.log(`Trakt people name translation failed for ${personId}: ${nameResult.reason}`);
        }
    }

    if (googlePromise) {
        if (googleResult.status === "fulfilled") {
            const googleTranslations = commonUtils.ensureArray(googleResult.value);
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
                    const translatedBiography = removeBiographyGoogleContext(googleTranslations[index], biographyContextName);
                    if (!cachedBiography && translatedBiography) {
                        data.biography = translatedBiography;
                        nextCacheEntry.biography = {
                            sourceTextHash: commonUtils.computeStringHash(originalBiography),
                            translatedText: translatedBiography,
                        };
                    }
                }
            });
        } else {
            context.env.log(`Trakt people Google translation failed for ${personId}: ${googleResult.reason}`);
        }
    }

    if (Object.keys(nextCacheEntry).length > 0 && setPeopleTranslationCacheEntry(cache, personId, nextCacheEntry)) {
        cacheUtils.savePeopleTranslationCache(context.env, cache);
    }

    return { type: "respond", body: JSON.stringify(data) };
}

export { handleMediaPeopleList, handlePeopleDetail, handlePeopleSearchList, handlePersonMediaCreditsList };
