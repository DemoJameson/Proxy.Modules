// 脚本出站请求的身份标识：自建后端按 TraktSimplifiedChinese/<构建版本> 区分请求来源与脚本版本。
// 版本号在构建时由 esbuild define 注入，未注入时回退 unknown。

const SCRIPT_CLIENT_NAME = "TraktSimplifiedChinese";

function getScriptVersion() {
    return String(globalThis.__SCRIPT_BUILD_VERSION__ || "unknown");
}

// 已有 UA 时追加在其后，便于上游同时识别既有客户端与脚本版本
function buildScriptUserAgent(baseUserAgent) {
    const scriptUserAgent = `${SCRIPT_CLIENT_NAME}/${getScriptVersion()}`;
    const base = String(baseUserAgent ?? "").trim();
    return base ? `${base} ${scriptUserAgent}` : scriptUserAgent;
}

export { buildScriptUserAgent, getScriptVersion, SCRIPT_CLIENT_NAME };
