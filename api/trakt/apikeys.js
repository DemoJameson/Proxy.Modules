// 脚本 API key 下发接口。
//
// 背景：脚本产物发布在公开仓库，任何硬编码在源码里的第三方 key 都等于公开。
// 把 key 收敛到部署环境变量后，轮换 key 只需要改 Vercel 环境变量并重新部署，
// 不必等待所有用户重新拉取脚本产物。
//
// 注意：本接口不是安全边界——脚本本身公开，能读脚本的人也能拼出这个 URL。
// 这里只用脚本 UA 做一道软门槛，拦掉 curl / 扫描器的顺手采集。

const TMDB_API_KEY_ENV = "TMDB_API_KEY";
const SCRIPT_USER_AGENT_PATTERN = /TraktSimplifiedChinese\/\d+/i;

function readEnvTrimmed(name) {
    return String(process.env[name] || "").trim();
}

// 只下发已配置的 key：未配置的服务不出现在响应里，避免脚本拿到空串误判为"有 key"。
function buildApiKeys() {
    const keys = {};
    const tmdbApiKey = readEnvTrimmed(TMDB_API_KEY_ENV);
    if (tmdbApiKey) {
        keys.tmdb = tmdbApiKey;
    }
    return keys;
}

module.exports = async (req, res) => {
    if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        res.status(405).json({ error: "Method not allowed" });
        return;
    }

    const userAgent = String(req.headers?.["user-agent"] ?? "");
    if (!SCRIPT_USER_AGENT_PATTERN.test(userAgent)) {
        res.status(403).json({ error: "Forbidden" });
        return;
    }

    const keys = buildApiKeys();
    if (Object.keys(keys).length === 0) {
        res.status(500).json({
            error: `No API key is configured. Set ${TMDB_API_KEY_ENV} to serve script API keys.`,
        });
        return;
    }

    // 关闭中间层缓存：key 轮换需要立刻生效，脚本侧自行做带 TTL 的本地缓存。
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ keys });
};
