const { getKvConfig, readAllTranslationOverridesFromKv, sendKvNotConfigured } = require("./translation-cache");

module.exports = async (req, res) => {
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

        res.setHeader("Cache-Control", "public, max-age=8");
        res.status(200).json(await readAllTranslationOverridesFromKv(kvConfig));
    } catch (error) {
        res.status(500).json({
            error: error instanceof Error ? error.message : String(error),
        });
    }
};
