import * as commonUtils from "../utils/common.mjs";
import * as translationEngine from "./translation-engine.mjs";

function normalizeTranslation(value) {
    return String(value ?? "").trim();
}

async function translateTextFieldTargets(targets, options = {}) {
    const normalizedTargets = commonUtils.ensureArray(targets);
    const engineEnabled = translationEngine.isTranslationEnabled(options.translationEngine);
    // 注入的 translateTexts（测试用）不套回退；否则 google 引擎失败后自动回退 DeepLX。
    const translateTexts = options.translateTexts || translationEngine.selectTranslateTextsWithFallback(options.translationEngine);
    const pendingByLanguage = {};
    let changed = false;
    let cacheChanged = false;
    let cacheHitCount = 0;
    let translatedCount = 0;

    normalizedTargets.forEach((target) => {
        if (!commonUtils.isPlainObject(target)) {
            return;
        }

        const sourceText = normalizeTranslation(target.sourceText);
        if (!sourceText) {
            return;
        }

        const cachedTranslation = typeof target.getCachedTranslation === "function" ? normalizeTranslation(target.getCachedTranslation(sourceText, target)) : "";
        if (cachedTranslation) {
            cacheHitCount += 1;
            if (typeof target.applyTranslation === "function") {
                changed =
                    target.applyTranslation(cachedTranslation, {
                        source: "cache",
                        sourceText,
                        target,
                    }) !== false || changed;
            }
            return;
        }

        if (!engineEnabled) {
            return;
        }

        const sourceLanguage =
            String(target.sourceLanguage ?? "en")
                .trim()
                .toLowerCase() || "en";
        if (!pendingByLanguage[sourceLanguage]) {
            pendingByLanguage[sourceLanguage] = [];
        }
        pendingByLanguage[sourceLanguage].push({ ...target, sourceText });
    });

    const pendingEntries = Object.entries(pendingByLanguage);
    const translationResults = await Promise.allSettled(
        pendingEntries.map(([language, languageTargets]) => {
            const sourceTexts = languageTargets.map((target) => target.sourceText);
            return translateTexts(sourceTexts, language);
        }),
    );
    let firstError = null;

    pendingEntries.forEach(([language, languageTargets], resultIndex) => {
        const result = translationResults[resultIndex];
        if (result.status === "rejected") {
            if (typeof options.logFailure === "function") {
                options.logFailure(language, result.reason);
            }
            if (!firstError) {
                firstError = result.reason;
            }
            return;
        }

        const translatedTexts = result.value;
        languageTargets.forEach((target, index) => {
            const translatedText = normalizeTranslation(translatedTexts[index]);
            if (!translatedText) {
                return;
            }

            if (typeof target.shouldAcceptTranslation === "function" && !target.shouldAcceptTranslation(translatedText, target)) {
                return;
            }

            if (typeof target.setCachedTranslation === "function") {
                const targetCacheChanged = target.setCachedTranslation(translatedText, target);
                cacheChanged = targetCacheChanged || cacheChanged;
                changed = targetCacheChanged || changed;
            }
            if (typeof target.applyTranslation === "function") {
                changed =
                    target.applyTranslation(translatedText, {
                        source: "google",
                        sourceText: target.sourceText,
                        target,
                    }) !== false || changed;
            }
            translatedCount += 1;
        });
    });

    if (options.throwOnFailure && firstError) {
        throw firstError;
    }

    return {
        cacheHitCount,
        cacheChanged,
        changed,
        pendingCount: Object.values(pendingByLanguage).reduce((count, group) => count + group.length, 0),
        translatedCount,
    };
}

export { translateTextFieldTargets };
