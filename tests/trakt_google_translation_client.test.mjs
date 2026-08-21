import assert from "node:assert/strict";
import test from "node:test";
import { DEEPLX_TRANSLATE_API_URL, translateTextsWithDeeplx } from "../trakt_simplified_chinese/src/outbound/deeplx-translate-client.mjs";
import { GOOGLE_FALLBACK_API_KEY, GOOGLE_PA_TRANSLATE_URL, googleAuth, translateTextsWithGoogle } from "../trakt_simplified_chinese/src/outbound/google-translate-client.mjs";
import * as googleTranslationContext from "../trakt_simplified_chinese/src/shared/google-translation-context.mjs";
import { translateTextFieldTargets } from "../trakt_simplified_chinese/src/shared/google-translation-pipeline.mjs";
import * as translationEngine from "../trakt_simplified_chinese/src/shared/translation-engine.mjs";

// googleAuth 是模块级单例，缓存 key 20 分钟；每个用例前重置，避免用例间互相污染。
function resetGoogleAuth() {
    googleAuth._key = null;
    googleAuth._expiresAt = 0;
    googleAuth._inflight = null;
}

// 一个可被 Google 正则命中的公开 key（AIzaSy + 33 位）。
const MOCK_EXTRACTED_API_KEY = "AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz0123456";

// 模拟真实前端 JS：把 key 放在 translate-pa 请求头 X-goog-api-key 字段里（与线上一致）。
function createGoogleJsBodyWithKey(key = MOCK_EXTRACTED_API_KEY) {
    return `var a="x";path:"/v1/translateHtml",method:"POST",headers:{"X-goog-api-key":"${key}","Content-Type":"application/json+protobuf"};var b=1;`;
}

// 模拟前端 JS 里「另一个」AIzaSy key（display_language 接口用），不在 X-goog-api-key 字段下——
// 精准正则不应误提取它，应回退硬编码 key。
const MOCK_DISTRACTING_API_KEY = "AIzaSyBWDj0QJvVIx8XOhRegXX5_SrRWxhT5Hs4";
function createGoogleJsBodyWithDistractingKeyOnly() {
    return `var a="x";someObj.send({display_language:"zh",key:"${MOCK_DISTRACTING_API_KEY}"});var b=1;`;
}

// translate-pa 请求体为 [[texts, src, tgt], "te"]：
// texts 既可能是字符串数组（批量），也可能是单个字符串（超长切分后的单段）。
// 响应须与入参形状一致：数组入 -> [translatedArray]，字符串入 -> [translatedString]。
function buildGoogleResponse(body, mapText) {
    const inner = JSON.parse(String(body ?? "{}"))[0][0];
    if (Array.isArray(inner)) {
        return JSON.stringify([inner.map(mapText)]);
    }
    return JSON.stringify([mapText(inner)]);
}

function mockGoogleHttp(handlers) {
    const originalContext = globalThis.$ctx;
    globalThis.$ctx = {
        env: {
            http: {
                get(options) {
                    return Promise.resolve(handlers.get(options));
                },
                post(options) {
                    return Promise.resolve(handlers.post(options));
                },
            },
        },
    };
    return {
        restore() {
            globalThis.$ctx = originalContext;
        },
    };
}

test("谷歌客户端从前端 JS 提取 API key 并通过 translate-pa 翻译", async () => {
    resetGoogleAuth();
    let getCalled = false;
    let getUrl = null;
    const posts = [];

    const mock = mockGoogleHttp({
        get(options) {
            getCalled = true;
            getUrl = options.url;
            return { status: 200, body: createGoogleJsBodyWithKey() };
        },
        post(options) {
            posts.push(options);
            return { status: 200, body: buildGoogleResponse(options.body, (text) => `译:${text}`) };
        },
    });

    try {
        const translatedTexts = await translateTextsWithGoogle(["hello world"], "en");
        assert.deepEqual(translatedTexts, ["译:hello world"]);
        assert.equal(posts.length, 1);
        assert.equal(getCalled, true);
        assert.equal(
            getUrl,
            "https://translate.googleapis.com/_/translate_http/_/js/k=translate_http.tr.en_US.YusFYy3P_ro.O/am=AAg/d=1/exm=el_conf/ed=1/rs=AN8SPfq1Hb8iJRleQqQc8zhdzXmF9E56eQ/m=el_main",
        );
        assert.deepEqual(JSON.parse(posts[0].body), [[["hello world"], "EN", "ZH"], "te"]);
        assert.equal(posts[0].headers["X-goog-api-key"], MOCK_EXTRACTED_API_KEY);
        assert.equal(posts[0].url, GOOGLE_PA_TRANSLATE_URL);
    } finally {
        mock.restore();
    }
});

test("谷歌客户端在 JS 拉取失败时回退到硬编码 key", async () => {
    resetGoogleAuth();
    let getCalled = false;
    const posts = [];

    const mock = mockGoogleHttp({
        get() {
            getCalled = true;
            return { status: 500, body: "" };
        },
        post(options) {
            posts.push(options);
            return { status: 200, body: buildGoogleResponse(options.body, (text) => `译:${text}`) };
        },
    });

    try {
        const translatedTexts = await translateTextsWithGoogle(["hi"], "en");
        assert.deepEqual(translatedTexts, ["译:hi"]);
        assert.equal(getCalled, true);
        assert.equal(posts.length, 1);
        assert.equal(posts[0].headers["X-goog-api-key"], GOOGLE_FALLBACK_API_KEY);
        assert.equal(posts[0].headers["X-goog-api-key"], "AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520");
    } finally {
        mock.restore();
    }
});

test("谷歌客户端只提取 X-goog-api-key 字段下的 key，不误取其他 AIzaSy key", async () => {
    resetGoogleAuth();
    const posts = [];

    const mock = mockGoogleHttp({
        get() {
            // JS 200 但只含「干扰 key」（display_language 接口的 key，不在 X-goog-api-key 字段下）。
            return { status: 200, body: createGoogleJsBodyWithDistractingKeyOnly() };
        },
        post(options) {
            posts.push(options);
            return { status: 200, body: buildGoogleResponse(options.body, (text) => `译:${text}`) };
        },
    });

    try {
        const translatedTexts = await translateTextsWithGoogle(["hi"], "en");
        assert.deepEqual(translatedTexts, ["译:hi"]);
        assert.equal(posts.length, 1);
        // 精准正则未命中 X-goog-api-key 字段 → 回退硬编码 key，绝不误用干扰 key。
        assert.equal(posts[0].headers["X-goog-api-key"], GOOGLE_FALLBACK_API_KEY);
        assert.notEqual(posts[0].headers["X-goog-api-key"], MOCK_DISTRACTING_API_KEY);
    } finally {
        mock.restore();
    }
});

test("谷歌客户端按 6000 字符上限分批，每批请求不超过上限", async () => {
    resetGoogleAuth();
    const posts = [];

    const mock = mockGoogleHttp({
        get() {
            return { status: 200, body: createGoogleJsBodyWithKey() };
        },
        post(options) {
            posts.push(options);
            return { status: 200, body: buildGoogleResponse(options.body, (text) => `译:${text}`) };
        },
    });

    try {
        const texts = Array.from({ length: 70 }, () => "x".repeat(100));
        const translatedTexts = await translateTextsWithGoogle(texts, "en");
        assert.deepEqual(
            translatedTexts,
            texts.map((text) => `译:${text}`),
        );
        assert.equal(posts.length, 2);
        const requestTextLengths = posts.map((post) => {
            const inner = JSON.parse(post.body)[0][0];
            const textsInBatch = Array.isArray(inner) ? inner : [inner];
            return textsInBatch.reduce((sum, text) => sum + text.length, 0);
        });
        assert.ok(requestTextLengths.every((length) => length <= 6000));
        assert.deepEqual(requestTextLengths, [6000, 1000]);
    } finally {
        mock.restore();
    }
});

test("谷歌客户端在 429 限流时按重试次数退避并重试", async () => {
    resetGoogleAuth();
    const posts = [];

    const mock = mockGoogleHttp({
        get() {
            return { status: 200, body: createGoogleJsBodyWithKey() };
        },
        post(options) {
            posts.push(options);
            if (posts.length === 1) {
                return { status: 429, body: '{"error":"rate limited"}' };
            }
            return { status: 200, body: buildGoogleResponse(options.body, (text) => `译:${text}`) };
        },
    });

    try {
        const translatedTexts = await translateTextsWithGoogle(["hi"], "en");
        assert.deepEqual(translatedTexts, ["译:hi"]);
        assert.equal(posts.length, 2);
    } finally {
        mock.restore();
    }
});

test("谷歌客户端把超过 6000 字符的单条文本切分为多段并拼回", async () => {
    resetGoogleAuth();
    const posts = [];

    const mock = mockGoogleHttp({
        get() {
            return { status: 200, body: createGoogleJsBodyWithKey() };
        },
        post(options) {
            posts.push(options);
            return { status: 200, body: buildGoogleResponse(options.body, (text) => `[${text.length}]`) };
        },
    });

    try {
        const longText = "A".repeat(12000);
        const translatedTexts = await translateTextsWithGoogle([longText], "en");
        const requestLengths = posts.map((post) => {
            const inner = JSON.parse(post.body)[0][0];
            return Array.isArray(inner) ? inner[0].length : inner.length;
        });
        assert.ok(posts.length > 1);
        assert.ok(requestLengths.every((length) => length <= 6000));
        assert.equal(translatedTexts[0], requestLengths.map((length) => `[${length}]`).join(""));
    } finally {
        mock.restore();
    }
});

test("谷歌客户端解析 translate-pa 的数组响应", async () => {
    resetGoogleAuth();
    const posts = [];

    const mock = mockGoogleHttp({
        get() {
            return { status: 200, body: createGoogleJsBodyWithKey() };
        },
        post(options) {
            posts.push(options);
            return { status: 200, body: '[["你好","世界"]]' };
        },
    });

    try {
        const translatedTexts = await translateTextsWithGoogle(["hello", "world"], "en");
        assert.deepEqual(translatedTexts, ["你好", "世界"]);
        assert.equal(posts.length, 1);
    } finally {
        mock.restore();
    }
});

test("pipeline 在 translationEngine=google 时走真实谷歌客户端并剥离上下文头", async () => {
    resetGoogleAuth();
    const appliedTranslations = [];
    const posts = [];

    const mock = mockGoogleHttp({
        get() {
            return { status: 200, body: createGoogleJsBodyWithKey() };
        },
        post(options) {
            posts.push(options);
            return {
                status: 200,
                body: buildGoogleResponse(options.body, (text) => {
                    if (text === "hello") {
                        return "你好";
                    }
                    if (text.includes("Overall enjoyable")) {
                        return text.replace("Overall enjoyable", "整体观感不错");
                    }
                    return text;
                }),
            };
        },
    });

    try {
        const targets = [
            {
                sourceLanguage: "en",
                sourceText: "hello",
                applyTranslation(translatedText) {
                    appliedTranslations.push(translatedText);
                },
            },
            {
                sourceLanguage: "en",
                sourceText: googleTranslationContext.buildSourceText("Overall enjoyable", "Original Movie (中文电影)"),
                applyTranslation(translatedText) {
                    appliedTranslations.push(translatedText);
                },
            },
        ];

        const result = await translateTextFieldTargets(targets, { translationEngine: "google" });
        assert.equal(result.translatedCount, 2);
        assert.deepEqual(appliedTranslations, ["你好", "整体观感不错"]);
        assert.ok(posts.length >= 1);
        assert.equal(posts[0].url, GOOGLE_PA_TRANSLATE_URL);
    } finally {
        mock.restore();
    }
});

test("谷歌客户端用 HTML 注释携带上下文并按注释边界剥离", async () => {
    resetGoogleAuth();
    const posts = [];

    const mock = mockGoogleHttp({
        get() {
            return { status: 200, body: createGoogleJsBodyWithKey() };
        },
        post(options) {
            posts.push(options);
            return {
                status: 200,
                body: buildGoogleResponse(options.body, (text) => {
                    // 模拟真实 Google：注释原样保留在开头（内容不翻译），仅翻译注释后的正文。
                    const match = String(text).match(/^(<!--[\s\S]*?-->)\s*([\s\S]*)$/);
                    if (match) {
                        const body = match[2];
                        const translatedBody = body.includes("Overall enjoyable") ? "整体观感不错" : body.includes("Worth watching") ? "值得一看" : `译:${body}`;
                        return `${match[1]}${translatedBody}`;
                    }
                    return `译:${text}`;
                }),
            };
        },
    });

    try {
        const translatedTexts = await translateTextsWithGoogle(
            [
                googleTranslationContext.buildSourceText("Overall enjoyable", "Original Movie (中文电影)"),
                googleTranslationContext.buildSourceText("Worth watching", "Another Show (另一部剧)"),
            ],
            "en",
        );
        assert.deepEqual(translatedTexts, ["整体观感不错", "值得一看"]);
        assert.equal(posts.length, 1);
        // 验证请求确实带上了 HTML 注释（而非 notranslate span）。
        const firstInner = JSON.parse(posts[0].body)[0][0];
        assert.ok(Array.isArray(firstInner));
        assert.ok(firstInner[0].startsWith("<!-- "));
        assert.ok(firstInner[1].startsWith("<!-- "));
    } finally {
        mock.restore();
    }
});

test("谷歌客户端正文引用片名时注释不被复用到句中", async () => {
    // 复现用户 curl 实测：notranslate span 方案下，正文里引用 "The Night Of" 会让 Google 把 span
    // 复用到句中（"《 <span>…</span> 第一集"），全局移除后留下残缺书名号+丢主语。
    // 改用 HTML 注释后，注释固定在开头不被复用，正文由 Google 自带片名知识正确译出《罪夜之奔》。
    resetGoogleAuth();

    const mock = mockGoogleHttp({
        get() {
            return { status: 200, body: createGoogleJsBodyWithKey() };
        },
        post(options) {
            return {
                status: 200,
                body: buildGoogleResponse(options.body, (text) => {
                    const match = String(text).match(/^(<!--[\s\S]*?-->)\s*([\s\S]*)$/);
                    if (match) {
                        return `${match[1]}我看了HBO提前放映的《罪夜之奔》第一集。`;
                    }
                    return text;
                }),
            };
        },
    });

    try {
        const context = "The Night Of (罪夜之奔)";
        const translatedTexts = await translateTextsWithGoogle(
            [googleTranslationContext.buildSourceText('I watched the 1st episode of "The Night Of" when HBO previewed it early.', context)],
            "en",
        );
        assert.equal(translatedTexts[0], "我看了HBO提前放映的《罪夜之奔》第一集。");
        assert.ok(!translatedTexts[0].includes("<!--"));
        assert.ok(!translatedTexts[0].includes("The Night Of"));
        assert.ok(!translatedTexts[0].includes("罪夜之奔)")); // 上下文括号形式不残留
    } finally {
        mock.restore();
    }
});

test("谷歌客户端在注释丢失时退回本地化名后缀回退剥离上下文", async () => {
    resetGoogleAuth();
    const posts = [];

    const mock = mockGoogleHttp({
        get() {
            return { status: 200, body: createGoogleJsBodyWithKey() };
        },
        post(options) {
            posts.push(options);
            return {
                status: 200,
                body: buildGoogleResponse(options.body, () => {
                    // 模拟注释丢失且 Google 把上下文翻译并保留换行（全角括号）。
                    return "原版电影（中文电影）\n整体观感不错";
                }),
            };
        },
    });

    try {
        const translatedTexts = await translateTextsWithGoogle([googleTranslationContext.buildSourceText("Overall enjoyable", "Original Movie (中文电影)")], "en");
        assert.deepEqual(translatedTexts, ["整体观感不错"]);
        assert.equal(posts.length, 1);
    } finally {
        mock.restore();
    }
});

test("谷歌客户端超长带上下文文本逐段剥离注释前缀后拼回", async () => {
    resetGoogleAuth();
    const posts = [];

    const mock = mockGoogleHttp({
        get() {
            return { status: 200, body: createGoogleJsBodyWithKey() };
        },
        post(options) {
            posts.push(options);
            return {
                status: 200,
                body: buildGoogleResponse(options.body, (text) => {
                    // 每段请求都带 HTML 注释上下文，响应原样保留注释 + 段译文。
                    const match = String(text).match(/^(<!--[\s\S]*?-->)\s*([\s\S]*)$/);
                    if (match) {
                        return `${match[1]}[${match[2].length}]`;
                    }
                    return `[${text.length}]`;
                }),
            };
        },
    });

    try {
        const longText = googleTranslationContext.buildSourceText(`${"A".repeat(6000)}.${"B".repeat(6000)}.`, "Original Movie (中文电影)");
        const translatedTexts = await translateTextsWithGoogle([longText], "en");
        const expected = posts
            .map((post) => {
                const inner = JSON.parse(post.body)[0][0];
                const text = Array.isArray(inner) ? inner[0] : inner;
                const match = String(text).match(/^<!--[\s\S]*?-->\s*([\s\S]*)$/);
                return match ? `[${match[1].length}]` : "";
            })
            .join("");
        assert.ok(posts.length > 1);
        assert.notEqual(translatedTexts[0], "");
        assert.equal(translatedTexts[0], expected);
        // 关键：拼回结果不应残留任何注释或上下文。
        assert.ok(!translatedTexts[0].includes("<!--"));
        assert.ok(!translatedTexts[0].includes("中文电影"));
    } finally {
        mock.restore();
    }
});

test("谷歌客户端在 key 失效(401)时清缓存重新抓取并自愈", async () => {
    resetGoogleAuth();
    const rotatedKey = "AIzaSyZyXwVuTsRqPoNmLkJiHgFeDcBa9876543";
    let getCallCount = 0;
    const posts = [];

    const mock = mockGoogleHttp({
        get() {
            getCallCount += 1;
            return { status: 200, body: createGoogleJsBodyWithKey(getCallCount === 1 ? MOCK_EXTRACTED_API_KEY : rotatedKey) };
        },
        post(options) {
            posts.push(options);
            if (posts.length === 1) {
                return { status: 401, body: '{"error":"invalid api key"}' };
            }
            return { status: 200, body: buildGoogleResponse(options.body, (text) => `译:${text}`) };
        },
    });

    try {
        const translatedTexts = await translateTextsWithGoogle(["hi"], "en");
        assert.deepEqual(translatedTexts, ["译:hi"]);
        assert.equal(getCallCount, 2);
        assert.equal(posts.length, 2);
        assert.equal(posts[0].headers["X-goog-api-key"], MOCK_EXTRACTED_API_KEY);
        assert.equal(posts[1].headers["X-goog-api-key"], rotatedKey);
    } finally {
        mock.restore();
    }
});

test("谷歌客户端在 key 持续失效时按上限终止而不无限重试", async () => {
    resetGoogleAuth();
    const rotatedKey = "AIzaSyZyXwVuTsRqPoNmLkJiHgFeDcBa9876543";
    let getCallCount = 0;
    const posts = [];

    const mock = mockGoogleHttp({
        get() {
            getCallCount += 1;
            return { status: 200, body: createGoogleJsBodyWithKey(getCallCount === 1 ? MOCK_EXTRACTED_API_KEY : rotatedKey) };
        },
        post(options) {
            posts.push(options);
            return { status: 403, body: '{"error":"forbidden"}' };
        },
    });

    try {
        await assert.rejects(translateTextsWithGoogle(["hi"], "en"));
        // 一次原始尝试 + 一次 key 刷新后的额外重试，不会无限循环。
        assert.equal(posts.length, 2);
        assert.equal(getCallCount, 2);
        assert.equal(posts[0].headers["X-goog-api-key"], MOCK_EXTRACTED_API_KEY);
        assert.equal(posts[1].headers["X-goog-api-key"], rotatedKey);
        // 失效后缓存的已是重新抓取的 key，下一次调用会立即用它再验证一次。
        assert.equal(googleAuth._key, rotatedKey);
    } finally {
        mock.restore();
    }
});

test("谷歌客户端超长文本单段失败时空段兜底保留其余译文", async () => {
    resetGoogleAuth();
    const posts = [];

    const mock = mockGoogleHttp({
        get() {
            return { status: 200, body: createGoogleJsBodyWithKey() };
        },
        post(options) {
            posts.push(options);
            const inner = JSON.parse(options.body)[0][0];
            const text = Array.isArray(inner) ? inner[0] : inner;
            if (text.includes("FAILSEG")) {
                // 非法 JSON 模拟该段翻译失败（无 statusCode，不触发重试）。
                return { status: 200, body: "not-json" };
            }
            return { status: 200, body: JSON.stringify([`[${text.length}]`]) };
        },
    });

    try {
        const longText = `${"A".repeat(5000)}FAILSEG${"A".repeat(5000)}.${"B".repeat(3000)}.`;
        const translatedTexts = await translateTextsWithGoogle([longText], "en");
        const expected = posts
            .map((post) => {
                const inner = JSON.parse(post.body)[0][0];
                const text = Array.isArray(inner) ? inner[0] : inner;
                return text.includes("FAILSEG") ? "" : `[${text.length}]`;
            })
            .join("");
        assert.ok(posts.length > 2);
        assert.notEqual(expected, "");
        assert.notEqual(translatedTexts[0], "");
        assert.equal(translatedTexts[0], expected);
    } finally {
        mock.restore();
    }
});

test("translation-engine 统一收敛引擎选择逻辑", () => {
    const originalContext = globalThis.$ctx;
    try {
        globalThis.$ctx = { argument: { translationEngine: "DeepLX" } };
        // 显式传参优先并归一（含中文标签与大小写）。
        assert.equal(translationEngine.resolveTranslationEngine("谷歌翻译"), "google");
        assert.equal(translationEngine.resolveTranslationEngine("DeepLX"), "deeplx");
        assert.equal(translationEngine.resolveTranslationEngine("关闭"), "off");
        // 缺省时回退到脚本参数并归一。
        assert.equal(translationEngine.resolveTranslationEngine(undefined), "deeplx");
        assert.equal(translationEngine.isTranslationEnabled(undefined), true);
        // 客户端选择与启用判断共用同一解析结果。
        assert.equal(translationEngine.selectTranslateTexts(undefined), translateTextsWithDeeplx);
        assert.equal(translationEngine.selectTranslateTexts("谷歌翻译"), translateTextsWithGoogle);

        globalThis.$ctx = undefined;
        assert.equal(translationEngine.resolveTranslationEngine(""), "google");
        assert.equal(translationEngine.isTranslationEnabled("off"), false);
        assert.equal(translationEngine.isTranslationEnabled("关闭"), false);
        assert.equal(translationEngine.selectTranslateTexts(""), translateTextsWithGoogle);
    } finally {
        globalThis.$ctx = originalContext;
    }
});

test("谷歌引擎不做《》补全与人名 - 替换·的 DeepLX 专属后处理", async () => {
    resetGoogleAuth();

    const mock = mockGoogleHttp({
        get() {
            return { status: 200, body: createGoogleJsBodyWithKey() };
        },
        post(options) {
            return {
                status: 200,
                body: buildGoogleResponse(options.body, (text) => {
                    // 模拟 Google 原生输出：人名用 - 连接、标题残缺《》——这些在 DeepLX 路径会被修复，
                    // 但 Google 路径应原样保留。
                    if (text === "Tom Hanks") {
                        return "汤姆-汉克斯";
                    }
                    if (text === "Great movie") {
                        return "沙丘》是一部好电影";
                    }
                    return text;
                }),
            };
        },
    });

    try {
        const translatedTexts = await translateTextsWithGoogle(["Tom Hanks", "Great movie"], "en");
        assert.equal(translatedTexts[0], "汤姆-汉克斯"); // 不替换为 ·
        assert.equal(translatedTexts[1], "沙丘》是一部好电影"); // 不补全《
    } finally {
        mock.restore();
    }
});

test("pipeline 在谷歌引擎最终失败时回退 DeepLX", async () => {
    resetGoogleAuth();
    const originalContext = globalThis.$ctx;
    const posts = [];

    globalThis.$ctx = {
        env: {
            http: {
                get() {
                    return Promise.resolve({ status: 200, body: createGoogleJsBodyWithKey() });
                },
                post(options) {
                    posts.push(options);
                    if (options.url.includes("translate-pa.googleapis.com")) {
                        // 400 非临时失败，Google 客户端立即放弃 → 触发回退。
                        return Promise.resolve({ status: 400, body: '{"error":"bad"}' });
                    }
                    // DeepLX 成功
                    const payload = JSON.parse(options.body);
                    return Promise.resolve({ status: 200, body: JSON.stringify({ data: `回退:${payload.text}` }) });
                },
            },
        },
    };

    try {
        const applied = [];
        const targets = [
            {
                sourceLanguage: "en",
                sourceText: "hello",
                applyTranslation(translatedText) {
                    applied.push(translatedText);
                },
            },
        ];
        const result = await translateTextFieldTargets(targets, { translationEngine: "google" });
        assert.equal(result.translatedCount, 1);
        assert.deepEqual(applied, ["回退:hello"]);
        // 谷歌被尝试过、DeepLX 回退也被调用过。
        assert.ok(posts.some((post) => post.url.includes("translate-pa.googleapis.com")));
        assert.ok(posts.some((post) => post.url === DEEPLX_TRANSLATE_API_URL));
    } finally {
        globalThis.$ctx = originalContext;
    }
});

test("pipeline 在谷歌超长文本全部分段失败时回退 DeepLX", async () => {
    resetGoogleAuth();
    const originalContext = globalThis.$ctx;
    const posts = [];

    globalThis.$ctx = {
        env: {
            http: {
                get() {
                    return Promise.resolve({ status: 200, body: createGoogleJsBodyWithKey() });
                },
                post(options) {
                    posts.push(options);
                    if (options.url.includes("translate-pa.googleapis.com")) {
                        return Promise.resolve({ status: 400, body: '{"error":"bad"}' });
                    }
                    const payload = JSON.parse(options.body);
                    return Promise.resolve({ status: 200, body: JSON.stringify({ data: `回退:${payload.text.length}` }) });
                },
            },
        },
    };

    try {
        const longText = `${"A".repeat(12000)}.`;
        const applied = [];
        const result = await translateTextFieldTargets(
            [
                {
                    sourceLanguage: "en",
                    sourceText: longText,
                    applyTranslation(translatedText) {
                        applied.push(translatedText);
                    },
                },
            ],
            { translationEngine: "google" },
        );
        assert.equal(result.translatedCount, 1);
        // 路歌对超长文本切了多段、每段都失败；DeepLX 回退成功翻译整条。
        assert.ok(posts.filter((post) => post.url.includes("translate-pa.googleapis.com")).length > 1);
        assert.ok(posts.some((post) => post.url === DEEPLX_TRANSLATE_API_URL));
        // DeepLX 回退成功产出非空译文（DeepLX 自身也可能切分，此处只验证回退发生且成功）。
        assert.ok(applied[0].length > 0);
        assert.ok(applied[0].startsWith("回退:"));
    } finally {
        globalThis.$ctx = originalContext;
    }
});

test("pipeline 在谷歌与 DeepLX 都失败时记录失败且不翻译", async () => {
    resetGoogleAuth();
    const originalContext = globalThis.$ctx;
    let logFailureCalls = 0;

    globalThis.$ctx = {
        env: {
            http: {
                get() {
                    return Promise.resolve({ status: 200, body: createGoogleJsBodyWithKey() });
                },
                post() {
                    // 400 非临时失败，两个引擎都立即放弃，不触发重试拖慢测试。
                    return Promise.resolve({ status: 400, body: '{"error":"bad"}' });
                },
            },
        },
    };

    try {
        const applied = [];
        const result = await translateTextFieldTargets(
            [
                {
                    sourceLanguage: "en",
                    sourceText: "hello",
                    applyTranslation(translatedText) {
                        applied.push(translatedText);
                    },
                },
            ],
            {
                translationEngine: "google",
                logFailure() {
                    logFailureCalls += 1;
                },
            },
        );
        assert.equal(result.translatedCount, 0);
        assert.deepEqual(applied, []);
        assert.ok(logFailureCalls >= 1);
    } finally {
        globalThis.$ctx = originalContext;
    }
});
