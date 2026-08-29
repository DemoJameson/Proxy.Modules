const { CACHE_STATUS, PARTIAL_FOUND_TTL_SECONDS, IMAGE_NOT_FOUND_TTL_SECONDS, IMAGE_GROUPS, normalizeImageEntry } = require("./normalize");

const { jsonGetManyKv, pipelineKv, parseRedisJsonValue } = require("./kv-client");

function buildImageCacheKey(group, lookupKey) {
    return buildImageCacheKeyForMode("chinese", group, lookupKey);
}

function normalizeImageCacheMode(mode) {
    const normalized = String(mode || "")
        .trim()
        .toLowerCase();
    return normalized === "original" ? "original" : "chinese";
}

function buildImageCacheKeyForMode(mode, group, lookupKey) {
    const normalizedMode = normalizeImageCacheMode(mode);
    const normalizedGroup = IMAGE_GROUPS.includes(group) ? group : "";
    const normalizedLookupKey = String(lookupKey || "").trim();
    if (!normalizedGroup || !normalizedLookupKey) {
        return "";
    }
    return `trakt:image:${normalizedMode}:${normalizedGroup}:${normalizedLookupKey}`;
}

function parseCachedImageEntry(value) {
    const parsed = parseRedisJsonValue(value);
    return parsed ? normalizeImageEntry(parsed) : null;
}

async function readManyImageGroupsFromKv(config, groupsByGroup) {
    if (!config) {
        return Object.fromEntries(IMAGE_GROUPS.map((group) => [group, {}]));
    }

    const refs = IMAGE_GROUPS.flatMap((group) => {
        const ids = groupsByGroup[group] || [];
        return ids.map((id) => ({
            group,
            id,
            key: buildImageCacheKeyForMode(groupsByGroup.mode, group, id),
        }));
    });
    const results = await jsonGetManyKv(
        config,
        refs.map((ref) => ref.key),
    );
    const entries = Object.fromEntries(IMAGE_GROUPS.map((group) => [group, {}]));
    refs.forEach((ref, index) => {
        const imageEntry = parseCachedImageEntry(results[index]);
        if (imageEntry) {
            entries[ref.group][ref.id] = imageEntry;
        }
    });
    return entries;
}

function buildWriteManyImageCommands(group, entriesById, mode = "chinese") {
    const msetArgs = [];
    const ttlCommands = [];
    const now = Date.now();
    Object.entries(entriesById).forEach(([id, rawEntry]) => {
        const entry = normalizeImageEntry(rawEntry, now);
        if (!entry) {
            return;
        }
        const key = buildImageCacheKeyForMode(mode, group, id);
        if (!key) {
            return;
        }
        msetArgs.push(key, "$", JSON.stringify(entry));
        const fields = Object.values(entry);
        const hasNotFound = fields.some((field) => field?.status === CACHE_STATUS.NOT_FOUND);
        const hasPartialFound = fields.some((field) => field?.status === CACHE_STATUS.PARTIAL_FOUND);
        if (hasNotFound) {
            ttlCommands.push(["EXPIRE", key, IMAGE_NOT_FOUND_TTL_SECONDS]);
        } else if (hasPartialFound) {
            ttlCommands.push(["EXPIRE", key, PARTIAL_FOUND_TTL_SECONDS]);
        }
    });
    return msetArgs.length > 0 ? [["JSON.MSET", ...msetArgs], ...ttlCommands] : [];
}

async function writeManyImageGroupsToKv(config, groupsByGroup) {
    if (!config) {
        return;
    }

    const modes = groupsByGroup?.modes && typeof groupsByGroup.modes === "object" ? groupsByGroup.modes : null;
    const commands = (modes ? Object.entries(modes) : []).flatMap(([mode, groups]) =>
        Object.entries(groups || {}).flatMap(([group, entriesById]) => (IMAGE_GROUPS.includes(group) ? buildWriteManyImageCommands(group, entriesById || {}, mode) : [])),
    );
    if (commands.length === 0) {
        return;
    }

    await pipelineKv(config, commands);
}

module.exports = {
    buildImageCacheKey,
    normalizeImageCacheMode,
    buildImageCacheKeyForMode,
    parseCachedImageEntry,
    readManyImageGroupsFromKv,
    buildWriteManyImageCommands,
    writeManyImageGroupsToKv,
};
