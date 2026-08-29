module.exports = async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
        res.setHeader("Allow", "GET, HEAD");
        res.status(405).json({ error: "Method not allowed" });
        return;
    }

    const deeplink = typeof req.query.deeplink === "string" ? req.query.deeplink.trim() : "";

    if (!deeplink) {
        res.status(400).json({ error: "Missing deeplink query" });
        return;
    }

    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Location", deeplink);
    res.status(302).end();
};
