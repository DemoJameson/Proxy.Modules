import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { formatBuildVersion, renderGeneratedTargets, renderScriptBanner } from "../scripts/build-trakt.mjs";
import { argumentFields, BOXJS_CONFIG_KEY, metadata } from "../trakt_simplified_chinese/src/module-manifest.mjs";
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
    assert.equal(app.keys[0], `@${BOXJS_CONFIG_KEY}.fakeVipEnabled`);
    assert.equal(app.settings[0].id, `@${BOXJS_CONFIG_KEY}.fakeVipEnabled`);
    assert.ok(app.keys.includes(`@${BOXJS_CONFIG_KEY}.historyEpisodesMergedByShow`));
    assert.ok(app.keys.includes(`@${BOXJS_CONFIG_KEY}.characterTranslationEnabled`));

    const characterSetting = app.settings.find((setting) => setting.id === `@${BOXJS_CONFIG_KEY}.characterTranslationEnabled`);
    assert.ok(characterSetting);
    assert.equal(characterSetting.name, "用豆瓣翻译角色名");
});
