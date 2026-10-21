const { readLocaleEntriesFromKv, writeLocaleEntriesToKv } = require("./locale");

const COMMENT_ROOT_FIELDS = ["comment"];

function hasCommentRootData(doc) {
    return !!doc && typeof doc === "object" && typeof doc.comment === "object";
}

function buildCommentTranslationCacheKey(commentId) {
    const normalizedCommentId = String(commentId || "").trim();
    if (!/^\d+$/.test(normalizedCommentId)) {
        return "";
    }
    return `trakt:comment-translation:${normalizedCommentId}`;
}

const COMMENT_TRANSLATION_TTL_SECONDS = 90 * 24 * 60 * 60;

function normalizeCommentTranslationEntry(entry) {
    const comment = entry?.comment && typeof entry.comment === "object" ? entry.comment : null;
    if (!comment) {
        return null;
    }

    const sourceTextHash = String(comment.sourceTextHash || "").trim();
    const translatedText = String(comment.translatedText || "").trim();
    if (!sourceTextHash || !translatedText) {
        return null;
    }

    const normalized = {
        comment: {
            sourceTextHash,
            translatedText,
        },
    };
    if (Number.isFinite(Number(entry?.expiresAt))) {
        normalized.expiresAt = Number(entry.expiresAt);
    }
    return normalized;
}

async function readManyCommentTranslationEntriesFromKv(config, ids, options = {}) {
    if (!config) {
        return { comments: {}, cn: {} };
    }

    const refs = (Array.isArray(ids) ? ids : []).map((id) => ({ id, key: buildCommentTranslationCacheKey(id) })).filter((ref) => ref.key);
    const { entries, cnHints } = await readLocaleEntriesFromKv(config, refs, { locale: options.locale, hasRootData: hasCommentRootData });
    const comments = {};
    Object.entries(entries).forEach(([id, entry]) => {
        const normalized = normalizeCommentTranslationEntry(entry);
        if (normalized) {
            comments[id] = normalized;
        }
    });
    const cn = {};
    Object.entries(cnHints).forEach(([id, entry]) => {
        const normalized = normalizeCommentTranslationEntry(entry);
        if (normalized) {
            cn[id] = normalized;
        }
    });
    return { comments, cn };
}

async function writeManyCommentTranslationEntriesToKv(config, entriesById, options = {}) {
    if (!config) {
        return;
    }

    // 评论翻译 90 天 TTL 写进数据字段，正文变更由 sourceTextHash 兜底；不再发送 EXPIRE
    const now = Date.now();
    const cnById = options.cn && typeof options.cn === "object" ? options.cn : {};
    const items = [];
    Object.entries(entriesById || {}).forEach(([id, rawEntry]) => {
        const entry = normalizeCommentTranslationEntry(rawEntry);
        const key = buildCommentTranslationCacheKey(id);
        if (!entry || !key) {
            return;
        }
        const cnEntry = normalizeCommentTranslationEntry(cnById[id]);
        items.push({
            key,
            locale: options.locale,
            entry: { ...entry, expiresAt: now + COMMENT_TRANSLATION_TTL_SECONDS * 1000 },
            cnData: cnEntry ? { ...cnEntry, expiresAt: now + COMMENT_TRANSLATION_TTL_SECONDS * 1000 } : null,
        });
    });
    await writeLocaleEntriesToKv(config, items, { rootFields: COMMENT_ROOT_FIELDS });
}

module.exports = {
    buildCommentTranslationCacheKey,
    normalizeCommentTranslationEntry,
    readManyCommentTranslationEntriesFromKv,
    writeManyCommentTranslationEntriesToKv,
};
