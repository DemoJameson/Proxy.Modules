const { authorizeScriptRequest } = require("../../lib/trakt-cache/script-auth");
const { getKvConfig, readAllTranslationOverridesFromKv, sendKvNotConfigured } = require("./translation-cache");

module.exports = async (req, res) => {
    if (!authorizeScriptRequest(req, res)) {
        return;
    }

    try {
        if (req.method !== "GET") {
            res.setHeader("Allow", "GET");
            res.status(405).json({ error: "Method not allowed" });
            return;
        }

        const kvConfig = getKvConfig();
        if (!kvConfig) {
            sendKvNotConfigured(res);
            return;
        }

        // 修订表是全局单 URL，CDN 基础缓存 5 分钟，并允许 5 分钟 stale-while-revalidate；
        // 脚本侧另有 24 小时刷新节流（TRANSLATION_OVERRIDES_REFRESH_INTERVAL_MS），管理端修改最坏约 24 小时生效。
        res.setHeader("Cache-Control", "public, max-age=60");
        res.setHeader("CDN-Cache-Control", "public, s-maxage=300, stale-while-revalidate=300");
        res.setHeader("Vercel-CDN-Cache-Control", "public, s-maxage=300, stale-while-revalidate=300");
        res.status(200).json(await readAllTranslationOverridesFromKv(kvConfig));
    } catch (error) {
        res.status(500).json({
            error: error instanceof Error ? error.message : String(error),
        });
    }
};
