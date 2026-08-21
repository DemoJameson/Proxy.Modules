import * as deeplxTranslateClient from "../outbound/deeplx-translate-client.mjs";
import * as googleTranslateClient from "../outbound/google-translate-client.mjs";

// 翻译引擎选择的唯一入口：参数归一、启用判断、客户端选择都收敛在这里，
// 避免 pipeline 与各 feature 自行判断导致规则漂移。

const TRANSLATION_ENGINE_LABEL_MAP = {
    谷歌翻译: "google",
    google: "google",
    deeplx: "deeplx",
    off: "off",
    关闭: "off",
};

const TRANSLATION_ENGINE_VALUES = ["google", "deeplx", "off"];

function normalizeTranslationEngine(value) {
    const normalized = String(value ?? "")
        .trim()
        .toLowerCase();
    if (TRANSLATION_ENGINE_LABEL_MAP[normalized]) {
        return TRANSLATION_ENGINE_LABEL_MAP[normalized];
    }
    return TRANSLATION_ENGINE_VALUES.includes(normalized) ? normalized : "google";
}

// 解析当前生效引擎：显式传参优先（非空才生效），缺省回退到脚本参数，最终默认 google。
function resolveTranslationEngine(engine) {
    const explicit = String(engine ?? "").trim();
    if (explicit) {
        return normalizeTranslationEngine(explicit);
    }
    return normalizeTranslationEngine(globalThis.$ctx?.argument?.translationEngine);
}

function isTranslationEnabled(engine) {
    return resolveTranslationEngine(engine) !== "off";
}

function selectTranslateTexts(engine) {
    return resolveTranslationEngine(engine) === "deeplx" ? deeplxTranslateClient.translateTextsWithDeeplx : googleTranslateClient.translateTextsWithGoogle;
}

// 主引擎是 google 且最终失败（已耗尽客户端内部重试与 key 自愈）时，回退到 DeepLX。
// deeplx/off 不回退；主引擎已是 deeplx 时不再包裹。回退成功得到的译文照常进缓存，下次直接命中、不再回退。
function withDeeplxFallback(primaryTranslateTexts, engine) {
    if (resolveTranslationEngine(engine) !== "google" || primaryTranslateTexts === deeplxTranslateClient.translateTextsWithDeeplx) {
        return primaryTranslateTexts;
    }
    const deeplxTranslate = deeplxTranslateClient.translateTextsWithDeeplx;
    return async function translateTextsWithFallback(texts, sourceLanguage) {
        try {
            return await primaryTranslateTexts(texts, sourceLanguage);
        } catch (primaryError) {
            globalThis.$ctx?.env?.log?.(`Trakt 谷歌翻译失败，回退 DeepLX：${primaryError?.message ?? primaryError}`);
            return deeplxTranslate(texts, sourceLanguage);
        }
    };
}

// 便捷封装：按引擎选择主客户端，并在 google 时自动套上 DeepLX 回退。
function selectTranslateTextsWithFallback(engine) {
    return withDeeplxFallback(selectTranslateTexts(engine), engine);
}

export { isTranslationEnabled, normalizeTranslationEngine, resolveTranslationEngine, selectTranslateTexts, selectTranslateTextsWithFallback, withDeeplxFallback };
