import * as googleTranslationContext from "../shared/google-translation-context.mjs";
import * as googleTranslationPipeline from "../shared/google-translation-pipeline.mjs";
import * as commonUtils from "../utils/common.mjs";

import {
    applyPersonNameNotFoundCache,
    getCachedPersonBiographyTranslation,
    getCachedPersonNameTranslation,
    getCachedTmdbPersonNameTranslation,
    getPeopleListOriginalName,
    getPeopleTranslationCacheEntry,
    getPersonTranslationCacheKeys,
    getValidPersonNameCacheEntry,
    getValidPersonNameNotFoundEntry,
    PEOPLE_NAME_SOURCE,
    rememberPeopleListOriginalName,
    setPeopleTranslationCacheEntry,
} from "./people-name-cache.mjs";

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

export {
    applyPeopleCollectionCachedTranslations,
    applyPeopleCollectionGoogleBiographyTranslations,
    applyPeopleCollectionGoogleNameTranslations,
    applyPeopleListCachedNameTranslations,
    applyPeopleListCastNameTranslations,
    applyPeopleListGoogleNameTranslations,
    buildBiographyGoogleContextLine,
    buildBiographyGoogleSourceText,
    buildTmdbCastNameMap,
    collectPeopleCollectionItems,
    collectPeopleCollectionMissingTmdbNameIds,
    collectPeopleListGoogleNameTranslationTargets,
    collectPeopleListMissingTmdbNameIds,
    collectPeopleListPersonItems,
    removeBiographyGoogleContext,
};
