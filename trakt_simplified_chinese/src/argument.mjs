import { argumentFields, BOXJS_CONFIG_KEY, DEFAULT_BACKEND_BASE_URL } from "./module-manifest.mjs";
import { normalizeChineseLocale } from "./shared/chinese-script-converter.mjs";
import * as playerDefinitions from "./shared/player-definitions.mjs";
import { normalizeTranslationEngine } from "./shared/translation-engine.mjs";
import * as commonUtils from "./utils/common.mjs";

const PLAYER_BUTTON_ARGUMENT_GROUP_KEYS = {
    forwardButtonOrder: "forward",
    infuseButtonOrder: "infuse",
    rexButtonOrder: "rex",
};

const ARGUMENT_FIELDS = argumentFields.map((field) => {
    const groupKey = PLAYER_BUTTON_ARGUMENT_GROUP_KEYS[field.key];
    return groupKey ? { ...field, group: "playerButtonOrder", groupKey } : field;
});

function createDefaultPlayerButtonOrderConfig() {
    return {
        forward: 1,
        infuse: 2,
        rex: 3,
    };
}

function createDefaultArgumentConfig() {
    const config = {
        playerButtonOrder: createDefaultPlayerButtonOrderConfig(),
    };

    ARGUMENT_FIELDS.forEach(({ key, defaultValue, group, groupKey }) => {
        if (group && groupKey) {
            config[group][groupKey] = defaultValue;
            return;
        }

        config[key] = defaultValue;
    });

    return config;
}

function applyArgumentObjectConfig(config, argument) {
    ARGUMENT_FIELDS.forEach(({ key, group, groupKey }) => {
        if (group && groupKey) {
            config[group][groupKey] = commonUtils.parseArgumentValue(argument[key], config[group][groupKey]);
            return;
        }

        config[key] = commonUtils.parseArgumentValue(argument[key], config[key]);
    });

    return config;
}

// 位置参数只按当前顺序解析：字段顺序与 ARGUMENT_FIELDS 一致（fakeVipEnabled 在 chineseLocale 前），不兼容历史顺序
function applyArgumentStringConfig(config, argument) {
    // 平台外层包裹可能是 Loon 的 [a,b,c] 或 Surge 的双引号；参数表逐项也可能带引号，统一剥离后再按位置解析
    const raw = String(argument ?? "")
        .trim()
        .replace(/^\[|\]$/g, "")
        .replace(/^["']|["']$/g, "")
        .trim();
    if (!raw) {
        return config;
    }

    const parts = raw
        .split(",")
        .map((item) =>
            item
                .trim()
                .replace(/^["']|["']$/g, "")
                .trim(),
        )
        .filter(Boolean);
    ARGUMENT_FIELDS.forEach(({ key, group, groupKey }, index) => {
        if (parts.length <= index) {
            return;
        }

        if (group && groupKey) {
            config[group][groupKey] = commonUtils.parseArgumentValue(parts[index], config[group][groupKey]);
            return;
        }

        config[key] = commonUtils.parseArgumentValue(parts[index], config[key]);
    });

    return config;
}

function readBoxJsConfig(env) {
    const config = createDefaultArgumentConfig();
    const boxJsConfig = commonUtils.ensureObject(env.getjson(BOXJS_CONFIG_KEY, {}));
    return applyArgumentObjectConfig(config, boxJsConfig);
}

function normalizeBackendBaseUrl(argument) {
    let value = argument.backendBaseUrl;
    if (typeof value !== "string") {
        return DEFAULT_BACKEND_BASE_URL;
    }
    value = value.trim();
    if (!/^https?:\/\//i.test(value)) {
        return DEFAULT_BACKEND_BASE_URL;
    }
    return value.replace(/\/+$/, "");
}

// 海报语言：原片语言 / 简体中文 / 繁體中文（台灣）/ 繁體中文（香港）/ 原图
// 兼容旧标签与旧内部值（中文/chinese 等价简体中文，默认 等价原图），避免升级后静默回落到原片语言
function normalizePosterImageMode(value) {
    const normalized = String(value ?? "")
        .trim()
        .toLowerCase();
    const labelMap = {
        原片语言: "original",
        简体中文: "cn",
        "繁體中文（台灣）": "tw",
        "繁體中文(台灣)": "tw",
        "繁體中文（香港）": "hk",
        "繁體中文(香港)": "hk",
        原图: "default",
        中文: "cn",
        chinese: "cn",
        默认: "default",
    };
    if (labelMap[normalized]) {
        return labelMap[normalized];
    }
    return ["original", "cn", "tw", "hk", "default"].includes(normalized) ? normalized : "original";
}

function normalizeDebugMode(value) {
    const normalized = String(value ?? "").trim();
    const labelMap = {
        关闭: "off",
        禁用本地缓存: "disableLocal",
        禁用远端缓存: "disableRemote",
        禁用所有缓存: "disableAll",
    };
    if (labelMap[normalized]) {
        return labelMap[normalized];
    }
    return ["off", "disableLocal", "disableRemote", "disableAll"].includes(normalized) ? normalized : "off";
}

function normalizeArgument(argument) {
    const orderMap = argument.playerButtonOrder;
    const orderOf = (source) => (Number(orderMap[source]) > 0 ? Number(orderMap[source]) : 0);
    const orderedPlayerTypes = Object.values(playerDefinitions.PLAYER_TYPE)
        .slice()
        .sort((a, b) => {
            const oa = orderOf(a);
            const ob = orderOf(b);
            if (oa === 0 && ob === 0) {
                return 0;
            }
            if (oa === 0) {
                return 1;
            }
            if (ob === 0) {
                return -1;
            }
            return oa - ob;
        });
    const enabledPlayerTypes = orderedPlayerTypes.filter((source) => orderOf(source) > 0);

    return {
        ...argument,
        chineseLocale: normalizeChineseLocale(argument.chineseLocale),
        posterImageMode: normalizePosterImageMode(argument.posterImageMode),
        translationEngine: normalizeTranslationEngine(argument.translationEngine),
        debugMode: normalizeDebugMode(argument.debugMode),
        backendBaseUrl: normalizeBackendBaseUrl(argument),
        playerButtonOrder: orderMap,
        orderedPlayerTypes,
        enabledPlayerTypes,
    };
}

function parseArgument(env) {
    const argument = readBoxJsConfig(env);
    const runtimeArgument = typeof $argument === "undefined" ? undefined : $argument;

    if (typeof runtimeArgument === "object" && runtimeArgument !== null) {
        return normalizeArgument(applyArgumentObjectConfig(argument, runtimeArgument));
    }

    if (typeof runtimeArgument === "string") {
        return normalizeArgument(applyArgumentStringConfig(argument, runtimeArgument));
    }

    return normalizeArgument(argument);
}

export {
    ARGUMENT_FIELDS,
    applyArgumentObjectConfig,
    applyArgumentStringConfig,
    BOXJS_CONFIG_KEY,
    commonUtils,
    createDefaultArgumentConfig,
    normalizeArgument,
    normalizePosterImageMode,
    parseArgument,
};
