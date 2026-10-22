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
    buildCacheKeyForLocale,
    buildCacheKeyPattern,
    buildOverrideField,
    buildTranslationOverridesKey,
    deleteCacheEntriesFromKv,
    isValidOverrideId,
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
    getCreditCacheStatus,
    isCompleteCreditEntry,
    mergeCreditEntriesByField,
    splitCreditEntriesByCompleteness,
    readManyCreditEntriesFromKv,
    writeManyCreditEntriesToKv,
} = require("../../lib/trakt-cache/credit-store");

const {
    buildPersonNameCacheKey,
    normalizePersonNameEntry,
    readManyPersonNameEntriesFromKv,
    writeManyPersonNameEntriesToKv,
    PERSON_NAME_STATUS,
} = require("../../lib/trakt-cache/person-name-store");

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

const { normalizeLocale } = require("../../lib/trakt-cache/locale");

module.exports = {
    CACHE_STATUS,
    OVERRIDE_FIELDS,
    TRANSLATION_OVERRIDES_KEY,
    MEDIA_TYPES,
    IMAGE_GROUPS,
    DOUBAN_TARGET_TYPES,
    buildCacheKey,
    buildCacheKeyForLocale,
    buildCacheKeyPattern,
    buildImageCacheKey,
    buildImageCacheKeyForMode,
    buildCreditCacheKey,
    getCreditCacheStatus,
    buildOverrideField,
    buildTranslationOverridesKey,
    isValidOverrideId,
    buildPersonNameCacheKey,
    buildCommentTranslationCacheKey,
    buildListTranslationCacheKey,
    deleteCacheEntriesFromKv,
    getKvConfig,
    getResponseCacheStatus,
    isSupportedMediaType,
    isCompleteCreditEntry,
    listCacheItemsFromKv,
    mergeCreditEntriesByField,
    normalizePersonNameEntry,
    PERSON_NAME_STATUS,
    normalizeCommentTranslationEntry,
    normalizeListTranslationEntry,
    normalizeLocale,
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
