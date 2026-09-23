## 项目结构与模块组织

本仓库是个人代理模块与 Trakt 翻译后端的组合项目，主要面向 Loon、Surge、Quantumult X 和 Vercel。

- `trakt_simplified_chinese/` 是核心模块目录，包含 Trakt 简体中文增强脚本、模块配置、图片资源和构建后的发布产物。
- `trakt_simplified_chinese/src/` 是 Trakt 脚本源码，入口为 `main.mjs`，请求/响应分派位于 `request.mjs`、`response.mjs`。
- `trakt_simplified_chinese/src/features/` 放具体行为，如翻译、人物信息、评论、播放源注入；`outbound/` 放外部服务客户端；`shared/` 放跨入口复用逻辑；`utils/` 放通用工具。
- `api/` 是 Vercel Serverless Functions 后端，`api/trakt/translations.js`、`api/trakt/translations/admin.js` 等负责翻译缓存、修订和管理接口，`api/redirect.js` 负责跳转接口。
- `public/` 放 Vercel 静态页面与素材，例如 `admin.html`、`index.html`、`trakt.webp`。
- `scripts/` 放构建与测试驱动脚本，`scripts/vendor/Env.js` 和 `Env.module.mjs` 是代理运行时适配代码。
- `tests/` 放 Node 内置测试、fixture 和 helper；`tests/README.md` 维护测试归属和 live 测试说明。
- `fix_infuse_image_language/` 和 `github_redirect_to_local/` 是独立代理模块目录，包含各自的 `.js`、`.plugin`、`.sgmodule`、`.snippet`。

## 构建、测试与开发命令

在仓库根目录执行：

- `npm run format`：格式化整个仓库。
- `npm run format:check`：检查格式，不写入文件。
- `npm run build:trakt`：从 `trakt_simplified_chinese/src/` 构建 Trakt 发布产物和相关模块配置。
- `npm run sync:env.js`：同步代理运行时 Env 适配文件。
- `npm run check:trakt`：格式检查、构建 Trakt 产物，并对源码、vendor 和构建后的脚本做 `node --check`。
- `npm test`：构建 Trakt 后运行默认离线测试，不依赖真实凭据或外部服务。
- `npm run test:trakt:live`：运行真实 Trakt/Vercel 后端联调，可能需要 `TRAKT_API_KEY`、`TRAKT_CLIENT_SECRET`、`TRAKT_OAUTH_TOKEN`、`TRAKT_BACKEND_BASE_URL` 等本地配置。
- `npm run test:trakt:all`：串行运行完整 Trakt 测试集合。
- `node --test tests/xxx.test.mjs`：定向跑单个测试文件；必须前先执行 `npm run format` 和 `npm run build:trakt` 等待编译完成，确保脚本产物是最新的，之后才运行测试。

## 编码风格与命名约定

项目使用 ESM，源码以 `.mjs` 为主，Vercel 函数以 `.js` 为主。格式化交给 Prettier，缩进保持 4 空格。文件名以 kebab-case 为主，如 `google-translate-client.mjs`、`translation-cache.js`；测试文件统一使用 `*.test.mjs`。

新增 Trakt 脚本行为时，优先放入 `trakt_simplified_chinese/src/features/`；外部 API 调用放入 `outbound/`；媒体类型、路由、缓存、简繁转换、翻译流水线等跨功能逻辑放入 `shared/`；纯工具逻辑放入 `utils/`。修改脚本源码后通常需要同步更新构建产物，运行 `npm run build:trakt`。

后端接口改动集中在 `api/trakt/`，管理页相关静态资源集中在 `public/admin.html`。不要引入 Next.js、Hono 或额外服务框架，除非任务明确要求迁移架构。

## 生成产物与配置

`trakt_simplified_chinese/*.js`、`*.plugin`、`*.sgmodule`、`*.snippet` 以及根目录 `boxjs.json` 是发布/订阅相关产物或配置。修改 Trakt 源码、模块参数、资源链接或 Env 适配时，运行 `npm run build:trakt` 并检查这些文件是否随之变化。

`trakt_simplified_chinese/trakt_simplified_chinese.js` 开头带 5 行中文元信息（名称/描述/主页/作者/生成时间，固定按 +08:00 精确到分钟），因此每次构建都会改动该产物的头部，属于预期行为；`.plugin`、`.sgmodule`、`.snippet` 与 `boxjs.json` 不含时间戳，保持逐字节可比对。同一次构建时间还会作为脚本版本号（`YYMMDDHHmm`）注入产物，用于自建后端请求的 UA 标识（`TraktSimplifiedChinese/<版本号>`）。

发布链接在 `README.md` 中指向 GitHub raw 的 `main` 分支；调整目录名、产物名或新增模块时，同步更新 README 链接和对应平台配置。

## 测试规范

默认测试框架为 Node 内置 `node:test`。参数解析、开关项、请求 phase 配置优先写入 `tests/trakt_argument.test.mjs`；模块清单写入 `tests/trakt_module_manifest.test.mjs`；缓存工具写入 `tests/trakt_cache_utils.test.mjs`；管理后端缓存写入 `tests/trakt_backend_admin_cache.test.mjs`。

脚本级行为按主题归类：

- `tests/trakt_script_watchnow.test.mjs`：watchnow、用户设置、season request state、redirect/logo rewrite。
- `tests/trakt_script_translations.test.mjs`：translations、媒体详情、history、comments、list descriptions、sentiments。
- `tests/trakt_script_people.test.mjs`：people detail、media people list、person credits。
- `tests/trakt_script_routes.test.mjs`：Sofa Time、TMDb provider、request/response route matrix 和其他 route smoke tests。
- `tests/trakt_script_user_agent.test.mjs`：脚本出站请求的 UA 标识（仅自建后端追加 `TraktSimplifiedChinese/<版本号>`）。

fixture 放在 `tests/fixtures/trakt/`，只保留断言真正依赖的字段。通用运行时模拟和 fixture helper 放在 `tests/helpers/`；至少两个测试复用的构造逻辑再抽 helper。新增 request phase 用例时，显式覆盖 `hasResponse: false`；涉及缓存未命中的正向链路，除了断言响应内容，也要断言缓存写回。

live 测试放在 `tests/trakt_live_backend.test.mjs` 和 `tests/trakt_live_script.test.mjs`，不进入默认 `npm test`。本地凭据保存到被忽略的 `.trakt-live-test.local.json`，不要提交真实 token、client secret 或后端密钥。

## 提交与 Pull Request 规范

提交历史采用 Conventional Commits，常见形式如 `feat(trakt): ...`、`fix(trakt): ...`、`refactor(trakt): ...`、`docs: ...`。建议按单一主题提交，标题直接说明影响范围。

PR 或交付说明应包含：变更目的、影响的代理模块或 Vercel 接口、是否更新生成产物、执行过的测试命令。若改动 live 测试、Vercel KV/Redis、Trakt OAuth 或管理后台鉴权，说明新增或变更的环境变量与凭据要求。
