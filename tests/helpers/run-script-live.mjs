import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(__dirname, "..", "..", "trakt_simplified_chinese", "trakt_simplified_chinese.js");
const scriptContent = fs.readFileSync(scriptPath, "utf8");

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

    for (const [pattern, value] of Object.entries(mocks)) {
        if (pattern.startsWith("regex:")) {
            const regex = new RegExp(pattern.slice(6));
            if (regex.test(url)) {
                return consumeMockValue(value);
            }
        }
    }

    return null;
}

function normalizeHeaders(headers) {
    const result = {};
    const input = headers instanceof Headers ? Object.fromEntries(headers.entries()) : headers;

    if (!input || typeof input !== "object") {
        return result;
    }

    Object.keys(input).forEach((key) => {
        result[String(key).toLowerCase()] = String(input[key]);
    });

    return result;
}

function isAllowedRealUrl(url, allowRealHttpHosts) {
    const { hostname } = new URL(url);
    return allowRealHttpHosts.includes(hostname);
}

async function performRealHttpRequest(method, options, allowRealHttpHosts, httpLogs) {
    const requestOptions =
        typeof options === "string"
            ? { url: options }
            : {
                  url: String(options?.url ?? ""),
                  headers: options?.headers,
                  body: options?.body,
              };

    if (!requestOptions.url) {
        throw new Error(`Missing URL for real HTTP ${method}`);
    }

    if (!isAllowedRealUrl(requestOptions.url, allowRealHttpHosts)) {
        throw new Error(`Real HTTP ${method} not allowed for ${requestOptions.url}`);
    }

    const response = await fetch(requestOptions.url, {
        method,
        headers: requestOptions.headers,
        body: method === "GET" ? undefined : requestOptions.body,
    });
    const responseBody = await response.text();
    const responseHeaders = normalizeHeaders(response.headers);

    httpLogs.push({
        method,
        url: requestOptions.url,
        status: response.status,
    });

    return {
        status: response.status,
        statusCode: response.status,
        headers: responseHeaders,
        body: responseBody,
    };
}

function runScriptLive({
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
    allowRealHttpHosts = [],
    verboseLogs = false,
}) {
    return new Promise((resolve, reject) => {
        const persistentStore = createPersistentStore(persistentData);
        const httpLogs = [];
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for $done")), 15000);

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
                    const requestUrl = String(options?.url ?? "");
                    const mock = resolveHttpMock(httpGetMocks, requestUrl);
                    if (mock) {
                        const error = createMockHttpError(mock);
                        if (error) {
                            callback(error);
                            return;
                        }

                        const response = createMockHttpResponse(mock);
                        httpLogs.push({
                            method: "GET",
                            url: requestUrl,
                            status: response.status,
                            mocked: true,
                        });
                        callback(null, response, response.body);
                        return;
                    }

                    performRealHttpRequest("GET", options, allowRealHttpHosts, httpLogs)
                        .then((response) => callback(null, response, response.body))
                        .catch((error) => callback(error));
                },
                post(options, callback) {
                    const requestUrl = String(options?.url ?? "");
                    const mock = resolveHttpMock(httpPostMocks, requestUrl);
                    if (mock) {
                        const error = createMockHttpError(mock);
                        if (error) {
                            callback(error);
                            return;
                        }

                        const response = createMockHttpResponse(mock);
                        httpLogs.push({
                            method: "POST",
                            url: requestUrl,
                            status: response.status,
                            mocked: true,
                        });
                        callback(null, response, response.body);
                        return;
                    }

                    performRealHttpRequest("POST", options, allowRealHttpHosts, httpLogs)
                        .then((response) => callback(null, response, response.body))
                        .catch((error) => callback(error));
                },
            },
            $notification: {
                post() {},
            },
            $done(result = {}) {
                clearTimeout(timeout);
                resolve({
                    result,
                    persistentData: persistentStore.data,
                    httpLogs,
                });
            },
            console: createTestConsole(verboseLogs),
            URL,
            setTimeout,
            clearTimeout,
            fetch,
            Headers,
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
            reject(error);
        }
    });
}

export { runScriptLive };
