import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
    extractHostsFromPattern,
    formatBuildDateTimeText,
    formatBuildVersion,
    renderGeneratedTargets,
    renderPlugin,
    renderScriptBanner,
    renderSnippet,
} from "../scripts/build-trakt.mjs";
import { WATCHNOW_REDIRECT_URL } from "../trakt_simplified_chinese/src/features/player-injection-trakt.mjs";
import { argumentFields, BOXJS_CONFIG_KEY, metadata, mitmHosts, scriptRules } from "../trakt_simplified_chinese/src/module-manifest.mjs";
import { createRequestPhaseRoutes } from "../trakt_simplified_chinese/src/request.mjs";
import { createResponsePhaseRoutes } from "../trakt_simplified_chinese/src/response.mjs";
import { PLAYER_DEFINITIONS } from "../trakt_simplified_chinese/src/shared/player-definitions.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

function normalizeLineEndings(value) {
    return String(value).replace(/\r\n/g, "\n");
}

// updatedTime 每次构建都会变化，比对产物一致性时先把这一行归一化
function normalizeBuildUpdatedTime(value) {
    return normalizeLineEndings(value).replace(/^#!updatedTime=.*$/gm, "#!updatedTime=<build-time>");
}

test("module manifest renders tracked Trakt subscription and BoxJs files", async () => {
    const generatedTargets = renderGeneratedTargets();

    for (const target of generatedTargets) {
        const actual = await readFile(path.join(rootDir, target.outputFile), "utf8");
        assert.equal(normalizeBuildUpdatedTime(actual), normalizeBuildUpdatedTime(target.content), `${target.outputFile} should be generated from module-manifest.mjs`);
    }
});

test("Trakt 的 .plugin/.sgmodule/.snippet 在 metadata 末尾带构建时间 updatedTime", () => {
    const buildTime = new Date("2026-10-12T14:33:00Z"); // +08:00 => 2026-10-12 22:33:00
    const configTargets = renderGeneratedTargets(buildTime).filter((target) => /\.(plugin|sgmodule|snippet)$/.test(target.outputFile));
    assert.equal(configTargets.length, 3, "应生成 .plugin、.sgmodule、.snippet 三个配置文件");
    assert.equal(formatBuildDateTimeText(buildTime), "2026-10-12 22:33:00");

    for (const target of configTargets) {
        const lines = normalizeLineEndings(target.content).split("\n");
        const authorIndex = lines.findIndex((line) => line.startsWith("#!author="));
        assert.ok(authorIndex >= 0, `${target.outputFile} 应包含 #!author 元信息`);
        assert.equal(lines[authorIndex + 1], "#!updatedTime=2026-10-12 22:33:00", `${target.outputFile} 的 updatedTime 应紧跟 #!author 下方且取自构建时间`);
    }
});

test("配置文件 updatedTime 与脚本头部生成时间取自同一次构建", async () => {
    const script = normalizeLineEndings(await readFile(path.join(rootDir, "trakt_simplified_chinese", "trakt_simplified_chinese.js"), "utf8"));
    const buildTimeLine = script.split("\n").find((line) => line.startsWith("// 生成时间："));
    assert.ok(buildTimeLine, "脚本产物应包含头部生成时间");
    const bannerTime = buildTimeLine.slice("// 生成时间：".length);

    for (const outputFile of [
        "trakt_simplified_chinese/trakt_simplified_chinese.plugin",
        "trakt_simplified_chinese/trakt_simplified_chinese.sgmodule",
        "trakt_simplified_chinese/trakt_simplified_chinese.snippet",
    ]) {
        const content = normalizeLineEndings(await readFile(path.join(rootDir, outputFile), "utf8"));
        const updatedTimeLine = content.split("\n").find((line) => line.startsWith("#!updatedTime="));
        assert.ok(updatedTimeLine, `${outputFile} 应包含 #!updatedTime`);
        const updatedTime = updatedTimeLine.slice("#!updatedTime=".length);
        assert.match(updatedTime, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, `${outputFile} 的 updatedTime 格式应为 YYYY-MM-DD HH:mm:ss`);
        assert.equal(updatedTime.slice(0, 16), bannerTime, `${outputFile} 的 updatedTime 应与头部生成时间同源`);
    }
});

test("Surge 模块的 argument 必须整体加双引号，避免逗号被 Surge 当作参数分隔符", () => {
    const target = renderGeneratedTargets().find((item) => item.outputFile === "trakt_simplified_chinese/trakt_simplified_chinese.sgmodule");
    assert.ok(target, "应生成 Surge 模块产物");

    const content = normalizeLineEndings(target.content);
    const argumentLines = content.split("\n").filter((line) => line.includes("argument="));
    assert.ok(argumentLines.length > 0, "Surge 模块应包含带 argument 的脚本规则");
    for (const line of argumentLines) {
        assert.match(line, /argument="\{\{\{/, `argument 应以双引号包裹：${line}`);
        assert.match(line, /\}\}\}"(?:,|$)/, `argument 应在双引号内结束：${line}`);
    }
    assert.equal(content.includes("argument={{{"), false, "Surge 模块不应存在未加引号的 argument");

    // #!arguments 的默认值会被替换进 argument="..." 内层，默认值本身不能带引号
    const argumentsLine = content.split("\n").find((line) => line.startsWith("#!arguments="));
    assert.ok(argumentsLine, "Surge 模块应声明 #!arguments");
    assert.equal(argumentsLine.includes('"'), false, "#!arguments 默认值不应带引号");
});

test("Quantumult X snippet 会按 requiresBody 选择请求体或响应头脚本类型", () => {
    const snippet = normalizeLineEndings(renderSnippet());
    const snippetLines = snippet.split("\n");

    assert.ok(
        snippetLines.some((line) => line.includes("device\\/code") && line.includes("script-request-body")),
        "device/code 请求体规则应使用 script-request-body",
    );
    assert.ok(
        snippetLines.some((line) => line.includes("oauth\\/(?:device\\/code|device\\/token|token)") && line.includes("script-request-body")),
        "token 请求体规则应使用 script-request-body",
    );
    assert.ok(
        snippetLines.some((line) => line.includes("api\\/auth\\/oauth2\\/authorize") && line.includes("script-response-header")),
        "OAuth 回调响应头规则应使用 script-response-header",
    );
});

// OAuth 相关域名在规则层合并成同一条 pattern。
// QX build 954 实测 script-request-body 在空 body/GET 也会执行，因此不再需要并行 header 兜底；
// 该规则若回流，QX 会对同一请求重复执行改写，Loon/Surge 也会多跑一遍脚本。
test("QX 片段不再生成并行的 OAuth 请求头兜底规则", () => {
    const snippet = normalizeLineEndings(renderSnippet());
    const oauthTokenPattern = String.raw`^https:\/\/(?:apiz?\.trakt\.tv|auth\.trakt\.tv|trakt\.tv)\/oauth\/(?:device\/code|device\/token|token)(?:\?.*)?$`;
    const matchingLines = snippet.split("\n").filter((line) => line.startsWith(oauthTokenPattern));

    assert.equal(matchingLines.length, 1, "OAuth token/设备码请求在 QX 片段里应只有一条 rewrite");
    assert.ok(matchingLines[0].includes("script-request-body"), "QX OAuth 请求改写应使用 script-request-body");
    assert.equal(
        scriptRules.filter((rule) => rule.title.startsWith("Trakt OAuth")).some((rule) => Array.isArray(rule.targets)),
        false,
        "OAuth 规则不应存在平台专用兜底项",
    );
});

// 合并后的 pattern 用 alternation 表达多个域名，构建器的 MITM 校验必须能把它展开成独立 host，
// 否则漏配 hostname 会在真机上表现为「规则存在但 MITM 不解密、脚本从不触发」
test("MITM host 校验能展开合并 pattern 中的域名 alternation 与可选分组", () => {
    assert.deepEqual(extractHostsFromPattern(String.raw`^https:\/\/(?:apiz?\.trakt\.tv|auth\.trakt\.tv|trakt\.tv)\/oauth\/token$`).sort(), [
        "api.trakt.tv",
        "apiz.trakt.tv",
        "auth.trakt.tv",
        "trakt.tv",
    ]);
    assert.deepEqual(extractHostsFromPattern(String.raw`^https:\/\/(?:auth\.)?trakt\.tv\/oauth\/authorize$`).sort(), ["auth.trakt.tv", "trakt.tv"]);
});

// api/apiz 的 OAuth 响应已经由 Trakt Response Router 统一处理，
// 专用 token 响应规则必须排除它们，否则同一响应会被执行两次（重复消费 pending、重复写 token）
test("OAuth token 响应规则不与 Trakt Response Router 重复命中 api 域名", () => {
    const apiOAuthUrls = ["https://api.trakt.tv/oauth/token", "https://apiz.trakt.tv/oauth/device/code", "https://api.trakt.tv/oauth/device/token"];
    const responseRules = scriptRules.filter((rule) => rule.phase === "http-response");

    for (const url of apiOAuthUrls) {
        const matched = responseRules.filter((rule) => new RegExp(rule.pattern, "i").test(url)).map((rule) => rule.title);
        assert.deepEqual(matched, ["Trakt Response Router"], `${url} 只应由响应路由器处理，实际命中：${matched.join(" / ")}`);
    }

    for (const url of [
        "https://auth.trakt.tv/oauth/token",
        "https://trakt.tv/oauth/token",
        "https://auth.trakt.tv/oauth/device/code",
        "https://auth.trakt.tv/oauth/device/token",
        "https://trakt.tv/oauth/device/code",
        "https://trakt.tv/oauth/device/token",
    ]) {
        const matched = responseRules.filter((rule) => new RegExp(rule.pattern, "i").test(url)).map((rule) => rule.title);
        assert.deepEqual(matched, ["Trakt OAuth Token Response Rewrite"], `${url} 应只由专用响应规则处理，实际命中：${matched.join(" / ")}`);
    }
});

// 授权相关规则按「域名 × 阶段」合并：token/设备码请求、token/设备码响应、authorize、callback 各一条。
test("授权相关规则已按域名合并，不再逐域名重复", () => {
    const oauthRules = scriptRules.filter((rule) => rule.title.startsWith("Trakt OAuth"));
    assert.equal(oauthRules.length, 4, "授权规则应为 4 条共享规则");

    for (const rule of oauthRules) {
        // token 请求用三域名 alternation；authorize/callback/token 响应用可选分组 (?:auth\.)? 或双域名 alternation 合并
        assert.ok(rule.pattern.includes("(?:") && (rule.pattern.includes("|") || rule.pattern.includes("(?:auth")), `授权规则应合并多个域名：「${rule.title}」`);
    }
});

// OAuth 相关端点需要模块清单规则和脚本路由同时覆盖，任一侧漏配都会导致请求未被改写。
const OAUTH_INTERCEPT_TARGETS = [
    { phase: "http-request", url: "https://api.trakt.tv/oauth/token" },
    { phase: "http-request", url: "https://apiz.trakt.tv/oauth/token" },
    { phase: "http-request", url: "https://api.trakt.tv/oauth/device/code" },
    { phase: "http-request", url: "https://api.trakt.tv/oauth/device/token" },
    { phase: "http-request", url: "https://auth.trakt.tv/oauth/token" },
    { phase: "http-request", url: "https://auth.trakt.tv/oauth/device/code" },
    { phase: "http-request", url: "https://auth.trakt.tv/oauth/device/token" },
    { phase: "http-request", url: "https://trakt.tv/oauth/token" },
    { phase: "http-request", url: "https://trakt.tv/oauth/device/code" },
    { phase: "http-request", url: "https://trakt.tv/oauth/device/token" },
    { phase: "http-request", url: "https://trakt.tv/oauth/authorize" },
    { phase: "http-request", url: "https://auth.trakt.tv/oauth/authorize" },
    { phase: "http-response", url: "https://auth.trakt.tv/api/auth/oauth2/authorize" },
    { phase: "http-response", url: "https://trakt.tv/api/auth/oauth2/authorize" },
    { phase: "http-response", url: "https://api.trakt.tv/oauth/token" },
    { phase: "http-response", url: "https://api.trakt.tv/oauth/device/code" },
    { phase: "http-response", url: "https://api.trakt.tv/oauth/device/token" },
    { phase: "http-response", url: "https://auth.trakt.tv/oauth/token" },
    { phase: "http-response", url: "https://auth.trakt.tv/oauth/device/code" },
    { phase: "http-response", url: "https://auth.trakt.tv/oauth/device/token" },
    { phase: "http-response", url: "https://trakt.tv/oauth/token" },
    { phase: "http-response", url: "https://trakt.tv/oauth/device/code" },
    { phase: "http-response", url: "https://trakt.tv/oauth/device/token" },
];

function createRouteContext(url) {
    const parsed = new URL(url);
    parsed.shortPathname = parsed.pathname.replace(/^\/+|\/+$/g, "");
    return { url: parsed };
}

test("OAuth 模块清单规则与请求/响应路由保持一致", () => {
    const routesByPhase = {
        "http-request": createRequestPhaseRoutes(),
        "http-response": createResponsePhaseRoutes(),
    };
    const oauthRules = scriptRules.filter((rule) => /\/oauth\//.test(rule.pattern));
    const oauthRoutes = Object.entries(routesByPhase).flatMap(([phase, routes]) =>
        routes.filter((route) => route.describe().startsWith("oauth.")).map((route) => ({ phase, route })),
    );

    for (const target of OAUTH_INTERCEPT_TARGETS) {
        // api/apiz 的响应由通用 Trakt Response Router 触发，因此这里对全部规则做覆盖检查
        const ruleMatched = scriptRules.some((rule) => rule.phase === target.phase && new RegExp(rule.pattern).test(target.url));
        assert.ok(ruleMatched, `${target.phase} ${target.url} 应被模块清单规则覆盖`);

        const routeMatched = oauthRoutes.some(({ phase, route }) => phase === target.phase && route.test(createRouteContext(target.url)));
        assert.ok(routeMatched, `${target.phase} ${target.url} 应被脚本路由覆盖`);
    }

    for (const rule of oauthRules) {
        assert.ok(
            OAUTH_INTERCEPT_TARGETS.some((target) => target.phase === rule.phase && new RegExp(rule.pattern).test(target.url)),
            `模块清单规则「${rule.title}」未出现在一致性用例的端点列表里`,
        );
    }

    for (const { phase, route } of oauthRoutes) {
        assert.ok(
            OAUTH_INTERCEPT_TARGETS.some((target) => target.phase === phase && route.test(createRouteContext(target.url))),
            `脚本路由「${route.describe()}」未出现在一致性用例的端点列表里`,
        );
    }
});

// 非认证 Trakt 请求也要走请求阶段改写 trakt-api-key；漏掉通用规则时脚本根本不会运行
const NON_OAUTH_REQUEST_TARGETS = [
    "https://api.trakt.tv/sync/history",
    "https://apiz.trakt.tv/sync/history",
    "https://api.trakt.tv/users/me/watchlist",
    "https://api.trakt.tv/shows/1/seasons",
];

// Direct Redirect 规则必须与脚本实际生成的跳转链接同域名：
// 后端域名从 loon-plugins 迁到 proxy-modules 后，规则若仍指向旧域名，
// 生成的链接既不会命中规则也不会被 MITM，DeepLink 跳转会静默失效。
test("Direct Redirect 规则与 MITM host 使用脚本实际生成的域名", () => {
    const redirectHost = new URL(WATCHNOW_REDIRECT_URL).hostname;
    const redirectRule = scriptRules.find((rule) => rule.title === "Direct Redirect");
    assert.ok(redirectRule, "应存在 Direct Redirect 规则");
    assert.ok(redirectRule.pattern.includes(redirectHost.replaceAll(".", "\\.")), `Direct Redirect 规则应匹配 ${redirectHost}，实际：${redirectRule.pattern}`);
    assert.ok(mitmHosts.includes(redirectHost), `MITM host 应包含 ${redirectHost}`);
    assert.equal(mitmHosts.includes("loon-plugins.demojameson.de5.net"), false, "不应再保留已下线的旧域名");
});

test("非 OAuth 的 Trakt API 请求会被请求阶段规则覆盖", () => {
    const requestRules = scriptRules.filter((rule) => rule.phase === "http-request");
    for (const url of NON_OAUTH_REQUEST_TARGETS) {
        assert.ok(
            requestRules.some((rule) => new RegExp(rule.pattern).test(url)),
            `http-request ${url} 应被模块清单规则覆盖`,
        );
    }
});

test("build-trakt 头部元信息按 +08:00 分钟精度格式化，并与代码之间留出空行", () => {
    const buildTime = new Date("2026-09-23T15:30:00+08:00");
    const expectedLines = [
        `// 名称：${metadata.name}`,
        `// 描述：${metadata.description}`,
        `// 主页：${metadata.homepage}`,
        `// 作者：${metadata.author}`,
        "// 生成时间：2026-09-23 15:30",
    ];

    assert.equal(renderScriptBanner(buildTime), `${expectedLines.join("\n")}\n\n`);
    assert.equal(formatBuildVersion(buildTime), "2609231530");
});

test("构建产物带中文头部，且紧跟一个空行", async () => {
    const script = normalizeLineEndings(await readFile(path.join(rootDir, "trakt_simplified_chinese", "trakt_simplified_chinese.js"), "utf8"));
    const [nameLine, descriptionLine, homepageLine, authorLine, buildTimeLine, separatorLine] = script.split("\n");

    assert.equal(nameLine, `// 名称：${metadata.name}`);
    assert.equal(descriptionLine, `// 描述：${metadata.description}`);
    assert.equal(homepageLine, `// 主页：${metadata.homepage}`);
    assert.equal(authorLine, `// 作者：${metadata.author}`);
    assert.match(buildTimeLine, /^\/\/ 生成时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.equal(separatorLine, "", "头部元信息与压缩代码之间应有一个空行");

    // UA 版本号与头部生成时间取自同一次构建，理论上必须一致
    const [datePart, timePart] = buildTimeLine.replace("// 生成时间：", "").split(" ");
    const expectedVersion = `${datePart.slice(2).replaceAll("-", "")}${timePart.replace(":", "")}`;
    assert.match(expectedVersion, /^\d{10}$/);
    assert.ok(script.includes(`"${expectedVersion}"`), "产物内注入的 UA 版本号应与头部生成时间一致");
});

test("模块清单不再包含定时任务，产物里也没有 cron 行", async () => {
    const plugin = normalizeLineEndings(await readFile(path.join(rootDir, "trakt_simplified_chinese", "trakt_simplified_chinese.plugin"), "utf8"));
    const sgmodule = normalizeLineEndings(await readFile(path.join(rootDir, "trakt_simplified_chinese", "trakt_simplified_chinese.sgmodule"), "utf8"));

    assert.equal(plugin.includes('cron "'), false);
    assert.equal(sgmodule.includes('cron "'), false);

    for (const targetFile of ["trakt_simplified_chinese_clear_cache.js", "trakt_simplified_chinese_expand_cache.js"]) {
        assert.equal(plugin.includes(targetFile), false, `${targetFile} 不应再出现在插件里`);
        await assert.rejects(readFile(path.join(rootDir, "trakt_simplified_chinese", targetFile), "utf8"));
    }
});

test("Loon 插件使用 Script v2 语法并由模块清单生成", () => {
    const plugin = normalizeLineEndings(renderPlugin(new Date("2026-10-12T14:33:00Z")));
    const lines = plugin.split("\n");
    const pluginRules = scriptRules.filter((rule) => !Array.isArray(rule.targets) || rule.targets.includes("plugin"));

    assert.equal(
        lines.some((line) => /^https?-(?:request|response) /.test(line)),
        false,
        "不应再生成旧版 HTTP 语法",
    );
    assert.equal(plugin.includes("script-path="), false, "Script v2 不应使用 script-path");
    assert.equal(plugin.includes("argument=["), false, "Script v2 不应使用 argument=[]");

    for (const rule of pluginRules) {
        const action = rule.phase === "http-request" ? "request" : "response";
        const argumentKeys = rule.argumentKeys ?? [];
        const argumentObject = `{${argumentKeys.map((key) => `\${${key}}`).join(", ")}}`;
        const expected = `${action} if \${url} ~= /${rule.pattern}/i then script("${metadata.rawBaseUrl}/${metadata.modulePath}/${rule.scriptFile}", ${argumentObject}) with tag="${rule.title}", timeout=${rule.timeout}${rule.requiresBody ? ", requires_body=true" : ""}`;

        assert.ok(lines.includes(expected), `插件规则「${rule.title}」应使用 Script v2 语法`);
    }
});

test("module manifest description mentions every player button", () => {
    const playerNames = Object.values(PLAYER_DEFINITIONS).map((definition) => definition.name);

    for (const playerName of playerNames) {
        assert.ok(metadata.description.includes(playerName), `${playerName} 跳转按钮应出现在模块描述里`);
    }
});

test("module manifest description is reused by the Vercel landing page", async () => {
    const indexHtml = await readFile(path.join(rootDir, "public", "index.html"), "utf8");

    assert.ok(normalizeLineEndings(indexHtml).includes(normalizeLineEndings(metadata.description)), "public/index.html 的 Trakt 模块描述应与 module-manifest.mjs 保持一致");
});

test("module manifest generates current BoxJs keys from argument fields", async () => {
    const boxjsTarget = renderGeneratedTargets().find((target) => target.outputFile === "boxjs.json");
    assert.ok(boxjsTarget);
    assert.equal(boxjsTarget.content.includes("latestHistoryEpisodeOnly"), false);

    const payload = JSON.parse(boxjsTarget.content);
    const app = payload.apps[0];
    const expectedKeys = argumentFields.map((field) => `@${BOXJS_CONFIG_KEY}.${field.key}`);

    assert.deepEqual(app.keys, expectedKeys);
    assert.deepEqual(
        app.settings.map((setting) => setting.id),
        expectedKeys,
    );
    // fakeVipEnabled 是配置第一项，chineseLocale 是第二项
    assert.equal(app.keys[0], `@${BOXJS_CONFIG_KEY}.fakeVipEnabled`);
    assert.equal(app.settings[0].id, `@${BOXJS_CONFIG_KEY}.fakeVipEnabled`);
    assert.equal(app.keys[1], `@${BOXJS_CONFIG_KEY}.chineseLocale`);
    assert.equal(app.settings[1].id, `@${BOXJS_CONFIG_KEY}.chineseLocale`);
    const localeSetting = app.settings.find((setting) => setting.id === `@${BOXJS_CONFIG_KEY}.chineseLocale`);
    assert.ok(localeSetting);
    assert.equal(localeSetting.name, "目标语言");
    assert.deepEqual(
        localeSetting.items.map((item) => item.label),
        ["简体中文", "繁體中文（台灣）", "繁體中文（香港）"],
    );

    const posterSetting = app.settings.find((setting) => setting.id === `@${BOXJS_CONFIG_KEY}.posterImageMode`);
    assert.ok(posterSetting);
    assert.deepEqual(
        posterSetting.items.map((item) => item.label),
        ["原片语言", "简体中文", "繁體中文（台灣）", "繁體中文（香港）", "原图"],
    );

    const characterIndex = app.keys.indexOf(`@${BOXJS_CONFIG_KEY}.characterTranslationEnabled`);
    const historyIndex = app.keys.indexOf(`@${BOXJS_CONFIG_KEY}.historyEpisodesMergedByShow`);
    assert.equal(characterIndex, 4);
    assert.equal(historyIndex, characterIndex + 1, "历史剧集按电视剧合并应在用豆瓣翻译角色名之后");

    const characterSetting = app.settings.find((setting) => setting.id === `@${BOXJS_CONFIG_KEY}.characterTranslationEnabled`);
    assert.ok(characterSetting);
    assert.equal(characterSetting.name, "用豆瓣翻译角色名");
});
