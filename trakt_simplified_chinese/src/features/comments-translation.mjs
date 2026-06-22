import * as googleTranslationContext from "../shared/google-translation-context.mjs";
import * as googleTranslationPipeline from "../shared/google-translation-pipeline.mjs";
import * as mediaTypes from "../shared/media-types.mjs";
import * as traktLinkIds from "../shared/trakt-link-ids.mjs";
import * as mediaTranslationHelper from "../shared/trakt-translation-helper.mjs";
import * as cacheUtils from "../utils/cache.mjs";
import * as commonUtils from "../utils/common.mjs";

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

function buildRequestCommentContextLine(requestTarget, linkCache, mediaCache) {
    if (!requestTarget) {
        return "";
    }

    if (requestTarget.mediaType === mediaTypes.MEDIA_TYPE.MOVIE || requestTarget.mediaType === mediaTypes.MEDIA_TYPE.SHOW) {
        const linkEntry = traktLinkIds.getLinkIdsCacheEntry(linkCache, requestTarget.traktId);
        const translationEntry = mediaTranslationHelper.getCachedTranslation(mediaCache, requestTarget.mediaType, requestTarget);
        return buildBilingualContextLine(linkEntry?.title, translationEntry?.translation?.title);
    }

    if (requestTarget.mediaType === mediaTypes.MEDIA_TYPE.EPISODE) {
        const linkEntry = traktLinkIds.getEpisodeLinkIdsCacheEntry(linkCache, requestTarget.showId, requestTarget.seasonNumber, requestTarget.episodeNumber);
        const translationEntry = mediaTranslationHelper.getCachedTranslation(mediaCache, mediaTypes.MEDIA_TYPE.EPISODE, requestTarget);
        return buildBilingualContextLine(linkEntry?.title, translationEntry?.translation?.title);
    }

    return "";
}

function createCommentContextResolver(options = {}) {
    const requestTarget = resolveCommentRequestTarget();
    const hasRequestContext = !!requestTarget;
    const linkCache = hasRequestContext ? cacheUtils.loadLinkIdsCache(globalThis.$ctx.env) : {};
    const mediaCache = hasRequestContext ? cacheUtils.loadCache(globalThis.$ctx.env) : {};
    const requestContextLine = buildRequestCommentContextLine(requestTarget, linkCache, mediaCache);

    return (entry) => {
        const recentContextLine = buildRecentCommentContextLine(entry.comment, entry.item, options.originalTitles);
        return recentContextLine || requestContextLine;
    };
}

async function translateCommentsInPlace(payload, options = {}) {
    const context = globalThis.$ctx;
    const commentEntries = collectCommentTargets(payload);
    if (commentEntries.length === 0) {
        return payload;
    }

    const cache = cacheUtils.loadCommentTranslationCache(context.env);
    const resolveContextLine = createCommentContextResolver(options);
    const targets = commonUtils
        .ensureArray(commentEntries)
        .filter((entry) => shouldTranslateComment(entry.comment))
        .map((entry) => {
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
                    return cacheUtils.setHashedFieldTranslation(cache, comment.id, "comment", sourceText, normalizeTranslatedComment(translatedText));
                },
                applyTranslation(translatedText) {
                    comment.comment = normalizeTranslatedComment(translatedText);
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

    if (context.argument.googleTranslationEnabled && result.cacheChanged) {
        cacheUtils.saveCommentTranslationCache(context.env, cache);
    }

    return payload;
}

async function handleComments() {
    const comments = JSON.parse(globalThis.$ctx.responseBody);
    if (commonUtils.isNotArray(comments) || comments.length === 0) {
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
