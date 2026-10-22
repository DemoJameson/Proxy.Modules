import assert from "node:assert/strict";
import test from "node:test";
import { getPeopleTranslationCacheEntry, setPeopleTranslationCacheEntry } from "../trakt_simplified_chinese/src/features/people-name-cache.mjs";
import { convertChineseForLocale, normalizeChineseLocale } from "../trakt_simplified_chinese/src/shared/chinese-script-converter.mjs";
import { getImageCacheEntry, normalizeImageFieldEntry } from "../trakt_simplified_chinese/src/shared/media-image-replacement.mjs";
import { storeTranslationEntry } from "../trakt_simplified_chinese/src/shared/media-translation-backend.mjs";
import { containsChineseText, extractNormalizedTranslation, normalizeTranslations } from "../trakt_simplified_chinese/src/shared/translation-cache.mjs";
import {
    clearCurrentSeason,
    createEmptyUnifiedCache,
    FOUND_TTL_MS,
    GOOGLE_PEOPLE_CACHE_MAX_BYTES,
    getAuthToken,
    getHashedFieldTranslation,
    loadCache,
    loadTamperAuthorization,
    loadUnifiedCache,
    normalizeUnifiedCache,
    pruneUnifiedCacheToLimit,
    saveAuthToken,
    saveCache,
    saveCommentTranslationCache,
    saveTamperAuthorization,
    setCurrentSeason,
    setHashedFieldTranslation,
    TAMPER_AUTHORIZATION_KEY,
    TAMPER_AUTHORIZATION_RECORD_LIMIT,
    TAMPER_AUTHORIZATION_TOKEN_LIMIT,
    UNIFIED_CACHE_KEY,
    UNIFIED_CACHE_REV_KEY,
    UNIFIED_CACHE_SCHEMA_VERSION,
} from "../trakt_simplified_chinese/src/utils/cache.mjs";

function createEnv(initialData = {}) {
    const data = {};
    Object.entries(initialData).forEach(([key, value]) => {
        data[key] = JSON.stringify(value);
    });

    let toStrCalls = 0;
    const getjsonCalls = new Map();
    return {
        data,
        getjson(key, defaultValue = null) {
            getjsonCalls.set(key, (getjsonCalls.get(key) ?? 0) + 1);
            if (!Object.hasOwn(data, key)) {
                return defaultValue;
            }

            try {
                return JSON.parse(data[key]);
            } catch {
                return defaultValue;
            }
        },
        setjson(value, key) {
            data[key] = JSON.stringify(value);
            return true;
        },
        toStr(value, fallback = "") {
            toStrCalls += 1;
            try {
                return JSON.stringify(value);
            } catch {
                return fallback;
            }
        },
        getToStrCalls() {
            return toStrCalls;
        },
        getjsonCallsFor(key) {
            return getjsonCalls.get(key) ?? 0;
        },
    };
}

function readStoredUnifiedCache(env) {
    return JSON.parse(String(env.data[UNIFIED_CACHE_KEY]));
}

function createStoredUnifiedCache(rev = 100) {
    const cache = createEmptyUnifiedCache();
    cache.rev = rev;
    return cache;
}

function estimateEntryMapBytes(env, entries) {
    return Object.entries(entries).reduce((total, [key, entry]) => {
        const serialized = env.toStr({ [key]: entry }, "");
        return total + Math.max(serialized.length - 2, 0);
    }, 0);
}

function createPeopleEntry(size, sourceTextHash = "person-name") {
    return {
        status: 1,
        name: "汤姆·汉克斯",
        sourceTextHash,
        source: "tmdb",
        expiresAt: Date.now() + 90 * 24 * 60 * 60 * 1000,
        biography: {
            sourceTextHash: `${sourceTextHash}-biography`,
            translatedText: "P".repeat(size),
        },
    };
}

test("cache utils: hashed field translation roundtrip works for comments cache shape", () => {
    const cache = {};

    assert.equal(setHashedFieldTranslation(cache, 9001, "comment", "Great movie", " 很棒的电影 ", "comment:translation"), true);
    assert.equal(getHashedFieldTranslation(cache, 9001, "comment", "Great movie", "comment:translation"), "很棒的电影");
    assert.equal(getHashedFieldTranslation(cache, 9001, "comment", "Another movie", "comment:translation"), "");
    assert.equal(cache["comment:translation:9001:cn"].comment.translatedText, "很棒的电影");
});

test("cache utils: 篡改授权独立 key 会截断超量的流程、token 与 pending", () => {
    const env = createEnv();
    const records = Array.from({ length: TAMPER_AUTHORIZATION_RECORD_LIMIT + 5 }, (_, index) => ({ id: `record-${index}` }));
    const tokens = Array.from({ length: TAMPER_AUTHORIZATION_TOKEN_LIMIT + 5 }, (_, index) => ({ accessToken: `access-${index}` }));
    const pending = Array.from({ length: TAMPER_AUTHORIZATION_RECORD_LIMIT + 5 }, (_, index) => ({ kind: "device_code", id: `pending-${index}` }));

    saveTamperAuthorization(env, { records, tokens, pending });
    const stored = loadTamperAuthorization(env);

    assert.equal(stored.records.length, TAMPER_AUTHORIZATION_RECORD_LIMIT);
    assert.equal(stored.tokens.length, TAMPER_AUTHORIZATION_TOKEN_LIMIT);
    assert.equal(stored.pending.length, TAMPER_AUTHORIZATION_RECORD_LIMIT);
    assert.equal(env.data[UNIFIED_CACHE_KEY], undefined, "篡改授权不再写 unified cache");
    assert.notEqual(env.data[TAMPER_AUTHORIZATION_KEY], undefined);
});

test("cache utils: normalizeUnifiedCache keeps comments cache in current nested shape", () => {
    const normalized = normalizeUnifiedCache({
        version: 5,
        rev: 123,
        maxBytes: 512,
        google: {
            comments: {
                "comment:translation:9001:cn": {
                    comment: {
                        sourceTextHash: "cafebabe",
                        translatedText: "很棒的电影",
                    },
                },
            },
        },
    });

    assert.equal(normalized.google.comments["comment:translation:9001:cn"].comment.translatedText, "很棒的电影");
    assert.equal(normalized.google.comments["comment:translation:9001:cn"].rev, undefined);
    assert.deepEqual(normalized.douban, {});
});

test("cache utils: normalizeUnifiedCache 保留豆瓣角色缓存摘要", () => {
    const now = Date.now();
    const expiresAt = now + 30 * 24 * 60 * 60 * 1000;
    const normalized = normalizeUnifiedCache({
        version: 9,
        douban: {
            "credit:shows:123": {
                subject: {
                    id: "35517044",
                    targetType: "shows",
                },
                seasons: {
                    ids: ["4707205", "", "4707205", "6312211"],
                },
                credits: {
                    王骁: ["张一昂", "", "张一昂"],
                },
                expiresAt,
            },
        },
    });

    assert.deepEqual(normalized.douban["credit:shows:123"].subject, {
        id: "35517044",
        targetType: "shows",
    });
    assert.deepEqual(normalized.douban["credit:shows:123"].seasons.ids, ["4707205", "6312211"]);
    assert.deepEqual(normalized.douban["credit:shows:123"].credits.王骁, ["张一昂"]);
    assert.equal(normalized.douban["credit:shows:123"].expiresAt, expiresAt);
});

test("cache utils: normalizeUnifiedCache 丢弃过期豆瓣缓存条目", () => {
    const now = Date.now();
    const expired = now - 1000;
    const fresh = now + 30 * 24 * 60 * 60 * 1000;
    const normalized = normalizeUnifiedCache({
        version: 12,
        douban: {
            "credit:shows:123": {
                subject: {
                    id: "35517044",
                    targetType: "shows",
                },
                credits: {
                    王骁: ["张一昂"],
                },
                expiresAt: fresh,
            },
            "credit:shows:456": {
                subject: {
                    id: "4707205",
                    targetType: "shows",
                },
                expiresAt: expired,
            },
        },
    });

    assert.equal(normalized.douban["credit:shows:123"].subject.id, "35517044");
    assert.equal(normalized.douban["credit:shows:456"], undefined);
});

test("cache utils: normalizeUnifiedCache 保留未过期图片 TTL 并移除过期字段", () => {
    const now = Date.now();
    const normalized = normalizeUnifiedCache({
        version: 7,
        trakt: {
            image: {
                "image:chinese:movies:123:cn": {
                    poster: {
                        status: 2,
                        url: "https://image.tmdb.org/t/p/original/partial.jpg",
                        expiresAt: now + 30 * 24 * 60 * 60 * 1000,
                    },
                    logo: {
                        status: 3,
                        expiresAt: now - 1000,
                    },
                },
                "image:chinese:movies:124:cn": {
                    poster: {
                        status: 3,
                        expiresAt: now - 1000,
                    },
                },
                "image:chinese:movies:125:cn": {
                    poster: {
                        status: 1,
                        url: "https://image.tmdb.org/t/p/original/found.jpg",
                    },
                },
            },
        },
    });

    assert.equal(normalized.trakt.image["image:chinese:movies:123:cn"].poster.status, 2);
    assert.equal(normalized.trakt.image["image:chinese:movies:123:cn"].logo, undefined);
    assert.equal(normalized.trakt.image["image:chinese:movies:124:cn"], undefined);
    assert.ok(normalized.trakt.image["image:chinese:movies:125:cn"].poster.expiresAt > Date.now());
    assert.ok(normalized.trakt.image["image:chinese:movies:125:cn"].poster.expiresAt <= Date.now() + FOUND_TTL_MS);
});

test("cache utils: 过期 FOUND 图片字段会被清理", () => {
    const expired = Date.now() - 1000;
    const normalized = normalizeUnifiedCache({
        version: UNIFIED_CACHE_SCHEMA_VERSION,
        trakt: {
            image: {
                "image:chinese:movies:126:cn": {
                    poster: {
                        status: 1,
                        url: "https://image.tmdb.org/t/p/original/expired.jpg",
                        expiresAt: expired,
                    },
                },
            },
        },
    });

    assert.equal(normalized.trakt.image["image:chinese:movies:126:cn"], undefined);
    assert.equal(normalizeImageFieldEntry({ status: 1, url: "https://image.tmdb.org/t/p/original/expired.jpg", expiresAt: expired }), null);
    assert.equal(
        getImageCacheEntry(
            {
                "image:chinese:movies:126:cn": {
                    poster: { status: 1, url: "https://image.tmdb.org/t/p/original/expired.jpg", expiresAt: expired },
                },
            },
            "movie",
            { traktId: 126, imageMode: "cn" },
        ),
        null,
    );
});

test("cache utils: pruneUnifiedCacheToLimit removes lower-priority entries first", () => {
    const env = createEnv();
    const cache = createEmptyUnifiedCache(3, 700);

    cache.google.comments.large = {
        comment: {
            sourceTextHash: "comments-large",
            translatedText: "A".repeat(420),
        },
    };
    cache.trakt.translation["translation:movies:1:cn"] = {
        status: 1,
        translation: {
            title: "保留标题",
            overview: "B".repeat(120),
        },
    };

    const pruned = pruneUnifiedCacheToLimit(env, cache, 3, 700);

    assert.equal(pruned.google.comments.large, undefined);
    assert.equal(pruned.trakt.translation["translation:movies:1:cn"].translation.title, "保留标题");
});

test("cache utils: pruneUnifiedCacheToLimit keeps people translations before media translations", () => {
    const env = createEnv();
    const cache = createEmptyUnifiedCache(3, 900);

    cache.google.people["person:1:cn"] = {
        status: 1,
        name: "汤姆·汉克斯",
        sourceTextHash: "person-name",
        source: "tmdb",
        expiresAt: Date.now() + 90 * 24 * 60 * 60 * 1000,
        biography: {
            sourceTextHash: "person-biography",
            translatedText: "A".repeat(180),
        },
    };
    cache.trakt.translation["translation:movies:1:cn"] = {
        status: 1,
        translation: {
            title: "保留标题",
            overview: "B".repeat(420),
        },
    };

    const pruned = pruneUnifiedCacheToLimit(env, cache, 3, 900);

    assert.equal(pruned.trakt.translation["translation:movies:1:cn"], undefined);
    assert.equal(pruned.google.people["person:1:cn"].name, "汤姆·汉克斯");
});

test("cache utils: pruneUnifiedCacheToLimit can prune douban cache before link ids", () => {
    const env = createEnv();
    const cache = createEmptyUnifiedCache(9, 900);
    cache.douban["credit:shows:123"] = {
        credits: {
            王骁: ["A".repeat(800)],
        },
        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    };
    cache.trakt.linkIds["123"] = {
        ids: {
            trakt: 123,
            tmdb: 456,
            imdb: "tt123",
        },
        language: "cn",
        title: "Original Movie",
    };

    const pruned = pruneUnifiedCacheToLimit(env, cache, 9, 900);

    assert.equal(pruned.douban["credit:shows:123"], undefined);
    assert.equal(pruned.trakt.linkIds["123"].ids.imdb, "tt123");
    assert.equal(pruned.trakt.linkIds["123"].title, "Original Movie");
});

test("cache utils: normalizeUnifiedCache preserves link ids source title", () => {
    const normalized = normalizeUnifiedCache({
        trakt: {
            linkIds: {
                123: {
                    ids: { trakt: 123, tmdb: 456 },
                    language: "en",
                    country: "US",
                    title: "Original Movie",
                },
            },
        },
    });

    assert.equal(normalized.trakt.linkIds["123"].title, "Original Movie");
});

test("cache utils: pruneUnifiedCacheToLimit caps oversized people translations even under total limit", () => {
    const env = createEnv();
    const cache = createEmptyUnifiedCache(3, GOOGLE_PEOPLE_CACHE_MAX_BYTES * 4);
    cache.google.people["small:cn"] = createPeopleEntry(128, "small");
    cache.google.people["large:cn"] = createPeopleEntry(GOOGLE_PEOPLE_CACHE_MAX_BYTES + 1024, "large");

    const pruned = pruneUnifiedCacheToLimit(env, cache, 3, GOOGLE_PEOPLE_CACHE_MAX_BYTES * 4);

    assert.equal(pruned.google.people["large:cn"], undefined);
    assert.equal(pruned.google.people["small:cn"].name, "汤姆·汉克斯");
    assert.ok(estimateEntryMapBytes(env, pruned.google.people) <= GOOGLE_PEOPLE_CACHE_MAX_BYTES);
});

test("cache utils: pruneUnifiedCacheToLimit prunes lower priorities before capped people entries", () => {
    const env = createEnv();
    const cache = createEmptyUnifiedCache(3, 900);
    cache.google.people["small:cn"] = createPeopleEntry(128, "small");
    cache.google.comments["large:cn"] = {
        comment: {
            sourceTextHash: "comments-large",
            translatedText: "C".repeat(900),
        },
    };

    const pruned = pruneUnifiedCacheToLimit(env, cache, 3, 900);

    assert.equal(pruned.google.comments["large:cn"], undefined);
    assert.equal(pruned.google.people["small:cn"].name, "汤姆·汉克斯");
});

test("cache utils: pruneUnifiedCacheToLimit keeps serialization calls bounded", () => {
    const env = createEnv();
    const cache = createEmptyUnifiedCache(3, 900);

    for (let index = 0; index < 12; index += 1) {
        cache.google.comments[String(index)] = {
            comment: {
                sourceTextHash: `hash-${index}`,
                translatedText: "X".repeat(180),
            },
        };
    }

    pruneUnifiedCacheToLimit(env, cache, 3, 900);

    assert.ok(env.getToStrCalls() <= 20, `expected bounded serialization calls, got ${env.getToStrCalls()}`);
});

test("cache utils: 同一次请求内多次 load 共享 unified cache 实例", () => {
    const env = createEnv({
        [UNIFIED_CACHE_KEY]: createStoredUnifiedCache(100),
        [UNIFIED_CACHE_REV_KEY]: 100,
    });

    const unifiedCache = loadUnifiedCache(env);
    const secondUnifiedCache = loadUnifiedCache(env);
    const translationCache = loadCache(env);

    assert.equal(unifiedCache, secondUnifiedCache);
    assert.equal(translationCache, unifiedCache.trakt.translation);
    assert.equal(env.getjsonCallsFor(UNIFIED_CACHE_KEY), 1);
});

test("cache utils: version 不匹配时清空旧 unified cache 且不做键迁移", () => {
    const oldCache = createStoredUnifiedCache(100);
    oldCache.version = 999;
    oldCache.trakt.translation["translation:movies:1:cn"] = {
        status: 1,
        translation: {
            title: "旧标题",
        },
    };
    oldCache.google.people["person:name:42:cn"] = createPeopleEntry(32);

    const env = createEnv({
        [UNIFIED_CACHE_KEY]: oldCache,
        [UNIFIED_CACHE_REV_KEY]: 100,
    });

    const unifiedCache = loadUnifiedCache(env);

    assert.equal(unifiedCache.version, createEmptyUnifiedCache().version);
    assert.deepEqual(unifiedCache.trakt.translation, {});
    assert.deepEqual(unifiedCache.google.people, {});
    assert.deepEqual(unifiedCache.douban, {});
    assert.equal(readStoredUnifiedCache(env).version, UNIFIED_CACHE_SCHEMA_VERSION);
    assert.deepEqual(readStoredUnifiedCache(env).trakt.translation, {}, "旧键不迁移，随旧版本一起丢弃");
});

test("cache utils: 无 revision 冲突时 save 不会重读完整 unified cache", () => {
    const env = createEnv({
        [UNIFIED_CACHE_KEY]: createStoredUnifiedCache(100),
        [UNIFIED_CACHE_REV_KEY]: 100,
    });

    const commentsCache = {
        "comment:translation:9001:cn": {
            comment: {
                sourceTextHash: "hash-9001",
                translatedText: "很棒的电影",
            },
        },
    };

    loadUnifiedCache(env);
    saveCommentTranslationCache(env, commentsCache);

    assert.equal(env.getjsonCallsFor(UNIFIED_CACHE_KEY), 1);
    assert.equal(readStoredUnifiedCache(env).google.comments["comment:translation:9001:cn"].comment.translatedText, "很棒的电影");
});

test("cache utils: revision 冲突时会重读最新 unified cache 并按桶合并", () => {
    const env = createEnv({
        [UNIFIED_CACHE_KEY]: createStoredUnifiedCache(100),
        [UNIFIED_CACHE_REV_KEY]: 100,
    });

    const translationCache = loadCache(env);
    translationCache["translation:movies:1:cn"] = {
        status: 1,
        translation: {
            title: "本地标题",
        },
    };

    const latestCache = createStoredUnifiedCache(101);
    latestCache.google.comments["comment:translation:9001:cn"] = {
        comment: {
            sourceTextHash: "hash-9001",
            translatedText: "外部评论",
        },
    };
    env.setjson(latestCache, UNIFIED_CACHE_KEY);
    env.setjson(101, UNIFIED_CACHE_REV_KEY);

    saveCache(env, translationCache);

    const storedCache = readStoredUnifiedCache(env);
    assert.equal(storedCache.trakt.translation["translation:movies:1:cn"].translation.title, "本地标题");
    assert.equal(storedCache.google.comments["comment:translation:9001:cn"].comment.translatedText, "外部评论");
    assert.ok(env.getjsonCallsFor(UNIFIED_CACHE_KEY) >= 2);
});

test("cache utils: 同桶 revision 冲突保持后写覆盖", () => {
    const env = createEnv({
        [UNIFIED_CACHE_KEY]: createStoredUnifiedCache(100),
        [UNIFIED_CACHE_REV_KEY]: 100,
    });

    const translationCache = loadCache(env);
    translationCache["translation:movies:1:cn"] = {
        status: 1,
        translation: {
            title: "本地标题",
        },
    };

    const latestCache = createStoredUnifiedCache(101);
    latestCache.trakt.translation["translation:movies:1:cn"] = {
        status: 1,
        translation: {
            title: "外部标题",
        },
    };
    env.setjson(latestCache, UNIFIED_CACHE_KEY);
    env.setjson(101, UNIFIED_CACHE_REV_KEY);

    saveCache(env, translationCache);

    assert.equal(readStoredUnifiedCache(env).trakt.translation["translation:movies:1:cn"].translation.title, "本地标题");
});

test("cache utils: body rev 落后于 sidecar rev 时不会把 sidecar rev 错记进 memo", () => {
    const staleBody = createStoredUnifiedCache(100);
    const env = createEnv({
        [UNIFIED_CACHE_KEY]: staleBody,
        [UNIFIED_CACHE_REV_KEY]: 101,
    });

    const unifiedCache = loadUnifiedCache(env);
    unifiedCache.trakt.translation["translation:movies:1:cn"] = {
        status: 1,
        translation: {
            title: "本地标题",
        },
    };

    saveCache(env, unifiedCache.trakt.translation);

    const storedCache = readStoredUnifiedCache(env);
    assert.equal(storedCache.rev > 101, true);
    assert.equal(storedCache.trakt.translation["translation:movies:1:cn"].translation.title, "本地标题");
    assert.equal(env.getjsonCallsFor(UNIFIED_CACHE_KEY) >= 2, true);
});

test("cache utils: body rev 领先于 sidecar rev 时会修复 sidecar", () => {
    const freshBody = createStoredUnifiedCache(101);
    const env = createEnv({
        [UNIFIED_CACHE_KEY]: freshBody,
        [UNIFIED_CACHE_REV_KEY]: 100,
    });

    const unifiedCache = loadUnifiedCache(env);

    assert.equal(unifiedCache.rev, 101);
    assert.equal(JSON.parse(String(env.data[UNIFIED_CACHE_REV_KEY])), 101);
});

test("containsChineseText: 纯中文标题返回 true", () => {
    assert.equal(containsChineseText("中文电影"), true);
});

test("containsChineseText: 纯英文标题返回 false", () => {
    assert.equal(containsChineseText("Original Movie"), false);
});

test("containsChineseText: 中英混合标题返回 true", () => {
    assert.equal(containsChineseText("Movie 中文标题"), true);
});

test("containsChineseText: 空字符串与 null 返回 false", () => {
    assert.equal(containsChineseText(""), false);
    assert.equal(containsChineseText(null), false);
    assert.equal(containsChineseText(undefined), false);
    assert.equal(containsChineseText("   "), false);
});

test("containsChineseText: 繁体中文标题返回 true", () => {
    assert.equal(containsChineseText("賣房子的女人"), true);
});

test("cache utils: getAuthToken 在无 apiKey 时返回空字符串", () => {
    const env = createEnv({
        [UNIFIED_CACHE_KEY]: createStoredUnifiedCache(100),
        [UNIFIED_CACHE_REV_KEY]: 100,
    });

    assert.equal(getAuthToken(env, ""), "");
    assert.equal(getAuthToken(env, null), "");
    assert.equal(getAuthToken(env, undefined), "");
});

test("cache utils: getAuthToken 在缓存无对应 apiKey 时返回空字符串", () => {
    const env = createEnv({
        [UNIFIED_CACHE_KEY]: createStoredUnifiedCache(100),
        [UNIFIED_CACHE_REV_KEY]: 100,
    });

    assert.equal(getAuthToken(env, "missing-api-key"), "");
});

test("cache utils: saveAuthToken 写入后 getAuthToken 可读出同一 token", () => {
    const env = createEnv({
        [UNIFIED_CACHE_KEY]: createStoredUnifiedCache(100),
        [UNIFIED_CACHE_REV_KEY]: 100,
    });

    saveAuthToken(env, "app-key-1", "Bearer token-1");

    assert.equal(getAuthToken(env, "app-key-1"), "Bearer token-1");
    assert.equal(readStoredUnifiedCache(env).persistent.authTokens["app-key-1"], "Bearer token-1");
});

test("cache utils: saveAuthToken 按 apiKey 区分不同 app 的 token", () => {
    const env = createEnv({
        [UNIFIED_CACHE_KEY]: createStoredUnifiedCache(100),
        [UNIFIED_CACHE_REV_KEY]: 100,
    });

    saveAuthToken(env, "app-key-1", "Bearer token-1");
    saveAuthToken(env, "app-key-2", "Bearer token-2");

    assert.equal(getAuthToken(env, "app-key-1"), "Bearer token-1");
    assert.equal(getAuthToken(env, "app-key-2"), "Bearer token-2");

    const stored = readStoredUnifiedCache(env).persistent.authTokens;
    assert.equal(stored["app-key-1"], "Bearer token-1");
    assert.equal(stored["app-key-2"], "Bearer token-2");
});

test("cache utils: saveAuthToken 覆盖同一 apiKey 的旧 token", () => {
    const env = createEnv({
        [UNIFIED_CACHE_KEY]: createStoredUnifiedCache(100),
        [UNIFIED_CACHE_REV_KEY]: 100,
    });

    saveAuthToken(env, "app-key-1", "Bearer old-token");
    saveAuthToken(env, "app-key-1", "Bearer new-token");

    assert.equal(getAuthToken(env, "app-key-1"), "Bearer new-token");
});

test("cache utils: saveAuthToken 在 apiKey 或 authorization 为空时跳过写入", () => {
    const env = createEnv({
        [UNIFIED_CACHE_KEY]: createStoredUnifiedCache(100),
        [UNIFIED_CACHE_REV_KEY]: 100,
    });

    saveAuthToken(env, "", "Bearer token-1");
    saveAuthToken(env, "app-key-1", "");
    saveAuthToken(env, null, "Bearer token-1");

    assert.deepEqual(readStoredUnifiedCache(env).persistent.authTokens, {});
});

test("cache utils: saveAuthToken 在 token 未变化时不重复写入", () => {
    const env = createEnv({
        [UNIFIED_CACHE_KEY]: createStoredUnifiedCache(100),
        [UNIFIED_CACHE_REV_KEY]: 100,
    });

    saveAuthToken(env, "app-key-1", "Bearer same-token");
    const firstRev = readStoredUnifiedCache(env).rev;
    saveAuthToken(env, "app-key-1", "Bearer same-token");
    const secondRev = readStoredUnifiedCache(env).rev;

    assert.equal(secondRev, firstRev);
});

test("cache utils: normalizeUnifiedCache 保留已有的 authTokens", () => {
    const normalized = normalizeUnifiedCache({
        version: 11,
        persistent: {
            authTokens: {
                "app-key-1": "Bearer token-1",
                "app-key-2": "Bearer token-2",
            },
        },
    });

    assert.equal(normalized.persistent.authTokens["app-key-1"], "Bearer token-1");
    assert.equal(normalized.persistent.authTokens["app-key-2"], "Bearer token-2");
});

test("cache utils: normalizeUnifiedCache 过滤 authTokens 中的非法条目", () => {
    const normalized = normalizeUnifiedCache({
        version: 11,
        persistent: {
            authTokens: {
                "app-key-1": "Bearer token-1",
                "": "Bearer empty-key",
                "app-key-empty": "",
                invalid: 123,
            },
        },
    });

    assert.equal(normalized.persistent.authTokens["app-key-1"], "Bearer token-1");
    assert.equal(normalized.persistent.authTokens[""], undefined);
    assert.equal(normalized.persistent.authTokens["app-key-empty"], undefined);
    assert.equal(normalized.persistent.authTokens.invalid, undefined);
});

test("cache utils: storeTranslationEntry 对相同条目不重复标记变更", () => {
    const cache = {};
    const ref = { traktId: 101 };

    const first = storeTranslationEntry(cache, "movie", ref, { status: 1, translation: { title: "标题" } });
    assert.equal(first.status, 1);
    assert.ok(first.expiresAt > Date.now());
    assert.ok(first.expiresAt <= Date.now() + FOUND_TTL_MS);

    const second = storeTranslationEntry(cache, "movie", ref, { status: 1, translation: { title: "标题" } });
    assert.equal(second, first);
    assert.equal(Object.keys(cache).length, 1);

    const third = storeTranslationEntry(cache, "movie", ref, { status: 1, translation: { title: "标题" }, complete: true });
    assert.notEqual(third, first);
    assert.equal(third.complete, true);
    assert.ok(third.expiresAt > Date.now());
    assert.ok(third.expiresAt <= Date.now() + FOUND_TTL_MS);
});

test("cache utils: storeTranslationEntry 未过期负缓存判同，过期则刷新 TTL", () => {
    const cache = {};
    const ref = { traktId: 102 };

    const first = storeTranslationEntry(cache, "movie", ref, { status: 3 });
    const second = storeTranslationEntry(cache, "movie", ref, { status: 3 });
    assert.equal(second, first);
    assert.ok(second.expiresAt > Date.now());

    cache["translation:movies:102:cn"].expiresAt = Date.now() - 1;
    const refreshed = storeTranslationEntry(cache, "movie", ref, { status: 3 });
    assert.notEqual(refreshed, first);
    assert.ok(refreshed.expiresAt > Date.now());
});

test("cache utils: storeTranslationEntry 翻译内容或状态变化判变", () => {
    const cache = {};
    const ref = { traktId: 103 };

    const first = storeTranslationEntry(cache, "movie", ref, { status: 1, translation: { title: "旧标题" } });
    const renamed = storeTranslationEntry(cache, "movie", ref, { status: 1, translation: { title: "新标题" } });
    assert.notEqual(renamed, first);

    const partial = storeTranslationEntry(cache, "movie", ref, { status: 2, translation: { title: "新标题" } });
    assert.equal(partial.status, 2);
});

test("cache utils: setCurrentSeason 相同季度不触发整缓存写回", () => {
    const env = createEnv({
        [UNIFIED_CACHE_KEY]: createStoredUnifiedCache(100),
        [UNIFIED_CACHE_REV_KEY]: 100,
    });

    setCurrentSeason(env, "123", 2);
    const storedAfterFirst = env.data[UNIFIED_CACHE_KEY];
    assert.ok(storedAfterFirst);
    assert.equal(readStoredUnifiedCache(env).persistent.currentSeason.seasonNumber, 2);

    setCurrentSeason(env, "123", 2);
    assert.equal(env.data[UNIFIED_CACHE_KEY], storedAfterFirst);

    setCurrentSeason(env, "123", 3);
    assert.notEqual(env.data[UNIFIED_CACHE_KEY], storedAfterFirst);
    assert.equal(readStoredUnifiedCache(env).persistent.currentSeason.seasonNumber, 3);
});

test("cache utils: clearCurrentSeason 已为空时不再写回", () => {
    const env = createEnv({
        [UNIFIED_CACHE_KEY]: createStoredUnifiedCache(100),
        [UNIFIED_CACHE_REV_KEY]: 100,
    });

    clearCurrentSeason(env);
    assert.equal(env.data[UNIFIED_CACHE_REV_KEY], JSON.stringify(100));
});

test("cache utils: 加载时丢弃过期负缓存条目并触发修复写回", () => {
    const stored = createStoredUnifiedCache(100);
    stored.trakt.translation["translation:movies:1:cn"] = { status: 3, expiresAt: Date.now() - 1000 };
    const env = createEnv({
        [UNIFIED_CACHE_KEY]: stored,
        [UNIFIED_CACHE_REV_KEY]: 100,
    });

    const cache = loadCache(env);
    assert.equal(cache["translation:movies:1:cn"], undefined);
    assert.equal(readStoredUnifiedCache(env).trakt.translation["translation:movies:1:cn"], undefined);
});

test("cache utils: 正常缓存加载不触发修复写回", () => {
    const env = createEnv({
        [UNIFIED_CACHE_KEY]: createStoredUnifiedCache(100),
        [UNIFIED_CACHE_REV_KEY]: 100,
    });

    loadUnifiedCache(env);
    assert.equal(env.data[UNIFIED_CACHE_KEY], JSON.stringify(createStoredUnifiedCache(100)));
    assert.equal(env.getjsonCallsFor(UNIFIED_CACHE_KEY), 1);
});

test("中文地区转换：cn 简体、tw 台湾用词、hk 香港字表", () => {
    assert.equal(normalizeChineseLocale("繁體中文（台灣）"), "tw");
    assert.equal(normalizeChineseLocale("繁體中文（香港）"), "hk");
    assert.equal(normalizeChineseLocale("中文（繁体·台湾）"), "cn");
    assert.equal(normalizeChineseLocale("繁体（台湾）"), "cn");
    assert.equal(normalizeChineseLocale("bogus"), "cn");

    assert.equal(convertChineseForLocale("软件更新可用", "cn"), "软件更新可用");
    // 只有确认来自简体来源时才做简→繁
    assert.equal(convertChineseForLocale("软件更新可用", "tw", { fromSimplified: true }), "軟體更新可用");
    assert.equal(convertChineseForLocale("软件更新可用", "hk", { fromSimplified: true }), "軟件更新可用");
    // 已是繁体的文本（港台原生译名等）直接透传，不做二次简→繁
    assert.equal(convertChineseForLocale("軟體更新可用", "tw"), "軟體更新可用");
    assert.equal(convertChineseForLocale("里約大冒險", "tw"), "里約大冒險");
    assert.equal(convertChineseForLocale("皇后的品格", "tw"), "皇后的品格");
    assert.equal(convertChineseForLocale("余文樂", "hk"), "余文樂");
});

test("Trakt 翻译按地区优先选择：cn/tw/hk 各取本地区", () => {
    const items = [
        { language: "zh", country: "cn", title: "大陆标题", overview: "大陆简介" },
        { language: "zh", country: "tw", title: "台灣標題", overview: "台灣簡介" },
        { language: "zh", country: "hk", title: "香港標題", overview: "香港簡介" },
    ];

    const cn = extractNormalizedTranslation(normalizeTranslations(structuredClone(items), "cn"), "cn");
    assert.equal(cn.translation.title, "大陆标题");

    const tw = extractNormalizedTranslation(normalizeTranslations(structuredClone(items), "tw"), "tw");
    // 台湾原生译名原样输出（不再二次简→繁）
    assert.equal(tw.translation.title, "台灣標題");
    assert.equal(tw.translation.overview, "台灣簡介");

    const hk = extractNormalizedTranslation(normalizeTranslations(structuredClone(items), "hk"), "hk");
    assert.equal(hk.translation.title, "香港標題");
});

test("Trakt 翻译缺失本地区字段时按地区顺序回退", () => {
    const items = [
        { language: "zh", country: "cn", title: "大陆标题", overview: "大陆简介" },
        { language: "zh", country: "tw", title: "台灣標題" },
    ];

    const tw = extractNormalizedTranslation(normalizeTranslations(structuredClone(items), "tw"), "tw");
    assert.equal(tw.translation.title, "台灣標題");
    // 台湾缺 overview：tw 回退顺序是 hk → cn → sg，回退到大陆（简体来源）后按台湾字形输出
    assert.equal(tw.translation.overview, "大陸簡介");
});

test("cache utils: 翻译条目按缓存键地区归一化，cn 设备不会把 tw/hk 条目转成简体", () => {
    const originalContext = globalThis.$ctx;
    try {
        globalThis.$ctx = { argument: { chineseLocale: "cn" } };
        const normalized = normalizeUnifiedCache({
            version: UNIFIED_CACHE_SCHEMA_VERSION,
            trakt: {
                translation: {
                    "translation:movies:123:cn": { status: 1, translation: { title: "蜘蛛侠：英雄无归", overview: "简体简介" } },
                    "translation:movies:123:tw": { status: 1, translation: { title: "蜘蛛人：無家日", overview: "台灣簡介" } },
                    "translation:movies:123:hk": { status: 1, translation: { title: "蜘蛛俠：不戰無歸", overview: "香港簡介" } },
                },
            },
        });

        assert.equal(normalized.trakt.translation["translation:movies:123:cn"].translation.title, "蜘蛛侠：英雄无归");
        assert.equal(normalized.trakt.translation["translation:movies:123:tw"].translation.title, "蜘蛛人：無家日");
        assert.equal(normalized.trakt.translation["translation:movies:123:tw"].translation.overview, "台灣簡介");
        assert.equal(normalized.trakt.translation["translation:movies:123:hk"].translation.title, "蜘蛛俠：不戰無歸");
        assert.equal(normalized.trakt.translation["translation:movies:123:hk"].translation.overview, "香港簡介");
    } finally {
        globalThis.$ctx = originalContext;
    }
});

test("cache utils: 整缓存落盘不会把 tw/hk 条目改写成简体", () => {
    const originalContext = globalThis.$ctx;
    try {
        globalThis.$ctx = { argument: { chineseLocale: "cn" } };
        const env = createEnv({
            [UNIFIED_CACHE_KEY]: {
                version: UNIFIED_CACHE_SCHEMA_VERSION,
                rev: 100,
                trakt: {
                    translation: {
                        "translation:movies:123:tw": { status: 1, translation: { title: "蜘蛛人：無家日", overview: "台灣簡介" } },
                    },
                },
            },
            [UNIFIED_CACHE_REV_KEY]: 100,
        });

        const cache = loadCache(env);
        cache["translation:movies:456:cn"] = { status: 1, translation: { title: "中文电影" } };
        saveCache(env, cache);

        const stored = readStoredUnifiedCache(env).trakt.translation;
        assert.equal(stored["translation:movies:123:tw"].translation.title, "蜘蛛人：無家日");
        assert.equal(stored["translation:movies:123:tw"].translation.overview, "台灣簡介");
        assert.equal(stored["translation:movies:456:cn"].translation.title, "中文电影");
    } finally {
        globalThis.$ctx = originalContext;
    }
});

test("cache utils: 只有 tw/hk 的覆盖条目不会被归一化丢弃", () => {
    const normalized = normalizeUnifiedCache({
        version: UNIFIED_CACHE_SCHEMA_VERSION,
        persistent: {
            translationOverrides: {
                fetchedAt: 123,
                shows: {},
                episodes: {},
                movies: {
                    123: { tw: { translation: { title: "蜘蛛人：無家日" } } },
                    456: { hk: { translation: { title: "蜘蛛俠：不戰無歸" } } },
                    789: { cn: { translation: { title: "蜘蛛侠：英雄无归" } } },
                    999: { en: { translation: { title: "Spider-Man" } } },
                },
            },
        },
    });

    const overrides = normalized.persistent.translationOverrides.movies;
    assert.equal(overrides["123"].tw.translation.title, "蜘蛛人：無家日");
    assert.equal(overrides["456"].hk.translation.title, "蜘蛛俠：不戰無歸");
    assert.equal(overrides["789"].cn.translation.title, "蜘蛛侠：英雄无归");
    assert.equal(overrides["999"], undefined, "没有任何中文地区覆盖的条目仍应丢弃");
});

test("人物名本地缓存按中文地区分键，cn 同样带后缀且切换地区不会命中旧字形", () => {
    const originalContext = globalThis.$ctx;
    try {
        const cache = {};
        globalThis.$ctx = { argument: { chineseLocale: "cn" } };
        setPeopleTranslationCacheEntry(cache, 42, {
            status: 1,
            name: "汤姆·汉克斯",
            sourceTextHash: "hash-1",
            source: "tmdb",
        });
        assert.ok(cache["person:name:42:cn"], "cn 与 tw/hk 共用 `person:name:<id>:<locale>` 键格式");
        assert.equal(cache["42"], undefined, "不再写入无地区后缀的历史键");
        assert.equal(cache["person:name:42:tw"], undefined);

        globalThis.$ctx = { argument: { chineseLocale: "tw" } };
        setPeopleTranslationCacheEntry(cache, 42, {
            status: 1,
            name: "湯姆·漢克斯",
            sourceTextHash: "hash-1",
            source: "tmdb",
        });
        assert.equal(getPeopleTranslationCacheEntry(cache, 42).name, "湯姆·漢克斯");

        globalThis.$ctx = { argument: { chineseLocale: "cn" } };
        assert.equal(getPeopleTranslationCacheEntry(cache, 42).name, "汤姆·汉克斯");
    } finally {
        globalThis.$ctx = originalContext;
    }
});
