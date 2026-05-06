import * as commonUtils from "../utils/common.mjs";

import * as chineseScriptConverter from "./chinese-script-converter.mjs";

const TRANSLATION_FIELDS = ["title", "overview", "tagline"];
const TRANSLATION_FALLBACK_REGIONS = ["sg", "tw", "hk"];
const EPISODE_PLACEHOLDER_TITLE_RE = /^\s*episode\s+0*(\d+)\s*$/i;

const CACHE_STATUS = {
    FOUND: 1,
    PARTIAL_FOUND: 2,
    NOT_FOUND: 3,
};

function isEmptyTranslationValue(value) {
    return value === undefined || value === null || value === "";
}

function extractEpisodePlaceholderNumber(value) {
    const match = String(value ?? "").match(EPISODE_PLACEHOLDER_TITLE_RE);
    if (!match) {
        return null;
    }
    const episodeNumber = Number(match[1]);
    return Number.isFinite(episodeNumber) ? episodeNumber : null;
}

function sortTranslations(arr, preferredLanguage) {
    const match = String(preferredLanguage ?? "").match(/([a-zA-Z]{2})(?:-([a-zA-Z]{2}))?/);
    const preference = {
        lang: match?.[1]?.toLowerCase() ?? null,
        region: match?.[2]?.toLowerCase() ?? null,
    };

    if (!preference.lang) {
        return arr;
    }

    arr.sort((a, b) => {
        const getScore = (item) => {
            const itemLang = item?.language?.toLowerCase() ?? null;
            const itemRegion = item?.country?.toLowerCase() ?? null;

            if (itemLang !== preference.lang) {
                return 0;
            }
            if (preference.region && itemRegion === preference.region) {
                return 2;
            }
            return 1;
        };

        return getScore(b) - getScore(a);
    });

    return arr;
}

function hasUsefulTranslation(translation) {
    return !!(translation && (!isEmptyTranslationValue(translation.title) || !isEmptyTranslationValue(translation.overview) || !isEmptyTranslationValue(translation.tagline)));
}

function normalizeTranslationPayload(translation) {
    if (!translation || typeof translation !== "object") {
        return null;
    }

    const normalized = {
        title: translation.title ?? null,
        overview: translation.overview ?? null,
        tagline: translation.tagline ?? null,
    };

    return hasUsefulTranslation(normalized) ? normalized : null;
}

function findTranslationByRegion(items, region) {
    return (
        items.find((item) => {
            return String(item?.language ?? "").toLowerCase() === "zh" && String(item?.country ?? "").toLowerCase() === region;
        }) ?? null
    );
}

function isChineseTranslation(item) {
    return String(item?.language ?? "").toLowerCase() === "zh";
}

function copyFallbackFieldToCnTranslation(cnTranslation, items, field) {
    if (!isEmptyTranslationValue(cnTranslation[field])) {
        return;
    }

    for (let i = 0; i < TRANSLATION_FALLBACK_REGIONS.length; i += 1) {
        const region = TRANSLATION_FALLBACK_REGIONS[i];
        const fallback = findTranslationByRegion(items, region);
        if (fallback && !isEmptyTranslationValue(fallback[field])) {
            cnTranslation[field] = chineseScriptConverter.convertRegionalTraditionalChineseToSimplified(fallback[field], region);
            return;
        }
    }
}

function normalizeTranslations(items, options = {}) {
    if (commonUtils.isNotArray(items)) {
        items = [];
    }

    let cnTranslation = findTranslationByRegion(items, "cn");
    const originalCnHasTitle = !!(cnTranslation && !isEmptyTranslationValue(cnTranslation.title));
    const hasAnyChineseField = items.some((item) => {
        return isChineseTranslation(item) && TRANSLATION_FIELDS.some((field) => !isEmptyTranslationValue(item[field]));
    });

    if (!cnTranslation) {
        cnTranslation = {
            language: "zh",
            country: "cn",
        };
        items.unshift(cnTranslation);
    }

    TRANSLATION_FIELDS.forEach((field) => {
        copyFallbackFieldToCnTranslation(cnTranslation, items, field);
    });

    cnTranslation.status = originalCnHasTitle ? CACHE_STATUS.FOUND : hasAnyChineseField ? CACHE_STATUS.PARTIAL_FOUND : CACHE_STATUS.NOT_FOUND;

    return items;
}

function pickCnTranslation(items) {
    if (commonUtils.isNotArray(items) || items.length === 0) {
        return null;
    }

    return (
        items.find((item) => {
            return String(item?.language ?? "").toLowerCase() === "zh" && String(item?.country ?? "").toLowerCase() === "cn";
        }) ?? null
    );
}

function extractNormalizedTranslation(items) {
    const cnTranslation = pickCnTranslation(items);
    return {
        status: cnTranslation?.status ?? CACHE_STATUS.NOT_FOUND,
        translation: normalizeTranslationPayload(cnTranslation),
    };
}

function areTranslationsEqual(left, right) {
    const normalizedLeft = normalizeTranslationPayload(left);
    const normalizedRight = normalizeTranslationPayload(right);

    if (!normalizedLeft && !normalizedRight) {
        return true;
    }

    if (!normalizedLeft || !normalizedRight) {
        return false;
    }

    return normalizedLeft.title === normalizedRight.title && normalizedLeft.overview === normalizedRight.overview && normalizedLeft.tagline === normalizedRight.tagline;
}

export {
    CACHE_STATUS,
    TRANSLATION_FALLBACK_REGIONS,
    TRANSLATION_FIELDS,
    areTranslationsEqual,
    extractNormalizedTranslation,
    findTranslationByRegion,
    hasUsefulTranslation,
    extractEpisodePlaceholderNumber,
    isChineseTranslation,
    isEmptyTranslationValue,
    normalizeTranslationPayload,
    normalizeTranslations,
    pickCnTranslation,
    sortTranslations,
};
