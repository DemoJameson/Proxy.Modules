import * as googleTranslateClient from "../outbound/google-translate-client.mjs";
import * as googleTranslationPipeline from "../shared/google-translation-pipeline.mjs";
import * as translationEngine from "../shared/translation-engine.mjs";
import * as commonUtils from "../utils/common.mjs";

// 谷歌兜底翻译：仅引擎为 google 时启用，译文只写入本次响应对象，
// 不写本地缓存、不回写远端（pipeline target 不带任何缓存回调）。
async function applyUncachedGoogleTranslation(context, fieldTargets) {
    if (translationEngine.resolveTranslationEngine() !== "google") {
        return false;
    }

    const targets = commonUtils
        .ensureArray(fieldTargets)
        .filter((fieldTarget) => {
            if (fieldTarget?.skip || !commonUtils.isPlainObject(fieldTarget?.target)) {
                return false;
            }
            const value = fieldTarget.target[fieldTarget.field];
            return typeof value === "string" && value.trim() !== "" && !commonUtils.containsChineseCharacter(value);
        })
        .map((fieldTarget) => {
            const { target, field } = fieldTarget;
            return {
                sourceLanguage: "en",
                sourceText: target[field].trim(),
                applyTranslation(translatedText) {
                    target[field] = translatedText;
                    return true;
                },
            };
        });
    if (targets.length === 0) {
        return false;
    }

    try {
        await googleTranslationPipeline.translateTextFieldTargets(targets, {
            translationEngine: "google",
            // 注入纯谷歌客户端：失败不回退 DeepLX，静默保留原文
            translateTexts: googleTranslateClient.translateTextsWithGoogle,
            logFailure(language, error) {
                context.env.log(`Trakt uncached google translation failed for language=${language}: ${error}`);
            },
        });
    } catch (error) {
        context.env.log(`Trakt uncached google translation failed: ${error}`);
    }
    return true;
}

async function handleMediaVideos() {
    const context = globalThis.$ctx;
    const videos = commonUtils.parseJsonBody(context.responseBody);
    if (commonUtils.isNotArray(videos) || videos.length === 0) {
        return { type: "passThrough" };
    }

    await applyUncachedGoogleTranslation(
        context,
        videos.filter((video) => commonUtils.isPlainObject(video)).map((video) => ({ target: video, field: "title" })),
    );
    return { type: "respond", body: JSON.stringify(videos) };
}

export { applyUncachedGoogleTranslation, handleMediaVideos };
