import * as tmdbClientModule from "../outbound/tmdb-client.mjs";
import * as mediaTypes from "../shared/media-types.mjs";
import * as mediaTranslationHelper from "../shared/trakt-translation-helper.mjs";
import * as translationEngine from "../shared/translation-engine.mjs";
import * as cacheUtils from "../utils/cache.mjs";
import * as commonUtils from "../utils/common.mjs";

import { applyDoubanCharacterTranslations, collectDoubanCreditsForPeopleTarget, normalizeVoiceSuffixInCast } from "./people-douban-credits.mjs";
import { resolvePeopleListTmdbId } from "./people-link-cache.mjs";
import {
    applyPersonNameNotFoundCache,
    buildPersonNameDisplay,
    flushPeopleNameBackendWrites,
    getCachedPersonBiographyTranslation,
    getCachedPersonNameTranslation,
    getCachedTmdbPersonNameTranslation,
    getPeopleTranslationCacheEntry,
    getValidPersonNameCacheEntry,
    getValidPersonNameNotFoundEntry,
    hydratePeopleNamesFromBackend,
    PEOPLE_NAME_SOURCE,
    setPeopleTranslationCacheEntry,
} from "./people-name-cache.mjs";
import {
    applyPeopleCollectionCachedTranslations,
    applyPeopleCollectionGoogleBiographyTranslations,
    applyPeopleCollectionGoogleNameTranslations,
    applyPeopleListCachedNameTranslations,
    applyPeopleListCastNameTranslations,
    applyPeopleListGoogleNameTranslations,
    buildBiographyGoogleSourceText,
    buildTmdbCastNameMap,
    collectPeopleCollectionMissingTmdbNameIds,
    collectPeopleListGoogleNameTranslationTargets,
    collectPeopleListMissingTmdbNameIds,
    removeBiographyGoogleContext,
} from "./people-translation-apply.mjs";

function fetchTmdbCredits(mediaType, tmdbId) {
    return tmdbClientModule.fetchCredits(mediaType, tmdbId);
}

function fetchTmdbPerson(tmdbPersonId) {
    return tmdbClientModule.fetchPerson(tmdbPersonId);
}

function translateTextsWithGoogle(texts, sourceLanguage) {
    // 引擎选择统一收敛在 shared/translation-engine.mjs，缺省时回退到脚本参数；google 失败自动回退 DeepLX。
    return translationEngine.selectTranslateTextsWithFallback(globalThis.$ctx?.argument?.translationEngine)(texts, sourceLanguage);
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

    match = normalizedPath.match(/^shows\/(\d+)\/seasons\/(\d+)\/people$/);
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

function buildPeopleListTmdbMediaType(target) {
    if (!target) {
        return null;
    }

    return target.mediaType === mediaTypes.MEDIA_TYPE.MOVIE ? mediaTypes.MEDIA_TYPE.MOVIE : mediaTypes.MEDIA_TYPE.SHOW;
}

async function handleMediaPeopleList() {
    const context = globalThis.$ctx;
    const data = commonUtils.parseJsonBody(context.responseBody);
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
        const googleTargets = translationEngine.isTranslationEnabled(context.argument.translationEngine) ? collectPeopleListGoogleNameTranslationTargets(data, cache) : [];
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
    const data = commonUtils.parseJsonBody(globalThis.$ctx.responseBody);
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
    const data = commonUtils.parseJsonBody(context.responseBody);
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
        const nameTargets = translationEngine.isTranslationEnabled(context.argument.translationEngine) ? cachedResult.nameTargets : [];
        const biographyTargets = translationEngine.isTranslationEnabled(context.argument.translationEngine) ? cachedResult.biographyTargets : [];
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
    const data = commonUtils.parseJsonBody(context.responseBody);
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
    const shouldFetchGoogleName = translationEngine.isTranslationEnabled(context.argument.translationEngine) && originalName && !hasTranslatedName && !hasMatchingTmdbName;
    const shouldFetchGoogleBiography = translationEngine.isTranslationEnabled(context.argument.translationEngine) && originalBiography && !cachedBiography;
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
