import assert from "node:assert/strict";
import test from "node:test";

import { translateTextsWithGoogle } from "../trakt_simplified_chinese/src/outbound/google-translate-client.mjs";
import * as googleTranslationContext from "../trakt_simplified_chinese/src/shared/google-translation-context.mjs";
import { translateTextFieldTargets } from "../trakt_simplified_chinese/src/shared/google-translation-pipeline.mjs";

const DEEPLX_TRANSLATE_URL = "https://deeplx.demojameson.de5.net/deepl";

function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return { promise, resolve, reject };
}

function joinDeepLxTranslatedTexts(translatedTexts) {
    return translatedTexts.map((translatedText, index) => (index === 0 ? translatedText : `\n¶${index}¶\n${translatedText}`)).join("");
}

function createDeepLxPayload(texts) {
    return JSON.stringify({
        data: joinDeepLxTranslatedTexts(texts.map((text) => `译:${text}`)),
    });
}

function getRequestTexts(body) {
    const payload = JSON.parse(String(body ?? "{}"));
    return String(payload.text ?? "").split(/\n¶\d+¶\n/g);
}

function getRequestText(body) {
    const payload = JSON.parse(String(body ?? "{}"));
    return String(payload.text ?? "");
}

test("DeepLX 兼容层超过 5000 字符上限时最多并行 20 个分批请求", async () => {
    const originalContext = globalThis.$ctx;
    const deferredResponses = [];
    const posts = [];
    let activeRequests = 0;
    let maxActiveRequests = 0;

    globalThis.$ctx = {
        env: {
            http: {
                post(options) {
                    const deferred = createDeferred();
                    deferredResponses.push(deferred);
                    posts.push(options);
                    activeRequests += 1;
                    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
                    return deferred.promise.finally(() => {
                        activeRequests -= 1;
                    });
                },
            },
        },
    };

    try {
        const texts = Array.from({ length: 1500 }, (_, index) => `${String(index).padStart(4, "0")}-${"x".repeat(80)}`);
        const translationPromise = translateTextsWithGoogle(texts, "en");
        await Promise.resolve();

        assert.equal(posts.length, 20);
        assert.equal(maxActiveRequests, 20);

        let resolvedCount = 0;
        while (resolvedCount < posts.length) {
            const post = posts[resolvedCount];
            assert.equal(post.url, DEEPLX_TRANSLATE_URL);
            const payload = JSON.parse(post.body);
            assert.ok(String(payload.text ?? "").length <= 5000);
            deferredResponses[resolvedCount].resolve({ status: 200, body: createDeepLxPayload(getRequestTexts(post.body)) });
            resolvedCount += 1;
            await Promise.resolve();
        }

        assert.equal(maxActiveRequests, 20);

        const translatedTexts = await translationPromise;
        assert.equal(translatedTexts.length, 1500);
        assert.equal(translatedTexts[0], `译:${texts[0]}`);
        assert.equal(translatedTexts[1499], `译:${texts[1499]}`);
    } finally {
        globalThis.$ctx = originalContext;
    }
});

test("DeepLX 兼容层在拼接分隔符丢失时回退逐条翻译", async () => {
    const originalContext = globalThis.$ctx;
    const posts = [];

    globalThis.$ctx = {
        env: {
            http: {
                post(options) {
                    posts.push(options);
                    if (posts.length === 1) {
                        return Promise.resolve({ status: 200, body: JSON.stringify({ data: "合并后没有分隔符" }) });
                    }

                    const [text] = getRequestTexts(options.body);
                    return Promise.resolve({ status: 200, body: JSON.stringify({ data: `逐条:${text}` }) });
                },
            },
        },
    };

    try {
        const translatedTexts = await translateTextsWithGoogle(["hello", "world"], "en");
        assert.deepEqual(translatedTexts, ["逐条:hello", "逐条:world"]);
        assert.equal(posts.length, 3);
    } finally {
        globalThis.$ctx = originalContext;
    }
});

test("DeepLX 兼容层会切分超长单条文本并拼回结果", async () => {
    const originalContext = globalThis.$ctx;
    const posts = [];

    globalThis.$ctx = {
        env: {
            http: {
                post(options) {
                    posts.push(options);
                    const [text] = getRequestTexts(options.body);
                    return Promise.resolve({ status: 200, body: JSON.stringify({ data: `[${text.length}]` }) });
                },
            },
        },
    };

    try {
        const longText = `${"A".repeat(3700)}.${"B".repeat(3700)}.`;
        const translatedTexts = await translateTextsWithGoogle([longText], "en");
        const requestLengths = posts.map((post) => getRequestTexts(post.body)[0].length);
        assert.deepEqual(requestLengths, [3701, 3701]);
        assert.equal(translatedTexts[0], requestLengths.map((length) => `[${length}]`).join(""));
    } finally {
        globalThis.$ctx = originalContext;
    }
});

test("DeepLX 兼容层切分带上下文的超长单条文本时会把上下文头计入 5000 字符限制", async () => {
    const originalContext = globalThis.$ctx;
    const posts = [];

    globalThis.$ctx = {
        env: {
            http: {
                post(options) {
                    posts.push(options);
                    return Promise.resolve({ status: 200, body: JSON.stringify({ data: `[${getRequestText(options.body).length}]` }) });
                },
            },
        },
    };

    try {
        const contextLine = `${"Context ".repeat(80)}(中文片名)`;
        const translatedTexts = await translateTextsWithGoogle([googleTranslationContext.buildSourceText("A".repeat(9000), contextLine)], "en");
        assert.ok(posts.length > 1);
        assert.ok(posts.every((post) => getRequestText(post.body).length <= 5000));
        assert.equal(translatedTexts[0], posts.map((post) => `[${getRequestText(post.body).length}]`).join(""));
    } finally {
        globalThis.$ctx = originalContext;
    }
});

test("DeepLX 兼容层切分多行长文本时会尽量合并到接近上限", async () => {
    const originalContext = globalThis.$ctx;
    const posts = [];

    globalThis.$ctx = {
        env: {
            http: {
                post(options) {
                    posts.push(options);
                    const [text] = getRequestTexts(options.body);
                    return Promise.resolve({ status: 200, body: JSON.stringify({ data: `[${text.length}]` }) });
                },
            },
        },
    };

    try {
        const longListText = Array.from({ length: 300 }, (_, index) => `${String(index + 1).padStart(3, "0")} - Miss You, Love You`).join("\r\n");
        const translatedTexts = await translateTextsWithGoogle([longListText], "en");
        const requestLengths = posts.map((post) => getRequestTexts(post.body)[0].length);
        assert.equal(posts.length, 2);
        assert.ok(requestLengths.every((length) => length <= 5000));
        assert.ok(requestLengths.every((length) => length >= 2500));
        assert.equal(translatedTexts[0], requestLengths.map((length) => `[${length}]`).join(""));
    } finally {
        globalThis.$ctx = originalContext;
    }
});

test("DeepLX 兼容层遇到临时失败时会重试", async () => {
    const originalContext = globalThis.$ctx;
    const posts = [];

    globalThis.$ctx = {
        env: {
            http: {
                post(options) {
                    posts.push(options);
                    if (posts.length === 1) {
                        return Promise.resolve({ status: 429, body: '{"error":"rate limited"}' });
                    }
                    return Promise.resolve({ status: 200, body: createDeepLxPayload(getRequestTexts(options.body)) });
                },
            },
        },
    };

    try {
        const translatedTexts = await translateTextsWithGoogle(["hello"], "en");
        assert.deepEqual(translatedTexts, ["译:hello"]);
        assert.equal(posts.length, 2);
    } finally {
        globalThis.$ctx = originalContext;
    }
});

test("DeepLX 兼容层会把相同上下文去重到请求头", async () => {
    const originalContext = globalThis.$ctx;
    const posts = [];

    globalThis.$ctx = {
        env: {
            http: {
                post(options) {
                    posts.push(options);
                    return Promise.resolve({
                        status: 200,
                        body: JSON.stringify({
                            data: "§原片 (中文片)§整体观感不错\n¶1¶\n详细分析",
                        }),
                    });
                },
            },
        },
    };

    try {
        const contextLine = "Original Movie (中文电影)";
        const translatedTexts = await translateTextsWithGoogle(
            [googleTranslationContext.buildSourceText("Overall enjoyable", contextLine), googleTranslationContext.buildSourceText("Detailed analysis", contextLine)],
            "en",
        );
        assert.equal(posts.length, 1);
        assert.equal(getRequestText(posts[0].body), "§Original Movie (中文电影)§Overall enjoyable\n¶1¶\nDetailed analysis");
        assert.deepEqual(translatedTexts, ["整体观感不错", "详细分析"]);
    } finally {
        globalThis.$ctx = originalContext;
    }
});

test("DeepLX 兼容层会把不同上下文放入同一个请求头且保持正文顺序", async () => {
    const originalContext = globalThis.$ctx;
    const posts = [];

    globalThis.$ctx = {
        env: {
            http: {
                post(options) {
                    posts.push(options);
                    return Promise.resolve({
                        status: 200,
                        body: JSON.stringify({
                            data: "整体观感不错\n¶1¶\n节奏较慢\n¶2¶\n详细分析",
                        }),
                    });
                },
            },
        },
    };

    try {
        const translatedTexts = await translateTextsWithGoogle(
            [
                googleTranslationContext.buildSourceText("Overall enjoyable", "The Housemaid (家弑服务)"),
                googleTranslationContext.buildSourceText("Slow pacing", "Another Movie (另一部电影)"),
                googleTranslationContext.buildSourceText("Detailed analysis", "The Housemaid (家弑服务)"),
            ],
            "en",
        );
        assert.equal(posts.length, 1);
        assert.equal(getRequestText(posts[0].body), "§The Housemaid (家弑服务)\nAnother Movie (另一部电影)§Overall enjoyable\n¶1¶\nSlow pacing\n¶2¶\nDetailed analysis");
        assert.deepEqual(translatedTexts, ["整体观感不错", "节奏较慢", "详细分析"]);
    } finally {
        globalThis.$ctx = originalContext;
    }
});

test("DeepLX 兼容层会清理统一上下文头被去掉边界符后的裸上下文残留", async () => {
    const originalContext = globalThis.$ctx;
    const posts = [];

    globalThis.$ctx = {
        env: {
            http: {
                post(options) {
                    posts.push(options);
                    return Promise.resolve({
                        status: 200,
                        body: JSON.stringify({
                            data: "Original Movie (中文电影)\n剧情\n¶1¶\n整体观感不错",
                        }),
                    });
                },
            },
        },
    };

    try {
        const translatedTexts = await translateTextsWithGoogle(["Story", googleTranslationContext.buildSourceText("Overall enjoyable", "Original Movie (中文电影)")], "en");
        assert.equal(posts.length, 1);
        assert.equal(getRequestText(posts[0].body), "§Original Movie (中文电影)§Story\n¶1¶\nOverall enjoyable");
        assert.deepEqual(translatedTexts, ["剧情", "整体观感不错"]);
    } finally {
        globalThis.$ctx = originalContext;
    }
});

test("DeepLX 兼容层计算 5000 字符限制时包含上下文头", async () => {
    const originalContext = globalThis.$ctx;
    const posts = [];

    globalThis.$ctx = {
        env: {
            http: {
                post(options) {
                    posts.push(options);
                    return Promise.resolve({ status: 200, body: createDeepLxPayload(getRequestTexts(options.body)) });
                },
            },
        },
    };

    try {
        const contextLine = `${"Context ".repeat(120)}(中文片名)`;
        const translatedTexts = await translateTextsWithGoogle(
            [googleTranslationContext.buildSourceText("A".repeat(2300), contextLine), googleTranslationContext.buildSourceText("B".repeat(2300), contextLine)],
            "en",
        );
        assert.equal(posts.length, 2);
        assert.ok(posts.every((post) => getRequestText(post.body).length <= 5000));
        assert.equal(translatedTexts.length, 2);
    } finally {
        globalThis.$ctx = originalContext;
    }
});

test("DeepLX 兼容层会在无提示词时修复开头残缺书名号", async () => {
    const originalContext = globalThis.$ctx;

    globalThis.$ctx = {
        env: {
            http: {
                post() {
                    return Promise.resolve({ status: 200, body: JSON.stringify({ data: "家弑服务》是一部心理惊悚片。" }) });
                },
            },
        },
    };

    try {
        const translatedTexts = await translateTextsWithGoogle(["The Housemaid is a psychological thriller."], "en");
        assert.deepEqual(translatedTexts, ["《家弑服务》是一部心理惊悚片。"]);
    } finally {
        globalThis.$ctx = originalContext;
    }
});

test("Google 翻译 pipeline 对不同源语言分组并行请求", async () => {
    const deferredByLanguage = {
        en: createDeferred(),
        fr: createDeferred(),
    };
    const startedLanguages = [];
    const appliedTranslations = [];

    const targets = [
        {
            sourceLanguage: "en",
            sourceText: "hello",
            applyTranslation(translatedText) {
                appliedTranslations.push(translatedText);
            },
        },
        {
            sourceLanguage: "fr",
            sourceText: "bonjour",
            applyTranslation(translatedText) {
                appliedTranslations.push(translatedText);
            },
        },
    ];

    const resultPromise = translateTextFieldTargets(targets, {
        translateTexts(sourceTexts, language) {
            startedLanguages.push(language);
            return deferredByLanguage[language].promise.then(() => sourceTexts.map((text) => `${language}:${text}`));
        },
    });
    await Promise.resolve();

    assert.deepEqual(startedLanguages, ["en", "fr"]);

    deferredByLanguage.fr.resolve();
    deferredByLanguage.en.resolve();

    const result = await resultPromise;
    assert.deepEqual(appliedTranslations, ["en:hello", "fr:bonjour"]);
    assert.equal(result.translatedCount, 2);
});
