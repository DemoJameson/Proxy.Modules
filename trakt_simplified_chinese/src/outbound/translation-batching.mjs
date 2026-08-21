import * as googleTranslationContext from "../shared/google-translation-context.mjs";
import { ensureArray } from "../utils/common.mjs";

// 通用翻译批处理/切分逻辑，与具体翻译后端（DeepLX / 谷歌）无关。
// 各后端客户端负责：请求构造、HTTP 调用、响应解析、目标语言与长度上限等差异。

const LONG_TEXT_SPLIT_BOUNDARY_PATTERN = /[\n。！？.!?;；]/;
const LONG_TEXT_SPLIT_SEARCH_WINDOW = 250;

// DeepLX 译音名习惯用半角 - 分隔音节（如 汤姆-汉克斯），改为中文间隔号 · 以符合中文译名规范。
// 只替换前后均为 CJK 汉字的 -，保留英文连字符、日期、数字范围等。
function localizeForeignNameSeparator(text) {
    return String(text ?? "").replace(/[\u4e00-\u9fa5](?:-[\u4e00-\u9fa5])+/g, (match) => match.replace(/-/g, "·"));
}

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

function getItemContexts(items) {
    return ensureArray(items).map((item) => item.context);
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

function buildItemRequestText(item) {
    return item.context ? googleTranslationContext.buildSourceText(item.requestText, item.context) : String(item.requestText ?? "");
}

function buildRequestText(items) {
    const normalizedItems = ensureArray(items);
    return normalizedItems.map((item, index) => (index === 0 ? buildItemRequestText(item) : `${buildBatchSeparator(index)}${buildItemRequestText(item)}`)).join("");
}

function getItemContextCharacterOverhead(item) {
    return item.context ? googleTranslationContext.buildSourceText("x", item.context).length - 1 : 0;
}

// 把翻译结果数组塑造成上层 pipeline 期望的 {data:{translations:[{translatedText}]}} 形态。
// repair=true（DeepLX 默认）会做《》补全等译文修复；Google 引擎传 repair=false 跳过这些 DeepLX 专属后处理。
function buildGoogleCompatiblePayload(translatedTexts, { repair = true } = {}) {
    return {
        data: {
            translations: ensureArray(translatedTexts).map((translatedText) => ({
                translatedText: repair ? googleTranslationContext.repairTranslatedText(translatedText) : String(translatedText ?? ""),
            })),
        },
    };
}

function extractTranslatedTexts(payload, texts) {
    const translations = ensureArray(payload?.data?.translations);
    return texts.map((_, index) => String(translations[index]?.translatedText ?? ""));
}

export {
    buildBatchSeparator,
    buildGoogleCompatiblePayload,
    buildItemRequestText,
    buildRequestText,
    createConcurrencyLimiter,
    createTranslationItem,
    estimateUtf8Bytes,
    extractTranslatedTexts,
    findSplitIndexNear,
    getItemContextCharacterOverhead,
    getItemContexts,
    getLongTextMinTrailingCharacters,
    localizeForeignNameSeparator,
    normalizeSourceLanguage,
    sleep,
    splitTextByLimit,
    splitTextEvenlyByLimit,
    splitTextGreedilyByLimit,
};
