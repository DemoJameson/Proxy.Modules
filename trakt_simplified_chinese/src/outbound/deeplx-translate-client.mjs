import * as googleTranslationContext from "../shared/google-translation-context.mjs";
import { ensureArray } from "../utils/common.mjs";
import * as httpUtils from "../utils/http.mjs";
import * as translationBatching from "./translation-batching.mjs";

const {
    buildRequestText,
    createConcurrencyLimiter,
    createTranslationItem,
    estimateUtf8Bytes,
    getItemContextCharacterOverhead,
    getItemContexts,
    localizeForeignNameSeparator,
    normalizeSourceLanguage,
    sleep,
    splitTextByLimit,
} = translationBatching;

const DEEPLX_TRANSLATE_API_URL = "https://deeplx.demojameson.de5.net/deepl";
const DEEPLX_TARGET_LANGUAGE = "ZH";
const DEEPLX_BATCH_SEPARATOR_PATTERN = "\\n¶\\d+¶\\n";
const DEEPLX_MAX_TEXT_CHARACTERS = 1500;
const DEEPLX_MAX_REQUEST_BYTES = 96 * 1024;
const DEEPLX_MAX_CONCURRENT_BATCHES = 20;
const DEEPLX_MAX_RETRIES = 2;
const DEEPLX_RETRY_DELAY_MS = 120;
const DEEPLX_REQUEST_TIMEOUT_MS = 30_000;
const DEEPLX_RETRY_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

const limitDeepLxRequest = createConcurrencyLimiter(DEEPLX_MAX_CONCURRENT_BATCHES);

function isTransientStatusCode(statusCode) {
    return DEEPLX_RETRY_STATUS_CODES.has(Number(statusCode));
}

function extractDeepLxTranslatedText(payload) {
    return String(payload?.data ?? payload?.translation ?? payload?.translated_text ?? payload?.translatedText ?? "");
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

async function postDeepLxPayload(payload) {
    const response = await httpUtils.post({
        url: DEEPLX_TRANSLATE_API_URL,
        timeout: DEEPLX_REQUEST_TIMEOUT_MS,
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

async function translateDeepLxText(text, sourceLanguage, contexts = []) {
    const payload = await postDeepLxPayloadWithRetry(buildDeepLxPayload(text, sourceLanguage));
    return googleTranslationContext.stripKnownContextHeader(extractDeepLxTranslatedText(payload), contexts);
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
    return parts.length === itemCount ? parts.map((part, index) => googleTranslationContext.stripKnownContextHeader(part, [normalizedItems[index]?.context])) : null;
}

function buildJoinedBatchText(items) {
    return buildRequestText(items);
}

async function translateOversizedText(text, sourceLanguage) {
    const item = createTranslationItem(text);
    const segmentMaxCharacters = DEEPLX_MAX_TEXT_CHARACTERS - getItemContextCharacterOverhead(item);
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
            try {
                return await translateDeepLxText(payloadText, sourceLanguage, [item.context]);
            } catch (e) {
                // 分段失败以空串兜底，不再因单段失败丢弃整条译文（其余分段仍保留）。
                return "";
            }
        }),
    );
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

async function translateTextsWithDeeplx(texts, sourceLanguage) {
    const normalizedTexts = ensureArray(texts).map((item) => String(item ?? ""));
    if (normalizedTexts.length === 0) {
        return [];
    }

    const batches = createDeepLxBatches(normalizedTexts, sourceLanguage);
    const batchResults = await Promise.all(batches.map((batch) => translateDeepLxBatch(batch, sourceLanguage)));
    const translatedTexts = new Array(normalizedTexts.length).fill("");
    batchResults.flat().forEach((item) => {
        translatedTexts[item.index] = localizeForeignNameSeparator(item.translatedText);
    });

    return translationBatching.extractTranslatedTexts(translationBatching.buildGoogleCompatiblePayload(translatedTexts), normalizedTexts);
}

export { DEEPLX_MAX_TEXT_CHARACTERS, DEEPLX_TRANSLATE_API_URL, translateTextsWithDeeplx };
