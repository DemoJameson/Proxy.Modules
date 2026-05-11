import * as commonUtils from "../utils/common.mjs";
import * as httpUtils from "../utils/http.mjs";

const DOUBAN_API_BASE_URL = "https://frodo.douban.com/api/v2";
const DOUBAN_API_KEY = "0ac44ae016490db2204ce0a042db2916";
const DOUBAN_HEADERS = {
    "User-Agent": "MicroMessenger/",
    Referer: "https://servicewechat.com/wx2f9b06c1de1ccfca",
};

function fetchDoubanJson(url) {
    return httpUtils.fetchJson(url, DOUBAN_HEADERS, false);
}

function searchSubject(query, targetType) {
    const normalizedQuery = String(query ?? "").trim();
    const normalizedTargetType = String(targetType ?? "")
        .trim()
        .toLowerCase();
    if (!normalizedQuery || !normalizedTargetType) {
        return Promise.resolve(null);
    }

    const url = `${DOUBAN_API_BASE_URL}/search/suggestion?q=${encodeURIComponent(normalizedQuery)}&apikey=${DOUBAN_API_KEY}`;
    return fetchDoubanJson(url).then((payload) => {
        return (
            commonUtils
                .ensureArray(payload?.cards)
                .map((card) => ({
                    id: String(card?.target_id ?? card?.target?.id ?? "").trim(),
                    targetType: String(card?.target_type ?? "")
                        .trim()
                        .toLowerCase(),
                }))
                .find((item) => item.id && item.targetType === normalizedTargetType) ?? null
        );
    });
}

function fetchCreditsStats(doubanId) {
    const normalizedDoubanId = String(doubanId ?? "").trim();
    if (!normalizedDoubanId) {
        return Promise.resolve(null);
    }

    return fetchDoubanJson(`${DOUBAN_API_BASE_URL}/movie/${encodeURIComponent(normalizedDoubanId)}/credits_stats?start=0&count=1000&apikey=${DOUBAN_API_KEY}`);
}

function fetchSeasons(tvDoubanId) {
    const normalizedDoubanId = String(tvDoubanId ?? "").trim();
    if (!normalizedDoubanId) {
        return Promise.resolve(null);
    }

    return fetchDoubanJson(`${DOUBAN_API_BASE_URL}/tv/${encodeURIComponent(normalizedDoubanId)}/seasons?apikey=${DOUBAN_API_KEY}`);
}

export { fetchCreditsStats, fetchSeasons, searchSubject };
