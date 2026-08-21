import * as googleTranslationContext from "../shared/google-translation-context.mjs";
import { ensureArray } from "../utils/common.mjs";
import * as httpUtils from "../utils/http.mjs";
import * as translationBatching from "./translation-batching.mjs";

const { createConcurrencyLimiter, createTranslationItem, estimateUtf8Bytes, getItemContextCharacterOverhead, normalizeSourceLanguage, sleep, splitTextByLimit } =
    translationBatching;

// 参考 Traduzir-paginas-web (TPW) 的 Google 翻译实现：
// 端点 translate-pa.googleapis.com/v1/translateHtml + X-goog-api-key 鉴权 + application/json+protobuf。
// 鉴权 key 来自由 Google 翻译前端 JS 动态提取（AIzaSy 开头），失败时回退到硬编码公开 key。

const GOOGLE_PA_TRANSLATE_URL = "https://translate-pa.googleapis.com/v1/translateHtml";
const GOOGLE_TARGET_LANGUAGE = "ZH";
const GOOGLE_FALLBACK_API_KEY = [
    65, 73, 122, 97, 83, 121, 65, 84, 66, 88, 97, 106, 118, 122, 81, 76, 84, 68, 72, 69, 81, 98, 99, 112, 113, 48, 73, 104, 101, 48, 118, 87, 68, 72, 109, 79, 53, 50, 48,
].reduce((s, b) => s + String.fromCharCode(b), "");
const GOOGLE_JS_URL =
    "https://translate.googleapis.com/_/translate_http/_/js/k=translate_http.tr.en_US.YusFYy3P_ro.O/am=AAg/d=1/exm=el_conf/ed=1/rs=AN8SPfq1Hb8iJRleQqQc8zhdzXmF9E56eQ/m=el_main";
// 锚定前端 JS 里 translate-pa 请求头字段名 X-goog-api-key 提取其值（39 位），不锚定 AIzaSy 前缀——
// 字段名本身已足够定位 translate-pa 用的 key。容忍可选反斜杠转义，兼容
// "X-goog-api-key":"..." 与 \"X-goog-api-key\":\"...\" 两种形态。
const GOOGLE_API_KEY_REGEX = /X-goog-api-key\\?["']?\s*:\s*\\?["']([A-Za-z0-9_-]{39})/i;
const GOOGLE_MAX_TEXT_CHARACTERS = 6000;

const GOOGLE_MAX_REQUEST_BYTES = 32 * 1024;
const GOOGLE_MAX_CONCURRENT_BATCHES = 20;
const GOOGLE_MAX_RETRIES = 2;
const GOOGLE_RETRY_DELAY_MS = 120;
const GOOGLE_REQUEST_TIMEOUT_MS = 30_000;
const GOOGLE_RETRY_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const GOOGLE_AUTH_FAILURE_STATUS_CODES = new Set([401, 403]);
const GOOGLE_AUTH_KEY_TTL_MS = 20 * 60 * 1000;
const GOOGLE_AUTH_REFRESH_BACKOFF_MS = 5 * 60 * 1000;

const limitGoogleRequest = createConcurrencyLimiter(GOOGLE_MAX_CONCURRENT_BATCHES);

// 从 Google 翻译前端 JS 动态提取 API key 的单例。
// 提取失败时回退到硬编码公开 key，并在退避窗口后重试，避免对失效 key 反复抓取。
const googleAuth = {
    _key: null,
    _expiresAt: 0,
    _inflight: null,
    async ensureKey() {
        const now = Date.now();
        if (this._key && now < this._expiresAt) {
            return this._key;
        }
        if (this._inflight) {
            return this._inflight;
        }
        this._inflight = this._fetchKey()
            .then((key) => {
                this._key = key;
                this._expiresAt = Date.now() + GOOGLE_AUTH_KEY_TTL_MS;
                return key;
            })
            .catch(() => {
                this._key = GOOGLE_FALLBACK_API_KEY;
                this._expiresAt = Date.now() + GOOGLE_AUTH_REFRESH_BACKOFF_MS;
                return GOOGLE_FALLBACK_API_KEY;
            })
            .finally(() => {
                this._inflight = null;
            });
        return this._inflight;
    },
    async _fetchKey() {
        const response = await httpUtils.get({
            url: GOOGLE_JS_URL,
            timeout: 10_000,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
            },
        });
        const statusCode = httpUtils.getResponseStatusCode(response);
        if (statusCode < 200 || statusCode >= 300) {
            throw new Error(`HTTP ${statusCode} for ${GOOGLE_JS_URL}`);
        }
        const match = GOOGLE_API_KEY_REGEX.exec(String(response.body ?? ""));
        if (!match) {
            throw new Error(`No Google API key found in ${GOOGLE_JS_URL}`);
        }
        return match[1];
    },
    // 清掉缓存 key，让下一次 ensureKey 重新抓取前端 JS（用于 key 失效自愈）。
    invalidate() {
        this._key = null;
        this._expiresAt = 0;
    },
};

function buildGoogleBody(texts, sourceLanguage) {
    return JSON.stringify([[texts, normalizeSourceLanguage(sourceLanguage), GOOGLE_TARGET_LANGUAGE], "te"]);
}

function isTransientStatusCode(statusCode) {
    return GOOGLE_RETRY_STATUS_CODES.has(Number(statusCode));
}

function isAuthFailureStatusCode(statusCode) {
    return GOOGLE_AUTH_FAILURE_STATUS_CODES.has(Number(statusCode));
}

// 按序列化后的完整请求体估算字节（含 [[...],"te"] JSON 包装与转义），避免只校验文本本体而低估。
function estimateGoogleRequestBytes(requestTexts, sourceLanguage) {
    return estimateUtf8Bytes(buildGoogleBody(ensureArray(requestTexts), sourceLanguage));
}

// 上下文用 HTML 注释携带：实测 Google 会把注释原样保留在开头且不翻译其内容，也从不把它复用到正文中
// （与 notranslate span 不同——span 会被 Google 当作"现成的未译片名"塞进正文引用处，破坏剥离）。
// 注释固定在开头，按注释边界剥离最可靠。另：实测 Google 自带片名知识，知名/冷门片名都能正确译出《》，
// 上下文对 Google 主要是防御性携带，剥离干净即可。
const GOOGLE_CONTEXT_COMMENT_OPEN = "<!-- ";
const GOOGLE_CONTEXT_COMMENT_CLOSE = " -->";
const GOOGLE_CONTEXT_COMMENT_PATTERN = /<!--[\s\S]*?-->\s*/g;
const GOOGLE_CONTEXT_COMMENT_OVERHEAD_CHARACTERS = `${GOOGLE_CONTEXT_COMMENT_OPEN}${GOOGLE_CONTEXT_COMMENT_CLOSE}\n`.length;

// 上下文存在时请求体带上 HTML 注释前缀，否则原样返回正文。
function buildGoogleItemRequestText(item) {
    if (!item.context) {
        return String(item.requestText ?? "");
    }
    return `${GOOGLE_CONTEXT_COMMENT_OPEN}${item.context}${GOOGLE_CONTEXT_COMMENT_CLOSE}\n${String(item.requestText ?? "")}`;
}

// 上下文字节开销需计入注释包装长度，避免超长切分时单段请求仍超 6000 字符上限。
function getGoogleItemContextOverhead(item) {
    const base = getItemContextCharacterOverhead(item);
    return base > 0 ? base + GOOGLE_CONTEXT_COMMENT_OVERHEAD_CHARACTERS : 0;
}

// 响应端剥离上下文：全局移除 HTML 注释（含未翻译的上下文内容）+ 收敛空白；
// 注释意外丢失时退回通用上下文剥离（精确匹配 + 本地化名后缀回退）。
function stripGoogleContextHeader(text, context) {
    const value = String(text ?? "");
    const stripped = value.replace(GOOGLE_CONTEXT_COMMENT_PATTERN, "");
    if (stripped !== value) {
        return stripped.replace(/\s{2,}/g, " ").trim();
    }
    return googleTranslationContext.stripKnownContextHeader(value, context ? [context] : []);
}

async function postGooglePayload(payload) {
    const apiKey = await googleAuth.ensureKey();
    const response = await httpUtils.post({
        url: GOOGLE_PA_TRANSLATE_URL,
        timeout: GOOGLE_REQUEST_TIMEOUT_MS,
        headers: {
            "Content-Type": "application/json+protobuf",
            "X-goog-api-key": apiKey,
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        },
        body: payload,
    });
    const statusCode = httpUtils.getResponseStatusCode(response);
    if (statusCode < 200 || statusCode >= 300) {
        const error = new Error(`HTTP ${statusCode} for ${GOOGLE_PA_TRANSLATE_URL}`);
        error.statusCode = statusCode;
        throw error;
    }
    return response.body;
}

async function postGooglePayloadWithRetry(payload) {
    let lastError = null;
    let authRetried = false;
    for (let attempt = 0; attempt <= GOOGLE_MAX_RETRIES; attempt += 1) {
        try {
            return await limitGoogleRequest(() => postGooglePayload(payload));
        } catch (error) {
            lastError = error;
            // key 失效自愈（401/403）：清掉缓存 key，让下一次尝试重新抓取前端 JS，最多额外重试一次。
            // 避免 Google 轮换 key 后，整个 key 缓存 TTL（20 分钟）内所有翻译持续失败。
            if (isAuthFailureStatusCode(error?.statusCode) && !authRetried) {
                authRetried = true;
                googleAuth.invalidate();
                continue;
            }
            if (!isTransientStatusCode(error?.statusCode) || attempt >= GOOGLE_MAX_RETRIES) {
                throw error;
            }
            await sleep(GOOGLE_RETRY_DELAY_MS * (attempt + 1));
        }
    }
    throw lastError;
}

// texts 为字符串时返回翻译字符串，为数组时返回翻译数组（与输入形状一致）。
async function translateGoogleText(requestTexts, sourceLanguage) {
    const raw = await postGooglePayloadWithRetry(buildGoogleBody(requestTexts, sourceLanguage));
    try {
        const parsed = JSON.parse(raw);
        return parsed?.[0] ?? "";
    } catch (e) {
        throw new Error(`JSON parse failed for ${GOOGLE_PA_TRANSLATE_URL}: ${e}`);
    }
}

function createGoogleBatches(texts, sourceLanguage) {
    const batches = [];
    let currentBatch = [];

    const currentRequestTextLength = () => currentBatch.reduce((sum, item) => sum + buildGoogleItemRequestText(item).length, 0);

    texts.forEach((text, index) => {
        const item = createTranslationItem(text, index);
        const requestText = buildGoogleItemRequestText(item);
        const isOversized = requestText.length > GOOGLE_MAX_TEXT_CHARACTERS || estimateGoogleRequestBytes([requestText], sourceLanguage) > GOOGLE_MAX_REQUEST_BYTES;
        if (isOversized) {
            if (currentBatch.length > 0) {
                batches.push({ type: "batch", items: currentBatch });
                currentBatch = [];
            }
            batches.push({ type: "oversized", items: [item] });
            return;
        }

        if (currentBatch.length > 0 && currentRequestTextLength() + requestText.length > GOOGLE_MAX_TEXT_CHARACTERS) {
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

async function translateGoogleOversizedText(text, sourceLanguage) {
    const item = createTranslationItem(text);
    const segmentMaxCharacters = GOOGLE_MAX_TEXT_CHARACTERS - getGoogleItemContextOverhead(item);
    const segments = splitTextByLimit(item.requestText, segmentMaxCharacters);
    if (segments.length === 0) {
        return "";
    }

    let lastSegmentError = null;
    const translatedSegments = await Promise.all(
        segments.map(async (segment) => {
            const payloadText = buildGoogleItemRequestText({ ...item, requestText: String(segment ?? "") });
            if (!payloadText || payloadText.length > GOOGLE_MAX_TEXT_CHARACTERS || estimateGoogleRequestBytes([payloadText], sourceLanguage) > GOOGLE_MAX_REQUEST_BYTES) {
                return "";
            }
            try {
                // 每段请求都带上下文，需逐段剥离注释前缀，避免拼回时上下文在各段间重复残留。
                return stripGoogleContextHeader(await translateGoogleText(payloadText, sourceLanguage), item.context);
            } catch (e) {
                // 分段失败以空串兜底，不再因单段失败丢弃整条译文（其余分段仍保留）。
                lastSegmentError = e;
                return "";
            }
        }),
    );
    const joined = translatedSegments.join("");
    // 全部分段失败时向上抛出，让 withDeeplxFallback 能回退 DeepLX；部分成功则保留已译分段。
    if (!joined && lastSegmentError) {
        throw lastSegmentError;
    }
    return joined;
}

async function translateGoogleBatch(batch, sourceLanguage) {
    if (batch.type === "oversized") {
        const item = batch.items[0];
        return [{ index: item.index, translatedText: await translateGoogleOversizedText(item.text, sourceLanguage) }];
    }

    const requestTexts = batch.items.map(buildGoogleItemRequestText);
    const translatedArray = ensureArray(await translateGoogleText(requestTexts, sourceLanguage));
    return batch.items.map((item, index) => ({
        index: item.index,
        translatedText: stripGoogleContextHeader(translatedArray[index] ?? "", item.context),
    }));
}

async function translateTextsWithGoogle(texts, sourceLanguage) {
    const normalizedTexts = ensureArray(texts).map((item) => String(item ?? ""));
    if (normalizedTexts.length === 0) {
        return [];
    }

    const batches = createGoogleBatches(normalizedTexts, sourceLanguage);
    const batchResults = await Promise.all(batches.map((batch) => translateGoogleBatch(batch, sourceLanguage)));
    const translatedTexts = new Array(normalizedTexts.length).fill("");
    batchResults.flat().forEach((item) => {
        // Google 原生译文已自带《》与·等中文排版，不做 DeepLX 专属的《》补全与人名 - 替换·后处理。
        translatedTexts[item.index] = item.translatedText;
    });

    return translationBatching.extractTranslatedTexts(translationBatching.buildGoogleCompatiblePayload(translatedTexts, { repair: false }), normalizedTexts);
}

export { GOOGLE_FALLBACK_API_KEY, GOOGLE_PA_TRANSLATE_URL, googleAuth, translateTextsWithGoogle };
