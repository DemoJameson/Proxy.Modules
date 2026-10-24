/**
 * QX 重写能力探测脚本
 *
 * 通过 $argument.mode 指定当前实例执行的探测项：
 * - status:        响应体重写为 JSON result=ok（验证 script-response-body）
 * - url:           script-request-header 返回 { url }（验证跨域 url 是否被支持/半套用）
 * - path:          script-request-header 返回 { path }（验证 path 是否生效）
 * - url-echo:      请求阶段把本次脚本看到的 $request 全量写进持久化（配合 sync 回读）
 * - sync:          响应阶段（script-response-body）合并请求阶段记录与服务器回显，输出 JSON
 *
 * $argument 里 mode 之外的字段全部透传给 $done 结果，便于逐项开关组合。
 */

const MODES = ['status', 'url', 'path', 'url-echo', 'sync'];

function getMode() {
    const mode = String($argument?.mode ?? '').trim();
    return MODES.includes(mode) ? mode : '';
}

function probeHeaders(extra = {}) {
    return {
        ...extra,
        'x-probe-mode': String($argument?.mode ?? ''),
        'x-probe-timestamp': String(Date.now()),
    };
}

// script-response-body：把服务器 404 JSON 改写成 result=ok 的 JSON
function handleStatus() {
    console.log('[probe] status: rewrite response body to JSON');
    const body = JSON.stringify({ result: 'ok', probe: 'response-body', mode: 'status', timestamp: Date.now() });
    $done({ body });
}

// script-request-header：返回完整跨域 url（观察 QX 是否应用 / 半套用）
function handleUrlRewrite() {
    const target = String($argument?.target ?? 'https://httpbin.org/get?probe=url');
    console.log(`[probe] url: return full url ${target}`);
    $done({ url: target });
}

// script-request-header：返回 path（路径+query，官方支持的形态）
function handlePathRewrite() {
    const target = String($argument?.target ?? '/echo?probe=path-applied');
    console.log(`[probe] path: return path ${target}`);
    $done({ path: target });
}

// 请求阶段：把 QX 真实交给脚本的内容记录下来
function handleUrlEcho() {
    const record = {
        mode: 'url-echo',
        url: $request.url ?? '',
        path: $request.path ?? '',
        headers: $request.headers ?? {},
    };
    console.log(`[probe] url-echo: ${JSON.stringify(record)}`);
    $prefs.setValueForKey(JSON.stringify(record), 'qx_probe_url_echo');
    $done({});
}

// 响应阶段：把请求阶段记录的内容与服务器回显合并成 JSON，页面直接可见
function handleSync() {
    const raw = $prefs.valueForKey('qx_probe_url_echo') ?? '';
    console.log(`[probe] sync: ${raw || '(empty)'}`);
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

switch (getMode()) {
    case 'status':
        handleStatus();
        break;
    case 'url':
        handleUrlRewrite();
        break;
    case 'path':
        handlePathRewrite();
        break;
    case 'url-echo':
        handleUrlEcho();
        break;
    case 'sync':
        handleSync();
        break;
    default:
        console.log(`[probe] unknown or missing mode: ${$argument?.mode}`);
        $done({});
}
