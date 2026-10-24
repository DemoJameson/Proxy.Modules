/**
 * QX 重写能力探测脚本
 *
 * QX 重写脚本没有 $argument，因此按 $request.url 的路径分流：
 * - /status:   响应体重写为 JSON result=ok（验证 script-response-body）
 * - /url:      script-request-header 返回 { url }（验证跨域 url 是否被支持/半套用）
 * - /path:     script-request-header 返回 { path }（验证 path 是否生效）
 * - /echo:     请求阶段记录 $request，响应阶段合并输出 JSON（验证 $prefs 跨阶段共享）
 */

const TARGET_HOST = '192.168.50.3:18765';
const ECHO_KEY = 'qx_probe_url_echo';
const URL_TARGET = 'https://httpbin.org/get?probe=url';
const PATH_TARGET = '/echo?probe=path-applied';

function getProbeName() {
    const path = String($request?.url ?? '').replace(/^https?:\/\/[^/]+/, '');
    if (path.startsWith('/status')) return 'status';
    if (path.startsWith('/url')) return 'url';
    if (path.startsWith('/path')) return 'path';
    if (path.startsWith('/echo')) return 'echo';
    return '';
}

// script-response-body：把服务器 404 JSON 改写成 result=ok 的 JSON
function handleStatus() {
    console.log('[probe] status: rewrite response body to JSON');
    const body = JSON.stringify({ result: 'ok', probe: 'response-body', mode: 'status', timestamp: Date.now() });
    $done({ body });
}

// script-request-header：返回完整跨域 url（观察 QX 是否应用 / 半套用）
function handleUrlRewrite() {
    console.log(`[probe] url: return full url ${URL_TARGET}`);
    $done({ url: URL_TARGET });
}

// script-request-header：返回 path（路径+query，官方支持的形态）
function handlePathRewrite() {
    console.log(`[probe] path: return path ${PATH_TARGET}`);
    $done({ path: PATH_TARGET });
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
    $done({});
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
    case 'echo':
        if (isResponsePhase) handleEchoResponse();
        else handleEchoRequest();
        break;
    default:
        console.log(`[probe] unknown probe path: ${$request?.url ?? ''}`);
        $done({});
}
