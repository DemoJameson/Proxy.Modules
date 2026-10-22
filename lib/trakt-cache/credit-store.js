const { CACHE_STATUS } = require("./normalize");
const { mgetKv, msetKv, parseRedisJsonValue } = require("./kv-client");

const DOUBAN_TARGET_TYPES = ["movies", "shows"];
const DOUBAN_TTL_SECONDS = 30 * 24 * 60 * 60;

function buildCreditCacheKey(targetType, traktId) {
    const normalizedTargetType = DOUBAN_TARGET_TYPES.includes(targetType) ? targetType : "";
    const normalizedTraktId = String(traktId || "").trim();
    if (!normalizedTargetType || !normalizedTraktId) {
        return "";
    }
    return `credit:${normalizedTargetType}:${normalizedTraktId}`;
}

function parseCreditEntry(value) {
    const parsed = parseRedisJsonValue(value);
    return parsed && typeof parsed === "object" ? parsed : null;
}

const CREDIT_ENTRY_FIELDS = ["subject", "seasons", "credits"];

// 30 天有效期写在数据字段里（不再使用 EXPIRE）：读取时过滤已过期条目
function isCreditEntryExpired(entry, now = Date.now()) {
    const expiresAt = Number(entry?.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now;
}

function isCreditEntryTargetTypeValid(entry, expectedType) {
    const subjectType = entry?.subject?.targetType;
    if (subjectType === undefined || subjectType === null || subjectType === "") {
        return true;
    }
    return String(subjectType).trim().toLowerCase() === expectedType;
}

function mergeCreditEntriesByField(existing, incoming) {
    const merged = {};
    const allIds = new Set([...Object.keys(existing || {}), ...Object.keys(incoming || {})]);
    for (const id of allIds) {
        const existingEntry = existing?.[id] && typeof existing[id] === "object" ? existing[id] : {};
        const incomingEntry = incoming?.[id] && typeof incoming[id] === "object" ? incoming[id] : {};
        const mergedEntry = { ...existingEntry };
        for (const field of CREDIT_ENTRY_FIELDS) {
            if (incomingEntry[field] && typeof incomingEntry[field] === "object") {
                mergedEntry[field] = incomingEntry[field];
            }
        }
        if (Number.isFinite(Number(incomingEntry.expiresAt))) {
            mergedEntry.expiresAt = Number(incomingEntry.expiresAt);
        }
        if (Object.keys(mergedEntry).length > 0) {
            merged[id] = mergedEntry;
        }
    }
    return merged;
}

function isCompleteCreditEntry(entry) {
    return CREDIT_ENTRY_FIELDS.every((field) => entry[field] && typeof entry[field] === "object");
}

function getCreditCacheStatus(entries, requestedCounts) {
    let hasEntries = false;
    let hasPartialFound = false;
    for (const type of DOUBAN_TARGET_TYPES) {
        const items = entries?.[type] && typeof entries[type] === "object" ? entries[type] : {};
        if (Object.keys(items).length !== requestedCounts[type]) {
            return CACHE_STATUS.NOT_FOUND;
        }
        if (Object.keys(items).length > 0) {
            hasEntries = true;
        }
        if (!Object.values(items).every(isCompleteCreditEntry)) {
            hasPartialFound = true;
        }
    }
    if (!hasEntries) {
        return CACHE_STATUS.NOT_FOUND;
    }
    return hasPartialFound ? CACHE_STATUS.PARTIAL_FOUND : CACHE_STATUS.FOUND;
}

function splitCreditEntriesByCompleteness(entriesById) {
    const complete = {};
    const partial = {};
    for (const [id, entry] of Object.entries(entriesById || {})) {
        if (entry && typeof entry === "object" && isCompleteCreditEntry(entry)) {
            complete[id] = entry;
        } else if (entry && typeof entry === "object") {
            partial[id] = entry;
        }
    }
    return { complete, partial };
}

async function readManyCreditEntriesFromKv(config, idsByType) {
    if (!config) {
        return Object.fromEntries(DOUBAN_TARGET_TYPES.map((type) => [type, {}]));
    }

    const refs = DOUBAN_TARGET_TYPES.flatMap((type) => {
        const ids = idsByType[type] || [];
        return ids.map((id) => ({ type, id, key: buildCreditCacheKey(type, id) }));
    });
    const results = await mgetKv(
        config,
        refs.map((ref) => ref.key),
    );
    const entries = Object.fromEntries(DOUBAN_TARGET_TYPES.map((type) => [type, {}]));
    refs.forEach((ref, index) => {
        const creditEntry = parseCreditEntry(results[index]);
        if (creditEntry && isCreditEntryTargetTypeValid(creditEntry, ref.type) && !isCreditEntryExpired(creditEntry)) {
            const expiresAt = Number(creditEntry.expiresAt);
            entries[ref.type][ref.id] = {
                ...creditEntry,
                expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : Date.now() + DOUBAN_TTL_SECONDS * 1000,
            };
        }
    });
    return entries;
}

function buildWriteManyCreditEntries(targetType, entriesById, now = Date.now()) {
    const entries = {};
    Object.entries(entriesById).forEach(([id, rawEntry]) => {
        const entry = rawEntry && typeof rawEntry === "object" ? rawEntry : null;
        if (!entry) {
            return;
        }
        const key = buildCreditCacheKey(targetType, id);
        if (!key) {
            return;
        }
        // 30 天有效期写进数据字段，不再发送 EXPIRE
        entries[key] = { ...entry, expiresAt: now + DOUBAN_TTL_SECONDS * 1000 };
    });
    return entries;
}

async function writeManyCreditEntriesToKv(config, entriesByType) {
    if (!config) {
        return;
    }

    const now = Date.now();
    const entries = Object.assign({}, ...DOUBAN_TARGET_TYPES.map((type) => buildWriteManyCreditEntries(type, entriesByType?.[type] || {}, now)));
    await msetKv(config, entries);
}

module.exports = {
    DOUBAN_TARGET_TYPES,
    DOUBAN_TTL_SECONDS,
    buildCreditCacheKey,
    getCreditCacheStatus,
    isCreditEntryExpired,
    isCompleteCreditEntry,
    mergeCreditEntriesByField,
    splitCreditEntriesByCompleteness,
    readManyCreditEntriesFromKv,
    buildWriteManyCreditEntries,
    writeManyCreditEntriesToKv,
};
