const { next } = require("@vercel/functions");

const { SCRIPT_USER_AGENT_PATTERN } = require("./lib/trakt-cache/script-auth");

// Routing Middleware 在 CDN 缓存前执行：合法脚本请求继续走共享缓存，
// 非法 UA 直接返回不可缓存的 403，因此不需要按 User-Agent 拆分缓存。
function middleware(request) {
    const userAgent = String(request.headers?.get?.("user-agent") ?? "");
    if (SCRIPT_USER_AGENT_PATTERN.test(userAgent)) {
        return next();
    }

    return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: {
            "Cache-Control": "no-store",
            "Content-Type": "application/json",
        },
    });
}

module.exports = middleware;
module.exports.default = middleware;
