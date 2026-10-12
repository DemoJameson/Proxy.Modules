import * as commonUtils from "../utils/common.mjs";

import * as chineseLocale from "./chinese-script-converter.mjs";

const TRANSLATION_FIELDS = ["title", "overview", "tagline"];
// 简体沿用历史顺序；港台优先本地区原生翻译，再退到另一繁体地区、大陆、新加坡
const TRANSLATION_REGION_PREFERENCE = {
    cn: ["cn", "sg", "tw", "hk"],
    tw: ["tw", "hk", "cn", "sg"],
    hk: ["hk", "tw", "cn", "sg"],
};
const TRANSLATION_FALLBACK_REGIONS = TRANSLATION_REGION_PREFERENCE.cn.slice(1);
const EPISODE_PLACEHOLDER_TITLE_RE = /^\s*episode\s+0*(\d+)\s*$/i;
const OVERVIEW_FULL_WIDTH_SPACE_BREAK_RE = /\u3000{2,}/g;
const CJK_CHARACTER_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;

const CACHE_STATUS = {
    FOUND: 1,
    PARTIAL_FOUND: 2,
    NOT_FOUND: 3,
};

function resolveLocale(locale) {
    return locale === undefined ? chineseLocale.resolveChineseLocale() : chineseLocale.normalizeChineseLocale(locale);
}

function getRegionPreference(locale) {
    return TRANSLATION_REGION_PREFERENCE[resolveLocale(locale)] ?? TRANSLATION_REGION_PREFERENCE.cn;
}

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

function containsChineseText(value) {
    const text = normalizeTranslationText(value);
    return text !== null && CJK_CHARACTER_RE.test(text);
}

function normalizeTranslationFieldValue(field, value, locale, options = {}) {
    const normalized = normalizeTranslationText(value);
    if (normalized === null) {
        return null;
    }

    const converted = chineseLocale.normalizeChineseForLocale(normalized, resolveLocale(locale), options);
    if (field === "overview") {
        return normalizeTranslationText(converted.replace(OVERVIEW_FULL_WIDTH_SPACE_BREAK_RE, "\n"));
    }

    return converted;
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

function deriveTranslationStatus(translation) {
    if (translation && !isEmptyTranslationValue(translation.title)) {
        return CACHE_STATUS.FOUND;
    }
    return hasUsefulTranslation(translation) ? CACHE_STATUS.PARTIAL_FOUND : CACHE_STATUS.NOT_FOUND;
}

function normalizeTranslationStatus(status) {
    return status === CACHE_STATUS.FOUND ? CACHE_STATUS.FOUND : status === CACHE_STATUS.PARTIAL_FOUND ? CACHE_STATUS.PARTIAL_FOUND : CACHE_STATUS.NOT_FOUND;
}

function normalizeTranslationPayload(translation, locale, options = {}) {
    if (!translation || typeof translation !== "object") {
        return null;
    }

    const normalized = {
        title: normalizeTranslationFieldValue("title", translation.title, locale, options),
        overview: normalizeTranslationFieldValue("overview", translation.overview, locale, options),
        tagline: normalizeTranslationFieldValue("tagline", translation.tagline, locale, options),
    };

    return hasUsefulTranslation(normalized) ? normalized : null;
}

function normalizeTranslationFieldsInPlace(translation, locale, options = {}) {
    if (!translation || typeof translation !== "object") {
        return translation;
    }

    TRANSLATION_FIELDS.forEach((field) => {
        const normalizedValue = normalizeTranslationFieldValue(field, translation[field], locale, options);
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

function copyFallbackFieldToPrimaryTranslation(primaryTranslation, items, field, fallbackRegions, locale) {
    if (!isEmptyTranslationValue(primaryTranslation[field])) {
        return;
    }

    for (let i = 0; i < fallbackRegions.length; i += 1) {
        const region = fallbackRegions[i];
        const fallback = findTranslationByRegion(items, region);
        if (fallback && !isEmptyTranslationValue(fallback[field])) {
            // 回退字段按来源地区转换：只有 cn/sg 来源才需要简→繁，繁体来源直接透传
            const normalizedValue = normalizeTranslationFieldValue(field, fallback[field], locale, {
                fromSimplified: chineseLocale.isSimplifiedSourceRegion(region),
            });
            if (!isEmptyTranslationValue(normalizedValue)) {
                primaryTranslation[field] = normalizedValue;
            }
            return;
        }
    }
}

function normalizeTranslations(items, locale) {
    if (commonUtils.isNotArray(items)) {
        items = [];
    }

    const resolvedLocale = resolveLocale(locale);
    const [primaryRegion, ...fallbackRegions] = getRegionPreference(resolvedLocale);
    let primaryTranslation = findTranslationByRegion(items, primaryRegion);
    const originalPrimaryHasTitle = !!(primaryTranslation && !isEmptyTranslationValue(primaryTranslation.title));
    const hasAnyChineseField = items.some((item) => {
        return isChineseTranslation(item) && TRANSLATION_FIELDS.some((field) => !isEmptyTranslationValue(item[field]));
    });

    if (!primaryTranslation) {
        primaryTranslation = {
            language: "zh",
            country: primaryRegion,
        };
        items.unshift(primaryTranslation);
    }

    // 主条目字段按主地区来源转换（tw/hk 只转换 cn/sg 来源），再补回退字段（各自按来源地区转换）
    normalizeTranslationFieldsInPlace(primaryTranslation, resolvedLocale, {
        fromSimplified: chineseLocale.isSimplifiedSourceRegion(primaryRegion),
    });
    TRANSLATION_FIELDS.forEach((field) => {
        copyFallbackFieldToPrimaryTranslation(primaryTranslation, items, field, fallbackRegions, resolvedLocale);
    });

    primaryTranslation.status = originalPrimaryHasTitle ? CACHE_STATUS.FOUND : hasAnyChineseField ? CACHE_STATUS.PARTIAL_FOUND : CACHE_STATUS.NOT_FOUND;

    return items;
}

// 兼容旧调用：默认取简体条目
function pickCnTranslation(items) {
    return pickLocaleTranslation(items, chineseLocale.CHINESE_LOCALE.CN);
}

function pickLocaleTranslation(items, locale) {
    if (commonUtils.isNotArray(items) || items.length === 0) {
        return null;
    }

    const primaryRegion = getRegionPreference(locale)[0];
    return (
        items.find((item) => {
            return String(item?.language ?? "").toLowerCase() === "zh" && String(item?.country ?? "").toLowerCase() === primaryRegion;
        }) ?? null
    );
}

function extractNormalizedTranslation(items, locale) {
    const primaryTranslation = pickLocaleTranslation(items, locale);
    return {
        status: primaryTranslation?.status ?? CACHE_STATUS.NOT_FOUND,
        translation: normalizeTranslationPayload(primaryTranslation, locale),
    };
}

// tw/hk 场景下从同一次上游响应派生 cn 槽位数据：状态按内容推导（有 title → FOUND，有任一字段 → PARTIAL）
function buildCnFoldEntry(items, locale) {
    if (resolveLocale(locale) === chineseLocale.CHINESE_LOCALE.CN) {
        return null;
    }
    const cnEntry = extractNormalizedTranslation(items, chineseLocale.CHINESE_LOCALE.CN);
    if (!cnEntry?.translation) {
        return null;
    }
    return {
        status: deriveTranslationStatus(cnEntry.translation),
        translation: cnEntry.translation,
        complete: true,
    };
}

function areTranslationsEqual(left, right, locale) {
    const normalizedLeft = normalizeTranslationPayload(left, locale);
    const normalizedRight = normalizeTranslationPayload(right, locale);

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
    buildCnFoldEntry,
    CACHE_STATUS,
    containsChineseText,
    deriveTranslationStatus,
    extractEpisodePlaceholderNumber,
    extractNormalizedTranslation,
    findTranslationByRegion,
    getRegionPreference,
    hasUsefulTranslation,
    isChineseTranslation,
    isEmptyTranslationValue,
    normalizeTranslationFieldsInPlace,
    normalizeTranslationFieldValue,
    normalizeTranslationPayload,
    normalizeTranslationStatus,
    normalizeTranslations,
    normalizeTranslationText,
    pickCnTranslation,
    pickLocaleTranslation,
    sortTranslations,
    TRANSLATION_FALLBACK_REGIONS,
    TRANSLATION_FIELDS,
    TRANSLATION_REGION_PREFERENCE,
};
