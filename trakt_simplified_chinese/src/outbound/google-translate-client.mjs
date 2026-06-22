import * as googleTranslationContext from "../shared/google-translation-context.mjs";
import { ensureArray } from "../utils/common.mjs";
import * as httpUtils from "../utils/http.mjs";

const DEEPLX_TRANSLATE_API_URL = "https://deeplx.demojameson.de5.net/deepl";
const DEEPLX_TARGET_LANGUAGE = "ZH";
const DEEPLX_BATCH_SEPARATOR_PATTERN = "\\n¶\\d+¶\\n";
const DEEPLX_MAX_TEXT_CHARACTERS = 5000;
const DEEPLX_MAX_REQUEST_BYTES = 96 * 1024;
const DEEPLX_MAX_CONCURRENT_BATCHES = 20;
const DEEPLX_MAX_RETRIES = 2;
const DEEPLX_RETRY_DELAY_MS = 120;
const DEEPLX_RETRY_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const LONG_TEXT_SPLIT_BOUNDARY_PATTERN = /[\n。！？.!?;；]/;
const LONG_TEXT_SPLIT_SEARCH_WINDOW = 250;

function createConcurrencyLimiter(concurrency) {
    let activeCount = 0;
    const queue = [];

    function runNext() {
        if (activeCount >= concurrency || queue.length === 0) {
            return;
        }

        const entry = queue.shift();
        activeCount += 1;
        Promise.resolve()
            .then(entry.task)
            .then(entry.resolve, entry.reject)
            .finally(() => {
                activeCount -= 1;
                runNext();
            });
    }

    return function limit(task) {
        return new Promise((resolve, reject) => {
            queue.push({ task, resolve, reject });
            runNext();
        });
    };
}

const limitDeepLxRequest = createConcurrencyLimiter(DEEPLX_MAX_CONCURRENT_BATCHES);

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSourceLanguage(sourceLanguage) {
    const value = String(sourceLanguage ?? "en")
        .trim()
        .toUpperCase();
    return value || "EN";
}

function buildBatchSeparator(index) {
    return `\n¶${index}¶\n`;
}

function estimateUtf8Bytes(value) {
    const text = String(value ?? "");
    let bytes = 0;
    for (let index = 0; index < text.length; index += 1) {
        const codePoint = text.codePointAt(index) ?? 0;
        if (codePoint > 0xffff) {
            index += 1;
        }
        if (codePoint <= 0x7f) {
            bytes += 1;
        } else if (codePoint <= 0x7ff) {
            bytes += 2;
        } else if (codePoint <= 0xffff) {
            bytes += 3;
        } else {
            bytes += 4;
        }
    }
    return bytes;
}

function buildDeepLxPayload(text, sourceLanguage) {
    return {
        text: String(text ?? ""),
        source_lang: normalizeSourceLanguage(sourceLanguage),
        target_lang: DEEPLX_TARGET_LANGUAGE,
    };
}

function estimateDeepLxRequestBytes(text, sourceLanguage) {
    return estimateUtf8Bytes(JSON.stringify(buildDeepLxPayload(text, sourceLanguage)));
}

function isTransientStatusCode(statusCode) {
    return DEEPLX_RETRY_STATUS_CODES.has(Number(statusCode));
}

function extractDeepLxTranslatedText(payload) {
    return String(payload?.data ?? payload?.translation ?? payload?.translated_text ?? payload?.translatedText ?? "");
}

async function postDeepLxPayload(payload) {
    const response = await httpUtils.post({
        url: DEEPLX_TRANSLATE_API_URL,
        headers: {
            accept: "application/json",
            "content-type": "application/json;charset=UTF-8",
        },
        body: JSON.stringify(payload),
    });
    const statusCode = httpUtils.getResponseStatusCode(response);
    if (statusCode < 200 || statusCode >= 300) {
        const error = new Error(`HTTP ${statusCode} for ${DEEPLX_TRANSLATE_API_URL}`);
        error.statusCode = statusCode;
        throw error;
    }

    try {
        return JSON.parse(response.body);
    } catch (e) {
        throw new Error(`JSON parse failed for ${DEEPLX_TRANSLATE_API_URL}: ${e}`);
    }
}

async function postDeepLxPayloadWithRetry(payload) {
    let lastError = null;
    for (let attempt = 0; attempt <= DEEPLX_MAX_RETRIES; attempt += 1) {
        try {
            return await limitDeepLxRequest(() => postDeepLxPayload(payload));
        } catch (error) {
            lastError = error;
            if (!isTransientStatusCode(error?.statusCode) || attempt >= DEEPLX_MAX_RETRIES) {
                throw error;
            }
            await sleep(DEEPLX_RETRY_DELAY_MS * (attempt + 1));
        }
    }
    throw lastError;
}

function getItemContexts(items) {
    return ensureArray(items).map((item) => item.context);
}

async function translateDeepLxText(text, sourceLanguage, contexts = []) {
    const payload = await postDeepLxPayloadWithRetry(buildDeepLxPayload(text, sourceLanguage));
    return googleTranslationContext.stripKnownContextHeader(extractDeepLxTranslatedText(payload), contexts);
}

function findSplitIndexNear(text, preferredEndIndex, minEndIndex, maxEndIndex) {
    const backwardLimit = Math.max(minEndIndex, preferredEndIndex - LONG_TEXT_SPLIT_SEARCH_WINDOW);
    for (let index = preferredEndIndex - 1; index >= backwardLimit; index -= 1) {
        if (LONG_TEXT_SPLIT_BOUNDARY_PATTERN.test(text[index])) {
            return index + 1;
        }
    }

    const forwardLimit = Math.min(maxEndIndex, preferredEndIndex + LONG_TEXT_SPLIT_SEARCH_WINDOW);
    for (let index = preferredEndIndex; index < forwardLimit; index += 1) {
        if (LONG_TEXT_SPLIT_BOUNDARY_PATTERN.test(text[index])) {
            return index + 1;
        }
    }

    return preferredEndIndex;
}

function getLongTextMinTrailingCharacters(maxCharacters) {
    return Math.max(1, Math.floor(Number(maxCharacters) / 2));
}

function splitTextGreedilyByLimit(text, maxCharacters) {
    const normalizedText = String(text ?? "");
    if (maxCharacters <= 0) {
        return [];
    }
    if (normalizedText.length <= maxCharacters) {
        return [normalizedText];
    }

    const chunks = [];
    const minTrailingCharacters = getLongTextMinTrailingCharacters(maxCharacters);
    let startIndex = 0;
    while (startIndex < normalizedText.length) {
        const hardEndIndex = Math.min(startIndex + maxCharacters, normalizedText.length);
        if (hardEndIndex === normalizedText.length) {
            chunks.push(normalizedText.slice(startIndex));
            break;
        }

        const minEndIndex = Math.min(hardEndIndex, startIndex + minTrailingCharacters);
        const splitIndex = findSplitIndexNear(normalizedText, hardEndIndex, minEndIndex, hardEndIndex);

        chunks.push(normalizedText.slice(startIndex, splitIndex));
        startIndex = splitIndex;
    }

    return chunks;
}

function splitTextEvenlyByLimit(text, maxCharacters, chunkCount) {
    const normalizedText = String(text ?? "");
    const chunks = [];
    let startIndex = 0;

    for (let chunkIndex = 0; chunkIndex < chunkCount - 1; chunkIndex += 1) {
        const remainingChunks = chunkCount - chunkIndex - 1;
        const remainingLength = normalizedText.length - startIndex;
        const targetLength = Math.ceil(remainingLength / (remainingChunks + 1));
        const preferredEndIndex = startIndex + targetLength;
        const minEndIndex = Math.max(startIndex + 1, normalizedText.length - remainingChunks * maxCharacters);
        const maxEndIndex = Math.min(startIndex + maxCharacters, normalizedText.length - remainingChunks);
        const splitIndex = findSplitIndexNear(normalizedText, preferredEndIndex, minEndIndex, maxEndIndex);
        chunks.push(normalizedText.slice(startIndex, splitIndex));
        startIndex = splitIndex;
    }

    chunks.push(normalizedText.slice(startIndex));
    return chunks;
}

function splitTextByLimit(text, maxCharacters) {
    const chunks = splitTextGreedilyByLimit(text, maxCharacters);
    const lastChunk = chunks[chunks.length - 1] ?? "";
    if (chunks.length <= 1 || lastChunk.length >= getLongTextMinTrailingCharacters(maxCharacters)) {
        return chunks;
    }

    return splitTextEvenlyByLimit(String(text ?? ""), maxCharacters, chunks.length);
}

function createTranslationItem(text, index = 0) {
    const parsed = googleTranslationContext.parseSourceText(text);
    return {
        index,
        text: String(text ?? ""),
        context: parsed.context,
        requestText: parsed.text,
    };
}

function buildRequestText(items) {
    const normalizedItems = ensureArray(items);
    const contextHeader = googleTranslationContext.buildContextHeader(normalizedItems.map((item) => item.context));
    const bodyText = normalizedItems.map((item, index) => (index === 0 ? item.requestText : `${buildBatchSeparator(index)}${item.requestText}`)).join("");
    return `${contextHeader}${bodyText}`;
}

async function translateOversizedText(text, sourceLanguage) {
    const item = createTranslationItem(text);
    const contextHeader = googleTranslationContext.buildContextHeader([item.context]);
    const segmentMaxCharacters = DEEPLX_MAX_TEXT_CHARACTERS - contextHeader.length;
    const segments = splitTextByLimit(item.requestText, segmentMaxCharacters);
    if (segments.length === 0) {
        return "";
    }

    const translatedSegments = await Promise.all(
        segments.map(async (segment) => {
            const payloadText = buildRequestText([{ ...item, requestText: String(segment ?? "") }]);
            if (!payloadText || payloadText.length > DEEPLX_MAX_TEXT_CHARACTERS || estimateDeepLxRequestBytes(payloadText, sourceLanguage) > DEEPLX_MAX_REQUEST_BYTES) {
                return "";
            }
            return translateDeepLxText(payloadText, sourceLanguage, [item.context]);
        }),
    );
    if (translatedSegments.some((translatedText) => !translatedText)) {
        return "";
    }
    return translatedSegments.join("");
}

function canAddTextToBatch(currentText, nextText, sourceLanguage) {
    const currentItems = ensureArray(currentText);
    const candidate = buildRequestText(currentItems.concat(nextText));
    return candidate.length <= DEEPLX_MAX_TEXT_CHARACTERS && estimateDeepLxRequestBytes(candidate, sourceLanguage) <= DEEPLX_MAX_REQUEST_BYTES;
}

function createDeepLxBatches(texts, sourceLanguage) {
    const batches = [];
    let currentBatch = [];

    texts.forEach((text, index) => {
        const item = createTranslationItem(text, index);
        const singleRequestText = buildRequestText([item]);
        const isOversized = singleRequestText.length > DEEPLX_MAX_TEXT_CHARACTERS || estimateDeepLxRequestBytes(singleRequestText, sourceLanguage) > DEEPLX_MAX_REQUEST_BYTES;
        if (isOversized) {
            if (currentBatch.length > 0) {
                batches.push({ type: "batch", items: currentBatch });
                currentBatch = [];
            }
            batches.push({ type: "oversized", items: [item] });
            return;
        }

        if (currentBatch.length > 0 && !canAddTextToBatch(currentBatch, item, sourceLanguage)) {
            batches.push({ type: "batch", items: currentBatch });
            currentBatch = [];
        }

        currentBatch.push(item);
    });

    if (currentBatch.length > 0) {
        batches.push({ type: "batch", items: currentBatch });
    }

    return batches;
}

function buildJoinedBatchText(items) {
    return buildRequestText(items);
}

function splitJoinedTranslation(translatedText, items) {
    const normalizedText = String(translatedText ?? "");
    const normalizedItems = ensureArray(items);
    const itemCount = normalizedItems.length;
    if (itemCount <= 1) {
        return [googleTranslationContext.stripKnownContextHeader(normalizedText, getItemContexts(normalizedItems))];
    }

    const separatorPattern = new RegExp(DEEPLX_BATCH_SEPARATOR_PATTERN, "g");
    const parts = normalizedText.split(separatorPattern);
    return parts.length === itemCount ? parts.map((part) => googleTranslationContext.stripKnownContextHeader(part, getItemContexts(normalizedItems))) : null;
}

function buildGoogleCompatiblePayload(translatedTexts) {
    return {
        data: {
            translations: ensureArray(translatedTexts).map((translatedText) => ({
                translatedText: googleTranslationContext.repairTranslatedText(translatedText),
            })),
        },
    };
}

async function translateBatchItemsWithFallback(items, sourceLanguage) {
    if (items.length === 0) {
        return [];
    }

    if (items.length === 1) {
        return [await translateDeepLxText(buildJoinedBatchText(items), sourceLanguage, getItemContexts(items))];
    }

    const joinedText = buildJoinedBatchText(items);
    const payload = await postDeepLxPayloadWithRetry(buildDeepLxPayload(joinedText, sourceLanguage));
    const translatedText = extractDeepLxTranslatedText(payload);
    const splitTranslations = splitJoinedTranslation(translatedText, items);
    if (splitTranslations) {
        return splitTranslations;
    }

    return Promise.all(items.map((item) => translateDeepLxText(buildJoinedBatchText([item]), sourceLanguage, [item.context])));
}

async function translateDeepLxBatch(batch, sourceLanguage) {
    if (batch.type === "oversized") {
        const item = batch.items[0];
        return [{ index: item.index, translatedText: await translateOversizedText(item.text, sourceLanguage) }];
    }

    const translatedTexts = await translateBatchItemsWithFallback(batch.items, sourceLanguage);
    return batch.items.map((item, index) => ({
        index: item.index,
        translatedText: translatedTexts[index] ?? "",
    }));
}

function extractTranslatedTexts(payload, texts) {
    const translations = ensureArray(payload?.data?.translations);
    return texts.map((_, index) => String(translations[index]?.translatedText ?? ""));
}

async function translateTextsWithGoogle(texts, sourceLanguage) {
    const normalizedTexts = ensureArray(texts).map((item) => String(item ?? ""));
    if (normalizedTexts.length === 0) {
        return [];
    }

    const batches = createDeepLxBatches(normalizedTexts, sourceLanguage);
    const batchResults = await Promise.all(batches.map((batch) => translateDeepLxBatch(batch, sourceLanguage)));
    const translatedTexts = new Array(normalizedTexts.length).fill("");
    batchResults.flat().forEach((item) => {
        translatedTexts[item.index] = item.translatedText;
    });

    return extractTranslatedTexts(buildGoogleCompatiblePayload(translatedTexts), normalizedTexts);
}

export { translateTextsWithGoogle };
