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
6. 如需使用管理页面，继续配置 `ADMIN_TOKEN`；如需标题搜索，继续配置 `TRAKT_API_KEY`。
7. 部署完成后，记录你的域名，例如 `https://your-project.vercel.app`。

常用环境变量：

| 变量                                                  |         必需 | 说明                                                                 |
| ----------------------------------------------------- | -----------: | -------------------------------------------------------------------- |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN`               |       二选一 | Vercel KV / Upstash Redis REST 地址与 Token。                        |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` |       二选一 | Upstash Redis REST 地址与 Token。                                    |
| `ADMIN_TOKEN`                                         |   管理页必需 | 访问翻译管理后台时输入的管理员令牌。                                 |
| `TRAKT_API_KEY`                                       | 标题搜索必需 | Trakt app 的 client id，用于通过 Trakt API 搜索标题并解析 Trakt ID。 |

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
