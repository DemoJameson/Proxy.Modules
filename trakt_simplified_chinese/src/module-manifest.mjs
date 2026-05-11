const REPOSITORY_URL = "https://github.com/DemoJameson/Proxy.Modules";
const RAW_BASE_URL = "https://raw.githubusercontent.com/DemoJameson/Proxy.Modules/main";
const TRAKT_MODULE_PATH = "trakt_simplified_chinese";
const TRAKT_SCRIPT_FILE = "trakt_simplified_chinese.js";
const TRAKT_SCRIPT_TITLE = "Trakt增强";
const SHORTCUT_URL = "https://www.icloud.com/shortcuts/9238bef05b144159a4351c2fa9e2570d";
const DEFAULT_BACKEND_BASE_URL = "https://proxy-modules.demojameson.de5.net";

const metadata = {
    name: "Trakt 增强",
    description:
        "Trakt App 各页面从英文改为简体中文，支持中文标题、简介和海报；历史页面剧集类别的已观看记录按电视剧合并；Trakt 和 SofaTime 的影片详情页添加 EplayerX、Forward、Infuse 跳转按钮；部分兼容其它使用了 Trakt API 的应用。",
    icon: `${RAW_BASE_URL}/${TRAKT_MODULE_PATH}/images/trakt.webp`,
    homepage: REPOSITORY_URL,
    openUrl: "https://apps.apple.com/app/id1514873602",
    author: "DemoJameson",
    repositoryUrl: REPOSITORY_URL,
    moduleRepositoryUrl: `${REPOSITORY_URL}/tree/main/${TRAKT_MODULE_PATH}`,
    rawBaseUrl: RAW_BASE_URL,
    modulePath: TRAKT_MODULE_PATH,
};

const BOXJS_CONFIG_KEY = "dj_trakt_boxjs_configs";

const argumentFields = [
    {
        key: "posterImageMode",
        defaultValue: "original",
        type: "select",
        options: ["原片语言", "中文", "原图"],
        optionValues: ["original", "chinese", "default"],
        tag: "海报语言",
        desc: "原片语言使用 TMDb 影片原始语言图片；中文使用 TMDb 中文图片；原图保留 Trakt 原图",
    },
    {
        key: "historyEpisodesMergedByShow",
        defaultValue: true,
        type: "boolean",
        tag: "历史剧集按电视剧合并",
        desc: "启用后会将历史页面电视剧类别的观看记录按电视剧合并",
    },
    {
        key: "googleTranslationEnabled",
        defaultValue: true,
        type: "boolean",
        tag: "用谷歌翻译部分文本",
        desc: "启用后会翻译评论、社区情绪、冷知识、演员、片单等谷歌翻译场景",
    },
    {
        key: "characterTranslationEnabled",
        defaultValue: true,
        type: "boolean",
        tag: "用豆瓣翻译角色名",
        desc: "启用后会用豆瓣翻译角色名",
    },
    {
        key: "eplayerxEnabled",
        defaultValue: true,
        type: "boolean",
        tag: "EplayerX 跳转按钮",
        desc: "启用后在 Trakt 和 SofaTime 中添加 EplayerX 跳转按钮",
    },
    {
        key: "forwardEnabled",
        defaultValue: true,
        type: "boolean",
        tag: "Forward 跳转按钮",
        desc: "启用后在 Trakt 和 SofaTime 中添加 Forward 跳转按钮",
    },
    {
        key: "infuseEnabled",
        defaultValue: true,
        type: "boolean",
        tag: "Infuse 跳转按钮",
        desc: "启用后在 Trakt 和 SofaTime 中添加 Infuse 跳转按钮",
    },
    {
        key: "useShortcutsJumpEnabled",
        defaultValue: false,
        type: "boolean",
        tag: "借助快捷指令跳转",
        desc: `启用后播放器跳转链接改为通过快捷指令打开 DeepLink，用于规避弹框确认。Safari浏览器需处于非无痕模式，配置快捷指令 ${SHORTCUT_URL}`,
    },
    {
        key: "backendBaseUrl",
        defaultValue: DEFAULT_BACKEND_BASE_URL,
        type: "text",
        tag: "翻译缓存接口",
        desc: "用于批量获取 Trakt 的中文翻译，一般留空即可",
    },
    {
        key: "debugEnabled",
        defaultValue: false,
        type: "boolean",
        tag: "调试模式",
        desc: "启用后每次都会刷新 translation-overrides 覆盖数据",
    },
];

const ALL_ARGUMENT_KEYS = argumentFields.map((field) => field.key);
const PLAYER_ARGUMENT_KEYS = ["eplayerxEnabled", "forwardEnabled", "infuseEnabled"];
const CORE_ARGUMENT_KEYS = [
    "posterImageMode",
    "historyEpisodesMergedByShow",
    "googleTranslationEnabled",
    "characterTranslationEnabled",
    "useShortcutsJumpEnabled",
    "backendBaseUrl",
    "debugEnabled",
];
const CORE_WITH_PLAYER_ARGUMENT_KEYS = CORE_ARGUMENT_KEYS.flatMap((key) => (key === "useShortcutsJumpEnabled" ? [...PLAYER_ARGUMENT_KEYS, key] : key));

const scriptRules = [
    {
        kind: "cron",
        title: "手动清理本地缓存脚本",
        comment: "手动清理本地缓存脚本",
        cron: "0 0 1 1 1",
        scriptFile: "trakt_simplified_chinese_clear_cache.js",
        timeout: 10,
        enable: false,
        targets: ["plugin"],
    },
    {
        title: "Direct Redirect",
        comment: "处理播放器 DeepLink 跳转",
        phase: "http-request",
        pattern: String.raw`^https:\/\/loon-plugins\.demojameson\.de5\.net\/api\/redirect\?.*$`,
        scriptFile: TRAKT_SCRIPT_FILE,
        timeout: 10,
        argumentKeys: ALL_ARGUMENT_KEYS,
    },
    {
        title: "TMDB Logo Redirect",
        comment: "SofaTime 中自定义播放器 Logo",
        phase: "http-request",
        pattern: String.raw`^https:\/\/image\.tmdb\.org\/t\/p\/w342\/[a-z0-9_-]+_logo\.webp(?:\?.*)?$`,
        scriptFile: TRAKT_SCRIPT_FILE,
        timeout: 10,
        argumentKeys: ALL_ARGUMENT_KEYS,
    },
    {
        title: "Trakt Sync History Episodes Request",
        comment: "拦截 sync/history/episodes 请求，放大 limit",
        phase: "http-request",
        pattern: String.raw`^https:\/\/apiz?\.trakt\.tv\/sync\/history\/episodes\/?(\?.*)?$`,
        scriptFile: TRAKT_SCRIPT_FILE,
        timeout: 10,
        argumentKeys: CORE_ARGUMENT_KEYS,
    },
    {
        title: "Trakt History Episodes Request",
        comment: "拦截 history/episodes 请求，放大 limit",
        phase: "http-request",
        pattern: String.raw`^https:\/\/apiz?\.trakt\.tv\/users\/[^\/]+?\/history\/episodes\/?(\?.*)?$`,
        scriptFile: TRAKT_SCRIPT_FILE,
        timeout: 10,
        argumentKeys: CORE_ARGUMENT_KEYS,
    },
    {
        title: "Trakt Rippple History Request",
        comment: "拦截 Rippple 的 history 请求，确保 limit 至少为 100",
        phase: "http-request",
        pattern: String.raw`^https:\/\/apiz?\.trakt\.tv\/users\/[^\/]+?\/history\/?(\?.*)?$`,
        scriptFile: TRAKT_SCRIPT_FILE,
        timeout: 10,
        argumentKeys: CORE_ARGUMENT_KEYS,
    },
    {
        title: "Trakt Current Season Request",
        comment: "拦截带季号的请求，记录当前浏览季",
        phase: "http-request",
        pattern: String.raw`^https:\/\/apiz?\.trakt\.tv\/shows\/[^\/]+\/seasons\/\d+(?:\/.*|\?.*)?$`,
        scriptFile: TRAKT_SCRIPT_FILE,
        timeout: 10,
        argumentKeys: CORE_ARGUMENT_KEYS,
    },
    {
        title: "Trakt Response Router",
        comment: "统一拦截 Trakt 响应，由脚本内部分流处理",
        phase: "http-response",
        pattern: String.raw`^https:\/\/apiz?\.trakt\.tv\/.*$`,
        scriptFile: TRAKT_SCRIPT_FILE,
        timeout: 60,
        requiresBody: true,
        maxSize: 0,
        argumentKeys: ALL_ARGUMENT_KEYS,
    },
    {
        title: "TMDB Provider Catalog",
        comment: "仅拦截 SofaTime 的 TMDB provider 列表，注入播放器",
        phase: "http-response",
        pattern: String.raw`^https:\/\/api\.themoviedb\.org\/3\/watch\/providers\/(?:movie|tv)(\?.*)?$`,
        scriptFile: TRAKT_SCRIPT_FILE,
        timeout: 60,
        requiresBody: true,
        maxSize: 0,
        argumentKeys: CORE_ARGUMENT_KEYS,
    },
    {
        title: "SofaTime Streaming Availability",
        comment: "仅拦截 SofaTime 的 streaming-availability shows 详情，注入播放器",
        phase: "http-response",
        pattern: String.raw`^https:\/\/streaming-availability\.p\.rapidapi\.com\/shows\/tt\d+(\?.*)?$`,
        scriptFile: TRAKT_SCRIPT_FILE,
        timeout: 60,
        requiresBody: true,
        maxSize: 0,
        argumentKeys: CORE_WITH_PLAYER_ARGUMENT_KEYS,
    },
    {
        title: "SofaTime Country Services",
        comment: "仅拦截 SofaTime 的 streaming-availability 国家服务列表，注入播放器",
        phase: "http-response",
        pattern: String.raw`^https:\/\/streaming-availability\.p\.rapidapi\.com\/countries\/[a-z]{2}(\?.*)?$`,
        scriptFile: TRAKT_SCRIPT_FILE,
        timeout: 60,
        requiresBody: true,
        maxSize: 0,
        argumentKeys: CORE_ARGUMENT_KEYS,
    },
    {
        kind: "cron",
        title: "缓存压力测试脚本",
        comment: "缓存压力测试脚本",
        cron: "0 0 1 1 1",
        scriptFile: "trakt_simplified_chinese_expand_cache.js",
        timeout: 10,
        enable: false,
        targets: ["plugin"],
    },
];

const mitmHosts = ["apiz.trakt.tv", "api.trakt.tv", "api.themoviedb.org", "image.tmdb.org", "streaming-availability.p.rapidapi.com", "loon-plugins.demojameson.de5.net"];

const boxjs = {
    id: "demojameson.app.sub",
    name: "DemoJameson 应用订阅",
    description: "DemoJameson 的 BoxJs 订阅",
    author: "@DemoJameson",
    repo: REPOSITORY_URL,
    icon: "https://avatars.githubusercontent.com/u/181192?v=4",
    app: {
        id: "demojameson_trakt_simplified_chinese",
        author: "@DemoJameson",
        repo: `${REPOSITORY_URL}/tree/main/${TRAKT_MODULE_PATH}`,
        icons: [metadata.icon, metadata.icon],
        descsHtml: [
            metadata.description,
            `点此直达 <a href="${REPOSITORY_URL}/tree/main/${TRAKT_MODULE_PATH}">项目目录</a>`,
            'Egern 安装：<a href="egern:/modules/new?name=%E4%BC%98%E5%8C%96%20Trakt%20%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87%E4%BD%93%E9%AA%8C&amp;url=https%3A%2F%2Fraw.githubusercontent.com%2FDemoJameson%2FProxy.Modules%2Fmain%2Ftrakt_simplified_chinese%2Ftrakt_simplified_chinese.plugin">安装模块</a>',
            'Loon 安装：<a href="https://www.nsloon.com/openloon/import?plugin=https%3A%2F%2Fraw.githubusercontent.com%2FDemoJameson%2FProxy.Modules%2Fmain%2Ftrakt_simplified_chinese%2Ftrakt_simplified_chinese.plugin">安装插件</a>',
            'Surge 安装：<a href="surge:///install-module?url=https%3A%2F%2Fraw.githubusercontent.com%2FDemoJameson%2FProxy.Modules%2Fmain%2Ftrakt_simplified_chinese%2Ftrakt_simplified_chinese.sgmodule">安装模块</a>',
            'QX 安装：<a href="https://quantumult.app/x/open-app/add-resource?remote-resource=%7B%22rewrite_remote%22%3A%5B%22https%3A%2F%2Fraw.githubusercontent.com%2FDemoJameson%2FProxy.Modules%2Fmain%2Ftrakt_simplified_chinese%2Ftrakt_simplified_chinese.snippet%2C%20tag%3DTrakt%20Simplified%20Chinese%2C%20enabled%3Dtrue%22%5D%7D">安装片段</a>',
            `配套快捷指令：<a href="${SHORTCUT_URL}">打开链接</a>`,
            "脚本读取优先级：默认值 < BoxJs < 插件参数。已经在插件参数里填写的值会覆盖 BoxJs。",
        ],
    },
};

export { argumentFields, BOXJS_CONFIG_KEY, boxjs, DEFAULT_BACKEND_BASE_URL, metadata, mitmHosts, SHORTCUT_URL, scriptRules, TRAKT_SCRIPT_TITLE };
