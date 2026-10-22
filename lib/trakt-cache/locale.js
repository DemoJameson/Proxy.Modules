// 中文地区字段：cn 简体、tw 台湾繁体、hk 香港繁体。
// 每个地区使用独立 String key，避免不同地区互相覆盖。
const { mgetKv, msetKv, parseRedisJsonValue } = require("./kv-client");

const LOCALES = ["cn", "tw", "hk"];

function normalizeLocale(value) {
    const normalized = String(value || "")
        .trim()
        .toLowerCase();
    return LOCALES.includes(normalized) ? normalized : "cn";
}

function isExpiredEntry(entry, now = Date.now()) {
    if (!entry || typeof entry !== "object") {
        return false;
    }
    if (!Object.hasOwn(entry, "expiresAt")) {
        return false;
    }
    const expiresAt = Number(entry.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now;
}

function buildLocaleKey(baseKey, locale) {
    return `${baseKey}:${normalizeLocale(locale)}`;
}

async function readLocaleEntriesFromKv(config, refs, options = {}) {
    const list = Array.isArray(refs) ? refs : [];
    const entries = {};
    const cnHints = {};
    if (!config || list.length === 0) {
        return { entries, cnHints };
    }

    const locale = normalizeLocale(options.locale);
    const isExpired = typeof options.isExpired === "function" ? options.isExpired : isExpiredEntry;
    const keys = [];
    const keySet = new Set();
    const refKeys = list.map((ref) => {
        const targetKey = buildLocaleKey(ref.key, locale);
        const cnKey = buildLocaleKey(ref.key, "cn");
        [targetKey, cnKey].forEach((key) => {
            if (!keySet.has(key)) {
                keySet.add(key);
                keys.push(key);
            }
        });
        return { ref, targetKey, cnKey };
    });

    const values = await mgetKv(config, keys);
    const valueByKey = new Map(keys.map((key, index) => [key, parseRedisJsonValue(values[index])]));
    const now = Date.now();
    refKeys.forEach(({ ref, targetKey, cnKey }) => {
        const target = valueByKey.get(targetKey);
        if (target && !isExpired(target, now)) {
            entries[ref.id] = target;
            return;
        }
        if (locale === "cn") {
            return;
        }
        const cnData = valueByKey.get(cnKey);
        if (cnData && !isExpired(cnData, now) && options.collectCnHints !== false) {
            cnHints[ref.id] = cnData;
        }
    });
    return { entries, cnHints };
}

async function writeLocaleEntriesToKv(config, items) {
    if (!config) {
        return;
    }

    const entries = {};
    (Array.isArray(items) ? items : []).forEach((item) => {
        if (!item?.key || !item?.entry) {
            return;
        }
        const locale = normalizeLocale(item.locale);
        entries[buildLocaleKey(item.key, locale)] = item.entry;
        if (locale !== "cn" && item.cnData && typeof item.cnData === "object") {
            entries[buildLocaleKey(item.key, "cn")] = item.cnData;
        }
    });
    await msetKv(config, entries);
}

module.exports = {
    buildLocaleKey,
    isExpiredEntry,
    LOCALES,
    normalizeLocale,
    readLocaleEntriesFromKv,
    writeLocaleEntriesToKv,
};
