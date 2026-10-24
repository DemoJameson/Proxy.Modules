#!/usr/bin/env node
/**
 * QX Rewrite Probe 本地探测服务器
 *
 * 用法：node qx-rewrite-probe-server.mjs  （监听 127.0.0.1:18765）
 *
 * 路由：
 *   /status  返回 404（供 P1 验证 response-header 改状态码，成功时 QX 会改成 233）
 *   /url     返回 200 + JSON（供 P2 验证 script-request-header 的 url 改写，成功时这条响应根本到不了这里）
 *   /path    返回 200 + JSON（供 P3 验证 path 改写，成功时请求会变成 /echo?probe=path）
 *   /echo    返回 200 + 请求明细 JSON（P3/P4 的落点：能直接看到 QX 实际发出的路径与头）
 *   其他     返回 200 + 请求明细 JSON
 *
 * 响应都带 access-control-allow-origin: *，方便 Safari 直接打开看 JSON。
 */
import http from "node:http";

const PORT = 18765;

function send(res, status, payload) {
    const body = JSON.stringify(payload, null, 2);
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
    });
    res.end(body);
}

const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
        const detail = {
            path: req.url,
            method: req.method,
            httpVersion: req.httpVersion,
            headers: req.headers,
            body: Buffer.concat(chunks).toString("utf8"),
        };
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
        console.log(JSON.stringify(detail.headers, null, 2));

        if (req.url.startsWith("/status")) {
            send(res, 404, { probe: "status", hint: "QX rewrite should change this to 233", ...detail });
            return;
        }
        if (req.url.startsWith("/url")) {
            send(res, 200, { probe: "url", hint: "if you can see this, {url} rewrite did NOT take effect", ...detail });
            return;
        }
        if (req.url.startsWith("/path")) {
            send(res, 200, { probe: "path", hint: "if you can see this, {path} rewrite did NOT take effect", ...detail });
            return;
        }
        send(res, 200, { probe: "echo", ...detail });
    });
});

server.listen(PORT, "127.0.0.1", () => {
    console.log(`probe server listening on http://127.0.0.1:${PORT}`);
    console.log("P1 GET /status   -> expect 233 (rewritten by script-response-header)");
    console.log("P2 GET /url      -> expect redirect to httpbin (if {url} is supported)");
    console.log("P3 GET /path     -> expect /echo?probe=path (if {path} is supported)");
    console.log("P4 GET /echo     -> check x-probe-echo-url response header");
});
