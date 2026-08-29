const {
  jsonGetManyKv,
  pipelineKv,
  parseRedisJsonValue,
} = require("./kv-client");

function buildCommentTranslationCacheKey(commentId) {
  const normalizedCommentId = String(commentId || "").trim();
  if (!/^\d+$/.test(normalizedCommentId)) {
    return "";
  }
  return `trakt:comment-translation:${normalizedCommentId}`;
}

const COMMENT_TRANSLATION_TTL_SECONDS = 90 * 24 * 60 * 60;

function normalizeCommentTranslationEntry(entry) {
  const comment =
    entry?.comment && typeof entry.comment === "object" ? entry.comment : null;
  if (!comment) {
    return null;
  }

  const sourceTextHash = String(comment.sourceTextHash || "").trim();
  const translatedText = String(comment.translatedText || "").trim();
  if (!sourceTextHash || !translatedText) {
    return null;
  }

  return {
    comment: {
      sourceTextHash,
      translatedText,
    },
  };
}

function parseCommentTranslationEntry(value) {
  const parsed = parseRedisJsonValue(value);
  return parsed ? normalizeCommentTranslationEntry(parsed) : null;
}

async function readManyCommentTranslationEntriesFromKv(config, ids) {
  if (!config) {
    return { comments: {} };
  }

  const refs = (Array.isArray(ids) ? ids : [])
    .map((id) => ({ id, key: buildCommentTranslationCacheKey(id) }))
    .filter((ref) => ref.key);
  const results = await jsonGetManyKv(
    config,
    refs.map((ref) => ref.key),
  );
  const comments = {};
  refs.forEach((ref, index) => {
    const entry = parseCommentTranslationEntry(results[index]);
    if (entry) {
      comments[ref.id] = entry;
    }
  });
  return { comments };
}

async function writeManyCommentTranslationEntriesToKv(config, entriesById) {
  if (!config) {
    return;
  }

  // 评论翻译 90 天 TTL，正文变更由 sourceTextHash 兜底
  const msetArgs = [];
  const ttlCommands = [];
  Object.entries(entriesById || {}).forEach(([id, rawEntry]) => {
    const entry = normalizeCommentTranslationEntry(rawEntry);
    const key = buildCommentTranslationCacheKey(id);
    if (!entry || !key) {
      return;
    }
    msetArgs.push(key, "$", JSON.stringify(entry));
    ttlCommands.push(["EXPIRE", key, COMMENT_TRANSLATION_TTL_SECONDS]);
  });
  if (msetArgs.length === 0) {
    return;
  }

  await pipelineKv(config, [["JSON.MSET", ...msetArgs], ...ttlCommands]);
}

module.exports = {
  buildCommentTranslationCacheKey,
  normalizeCommentTranslationEntry,
  readManyCommentTranslationEntriesFromKv,
  writeManyCommentTranslationEntriesToKv,
};
