import { argumentFields, BOXJS_CONFIG_KEY, DEFAULT_BACKEND_BASE_URL } from "./module-manifest.mjs";
import * as playerDefinitions from "./shared/player-definitions.mjs";
import * as commonUtils from "./utils/common.mjs";

const PLAYER_BUTTON_ARGUMENT_GROUP_KEYS = {
    eplayerxEnabled: "eplayerx",
    forwardEnabled: "forward",
    infuseEnabled: "infuse",
};

const ARGUMENT_FIELDS = argumentFields.map((field) => {
    const groupKey = PLAYER_BUTTON_ARGUMENT_GROUP_KEYS[field.key];
    return groupKey ? { ...field, group: "playerButtonEnabled", groupKey } : field;
});

function createDefaultPlayerButtonEnabledConfig() {
    return {
        eplayerx: true,
        forward: true,
        infuse: true,
    };
}

function createDefaultArgumentConfig() {
    const config = {
        playerButtonEnabled: createDefaultPlayerButtonEnabledConfig(),
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

function normalizeArgument(argument) {
    return {
        ...argument,
        backendBaseUrl: normalizeBackendBaseUrl(argument),
        enabledPlayerTypes: Object.values(playerDefinitions.PLAYER_TYPE).filter((source) => {
            return argument.playerButtonEnabled[source];
        }),
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
