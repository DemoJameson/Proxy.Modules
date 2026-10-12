const { pipelineKv } = require("./kv-client");

const { buildLocaleWriteCommands, readLocaleEntriesFromKv } = require("./locale");

const PERSON_NAME_ROOT_FIELDS = ["name", "notFound"];

function hasPersonNameRootData(doc) {
    return !!doc && typeof doc === "object" && (typeof doc.name === "object" || typeof doc.notFound === "object" || doc.notFound === true);
}

function buildPersonNameCacheKey(traktId) {
    const normalizedTraktId = String(traktId || "").trim();
    if (!/^\d+$/.test(normalizedTraktId)) {
        return "";
    }
    return `trakt:person-name:${normalizedTraktId}`;
}

const PERSON_NAME_SOURCES = ["tmdb", "google"];
const PERSON_NAME_TTL_SECONDS = 90 * 24 * 60 * 60;
const PERSON_NAME_GOOGLE_TTL_SECONDS = 30 * 24 * 60 * 60;
const PERSON_NAME_NOT_FOUND_TTL_SECONDS = 7 * 24 * 60 * 60;

function normalizePersonNameEntry(entry) {
    // TMDB 查询无中文名的负缓存条目：{ notFound: true }（过期时间写在数据里）
    if (entry?.notFound === true || (entry?.notFound && typeof entry.notFound === "object")) {
        // 线上形状保持 { notFound: true }：客户端据此写入本地 7 天负缓存
        return { notFound: true };
    }

    const name = entry?.name && typeof entry.name === "object" ? entry.name : null;
    if (!name) {
        return null;
    }

    const sourceTextHash = String(name.sourceTextHash || "").trim();
    const translatedText = String(name.translatedText || "").trim();
    const source = String(name.source || "")
        .trim()
        .toLowerCase();
    if (!sourceTextHash || !translatedText || !PERSON_NAME_SOURCES.includes(source)) {
        return null;
    }

    const normalizedName = {
        sourceTextHash,
        translatedText,
        source,
    };
    if (Number.isFinite(Number(name.expiresAt))) {
        normalizedName.expiresAt = Number(name.expiresAt);
    }
    return { name: normalizedName };
}

// 人物名的过期时间嵌在 name/notFound 内，需要单独判断
function isPersonNameEntryExpired(entry, now = Date.now()) {
    if (!entry || typeof entry !== "object") {
        return false;
    }
    const expiresAt = Number(entry.name?.expiresAt ?? entry.notFound?.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now;
}

// 过期时间写进数据字段，不再发送 EXPIRE：tmdb 90 天、google 30 天、未找到 7 天
function applyPersonNameExpiresAt(entry, now = Date.now()) {
    if (!entry || typeof entry !== "object") {
        return entry;
    }
    if (entry.notFound === true || (entry.notFound && typeof entry.notFound === "object")) {
        return { notFound: { ...(typeof entry.notFound === "object" ? entry.notFound : {}), expiresAt: now + PERSON_NAME_NOT_FOUND_TTL_SECONDS * 1000 } };
    }
    if (entry.name && typeof entry.name === "object") {
        const ttl = entry.name.source === "google" ? PERSON_NAME_GOOGLE_TTL_SECONDS : PERSON_NAME_TTL_SECONDS;
        return { name: { ...entry.name, expiresAt: now + ttl * 1000 } };
    }
    return entry;
}

async function readManyPersonNameEntriesFromKv(config, ids, options = {}) {
    if (!config) {
        return { people: {}, cn: {} };
    }

    const refs = (Array.isArray(ids) ? ids : []).map((id) => ({ id, key: buildPersonNameCacheKey(id) })).filter((ref) => ref.key);
    const { entries, cnHints } = await readLocaleEntriesFromKv(config, refs, {
        locale: options.locale,
        hasRootData: hasPersonNameRootData,
        isExpired: isPersonNameEntryExpired,
    });
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
        const normalized = normalizePersonNameEntry(rawEntry);
        if (!normalized || !key) {
            return;
        }
        const entry = applyPersonNameExpiresAt(normalized, now);
        const cnNormalized = normalizePersonNameEntry(cnById[id]);
        items.push({ key, locale: options.locale, entry, cnData: cnNormalized ? applyPersonNameExpiresAt(cnNormalized, now) : null });
    });
    const commands = buildLocaleWriteCommands(items, { rootFields: PERSON_NAME_ROOT_FIELDS });
    if (commands.length === 0) {
        return;
    }

    await pipelineKv(config, commands);
}

module.exports = {
    buildPersonNameCacheKey,
    isPersonNameEntryExpired,
    normalizePersonNameEntry,
    readManyPersonNameEntriesFromKv,
    writeManyPersonNameEntriesToKv,
};
