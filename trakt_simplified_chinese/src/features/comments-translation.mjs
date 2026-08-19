import * as vercelBackendClientModule from "../outbound/vercel-backend-client.mjs";
import * as googleTranslationContext from "../shared/google-translation-context.mjs";
import * as googleTranslationPipeline from "../shared/google-translation-pipeline.mjs";
import * as mediaTypes from "../shared/media-types.mjs";
import * as traktLinkIds from "../shared/trakt-link-ids.mjs";
import * as mediaTranslationHelper from "../shared/trakt-translation-helper.mjs";
import * as cacheUtils from "../utils/cache.mjs";
import * as commonUtils from "../utils/common.mjs";

const COMMENT_TRANSLATION_BACKEND_WRITE_BATCH_SIZE = 50;
const commentTranslationBackendWriteQueue = {};

function isChineseLanguage(language) {
    const normalized = String(language ?? "")
        .trim()
        .toLowerCase();
    return normalized === "zh" || normalized.startsWith("zh-");
}

function shouldTranslateComment(comment) {
    return !!(commonUtils.isPlainObject(comment) && commonUtils.isNonNullish(comment.id) && typeof comment.comment === "string" && !isChineseLanguage(comment.language));
}

function collectCommentTargets(payload) {
    if (commonUtils.isPlainObject(payload) && commonUtils.isNonNullish(payload.id) && typeof payload.comment === "string") {
        return [{ comment: payload, item: null }];
    }

    if (commonUtils.isNotArray(payload) || payload.length === 0) {
        return [];
    }

    const commentTargets = [];
    payload.forEach((item) => {
        if (commonUtils.isPlainObject(item?.comment)) {
            commentTargets.push({ comment: item.comment, item });
        } else if (commonUtils.isPlainObject(item) && commonUtils.isNonNullish(item.id) && typeof item.comment === "string") {
            commentTargets.push({ comment: item, item: null });
        }
    });
    return commentTargets;
}

function resolveCommentRequestTarget() {
    const normalizedPath = globalThis.$ctx.url.shortPathname;
    let match = normalizedPath.match(/^(movies|shows)\/(\d+)\/comments\/[^/]+$/i);
    if (match) {
        return {
            mediaType: String(match[1]).toLowerCase() === "shows" ? mediaTypes.MEDIA_TYPE.SHOW : mediaTypes.MEDIA_TYPE.MOVIE,
            traktId: match[2],
        };
    }

    match = normalizedPath.match(/^shows\/(\d+)\/seasons\/(\d+)\/episodes\/(\d+)\/comments\/[^/]+$/i);
    return match
        ? {
              mediaType: mediaTypes.MEDIA_TYPE.EPISODE,
              showId: match[1],
              seasonNumber: match[2],
              episodeNumber: match[3],
          }
        : null;
}

function getCommentMediaTarget(item) {
    if (!commonUtils.isPlainObject(item)) {
        return null;
    }

    if (commonUtils.isPlainObject(item.movie)) {
        return item.movie;
    }
    if (commonUtils.isPlainObject(item.episode)) {
        return item.episode;
    }
    if (commonUtils.isPlainObject(item.show)) {
        return item.show;
    }
    return null;
}

function createRecentCommentOriginalTitleMap(payload) {
    const originalTitles = new WeakMap();
    commonUtils.ensureArray(payload).forEach((item) => {
        const comment = item?.comment;
        const mediaTarget = getCommentMediaTarget(item);
        const title = String(mediaTarget?.title ?? "").trim();
        if (commonUtils.isPlainObject(comment) && title) {
            originalTitles.set(comment, title);
        }
    });
    return originalTitles;
}

function buildBilingualContextLine(sourceTitle, localizedTitle) {
    const source = String(sourceTitle ?? "").trim();
    const localized = String(localizedTitle ?? "").trim();
    return source && localized && source !== localized ? googleTranslationContext.buildContextLine(source, localized) : "";
}

function buildRecentCommentContextLine(comment, item, originalTitles) {
    const mediaTarget = getCommentMediaTarget(item);
    if (!mediaTarget) {
        return "";
    }

    return buildBilingualContextLine(originalTitles?.get(comment) ?? mediaTarget.title, mediaTarget.title);
}

function readRequestCommentMediaEntries(requestTarget, linkCache, mediaCache) {
    if (!requestTarget) {
        return null;
    }

    if (requestTarget.mediaType === mediaTypes.MEDIA_TYPE.MOVIE || requestTarget.mediaType === mediaTypes.MEDIA_TYPE.SHOW) {
        const linkEntry = traktLinkIds.getLinkIdsCacheEntry(linkCache, requestTarget.traktId);
        const translationEntry = mediaTranslationHelper.getCachedTranslation(mediaCache, requestTarget.mediaType, requestTarget);
        return { linkEntry, translationEntry };
    }

    if (requestTarget.mediaType === mediaTypes.MEDIA_TYPE.EPISODE) {
        const linkEntry = traktLinkIds.getEpisodeLinkIdsCacheEntry(linkCache, requestTarget.showId, requestTarget.seasonNumber, requestTarget.episodeNumber);
        const translationEntry = mediaTranslationHelper.getCachedTranslation(mediaCache, mediaTypes.MEDIA_TYPE.EPISODE, requestTarget);
        return { linkEntry, translationEntry };
    }

    return null;
}

function resolveMissingOriginalTitleFetch(requestTarget, linkEntry) {
    if (String(linkEntry?.title ?? "").trim()) {
        return null;
    }
    if (requestTarget.mediaType === mediaTypes.MEDIA_TYPE.MOVIE || requestTarget.mediaType === mediaTypes.MEDIA_TYPE.SHOW) {
        return mediaTranslationHelper.fetchMediaDetail(requestTarget.mediaType, requestTarget.traktId);
    }
    if (requestTarget.mediaType === mediaTypes.MEDIA_TYPE.EPISODE) {
        return mediaTranslationHelper.fetchEpisodeDetail(requestTarget);
    }
    return null;
}

function resolveMissingTranslationFetch(requestTarget, translationEntry) {
    return String(translationEntry?.translation?.title ?? "").trim() ? null : mediaTranslationHelper.fetchDirectTranslation(requestTarget.mediaType, requestTarget);
}

async function hydrateMissingCommentMediaNames(requestTarget, linkCache, mediaCache, entries) {
    const { linkEntry, translationEntry } = entries;
    const originalTitlePromise = resolveMissingOriginalTitleFetch(requestTarget, linkEntry);
    const translationPromise = resolveMissingTranslationFetch(requestTarget, translationEntry);

    const tasks = [];
    if (originalTitlePromise) {
        tasks.push(
            (async () => {
                try {
                    const payload = await originalTitlePromise;
                    if (commonUtils.isPlainObject(payload)) {
                        traktLinkIds.cacheMediaIdsFromDetailResponse(linkCache, requestTarget.mediaType, requestTarget, payload);
                        cacheUtils.saveLinkIdsCache(globalThis.$ctx.env, linkCache);
                    }
                } catch (error) {
                    globalThis.$ctx.env.log(`Trakt comment context media detail failed for mediaType=${requestTarget.mediaType}: ${error}`);
                }
            })(),
        );
    }
    if (translationPromise) {
        tasks.push(
            (async () => {
                try {
                    const merged = await translationPromise;
                    mediaTranslationHelper.storeTranslationEntry(mediaCache, requestTarget.mediaType, requestTarget, merged);
                    cacheUtils.saveCache(globalThis.$ctx.env, mediaCache);
                } catch (error) {
                    globalThis.$ctx.env.log(`Trakt comment context translation fetch failed for mediaType=${requestTarget.mediaType}: ${error}`);
                }
            })(),
        );
    }
    if (tasks.length > 0) {
        await Promise.all(tasks);
    }
}

async function createCommentContextResolver(options = {}) {
    const requestTarget = resolveCommentRequestTarget();
    const hasRequestContext = !!requestTarget;
    const googleTranslationEnabled = globalThis.$ctx.argument?.googleTranslationEnabled !== false;
    const linkCache = hasRequestContext ? cacheUtils.loadLinkIdsCache(globalThis.$ctx.env) : {};
    const mediaCache = hasRequestContext ? cacheUtils.loadCache(globalThis.$ctx.env) : {};
    let requestContextLine = "";

    if (hasRequestContext) {
        const entries = readRequestCommentMediaEntries(requestTarget, linkCache, mediaCache);
        if (entries && googleTranslationEnabled) {
            await hydrateMissingCommentMediaNames(requestTarget, linkCache, mediaCache, entries);
            const refreshed = readRequestCommentMediaEntries(requestTarget, linkCache, mediaCache);
            requestContextLine = buildBilingualContextLine(refreshed?.linkEntry?.title, refreshed?.translationEntry?.translation?.title);
        } else if (entries) {
            requestContextLine = buildBilingualContextLine(entries.linkEntry?.title, entries.translationEntry?.translation?.title);
        }
    }

    return (entry) => {
        const recentContextLine = buildRecentCommentContextLine(entry.comment, entry.item, options.originalTitles);
        return recentContextLine || requestContextLine;
    };
}

function queueCommentTranslationBackendWrite(commentId, fieldEntry) {
    const normalizedCommentId = String(commentId ?? "").trim();
    const sourceTextHash = String(fieldEntry?.sourceTextHash ?? "").trim();
    const translatedText = String(fieldEntry?.translatedText ?? "").trim();
    if (!normalizedCommentId || !sourceTextHash || !translatedText) {
        return;
    }
    commentTranslationBackendWriteQueue[normalizedCommentId] = { comment: { sourceTextHash, translatedText } };
}

function flushCommentTranslationBackendWrites() {
    const keys = Object.keys(commentTranslationBackendWriteQueue);
    if (keys.length === 0) {
        return;
    }
    for (let start = 0; start < keys.length; start += COMMENT_TRANSLATION_BACKEND_WRITE_BATCH_SIZE) {
        const batchKeys = keys.slice(start, start + COMMENT_TRANSLATION_BACKEND_WRITE_BATCH_SIZE);
        const payload = { comments: {} };
        batchKeys.forEach((key) => {
            payload.comments[key] = commentTranslationBackendWriteQueue[key];
            delete commentTranslationBackendWriteQueue[key];
        });
        vercelBackendClientModule.postCommentTranslations(payload).catch(() => {});
    }
}

function normalizeBackendCommentIds(commentIds) {
    return commonUtils
        .ensureArray(commentIds)
        .map((id) => String(id ?? "").trim())
        .filter(Boolean)
        .filter((id, index, array) => array.indexOf(id) === index)
        .sort((left, right) => Number(left) - Number(right));
}

function mergeBackendCommentTranslationEntry(cache, commentId, entry) {
    const commentEntry = commonUtils.isPlainObject(entry?.comment) ? entry.comment : null;
    const sourceTextHash = String(commentEntry?.sourceTextHash ?? "").trim();
    const translatedText = String(commentEntry?.translatedText ?? "").trim();
    if (!sourceTextHash || !translatedText) {
        return false;
    }

    const cacheKey = String(commentId);
    const currentEntry = commonUtils.isPlainObject(cache?.[cacheKey]) ? cache[cacheKey] : {};
    const currentFieldEntry = commonUtils.isPlainObject(currentEntry.comment) ? currentEntry.comment : null;
    if (currentFieldEntry?.sourceTextHash === sourceTextHash && currentFieldEntry.translatedText === translatedText) {
        return false;
    }

    cache[cacheKey] = {
        ...currentEntry,
        comment: {
            sourceTextHash,
            translatedText,
        },
    };
    return true;
}

async function hydrateCommentTranslationsFromBackend(cache, commentIds) {
    const ids = normalizeBackendCommentIds(commentIds);
    if (ids.length === 0) {
        return false;
    }

    try {
        const payload = await vercelBackendClientModule.fetchCommentTranslations(`comments=${ids.join(",")}`);
        const entries = commonUtils.ensureObject(payload?.comments);
        let changed = false;
        Object.entries(entries).forEach(([commentId, entry]) => {
            changed = mergeBackendCommentTranslationEntry(cache, commentId, entry) || changed;
        });
        return changed;
    } catch (error) {
        globalThis.$ctx?.env?.log?.(`Trakt comment translation backend cache read failed: ${error}`);
        return false;
    }
}

async function translateCommentsInPlace(payload, options = {}) {
    const context = globalThis.$ctx;
    const commentEntries = collectCommentTargets(payload);
    if (commentEntries.length === 0) {
        return payload;
    }

    const cache = cacheUtils.loadCommentTranslationCache(context.env);
    const translateableEntries = commonUtils.ensureArray(commentEntries).filter((entry) => shouldTranslateComment(entry.comment));

    // 本地缓存未命中的评论先从后端批量补齐（不受 googleTranslationEnabled 限制，与人物名行为一致）；
    // 后端读取与双语上下文构建相互独立（分别写 google.comments 与 trakt.linkIds/translation 缓存），并行执行
    const missingCommentIds = translateableEntries
        .map((entry) => {
            const sourceText = String(entry.comment.comment ?? "").trim();
            return cacheUtils.getHashedFieldTranslation(cache, entry.comment.id, "comment", sourceText) ? "" : String(entry.comment.id);
        })
        .filter(Boolean);
    const [hydratedChanged, resolveContextLine] = await Promise.all([hydrateCommentTranslationsFromBackend(cache, missingCommentIds), createCommentContextResolver(options)]);
    const targets = translateableEntries.map((entry) => {
        const comment = entry.comment;
        const sourceText = String(comment.comment ?? "").trim();
        const contextLine = resolveContextLine(entry);
        const requestText = contextLine ? googleTranslationContext.buildSourceText(sourceText, contextLine) : sourceText;
        const normalizeTranslatedComment = (translatedText) =>
            contextLine ? googleTranslationContext.removeContextLine(translatedText, contextLine) : String(translatedText ?? "").trim();
        return {
            sourceLanguage: String(comment.language ?? "en").toLowerCase(),
            sourceText: requestText,
            getCachedTranslation() {
                return cacheUtils.getHashedFieldTranslation(cache, comment.id, "comment", sourceText);
            },
            setCachedTranslation(translatedText) {
                const normalizedTranslation = normalizeTranslatedComment(translatedText);
                const targetCacheChanged = cacheUtils.setHashedFieldTranslation(cache, comment.id, "comment", sourceText, normalizedTranslation);
                if (targetCacheChanged) {
                    queueCommentTranslationBackendWrite(comment.id, {
                        sourceTextHash: commonUtils.computeStringHash(sourceText),
                        translatedText: normalizedTranslation,
                    });
                }
                return targetCacheChanged;
            },
            applyTranslation(translatedText, options = {}) {
                comment.comment = options.source === "cache" ? String(translatedText ?? "").trim() : normalizeTranslatedComment(translatedText);
                return true;
            },
        };
    });

    const result = await googleTranslationPipeline.translateTextFieldTargets(targets, {
        googleTranslationEnabled: context.argument.googleTranslationEnabled,
        logFailure(language, error) {
            context.env.log(`Trakt comment translation failed for language=${language}: ${error}`);
        },
    });

    if ((context.argument.googleTranslationEnabled && result.cacheChanged) || hydratedChanged) {
        cacheUtils.saveCommentTranslationCache(context.env, cache);
    }
    flushCommentTranslationBackendWrites();

    return payload;
}

async function handleComments() {
    const comments = JSON.parse(globalThis.$ctx.responseBody);
    const hasCommentPayload =
        (commonUtils.isArray(comments) && comments.length > 0) ||
        (commonUtils.isPlainObject(comments) && commonUtils.isNonNullish(comments.id) && typeof comments.comment === "string");
    if (!hasCommentPayload) {
        return { type: "passThrough" };
    }

    await translateCommentsInPlace(comments);
    return {
        type: "respond",
        body: JSON.stringify(comments),
    };
}

async function handleRecentCommentsList() {
    const data = JSON.parse(globalThis.$ctx.responseBody);
    if (commonUtils.isNotArray(data) || data.length === 0) {
        return { type: "passThrough" };
    }

    const originalTitles = createRecentCommentOriginalTitleMap(data);
    await mediaTranslationHelper.translateMediaItemsInPlace(data);
    await translateCommentsInPlace(data, { originalTitles });

    return {
        type: "respond",
        body: JSON.stringify(data),
    };
}

export { handleComments, handleRecentCommentsList };
