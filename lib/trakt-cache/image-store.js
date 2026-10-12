const { IMAGE_FIELDS, IMAGE_GROUPS, normalizeImageEntry } = require("./normalize");

const { jsonGetManyKv, parseRedisJsonValue, pipelineKv } = require("./kv-client");

const { buildLocaleWriteCommands, normalizeLocale } = require("./locale");

const IMAGE_ROOT_FIELDS = ["poster", "logo"];

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
            key: buildImageCacheKeyForMode(groupsByGroup.mode, group, id),
        }));
    });
    const results = await jsonGetManyKv(
        config,
        refs.map((ref) => ref.key),
    );
    const entries = Object.fromEntries(IMAGE_GROUPS.map((group) => [group, {}]));
    const cnHints = Object.fromEntries(IMAGE_GROUPS.map((group) => [group, {}]));
    const now = Date.now();
    refs.forEach((ref, index) => {
        const doc = parseRedisJsonValue(results[index]);
        const hasLocale = doc && typeof doc === "object" && ["cn", "tw", "hk"].some((locale) => doc[locale] !== undefined);
        if (hasLocale) {
            const imageEntry = parseCachedImageEntryForRead(doc[readLocale] ?? null, now);
            if (imageEntry) {
                entries[ref.group][ref.id] = imageEntry;
                return;
            }
            // cn（含 original 档位）回退旧根 poster/logo；tw/hk 不回退，只回带 cn 提示
            const fallbackRootEntry = parseCachedImageEntryForRead(doc, now);
            if (!fallbackRootEntry) {
                return;
            }
            if (readLocale === "cn") {
                entries[ref.group][ref.id] = fallbackRootEntry;
                return;
            }
            if (doc.cn === undefined) {
                cnHints[ref.group][ref.id] = fallbackRootEntry;
            }
            return;
        }
        const rootEntry = parseCachedImageEntryForRead(doc, now);
        if (!rootEntry) {
            return;
        }
        if (readLocale === "tw" || readLocale === "hk") {
            cnHints[ref.group][ref.id] = rootEntry;
            return;
        }
        entries[ref.group][ref.id] = rootEntry;
    });
    return { ...entries, cn: cnHints };
}

// 图片过期时间写在 poster/logo 字段内，不再发送 EXPIRE
function buildWriteManyImageCommands(group, entriesById, mode = "chinese", options = {}) {
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
    return buildLocaleWriteCommands(items, { rootFields: IMAGE_ROOT_FIELDS });
}

async function writeManyImageGroupsToKv(config, groupsByGroup) {
    if (!config) {
        return;
    }

    const modes = groupsByGroup?.modes && typeof groupsByGroup.modes === "object" ? groupsByGroup.modes : null;
    const cnModes = groupsByGroup?.cn && typeof groupsByGroup.cn === "object" ? groupsByGroup.cn : {};
    const commands = (modes ? Object.entries(modes) : []).flatMap(([mode, groups]) =>
        Object.entries(groups || {}).flatMap(([group, entriesById]) =>
            IMAGE_GROUPS.includes(group) ? buildWriteManyImageCommands(group, entriesById || {}, mode, { locale: groupsByGroup.locale, cn: cnModes[mode]?.[group] || {} }) : [],
        ),
    );
    if (commands.length === 0) {
        return;
    }

    await pipelineKv(config, commands);
}

module.exports = {
    buildImageCacheKey,
    filterExpiredImageFields,
    normalizeImageCacheMode,
    buildImageCacheKeyForMode,
    parseCachedImageEntry,
    readManyImageGroupsFromKv,
    buildWriteManyImageCommands,
    writeManyImageGroupsToKv,
};
