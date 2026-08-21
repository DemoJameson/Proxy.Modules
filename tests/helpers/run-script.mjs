import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { DEEPLX_TRANSLATE_API_URL as DEEPLX_TRANSLATE_URL } from "../../trakt_simplified_chinese/src/outbound/deeplx-translate-client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(__dirname, "..", "..", "trakt_simplified_chinese", "trakt_simplified_chinese.js");
const scriptContent = fs.readFileSync(scriptPath, "utf8");
const GOOGLE_TRANSLATE_URL = "https://translation.googleapis.com/language/translate/v2";

function createTestConsole(verboseLogs) {
    if (verboseLogs) {
        return console;
    }

    const noop = () => {};
    return {
        log: noop,
        info: noop,
        warn: noop,
        error: noop,
        debug: noop,
    };
}

function createPersistentStore(initialData = {}) {
    const data = { ...initialData };
    return {
        data,
        read(key) {
            return Object.hasOwn(data, key) ? data[key] : null;
        },
        write(value, key) {
            data[key] = value;
            return true;
        },
    };
}

function createMockHttpResponse(mock) {
    if (typeof mock === "string") {
        return {
            status: 200,
            statusCode: 200,
            body: mock,
        };
    }

    return {
        status: Number(mock?.status ?? mock?.statusCode ?? 200),
        statusCode: Number(mock?.statusCode ?? mock?.status ?? 200),
        body: String(mock?.body ?? ""),
    };
}

function createMockHttpError(mock) {
    if (!mock || typeof mock !== "object" || !Object.hasOwn(mock, "error")) {
        return null;
    }

    return mock.error instanceof Error ? mock.error : new Error(String(mock.error ?? "Mock HTTP error"));
}

function resolveHttpMock(mocks, url) {
    if (!mocks) {
        return null;
    }

    function consumeMockValue(value) {
        if (Array.isArray(value)) {
            if (value.length === 0) {
                return null;
            }

            return value.shift();
        }

        return value;
    }

    if (Object.hasOwn(mocks, url)) {
        return consumeMockValue(mocks[url]);
    }

    if (url === DEEPLX_TRANSLATE_URL && Object.hasOwn(mocks, GOOGLE_TRANSLATE_URL)) {
        return consumeMockValue(mocks[GOOGLE_TRANSLATE_URL]);
    }

    const entries = Object.entries(mocks);
    for (const [pattern, value] of entries) {
        if (pattern.startsWith("regex:")) {
            const regex = new RegExp(pattern.slice(6));
            if (regex.test(url)) {
                return consumeMockValue(value);
            }
        }
    }

    return null;
}

function runScript({
    url,
    body,
    headers = {},
    responseHeaders = {},
    responseStatus = 200,
    argument,
    persistentData = {},
    hasResponse = true,
    httpGetMocks = {},
    httpPostMocks = {},
    verboseLogs = false,
}) {
    return new Promise((resolve, reject) => {
        const persistentStore = createPersistentStore(persistentData);
        const httpLogs = [];
        const pendingTimers = new Set();
        const timeout = setTimeout(() => {
            clearPendingTimers();
            reject(new Error("Timed out waiting for $done"));
        }, 2000);
        let settled = false;

        const trackedSetTimeout = (fn, delay, ...args) => {
            const id = setTimeout(
                (...timerArgs) => {
                    pendingTimers.delete(id);
                    if (typeof fn === "function") {
                        fn(...timerArgs);
                    }
                },
                delay,
                ...args,
            );
            pendingTimers.add(id);
            return id;
        };

        const trackedClearTimeout = (id) => {
            clearTimeout(id);
            pendingTimers.delete(id);
        };

        const clearPendingTimers = () => {
            for (const id of pendingTimers) {
                clearTimeout(id);
            }
            pendingTimers.clear();
        };

        const context = {
            $loon: {},
            $argument: argument,
            $request: {
                url,
                headers,
            },
            $persistentStore: persistentStore,
            $httpClient: {
                get(options, callback) {
                    httpLogs.push({
                        method: "GET",
                        url: String(options.url ?? ""),
                    });
                    const mock = resolveHttpMock(httpGetMocks, String(options.url ?? ""));
                    if (mock) {
                        const error = createMockHttpError(mock);
                        if (error) {
                            callback(error);
                            return;
                        }
                        const response = createMockHttpResponse(mock);
                        callback(null, response, response.body);
                        return;
                    }

                    if (/\/api\/trakt\/images(?:\?|$)/.test(String(options.url ?? ""))) {
                        callback(null, { status: 200, statusCode: 200, body: "{}" }, "{}");
                        return;
                    }

                    if (/\/api\/trakt\/credits(?:\?|$)/.test(String(options.url ?? ""))) {
                        callback(null, { status: 200, statusCode: 200, body: "{}" }, "{}");
                        return;
                    }

                    if (/\/api\/trakt\/people-names(?:\?|$)/.test(String(options.url ?? ""))) {
                        callback(null, { status: 200, statusCode: 200, body: "{}" }, "{}");
                        return;
                    }

                    if (/\/api\/trakt\/comment-translations(?:\?|$)/.test(String(options.url ?? ""))) {
                        callback(null, { status: 200, statusCode: 200, body: "{}" }, "{}");
                        return;
                    }

                    if (/\/api\/trakt\/list-translations(?:\?|$)/.test(String(options.url ?? ""))) {
                        callback(null, { status: 200, statusCode: 200, body: "{}" }, "{}");
                        return;
                    }

                    callback(new Error(`Unexpected HTTP GET: ${options.url}`));
                },
                post(options, callback) {
                    const postUrl = String(options.url ?? "");
                    httpLogs.push({
                        method: "POST",
                        url: postUrl,
                        body: String(options.body ?? ""),
                    });
                    const mock = resolveHttpMock(httpPostMocks, postUrl);
                    if (mock) {
                        const error = createMockHttpError(mock);
                        if (error) {
                            callback(error);
                            return;
                        }
                        const response = createMockHttpResponse(mock);
                        callback(null, response, response.body);
                        return;
                    }

                    if (/\/api\/trakt\/translations(?:\?|$)/.test(String(options.url ?? ""))) {
                        callback(null, { status: 200, statusCode: 200, body: "{}" }, "{}");
                        return;
                    }

                    if (/\/api\/trakt\/images(?:\?|$)/.test(String(options.url ?? ""))) {
                        callback(null, { status: 200, statusCode: 200, body: "{}" }, "{}");
                        return;
                    }

                    if (/\/api\/trakt\/credits(?:\?|$)/.test(String(options.url ?? ""))) {
                        callback(null, { status: 200, statusCode: 200, body: "{}" }, "{}");
                        return;
                    }

                    if (/\/api\/trakt\/people-names(?:\?|$)/.test(String(options.url ?? ""))) {
                        callback(null, { status: 200, statusCode: 200, body: "{}" }, "{}");
                        return;
                    }

                    if (/\/api\/trakt\/comment-translations(?:\?|$)/.test(String(options.url ?? ""))) {
                        callback(null, { status: 200, statusCode: 200, body: "{}" }, "{}");
                        return;
                    }

                    if (/\/api\/trakt\/list-translations(?:\?|$)/.test(String(options.url ?? ""))) {
                        callback(null, { status: 200, statusCode: 200, body: "{}" }, "{}");
                        return;
                    }

                    if (String(options.url ?? "") === DEEPLX_TRANSLATE_URL) {
                        callback(null, { status: 200, statusCode: 200, body: '{"data":""}' }, '{"data":""}');
                        return;
                    }

                    callback(new Error(`Unexpected HTTP POST: ${options.url}`));
                },
            },
            $notification: {
                post() {},
            },
            $done(result = {}) {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeout);
                clearPendingTimers();
                setTimeout(() => {
                    resolve({
                        result,
                        persistentData: persistentStore.data,
                        httpLogs,
                        hasRuntimeCtx: Object.hasOwn(context, "$ctx"),
                    });
                }, 0);
            },
            console: createTestConsole(verboseLogs),
            URL,
            setTimeout: trackedSetTimeout,
            clearTimeout: trackedClearTimeout,
        };

        if (hasResponse) {
            context.$response = {
                body,
                headers: responseHeaders,
                status: responseStatus,
                statusCode: responseStatus,
            };
        }

        try {
            vm.runInNewContext(scriptContent, context, { filename: scriptPath });
        } catch (error) {
            clearTimeout(timeout);
            clearPendingTimers();
            reject(error);
        }
    });
}

export { runScript };
