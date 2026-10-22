const { readLocaleEntriesFromKv, writeLocaleEntriesToKv } = require("./locale");

function buildListTranslationCacheKey(listId) {
    const normalizedListId = String(listId || "").trim();
    if (!/^\d+$/.test(normalizedListId)) {
        return "";
    }
    return `list:translation:${normalizedListId}`;
}

const LIST_TRANSLATION_TTL_SECONDS = 90 * 24 * 60 * 60;

const LIST_TRANSLATION_FIELDS = ["name", "description"];

function normalizeListTranslationEntry(entry) {
    if (!entry || typeof entry !== "object") {
        return null;
    }

    // name/description 两字段可选，至少一个有效才接受；多余字段丢弃
    const normalized = {};
    LIST_TRANSLATION_FIELDS.forEach((field) => {
        const fieldEntry = entry[field] && typeof entry[field] === "object" ? entry[field] : null;
        const sourceTextHash = String(fieldEntry?.sourceTextHash || "").trim();
        const translatedText = String(fieldEntry?.translatedText || "").trim();
        if (sourceTextHash && translatedText) {
            normalized[field] = {
                sourceTextHash,
                translatedText,
            };
        }
    });
    if (Object.keys(normalized).length === 0) {
        return null;
    }
    const expiresAt = Number(entry?.expiresAt);
    normalized.expiresAt = Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : Date.now() + LIST_TRANSLATION_TTL_SECONDS * 1000;
    return normalized;
}

async function readManyListTranslationEntriesFromKv(config, ids, options = {}) {
    if (!config) {
        return { lists: {}, cn: {} };
    }

    const refs = (Array.isArray(ids) ? ids : []).map((id) => ({ id, key: buildListTranslationCacheKey(id) })).filter((ref) => ref.key);
    const { entries, cnHints } = await readLocaleEntriesFromKv(config, refs, { locale: options.locale });
    const lists = {};
    Object.entries(entries).forEach(([id, entry]) => {
        const normalized = normalizeListTranslationEntry(entry);
        if (normalized) {
            lists[id] = normalized;
        }
    });
    const cn = {};
    Object.entries(cnHints).forEach(([id, entry]) => {
        const normalized = normalizeListTranslationEntry(entry);
        if (normalized) {
            cn[id] = normalized;
        }
    });
    return { lists, cn };
}

async function writeManyListTranslationEntriesToKv(config, entriesById, options = {}) {
    if (!config) {
        return;
    }

    // 片单翻译 90 天 TTL 写进数据字段，正文变更由 sourceTextHash 兜底；不再发送 EXPIRE
    const now = Date.now();
    const cnById = options.cn && typeof options.cn === "object" ? options.cn : {};
    const items = [];
    Object.entries(entriesById || {}).forEach(([id, rawEntry]) => {
        const entry = normalizeListTranslationEntry(rawEntry);
        const key = buildListTranslationCacheKey(id);
        if (!entry || !key) {
            return;
        }
        const cnEntry = normalizeListTranslationEntry(cnById[id]);
        items.push({
            key,
            locale: options.locale,
            entry: { ...entry, expiresAt: now + LIST_TRANSLATION_TTL_SECONDS * 1000 },
            cnData: cnEntry ? { ...cnEntry, expiresAt: now + LIST_TRANSLATION_TTL_SECONDS * 1000 } : null,
        });
    });
    await writeLocaleEntriesToKv(config, items);
}

module.exports = {
    buildListTranslationCacheKey,
    normalizeListTranslationEntry,
    readManyListTranslationEntriesFromKv,
    writeManyListTranslationEntriesToKv,
};
