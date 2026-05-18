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

const buildTargets = [
    {
        entryPoint: "trakt_simplified_chinese/src/main.mjs",
        outputFile: "trakt_simplified_chinese/trakt_simplified_chinese.js",
    },
    {
        entryPoint: "trakt_simplified_chinese/src/main-clear-cache.mjs",
        outputFile: "trakt_simplified_chinese/trakt_simplified_chinese_clear_cache.js",
    },
    {
        entryPoint: "trakt_simplified_chinese/src/main-expand-cache.mjs",
        outputFile: "trakt_simplified_chinese/trakt_simplified_chinese_expand_cache.js",
    },
];

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

async function buildBundle(entryPoint) {
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

function formatSgmoduleArgumentValue(value) {
    return `"${formatDefaultValue(value)}"`;
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

function extractHostsFromPattern(pattern) {
    const match = String(pattern).match(/^\^https:\\\/\\\/(.+?)\\\//);
    if (!match) {
        return [];
    }

    return expandOptionalHostCharacters(match[1]).map(normalizePatternHost);
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

function renderPlugin() {
    const lines = [
        `#!name=${metadata.name}`,
        `#!desc=${metadata.description}`,
        `#!icon=${metadata.icon}`,
        `#!homepage=${metadata.homepage}`,
        `#!openUrl=${metadata.openUrl}`,
        `#!author=${metadata.author}`,
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
            if (rule.kind === "cron") {
                lines.push(`cron "${rule.cron}" script-path=${buildScriptUrl(rule.scriptFile)}, timeout=${rule.timeout}, enable=${rule.enable}, tag=${rule.title}`);
                return;
            }

            const parts = [`${rule.phase} ${rule.pattern} script-path=${buildScriptUrl(rule.scriptFile)}`];
            if (rule.requiresBody) {
                parts.push("requires-body=true");
            }
            parts.push(`timeout=${rule.timeout}`);
            if (rule.argumentKeys?.length) {
                parts.push(`argument=[${buildArgumentList(rule.argumentKeys, (key) => `{${key}}`)}]`);
            }
            parts.push(`tag=${rule.title}`);
            lines.push(parts.join(", "));
        });

    lines.push("", "[MITM]", `hostname = ${mitmHosts.join(", ")}`);

    return `${lines.join("\n")}\n`;
}

function renderSgmodule() {
    const argumentPairs = argumentFields.map((field) => `${field.key}:${formatSgmoduleDefaultArgumentValue(field)}`).join(", ");
    const argumentDescriptions = argumentFields.map((field) => `${field.key}: ${field.desc}`).join("\\n");
    const lines = [
        `#!name=${metadata.name}`,
        `#!desc=${metadata.description}`,
        `#!icon=${metadata.icon}`,
        `#!homepage=${metadata.homepage}`,
        `#!author=${metadata.author}`,
        `#!arguments=${argumentPairs}`,
        `#!arguments-desc=${argumentDescriptions}`,
        "",
        "[Script]",
    ];

    scriptRules
        .filter((rule) => rule.kind !== "cron" && getRuleTargets(rule).includes("sgmodule"))
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
                parts.push(`argument=${buildArgumentList(rule.argumentKeys, (key) => `{{{${key}}}}`)}`);
            }
            parts.push(`script-path=${buildScriptUrl(rule.scriptFile)}`);

            lines.push(`# ${rule.comment}`, parts.join(", "));
        });

    lines.push("", "[MITM]", `hostname = %APPEND% ${mitmHosts.join(", ")}`);

    return `${lines.join("\n")}\n`;
}

function renderSnippet() {
    const lines = [
        `#!name=${metadata.name}`,
        `#!desc=${metadata.description}`,
        `#!icon=${metadata.icon}`,
        `#!homepage=${metadata.homepage}`,
        `#!author=${metadata.author}`,
        "",
        "# [rewrite_remote]",
    ];

    scriptRules
        .filter((rule) => rule.kind !== "cron" && getRuleTargets(rule).includes("snippet"))
        .forEach((rule) => {
            const snippetType = rule.phase === "http-request" ? "script-request-header" : "script-response-body";
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

function renderGeneratedTargets() {
    const boxjsKeys = argumentFields.map((field) => field.key);
    assertManifestIsValid({ argumentFields, boxjsKeys, mitmHosts, scriptRules });

    return [
        { outputFile: "trakt_simplified_chinese/trakt_simplified_chinese.plugin", content: renderPlugin() },
        { outputFile: "trakt_simplified_chinese/trakt_simplified_chinese.sgmodule", content: renderSgmodule() },
        { outputFile: "trakt_simplified_chinese/trakt_simplified_chinese.snippet", content: renderSnippet() },
        { outputFile: "boxjs.json", content: renderBoxjs() },
    ];
}

async function writeGeneratedTargets() {
    for (const target of renderGeneratedTargets()) {
        await writeTarget(target.outputFile, target.content);
    }
}

async function buildTrakt() {
    await ensureEnvSource(isSyncEnvMode);

    for (const target of buildTargets) {
        const scriptSource = await buildBundle(target.entryPoint);
        await writeTarget(target.outputFile, scriptSource);
    }

    await writeGeneratedTargets();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    buildTrakt().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

export { buildTrakt, renderBoxjs, renderGeneratedTargets, renderPlugin, renderSgmodule, renderSnippet };
