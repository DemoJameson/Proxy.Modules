import { Converter } from "opencc-js/t2cn";

const TRADITIONAL_TO_SIMPLIFIED_CONVERTER = Converter({ from: "t", to: "cn" });

function convertTraditionalChineseToSimplified(value) {
    return TRADITIONAL_TO_SIMPLIFIED_CONVERTER(String(value ?? ""));
}

export { convertTraditionalChineseToSimplified };
