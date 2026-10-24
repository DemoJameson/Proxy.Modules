/**
 * QX 重写能力探测脚本（公网版）
 *
 * 目标域名改为 httpbin.org，避开 QX 默认 excluded_routes 对局域网 192.168.x.x 的排除：
 * 局域网目标既不抓包也不重写，会导致探测完全失效且 QX 无记录。
 *
 * 按 $request.url 的路径分流：
 * - /status:   响应体重写为 JSON result=ok（验证 script-response-body）
 * - /url:      script-request-header 返回 { url, path }（验证同时给 host 与 path 是否能完成完整跨域改写）
 * - /path:     script-request-header 返回 { path }（验证 path 是否生效）
 * - /anything/echo: 请求阶段记录 $request，响应阶段合并输出 JSON（验证 $prefs 跨阶段共享）
 */

const ECHO_KEY = 'qx_probe_url_echo';
const URL_TARGET = 'https://www.httpbin.org/get?probe=url-path-both';
const PATH_TARGET = '/anything/echo?probe=path-applied';

function getProbeName() {
    const path = String($request?.url ?? '').replace(/^https?:\/\/[^/]+/, '');
    if (path.startsWith('/status')) return 'status';
    if (path.startsWith('/url')) return 'url';
    if (path.startsWith('/path')) return 'path';
    if (path.startsWith('/hostpath')) return 'hostpath';
    if (path.startsWith('/anything/echo')) return 'echo';
    return '';
}

// script-response-body：把 httpbin 的 404 改写成 result=ok 的 JSON
function handleStatus() {
    console.log('[probe] status: rewrite response body to JSON');
    const body = JSON.stringify({ result: 'ok', probe: 'response-body', mode: 'status', timestamp: Date.now() });
    $done({ body });
}

// script-request-header：同时返回 url 与 path，验证「url 只负责换域名、path 负责换路径」能否组合出完整跨域改写
function handleUrlRewrite() {
    const target = new URL(URL_TARGET);
    const targetPath = `${target.pathname}${target.search}`;
    console.log(`[probe] url+path: return url ${URL_TARGET} path ${targetPath}`);
    $done({ url: URL_TARGET, path: targetPath });
}

// script-request-header：返回 path（路径+query，官方支持的形态）
function handlePathRewrite() {
    console.log(`[probe] path: return path ${PATH_TARGET}`);
    $done({ path: PATH_TARGET });
}

// script-request-header：只改域名不改变量路径，配合 path 观察「分别改 host 与 path」
function handleHostPathRewrite() {
    const targetPath = '/anything/hostpath?probe=host-path-applied';
    console.log(`[probe] host+path: return url https://www.httpbin.org${targetPath} path ${targetPath}`);
    $done({ url: `https://www.httpbin.org${targetPath}`, path: targetPath });
}

// 请求阶段：把 QX 真实交给脚本的内容记录下来
function handleEchoRequest() {
    const record = {
        probe: 'request-view',
        url: $request.url ?? '',
        path: $request.path ?? '',
        headers: $request.headers ?? {},
    };
    console.log(`[probe] echo request: ${JSON.stringify(record)}`);
    $prefs.setValueForKey(JSON.stringify(record), ECHO_KEY);
    // 请求头改写是 QX 明确支持的能力；httpbin 会把这个头回显在 headers 里，
    // 即使响应阶段脚本没跑，也能证明请求阶段脚本执行过。
    const headers = { ...($request.headers ?? {}) };
    headers['X-Probe-Request'] = 'yes';
    $done({ headers });
}

// 响应阶段：把请求阶段记录的内容与服务器回显合并成 JSON，页面直接可见
function handleEchoResponse() {
    const raw = $prefs.valueForKey(ECHO_KEY) ?? '';
    console.log(`[probe] echo response: ${raw || '(empty)'}`);
    let requestView = null;
    try {
        requestView = raw ? JSON.parse(raw) : null;
    } catch {
        requestView = { parseError: true, raw: String(raw).slice(0, 500) };
    }
    let serverView = null;
    try {
        serverView = $response?.body ? JSON.parse($response.body) : null;
    } catch {
        serverView = { parseError: true };
    }
    const body = JSON.stringify(
        { result: requestView ? 'ok' : 'no-request-record', probe: 'request-response-sync', requestView, serverView },
        null,
        2,
    );
    $done({ body });
}

const probe = getProbeName();
const isResponsePhase = typeof $response !== 'undefined';
console.log(`[probe] dispatch: probe=${probe || 'unknown'} phase=${isResponsePhase ? 'response' : 'request'} url=${$request?.url ?? ''}`);

switch (probe) {
    case 'status':
        if (isResponsePhase) handleStatus();
        else $done({});
        break;
    case 'url':
        if (!isResponsePhase) handleUrlRewrite();
        else $done({});
        break;
    case 'path':
        if (!isResponsePhase) handlePathRewrite();
        else $done({});
        break;
    case 'hostpath':
        if (!isResponsePhase) handleHostPathRewrite();
        else $done({});
        break;
    case 'echo':
        if (isResponsePhase) handleEchoResponse();
        else handleEchoRequest();
        break;
    default:
        console.log(`[probe] unknown probe path: ${$request?.url ?? ''}`);
        $done({});
}
