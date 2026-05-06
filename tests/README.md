# Trakt Tests

`tests/` 里的 Trakt 自动化目前分成两层：

- `trakt_argument.test.mjs`
  覆盖参数解析、开关项、请求 phase 改写与配置注入相关行为。
- `trakt_script_*.test.mjs`
  覆盖构建后的单文件脚本在 Loon 运行时的 request/response 行为。

## Test File Ownership

- `trakt_script_watchnow.test.mjs`
  放 `watchnow`、`users/settings`、season request state、redirect/logo rewrite 相关测试。
- `trakt_script_translations.test.mjs`
  放 translations、media detail、history、comments、list descriptions、sentiments 相关测试。
- `trakt_script_people.test.mjs`
  放 people detail、media people list、person credits 相关测试。
- `trakt_script_routes.test.mjs`
  放 Sofa Time、TMDb provider、request/response route matrix、以及不适合归到其他主题的 route smoke tests。

新增脚本级测试时，优先按“行为域”归类，不按 URL 数量平均拆分。

## Fixtures

- Trakt 相关 fixture 放在 `fixtures/trakt/`。
- fixture 尽量只保留测试真正依赖的字段，减少无关噪音。
- 如果多个测试只差少量字段，优先复用 helper 生成，避免复制接近相同的 JSON。

## Helpers

- `helpers/run-script.mjs`
  负责在 Node 里模拟 Loon 运行时，包括 `$request`、`$response`、`$persistentStore`、`$httpClient`、`$done`。
  默认会静默脚本里的 `console` 输出；排查单个 case 时可传 `verboseLogs: true` 打开日志。
- `helpers/trakt-test-helpers.mjs`
  放 fixture 读取、hash 计算、常用 body/cache 构造器。

新的通用测试构造逻辑先放 helper；只有在至少两个测试会复用时再抽。

## Adding Tests

1. 如果测参数解析、功能开关或 request phase 配置行为，优先加到 `trakt_argument.test.mjs`。
2. 如果测脚本路由、缓存、网络编排或 `$done` 输出，加到对应的 `trakt_script_*.test.mjs`。
3. 如果是新的 route dispatch smoke test，默认放 `trakt_script_routes.test.mjs`。
4. 如果是缓存未命中后的正向链路，除了断言响应内容，还要断言缓存写回。
5. 如果是 request phase 行为，使用 `hasResponse: false` 明确覆盖无 `$response` 分支。

## Running

在仓库根目录运行：

```powershell
npm test
```

定向运行单个或少量测试前，先格式化并构建：

```powershell
npm run format
npm run build:trakt
node --test tests/xxx.test.mjs
```

真实请求联调单独运行：

```powershell
npm run test:trakt:live
```

首次运行如果缺少 `TRAKT_API_KEY` 或 `TRAKT_BACKEND_BASE_URL`，脚本会提示输入并保存到仓库根目录的 `.trakt-live-test.local.json`，下次自动复用。

如果缺少 `TRAKT_OAUTH_TOKEN`，脚本会优先引导你走 Trakt Device Flow 登录：

- 先要求填写 `TRAKT_API_KEY`（也就是 Trakt app 的 `client_id`）
- 一开始同时要求填写 `TRAKT_CLIENT_SECRET`
- 打印 Trakt 官方登录链接和用户码
- 你在浏览器完成授权后，回到终端按回车
- 脚本再开始轮询获取 access token
- 成功后自动保存到 `.trakt-live-test.local.json`

如果不提供 `TRAKT_CLIENT_SECRET`，则只跑非登录态接口，登录态用例自动跳过。

`TRAKT_BACKEND_BASE_URL` 输入留空时会使用 `trakt_simplified_chinese/src/module-manifest.mjs` 中的 `DEFAULT_BACKEND_BASE_URL`。

可选环境变量：

- `TRAKT_API_VERSION`
  默认 `2`
- `TRAKT_OAUTH_TOKEN`
  用于 `/users/me/...`、`/users/settings`、真实 `watchnow` 等登录态接口；留空时相关 live case 会自动跳过
- `LIVE_TEST_ALLOW_GOOGLE_TRANSLATE`
  设为 `true` 时，live harness 才允许脚本真实访问 Google 翻译接口

## 登录态测试

如果要测试已登录接口，推荐直接使用启动脚本内置的 Device Flow。

最小流程：

1. 在 Trakt 开发者后台创建一个 app，拿到 `client_id` 和 `client_secret`
2. 运行 `npm run test:trakt:live`
3. 启动脚本提示输入 `TRAKT_API_KEY` 和 `TRAKT_CLIENT_SECRET`
4. 脚本会打印 Trakt 登录链接和用户码
5. 在浏览器完成授权
6. 回到终端按回车
7. 脚本自动拿到 `TRAKT_OAUTH_TOKEN` 并保存到本地配置

如果暂时不想启用登录态测试，`TRAKT_CLIENT_SECRET` 直接回车即可，只会跳过登录态相关 live case。

只做语法和构建检查：

```powershell
npm run check:trakt
```

## Live Tests

- `trakt_live_backend.test.js`
  直接向真实 `backendBaseUrl` 发送 GET/POST，请求真实 KV 缓存链路。
- `trakt_live_script.test.js`
  先请求真实 Trakt 数据，再用生产产物脚本在 Node 里处理真实响应，验证脚本联调结果。

live tests 不进入默认 `npm test`，避免：

- 污染离线测试的稳定性
- 依赖真实密钥和外网
- 意外触发第三方限流
