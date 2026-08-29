const { getKvConfig, sendKvNotConfigured } = require("../../lib/trakt-cache/kv-client");

const {
    CACHE_STATUS,
    OVERRIDE_FIELDS,
    TRANSLATION_OVERRIDES_KEY,
    MEDIA_TYPES,
    IMAGE_GROUPS,
    getResponseCacheStatus,
    isSupportedMediaType,
    normalizeTranslationOverrideEntry,
    setResponseCacheHeaders,
} = require("../../lib/trakt-cache/normalize");

const { parseIds, parseEpisodeKeys, parseSeasonKeys, readJsonBody } = require("../../lib/trakt-cache/params");

const {
    buildCacheKey,
    buildOverrideCacheKey,
    buildTranslationOverridesKey,
    deleteCacheEntriesFromKv,
    readAllTranslationOverridesFromKv,
    readManyAutoFromKv,
    readManyAutoGroupsFromKv,
    readCachePairFromKv,
    readManyEffectiveFromKv,
    writeTranslationOverrideEntryToKv,
    writeManyGroupsToKv,
    writeManyToKv,
} = require("../../lib/trakt-cache/translation-store");

const { buildImageCacheKey, buildImageCacheKeyForMode, readManyImageGroupsFromKv, writeManyImageGroupsToKv } = require("../../lib/trakt-cache/image-store");

const {
    DOUBAN_TARGET_TYPES,
    buildCreditCacheKey,
    mergeCreditEntriesByField,
    splitCreditEntriesByCompleteness,
    readManyCreditEntriesFromKv,
    writeManyCreditEntriesToKv,
} = require("../../lib/trakt-cache/credit-store");

const { buildPersonNameCacheKey, normalizePersonNameEntry, readManyPersonNameEntriesFromKv, writeManyPersonNameEntriesToKv } = require("../../lib/trakt-cache/person-name-store");

const {
    buildCommentTranslationCacheKey,
    normalizeCommentTranslationEntry,
    readManyCommentTranslationEntriesFromKv,
    writeManyCommentTranslationEntriesToKv,
} = require("../../lib/trakt-cache/comment-translation-store");

const {
    buildListTranslationCacheKey,
    normalizeListTranslationEntry,
    readManyListTranslationEntriesFromKv,
    writeManyListTranslationEntriesToKv,
} = require("../../lib/trakt-cache/list-translation-store");

const { listCacheItemsFromKv } = require("../../lib/trakt-cache/admin-list");

module.exports = {
    CACHE_STATUS,
    OVERRIDE_FIELDS,
    TRANSLATION_OVERRIDES_KEY,
    MEDIA_TYPES,
    IMAGE_GROUPS,
    DOUBAN_TARGET_TYPES,
    buildCacheKey,
    buildImageCacheKey,
    buildImageCacheKeyForMode,
    buildCreditCacheKey,
    buildOverrideCacheKey,
    buildTranslationOverridesKey,
    buildPersonNameCacheKey,
    buildCommentTranslationCacheKey,
    buildListTranslationCacheKey,
    deleteCacheEntriesFromKv,
    getKvConfig,
    getResponseCacheStatus,
    isSupportedMediaType,
    listCacheItemsFromKv,
    mergeCreditEntriesByField,
    normalizePersonNameEntry,
    normalizeCommentTranslationEntry,
    normalizeListTranslationEntry,
    normalizeTranslationOverrideEntry,
    parseEpisodeKeys,
    splitCreditEntriesByCompleteness,
    parseIds,
    parseSeasonKeys,
    readAllTranslationOverridesFromKv,
    readManyAutoFromKv,
    readManyAutoGroupsFromKv,
    readManyImageGroupsFromKv,
    readManyCreditEntriesFromKv,
    readManyPersonNameEntriesFromKv,
    readManyCommentTranslationEntriesFromKv,
    readManyListTranslationEntriesFromKv,
    readCachePairFromKv,
    readJsonBody,
    readManyEffectiveFromKv,
    sendKvNotConfigured,
    setResponseCacheHeaders,
    writeTranslationOverrideEntryToKv,
    writeManyGroupsToKv,
    writeManyImageGroupsToKv,
    writeManyCreditEntriesToKv,
    writeManyPersonNameEntriesToKv,
    writeManyCommentTranslationEntriesToKv,
    writeManyListTranslationEntriesToKv,
    writeManyToKv,
};
