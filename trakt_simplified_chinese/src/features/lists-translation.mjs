import * as vercelBackendClientModule from "../outbound/vercel-backend-client.mjs";
import * as googleTranslationPipeline from "../shared/google-translation-pipeline.mjs";
import * as cacheUtils from "../utils/cache.mjs";
import * as commonUtils from "../utils/common.mjs";

const LIST_TRANSLATION_BACKEND_WRITE_BATCH_SIZE = 50;
const LIST_TRANSLATION_FIELDS = ["name", "description"];

const listTranslationBackendWriteQueue = {};

function queueListTranslationBackendWrite(listId, field, fieldEntry) {
    const normalizedListId = String(listId ?? "").trim();
    const sourceTextHash = String(fieldEntry?.sourceTextHash ?? "").trim();
    const translatedText = String(fieldEntry?.translatedText ?? "").trim();
    if (!normalizedListId || !sourceTextHash || !translatedText) {
        return;
    }
    listTranslationBackendWriteQueue[normalizedListId] = {
        ...listTranslationBackendWriteQueue[normalizedListId],
        [field]: {
            sourceTextHash,
            translatedText,
        },
    };
}

function flushListTranslationBackendWrites() {
    const keys = Object.keys(listTranslationBackendWriteQueue);
    if (keys.length === 0) {
        return;
    }
    for (let start = 0; start < keys.length; start += LIST_TRANSLATION_BACKEND_WRITE_BATCH_SIZE) {
        const batchKeys = keys.slice(start, start + LIST_TRANSLATION_BACKEND_WRITE_BATCH_SIZE);
        const payload = { lists: {} };
        batchKeys.forEach((key) => {
            payload.lists[key] = listTranslationBackendWriteQueue[key];
            delete listTranslationBackendWriteQueue[key];
        });
        vercelBackendClientModule.postListTranslations(payload).catch(() => {});
    }
}

function normalizeBackendListIds(listIds) {
    return commonUtils
        .ensureArray(listIds)
        .map((id) => String(id ?? "").trim())
        .filter(Boolean)
        .filter((id, index, array) => array.indexOf(id) === index)
        .sort((left, right) => Number(left) - Number(right));
}

function mergeBackendListTranslationEntry(cache, listId, entry) {
    let changed = false;
    LIST_TRANSLATION_FIELDS.forEach((field) => {
        const fieldEntry = commonUtils.isPlainObject(entry?.[field]) ? entry[field] : null;
        const sourceTextHash = String(fieldEntry?.sourceTextHash ?? "").trim();
        const translatedText = String(fieldEntry?.translatedText ?? "").trim();
        if (!sourceTextHash || !translatedText) {
            return;
        }

        const currentEntry = commonUtils.isPlainObject(cache?.[listId]) ? cache[listId] : {};
        const currentFieldEntry = commonUtils.isPlainObject(currentEntry[field]) ? currentEntry[field] : null;
        if (currentFieldEntry?.sourceTextHash === sourceTextHash && currentFieldEntry.translatedText === translatedText) {
            return;
        }

        cache[listId] = {
            ...currentEntry,
            [field]: {
                sourceTextHash,
                translatedText,
            },
        };
        changed = true;
    });
    return changed;
}

async function hydrateListTranslationsFromBackend(cache, listIds) {
    const ids = normalizeBackendListIds(listIds);
    if (!vercelBackendClientModule.resolveBackendBaseUrl() || ids.length === 0) {
        return false;
    }

    try {
        const payload = await vercelBackendClientModule.fetchListTranslations(`lists=${ids.join(",")}`);
        const entries = commonUtils.ensureObject(payload?.lists);
        let changed = false;
        Object.entries(entries).forEach(([listId, entry]) => {
            changed = mergeBackendListTranslationEntry(cache, listId, entry) || changed;
        });
        return changed;
    } catch (error) {
        globalThis.$ctx?.env?.log?.(`Trakt list translation backend cache read failed: ${error}`);
        return false;
    }
}

function collectListTranslationEntries(lists) {
    const entries = [];
    lists.forEach((item) => {
        const target = commonUtils.isPlainObject(item?.list) ? item.list : commonUtils.isPlainObject(item) ? item : null;
        if (!target) {
            return;
        }

        const listId = commonUtils.isNonNullish(target?.ids?.trakt) ? String(target.ids.trakt) : "";
        LIST_TRANSLATION_FIELDS.forEach((field) => {
            const sourceText = String(target?.[field] ?? "").trim();
            if (!sourceText || commonUtils.containsChineseCharacter(sourceText)) {
                return;
            }
            entries.push({ listId, field, sourceText, target });
        });
    });
    return entries;
}

async function handleList() {
    const context = globalThis.$ctx;
    const lists = JSON.parse(context.responseBody);
    if (commonUtils.isNotArray(lists) || lists.length === 0) {
        return { type: "passThrough" };
    }

    const cache = cacheUtils.loadListTranslationCache(context.env);
    const entries = collectListTranslationEntries(lists);
    if (entries.length === 0) {
        return { type: "respond", body: JSON.stringify(lists) };
    }

    // 本地未命中的片单先从后端批量补齐（不受 translationEngine 限制，与评论/人物名行为一致）
    const missingListIds = entries
        .filter((entry) => entry.listId && !cacheUtils.getHashedFieldTranslation(cache, entry.listId, entry.field, entry.sourceText))
        .map((entry) => entry.listId);
    const hydratedChanged = await hydrateListTranslationsFromBackend(cache, missingListIds);

    const targets = entries.map((entry) => ({
        sourceLanguage: "en",
        sourceText: entry.sourceText,
        getCachedTranslation() {
            return cacheUtils.getHashedFieldTranslation(cache, entry.listId, entry.field, entry.sourceText);
        },
        setCachedTranslation(translatedText) {
            const targetCacheChanged = cacheUtils.setHashedFieldTranslation(cache, entry.listId, entry.field, entry.sourceText, translatedText);
            if (targetCacheChanged && entry.listId) {
                queueListTranslationBackendWrite(entry.listId, entry.field, {
                    sourceTextHash: commonUtils.computeStringHash(entry.sourceText),
                    translatedText: String(translatedText ?? "").trim(),
                });
            }
            return targetCacheChanged;
        },
        applyTranslation(translatedText) {
            entry.target[entry.field] = translatedText;
            return true;
        },
    }));

    const result = await googleTranslationPipeline.translateTextFieldTargets(targets, {
        translationEngine: context.argument.translationEngine,
        logFailure(language, error) {
            context.env.log(`Trakt list description translation failed for language=${language}: ${error}`);
        },
    });

    if (result.cacheChanged || hydratedChanged) {
        cacheUtils.saveListTranslationCache(context.env, cache);
    }
    flushListTranslationBackendWrites();
    return {
        type: "respond",
        body: JSON.stringify(lists),
    };
}

export { handleList };
