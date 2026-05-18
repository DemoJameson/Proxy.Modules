import * as commonUtils from "../utils/common.mjs";

import * as chineseScriptConverter from "./chinese-script-converter.mjs";

const TRANSLATION_FIELDS = ["title", "overview", "tagline"];
const TRANSLATION_FALLBACK_REGIONS = ["sg", "tw", "hk"];
const EPISODE_PLACEHOLDER_TITLE_RE = /^\s*episode\s+0*(\d+)\s*$/i;
const OVERVIEW_FULL_WIDTH_SPACE_BREAK_RE = /\u3000{2,}/g;

const CACHE_STATUS = {
    FOUND: 1,
    PARTIAL_FOUND: 2,
    NOT_FOUND: 3,
};

function isEmptyTranslationValue(value) {
    return value === undefined || value === null || value === "";
}

function normalizeTranslationText(value) {
    if (value === undefined || value === null) {
        return null;
    }

    const normalized = String(value).trim();
    return normalized || null;
}

function normalizeTranslationFieldValue(field, value) {
    const normalized = normalizeTranslationText(value);
    if (normalized === null) {
        return null;
    }

    const simplified = chineseScriptConverter.convertTraditionalChineseToSimplified(normalized);
    if (field === "overview") {
        return normalizeTranslationText(simplified.replace(OVERVIEW_FULL_WIDTH_SPACE_BREAK_RE, "\n"));
    }

    return simplified;
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
        title: normalizeTranslationFieldValue("title", translation.title),
        overview: normalizeTranslationFieldValue("overview", translation.overview),
        tagline: normalizeTranslationFieldValue("tagline", translation.tagline),
    };

    return hasUsefulTranslation(normalized) ? normalized : null;
}

function normalizeTranslationFieldsInPlace(translation) {
    if (!translation || typeof translation !== "object") {
        return translation;
    }

    TRANSLATION_FIELDS.forEach((field) => {
        const normalizedValue = normalizeTranslationFieldValue(field, translation[field]);
        if (normalizedValue === null) {
            delete translation[field];
            return;
        }
        translation[field] = normalizedValue;
    });

    return translation;
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
            cnTranslation[field] = fallback[field];
            return;
        }
    }
}

function normalizeTranslations(items) {
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
    normalizeTranslationFieldsInPlace(cnTranslation);

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
    areTranslationsEqual,
    CACHE_STATUS,
    extractEpisodePlaceholderNumber,
    extractNormalizedTranslation,
    findTranslationByRegion,
    hasUsefulTranslation,
    isChineseTranslation,
    isEmptyTranslationValue,
    normalizeTranslationFieldsInPlace,
    normalizeTranslationFieldValue,
    normalizeTranslationPayload,
    normalizeTranslations,
    normalizeTranslationText,
    pickCnTranslation,
    sortTranslations,
    TRANSLATION_FALLBACK_REGIONS,
    TRANSLATION_FIELDS,
};
