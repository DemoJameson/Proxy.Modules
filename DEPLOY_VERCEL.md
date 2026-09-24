# Trakt Translation Backend

仓库里已经包含一个可直接部署到 Vercel 的后端接口：

- 路径：`/api/trakt/translations`
- 方法：
    - `GET`：读取翻译
    - `POST`：写入翻译
- 实现文件：`/api/trakt/translations.js`

## 接口说明

### GET `/api/trakt/translations`

查询参数支持：

- `shows=1,2,3`
- `movies=11,12,13`
- `episodes=198225:1:1,198225:1:2,198225:1:3`

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
- `status = 2` 表示 `PARTIAL_FOUND`
    - 条件是任意中文地区语言的 `title` 字段有值，但未达到完整命中
- `status = 3` 表示 `NOT_FOUND`
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
- KV key：`trakt:comment-translation:{commentId}`，TTL 90 天；评论正文变更由 `sourceTextHash` 兜底失效

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

常用环境变量：

| 变量                                                  |         必需 | 说明                                                                 |
| ----------------------------------------------------- | -----------: | -------------------------------------------------------------------- |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN`               |       二选一 | Vercel KV / Upstash Redis REST 地址与 Token。                        |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` |       二选一 | Upstash Redis REST 地址与 Token。                                    |
| `ADMIN_TOKEN`                                         |   管理页必需 | 访问翻译管理后台时输入的管理员令牌。                                 |
| `TRAKT_API_KEY`                                       | 标题搜索必需 | Trakt app 的 client id，用于通过 Trakt API 搜索标题并解析 Trakt ID。 |
| `TMDB_API_KEY`                                        |   TMDb 必需 | TMDb v3 API key，由 `/api/trakt/apikeys` 下发给脚本，用于中文海报与演职员翻译。 |

### 脚本 API key 下发 `/api/trakt/apikeys`

- 路径：`/api/trakt/apikeys`，方法 `GET`，实现文件 `/api/trakt/apikeys.js`
- 作用：把脚本需要的第三方 API key（当前只有 TMDb）收敛到部署环境变量，避免硬编码进公开的脚本产物
- 响应：`{ "keys": { "tmdb": "<TMDb v3 key>" } }`（`keys` 下按服务名平铺，未配置的服务不出现）；未配置 `TMDB_API_KEY` 时返回 `500`
- 缓存：响应头 `Cache-Control: no-store`，由脚本侧自行做 24 小时本地缓存
- 门槛：请求需携带脚本 UA（`TraktSimplifiedChinese/<版本号>`），否则返回 `403`
    - 注意这不是安全边界——脚本本身公开，任何人都能拼出这个 URL 并伪造 UA。
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
| 列表浏览   | 搜索框留空时，可按媒体类型和锁定状态浏览已有缓存记录。                                                                               |
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
    1. 先向后端批量读取翻译记录
    2. 对未命中的条目，由插件直接请求 Trakt `translations/zh`
    3. 再将结果批量写回后端
- 后端按单条记录写入 KV，key 格式为：
    - `trakt:translation:shows:{id}`
    - `trakt:translation:movies:{id}`
    - `trakt:translation:episodes:{showId}:{seasonNumber}:{episodeNumber}`
- 管理页保存的修订翻译 key 格式为：
    - `trakt:translation:revision:shows:{id}`
    - `trakt:translation:revision:movies:{id}`
    - `trakt:translation:revision:episodes:{showId}:{seasonNumber}:{episodeNumber}`
- `FOUND` 永不过期
- `PARTIAL_FOUND` 保留 30 天
- `NOT_FOUND` 保留 7 天
- 修订翻译不设置过期时间；修订字段优先于原翻译，原翻译缺失时修订翻译可作为回退

## 说明

- 现在后端同时支持 `show`、`movie` 和 `episode`
- `episode` 翻译按 `showId:seasonNumber:episodeNumber` 存储
- 详情页和列表页可以复用同一套后端翻译
