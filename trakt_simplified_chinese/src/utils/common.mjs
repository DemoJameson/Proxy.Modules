function isNullish(value) {
    return value === undefined || value === null;
}

function isNonNullish(value) {
    return !isNullish(value);
}

function isArray(value) {
    return Array.isArray(value);
}

function isNotArray(value) {
    return !isArray(value);
}

function isPlainObject(value) {
    return !!(value && typeof value === "object" && isNotArray(value));
}

function ensureObject(value, fallbackValue) {
    return isPlainObject(value) ? value : isPlainObject(fallbackValue) ? fallbackValue : {};
}

function ensureArray(value) {
    return isArray(value) ? value : [];
}

function parseBooleanArgument(value, fallbackValue) {
    if (typeof value === "boolean") {
        return value;
    }

    if (typeof value === "number") {
        return value !== 0;
    }

    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (["true", "1", "yes", "on"].includes(normalized)) {
            return true;
        }
        if (["false", "0", "no", "off"].includes(normalized)) {
            return false;
        }
    }

    return fallbackValue;
}

function parseNumberArgument(value, fallbackValue) {
    if (typeof value === "number") {
        return Number.isFinite(value) ? Math.trunc(value) : fallbackValue;
    }

    if (typeof value === "string") {
        const num = Number(value.trim());
        if (Number.isFinite(num)) {
            return Math.trunc(num);
        }
    }

    return fallbackValue;
}

function readTextArgument(value, fallbackValue) {
    if (typeof value !== "string") {
        return fallbackValue;
    }

    const trimmedValue = value.trim();
    return trimmedValue || fallbackValue;
}

function parseArgumentValue(value, fallbackValue) {
    if (typeof fallbackValue === "boolean") {
        return parseBooleanArgument(value, fallbackValue);
    }

    if (typeof fallbackValue === "number") {
        return parseNumberArgument(value, fallbackValue);
    }

    if (typeof fallbackValue === "string") {
        return readTextArgument(value, fallbackValue);
    }

    return value ?? fallbackValue;
}

function normalizePathname(pathname) {
    return String(pathname ?? "").replace(/^\/+|\/+$/g, "");
}

function parseUrlParts(url) {
    const match = String(url ?? "").match(/^([^?]+)(?:\?(.*))?$/);
    return {
        path: match?.[1] ?? "",
        query: match?.[2] ?? "",
    };
}

function parseQueryParams(query) {
    const params = {};

    String(query ?? "")
        .split("&")
        .forEach((part) => {
            if (!part) {
                return;
            }

            const pieces = part.split("=");
            const key = decodeURIComponent(pieces[0] ?? "");
            if (!key) {
                return;
            }

            params[key] = pieces.length > 1 ? decodeURIComponent(pieces.slice(1).join("=")) : "";
        });

    return params;
}

function cloneObject(value) {
    return JSON.parse(JSON.stringify(value));
}

function escapeQueryComponent(value) {
    return encodeURIComponent(String(value ?? "")).replace(/%20/g, "+");
}

function computeStringHash(value) {
    const text = String(value ?? "");
    let hash = 2166136261;

    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }

    return (hash >>> 0).toString(16).padStart(8, "0");
}

function decodeBase64Value(value) {
    if (typeof value !== "string" || !value) {
        return "";
    }

    try {
        if (typeof atob === "function") {
            return atob(value);
        }
    } catch (e) {
        void e;
    }

    try {
        if (typeof Buffer !== "undefined") {
            return Buffer.from(value, "base64").toString("utf8");
        }
    } catch (e) {
        void e;
    }

    return "";
}

function containsChineseCharacter(value) {
    return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(String(value ?? ""));
}

export {
    cloneObject,
    computeStringHash,
    containsChineseCharacter,
    decodeBase64Value,
    ensureArray,
    ensureObject,
    escapeQueryComponent,
    isArray,
    isNonNullish,
    isNotArray,
    isNullish,
    isPlainObject,
    normalizePathname,
    parseArgumentValue,
    parseBooleanArgument,
    parseNumberArgument,
    parseQueryParams,
    parseUrlParts,
    readTextArgument,
};
