import { argumentFields, BOXJS_CONFIG_KEY, DEFAULT_BACKEND_BASE_URL } from "./module-manifest.mjs";
import * as playerDefinitions from "./shared/player-definitions.mjs";
import * as commonUtils from "./utils/common.mjs";

const PLAYER_BUTTON_ARGUMENT_GROUP_KEYS = {
    eplayerxOrder: "eplayerx",
    forwardOrder: "forward",
    infuseOrder: "infuse",
};

const ARGUMENT_FIELDS = argumentFields.map((field) => {
    const groupKey = PLAYER_BUTTON_ARGUMENT_GROUP_KEYS[field.key];
    return groupKey ? { ...field, group: "playerButtonOrder", groupKey } : field;
});

function createDefaultPlayerButtonOrderConfig() {
    return {
        eplayerx: 1,
        forward: 2,
        infuse: 3,
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

function applyArgumentStringConfig(config, argument) {
    const raw = String(argument ?? "")
        .replace(/^\[|\]$/g, "")
        .trim();
    if (!raw) {
        return config;
    }

    const parts = raw
        .split(",")
        .map((item) => item.trim())
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

function normalizePosterImageMode(value) {
    const normalized = String(value ?? "")
        .trim()
        .toLowerCase();
    const labelMap = {
        默认: "default",
        原图: "default",
        中文: "chinese",
        原片语言: "original",
    };
    if (labelMap[normalized]) {
        return labelMap[normalized];
    }
    return ["default", "chinese", "original"].includes(normalized) ? normalized : "original";
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
        posterImageMode: normalizePosterImageMode(argument.posterImageMode),
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

export { ARGUMENT_FIELDS, applyArgumentObjectConfig, applyArgumentStringConfig, BOXJS_CONFIG_KEY, commonUtils, createDefaultArgumentConfig, normalizeArgument, parseArgument };
