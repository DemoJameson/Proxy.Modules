const {
  jsonGetManyKv,
  pipelineKv,
  parseRedisJsonValue,
} = require("./kv-client");

const DOUBAN_TARGET_TYPES = ["movies", "shows"];
const DOUBAN_TTL_SECONDS = 30 * 24 * 60 * 60;

function buildCreditCacheKey(targetType, traktId) {
  const normalizedTargetType = DOUBAN_TARGET_TYPES.includes(targetType)
    ? targetType
    : "";
  const normalizedTraktId = String(traktId || "").trim();
  if (!normalizedTargetType || !normalizedTraktId) {
    return "";
  }
  return `trakt:credit:${normalizedTargetType}:${normalizedTraktId}`;
}

function parseCreditEntry(value) {
  const parsed = parseRedisJsonValue(value);
  return parsed && typeof parsed === "object" ? parsed : null;
}

const CREDIT_ENTRY_FIELDS = ["subject", "seasons", "credits"];

function isCreditEntryTargetTypeValid(entry, expectedType) {
  const subjectType = entry?.subject?.targetType;
  if (subjectType === undefined || subjectType === null || subjectType === "") {
    return true;
  }
  return String(subjectType).trim().toLowerCase() === expectedType;
}

function mergeCreditEntriesByField(existing, incoming) {
  const merged = {};
  const allIds = new Set([
    ...Object.keys(existing || {}),
    ...Object.keys(incoming || {}),
  ]);
  for (const id of allIds) {
    const existingEntry =
      existing?.[id] && typeof existing[id] === "object" ? existing[id] : {};
    const incomingEntry =
      incoming?.[id] && typeof incoming[id] === "object" ? incoming[id] : {};
    const mergedEntry = { ...existingEntry };
    for (const field of CREDIT_ENTRY_FIELDS) {
      if (incomingEntry[field] && typeof incomingEntry[field] === "object") {
        mergedEntry[field] = incomingEntry[field];
      }
    }
    if (Object.keys(mergedEntry).length > 0) {
      merged[id] = mergedEntry;
    }
  }
  return merged;
}

function isCompleteCreditEntry(entry) {
  return CREDIT_ENTRY_FIELDS.every(
    (field) => entry[field] && typeof entry[field] === "object",
  );
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
  const results = await jsonGetManyKv(
    config,
    refs.map((ref) => ref.key),
  );
  const entries = Object.fromEntries(
    DOUBAN_TARGET_TYPES.map((type) => [type, {}]),
  );
  refs.forEach((ref, index) => {
    const creditEntry = parseCreditEntry(results[index]);
    if (creditEntry && isCreditEntryTargetTypeValid(creditEntry, ref.type)) {
      entries[ref.type][ref.id] = creditEntry;
    }
  });
  return entries;
}

function buildWriteManyCreditCommands(targetType, entriesById) {
  const msetArgs = [];
  const ttlCommands = [];
  Object.entries(entriesById).forEach(([id, rawEntry]) => {
    const entry = rawEntry && typeof rawEntry === "object" ? rawEntry : null;
    if (!entry) {
      return;
    }
    const key = buildCreditCacheKey(targetType, id);
    if (!key) {
      return;
    }
    msetArgs.push(key, "$", JSON.stringify(entry));
    ttlCommands.push(["EXPIRE", key, DOUBAN_TTL_SECONDS]);
  });
  return msetArgs.length > 0
    ? [["JSON.MSET", ...msetArgs], ...ttlCommands]
    : [];
}

async function writeManyCreditEntriesToKv(config, entriesByType) {
  if (!config) {
    return;
  }

  const commands = DOUBAN_TARGET_TYPES.flatMap((type) =>
    buildWriteManyCreditCommands(type, entriesByType?.[type] || {}),
  );
  if (commands.length === 0) {
    return;
  }

  await pipelineKv(config, commands);
}

module.exports = {
  DOUBAN_TARGET_TYPES,
  DOUBAN_TTL_SECONDS,
  buildCreditCacheKey,
  mergeCreditEntriesByField,
  splitCreditEntriesByCompleteness,
  readManyCreditEntriesFromKv,
  writeManyCreditEntriesToKv,
};
