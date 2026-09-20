import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { renderGeneratedTargets } from "../scripts/build-trakt.mjs";
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
