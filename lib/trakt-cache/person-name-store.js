const { readLocaleEntriesFromKv, writeLocaleEntriesToKv } = require("./locale");

const { CACHE_STATUS } = require("./normalize");

const PERSON_NAME_SOURCES = ["tmdb", "google"];
const PERSON_NAME_TTL_SECONDS = 90 * 24 * 60 * 60;
const PERSON_NAME_GOOGLE_TTL_SECONDS = 30 * 24 * 60 * 60;
const PERSON_NAME_MISSING_TTL_SECONDS = 7 * 24 * 60 * 60;

function buildPersonNameCacheKey(traktId) {
    const normalizedTraktId = String(traktId || "").trim();
    if (!/^\d+$/.test(normalizedTraktId)) {
        return "";
    }
    return `person:name:${normalizedTraktId}`;
}

function normalizePersonNameEntry(entry, now = Date.now()) {
    const source = entry && typeof entry === "object" ? entry : {};
    const status = source.status === CACHE_STATUS.FOUND ? CACHE_STATUS.FOUND : source.status === CACHE_STATUS.NOT_FOUND ? CACHE_STATUS.NOT_FOUND : null;
    if (!status) {
        return null;
    }

    const providedExpiresAt = Number(source.expiresAt);
    if (status === CACHE_STATUS.NOT_FOUND) {
        if (source.tmdbMissing !== true) {
            return null;
        }
        const defaultExpiresAt = now + PERSON_NAME_MISSING_TTL_SECONDS * 1000;
        return {
            status,
            expiresAt: Number.isFinite(providedExpiresAt) && providedExpiresAt > now ? Math.min(providedExpiresAt, defaultExpiresAt) : defaultExpiresAt,
            tmdbMissing: true,
        };
    }

    const name = String(source.name ?? "").trim();
    const sourceTextHash = String(source.sourceTextHash ?? "").trim();
    const nameSource = String(source.source ?? "")
        .trim()
        .toLowerCase();
    if (!name || !sourceTextHash || !PERSON_NAME_SOURCES.includes(nameSource)) {
        return null;
    }

    const tmdbMissing = nameSource !== "tmdb" && source.tmdbMissing === true;
    const defaultTtlSeconds = tmdbMissing ? PERSON_NAME_MISSING_TTL_SECONDS : nameSource === "google" ? PERSON_NAME_GOOGLE_TTL_SECONDS : PERSON_NAME_TTL_SECONDS;
    const defaultExpiresAt = now + defaultTtlSeconds * 1000;
    return {
        status,
        name,
        sourceTextHash,
        source: nameSource,
        expiresAt: Number.isFinite(providedExpiresAt) && providedExpiresAt > now ? Math.min(providedExpiresAt, defaultExpiresAt) : defaultExpiresAt,
        ...(tmdbMissing ? { tmdbMissing: true } : {}),
    };
}

function isPersonNameEntryExpired(entry, now = Date.now()) {
    const expiresAt = Number(entry?.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now;
}

async function readManyPersonNameEntriesFromKv(config, ids, options = {}) {
    if (!config) {
        return { people: {}, cn: {} };
    }

    const refs = (Array.isArray(ids) ? ids : []).map((id) => ({ id, key: buildPersonNameCacheKey(id) })).filter((ref) => ref.key);
    const { entries, cnHints } = await readLocaleEntriesFromKv(config, refs, { locale: options.locale, isExpired: isPersonNameEntryExpired });
    const people = {};
    Object.entries(entries).forEach(([id, entry]) => {
        const normalized = normalizePersonNameEntry(entry);
        if (normalized) {
            people[id] = normalized;
        }
    });
    const cn = {};
    Object.entries(cnHints).forEach(([id, entry]) => {
        const normalized = normalizePersonNameEntry(entry);
        if (normalized) {
            cn[id] = normalized;
        }
    });
    return { people, cn };
}

async function writeManyPersonNameEntriesToKv(config, entriesById, options = {}) {
    if (!config) {
        return;
    }

    const now = Date.now();
    const cnById = options.cn && typeof options.cn === "object" ? options.cn : {};
    const items = [];
    Object.entries(entriesById || {}).forEach(([id, rawEntry]) => {
        const key = buildPersonNameCacheKey(id);
        const normalized = normalizePersonNameEntry(rawEntry, now);
        if (!normalized || !key) {
            return;
        }
        const cnNormalized = normalizePersonNameEntry(cnById[id], now);
        items.push({ key, locale: options.locale, entry: normalized, cnData: cnNormalized });
    });
    await writeLocaleEntriesToKv(config, items);
}

module.exports = {
    buildPersonNameCacheKey,
    isPersonNameEntryExpired,
    normalizePersonNameEntry,
    readManyPersonNameEntriesFromKv,
    writeManyPersonNameEntriesToKv,
    PERSON_NAME_STATUS: CACHE_STATUS,
};
