// QX conditional body rewrite probe (ES5-safe, no ?? or ?. operators)
var original = String(($request && $request.body) || '');
var headers = {};
var key;
for (key in ($request && $request.headers) || {}) {
    headers[key] = $request.headers[key];
}
headers['X-Probe-Conditional'] = 'yes';
var payload = {
    headers: headers,
    path: '/anything/conditional?probe=conditional-applied'
};
if (original) {
    payload.body = JSON.stringify({ probe: 'body-rewritten', originalBody: original });
}
console.log('[cond] method=' + $request.method + ' bodyLen=' + original.length + ' includeBody=' + (original ? 'true' : 'false'));
$done(payload);
