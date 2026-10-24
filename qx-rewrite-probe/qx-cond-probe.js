// QX 条件式 body 改写探测
// 目标：验证 script-request-body 在「不返回 body 字段」时，QX 是否会保持原始 body 不变。
// - 有 body：改写 body + headers + path
// - 空 body：只给 headers + path，绝不注入 body
const original = String($request.body ?? '');
const payload = {
    headers: { ...($request.headers ?? {}), 'X-Probe-Conditional': 'yes' },
    path: '/anything/conditional?probe=conditional-applied',
};
if (original) {
    payload.body = JSON.stringify({ probe: 'body-rewritten', originalBody: original });
}
console.log(`[cond] method=${$request.method} bodyLen=${original.length} includeBody=${Object.prototype.hasOwnProperty.call(payload, 'body')}`);
$done(payload);
