const {
  jsonGetManyKv,
  pipelineKv,
  parseRedisJsonValue,
} = require("./kv-client");

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
  // TMDB 查询无中文名的负缓存条目：{ notFound: true }
  if (entry?.notFound === true) {
    return { notFound: true };
  }

  const name =
    entry?.name && typeof entry.name === "object" ? entry.name : null;
  if (!name) {
    return null;
  }

  const sourceTextHash = String(name.sourceTextHash || "").trim();
  const translatedText = String(name.translatedText || "").trim();
  const source = String(name.source || "")
    .trim()
    .toLowerCase();
  if (
    !sourceTextHash ||
    !translatedText ||
    !PERSON_NAME_SOURCES.includes(source)
  ) {
    return null;
  }

  return {
    name: {
      sourceTextHash,
      translatedText,
      source,
    },
  };
}

function parsePersonNameEntry(value) {
  const parsed = parseRedisJsonValue(value);
  return parsed ? normalizePersonNameEntry(parsed) : null;
}

async function readManyPersonNameEntriesFromKv(config, ids) {
  if (!config) {
    return { people: {} };
  }

  const refs = (Array.isArray(ids) ? ids : [])
    .map((id) => ({ id, key: buildPersonNameCacheKey(id) }))
    .filter((ref) => ref.key);
  const results = await jsonGetManyKv(
    config,
    refs.map((ref) => ref.key),
  );
  const people = {};
  refs.forEach((ref, index) => {
    const entry = parsePersonNameEntry(results[index]);
    if (entry) {
      people[ref.id] = entry;
    }
  });
  return { people };
}

async function writeManyPersonNameEntriesToKv(config, entriesById) {
  if (!config) {
    return;
  }

  // tmdb 姓名 90 天、google 姓名 30 天、无中文名负缓存 7 天 TTL
  const msetArgs = [];
  const ttlCommands = [];
  Object.entries(entriesById || {}).forEach(([id, rawEntry]) => {
    const entry = normalizePersonNameEntry(rawEntry);
    const key = buildPersonNameCacheKey(id);
    if (!entry || !key) {
      return;
    }
    const ttlSeconds = entry.notFound
      ? PERSON_NAME_NOT_FOUND_TTL_SECONDS
      : entry.name?.source === "google"
        ? PERSON_NAME_GOOGLE_TTL_SECONDS
        : PERSON_NAME_TTL_SECONDS;
    msetArgs.push(key, "$", JSON.stringify(entry));
    ttlCommands.push(["EXPIRE", key, ttlSeconds]);
  });
  if (msetArgs.length === 0) {
    return;
  }

  await pipelineKv(config, [["JSON.MSET", ...msetArgs], ...ttlCommands]);
}

module.exports = {
  buildPersonNameCacheKey,
  normalizePersonNameEntry,
  readManyPersonNameEntriesFromKv,
  writeManyPersonNameEntriesToKv,
};
