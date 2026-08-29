const CACHE_STATUS = {
    FOUND: 1,
    PARTIAL_FOUND: 2,
    NOT_FOUND: 3,
};

const OVERRIDE_FIELDS = ["title", "overview", "tagline"];
const MEDIA_TYPES = ["shows", "movies", "episodes"];
const IMAGE_GROUPS = ["shows", "movies", "seasons"];
const IMAGE_FIELDS = ["poster", "logo"];
const TRANSLATION_OVERRIDES_KEY = "trakt:translation:overrides";
const PARTIAL_FOUND_TTL_SECONDS = 30 * 24 * 60 * 60;
const IMAGE_NOT_FOUND_TTL_SECONDS = 3 * 24 * 60 * 60;
const NOT_FOUND_TTL_SECONDS = 1 * 24 * 60 * 60;

const RESPONSE_CACHE_HEADERS = {
    [CACHE_STATUS.FOUND]: {
        "Cache-Control": "public, max-age=300",
        "CDN-Cache-Control": "public, s-maxage=86400",
        "Vercel-CDN-Cache-Control": "public, s-maxage=86400",
    },
    [CACHE_STATUS.PARTIAL_FOUND]: {
        "Cache-Control": "public, max-age=60",
        "CDN-Cache-Control": "public, s-maxage=60",
        "Vercel-CDN-Cache-Control": "public, s-maxage=60",
    },
    [CACHE_STATUS.NOT_FOUND]: {
        "Cache-Control": "public, max-age=60",
        "CDN-Cache-Control": "public, s-maxage=60",
        "Vercel-CDN-Cache-Control": "public, s-maxage=60",
    },
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
        };
    }

    const normalized = {
        status: entry.status === CACHE_STATUS.FOUND ? CACHE_STATUS.FOUND : entry.status === CACHE_STATUS.PARTIAL_FOUND ? CACHE_STATUS.PARTIAL_FOUND : CACHE_STATUS.NOT_FOUND,
        translation: normalizeTranslation(entry.translation, true),
    };

    if (Object.hasOwn(entry, "expiresAt")) {
        if (entry.expiresAt === null || Number.isFinite(entry.expiresAt)) {
            normalized.expiresAt = entry.expiresAt;
        }
    }

    if (entry.complete === true) {
        normalized.complete = true;
    }

    return normalized;
}

function normalizeImageField(entry, now = Date.now()) {
    const status = entry?.status === CACHE_STATUS.FOUND ? CACHE_STATUS.FOUND : entry?.status === CACHE_STATUS.PARTIAL_FOUND ? CACHE_STATUS.PARTIAL_FOUND : CACHE_STATUS.NOT_FOUND;
    const url = String(entry?.url || "").trim();
    if (status === CACHE_STATUS.FOUND && url) {
        return { status, url, expiresAt: null };
    }
    if (status === CACHE_STATUS.PARTIAL_FOUND && url) {
        const expiresAt = Number.isFinite(Number(entry?.expiresAt)) ? Number(entry.expiresAt) : now + PARTIAL_FOUND_TTL_SECONDS * 1000;
        return { status, url, expiresAt };
    }
    const expiresAt = Number.isFinite(Number(entry?.expiresAt)) ? Number(entry.expiresAt) : now + IMAGE_NOT_FOUND_TTL_SECONDS * 1000;
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
    if (status === CACHE_STATUS.PARTIAL_FOUND) {
        return now + PARTIAL_FOUND_TTL_SECONDS * 1000;
    }
    if (status === CACHE_STATUS.NOT_FOUND) {
        return now + NOT_FOUND_TTL_SECONDS * 1000;
    }
    return null;
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
        if (!isEmptyTranslationValue(source[field])) {
            result[field] = source[field];
        }
        return result;
    }, {});
    return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeTranslationOverrideEntry(entry, now = Date.now()) {
    const source = entry && typeof entry === "object" ? entry : {};
    return {
        translation: normalizeTranslationOverrideFields(source.translation),
        updatedAt: Number.isFinite(source.updatedAt) ? source.updatedAt : now,
    };
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
            const entries = source[mediaType] && typeof source[mediaType] === "object" ? source[mediaType] : {};
            const normalizedEntries = Object.fromEntries(
                Object.entries(entries)
                    .map(([id, entry]) => [id, normalizeTranslationOverrideEntry(entry)])
                    .filter(([, entry]) => entry.translation),
            );
            return [mediaType, normalizedEntries];
        }),
    );
}

function mergeEntries(autoEntry, override) {
    const auto = autoEntry ? normalizeEntry(autoEntry) : null;
    const normalizedOverride = override ? normalizeTranslationOverrideEntry(override) : null;
    const autoTranslation = auto?.translation ? auto.translation : {};
    const translationOverrides = normalizedOverride?.translation ? normalizedOverride.translation : {};

    const translation = OVERRIDE_FIELDS.reduce((result, field) => {
        const overrideValue = translationOverrides[field];
        result[field] = !isEmptyTranslationValue(overrideValue) ? overrideValue : autoTranslation[field] || null;
        return result;
    }, {});

    return {
        status: hasUsefulTranslation(translation) ? CACHE_STATUS.FOUND : CACHE_STATUS.NOT_FOUND,
        translation: hasUsefulTranslation(translation) ? translation : null,
    };
}

function getResponseCacheStatus(...groups) {
    let hasEntries = false;
    let hasPartialFound = false;

    for (const group of groups) {
        for (const entry of Object.values(group || {})) {
            hasEntries = true;
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
