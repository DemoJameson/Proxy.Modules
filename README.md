# Proxy.Modules

个人使用的网络工具模块仓库

## 脚本列表

| 脚本                       | 说明                                              | Loon                       | Surge                          | Quantumult X                 |
| -------------------------- | ------------------------------------------------- | -------------------------- | ------------------------------ | ---------------------------- |
| Trakt Simplified Chinese   | 优先补全和显示 Trakt 的简体中文标题、简介等内容，并在影片详情页添加 Forward、Infuse、Rex 跳转按钮 | [`.plugin`][trakt-plugin] | [`.sgmodule`][trakt-sgmodule] | [`.snippet`][trakt-snippet] |
| Fix Infuse Image Language  | 调整 TMDB 图片语言排序，改善 Infuse 图片语言匹配  | [`.plugin`][infuse-plugin] | [`.sgmodule`][infuse-sgmodule] | [`.snippet`][infuse-snippet] |
| IMDB API Redirect to tiffara | 将 imdbapi.dev 及其所有子域名重定向到 tiffara.com | [`.plugin`][imdb-plugin]   | [`.sgmodule`][imdb-sgmodule]   | [`.snippet`][imdb-snippet]   |

[trakt-plugin]: https://raw.githubusercontent.com/DemoJameson/Proxy.Modules/main/trakt_simplified_chinese/trakt_simplified_chinese.plugin
[trakt-sgmodule]: https://raw.githubusercontent.com/DemoJameson/Proxy.Modules/main/trakt_simplified_chinese/trakt_simplified_chinese.sgmodule
[trakt-snippet]: https://raw.githubusercontent.com/DemoJameson/Proxy.Modules/main/trakt_simplified_chinese/trakt_simplified_chinese.snippet
[infuse-plugin]: https://raw.githubusercontent.com/DemoJameson/Proxy.Modules/main/fix_infuse_image_language/fix_infuse_image_language.plugin
[infuse-sgmodule]: https://raw.githubusercontent.com/DemoJameson/Proxy.Modules/main/fix_infuse_image_language/fix_infuse_image_language.sgmodule
[infuse-snippet]: https://raw.githubusercontent.com/DemoJameson/Proxy.Modules/main/fix_infuse_image_language/fix_infuse_image_language.snippet
[imdb-plugin]: https://raw.githubusercontent.com/DemoJameson/Proxy.Modules/main/imdbapi_redirect_to_tiffara/imdbapi_redirect_to_tiffara.plugin
[imdb-sgmodule]: https://raw.githubusercontent.com/DemoJameson/Proxy.Modules/main/imdbapi_redirect_to_tiffara/imdbapi_redirect_to_tiffara.sgmodule
[imdb-snippet]: https://raw.githubusercontent.com/DemoJameson/Proxy.Modules/main/imdbapi_redirect_to_tiffara/imdbapi_redirect_to_tiffara.snippet

## 许可与使用限制

本项目采用 source-available 许可。

该许可证不是 OSI 定义的开源许可证，因为它对特定主体和使用场景作了限制。完整条款以 [`LICENSE`](./LICENSE) 为准。

### 允许

- 非 EplayerX 作者和用户使用、复制、修改和分发本项目。
- 在配置、元数据、源码和生成产物中追加自己的署名或其他贡献者署名，但不得移除或覆盖原作者署名。

### 必须保留

- 所有配置、元数据、源码、生成产物、文档和分发副本中的原作者名 `DemoJameson` 及版权声明。
- 包括但不限于 `.plugin`、`.sgmodule`、`.snippet` 中的 `#!author=` 字段、`boxjs.json` 的 `author` 字段、模块清单中的作者字段，以及生成脚本中的作者元数据。
- 如果配置格式只支持一个作者字段，可以在原作者名后追加其他名字，或另外增加 `contributor` / `originalAuthor` 等字段；不得把 `DemoJameson` 替换掉。

### 禁止

- 移除、隐藏、替换或篡改配置、元数据、源码和生成产物中的原作者名 `DemoJameson` 或版权声明。
- EplayerX 播放器的作者和用户使用、复制、修改和分发本项目。
- 通过再分发、子许可或其他方式规避上述限制。
