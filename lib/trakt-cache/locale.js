// 中文地区字段：cn 简体、tw 台湾繁体、hk 香港繁体。
// 旧数据是根字段平铺（等价于 cn），写入时统一折叠到 cn/tw/hk 字段并清空根字段。
const { jsonGetManyKv, parseRedisJsonValue } = require("./kv-client");

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

function hasLocaleField(doc) {
    return !!doc && typeof doc === "object" && LOCALES.some((locale) => doc[locale] !== undefined);
}

// 读取投影：cn 优先读 cn 字段、回退根字段；tw/hk 只读各自字段（未命中时不回退，避免大陆译名固化）。
// 旧形状文档在 tw/hk 请求下返回 cnData，供客户端在写入时原子折叠根字段。
function pickLocaleEntry(doc, locale, options = {}) {
    const normalizedLocale = normalizeLocale(locale);
    const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
    // 默认只把“没有地区字段的文档”当作旧根字段数据，避免把整份多地区文档误当条目返回
    const hasRootData = typeof options.hasRootData === "function" ? options.hasRootData : (value) => !!value && typeof value === "object" && !hasLocaleField(value);
    const isExpired = typeof options.isExpired === "function" ? options.isExpired : isExpiredEntry;
    if (!doc || typeof doc !== "object") {
        return { entry: null, cnData: null };
    }
    const localeEntry = doc[normalizedLocale] && typeof doc[normalizedLocale] === "object" ? doc[normalizedLocale] : null;
    if (localeEntry && !isExpired(localeEntry, now)) {
        return { entry: localeEntry, cnData: null };
    }

    // 旧根字段（等价于 cn）：cn 优先读本地区字段、缺失或过期时回退根字段；
    // tw/hk 不回退，但在没有 cn 字段时把根数据作为 cn 提示回带，供客户端写回时折叠
    const rootEntry = hasRootData(doc) ? doc : null;
    const validRootEntry = rootEntry && !isExpired(rootEntry, now) ? rootEntry : null;
    if (normalizedLocale === "cn") {
        return { entry: validRootEntry, cnData: null };
    }
    return { entry: null, cnData: doc.cn === undefined ? validRootEntry : null };
}

// Upstash/Vercel KV REST 的 pipeline 参数只接受字符串或数字：JSON 值必须序列化成字符串，
// 清空根字段用字符串 "null"（RedisJSON 会写入 JSON null，读取侧按缺失处理）。
function stringifyJsonValue(value) {
    return JSON.stringify(value);
}

// 写入三元组：cn 写入把根字段折叠进 cn 并清空根字段；tw/hk 写入在拿到 cn 数据时同样折叠，拿不到则不动根字段。
function buildLocaleWriteTriples(key, locale, entry, options = {}) {
    const normalizedLocale = normalizeLocale(locale);
    const rootFields = Array.isArray(options.rootFields) ? options.rootFields : [];
    const triples = [];
    if (normalizedLocale === "cn") {
        triples.push(key, "$.cn", stringifyJsonValue(entry));
        rootFields.forEach((field) => {
            triples.push(key, `$.${field}`, "null");
        });
        return triples;
    }
    if (options.cnData && typeof options.cnData === "object") {
        triples.push(key, "$.cn", stringifyJsonValue(options.cnData));
        rootFields.forEach((field) => {
            triples.push(key, `$.${field}`, "null");
        });
    }
    triples.push(key, `$.${normalizedLocale}`, stringifyJsonValue(entry));
    return triples;
}

// 先给每个 key 发一条 JSON.SET ... NX 建空文档：真实 RedisJSON 不允许对不存在的 key 写非根路径，
// NX 保证已存在的文档（可能已有其它地区字段）不会被覆盖；随后一条 JSON.MSET 原子写入，不发送任何 EXPIRE/PTTL。
function buildLocaleWriteCommands(items, options = {}) {
    const triples = [];
    const keys = [];
    (Array.isArray(items) ? items : []).forEach((item) => {
        if (!item?.key || !item?.entry) {
            return;
        }
        keys.push(item.key);
        triples.push(...buildLocaleWriteTriples(item.key, item.locale, item.entry, { ...options, cnData: item.cnData }));
    });
    if (triples.length === 0) {
        return [];
    }
    const createCommands = [...new Set(keys)].map((key) => ["JSON.SET", key, "$", "{}", "NX"]);
    return [...createCommands, ["JSON.MSET", ...triples]];
}

async function readLocaleEntriesFromKv(config, refs, options = {}) {
    const list = Array.isArray(refs) ? refs : [];
    const entries = {};
    const cnHints = {};
    if (!config || list.length === 0) {
        return { entries, cnHints };
    }
    const results = await jsonGetManyKv(
        config,
        list.map((ref) => ref.key),
    );
    list.forEach((ref, index) => {
        const doc = parseRedisJsonValue(results[index]);
        const { entry, cnData } = pickLocaleEntry(doc, options.locale, options);
        if (entry) {
            entries[ref.id] = entry;
        }
        if (cnData && options.collectCnHints !== false) {
            cnHints[ref.id] = cnData;
        }
    });
    return { entries, cnHints };
}

module.exports = {
    buildLocaleWriteCommands,
    buildLocaleWriteTriples,
    hasLocaleField,
    isExpiredEntry,
    LOCALES,
    normalizeLocale,
    pickLocaleEntry,
    readLocaleEntriesFromKv,
};
