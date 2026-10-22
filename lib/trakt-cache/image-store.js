const { IMAGE_FIELDS, IMAGE_GROUPS, normalizeImageEntry } = require("./normalize");

const { parseRedisJsonValue } = require("./kv-client");

const { normalizeLocale, readLocaleEntriesFromKv, writeLocaleEntriesToKv } = require("./locale");

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
    return `image:${normalizedMode}:${normalizedGroup}:${normalizedLookupKey}`;
}

function parseCachedImageEntry(value) {
    const parsed = parseRedisJsonValue(value);
    return parsed ? normalizeImageEntry(parsed) : null;
}

// 图片过期时间写在 poster/logo 字段内（EXPIRE 已移除）：读取时过滤已过期字段，与翻译/人名等 store 的读取过滤保持一致
function filterExpiredImageFields(entry, now = Date.now()) {
    if (!entry) {
        return null;
    }
    const filtered = {};
    IMAGE_FIELDS.forEach((field) => {
        const fieldEntry = entry[field];
        if (!fieldEntry || typeof fieldEntry !== "object") {
            return;
        }
        const expiresAt = Number(fieldEntry.expiresAt);
        if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now) {
            return;
        }
        filtered[field] = fieldEntry;
    });
    return Object.keys(filtered).length > 0 ? filtered : null;
}

function parseCachedImageEntryForRead(value, now = Date.now()) {
    return filterExpiredImageFields(parseCachedImageEntry(value), now);
}

// readLocaleEntriesFromKv 默认只看根级 expiresAt；图片的 TTL 在 poster/logo 字段内。
function isImageEntryExpired(entry, now = Date.now()) {
    if (!entry || typeof entry !== "object") {
        return true;
    }
    const fields = IMAGE_FIELDS.filter((field) => entry[field] && typeof entry[field] === "object");
    if (fields.length === 0) {
        return true;
    }
    return fields.every((field) => {
        const expiresAt = Number(entry[field]?.expiresAt);
        return Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now;
    });
}

async function readManyImageGroupsFromKv(config, groupsByGroup) {
    if (!config) {
        return Object.fromEntries(IMAGE_GROUPS.map((group) => [group, {}]));
    }

    const readLocale = groupsByGroup.mode === "original" ? "cn" : normalizeLocale(groupsByGroup.locale);
    const refs = IMAGE_GROUPS.flatMap((group) => {
        const ids = groupsByGroup[group] || [];
        return ids.map((id) => ({
            group,
            id,
            refId: `${group}:${id}`,
            key: buildImageCacheKeyForMode(groupsByGroup.mode, group, id),
        }));
    });
    const { entries: rawEntries, cnHints: rawCnHints } = await readLocaleEntriesFromKv(
        config,
        refs.map((ref) => ({ id: ref.refId, key: ref.key })),
        { locale: readLocale, isExpired: isImageEntryExpired },
    );
    const entries = Object.fromEntries(IMAGE_GROUPS.map((group) => [group, {}]));
    const cnHints = Object.fromEntries(IMAGE_GROUPS.map((group) => [group, {}]));
    const now = Date.now();
    refs.forEach((ref) => {
        const imageEntry = parseCachedImageEntryForRead(rawEntries[ref.refId], now);
        if (imageEntry) {
            entries[ref.group][ref.id] = imageEntry;
            return;
        }
        const cnEntry = parseCachedImageEntryForRead(rawCnHints[ref.refId], now);
        if (cnEntry) {
            cnHints[ref.group][ref.id] = cnEntry;
        }
    });
    return { ...entries, cn: cnHints };
}

// 图片过期时间写在 poster/logo 字段内，不再发送 EXPIRE
function buildWriteManyImageItems(group, entriesById, mode = "chinese", options = {}) {
    const now = Date.now();
    const cnById = options.cn && typeof options.cn === "object" ? options.cn : {};
    const items = [];
    Object.entries(entriesById).forEach(([id, rawEntry]) => {
        const entry = normalizeImageEntry(rawEntry, now);
        if (!entry) {
            return;
        }
        const key = buildImageCacheKeyForMode(mode, group, id);
        if (!key) {
            return;
        }
        const cnEntry = normalizeImageEntry(cnById[id], now);
        items.push({ key, locale: mode === "original" ? "cn" : options.locale, entry, cnData: cnEntry });
    });
    return items;
}

async function writeManyImageGroupsToKv(config, groupsByGroup) {
    if (!config) {
        return;
    }

    const modes = groupsByGroup?.modes && typeof groupsByGroup.modes === "object" ? groupsByGroup.modes : null;
    const cnModes = groupsByGroup?.cn && typeof groupsByGroup.cn === "object" ? groupsByGroup.cn : {};
    const items = (modes ? Object.entries(modes) : []).flatMap(([mode, groups]) =>
        Object.entries(groups || {}).flatMap(([group, entriesById]) =>
            IMAGE_GROUPS.includes(group) ? buildWriteManyImageItems(group, entriesById || {}, mode, { locale: groupsByGroup.locale, cn: cnModes[mode]?.[group] || {} }) : [],
        ),
    );
    await writeLocaleEntriesToKv(config, items);
}

module.exports = {
    buildImageCacheKey,
    filterExpiredImageFields,
    isImageEntryExpired,
    normalizeImageCacheMode,
    buildImageCacheKeyForMode,
    parseCachedImageEntry,
    readManyImageGroupsFromKv,
    buildWriteManyImageItems,
    writeManyImageGroupsToKv,
};
