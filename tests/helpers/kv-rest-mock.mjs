// 模拟真实 Upstash / Vercel KV REST API 的 /pipeline 语义，避免 mock 过宽掩盖线上失败：
// - 命令参数只接受字符串/数字：null、对象、数组、布尔都会让整个请求返回 HTTP 400
// - JSON.SET / JSON.MSET：$ 根路径可创建新 key，非根路径写入不存在的 key 返回 ERR new objects must be created at the root
// - JSON.SET 支持 NX/XX；字符串 "null" 按 JSON null 写入（与真实 RedisJSON 一致，不再删除字段）
// - JSON.DEL 删除路径或整个 key，key/路径不存在时返回 0
// - JSON.MGET / JSON.GET 返回 [value] 包装；EXPIRE/PTTL/PERSIST/DEL/SCAN 保持可用
function jsonValue(value) {
    return {
        __redisJson: true,
        value,
    };
}

function getJsonValue(store, key) {
    const stored = store.get(key);
    return stored && stored.__redisJson === true ? stored.value : null;
}

function hasJsonValue(store, key) {
    const stored = store.get(key);
    return !!stored && stored.__redisJson === true;
}

function hashValue(value) {
    return {
        __redisHash: true,
        value,
    };
}

function getHashValue(store, key) {
    const stored = store.get(key);
    return stored && stored.__redisHash === true ? stored.value : null;
}

function validateCommandArgs(commands) {
    for (const command of commands) {
        for (const arg of command) {
            if (arg === null || arg === undefined) {
                return "ERR null args are not supported";
            }
            if (typeof arg === "object") {
                return `ERR unsupported arg type: "${Array.isArray(arg) ? "[" : "{"}"`;
            }
            if (typeof arg !== "string" && typeof arg !== "number") {
                return "ERR unsupported arg type";
            }
        }
    }
    return "";
}

function parseJsonArg(rawValue) {
    if (typeof rawValue !== "string") {
        return rawValue;
    }
    try {
        return JSON.parse(rawValue);
    } catch {
        return rawValue;
    }
}

function splitJsonPath(path) {
    return String(path).replace(/^\$\./, "").split(".");
}

function globToRegExp(pattern) {
    const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
}

function applyPathWrite(store, key, path, rawValue) {
    const value = parseJsonArg(rawValue);
    if (path === "$") {
        store.set(key, jsonValue(value));
        return "";
    }
    if (!hasJsonValue(store, key)) {
        return "ERR new objects must be created at the root";
    }
    const root = { ...store.get(key).value };
    const segments = splitJsonPath(path);
    let cursor = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
        const segment = segments[index];
        cursor[segment] = cursor[segment] && typeof cursor[segment] === "object" ? { ...cursor[segment] } : {};
        cursor = cursor[segment];
    }
    cursor[segments[segments.length - 1]] = value;
    store.set(key, jsonValue(root));
    return "";
}

function applyPathDelete(store, key, path) {
    if (!hasJsonValue(store, key)) {
        return 0;
    }
    if (path === "$") {
        store.delete(key);
        return 1;
    }
    const root = { ...store.get(key).value };
    const segments = splitJsonPath(path);
    let cursor = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
        const segment = segments[index];
        if (!cursor[segment] || typeof cursor[segment] !== "object") {
            return 0;
        }
        cursor[segment] = { ...cursor[segment] };
        cursor = cursor[segment];
    }
    const last = segments[segments.length - 1];
    if (!Object.hasOwn(cursor, last)) {
        return 0;
    }
    delete cursor[last];
    store.set(key, jsonValue(root));
    return 1;
}

// 返回 { requestError }（整个请求 400）或 { results }（逐条命令结果，含 { error } 项）
function runKvPipeline(store, commands) {
    store.pipelineRequests = [...(store.pipelineRequests || []), commands];
    const argError = validateCommandArgs(commands);
    if (argError) {
        return { requestError: argError };
    }

    const results = [];
    for (const command of commands) {
        const [name, key] = command;
        if (name === "SEARCH.QUERY") {
            store.searchCommands = [...(store.searchCommands || []), command];
            results.push({ result: null });
        } else if (name === "JSON.SET") {
            store.setCommands = [...(store.setCommands || []), command];
            const path = command[2];
            const rawValue = command[3];
            const flags = command.slice(4).map((flag) => String(flag).toUpperCase());
            const exists = hasJsonValue(store, key);
            if ((flags.includes("NX") && exists) || (flags.includes("XX") && !exists)) {
                results.push({ result: null });
                continue;
            }
            const error = applyPathWrite(store, key, path, rawValue);
            results.push(error ? { error } : { result: "OK" });
        } else if (name === "JSON.MSET") {
            store.msetCommands = [...(store.msetCommands || []), command];
            // JSON.MSET 是原子的：任一三元组失败则整条命令不写入
            const snapshot = new Map();
            const remember = (itemKey) => {
                if (!snapshot.has(itemKey)) {
                    snapshot.set(itemKey, store.has(itemKey) ? store.get(itemKey) : null);
                }
            };
            let error = "";
            for (let index = 1; index < command.length; index += 3) {
                remember(command[index]);
                error = applyPathWrite(store, command[index], command[index + 1], command[index + 2]);
                if (error) {
                    break;
                }
            }
            if (error) {
                snapshot.forEach((value, itemKey) => {
                    if (value === null) {
                        store.delete(itemKey);
                    } else {
                        store.set(itemKey, value);
                    }
                });
                results.push({ error });
            } else {
                results.push({ result: "OK" });
            }
        } else if (name === "MGET") {
            store.mgetCommands = [...(store.mgetCommands || []), command];
            const keys = command.slice(1);
            results.push({
                result: keys.map((itemKey) => (typeof store.get(itemKey) === "string" ? store.get(itemKey) : null)),
            });
        } else if (name === "MSET") {
            store.msetCommands = [...(store.msetCommands || []), command];
            for (let index = 1; index < command.length; index += 2) {
                store.set(command[index], command[index + 1]);
            }
            results.push({ result: "OK" });
        } else if (name === "HGETALL") {
            store.hgetallCommands = [...(store.hgetallCommands || []), command];
            results.push({ result: getHashValue(store, key) || {} });
        } else if (name === "HMGET") {
            store.hmgetCommands = [...(store.hmgetCommands || []), command];
            const hash = getHashValue(store, key) || {};
            results.push({ result: command.slice(2).map((field) => hash[field] ?? null) });
        } else if (name === "HSET") {
            store.hsetCommands = [...(store.hsetCommands || []), command];
            const hash = { ...(getHashValue(store, key) || {}) };
            let added = 0;
            for (let index = 2; index < command.length; index += 2) {
                const field = command[index];
                if (!Object.hasOwn(hash, field)) {
                    added += 1;
                }
                hash[field] = command[index + 1];
            }
            store.set(key, hashValue(hash));
            results.push({ result: added });
        } else if (name === "HDEL") {
            store.hdelCommands = [...(store.hdelCommands || []), command];
            const hash = { ...(getHashValue(store, key) || {}) };
            let deleted = 0;
            command.slice(2).forEach((field) => {
                if (Object.hasOwn(hash, field)) {
                    delete hash[field];
                    deleted += 1;
                }
            });
            if (Object.keys(hash).length === 0) {
                store.delete(key);
            } else {
                store.set(key, hashValue(hash));
            }
            results.push({ result: deleted });
        } else if (name === "JSON.MGET") {
            store.mgetCommands = [...(store.mgetCommands || []), command];
            const keys = command.slice(1, -1);
            results.push({
                result: keys.map((itemKey) => (hasJsonValue(store, itemKey) ? [store.get(itemKey).value] : null)),
            });
        } else if (name === "JSON.GET") {
            store.getCommands = [...(store.getCommands || []), command];
            results.push({ result: hasJsonValue(store, key) ? [store.get(key).value] : null });
        } else if (name === "JSON.DEL") {
            store.delCommands = [...(store.delCommands || []), command];
            results.push({ result: applyPathDelete(store, key, command[2] ?? "$") });
        } else if (name === "EXPIRE") {
            store.expireCommands = [...(store.expireCommands || []), command];
            store.ttlByKey = store.ttlByKey || new Map();
            store.ttlByKey.set(key, Number(command[2]) * 1000);
            results.push({ result: store.has(key) ? 1 : 0 });
        } else if (name === "PERSIST") {
            store.persistCommands = [...(store.persistCommands || []), command];
            if (store.ttlByKey) {
                store.ttlByKey.delete(key);
            }
            results.push({ result: store.has(key) ? 1 : 0 });
        } else if (name === "PTTL") {
            store.pttlCommands = [...(store.pttlCommands || []), command];
            const ttl = store.ttlByKey ? store.ttlByKey.get(key) : undefined;
            results.push({ result: store.has(key) ? (Number.isFinite(ttl) ? ttl : -1) : -2 });
        } else if (name === "DEL") {
            if (store.ttlByKey) {
                command.slice(1).forEach((itemKey) => {
                    store.ttlByKey.delete(itemKey);
                });
            }
            let deleted = 0;
            command.slice(1).forEach((itemKey) => {
                if (store.delete(itemKey)) {
                    deleted += 1;
                }
            });
            results.push({ result: deleted });
        } else if (name === "SCAN") {
            store.scanCommands = [...(store.scanCommands || []), command];
            const cursor = Number.parseInt(command[1] || "0", 10) || 0;
            const matchIndex = command.indexOf("MATCH");
            const countIndex = command.indexOf("COUNT");
            const match = matchIndex >= 0 ? command[matchIndex + 1] || "" : "";
            const count = countIndex >= 0 ? Number.parseInt(command[countIndex + 1] || "10", 10) || 10 : 10;
            const pattern = globToRegExp(match);
            const keys = Array.from(store.keys()).filter((itemKey) => pattern.test(itemKey));
            const nextCursor = cursor + count >= keys.length ? "0" : String(cursor + count);
            results.push({ result: [nextCursor, keys.slice(cursor, cursor + count)] });
        } else {
            results.push({ result: null });
        }
    }
    return { results };
}

// 供各后端测试的 fetch mock 复用：把 /pipeline 请求交给真实语义的模拟器
function createPipelineResponse(store, init) {
    const commands = JSON.parse(init.body || "[]");
    const outcome = runKvPipeline(store, commands);
    if (outcome.requestError) {
        return {
            ok: false,
            status: 400,
            json: async () => ({ error: outcome.requestError }),
        };
    }
    return {
        ok: true,
        json: async () => outcome.results,
    };
}

export { createPipelineResponse, getHashValue, getJsonValue, hashValue, jsonValue, runKvPipeline, validateCommandArgs };
