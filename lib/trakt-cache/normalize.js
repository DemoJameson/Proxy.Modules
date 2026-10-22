const CACHE_STATUS = {
    FOUND: 1,
    PARTIAL_FOUND: 2,
    NOT_FOUND: 3,
};

const OVERRIDE_FIELDS = ["title", "overview", "tagline"];
const MEDIA_TYPES = ["shows", "movies", "episodes"];
const IMAGE_GROUPS = ["shows", "movies", "seasons"];
const IMAGE_FIELDS = ["poster", "logo"];
const TRANSLATION_OVERRIDES_KEY = "translation:overrides";
const PARTIAL_FOUND_TTL_SECONDS = 30 * 24 * 60 * 60;
const IMAGE_NOT_FOUND_TTL_SECONDS = 3 * 24 * 60 * 60;
const NOT_FOUND_TTL_SECONDS = 1 * 24 * 60 * 60;
const FOUND_TTL_SECONDS = 365 * 24 * 60 * 60;

const NOT_FOUND_RESPONSE_HEADERS = {
    "Cache-Control": "public, max-age=120",
    "CDN-Cache-Control": "public, s-maxage=3600, stale-while-revalidate=3600",
    "Vercel-CDN-Cache-Control": "public, s-maxage=3600, stale-while-revalidate=3600",
};

const RESPONSE_CACHE_HEADERS = {
    [CACHE_STATUS.FOUND]: {
        "Cache-Control": "public, max-age=300",
        "CDN-Cache-Control": "public, s-maxage=604800, stale-while-revalidate=604800",
        "Vercel-CDN-Cache-Control": "public, s-maxage=604800, stale-while-revalidate=604800",
    },
    // PARTIAL_FOUND 与 NOT_FOUND 使用同一组缓存头，避免部分数据长时间占住 CDN。
    [CACHE_STATUS.PARTIAL_FOUND]: NOT_FOUND_RESPONSE_HEADERS,
    [CACHE_STATUS.NOT_FOUND]: NOT_FOUND_RESPONSE_HEADERS,
};

function isSupportedMediaType(type) {
    return MEDIA_TYPES.includes(type);
}

function isEmptyTranslationValue(value) {
    return value === undefined || value === null || value === "";
}

function hasUsefulTranslation(translation) {
    return !!(translation && (!isEmptyTranslationValue(translation.title) || !isEmptyTranslationValue(translation.overview) || !isEmptyTranslationValue(translation.tagline)));
}

function normalizeTranslation(translation, emptyAsNull = true) {
    if (!translation || typeof translation !== "object") {
        return emptyAsNull ? null : { title: null, overview: null, tagline: null };
    }

    const normalized = {
        title: isEmptyTranslationValue(translation.title) ? null : translation.title,
        overview: isEmptyTranslationValue(translation.overview) ? null : translation.overview,
        tagline: isEmptyTranslationValue(translation.tagline) ? null : translation.tagline,
    };

    return emptyAsNull && !hasUsefulTranslation(normalized) ? null : normalized;
}

function normalizeEntry(entry) {
    if (!entry || typeof entry !== "object") {
        return {
            status: CACHE_STATUS.NOT_FOUND,
            translation: null,
            expiresAt: getWriteExpiresAt(CACHE_STATUS.NOT_FOUND),
        };
    }

    const normalized = {
        status: entry.status === CACHE_STATUS.FOUND ? CACHE_STATUS.FOUND : entry.status === CACHE_STATUS.PARTIAL_FOUND ? CACHE_STATUS.PARTIAL_FOUND : CACHE_STATUS.NOT_FOUND,
        translation: normalizeTranslation(entry.translation, true),
    };

    const expiresAt = Object.hasOwn(entry, "expiresAt") ? Number(entry.expiresAt) : NaN;
    normalized.expiresAt = Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : getWriteExpiresAt(normalized.status);

    if (entry.complete === true) {
        normalized.complete = true;
    }

    return normalized;
}

function normalizeImageField(entry, now = Date.now()) {
    const status = entry?.status === CACHE_STATUS.FOUND ? CACHE_STATUS.FOUND : entry?.status === CACHE_STATUS.PARTIAL_FOUND ? CACHE_STATUS.PARTIAL_FOUND : CACHE_STATUS.NOT_FOUND;
    const url = String(entry?.url || "").trim();
    const providedExpiresAt = Number(entry?.expiresAt);
    if (status === CACHE_STATUS.FOUND && url) {
        return { status, url, expiresAt: Number.isFinite(providedExpiresAt) && providedExpiresAt > 0 ? providedExpiresAt : now + FOUND_TTL_SECONDS * 1000 };
    }
    if (status === CACHE_STATUS.PARTIAL_FOUND && url) {
        const expiresAt =
            entry?.expiresAt !== null && entry?.expiresAt !== undefined && Number.isFinite(Number(entry.expiresAt)) && Number(entry.expiresAt) > 0
                ? Number(entry.expiresAt)
                : now + PARTIAL_FOUND_TTL_SECONDS * 1000;
        return { status, url, expiresAt };
    }
    const expiresAt =
        entry?.expiresAt !== null && entry?.expiresAt !== undefined && Number.isFinite(Number(entry.expiresAt)) && Number(entry.expiresAt) > 0
            ? Number(entry.expiresAt)
            : now + IMAGE_NOT_FOUND_TTL_SECONDS * 1000;
    return { status: CACHE_STATUS.NOT_FOUND, expiresAt };
}

function normalizeImageEntry(entry, now = Date.now()) {
    const source = entry && typeof entry === "object" ? entry : {};
    const normalized = {};
    IMAGE_FIELDS.forEach((field) => {
        if (source[field] && typeof source[field] === "object") {
            normalized[field] = normalizeImageField(source[field], now);
        }
    });
    return Object.keys(normalized).length > 0 ? normalized : null;
}

function getWriteExpiresAt(status, now = Date.now()) {
    if (status === CACHE_STATUS.FOUND) {
        return now + FOUND_TTL_SECONDS * 1000;
    }
    if (status === CACHE_STATUS.PARTIAL_FOUND) {
        return now + PARTIAL_FOUND_TTL_SECONDS * 1000;
    }
    if (status === CACHE_STATUS.NOT_FOUND) {
        return now + NOT_FOUND_TTL_SECONDS * 1000;
    }
    return now + FOUND_TTL_SECONDS * 1000;
}

function normalizeAutoEntryForWrite(entry, now = Date.now()) {
    const normalized = normalizeEntry(entry);
    return {
        ...normalized,
        expiresAt: getWriteExpiresAt(normalized.status, now),
    };
}

function normalizeTranslationOverrideFields(translation) {
    const source = translation && typeof translation === "object" ? translation : {};
    const normalized = OVERRIDE_FIELDS.reduce((result, field) => {
        if (Object.hasOwn(source, field) && !isEmptyTranslationValue(source[field])) {
            result[field] = source[field];
        }
        return result;
    }, {});
    return Object.keys(normalized).length > 0 ? normalized : null;
}

// 覆盖条目：cn/tw/hk 各存一份 translation
function normalizeTranslationOverrideEntry(entry, now = Date.now()) {
    const source = entry && typeof entry === "object" ? entry : {};
    const normalized = {
        updatedAt: Object.hasOwn(source, "updatedAt") && Number.isFinite(source.updatedAt) ? source.updatedAt : now,
    };
    const cnEntry = Object.hasOwn(source, "cn") ? source.cn : null;
    const cnFields = normalizeTranslationOverrideFields(cnEntry?.translation);
    if (cnFields) {
        normalized.cn = { translation: cnFields };
    }
    ["tw", "hk"].forEach((locale) => {
        const localized = Object.hasOwn(source, locale) ? source[locale] : null;
        if (!localized || typeof localized !== "object") {
            return;
        }
        const fields = normalizeTranslationOverrideFields(localized.translation);
        if (fields) {
            normalized[locale] = { translation: fields };
        }
    });
    return normalized;
}

function createEmptyTranslationOverridesStore() {
    return {
        shows: {},
        movies: {},
        episodes: {},
    };
}

function normalizeTranslationOverridesStore(value) {
    const source = value && typeof value === "object" ? value : {};
    return Object.fromEntries(
        MEDIA_TYPES.map((mediaType) => {
            const entries = Object.hasOwn(source, mediaType) && source[mediaType] && typeof source[mediaType] === "object" ? source[mediaType] : {};
            const normalizedEntries = Object.fromEntries(
                Object.entries(entries)
                    .map(([id, entry]) => [id, normalizeTranslationOverrideEntry(entry)])
                    .filter(([, entry]) => Object.hasOwn(entry, "cn") || Object.hasOwn(entry, "tw") || Object.hasOwn(entry, "hk")),
            );
            return [mediaType, normalizedEntries];
        }),
    );
}

function mergeEntries(autoEntry, override, locale = "cn") {
    const auto = autoEntry ? normalizeEntry(autoEntry) : null;
    const normalizedOverride = override ? normalizeTranslationOverrideEntry(override) : null;
    const autoTranslation = auto?.translation ? auto.translation : {};
    // 覆盖按地区生效，tw/hk 不回退 cn；与 cn 相同的本地区值视为伪覆盖并忽略
    const localizedOverride = locale !== "cn" ? normalizedOverride?.[locale]?.translation : null;
    const cnOverride = normalizedOverride?.cn?.translation;

    let hasAppliedOverride = false;
    const translation = OVERRIDE_FIELDS.reduce((result, field) => {
        let overrideValue;
        if (locale === "cn") {
            overrideValue = cnOverride?.[field];
        } else {
            const localizedValue = localizedOverride?.[field];
            const cnValue = cnOverride?.[field];
            overrideValue = !isEmptyTranslationValue(localizedValue) && (isEmptyTranslationValue(cnValue) || localizedValue !== cnValue) ? localizedValue : undefined;
        }
        if (!isEmptyTranslationValue(overrideValue)) {
            hasAppliedOverride = true;
            result[field] = overrideValue;
        } else {
            result[field] = autoTranslation[field] || null;
        }
        return result;
    }, {});

    const hasUseful = hasUsefulTranslation(translation);
    let status = CACHE_STATUS.NOT_FOUND;
    if (hasUseful) {
        status = auto?.status === CACHE_STATUS.PARTIAL_FOUND && !hasAppliedOverride ? CACHE_STATUS.PARTIAL_FOUND : CACHE_STATUS.FOUND;
    }
    return {
        status,
        translation: hasUseful ? translation : null,
        expiresAt: hasAppliedOverride ? getWriteExpiresAt(CACHE_STATUS.FOUND) : (auto?.expiresAt ?? getWriteExpiresAt(status)),
    };
}

// PARTIAL_FOUND 仍保留在条目数据中；这里只决定响应缓存等级。
function getResponseCacheStatus(groupsByType, requestedCounts = {}) {
    let hasEntries = false;
    let hasPartialFound = false;
    for (const [type, group] of Object.entries(groupsByType || {})) {
        const entries = group && typeof group === "object" ? group : {};
        if (Object.hasOwn(requestedCounts, type) && Object.keys(entries).length !== requestedCounts[type]) {
            return CACHE_STATUS.NOT_FOUND;
        }
        if (Object.keys(entries).length > 0) {
            hasEntries = true;
        }
        for (const entry of Object.values(entries)) {
            if (!entry || typeof entry !== "object") {
                return CACHE_STATUS.NOT_FOUND;
            }
            const statuses = Number.isFinite(entry.status)
                ? [entry.status]
                : Object.values(entry)
                      .map((field) => field?.status)
                      .filter(Number.isFinite);
            if (statuses.length === 0 || statuses.includes(CACHE_STATUS.NOT_FOUND)) {
                return CACHE_STATUS.NOT_FOUND;
            }
            if (statuses.includes(CACHE_STATUS.PARTIAL_FOUND)) {
                hasPartialFound = true;
            }
        }
    }
    if (!hasEntries) {
        return CACHE_STATUS.NOT_FOUND;
    }
    return hasPartialFound ? CACHE_STATUS.PARTIAL_FOUND : CACHE_STATUS.FOUND;
}

function setResponseCacheHeaders(res, status) {
    const headers = RESPONSE_CACHE_HEADERS[status] || RESPONSE_CACHE_HEADERS[CACHE_STATUS.NOT_FOUND];
    Object.entries(headers).forEach(([key, value]) => {
        res.setHeader(key, value);
    });
}

module.exports = {
    CACHE_STATUS,
    OVERRIDE_FIELDS,
    TRANSLATION_OVERRIDES_KEY,
    MEDIA_TYPES,
    IMAGE_GROUPS,
    IMAGE_FIELDS,
    PARTIAL_FOUND_TTL_SECONDS,
    IMAGE_NOT_FOUND_TTL_SECONDS,
    NOT_FOUND_TTL_SECONDS,
    FOUND_TTL_SECONDS,
    isSupportedMediaType,
    isEmptyTranslationValue,
    hasUsefulTranslation,
    normalizeTranslation,
    normalizeEntry,
    normalizeImageField,
    normalizeImageEntry,
    getWriteExpiresAt,
    normalizeAutoEntryForWrite,
    normalizeTranslationOverrideFields,
    normalizeTranslationOverrideEntry,
    createEmptyTranslationOverridesStore,
    normalizeTranslationOverridesStore,
    mergeEntries,
    getResponseCacheStatus,
    setResponseCacheHeaders,
};
