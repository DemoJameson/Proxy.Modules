import * as googleTranslationContext from "../shared/google-translation-context.mjs";
import * as googleTranslationPipeline from "../shared/google-translation-pipeline.mjs";
import * as mediaTypes from "../shared/media-types.mjs";
import * as cacheUtils from "../utils/cache.mjs";
import * as commonUtils from "../utils/common.mjs";

function buildSentimentCacheKey(mediaType, traktId) {
    if (!traktId || (mediaType !== mediaTypes.MEDIA_TYPE.SHOW && mediaType !== mediaTypes.MEDIA_TYPE.MOVIE)) {
        return "";
    }

    return `${mediaType}:${traktId}`;
}

function resolveSentimentRequestTarget() {
    const normalizedPath = globalThis.$ctx.url.shortPathname;
    let match = normalizedPath.match(/^(?:v3\/)?media\/(movie|show)\/(\d+)\/info\/(\d+)\/version\/(\d+)$/i);
    if (match) {
        return {
            mediaType: String(match[1]).toLowerCase() === "show" ? mediaTypes.MEDIA_TYPE.SHOW : mediaTypes.MEDIA_TYPE.MOVIE,
            traktId: match[2],
            infoId: match[3],
            version: match[4],
        };
    }

    match = normalizedPath.match(/^(shows|movies)\/(\d+)\/sentiments$/i);
    if (match) {
        return {
            mediaType: String(match[1]).toLowerCase() === "shows" ? mediaTypes.MEDIA_TYPE.SHOW : mediaTypes.MEDIA_TYPE.MOVIE,
            traktId: match[2],
            infoId: null,
            version: null,
        };
    }

    return null;
}

function normalizeSentimentAspectItem(item) {
    const normalized = commonUtils.ensureObject(item);
    return {
        ...normalized,
        theme: String(normalized.theme ?? ""),
    };
}

function normalizeSentimentGroupItem(item) {
    const normalized = commonUtils.ensureObject(item);
    return {
        ...normalized,
        sentiment: String(normalized.sentiment ?? ""),
        comment_ids: commonUtils.ensureArray(normalized.comment_ids),
    };
}

function normalizeSentimentInfoItem(item) {
    const normalized = commonUtils.ensureObject(item);
    return {
        ...normalized,
        text: String(normalized.text ?? ""),
    };
}

function cloneSentimentsPayload(payload) {
    const normalized = commonUtils.ensureObject(payload);
    return {
        ...normalized,
        aspect: {
            ...commonUtils.ensureObject(normalized.aspect),
            pros: commonUtils.ensureArray(normalized.aspect?.pros).map(normalizeSentimentAspectItem),
            cons: commonUtils.ensureArray(normalized.aspect?.cons).map(normalizeSentimentAspectItem),
        },
        good: commonUtils.ensureArray(normalized.good).map(normalizeSentimentGroupItem),
        bad: commonUtils.ensureArray(normalized.bad).map(normalizeSentimentGroupItem),
        summary: commonUtils.ensureArray(normalized.summary).map((item) => String(item ?? "")),
        text: String(normalized.text ?? ""),
        analysis: String(normalized.analysis ?? ""),
        highlight: String(normalized.highlight ?? ""),
        items: commonUtils.ensureArray(normalized.items).map(normalizeSentimentInfoItem),
    };
}

function buildSentimentTranslationPayload(payload) {
    const aspect = commonUtils.ensureObject(payload?.aspect);
    return {
        aspect: {
            pros: commonUtils.ensureArray(aspect.pros).map((item) => ({
                sourceTextHash: commonUtils.computeStringHash(item?.sourceTheme ?? item?.theme ?? ""),
                translatedText: String(item?.translatedTheme ?? item?.theme ?? ""),
            })),
            cons: commonUtils.ensureArray(aspect.cons).map((item) => ({
                sourceTextHash: commonUtils.computeStringHash(item?.sourceTheme ?? item?.theme ?? ""),
                translatedText: String(item?.translatedTheme ?? item?.theme ?? ""),
            })),
        },
        good: commonUtils.ensureArray(payload?.good).map((item) => ({
            sourceTextHash: commonUtils.computeStringHash(item?.sourceSentiment ?? item?.sentiment ?? ""),
            translatedText: String(item?.translatedSentiment ?? item?.sentiment ?? ""),
        })),
        bad: commonUtils.ensureArray(payload?.bad).map((item) => ({
            sourceTextHash: commonUtils.computeStringHash(item?.sourceSentiment ?? item?.sentiment ?? ""),
            translatedText: String(item?.translatedSentiment ?? item?.sentiment ?? ""),
        })),
        summary: commonUtils.ensureArray(payload?.summary).map((item) => ({
            sourceTextHash: commonUtils.computeStringHash(item?.sourceText ?? item?.text ?? item ?? ""),
            translatedText: String(item?.translatedText ?? item?.text ?? item ?? ""),
        })),
        analysis: {
            sourceTextHash: commonUtils.computeStringHash(payload?.sourceAnalysis ?? payload?.analysis ?? ""),
            translatedText: String(payload?.translatedAnalysis ?? payload?.analysis ?? ""),
        },
        highlight: {
            sourceTextHash: commonUtils.computeStringHash(payload?.sourceHighlight ?? payload?.highlight ?? ""),
            translatedText: String(payload?.translatedHighlight ?? payload?.highlight ?? ""),
        },
        items: commonUtils.ensureArray(payload?.items).map((item) => ({
            sourceTextHash: commonUtils.computeStringHash(item?.sourceText ?? item?.text ?? ""),
            translatedText: String(item?.translatedText ?? item?.text ?? ""),
        })),
        text: {
            sourceTextHash: commonUtils.computeStringHash(payload?.sourceText ?? payload?.text ?? ""),
            translatedText: String(payload?.translatedText ?? payload?.text ?? ""),
        },
    };
}

function applySentimentTranslationPayload(target, translation) {
    const payload = cloneSentimentsPayload(target);
    const translated = commonUtils.ensureObject(translation);
    const translatedAspect = commonUtils.ensureObject(translated.aspect);

    commonUtils.ensureArray(payload.aspect?.pros).forEach((item, index) => {
        const entry = commonUtils.ensureObject(commonUtils.ensureArray(translatedAspect.pros)[index]);
        const sourceTextHash = commonUtils.computeStringHash(item?.theme ?? "");
        const translatedText = String(entry.translatedText ?? "").trim();
        if (translatedText && String(entry.sourceTextHash ?? "") === sourceTextHash) {
            item.theme = translatedText;
        }
    });

    commonUtils.ensureArray(payload.aspect?.cons).forEach((item, index) => {
        const entry = commonUtils.ensureObject(commonUtils.ensureArray(translatedAspect.cons)[index]);
        const sourceTextHash = commonUtils.computeStringHash(item?.theme ?? "");
        const translatedText = String(entry.translatedText ?? "").trim();
        if (translatedText && String(entry.sourceTextHash ?? "") === sourceTextHash) {
            item.theme = translatedText;
        }
    });

    commonUtils.ensureArray(payload.summary).forEach((item, index) => {
        const entry = commonUtils.ensureObject(commonUtils.ensureArray(translated.summary)[index]);
        const sourceTextHash = commonUtils.computeStringHash(item ?? "");
        const translatedText = String(entry.translatedText ?? "").trim();
        if (translatedText && String(entry.sourceTextHash ?? "") === sourceTextHash) {
            payload.summary[index] = translatedText;
        }
    });

    const analysisTranslation = commonUtils.ensureObject(translated.analysis);
    const analysisSourceHash = commonUtils.computeStringHash(payload.analysis ?? "");
    const translatedAnalysis = String(analysisTranslation.translatedText ?? "").trim();
    if (translatedAnalysis && String(analysisTranslation.sourceTextHash ?? "") === analysisSourceHash) {
        payload.analysis = translatedAnalysis;
    }

    const highlightTranslation = commonUtils.ensureObject(translated.highlight);
    const highlightSourceHash = commonUtils.computeStringHash(payload.highlight ?? "");
    const translatedHighlight = String(highlightTranslation.translatedText ?? "").trim();
    if (translatedHighlight && String(highlightTranslation.sourceTextHash ?? "") === highlightSourceHash) {
        payload.highlight = translatedHighlight;
    }

    commonUtils.ensureArray(payload.items).forEach((item, index) => {
        const entry = commonUtils.ensureObject(commonUtils.ensureArray(translated.items)[index]);
        const sourceTextHash = commonUtils.computeStringHash(item?.text ?? "");
        const translatedText = String(entry.translatedText ?? "").trim();
        if (translatedText && String(entry.sourceTextHash ?? "") === sourceTextHash) {
            item.text = translatedText;
        }
    });

    const textTranslation = commonUtils.ensureObject(translated.text);
    const textSourceHash = commonUtils.computeStringHash(payload.text ?? "");
    const translatedText = String(textTranslation.translatedText ?? "").trim();
    if (translatedText && String(textTranslation.sourceTextHash ?? "") === textSourceHash) {
        payload.text = translatedText;
    }

    commonUtils.ensureArray(payload.good).forEach((item, index) => {
        const entry = commonUtils.ensureObject(commonUtils.ensureArray(translated.good)[index]);
        const sourceTextHash = commonUtils.computeStringHash(item?.sentiment ?? "");
        const translatedGroupText = String(entry.translatedText ?? "").trim();
        if (translatedGroupText && String(entry.sourceTextHash ?? "") === sourceTextHash) {
            item.sentiment = translatedGroupText;
        }
    });

    commonUtils.ensureArray(payload.bad).forEach((item, index) => {
        const entry = commonUtils.ensureObject(commonUtils.ensureArray(translated.bad)[index]);
        const sourceTextHash = commonUtils.computeStringHash(item?.sentiment ?? "");
        const translatedGroupText = String(entry.translatedText ?? "").trim();
        if (translatedGroupText && String(entry.sourceTextHash ?? "") === sourceTextHash) {
            item.sentiment = translatedGroupText;
        }
    });

    return payload;
}

function hasMatchingSentimentTranslationPayload(target, translation) {
    const payload = cloneSentimentsPayload(target);
    const translated = commonUtils.ensureObject(translation);
    const currentAspect = commonUtils.ensureObject(payload.aspect);
    const cachedAspect = commonUtils.ensureObject(translated.aspect);
    const aspectGroups = ["pros", "cons"];
    const aspectMatches = aspectGroups.every((group) => {
        const currentItems = commonUtils.ensureArray(currentAspect[group]);
        const cachedItems = commonUtils.ensureArray(cachedAspect[group]);
        if (currentItems.length !== cachedItems.length) {
            return false;
        }

        return currentItems.every((item, index) => {
            return commonUtils.computeStringHash(item?.theme ?? "") === String(cachedItems[index]?.sourceTextHash ?? "");
        });
    });
    if (!aspectMatches) {
        return false;
    }

    const goodItems = commonUtils.ensureArray(payload.good);
    const cachedGoodItems = commonUtils.ensureArray(translated.good);
    if (goodItems.length !== cachedGoodItems.length) {
        return false;
    }

    const goodMatches = goodItems.every((item, index) => {
        return commonUtils.computeStringHash(item?.sentiment ?? "") === String(cachedGoodItems[index]?.sourceTextHash ?? "");
    });
    if (!goodMatches) {
        return false;
    }

    const badItems = commonUtils.ensureArray(payload.bad);
    const cachedBadItems = commonUtils.ensureArray(translated.bad);
    if (badItems.length !== cachedBadItems.length) {
        return false;
    }

    const badMatches = badItems.every((item, index) => {
        return commonUtils.computeStringHash(item?.sentiment ?? "") === String(cachedBadItems[index]?.sourceTextHash ?? "");
    });
    if (!badMatches) {
        return false;
    }

    const currentSummary = commonUtils.ensureArray(payload.summary);
    const cachedSummary = commonUtils.ensureArray(translated.summary);
    if (currentSummary.length !== cachedSummary.length) {
        return false;
    }

    const summaryMatches = currentSummary.every((item, index) => {
        return commonUtils.computeStringHash(item ?? "") === String(cachedSummary[index]?.sourceTextHash ?? "");
    });
    if (!summaryMatches) {
        return false;
    }

    if (commonUtils.computeStringHash(payload.analysis ?? "") !== String(translated.analysis?.sourceTextHash ?? "")) {
        return false;
    }

    if (commonUtils.computeStringHash(payload.highlight ?? "") !== String(translated.highlight?.sourceTextHash ?? "")) {
        return false;
    }

    const currentItems = commonUtils.ensureArray(payload.items);
    const cachedItems = commonUtils.ensureArray(translated.items);
    if (currentItems.length !== cachedItems.length) {
        return false;
    }

    const itemsMatch = currentItems.every((item, index) => {
        return commonUtils.computeStringHash(item?.text ?? "") === String(cachedItems[index]?.sourceTextHash ?? "");
    });
    if (!itemsMatch) {
        return false;
    }

    return commonUtils.computeStringHash(payload.text ?? "") === String(translated.text?.sourceTextHash ?? "");
}

function getSentimentTranslationCacheEntry(cache, mediaType, traktId) {
    const cacheKey = buildSentimentCacheKey(mediaType, traktId);
    const entry = cacheKey ? cache[cacheKey] : null;
    return entry || null;
}

function buildSentimentGoogleContextLine(env, target) {
    const traktId = String(target?.traktId ?? "").trim();
    if (!traktId) {
        return "";
    }

    const linkEntry = commonUtils.ensureObject(cacheUtils.loadLinkIdsCache(env)[traktId]);
    const translationEntry = commonUtils.ensureObject(cacheUtils.loadCache(env)[buildSentimentCacheKey(target?.mediaType, traktId)]);
    return googleTranslationContext.buildContextLine(linkEntry.title, translationEntry.translation?.title);
}

function storeSentimentTranslationCacheEntry(cache, mediaType, traktId, payload) {
    const cacheKey = buildSentimentCacheKey(mediaType, traktId);
    if (!cacheKey) {
        return;
    }

    cache[cacheKey] = {
        translation: buildSentimentTranslationPayload(payload),
    };
}

function collectSentimentTranslationTargets(payload) {
    const translationTargets = [];

    commonUtils.ensureArray(payload.aspect?.pros).forEach((item) => {
        translationTargets.push({ target: item, field: "theme", text: String(item?.theme ?? "") });
    });
    commonUtils.ensureArray(payload.aspect?.cons).forEach((item) => {
        translationTargets.push({ target: item, field: "theme", text: String(item?.theme ?? "") });
    });
    commonUtils.ensureArray(payload.good).forEach((item) => {
        translationTargets.push({ target: item, field: "sentiment", text: String(item?.sentiment ?? "") });
    });
    commonUtils.ensureArray(payload.bad).forEach((item) => {
        translationTargets.push({ target: item, field: "sentiment", text: String(item?.sentiment ?? "") });
    });
    commonUtils.ensureArray(payload.summary).forEach((item, index) => {
        translationTargets.push({ target: payload.summary, field: index, text: String(item ?? ""), useContext: true });
    });
    translationTargets.push({ target: payload, field: "analysis", text: String(payload.analysis ?? ""), useContext: true });
    translationTargets.push({ target: payload, field: "highlight", text: String(payload.highlight ?? ""), useContext: true });
    commonUtils.ensureArray(payload.items).forEach((item) => {
        translationTargets.push({ target: item, field: "text", text: String(item?.text ?? ""), useContext: true });
    });
    translationTargets.push({ target: payload, field: "text", text: String(payload.text ?? ""), useContext: true });

    return translationTargets;
}

function buildTranslationMetadataFieldName(prefix, field) {
    const normalizedField = String(field ?? "");
    return `${prefix}${normalizedField.charAt(0).toUpperCase()}${normalizedField.slice(1)}`;
}

async function translateSentimentItems(items, options = {}) {
    const contextLine = String(options.contextLine ?? "").trim();
    const translationTargets = commonUtils.ensureArray(items).map((item) => {
        const sourceText = String(item?.text ?? "").trim();
        const useContext = !!item?.useContext && contextLine;
        return {
            sourceLanguage: "en",
            sourceText: useContext ? googleTranslationContext.buildSourceText(sourceText, contextLine) : sourceText,
            applyTranslation(translatedText) {
                item.sourceText = sourceText;
                item.translatedText = useContext ? googleTranslationContext.removeContextLine(translatedText) : translatedText;
                return true;
            },
        };
    });

    await googleTranslationPipeline.translateTextFieldTargets(translationTargets, {
        throwOnFailure: true,
    });
}

function applyTranslatedResponseValues(items) {
    commonUtils.ensureArray(items).forEach((item) => {
        if (String(item?.translatedText ?? "").trim()) {
            item.target[item.field] = String(item.translatedText);
        }
        delete item.sourceText;
        delete item.translatedText;
    });
}

function applyTranslatedCacheMetadata(items) {
    commonUtils.ensureArray(items).forEach((item) => {
        const translatedText = String(item?.translatedText ?? "").trim();
        if (!translatedText) {
            return;
        }

        if (commonUtils.isArray(item.target) && Number.isInteger(Number(item.field))) {
            item.target[Number(item.field)] = {
                sourceText: item.text,
                translatedText,
            };
            return;
        }

        item.target[buildTranslationMetadataFieldName("source", item.field)] = item.text;
        item.target[buildTranslationMetadataFieldName("translated", item.field)] = translatedText;
    });
}

async function handleSentiments() {
    const context = globalThis.$ctx;
    const data = JSON.parse(context.responseBody);
    if (!commonUtils.isPlainObject(data)) {
        return { type: "passThrough" };
    }

    const target = resolveSentimentRequestTarget();
    if (!target) {
        return { type: "passThrough" };
    }

    const cache = cacheUtils.loadSentimentTranslationCache(context.env);
    const cachedEntry = getSentimentTranslationCacheEntry(cache, target.mediaType, target.traktId);
    if (cachedEntry?.translation && hasMatchingSentimentTranslationPayload(data, cachedEntry.translation)) {
        return {
            type: "respond",
            body: JSON.stringify(applySentimentTranslationPayload(data, cachedEntry.translation)),
        };
    }

    if (!context.argument.googleTranslationEnabled) {
        return {
            type: "respond",
            body: JSON.stringify(data),
        };
    }

    const translatedData = cloneSentimentsPayload(data);
    const translationTargets = collectSentimentTranslationTargets(translatedData);
    const contextLine = buildSentimentGoogleContextLine(context.env, target);

    try {
        await translateSentimentItems(translationTargets, { contextLine });
        applyTranslatedResponseValues(translationTargets);

        const cachePayload = cloneSentimentsPayload(data);
        const cacheTargets = collectSentimentTranslationTargets(cachePayload);
        await translateSentimentItems(cacheTargets, { contextLine });
        applyTranslatedCacheMetadata(cacheTargets);

        storeSentimentTranslationCacheEntry(cache, target.mediaType, target.traktId, cachePayload);
        cacheUtils.saveSentimentTranslationCache(context.env, cache);
    } catch (error) {
        context.env.log(`Trakt sentiments translate failed: ${error}`);
    }

    return {
        type: "respond",
        body: JSON.stringify(translatedData),
    };
}

export { handleSentiments };
