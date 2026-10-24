# QX 重写能力实机探测套件

验证目标：QX `script-request-header` 是否支持 `{url}`（以及是否半套用）、`{path}` 是否生效、`script-response-header` 能否改状态码、请求/响应脚本能否通过 `$prefs` 共享数据。所有探测默认只打局域网 `192.168.50.3:18765`。

## 文件

- `qx-rewrite-probe.js`：探测脚本，按 URL 参数 `mode` 分流。
- `qx-rewrite-probe.snippet`：QX 可导入的远程片段（脚本走 `codex/qx-rewrite-probe` 分支的 `refs/heads/...` raw 链接）。
- `qx-rewrite-probe.conf`：手动粘贴版（与 snippet 内容一致）。
- `qx-rewrite-probe-server.mjs`：本机探测服务器。

## 步骤

1. 本机启动探测服务器：`node qx-rewrite-probe-server.mjs`
2. 让 iPhone 与 Mac 同网段；Mac 当前局域网 IP 为 `192.168.50.3`。
3. QX 里导入 snippet（或把 conf 内容贴进重写区域）（探测目标是 HTTP，无需 MitM）。
4. Safari 逐条访问下列地址，对照判读：

| 探测 | 访问 | 判读 |
| --- | --- | --- |
| P1 response-body 改写 | `http://<mac-ip>:18765/status` | 显示 `{ "result": "ok" ... }` = 生效；仍是服务器原 JSON = 不生效 |
| P2 request-header 返回 `{url}` | `http://<mac-ip>:18765/url` | 跳到 httpbin = 跨域 url 生效；本机 JSON 但 path 仍是 `/url` = url 被丢弃；QX 日志出现「Host httpbin + path /url」类错配 = 半套用 |
| P3 request-header 返回 `{path}` | `http://<mac-ip>:18765/path` | 本机返回 JSON 且 `path` 字段为 `/echo?probe=path` = path 生效；`path` 仍是 `/path` = path 被丢弃 |
| P4 请求/响应共享数据 | `http://<mac-ip>:18765/echo` | 响应头 `X-Probe-Echo-Url` 有内容 = `$prefs` 跨阶段共享可用 |

5. P2/P3/P4 的服务器控制台会打印 QX 实际发出的请求头（含 `host`），错配行为在这里最直观。
6. QX 日志过滤 `[probe]` 可看脚本自身输出。

## 备注

- 探测脚本与配置托管在 `Proxy.Modules` 的 `codex/qx-rewrite-probe` 分支（未合入 main），snippet 里的 raw 链接指向该分支；raw 链接必须带 `refs/heads/` 前缀；若分支被删，改用 conf 手动粘贴并把脚本存到 QX 本地脚本目录。
- P2 唯一会出网的用例：url 生效时会真的访问 `httpbin.org/get?probe=url`，不想出网可在 conf 里把 target 改成任意你可控的地址。
