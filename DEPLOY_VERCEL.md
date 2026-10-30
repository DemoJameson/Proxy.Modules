# Trakt Translation Backend

仓库里已经包含一个可直接部署到 Vercel 的后端接口：

- 路径：`/api/trakt/translations`
- 方法：
  - `GET`：读取翻译
    - `POST`：写入翻译
- 实现文件：`/api/trakt/translations.js`

## 中文地区与存储结构

- 脚本参数 `chineseLocale`：`cn` 简体（默认）、`tw` 台湾繁体、`hk` 香港繁体；接口用 `locale` 参数传递。
- 每个地区使用独立 String key，不再把一个 ID 的 cn/tw/hk 放在同一个 RedisJSON 文档里：

```text
translation:movies:123:cn
translation:movies:123:tw
translation:movies:123:hk
```

- 读取使用一次 `MGET`；写入使用一次 `MSET`。同一 locale 内允许 last-write-wins，不同 locale 不会互相覆盖。
- 所有 key 去掉 `trakt:` 前缀，连字符改为冒号。
- CDN 响应缓存：全部请求条目命中且状态均为 `FOUND` 时使用 `FOUND`，缓存 7 天；全部条目命中但含 `PARTIAL_FOUND` 时使用 `PARTIAL_FOUND`，缓存时长与 `NOT_FOUND` 相同；任意条目缺失或为 `NOT_FOUND` 时使用 `NOT_FOUND`。浏览器缓存分别为 300/120 秒，CDN 同时带 `stale-while-revalidate`。
- `translation-overrides` 的 CDN 基础缓存为 5 分钟，并允许 5 分钟 `stale-while-revalidate`；脚本端按 **24 小时**节流刷新（`TRANSLATION_OVERRIDES_REFRESH_INTERVAL_MS`），因此管理端修改在单个客户端上最坏约 24 小时生效；浏览器/CDN 那 10 分钟只决定客户端到点后拿到的是哪一版快照，不是生效上限。
- 所有面向脚本的接口（`translations`、`images`、`credits`、`people-names`、`comment-translations`、`list-translations`、`translation-overrides`、`apikeys`）都由根目录 `middleware.js` 在 CDN 缓存前校验 `User-Agent` 需含 `TraktSimplifiedChinese/<数字版本>`，否则直接返回带 `Cache-Control: no-store` 的 `403`。合法请求不按 UA 分区，继续共享 CDN 缓存，避免每次构建版本更新产生新的缓存变体；接口函数内保留同规则作为兜底。管理后台仍只使用 `ADMIN_TOKEN` Bearer 鉴权，`/api/redirect` 保持公开。
- 所有缓存响应条目都会返回 `expiresAt`（毫秒时间戳）：翻译和图片 `FOUND` 365 天、翻译 `PARTIAL_FOUND` 30 天、`NOT_FOUND` 1 天；图片 partial 30 天、not found 3 天；评论/片单 90 天；credits 30 天；人名按来源 90/30 天、TMDB 未命中 7 天。后端**不再发送 `EXPIRE`/`PTTL`**，读取时过滤已过期条目，脚本使用同一个 `expiresAt` 设置本地缓存有效期。

### V2 缓存结构迁移

V2 迁移使用 RDB，不在生产库上逐 key 执行 RENAME/SCAN：

```bash
# 1) 导出 Upstash RDB，并在本地 Redis 8 + RedisJSON 加载
# 2) dry-run：只读取并统计，不写入
npm run migrate:cache:v2

# 3) 确认统计后执行：写入新 String/Hash key，并删除旧 key
npm run migrate:cache:v2 -- --execute --max-output-bytes 175000000

# 4) 本地 SAVE 新 RDB，导入 Upstash 新库或维护窗口中的原库
```

- 默认使用 `redis://127.0.0.1:6379`；可用 `--redis-url` 指定本地 Redis。
- 默认最多生成 2,000,000 个新 key；`--max-output-bytes` 是 `--execute` 的必填项，建议设为当前套餐上限的 70%。
- 迁移前必须备份旧 RDB；Upstash RDB 导入会清空目标库。
- 迁移脚本会把旧 RedisJSON 文档和旧 String JSON 缓存展开为 V2 String key，把 `trakt:translation:overrides` 展开为 `translation:overrides` Hash field；非 JSON String 会跳过并保留原 key，同时兼容 `original:{group}:*` 和 `trakt:image:{group}:*` 两代旧图片 key。
- 迁移会读取旧 key 的 `PTTL`；旧数据没有 `expiresAt` 时，将剩余 TTL 写入新条目的 `expiresAt`，不会把有限缓存变成永久缓存。
- 旧数据中的永久缓存（`expiresAt: null` 或缺失）统一改为 365 天；如果旧 key 还有有限 `PTTL`，优先使用剩余 TTL。
- 旧人物名的 `name`/`notFound` 值会转换为数字 `status`、扁平 `name`、`sourceTextHash`、`source`、顶层 `expiresAt`，TMDB 无中文名时增加 `tmdbMissing: true`。
- 迁移后 key 数量约为 locale 数量的倍数；导入前必须检查数据库大小和 key 数量安全门禁。

## 接口说明

### GET `/api/trakt/translations`

查询参数支持：

- `shows=1,2,3`
- `movies=11,12,13`
- `episodes=198225:1:1,198225:1:2,198225:1:3`
- `locale=cn|tw|hk`（缺省 `cn`）：返回该地区的条目投影；`tw`/`hk` 未命中时会回带 `cn` 提示数据，供客户端写回时使用

至少需要提供一类参数，否则会返回 `400`。

如果服务端未配置 KV，接口会返回 `500`：

```json
{
    "error": "KV is not configured. Set KV_REST_API_URL and KV_REST_API_TOKEN, or UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN."
}
```

返回示例：

```json
{
    "shows": {
        "1": {
            "status": 1,
            "translation": {
                "title": "标题",
                "overview": "简介",
                "tagline": "标语"
            }
        }
    },
    "movies": {},
    "episodes": {
        "198225:1:1": {
            "status": 2,
            "translation": {
                "title": "示例标题",
                "overview": null,
                "tagline": null
            }
        }
    }
}
```

说明：

- `status = 1` 表示 `FOUND`
- `status = 2` 表示 `PARTIAL_FOUND`，内容仍会原样返回
- `status = 3` 表示 `NOT_FOUND`
- 全部条目为 `FOUND` 时使用 `FOUND`；全部条目命中但含 `PARTIAL_FOUND` 时使用 `PARTIAL_FOUND`；任意条目缺失或为 `NOT_FOUND` 时使用 `NOT_FOUND`。`PARTIAL_FOUND` 与 `NOT_FOUND` 使用同一组缓存头
- 后端只返回已存储的翻译内容，不会主动请求 Trakt

### POST `/api/trakt/translations`

如果服务端未配置 KV，接口同样会返回 `500` 和上面的错误信息。

请求体支持：

```json
{
    "shows": {
        "1": {
            "status": 1,
            "translation": {
                "title": "标题",
                "overview": "简介",
                "tagline": "标语"
            }
        }
    },
    "movies": {},
    "episodes": {
        "198225:1:1": {
            "status": 2,
            "translation": {
                "title": "示例标题",
                "overview": null,
                "tagline": null
            }
        }
    }
}
```

返回示例：

```json
{
    "counts": {
        "shows": 1,
        "movies": 0,
        "episodes": 1
    }
}
```

### 评论翻译缓存 `/api/trakt/comment-translations`

- 路径：`/api/trakt/comment-translations`
- 方法：
  - `GET`：读取评论翻译，查询参数 `comments=9001,9002`（数字评论 ID，去重）
    - `POST`：写入评论翻译
- 实现文件：`/api/trakt/comment-translations.js`
- KV key：`comment:translation:{commentId}:{locale}`，数据内 TTL 90 天；评论正文变更由 `sourceTextHash` 兜底失效

GET 返回示例：

```json
{
    "comments": {
        "9001": {
            "comment": {
                "sourceTextHash": "源文本哈希",
                "translatedText": "很棒的电影"
            }
        }
    }
}
```

POST 请求体为 `{ "comments": { "9001": { "comment": { "sourceTextHash": "...", "translatedText": "..." } } } }`，返回 `{ "counts": { "comments": 1 } }`。

## 部署到 Vercel

1. 将当前仓库推送到 GitHub。
2. 在 Vercel 中导入这个仓库。
3. 关闭 `Project Settings -> Deployment Protection -> Vercel Authentication`。
4. 给项目关联一个 Redis / KV 存储。
5. 确认 Redis / KV 环境变量至少配置以下任意一组：
   - `KV_REST_API_URL` 和 `KV_REST_API_TOKEN`
     - `UPSTASH_REDIS_REST_URL` 和 `UPSTASH_REDIS_REST_TOKEN`
6. 如需使用管理页面，继续配置 `ADMIN_TOKEN`；如需标题搜索，继续配置 `TRAKT_API_KEY`；如需中文海报等 TMDb 能力，继续配置 `TMDB_API_KEY`。
7. 部署完成后，记录你的域名，例如 `https://your-project.vercel.app`。

仓库的 `vercel.json` 只允许 `main` 分支触发自动部署；PR 和其它分支不会自动创建 Vercel 预览部署。如需临时预览，可在本地执行 `vercel deploy` 手动部署。

常用环境变量：

| 变量                                                  |         必需 | 说明                                                                            |
| ----------------------------------------------------- | -----------: | ------------------------------------------------------------------------------- |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN`               |       二选一 | Vercel KV / Upstash Redis REST 地址与 Token。                                   |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` |       二选一 | Upstash Redis REST 地址与 Token。                                               |
| `ADMIN_TOKEN`                                         |   管理页必需 | 访问翻译管理后台时输入的管理员令牌。                                            |
| `TRAKT_API_KEY`                                       | 标题搜索必需 | Trakt app 的 client id，用于通过 Trakt API 搜索标题并解析 Trakt ID。            |
| `TMDB_API_KEY`                                        |    TMDb 必需 | TMDb v3 API key，由 `/api/trakt/apikeys` 下发给脚本，用于中文海报与演职员翻译。 |

### 脚本 API key 下发 `/api/trakt/apikeys`

- 路径：`/api/trakt/apikeys`，方法 `GET`，实现文件 `/api/trakt/apikeys.js`
- 作用：把脚本需要的第三方 API key（当前只有 TMDb）收敛到部署环境变量，避免硬编码进公开的脚本产物
- 响应：`{ "keys": { "tmdb": "<TMDb v3 key>" } }`（`keys` 下按服务名平铺，未配置的服务不出现）；未配置 `TMDB_API_KEY` 时返回 `500`
- 缓存：响应头 `Cache-Control: no-store`，由脚本侧自行做 24 小时本地缓存
- 门槛：请求需携带脚本 UA（`TraktSimplifiedChinese/<数字版本>`），否则由 `middleware.js` 在 CDN 缓存前返回带 `Cache-Control: no-store` 的 `403`
  - 与其他脚本接口共用 `lib/trakt-cache/script-auth.js`。这不是安全边界——脚本本身公开，任何人都能拼出这个 URL 并伪造 UA，它只用于拦掉浏览器、curl 和扫描器的顺手采集。
    它的价值在于轮换 key 不必等用户重新拉取脚本，而不在于阻止恶意获取。
- 脚本取值顺序：本次运行内单例 → 本地持久化缓存（24 小时 TTL）→ 本接口
  - key 被判失效（TMDb `401`/`403`）时会**立刻拉黑**该 key 并向后端要新 key，不必等 TTL 过期：
    - 后端已换出新 key → 本次请求直接用它重试成功
    - 后端还没换 → 本次降级，且**下一个请求**会直接问后端（不会再用已知失效的 key 去撞 TMDb），后端一换 key 即恢复
    - 拉黑状态落在持久化缓存，因此跨请求生效；后端下发的 key 若仍在黑名单里也不会被拿去请求 TMDb
    - 拉黑有 10 分钟有效期：窗口内不拿它撞 TMDb，窗口过后允许同一把 key 再试一次，避免把瞬时 `401` 误判成 key 失效后永久判死
    - 只有同一次运行内会做 60 秒抑制，避免一次页面请求里反复查询后端；跨请求始终以"尽快拿到新 key"为准
    - 拿不到 key 时跳过 TMDb 相关能力，**不会**写入图片 `NOT_FOUND` 负缓存
    - 本接口是**配置下发而非缓存**，因此不受 `debugMode` 影响：选「禁用远端缓存」或「禁用所有缓存」时仍会请求它，只是不再读写远端缓存接口

## 管理页面

部署后可访问：

```text
https://your-project.vercel.app/admin
```

也兼容直接访问 `https://your-project.vercel.app/admin.html`。

页面标题为 `Trakt 翻译管理后台`。进入页面时需要输入 `ADMIN_TOKEN`；如果未配置或输入错误，管理接口会拒绝访问。

管理页面支持：

| 功能       | 说明                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 按 ID 搜索 | 搜索框输入纯数字时，直接读取对应 ID 的电影 / 剧集翻译记录；单集可输入 `showId:season:episode`。                                      |
| 按标题搜索 | 搜索框输入标题时，通过 Trakt API 最多取 3 个候选 Trakt ID，再从 Redis 读取已有翻译；选择全部时一次搜索电影和电视剧，不需要搜索索引。 |
| 列表浏览   | 搜索框留空时，可按媒体类型、中文地区和锁定状态浏览已有缓存记录。                                                                     |
| 中文地区   | 顶部筛选可选择简体 / 繁体（台湾）/ 繁体（香港）；列表、详情、保存与删除都只作用于所选地区。                                          |
| 编辑翻译   | 可修改标题、简介、标语，并按字段固定。保存后写入修订翻译。                                                                           |
| 当前翻译   | 页面只展示合并后的当前翻译，不区分原翻译和修订翻译。                                                                                 |
| 恢复原翻译 | 删除修订翻译，让条目恢复为原翻译结果。                                                                                               |
| 删除翻译   | 删除该条目的原翻译和修订翻译。                                                                                                       |

## 在 Loon 中使用

将插件参数里的后端地址填写为你的 Vercel 域名，例如：

```text
https://your-project.vercel.app
```

脚本会调用：

```text
GET  https://your-project.vercel.app/api/trakt/translations
POST https://your-project.vercel.app/api/trakt/translations
```

如果后端不可用，脚本会继续使用本地翻译存储，并在需要时直接请求 Trakt。

## 翻译存储设计

- 后端只负责翻译存储，不主动拉取 Trakt 翻译
- 插件流程：
  1. 先向后端批量读取翻译记录 2. 对未命中的条目，由插件直接请求 Trakt `translations/zh` 3. 再将结果批量写回后端
- 后端按单条记录写入 KV，locale 使用独立 String key：
  - `translation:shows:{id}:{locale}`
    - `translation:movies:{id}:{locale}`
    - `translation:episodes:{showId}:{seasonNumber}:{episodeNumber}:{locale}`
- 读取使用一次 `MGET`，写入使用一次 `MSET`；同一 locale 内允许 last-write-wins，不同 locale 不会互相覆盖。
- 管理页修订翻译存在 `translation:overrides` Hash 内，field 为 `{mediaType}:{id}:{locale}`，value 为 `{translation, updatedAt}`；读取使用 `HGETALL`/`HMGET`，写入使用 `HSET`，删除使用 `HDEL`。
- 过期时间写在数据字段 `expiresAt`：`FOUND` 365 天，`PARTIAL_FOUND` 30 天，`NOT_FOUND` 1 天
- 后端不再发送 `EXPIRE`/`PTTL`；读取时过滤已过期条目（图片按字段过滤）
- `PARTIAL_FOUND` 不会被归一为 `NOT_FOUND`，也不会丢失翻译或图片 URL；它与 `NOT_FOUND` 使用相同的缓存时长
- 人物名使用单个 `person:name:{traktId}:{locale}` String key，value 为 `{status, name, sourceTextHash, source, expiresAt, tmdbMissing?}`；`status` 复用 `1/3`，`name` 为最终字符串，不再返回 `providers`。运行时硬切该结构，不再接受旧 `notFound`、`providers` 或 name-only 条目

## 说明

- 现在后端同时支持 `show`、`movie` 和 `episode`
- `episode` 翻译按 `showId:seasonNumber:episodeNumber` 存储
- 详情页和列表页可以复用同一套后端翻译
