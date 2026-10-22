import { createPipelineResponse, getHashValue, hashValue } from "./kv-rest-mock.mjs";

function createResponse() {
    return {
        headers: {},
        statusCode: 200,
        jsonBody: null,
        setHeader(name, value) {
            this.headers[name] = value;
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.jsonBody = body;
            return this;
        },
    };
}

function createKvFetch(store) {
    return async (url, init = {}) => {
        const parsed = new URL(url);
        const path = parsed.pathname;
        if (parsed.hostname === "api.trakt.tv" && path.startsWith("/search/")) {
            const traktType = path.split("/").pop();
            store.traktSearchRequests = [
                ...(store.traktSearchRequests || []),
                {
                    type: traktType,
                    query: parsed.searchParams.get("query"),
                    apiKey: init.headers?.["trakt-api-key"],
                },
            ];
            if (store.traktSearchStatus) {
                return {
                    ok: false,
                    status: store.traktSearchStatus,
                    text: async () => store.traktSearchBody || "",
                    json: async () => ({ error: store.traktSearchBody || "trakt error" }),
                };
            }
            const results = store.traktSearchResults?.[traktType] || [];
            return {
                ok: true,
                text: async () => JSON.stringify(results),
                json: async () => results,
            };
        }
        if (path === "/pipeline") {
            return createPipelineResponse(store, init);
        }
        return {
            ok: false,
            status: 404,
            json: async () => ({ error: "not found" }),
        };
    };
}

function restoreEnv(name, value) {
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}

async function withBackend(store, callback, options = {}) {
    const previousFetch = globalThis.fetch;
    const previousKvUrl = process.env.KV_REST_API_URL;
    const previousKvToken = process.env.KV_REST_API_TOKEN;
    const previousAdminToken = process.env.ADMIN_TOKEN;
    const previousTraktApiKey = process.env.TRAKT_API_KEY;

    globalThis.fetch = createKvFetch(store);
    if (options.kvUrl === null) {
        delete process.env.KV_REST_API_URL;
        delete process.env.KV_REST_API_TOKEN;
    } else {
        process.env.KV_REST_API_URL = "https://kv.example";
        process.env.KV_REST_API_TOKEN = "test-kv-token";
    }
    if (options.adminToken === undefined) {
        process.env.ADMIN_TOKEN = "test-admin-token";
    } else if (options.adminToken === null) {
        delete process.env.ADMIN_TOKEN;
    } else {
        process.env.ADMIN_TOKEN = options.adminToken;
    }
    if (options.traktApiKey === undefined) {
        process.env.TRAKT_API_KEY = "test-trakt-api-key";
    } else if (options.traktApiKey === null) {
        delete process.env.TRAKT_API_KEY;
    } else {
        process.env.TRAKT_API_KEY = options.traktApiKey;
    }

    try {
        await callback();
    } finally {
        globalThis.fetch = previousFetch;
        restoreEnv("KV_REST_API_URL", previousKvUrl);
        restoreEnv("KV_REST_API_TOKEN", previousKvToken);
        restoreEnv("ADMIN_TOKEN", previousAdminToken);
        restoreEnv("TRAKT_API_KEY", previousTraktApiKey);
    }
}

async function invoke(handler, req) {
    const res = createResponse();
    await handler(
        {
            method: "GET",
            query: {},
            headers: {},
            ...req,
        },
        res,
    );
    return res;
}

function seedString(store, key, value) {
    store.set(key, JSON.stringify(value));
}

function getString(store, key) {
    const value = store.get(key);
    if (typeof value !== "string") {
        return null;
    }
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function seedHash(store, key, fields) {
    store.set(key, hashValue({ ...fields }));
}

export { createKvFetch, createResponse, getHashValue, getString, invoke, seedHash, seedString, withBackend };
