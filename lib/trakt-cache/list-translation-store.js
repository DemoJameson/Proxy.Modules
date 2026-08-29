const {
  jsonGetManyKv,
  pipelineKv,
  parseRedisJsonValue,
} = require("./kv-client");

function buildListTranslationCacheKey(listId) {
  const normalizedListId = String(listId || "").trim();
  if (!/^\d+$/.test(normalizedListId)) {
    return "";
  }
  return `trakt:list-translation:${normalizedListId}`;
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
    const fieldEntry =
      entry[field] && typeof entry[field] === "object" ? entry[field] : null;
    const sourceTextHash = String(fieldEntry?.sourceTextHash || "").trim();
    const translatedText = String(fieldEntry?.translatedText || "").trim();
    if (sourceTextHash && translatedText) {
      normalized[field] = {
        sourceTextHash,
        translatedText,
      };
    }
  });
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function parseListTranslationEntry(value) {
  const parsed = parseRedisJsonValue(value);
  return parsed ? normalizeListTranslationEntry(parsed) : null;
}

async function readManyListTranslationEntriesFromKv(config, ids) {
  if (!config) {
    return { lists: {} };
  }

  const refs = (Array.isArray(ids) ? ids : [])
    .map((id) => ({ id, key: buildListTranslationCacheKey(id) }))
    .filter((ref) => ref.key);
  const results = await jsonGetManyKv(
    config,
    refs.map((ref) => ref.key),
  );
  const lists = {};
  refs.forEach((ref, index) => {
    const entry = parseListTranslationEntry(results[index]);
    if (entry) {
      lists[ref.id] = entry;
    }
  });
  return { lists };
}

async function writeManyListTranslationEntriesToKv(config, entriesById) {
  if (!config) {
    return;
  }

  // 片单翻译 90 天 TTL，正文变更由 sourceTextHash 兜底
  const msetArgs = [];
  const ttlCommands = [];
  Object.entries(entriesById || {}).forEach(([id, rawEntry]) => {
    const entry = normalizeListTranslationEntry(rawEntry);
    const key = buildListTranslationCacheKey(id);
    if (!entry || !key) {
      return;
    }
    msetArgs.push(key, "$", JSON.stringify(entry));
    ttlCommands.push(["EXPIRE", key, LIST_TRANSLATION_TTL_SECONDS]);
  });
  if (msetArgs.length === 0) {
    return;
  }

  await pipelineKv(config, [["JSON.MSET", ...msetArgs], ...ttlCommands]);
}

module.exports = {
  buildListTranslationCacheKey,
  normalizeListTranslationEntry,
  readManyListTranslationEntriesFromKv,
  writeManyListTranslationEntriesToKv,
};
