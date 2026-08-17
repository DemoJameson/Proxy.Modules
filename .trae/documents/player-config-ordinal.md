# 播放器注入配置：布尔开关改为排序序号

## Summary

将 Trakt 模块的三个播放器跳转按钮配置从「布尔开关（启用/禁用）」改为「排序序号」：数字代表注入排序位置，`0` 代表不显示。涉及字段重命名、参数解析、6 个注入点统一排序逻辑，以及构建产物与测试同步更新。

## 用户确认的关键决策

1. **注入点范围**：6 个注入点统一按序号排序；但 `0=隐藏` 仅对已读取 config 的 2 个点（`/movies|shows|episodes/:id/watchnow`、SofaTime streaming availability）生效；其余 4 个（`/watchnow/sources`、`/users/settings` favorites、SofaTime country services、TMDB provider catalog）仍总是注入全部 3 个，仅按序号重排顺序。
2. **命名与迁移**：字段重命名为 `eplayerxOrder`/`forwardOrder`/`infuseOrder`，`type` 从 `boolean` 改为 `number`；**不迁移**旧 `*Enabled` 的 BoxJs 值（旧键被忽略，回落到默认值）。
3. **`/watchnow/sources` 顺序统一**：当前 `/watchnow/sources` 默认为反向 `[infuse, forward, eplayerx]`（与其它 5 个注入点的正向 `[eplayerx, forward, infuse]` 不一致）。改为与其它注入点一致——默认序号 `1/2/3` 下统一为正向 `[eplayerx, forward, infuse]`，自定义序号时同样按 `orderedPlayerTypes` 升序统一排序。这是本次变更会带来的**默认顺序行为变更**（仅此一个注入点的默认顺序翻转）。

## 当前状态分析

### 配置定义
- [module-manifest.mjs](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/module-manifest.mjs#L55-L75)：三个字段 `eplayerxEnabled`/`forwardEnabled`/`infuseEnabled`，`type: "boolean"`，默认 `true`。
- 同文件 [L93-L95](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/module-manifest.mjs#L93-L95) 聚合为 `PLAYER_ARGUMENT_KEYS`、`CORE_WITH_PLAYER_ARGUMENT_KEYS`。

### 参数解析
- [argument.mjs](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/argument.mjs#L5-L22)：`PLAYER_BUTTON_ARGUMENT_GROUP_KEYS` 把外键映射到 `PLAYER_TYPE`；`createDefaultPlayerButtonEnabledConfig()` 返回 `{eplayerx:true, forward:true, infuse:true}`；写入 `config.playerButtonEnabled`。
- [L116-L125](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/argument.mjs#L116-L125) `normalizeArgument`：`Object.values(PLAYER_TYPE).filter(s => playerButtonEnabled[s])` 生成 `enabledPlayerTypes`，按 `PLAYER_TYPE` 声明顺序（eplayerx→forward→infuse）。
- [common.mjs](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/utils/common.mjs#L29-L70) `parseBooleanArgument` / `parseArgumentValue`：`parseArgumentValue` 按 `typeof fallbackValue` 派发，boolean→`parseBooleanArgument`，string→`readTextArgument`，**number 无派发分支**（直接 `value ?? fallback`，字符串数字不会被转成数字）。

### 6 个注入点现状
| 注入点 | 文件:行 | 是否读 config | 当前顺序 |
|---|---|---|---|
| `/movies\|shows\|episodes/:id/watchnow` | [player-injection-trakt.mjs:196-218,249-265,343-357](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/features/player-injection-trakt.mjs#L196-L218) | 是 (`enabledPlayerTypes`) | eplayerx→forward→infuse |
| SofaTime streaming availability | [player-injection-sofatime.mjs:214-217,219-233,235-278,372-397](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/features/player-injection-sofatime.mjs#L214-L233) | 是 (`enabledPlayerTypes`) | eplayerx→forward→infuse |
| `/watchnow/sources` | [player-injection-trakt.mjs:111-120,140-174,359-365](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/features/player-injection-trakt.mjs#L111-L120) | 否 | infuse→forward→eplayerx（`reverse()+concat`） |
| `/users/settings` favorites | [player-injection-trakt.mjs:83-102,302-315,367-378](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/features/player-injection-trakt.mjs#L83-L102) | 否 | eplayerx→forward→infuse（`reverse()+unshift` 净效果正向） |
| SofaTime country services | [player-injection-sofatime.mjs:280-299,355-370](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/features/player-injection-sofatime.mjs#L280-L299) | 否 | eplayerx→forward→infuse（`reverse()+unshift` 净效果正向） |
| TMDB provider catalog | [player-injection-sofatime.mjs:28-41,301-322,324-334](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/features/player-injection-sofatime.mjs#L28-L41) | 否 | eplayerx(pid1)→forward(pid2)→infuse(pid3)（`reverse()+unshift` 净效果正向） |

> 注：`reverse().forEach(unshift)` 的净效果是「正向声明顺序」；`reverse().map().concat()` 的净效果是「反向」。因此默认序号 `1/2/3` 统一为正向后，**只有 `/watchnow/sources` 的默认顺序会从反向翻为正向**，其余 5 个注入点默认顺序不变。

### 关键既有问题（必须在本次修复，否则 Loon 下功能失效）
`applyArgumentStringConfig`（[argument.mjs:54-80](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/argument.mjs#L54-L80)）**按位置索引**解析字符串参数（索引对应 `argumentFields` 声明顺序：posterImageMode, history, google, character, eplayerx, forward, infuse, backendBaseUrl, debugEnabled）。

- `ALL_ARGUMENT_KEYS`（[L92](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/module-manifest.mjs#L92)）= `argumentFields.map(f=>f.key)`，与解析顺序对齐。
- `CORE_WITH_PLAYER_ARGUMENT_KEYS`（core 6 + player 3）与解析顺序**不对齐**。SofaTime Streaming Availability 规则（[L184-L193](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/module-manifest.mjs#L184-L193)）当前用它，Loon 字符串形式下 player 值会错位写到 backendBaseUrl/debugEnabled 等槽位（既有 bug，因默认全 `true` 未被察觉）。测试用对象形式传参，未覆盖到此。
- 结论：要让「序号 + 0=隐藏」在 Loon 下对该路由生效，必须把它的 `argumentKeys` 改为 `ALL_ARGUMENT_KEYS`（对齐解析顺序）。

### 构建产物渲染
- [build-trakt.mjs](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/scripts/build-trakt.mjs#L168-L186) `inferPluginArgumentType`/`inferBoxjsSettingType`：boolean→switch/boolean、text→input/text、select→select/select。**未支持 `number` 类型，会抛错**。需新增 number 分支。
- `.plugin`/`.sgmodule`/`boxjs.json` 全部由 `renderGeneratedTargets()` 从 `module-manifest.mjs` 渲染，测试 [trakt_module_manifest.test.mjs](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/tests/trakt_module_manifest.test.mjs#L17-L24) 守护一致性。

## 假设与约定

- **默认值**：`eplayerxOrder=1`、`forwardOrder=2`、`infuseOrder=3`（保留「全部显示、声明顺序」的现有行为）。
- **排序语义**：非 0 序号升序在前；序号相同时按 `PLAYER_TYPE` 声明顺序（依赖 `Array.prototype.sort` 稳定性，ES2019+ 保证）；`0`（含负数与非法值，经 `parseNumberArgument` 规范化）排到末尾。
- **可见性**：`0` 视为隐藏；`<= 0` 一律视为隐藏（负数未在用户需求中，按隐藏处理更安全）。
- **4 个 always-inject 点**：注入全部 3 个，但按 `orderedPlayerTypes`（0 排末尾）排序；`0` 不影响这些点的可见性。
- **旧值不迁移**：旧 `*Enabled` 的 BoxJs 值与新键名不匹配，被忽略；旧字符串位置上的 `"true"/"false"` 经 `parseNumberArgument` 解析为 NaN → 回落默认值。
- **既有 bug 修复**：SofaTime Streaming Availability 路由 `argumentKeys` 由 `CORE_WITH_PLAYER_ARGUMENT_KEYS` 改为 `ALL_ARGUMENT_KEYS`（对齐字符串解析顺序），这是新特性在 Loon 下正常工作的前提。

## Proposed Changes

### 1. `trakt_simplified_chinese/src/utils/common.mjs`
- 新增 `parseNumberArgument(value, fallbackValue)`：接受 `number`（`Number.isFinite` 时 `Math.trunc`）或数字字符串（`Number(trimmed)`，有限则 trunc），否则返回 `fallbackValue`。
- 修改 `parseArgumentValue`：当 `typeof fallbackValue === "number"` 时派发到 `parseNumberArgument`。
- 在 export 列表加入 `parseNumberArgument`。

### 2. `trakt_simplified_chinese/src/module-manifest.mjs`
- [L55-L75](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/module-manifest.mjs#L55-L75) 三个字段重命名 + 改类型 + 改默认值 + 更新 tag/desc：
  - `eplayerxEnabled` → `eplayerxOrder`，`defaultValue: 1`，`type: "number"`，desc 说明「序号代表排序位置，0 不显示，默认 1」。
  - `forwardEnabled` → `forwardOrder`，`defaultValue: 2`。
  - `infuseEnabled` → `infuseOrder`，`defaultValue: 3`。
- [L93](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/module-manifest.mjs#L93) `PLAYER_ARGUMENT_KEYS` 改为 `["eplayerxOrder", "forwardOrder", "infuseOrder"]`。
- 删除现已无引用的 `CORE_WITH_PLAYER_ARGUMENT_KEYS`（[L95](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/module-manifest.mjs#L95)）。
- scriptRules `argumentKeys` 调整（让 4 个 always-inject 点 + 修正 SofaTime streaming）：
  - "TMDB Provider Catalog"（[L173-L182](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/module-manifest.mjs#L173-L182)）：`CORE_ARGUMENT_KEYS` → `ALL_ARGUMENT_KEYS`。
  - "SofaTime Country Services"（[L194-L204](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/module-manifest.mjs#L194-L204)）：`CORE_ARGUMENT_KEYS` → `ALL_ARGUMENT_KEYS`。
  - "SofaTime Streaming Availability"（[L184-L193](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/module-manifest.mjs#L184-L193)）：`CORE_WITH_PLAYER_ARGUMENT_KEYS` → `ALL_ARGUMENT_KEYS`（修正既有错位）。
  - 其余规则不变（Direct Redirect / TMDB Logo Redirect / Trakt Response Router 已是 `ALL_ARGUMENT_KEYS`；3 个 history/season request 规则保持 `CORE_ARGUMENT_KEYS`，非注入点）。

### 3. `trakt_simplified_chinese/src/argument.mjs`
- [L5-L9](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/argument.mjs#L5-L9) `PLAYER_BUTTON_ARGUMENT_GROUP_KEYS` 键名改为 `eplayerxOrder/forwardOrder/infuseOrder`（值仍映射到 `eplayerx/forward/infuse`）。
- [L13](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/argument.mjs#L13) group 名 `playerButtonEnabled` → `playerButtonOrder`。
- [L16-L22](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/argument.mjs#L16-L22) `createDefaultPlayerButtonEnabledConfig` 重命名为 `createDefaultPlayerButtonOrderConfig`，返回 `{eplayerx:1, forward:2, infuse:3}`。
- [L24-L39](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/argument.mjs#L24-L39) `createDefaultArgumentConfig` 使用新 group 名与新默认函数。
- [L41-L80](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/argument.mjs#L41-L80) `applyArgumentObjectConfig`/`applyArgumentStringConfig`：写入 `config.playerButtonOrder[groupKey]`（`parseArgumentValue` 会自动派发到 `parseNumberArgument`）。
- [L116-L125](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/argument.mjs#L116-L125) `normalizeArgument` 重写排序逻辑：
  ```js
  const orderMap = argument.playerButtonOrder;
  const orderOf = (source) => (Number(orderMap[source]) > 0 ? Number(orderMap[source]) : 0);
  const orderedPlayerTypes = Object.values(playerDefinitions.PLAYER_TYPE)
      .slice()
      .sort((a, b) => {
          const oa = orderOf(a);
          const ob = orderOf(b);
          if (oa === 0 && ob === 0) return 0;   // 都隐藏：保持声明顺序（稳定排序）
          if (oa === 0) return 1;              // 隐藏沉底
          if (ob === 0) return -1;
          return oa - ob;                       // 非 0 升序
      });
  const enabledPlayerTypes = orderedPlayerTypes.filter((source) => orderOf(source) > 0);
  return {
      ...argument,
      posterImageMode: normalizePosterImageMode(argument.posterImageMode),
      backendBaseUrl: normalizeBackendBaseUrl(argument),
      playerButtonOrder: orderMap,
      orderedPlayerTypes,
      enabledPlayerTypes,
  };
  ```
- export 列表：补 `createDefaultPlayerButtonOrderConfig`（若被测试直接引用），保留其余导出。

### 4. `trakt_simplified_chinese/src/features/player-injection-trakt.mjs`
- `injectWatchnowFavoriteSources`（[L83-L102](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/features/player-injection-trakt.mjs#L83-L102)）：新增参数 `orderedPlayerTypes`；把 `Object.values(PLAYER_TYPE).slice().reverse().forEach(unshift)` 改为：
  ```js
  const playerFavorites = commonUtils
      .ensureArray(orderedPlayerTypes)
      .map((source) => buildWatchnowFavoriteSource(source, resolvedRegionCode));
  return [...playerFavorites, ...filtered];
  ```
  （净效果保持默认正向 `[sg-eplayerx, sg-forward, sg-infuse]`，并支持自定义顺序）
- `injectCustomSourcesIntoList`（[L111-L120](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/features/player-injection-trakt.mjs#L111-L120)）：新增参数 `orderedPlayerTypes`；把 `Object.values(PLAYER_TYPE).slice().reverse().map(...)` 改为 `commonUtils.ensureArray(orderedPlayerTypes).map(...)`。默认顺序由反向 `[infuse,forward,eplayerx]` 翻为正向 `[eplayerx,forward,infuse]`。
- `injectWatchnowSourcesPayload`（[L140-L174](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/features/player-injection-trakt.mjs#L140-L174)）：透传 `orderedPlayerTypes` 给 `injectCustomSourcesIntoList`。
- `injectUserSettingsPayload`（[L302-L315](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/features/player-injection-trakt.mjs#L302-L315)）：新增参数 `orderedPlayerTypes`，透传给 `injectWatchnowFavoriteSources`。
- `handleWatchnowSources`（[L359-L365](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/features/player-injection-trakt.mjs#L359-L365)）：读取 `globalThis.$ctx.argument?.orderedPlayerTypes` 并透传。
- `handleUserSettings`（[L367-L378](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/features/player-injection-trakt.mjs#L367-L378)）：读取 `globalThis.$ctx.argument?.orderedPlayerTypes` 并透传给 `injectUserSettingsPayload`。
- `handleWatchnow`（[L343-L357](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/features/player-injection-trakt.mjs#L343-L357)）：无需改动，已读 `context.argument.enabledPlayerTypes`（现为排序后的可见列表）。

### 5. `trakt_simplified_chinese/src/features/player-injection-sofatime.mjs`
- `injectSofaTimeCountryServices`（[L280-L299](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/features/player-injection-sofatime.mjs#L280-L299)）：新增参数 `orderedPlayerTypes`；把 `Object.values(PLAYER_TYPE).slice().reverse().forEach(unshift)` 改为：
  ```js
  const playerServices = commonUtils
      .ensureArray(orderedPlayerTypes)
      .map((source) => createSofaTimeCountryService(playerDefinitions.PLAYER_DEFINITIONS[source]));
  payload.services = [...playerServices, ...filteredServices];
  ```
- `injectTmdbProviderCatalog`（[L301-L322](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/features/player-injection-sofatime.mjs#L301-L322)）：新增参数 `orderedPlayerTypes`；用 source→entry 映射按 `orderedPlayerTypes` 取条目：
  ```js
  const entriesBySource = Object.fromEntries(
      Object.values(playerDefinitions.PLAYER_TYPE).map((source, index) => [source, TMDB_PROVIDER_LIST_ENTRIES[index]]),
  );
  const playerEntries = commonUtils
      .ensureArray(orderedPlayerTypes)
      .map((source) => entriesBySource[source])
      .filter(Boolean)
      .map((entry) => commonUtils.cloneObject(entry));
  payload.results = [...playerEntries, ...filteredResults];
  ```
  （`TMDB_PROVIDER_LIST_ENTRIES` 的 `provider_id` 1/2/3 是固定 ID，与排序无关，保持不变）
- `handleSofaTimeCountries`（[L355-L370](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/features/player-injection-sofatime.mjs#L355-L370)）：读取 `globalThis.$ctx.argument?.orderedPlayerTypes` 并透传给 `injectSofaTimeCountryServices`。
- `handleTmdbProviderCatalog`（[L324-L334](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/features/player-injection-sofatime.mjs#L324-L334)）：读取 `globalThis.$ctx.argument?.orderedPlayerTypes` 并透传。
- `handleSofaTimeStreamingAvailability`（[L372-L397](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/trakt_simplified_chinese/src/features/player-injection-sofatime.mjs#L372-L397)）：无需改动，已用 `context.argument.enabledPlayerTypes`（现为排序后的可见列表）。

### 6. `scripts/build-trakt.mjs`
- `inferPluginArgumentType`（[L168-L179](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/scripts/build-trakt.mjs#L168-L179)）：新增 `if (fieldType === "number") return "input";`（Loon 数字用 input 输入框，值以字符串形式传入，由 `parseNumberArgument` 解析）。
- `inferBoxjsSettingType`（[L181-L186](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/scripts/build-trakt.mjs#L181-L186)）：新增 `if (fieldType === "number") return "number";`。

### 7. 重新生成构建产物
执行 `npm run build:trakt`，自动重写：
- `trakt_simplified_chinese/trakt_simplified_chinese.js`（主脚本 bundle）
- `trakt_simplified_chinese/trakt_simplified_chinese.plugin`
- `trakt_simplified_chinese/trakt_simplified_chinese.sgmodule`
- `trakt_simplified_chinese/trakt_simplified_chinese.snippet`（无参数段，仅校验通过即可）
- `boxjs.json`

预期 `.plugin` [Argument] 段三行变为：
```
eplayerxOrder = input, "1", tag=EplayerX 跳转按钮, desc=...
forwardOrder = input, "2", tag=Forward 跳转按钮, desc=...
infuseOrder = input, "3", tag=Infuse 跳转按钮, desc=...
```
`boxjs.json` 对应 settings 的 `type` 变为 `"number"`、`val` 为 `1/2/3`。

### 8. 测试更新

#### `tests/trakt_argument.test.mjs`
- [L11-L19](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/tests/trakt_argument.test.mjs#L11-L19)：原 `"[original,true,true,false,false]"` 第 5 位是 `eplayerxOrder`；"false" 经数字解析为 NaN → 默认 1。改为传 `"[original,true,true,false,0]"`，断言 `parsed.playerButtonOrder.eplayerx === 0` 且 `parsed.enabledPlayerTypes` 不含 `eplayerx`。
- [L21-L29](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/tests/trakt_argument.test.mjs#L21-L29)：断言改为 `parsed.playerButtonOrder.eplayerx === 1`（默认）。
- [L118-L144](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/tests/trakt_argument.test.mjs#L118-L144)（关闭全部）：`argument` 键改为 `eplayerxOrder:0, forwardOrder:0, infuseOrder:0`；行为不变（`/movies/:id/watchnow` 不注入）。
- [L146-L172](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/tests/trakt_argument.test.mjs#L146-L172)（仅 forward）：键改为 `eplayerxOrder:0, forwardOrder:1, infuseOrder:0`；行为不变。
- **新增**用例（按 AGENTS.md 归属本文件）：
  - 数字解析：字符串 `"2"`→2、数字 3→3、`"abc"`→默认。
  - 排序：`{eplayerxOrder:3, forwardOrder:1, infuseOrder:2}` → `orderedPlayerTypes=[forward,infuse,eplayerx]`、`enabledPlayerTypes=[forward,infuse,eplayerx]`。
  - 隐藏沉底：`{eplayerxOrder:0, forwardOrder:1, infuseOrder:2}` → `orderedPlayerTypes=[forward,infuse,eplayerx]`、`enabledPlayerTypes=[forward,infuse]`。
  - 并列序号：`{eplayerxOrder:1, forwardOrder:1, infuseOrder:1}` → 声明顺序 `[eplayerx,forward,infuse]`。

#### `tests/trakt_script_watchnow.test.mjs`
- [L47-L58](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/tests/trakt_script_watchnow.test.mjs#L47-L58)（`/watchnow/sources` 默认）：断言由 `["infuse","forward","eplayerx"]` 改为 `["eplayerx","forward","infuse"]`（默认顺序统一为正向）。
- [L60-L76](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/tests/trakt_script_watchnow.test.mjs#L60-L76)：键改为 `eplayerxOrder:0, infuseOrder:0, forwardOrder:0`；断言改为 `["eplayerx","forward","infuse"]`（该路由 always-inject，0 仅沉底仍注入）；测试名改为「`/watchnow/sources` 在全部 player order 为 0 时仍注入全部自定义 source（按声明顺序）」。
- [L35-L45](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/tests/trakt_script_watchnow.test.mjs#L35-L45)（`/users/settings` favorites）：默认断言 `["sg-eplayerx","sg-forward","sg-infuse"]` 不变。
- [L197-L233](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/tests/trakt_script_watchnow.test.mjs#L197-L233)（禁用部分）：键改为 `eplayerxOrder:0, infuseOrder:0, forwardOrder:1`；断言不变。
- [L235-L263](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/tests/trakt_script_watchnow.test.mjs#L235-L263)（禁用全部）：键改为全 0；行为不变。
- **新增**：`/watchnow/sources` 自定义顺序用例（`{eplayerxOrder:3, forwardOrder:1, infuseOrder:2}` → `["forward","infuse","eplayerx"]`）；`/users/settings` favorites 自定义顺序用例。

#### `tests/trakt_script_routes.test.mjs`
- [L244-L260](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/tests/trakt_script_routes.test.mjs#L244-L260)（Sofa countries）：默认断言 `["eplayerx","forward","infuse"]` 不变。
- [L262-L278](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/tests/trakt_script_routes.test.mjs#L262-L278)（TMDb provider）：默认断言 `[1,2,3]` 不变。
- [L280-L296](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/tests/trakt_script_routes.test.mjs#L280-L296)（Sofa streaming availability）：默认断言 `["eplayerx","forward","infuse"]` 不变。
- **新增**：Sofa streaming availability 自定义顺序 + 隐藏用例（`{eplayerxOrder:0, forwardOrder:2, infuseOrder:1}` → `enabledPlayerTypes=[infuse,forward]`，只注入这两个且 infuse 在前）；Sofa countries / TMDb provider 自定义顺序用例（always-inject，0 沉底仍注入）。

#### `tests/trakt_module_manifest.test.mjs`
- 无需改动：[L33-L39](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/tests/trakt_module_manifest.test.mjs#L33-L39) 动态从 `argumentFields` 推导期望 keys，自动适配重命名；[L17-L24](file:///c:/Users/DemoJameson/.trae-cn/worktrees/Proxy.Modules/feat-player-config-index-EhOik5/tests/trakt_module_manifest.test.mjs#L17-L24) 守护生成产物与 manifest 一致。

## Verification

1. `npm run format`（Prettier 格式化）。
2. `npm run build:trakt`（重新生成 `.js`/`.plugin`/`.sgmodule`/`.snippet`/`boxjs.json`）。
3. `npm run check:trakt`（格式检查 + 构建 + `node --check` 源码/产物）。
4. `npm test`（默认离线测试套件）。
5. 重点确认通过：
   - `tests/trakt_argument.test.mjs`（数字解析、排序、可见性）。
   - `tests/trakt_script_watchnow.test.mjs`（`/watchnow/sources` 默认顺序翻转、自定义顺序）。
   - `tests/trakt_script_routes.test.mjs`（Sofa/TMDB 注入顺序与隐藏）。
   - `tests/trakt_module_manifest.test.mjs`（生成产物一致）。
6. 抽查生成产物：`.plugin` [Argument] 段为 `eplayerxOrder/forwardOrder/infuseOrder` 且 `type=input`、默认 `"1"/"2"/"3"`；`boxjs.json` settings `type:"number"`；`SofaTime Streaming Availability` 规则的 `argument=[...]` 占位符顺序变为 argumentFields 顺序（与其它 ALL_ARGUMENT_KEYS 规则一致）。
