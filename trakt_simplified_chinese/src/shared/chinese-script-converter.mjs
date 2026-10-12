import { ConverterFactory } from "opencc-js/core";
import HKVariants from "opencc-js/dict/HKVariants";
import STCharacters from "opencc-js/dict/STCharacters";
import TWPhrases from "opencc-js/dict/TWPhrases";
import TWVariants from "opencc-js/dict/TWVariants";
import { Converter } from "opencc-js/t2cn";

// 中文地区：cn 简体、tw 台湾繁体、hk 香港繁体；与 Trakt 的 country 字段、缓存字段名保持一致
const CHINESE_LOCALE = {
    CN: "cn",
    TW: "tw",
    HK: "hk",
};

const CHINESE_LOCALES = [CHINESE_LOCALE.CN, CHINESE_LOCALE.TW, CHINESE_LOCALE.HK];

// 只接受当前显示的标签；旧简繁标签不再兼容，内部仍接受 cn/tw/hk 值
const CHINESE_LOCALE_LABEL_MAP = {
    简体中文: CHINESE_LOCALE.CN,
    "繁體中文（台灣）": CHINESE_LOCALE.TW,
    "繁體中文(台灣)": CHINESE_LOCALE.TW,
    "繁體中文（香港）": CHINESE_LOCALE.HK,
    "繁體中文(香港)": CHINESE_LOCALE.HK,
};

const TRADITIONAL_TO_SIMPLIFIED_CONVERTER = Converter({ from: "t", to: "cn" });
// 轻量字表：字表 + 台湾/香港地区用词，避免引入约 1MB 的短语表
const SIMPLIFIED_TO_TRADITIONAL_TW_CONVERTER = ConverterFactory([STCharacters], [TWPhrases, TWVariants]);
const SIMPLIFIED_TO_TRADITIONAL_HK_CONVERTER = ConverterFactory([STCharacters], [HKVariants]);

// 返回 "" 表示不是合法地区值，供参数解析区分「新顺序参数」与「旧顺序参数」
function parseChineseLocale(value) {
    const raw = String(value ?? "").trim();
    if (!raw) {
        return "";
    }
    const normalized = raw.toLowerCase();
    if (CHINESE_LOCALES.includes(normalized)) {
        return normalized;
    }
    return CHINESE_LOCALE_LABEL_MAP[raw] ?? "";
}

function normalizeChineseLocale(value) {
    return parseChineseLocale(value) || CHINESE_LOCALE.CN;
}

function resolveChineseLocale() {
    return normalizeChineseLocale(globalThis.$ctx?.argument?.chineseLocale);
}

// 已知的简体来源地区（Trakt 的 cn/sg、TMDb zh-CN、豆瓣等）
const SIMPLIFIED_SOURCE_REGIONS = new Set(["cn", "sg"]);

function isSimplifiedSourceRegion(region) {
    return SIMPLIFIED_SOURCE_REGIONS.has(
        String(region ?? "")
            .trim()
            .toLowerCase(),
    );
}

// 转换规则：
// - cn 目标：t2cn 对简体/繁体都安全（繁体转简体、简体原样），保持原有行为；
// - tw/hk 目标：只转换确认来自简体（cn/sg）的文本；港台原生译名、TMDb zh-TW/zh-HK、Google/DeepLX 繁体输出
//   已经是目标字形，直接透传，避免二次简→繁把「里約/皇后/干預」这类同形字改坏。
function convertChineseForLocale(value, locale, options = {}) {
    const text = String(value ?? "");
    if (!text) {
        return text;
    }
    const targetLocale = normalizeChineseLocale(locale);
    if (targetLocale === CHINESE_LOCALE.CN) {
        return TRADITIONAL_TO_SIMPLIFIED_CONVERTER(text);
    }
    if (options.fromSimplified !== true) {
        return text;
    }
    return targetLocale === CHINESE_LOCALE.TW ? SIMPLIFIED_TO_TRADITIONAL_TW_CONVERTER(text) : SIMPLIFIED_TO_TRADITIONAL_HK_CONVERTER(text);
}

// 脚本所有产出的中文文本统一经过这里，按当前地区输出
function normalizeChineseForLocale(value, locale = resolveChineseLocale(), options = {}) {
    return convertChineseForLocale(value, locale, options);
}

function convertTraditionalChineseToSimplified(value) {
    return TRADITIONAL_TO_SIMPLIFIED_CONVERTER(String(value ?? ""));
}

export {
    CHINESE_LOCALE,
    CHINESE_LOCALES,
    convertChineseForLocale,
    convertTraditionalChineseToSimplified,
    isSimplifiedSourceRegion,
    normalizeChineseForLocale,
    normalizeChineseLocale,
    parseChineseLocale,
    resolveChineseLocale,
};
