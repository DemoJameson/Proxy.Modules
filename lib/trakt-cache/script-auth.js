// 脚本请求的轻量 UA 门槛：拦截 curl / 扫描器的顺手采集。
// 公开脚本本身可被读取，UA 也能伪造，因此这里不是安全边界，只是降低误用与爬取成本。
// 生产环境由根目录 middleware.js 在 CDN 缓存前拦截；函数内保留同规则作为兜底。
const SCRIPT_USER_AGENT_PATTERN = /TraktSimplifiedChinese\/\d+/i;

function authorizeScriptRequest(req, res) {
    const userAgent = String(req.headers?.["user-agent"] ?? "");
    if (SCRIPT_USER_AGENT_PATTERN.test(userAgent)) {
        return true;
    }

    res.setHeader("Cache-Control", "no-store");
    res.status(403).json({ error: "Forbidden" });
    return false;
}

module.exports = { SCRIPT_USER_AGENT_PATTERN, authorizeScriptRequest };
