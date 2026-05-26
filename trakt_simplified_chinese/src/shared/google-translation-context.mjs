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

function removeContextLine(translatedText) {
    const text = String(translatedText ?? "").trim();
    if (!text) {
        return text;
    }

    const newlineMatch = text.match(/\r?\n/);
    if (newlineMatch?.index >= 0) {
        return text.slice(newlineMatch.index + newlineMatch[0].length).trim();
    }

    return text;
}

export { buildContextLine, buildSourceText, removeContextLine };
