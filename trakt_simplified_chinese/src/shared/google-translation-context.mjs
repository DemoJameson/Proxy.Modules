function buildContextLine(sourceName, localizedName) {
    const source = String(sourceName ?? "").trim();
    const localized = String(localizedName ?? "").trim();
    if (!source && !localized) {
        return "";
    }
    if (!source || !localized || source === localized) {
        return source || localized;
    }
    return `${source} (${localized})`;
}

function buildSourceText(sourceText, contextLine) {
    const text = String(sourceText ?? "").trim();
    const context = String(contextLine ?? "").trim();
    return text && context ? `${context}\n${text}` : text;
}

function parseContextSourceText(text) {
    const value = String(text ?? "").trim();
    const newlineMatch = value.match(/\r?\n/);
    if (!newlineMatch?.index) {
        return null;
    }

    const context = value.slice(0, newlineMatch.index).trim();
    const body = value.slice(newlineMatch.index + newlineMatch[0].length).trim();
    if (!context || !body || !/\([^()]+\)$/.test(context)) {
        return null;
    }

    return { context, text: body };
}

function parseSourceText(text) {
    const value = String(text ?? "").trim();
    return parseContextSourceText(value) || { context: "", text: value };
}

function stripContextHeader(text) {
    return String(text ?? "").trim();
}

function normalizeContextList(contexts) {
    const uniqueContexts = [];
    ensureArrayLike(contexts).forEach((context) => {
        String(context ?? "")
            .split(/\r?\n/g)
            .forEach((line) => {
                const value = line.trim();
                if (value && !uniqueContexts.includes(value)) {
                    uniqueContexts.push(value);
                }
            });
    });
    return uniqueContexts;
}

function escapeRegExp(value) {
    return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Google/DeepLX 可能把上下文行中的源文名一并翻译（如 "Original Movie (中文电影)" → "原版电影（中文电影）"），
// 导致首行与已知上下文的精确匹配失败，剥离失效后译文头部会残留已翻译的上下文。
// 回退策略：首行若以已知上下文的「本地化名」（括号内的中文名）结尾，即视为翻译后的上下文行——
// 本地化名是中文、目标语言也是中文，翻译后保持不变，是可靠锚点；兼容全/半角括号与空白差异。
function isKnownContextLine(line, knownContext) {
    const normalizedLine = String(line ?? "").trim();
    const context = String(knownContext ?? "").trim();
    if (!normalizedLine || !context) {
        return false;
    }
    if (normalizedLine === context) {
        return true;
    }

    const match = context.match(/\(([^()]+)\)\s*$/);
    const localizedName = String(match?.[1] ?? "").trim();
    if (!localizedName) {
        return false;
    }
    return new RegExp(`[（(]\\s*${escapeRegExp(localizedName)}\\s*[)）]\\s*$`).test(normalizedLine);
}

function stripKnownContextHeader(text, contexts) {
    let value = stripContextHeader(text);
    const knownContexts = normalizeContextList(contexts);
    if (!value || knownContexts.length === 0) {
        return value;
    }

    while (value) {
        const newlineMatch = value.match(/\r?\n/);
        if (!newlineMatch) {
            // 无换行时保持保守：仅整体精确命中已知上下文才清空，避免误删正文。
            return knownContexts.includes(value.trim()) ? "" : value;
        }

        const firstLine = value.slice(0, newlineMatch.index).trim();
        if (!knownContexts.some((context) => isKnownContextLine(firstLine, context))) {
            return value;
        }

        value = value.slice(newlineMatch.index + newlineMatch[0].length).trim();
    }

    return value;
}

function ensureArrayLike(value) {
    return Array.isArray(value) ? value : [];
}

function extractLocalizedContextName(contextLine) {
    const context = String(contextLine ?? "").trim();
    const match = context.match(/\(([^()]+)\)$/);
    return String(match?.[1] ?? "").trim();
}

function hasLikelyLeadingTitleCloseQuote(text) {
    const closeQuoteIndex = text.indexOf("》");
    if (closeQuoteIndex <= 0 || closeQuoteIndex > 40 || text.startsWith("《")) {
        return false;
    }

    const leadingTitle = text.slice(0, closeQuoteIndex);
    return !/[《》\r\n,，.。!！?？;；()[\]{}]/.test(leadingTitle);
}

function repairLeadingTitleQuote(text, contextLine) {
    const normalizedText = String(text ?? "").trim();
    const localizedName = extractLocalizedContextName(contextLine);
    if (localizedName && !localizedName.startsWith("《") && normalizedText.startsWith(`${localizedName}》`)) {
        return `《${normalizedText}`;
    }

    return hasLikelyLeadingTitleCloseQuote(normalizedText) ? `《${normalizedText}` : normalizedText;
}

function repairTranslatedText(text) {
    return repairLeadingTitleQuote(stripContextHeader(text), "");
}

function removeContextLine(translatedText, contextLine = "") {
    const text = stripContextHeader(translatedText);
    if (!text) {
        return text;
    }

    const newlineMatch = text.match(/\r?\n/);
    if (newlineMatch?.index >= 0) {
        return repairLeadingTitleQuote(text.slice(newlineMatch.index + newlineMatch[0].length), contextLine);
    }

    return repairLeadingTitleQuote(text, contextLine);
}

export { buildContextLine, buildSourceText, parseSourceText, removeContextLine, repairTranslatedText, stripContextHeader, stripKnownContextHeader };
