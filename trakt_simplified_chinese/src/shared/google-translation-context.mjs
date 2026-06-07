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
    return !/[《》\r\n,，.。!！?？:：;；()[\]{}]/.test(leadingTitle);
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
    return repairLeadingTitleQuote(text, "");
}

function removeContextLine(translatedText, contextLine = "") {
    const text = String(translatedText ?? "").trim();
    if (!text) {
        return text;
    }

    const newlineMatch = text.match(/\r?\n/);
    if (newlineMatch?.index >= 0) {
        return repairLeadingTitleQuote(text.slice(newlineMatch.index + newlineMatch[0].length), contextLine);
    }

    return repairLeadingTitleQuote(text, contextLine);
}

export { buildContextLine, buildSourceText, removeContextLine, repairTranslatedText };
