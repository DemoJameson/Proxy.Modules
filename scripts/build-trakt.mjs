import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

import { argumentFields, boxjs, metadata, mitmHosts, scriptRules } from "../trakt_simplified_chinese/src/module-manifest.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const envCacheFile = path.join(rootDir, "scripts", "vendor", "Env.js");
const envModuleFile = path.join(rootDir, "scripts", "vendor", "Env.module.mjs");
const envSourceUrl = "https://github.com/DemoJameson/scripts/blob/feat-more-env/Env.js";
const externalModules = ["fs", "path", "got", "tough-cookie", "iconv-lite"];
const isSyncEnvMode = process.argv.includes("--sync-env");
const scriptBaseUrl = `${metadata.rawBaseUrl}/${metadata.modulePath}`;
// 构建时间固定按 +08:00 格式化，避免产物头部随构建机器时区变化
const BUILD_TIME_OFFSET_MS = 8 * 60 * 60 * 1000;

const buildTarget = {
    entryPoint: "trakt_simplified_chinese/src/main.mjs",
    outputFile: "trakt_simplified_chinese/trakt_simplified_chinese.js",
};

function formatBuildTimeText(date) {
    const shifted = new Date(date.getTime() + BUILD_TIME_OFFSET_MS);
    const pad = (value) => String(value).padStart(2, "0");
    return [shifted.getUTCFullYear(), "-", pad(shifted.getUTCMonth() + 1), "-", pad(shifted.getUTCDate()), " ", pad(shifted.getUTCHours()), ":", pad(shifted.getUTCMinutes())].join(
        "",
    );
}

// 配置文件里的 updatedTime：与头部「生成时间」取自同一次构建，精确到秒
function formatBuildDateTimeText(date) {
    const shifted = new Date(date.getTime() + BUILD_TIME_OFFSET_MS);
    const pad = (value) => String(value).padStart(2, "0");
    return [
        shifted.getUTCFullYear(),
        "-",
        pad(shifted.getUTCMonth() + 1),
        "-",
        pad(shifted.getUTCDate()),
        " ",
        pad(shifted.getUTCHours()),
        ":",
        pad(shifted.getUTCMinutes()),
        ":",
        pad(shifted.getUTCSeconds()),
    ].join("");
}

// 产物 UA 使用的版本号：YYMMDDHHmm，与头部「生成时间」取自同一次构建
function formatBuildVersion(date) {
    return formatBuildTimeText(date).replace(/[-: ]/g, "").slice(2);
}

function renderScriptBanner(date) {
    const metaLines = [
        `// 名称：${metadata.name}`,
        `// 描述：${metadata.description}`,
        `// 主页：${metadata.homepage}`,
        `// 作者：${metadata.author}`,
        `// 生成时间：${formatBuildTimeText(date)}`,
    ];

    return `${metaLines.join("\n")}\n\n`;
}

async function fileExists(targetPath) {
    try {
        await fs.access(targetPath);
        return true;
    } catch {
        return false;
    }
}

async function readEnvSourceFromCache() {
    return fs.readFile(envCacheFile, "utf8");
}

function resolveEnvFetchUrl(url) {
    const githubBlobMatch = String(url).match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);

    if (githubBlobMatch) {
        const [, owner, repo, ref, filePath] = githubBlobMatch;
        return `https://raw.githubusercontent.com/${owner}/${repo}/refs/heads/${ref}/${filePath}`;
    }

    return url;
}

async function fetchEnvSource() {
    const response = await fetch(resolveEnvFetchUrl(envSourceUrl));
    if (!response.ok) {
        throw new Error(`Failed to fetch Env.js: ${response.status} ${response.statusText}`);
    }

    return response.text();
}

async function writeEnvCache(source) {
    await fs.mkdir(path.dirname(envCacheFile), { recursive: true });
    await fs.writeFile(envCacheFile, source, "utf8");
}

async function writeEnvModule(source) {
    const moduleSource = `${source.trim()}\n\nexport { Env };\nexport default Env;\n`;
    await fs.mkdir(path.dirname(envModuleFile), { recursive: true });
    await fs.writeFile(envModuleFile, moduleSource, "utf8");
}

async function ensureEnvSource(forceRefresh = false) {
    const hasCache = await fileExists(envCacheFile);

    if (!forceRefresh && hasCache) {
        const envSource = await readEnvSourceFromCache();
        await writeEnvModule(envSource);
        return envSource;
    }

    const envSource = await fetchEnvSource();
    await writeEnvCache(envSource);
    await writeEnvModule(envSource);
    return envSource;
}

async function buildBundle(entryPoint, define = {}) {
    const result = await esbuild.build({
        entryPoints: [entryPoint],
        absWorkingDir: rootDir,
        bundle: true,
        format: "iife",
        platform: "browser",
        target: ["safari15"],
        charset: "utf8",
        legalComments: "none",
        sourcemap: false,
        minify: true,
        treeShaking: true,
        external: externalModules,
        define,
        write: false,
    });

    return result.outputFiles[0].text;
}

async function writeTarget(outputFile, content) {
    const targetPath = path.join(rootDir, outputFile);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, content, "utf8");
}

function getRuleTargets(rule) {
    return Array.isArray(rule.targets) && rule.targets.length > 0 ? rule.targets : ["plugin", "sgmodule", "snippet"];
}

function formatDefaultValue(value) {
    return typeof value === "boolean" ? String(value) : String(value ?? "");
}

function formatPluginArgumentValue(value) {
    return `"${formatDefaultValue(value)}"`;
}

function formatPluginArgumentValues(field) {
    const optionItems = getFieldOptionItems(field);
    const values = optionItems.length > 0 ? optionItems.map((item) => item.label) : [field.defaultValue];
    return values.map((value) => formatPluginArgumentValue(value)).join(", ");
}

function renderPluginArgumentLine(field) {
    if (field.type === "select") {
        return `${field.key} = ${inferPluginArgumentType(field.type)},${formatPluginArgumentValues(field).replaceAll(", ", ",")},tag=${field.tag},desc=${field.desc}`;
    }
    return `${field.key} = ${inferPluginArgumentType(field.type)}, ${formatPluginArgumentValues(field)}, tag=${field.tag}, desc=${field.desc}`;
}

// Surge 模块参数表的默认值会被替换进 argument="..." 的内层，值本身不能再带引号，否则与外层引号冲突
function formatSgmoduleArgumentValue(value) {
    return formatDefaultValue(value);
}

function formatSgmoduleDefaultArgumentValue(field) {
    if (field.type !== "select") {
        return formatSgmoduleArgumentValue(field.defaultValue);
    }

    const optionItems = getFieldOptionItems(field);
    const defaultItem = optionItems.find((item) => item.key === field.defaultValue);
    return formatSgmoduleArgumentValue(defaultItem?.label ?? field.defaultValue);
}

function getFieldOptionItems(field) {
    if (!Array.isArray(field.options) || field.options.length === 0) {
        return [];
    }

    const values = Array.isArray(field.optionValues) ? field.optionValues : [];
    return field.options.map((label, index) => ({
        key: values[index] ?? label,
        label,
    }));
}

function inferPluginArgumentType(fieldType) {
    if (fieldType === "boolean") {
        return "switch";
    }
    if (fieldType === "text") {
        return "input";
    }
    if (fieldType === "select") {
        return "select";
    }
    throw new Error(`Unsupported plugin argument type: ${fieldType}`);
}

function inferBoxjsSettingType(fieldType) {
    if (fieldType === "boolean" || fieldType === "text" || fieldType === "select") {
        return fieldType;
    }
    throw new Error(`Unsupported BoxJs setting type: ${fieldType}`);
}

function buildArgumentList(argumentKeys, formatter) {
    return argumentKeys.map(formatter).join(",");
}

function buildPluginArgumentObject(argumentKeys) {
    return `{${buildArgumentList(argumentKeys, (key) => `\${${key}}`).replaceAll(",", ", ")}}`;
}

function buildScriptUrl(scriptFile) {
    return `${scriptBaseUrl}/${scriptFile}`;
}

function normalizePatternHost(hostPattern) {
    return String(hostPattern ?? "")
        .replace(/\\\./g, ".")
        .replace(/\\-/g, "-");
}

function expandOptionalHostCharacters(hostPattern) {
    const optionalCharacterMatch = String(hostPattern).match(/^(.*)([A-Za-z0-9])\?(.*)$/);
    if (!optionalCharacterMatch) {
        return [hostPattern];
    }

    const [, prefix, optionalCharacter, suffix] = optionalCharacterMatch;
    return [normalizePatternHost(`${prefix}${optionalCharacter}${suffix}`), normalizePatternHost(`${prefix}${suffix}`)];
}

// 展开 host 段里的 `(?:a|b|c)` 分组与可选的 `(?:x)?` 分组，供 MITM host 校验使用
function splitTopLevelAlternatives(text) {
    const alternatives = [];
    let depth = 0;
    let current = "";
    for (const char of String(text)) {
        if (char === "(") {
            depth += 1;
        } else if (char === ")") {
            depth -= 1;
        }
        if (char === "|" && depth === 0) {
            alternatives.push(current);
            current = "";
            continue;
        }
        current += char;
    }
    alternatives.push(current);
    return alternatives;
}

function findMatchingGroupEnd(text, groupStart) {
    let depth = 0;
    for (let index = groupStart; index < text.length; index += 1) {
        const char = text[index];
        if (char === "(") {
            depth += 1;
        } else if (char === ")") {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        }
    }
    return -1;
}

function expandHostPattern(hostPattern) {
    const text = String(hostPattern ?? "");
    const groupStart = text.indexOf("(?:");
    if (groupStart < 0) {
        return expandOptionalHostCharacters(text);
    }

    const groupEnd = findMatchingGroupEnd(text, groupStart);
    if (groupEnd < 0) {
        return [text];
    }

    const inner = text.slice(groupStart + 3, groupEnd);
    const isOptional = text[groupEnd + 1] === "?";
    const prefix = text.slice(0, groupStart);
    const suffix = text.slice(groupEnd + (isOptional ? 2 : 1));
    const expansions = [];

    splitTopLevelAlternatives(inner).forEach((alternative) => {
        expansions.push(...expandHostPattern(`${prefix}${alternative}${suffix}`));
    });
    if (isOptional) {
        expansions.push(...expandHostPattern(`${prefix}${suffix}`));
    }

    return expansions;
}

function extractHostsFromPattern(pattern) {
    const match = String(pattern).match(/^\^https:\\\/\\\/(.+?)\\\//);
    if (!match) {
        return [];
    }

    return Array.from(new Set(expandHostPattern(match[1]).map(normalizePatternHost)));
}

function assertManifestIsValid(manifest) {
    const argumentKeySet = new Set(manifest.argumentFields.map((field) => field.key));
    const mitmHostSet = new Set(manifest.mitmHosts);
    const boxjsKeySet = new Set(manifest.boxjsKeys);

    manifest.scriptRules.forEach((rule) => {
        (rule.argumentKeys ?? []).forEach((key) => {
            if (!argumentKeySet.has(key)) {
                throw new Error(`Unknown argument key "${key}" in script rule "${rule.title}"`);
            }
        });

        extractHostsFromPattern(rule.pattern).forEach((host) => {
            if (!mitmHostSet.has(host)) {
                throw new Error(`MITM host "${host}" is missing for script rule "${rule.title}"`);
            }
        });
    });

    argumentKeySet.forEach((key) => {
        if (!boxjsKeySet.has(key)) {
            throw new Error(`BoxJs key "${key}" is missing`);
        }
    });

    boxjsKeySet.forEach((key) => {
        if (!argumentKeySet.has(key)) {
            throw new Error(`BoxJs key "${key}" is not declared in argumentFields`);
        }
    });
}

function renderPlugin(buildTime = new Date()) {
    const lines = [
        `#!name=${metadata.name}`,
        `#!desc=${metadata.description}`,
        `#!icon=${metadata.icon}`,
        `#!homepage=${metadata.homepage}`,
        `#!openUrl=${metadata.openUrl}`,
        `#!author=${metadata.author}`,
        `#!updatedTime=${formatBuildDateTimeText(buildTime)}`,
        "",
        "[Argument]",
    ];

    argumentFields.forEach((field) => {
        lines.push(renderPluginArgumentLine(field));
    });

    lines.push("", "[Script]");

    scriptRules
        .filter((rule) => getRuleTargets(rule).includes("plugin"))
        .forEach((rule) => {
            lines.push(`# ${rule.comment}`);
            const action = rule.phase === "http-request" ? "request" : "response";
            const argument = rule.argumentKeys?.length ? `, ${buildPluginArgumentObject(rule.argumentKeys)}` : "";
            const options = [`tag="${rule.title}"`, `timeout=${rule.timeout}`];
            if (rule.requiresBody) {
                options.push("requires_body=true");
            }
            lines.push(`${action} if \${url} ~= /${rule.pattern}/i then script("${buildScriptUrl(rule.scriptFile)}"${argument}) with ${options.join(", ")}`);
        });

    lines.push("", "[MITM]", `hostname = ${mitmHosts.join(", ")}`);

    return `${lines.join("\n")}\n`;
}

function renderSgmodule(buildTime = new Date()) {
    // 参数之间只用逗号分隔，与 Surge 官方示例一致，避免参数名带上前导空格
    const argumentPairs = argumentFields.map((field) => `${field.key}:${formatSgmoduleDefaultArgumentValue(field)}`).join(",");
    const argumentDescriptions = argumentFields.map((field) => `${field.key}: ${field.desc}`).join("\\n");
    const lines = [
        `#!name=${metadata.name}`,
        `#!desc=${metadata.description}`,
        `#!icon=${metadata.icon}`,
        `#!homepage=${metadata.homepage}`,
        `#!author=${metadata.author}`,
        `#!updatedTime=${formatBuildDateTimeText(buildTime)}`,
        `#!arguments=${argumentPairs}`,
        `#!arguments-desc=${argumentDescriptions}`,
        "",
        "[Script]",
    ];

    scriptRules
        .filter((rule) => getRuleTargets(rule).includes("sgmodule"))
        .forEach((rule) => {
            const parts = [`${rule.title} = type=${rule.phase}`, `pattern=${rule.pattern}`];
            if (rule.requiresBody) {
                parts.push("requires-body=true");
            }
            if (Number.isFinite(Number(rule.maxSize))) {
                parts.push(`max-size=${rule.maxSize}`);
            }
            parts.push(`timeout=${rule.timeout}`);
            if (rule.argumentKeys?.length) {
                // Surge 的 [Script] 行按逗号分隔 key=value 参数，含逗号的值必须用双引号包裹，
                // 否则 argument 会在第一个逗号处截断，只有第一个位置参数能传给脚本
                parts.push(`argument="${buildArgumentList(rule.argumentKeys, (key) => `{{{${key}}}}`)}"`);
            }
            parts.push(`script-path=${buildScriptUrl(rule.scriptFile)}`);

            lines.push(`# ${rule.comment}`, parts.join(", "));
        });

    lines.push("", "[MITM]", `hostname = %APPEND% ${mitmHosts.join(", ")}`);

    return `${lines.join("\n")}\n`;
}

function renderSnippet(buildTime = new Date()) {
    const lines = [
        `#!name=${metadata.name}`,
        `#!desc=${metadata.description}`,
        `#!icon=${metadata.icon}`,
        `#!homepage=${metadata.homepage}`,
        `#!author=${metadata.author}`,
        `#!updatedTime=${formatBuildDateTimeText(buildTime)}`,
        "",
        "# [rewrite_remote]",
    ];

    scriptRules
        .filter((rule) => getRuleTargets(rule).includes("snippet"))
        .forEach((rule) => {
            const snippetType =
                rule.phase === "http-request"
                    ? rule.requiresBody
                        ? "script-request-body"
                        : "script-request-header"
                    : rule.requiresBody
                      ? "script-response-body"
                      : "script-response-header";
            lines.push(`# ${rule.comment}`, `${rule.pattern} url ${snippetType} ${buildScriptUrl(rule.scriptFile)}`);
        });

    lines.push("# [mitm]", `hostname = ${mitmHosts.join(", ")}`);

    return `${lines.join("\n")}\n`;
}

function renderBoxjs() {
    const storagePrefix = "@dj_trakt_boxjs_configs";
    const keys = argumentFields.map((field) => `${storagePrefix}.${field.key}`);
    const app = {
        id: boxjs.app.id,
        name: metadata.name,
        keys,
        author: boxjs.app.author,
        repo: boxjs.app.repo,
        icons: boxjs.app.icons,
        settings: argumentFields.map((field) => ({
            id: `${storagePrefix}.${field.key}`,
            name: field.tag,
            val: field.defaultValue,
            type: inferBoxjsSettingType(field.type),
            desc: field.desc,
            ...(getFieldOptionItems(field).length > 0 ? { items: getFieldOptionItems(field) } : {}),
        })),
        descs_html: boxjs.app.descsHtml,
    };
    const payload = {
        id: boxjs.id,
        name: boxjs.name,
        description: boxjs.description,
        author: boxjs.author,
        repo: boxjs.repo,
        icon: boxjs.icon,
        apps: [app],
    };

    return `${JSON.stringify(payload, null, 4)}\n`;
}

function renderGeneratedTargets(buildTime = new Date()) {
    const boxjsKeys = argumentFields.map((field) => field.key);
    assertManifestIsValid({ argumentFields, boxjsKeys, mitmHosts, scriptRules });

    return [
        { outputFile: "trakt_simplified_chinese/trakt_simplified_chinese.plugin", content: renderPlugin(buildTime) },
        { outputFile: "trakt_simplified_chinese/trakt_simplified_chinese.sgmodule", content: renderSgmodule(buildTime) },
        { outputFile: "trakt_simplified_chinese/trakt_simplified_chinese.snippet", content: renderSnippet(buildTime) },
        { outputFile: "boxjs.json", content: renderBoxjs() },
    ];
}

async function writeGeneratedTargets(buildTime = new Date()) {
    for (const target of renderGeneratedTargets(buildTime)) {
        await writeTarget(target.outputFile, target.content);
    }
}

async function buildTrakt() {
    await ensureEnvSource(isSyncEnvMode);

    // 整次构建只取一次时间：头部「生成时间」与注入的 UA 版本号取自同一时刻
    const buildTime = new Date();
    const scriptSource = await buildBundle(buildTarget.entryPoint, {
        "globalThis.__SCRIPT_BUILD_VERSION__": JSON.stringify(formatBuildVersion(buildTime)),
    });
    await writeTarget(buildTarget.outputFile, renderScriptBanner(buildTime) + scriptSource);

    await writeGeneratedTargets(buildTime);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    buildTrakt().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

export {
    buildTrakt,
    extractHostsFromPattern,
    formatBuildDateTimeText,
    formatBuildVersion,
    renderBoxjs,
    renderGeneratedTargets,
    renderPlugin,
    renderScriptBanner,
    renderSgmodule,
    renderSnippet,
};
