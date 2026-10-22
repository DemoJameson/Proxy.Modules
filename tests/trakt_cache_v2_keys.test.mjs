import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { buildCacheKey, buildCacheKeyForLocale, buildCacheKeyPattern, buildOverrideField, buildTranslationOverridesKey } = require("../lib/trakt-cache/translation-store.js");
const { buildImageCacheKeyForMode } = require("../lib/trakt-cache/image-store.js");
const { buildCreditCacheKey } = require("../lib/trakt-cache/credit-store.js");
const { buildPersonNameCacheKey } = require("../lib/trakt-cache/person-name-store.js");
const { buildCommentTranslationCacheKey } = require("../lib/trakt-cache/comment-translation-store.js");
const { buildListTranslationCacheKey } = require("../lib/trakt-cache/list-translation-store.js");

test("V2 key builder 使用冒号命名并移除 trakt 前缀", () => {
    const keys = [
        buildCacheKey("movies", "123"),
        buildCacheKeyForLocale("movies", "123", "tw"),
        buildCacheKeyPattern("episodes", "hk"),
        buildOverrideField("episodes", "301:1:1", "cn"),
        buildTranslationOverridesKey(),
        buildImageCacheKeyForMode("chinese", "seasons", "555:1"),
        buildCreditCacheKey("movies", "123"),
        buildPersonNameCacheKey("42"),
        buildCommentTranslationCacheKey("1000003"),
        buildListTranslationCacheKey("42"),
    ];
    assert.deepEqual(keys, [
        "translation:movies:123",
        "translation:movies:123:tw",
        "translation:episodes:*:hk",
        "episodes:301:1:1:cn",
        "translation:overrides",
        "image:chinese:seasons:555:1",
        "credit:movies:123",
        "person:name:42",
        "comment:translation:1000003",
        "list:translation:42",
    ]);
    keys.forEach((key) => {
        assert.equal(key.startsWith("trakt:"), false);
        assert.equal(key.includes("-"), false);
    });
});
