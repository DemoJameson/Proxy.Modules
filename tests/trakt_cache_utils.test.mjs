import assert from "node:assert/strict";
import test from "node:test";

import {
    createEmptyUnifiedCache,
    GOOGLE_PEOPLE_CACHE_MAX_BYTES,
    getHashedFieldTranslation,
    loadCache,
    loadUnifiedCache,
    normalizeUnifiedCache,
    pruneUnifiedCacheToLimit,
    saveCache,
    saveCommentTranslationCache,
    setHashedFieldTranslation,
    UNIFIED_CACHE_KEY,
    UNIFIED_CACHE_REV_KEY,
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
        name: {
            sourceTextHash,
            translatedText: "汤姆·汉克斯",
            source: "tmdb",
        },
        biography: {
            sourceTextHash: `${sourceTextHash}-biography`,
            translatedText: "P".repeat(size),
        },
    };
}

test("cache utils: hashed field translation roundtrip works for comments cache shape", () => {
    const cache = {};

    assert.equal(setHashedFieldTranslation(cache, 9001, "comment", "Great movie", " 很棒的电影 "), true);
    assert.equal(getHashedFieldTranslation(cache, 9001, "comment", "Great movie"), "很棒的电影");
    assert.equal(getHashedFieldTranslation(cache, 9001, "comment", "Another movie"), "");
    assert.equal(cache["9001"].comment.translatedText, "很棒的电影");
});

test("cache utils: normalizeUnifiedCache keeps comments cache in current nested shape", () => {
    const normalized = normalizeUnifiedCache({
        version: 5,
        rev: 123,
        maxBytes: 512,
        google: {
            comments: {
                9001: {
                    comment: {
                        sourceTextHash: "cafebabe",
                        translatedText: "很棒的电影",
                    },
                },
            },
        },
    });

    assert.equal(normalized.google.comments["9001"].comment.translatedText, "很棒的电影");
    assert.equal(normalized.google.comments["9001"].rev, undefined);
    assert.deepEqual(normalized.douban, {
        search: {},
        seasons: {},
        credits: {},
    });
});

test("cache utils: normalizeUnifiedCache 保留豆瓣角色缓存摘要", () => {
    const normalized = normalizeUnifiedCache({
        version: 9,
        douban: {
            search: {
                "tv:tt123": {
                    id: "35517044",
                    targetType: "tv",
                },
            },
            seasons: {
                35517044: {
                    ids: ["4707205", "", "4707205", "6312211"],
                },
            },
            credits: {
                4707205: {
                    王骁: ["张一昂", "", "张一昂"],
                },
            },
        },
    });

    assert.deepEqual(normalized.douban.search["tv:tt123"], {
        id: "35517044",
        targetType: "tv",
    });
    assert.deepEqual(normalized.douban.seasons["35517044"].ids, ["4707205", "6312211"]);
    assert.deepEqual(normalized.douban.credits["4707205"].王骁, ["张一昂"]);
});

test("cache utils: normalizeUnifiedCache 不迁移旧 poster 图片缓存", () => {
    const normalized = normalizeUnifiedCache({
        version: 6,
        trakt: {
            poster: {
                "movie:123": {
                    status: 1,
                    url: "https://image.tmdb.org/t/p/w780/old-poster.jpg",
                },
            },
        },
    });

    assert.deepEqual(normalized.trakt.image, {});
});

test("cache utils: normalizeUnifiedCache 保留未过期图片 TTL 并移除过期字段", () => {
    const now = Date.now();
    const normalized = normalizeUnifiedCache({
        version: 7,
        trakt: {
            image: {
                "movie:123": {
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
                "movie:124": {
                    poster: {
                        status: 3,
                        expiresAt: now - 1000,
                    },
                },
                "movie:125": {
                    poster: {
                        status: 1,
                        url: "https://image.tmdb.org/t/p/original/found.jpg",
                    },
                },
            },
        },
    });

    assert.equal(normalized.trakt.image["movie:123"].poster.status, 2);
    assert.equal(normalized.trakt.image["movie:123"].logo, undefined);
    assert.equal(normalized.trakt.image["movie:124"], undefined);
    assert.equal(normalized.trakt.image["movie:125"].poster.expiresAt, null);
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
    cache.trakt.translation["movie:1"] = {
        status: 1,
        translation: {
            title: "保留标题",
            overview: "B".repeat(120),
        },
    };

    const pruned = pruneUnifiedCacheToLimit(env, cache, 3, 700);

    assert.equal(pruned.google.comments.large, undefined);
    assert.equal(pruned.trakt.translation["movie:1"].translation.title, "保留标题");
});

test("cache utils: pruneUnifiedCacheToLimit keeps people translations before media translations", () => {
    const env = createEnv();
    const cache = createEmptyUnifiedCache(3, 900);

    cache.google.people["person:1"] = {
        name: {
            sourceTextHash: "person-name",
            translatedText: "汤姆·汉克斯",
            source: "tmdb",
        },
        biography: {
            sourceTextHash: "person-biography",
            translatedText: "A".repeat(180),
        },
    };
    cache.trakt.translation["movie:1"] = {
        status: 1,
        translation: {
            title: "保留标题",
            overview: "B".repeat(420),
        },
    };

    const pruned = pruneUnifiedCacheToLimit(env, cache, 3, 900);

    assert.equal(pruned.trakt.translation["movie:1"], undefined);
    assert.equal(pruned.google.people["person:1"].name.translatedText, "汤姆·汉克斯");
});

test("cache utils: pruneUnifiedCacheToLimit can prune douban cache before link ids", () => {
    const env = createEnv();
    const cache = createEmptyUnifiedCache(9, 900);
    cache.douban.credits["35517044"] = {
        王骁: ["A".repeat(800)],
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

    assert.equal(pruned.douban.credits["35517044"], undefined);
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
    cache.google.people.small = createPeopleEntry(128, "small");
    cache.google.people.large = createPeopleEntry(GOOGLE_PEOPLE_CACHE_MAX_BYTES + 1024, "large");

    const pruned = pruneUnifiedCacheToLimit(env, cache, 3, GOOGLE_PEOPLE_CACHE_MAX_BYTES * 4);

    assert.equal(pruned.google.people.large, undefined);
    assert.equal(pruned.google.people.small.name.translatedText, "汤姆·汉克斯");
    assert.ok(estimateEntryMapBytes(env, pruned.google.people) <= GOOGLE_PEOPLE_CACHE_MAX_BYTES);
});

test("cache utils: pruneUnifiedCacheToLimit prunes lower priorities before capped people entries", () => {
    const env = createEnv();
    const cache = createEmptyUnifiedCache(3, 900);
    cache.google.people.small = createPeopleEntry(128, "small");
    cache.google.comments.large = {
        comment: {
            sourceTextHash: "comments-large",
            translatedText: "C".repeat(900),
        },
    };

    const pruned = pruneUnifiedCacheToLimit(env, cache, 3, 900);

    assert.equal(pruned.google.comments.large, undefined);
    assert.equal(pruned.google.people.small.name.translatedText, "汤姆·汉克斯");
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

test("cache utils: version 不匹配时清空旧 unified cache", () => {
    const oldCache = createStoredUnifiedCache(100);
    oldCache.version = 999;
    oldCache.trakt.translation["movie:1"] = {
        status: 1,
        translation: {
            title: "旧标题",
        },
    };
    oldCache.google.people["42"] = createPeopleEntry(32);

    const env = createEnv({
        [UNIFIED_CACHE_KEY]: oldCache,
        [UNIFIED_CACHE_REV_KEY]: 100,
    });

    const unifiedCache = loadUnifiedCache(env);

    assert.equal(unifiedCache.version, createEmptyUnifiedCache().version);
    assert.deepEqual(unifiedCache.trakt.translation, {});
    assert.deepEqual(unifiedCache.google.people, {});
    assert.deepEqual(unifiedCache.douban, {
        search: {},
        seasons: {},
        credits: {},
    });
});

test("cache utils: 无 revision 冲突时 save 不会重读完整 unified cache", () => {
    const env = createEnv({
        [UNIFIED_CACHE_KEY]: createStoredUnifiedCache(100),
        [UNIFIED_CACHE_REV_KEY]: 100,
    });

    const commentsCache = {
        9001: {
            comment: {
                sourceTextHash: "hash-9001",
                translatedText: "很棒的电影",
            },
        },
    };

    loadUnifiedCache(env);
    saveCommentTranslationCache(env, commentsCache);

    assert.equal(env.getjsonCallsFor(UNIFIED_CACHE_KEY), 1);
    assert.equal(readStoredUnifiedCache(env).google.comments["9001"].comment.translatedText, "很棒的电影");
});

test("cache utils: revision 冲突时会重读最新 unified cache 并按桶合并", () => {
    const env = createEnv({
        [UNIFIED_CACHE_KEY]: createStoredUnifiedCache(100),
        [UNIFIED_CACHE_REV_KEY]: 100,
    });

    const translationCache = loadCache(env);
    translationCache["movie:1"] = {
        status: 1,
        translation: {
            title: "本地标题",
        },
    };

    const latestCache = createStoredUnifiedCache(101);
    latestCache.google.comments["9001"] = {
        comment: {
            sourceTextHash: "hash-9001",
            translatedText: "外部评论",
        },
    };
    env.setjson(latestCache, UNIFIED_CACHE_KEY);
    env.setjson(101, UNIFIED_CACHE_REV_KEY);

    saveCache(env, translationCache);

    const storedCache = readStoredUnifiedCache(env);
    assert.equal(storedCache.trakt.translation["movie:1"].translation.title, "本地标题");
    assert.equal(storedCache.google.comments["9001"].comment.translatedText, "外部评论");
    assert.ok(env.getjsonCallsFor(UNIFIED_CACHE_KEY) >= 2);
});

test("cache utils: 同桶 revision 冲突保持后写覆盖", () => {
    const env = createEnv({
        [UNIFIED_CACHE_KEY]: createStoredUnifiedCache(100),
        [UNIFIED_CACHE_REV_KEY]: 100,
    });

    const translationCache = loadCache(env);
    translationCache["movie:1"] = {
        status: 1,
        translation: {
            title: "本地标题",
        },
    };

    const latestCache = createStoredUnifiedCache(101);
    latestCache.trakt.translation["movie:1"] = {
        status: 1,
        translation: {
            title: "外部标题",
        },
    };
    env.setjson(latestCache, UNIFIED_CACHE_KEY);
    env.setjson(101, UNIFIED_CACHE_REV_KEY);

    saveCache(env, translationCache);

    assert.equal(readStoredUnifiedCache(env).trakt.translation["movie:1"].translation.title, "本地标题");
});

test("cache utils: body rev 落后于 sidecar rev 时不会把 sidecar rev 错记进 memo", () => {
    const staleBody = createStoredUnifiedCache(100);
    const env = createEnv({
        [UNIFIED_CACHE_KEY]: staleBody,
        [UNIFIED_CACHE_REV_KEY]: 101,
    });

    const unifiedCache = loadUnifiedCache(env);
    unifiedCache.trakt.translation["movie:1"] = {
        status: 1,
        translation: {
            title: "本地标题",
        },
    };

    saveCache(env, unifiedCache.trakt.translation);

    const storedCache = readStoredUnifiedCache(env);
    assert.equal(storedCache.rev > 101, true);
    assert.equal(storedCache.trakt.translation["movie:1"].translation.title, "本地标题");
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
