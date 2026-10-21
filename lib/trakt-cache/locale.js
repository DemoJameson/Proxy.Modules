// 中文地区字段：cn 简体、tw 台湾繁体、hk 香港繁体。
// 旧数据是根字段平铺（等价于 cn），写入时统一折叠到 cn/tw/hk 字段并清空根字段。
const { evalKv, jsonGetManyKv, parseRedisJsonValue } = require("./kv-client");

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

// 脚本内只调用一次 JSON.MGET 和一次 JSON.MSET；Upstash 计费为 EVAL + 2 次 redis.call = 3 条命令。
// allow-key-locking 避免默认全局锁；所有实际访问的 key 都通过 KEYS 传入。
const LOCALE_WRITE_SCRIPT = `#!lua flags=allow-key-locking
local payload = cjson.decode(ARGV[1])
local rootFields = payload.rootFields or {}
local writesByKey = payload.writes or {}
local values = redis.call('JSON.MGET', unpack(KEYS), '$')
local msetArgs = {}

local function decodeValue(value)
    if value == nil or value == false or value == cjson.null then
        return nil
    end
    if type(value) == 'table' then
        if #value == 0 then
            return nil
        end
        value = value[1]
    end
    if type(value) == 'string' then
        local ok, decoded = pcall(cjson.decode, value)
        if ok and decoded ~= cjson.null then
            return decoded
        end
        return nil
    end
    if type(value) == 'table' then
        return value
    end
    return nil
end

local function appendWrite(key, path, value)
    table.insert(msetArgs, key)
    table.insert(msetArgs, path)
    table.insert(msetArgs, cjson.encode(value))
end

for index, key in ipairs(KEYS) do
    local doc = decodeValue(values[index])
    local writes = writesByKey[index] or {}
    if doc ~= nil then
        for _, item in ipairs(writes) do
            if item.locale == 'cn' then
                appendWrite(key, '$.cn', item.entry)
                for _, field in ipairs(rootFields) do
                    table.insert(msetArgs, key)
                    table.insert(msetArgs, '$.' .. field)
                    table.insert(msetArgs, 'null')
                end
            else
                if item.cnData ~= nil then
                    appendWrite(key, '$.cn', item.cnData)
                    for _, field in ipairs(rootFields) do
                        table.insert(msetArgs, key)
                        table.insert(msetArgs, '$.' .. field)
                        table.insert(msetArgs, 'null')
                    end
                end
                appendWrite(key, '$.' .. item.locale, item.entry)
            end
        end
    else
        local rootDoc = {}
        for _, item in ipairs(writes) do
            if item.locale == 'cn' then
                rootDoc.cn = item.entry
            else
                if item.cnData ~= nil then
                    rootDoc.cn = item.cnData
                end
                rootDoc[item.locale] = item.entry
            end
        end
        table.insert(msetArgs, key)
        table.insert(msetArgs, '$')
        table.insert(msetArgs, cjson.encode(rootDoc))
    end
end

if #msetArgs == 0 then
    return 0
end

redis.call('JSON.MSET', unpack(msetArgs))
return #KEYS
`;

async function writeLocaleEntriesToKv(config, items, options = {}) {
    if (!config) {
        return;
    }

    const itemsByKey = new Map();
    (Array.isArray(items) ? items : []).forEach((item) => {
        if (!item?.key || !item?.entry) {
            return;
        }
        const keyItems = itemsByKey.get(item.key) || [];
        keyItems.push(item);
        itemsByKey.set(item.key, keyItems);
    });
    if (itemsByKey.size === 0) {
        return;
    }

    const keys = [...itemsByKey.keys()];
    const writes = keys.map((key) =>
        (itemsByKey.get(key) || []).map((item) => ({
            locale: normalizeLocale(item.locale),
            entry: item.entry,
            ...(item.cnData && typeof item.cnData === "object" ? { cnData: item.cnData } : {}),
        })),
    );
    await evalKv(config, LOCALE_WRITE_SCRIPT, keys, [
        JSON.stringify({
            rootFields: Array.isArray(options.rootFields) ? options.rootFields : [],
            writes,
        }),
    ]);
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
    hasLocaleField,
    isExpiredEntry,
    LOCALE_WRITE_SCRIPT,
    LOCALES,
    normalizeLocale,
    pickLocaleEntry,
    readLocaleEntriesFromKv,
    writeLocaleEntriesToKv,
};
