import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { formatBuildVersion, renderGeneratedTargets, renderScriptBanner, renderSnippet } from "../scripts/build-trakt.mjs";
import { argumentFields, BOXJS_CONFIG_KEY, metadata, scriptRules } from "../trakt_simplified_chinese/src/module-manifest.mjs";
import { createRequestPhaseRoutes } from "../trakt_simplified_chinese/src/request.mjs";
import { createResponsePhaseRoutes } from "../trakt_simplified_chinese/src/response.mjs";
import { PLAYER_DEFINITIONS } from "../trakt_simplified_chinese/src/shared/player-definitions.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

function normalizeLineEndings(value) {
    return String(value).replace(/\r\n/g, "\n");
}

test("module manifest renders tracked Trakt subscription and BoxJs files", async () => {
    const generatedTargets = renderGeneratedTargets();

    for (const target of generatedTargets) {
        const actual = await readFile(path.join(rootDir, target.outputFile), "utf8");
        assert.equal(normalizeLineEndings(actual), normalizeLineEndings(target.content), `${target.outputFile} should be generated from module-manifest.mjs`);
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

    assert.ok(
        snippet.split("\n").some((line) => line.includes("device\\/code") && line.includes("script-request-body")),
        "device/code 请求体规则应使用 script-request-body",
    );
    assert.ok(
        snippet.split("\n").some((line) => line.includes("auth\\.trakt\\.tv\\/oauth\\/token") && line.includes("script-request-body")),
        "auth token 请求体规则应使用 script-request-body",
    );
    assert.ok(
        snippet.split("\n").some((line) => line.startsWith(String.raw`^https:\/\/trakt\.tv\/oauth\/token`) && line.includes("script-request-body")),
        "trakt.tv token 请求体规则应使用 script-request-body",
    );
    assert.ok(
        snippet.split("\n").some((line) => line.includes("api\\/auth\\/oauth2\\/authorize") && line.includes("script-response-header")),
        "OAuth 回调响应头规则应使用 script-response-header",
    );
});

// QX 的 script-request-body 改不了 headers，需要并行的 script-request-header 规则；
// 该规则只进 QX 片段，否则 Loon/Surge 会对同一请求跑两遍脚本
test("QX 的 OAuth 请求头规则只进 snippet 且与请求体规则成对", () => {
    const qxHeaderRules = scriptRules.filter((rule) => Array.isArray(rule.targets) && rule.targets.includes("snippet"));
    assert.equal(qxHeaderRules.length, 3, "应有三条 QX 专用的 OAuth 请求头规则");

    const snippet = normalizeLineEndings(renderSnippet());
    const snippetLines = snippet.split("\n");
    const otherTargets = renderGeneratedTargets().filter((target) => target.outputFile !== "trakt_simplified_chinese/trakt_simplified_chinese.snippet");
    for (const rule of qxHeaderRules) {
        assert.deepEqual(rule.targets, ["snippet"]);
        assert.ok(
            snippetLines.some((line) => line.startsWith(rule.pattern) && line.includes("script-request-header")),
            `QX 片段应包含请求头规则：${rule.title}`,
        );
        for (const target of otherTargets) {
            // 同一 pattern 会被 Loon/Surge 的请求体规则复用，因此用 QX 专用注释判断该规则是否泄漏到其它产物
            assert.equal(normalizeLineEndings(target.content).includes(rule.comment), false, `${target.outputFile} 不应包含 QX 专用规则：${rule.title}`);
        }
    }

    // 同一条 URL 在 QX 上必须同时挂 script-request-body 与 script-request-header 两条规则
    const oauthBodyPattern = String.raw`^https:\/\/apiz?\.trakt\.tv\/oauth\/(?:device\/code|device\/token|token)(?:\?.*)?$`;
    assert.ok(snippetLines.some((line) => line.startsWith(oauthBodyPattern) && line.includes("script-request-body")));
    assert.ok(snippetLines.some((line) => line.startsWith(oauthBodyPattern) && line.includes("script-request-header")));
});

// OAuth 相关端点需要模块清单规则和脚本路由同时覆盖，任一侧漏配都会导致请求未被改写。
const OAUTH_INTERCEPT_TARGETS = [
    { phase: "http-request", url: "https://api.trakt.tv/oauth/token" },
    { phase: "http-request", url: "https://apiz.trakt.tv/oauth/token" },
    { phase: "http-request", url: "https://api.trakt.tv/oauth/device/code" },
    { phase: "http-request", url: "https://api.trakt.tv/oauth/device/token" },
    { phase: "http-request", url: "https://auth.trakt.tv/oauth/token" },
    { phase: "http-request", url: "https://trakt.tv/oauth/token" },
    { phase: "http-request", url: "https://trakt.tv/oauth/authorize" },
    { phase: "http-request", url: "https://auth.trakt.tv/oauth/authorize" },
    { phase: "http-response", url: "https://auth.trakt.tv/api/auth/oauth2/authorize" },
    { phase: "http-response", url: "https://trakt.tv/api/auth/oauth2/authorize" },
    { phase: "http-response", url: "https://api.trakt.tv/oauth/token" },
    { phase: "http-response", url: "https://api.trakt.tv/oauth/device/code" },
    { phase: "http-response", url: "https://api.trakt.tv/oauth/device/token" },
    { phase: "http-response", url: "https://auth.trakt.tv/oauth/token" },
    { phase: "http-response", url: "https://trakt.tv/oauth/token" },
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
