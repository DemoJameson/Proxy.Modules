function parseIds(value) {
    if (!value) {
        return [];
    }

    const parts = Array.isArray(value) ? value.join(",").split(",") : String(value).split(",");
    const unique = new Set();

    for (const part of parts) {
        const normalized = String(part).trim();
        if (!/^\d+$/.test(normalized)) {
            continue;
        }
        unique.add(normalized);
    }

    return Array.from(unique);
}

function parseEpisodeKeys(value) {
    if (!value) {
        return [];
    }

    const parts = Array.isArray(value) ? value.join(",").split(",") : String(value).split(",");
    const unique = new Set();

    for (const part of parts) {
        const normalized = String(part).trim();
        if (!/^\d+:\d+:\d+$/.test(normalized)) {
            continue;
        }
        unique.add(normalized);
    }

    return Array.from(unique);
}

function parseSeasonKeys(value) {
    if (!value) {
        return [];
    }

    const parts = Array.isArray(value) ? value.join(",").split(",") : String(value).split(",");
    const unique = new Set();

    for (const part of parts) {
        const normalized = String(part).trim();
        if (!/^\d+:\d+$/.test(normalized)) {
            continue;
        }
        unique.add(normalized);
    }

    return Array.from(unique);
}

async function readJsonBody(req) {
    if (req.body && typeof req.body === "object") {
        return req.body;
    }

    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }

    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? JSON.parse(raw) : {};
}

module.exports = {
    parseIds,
    parseEpisodeKeys,
    parseSeasonKeys,
    readJsonBody,
};
