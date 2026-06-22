const CONTEXT_BOUNDARY = "§";

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
    return text && context ? `${CONTEXT_BOUNDARY}${context}${CONTEXT_BOUNDARY}${text}` : text;
}

function parseMarkedSourceText(text) {
    const value = String(text ?? "").trim();
    if (!value.startsWith(CONTEXT_BOUNDARY)) {
        return null;
    }

    const endIndex = value.indexOf(CONTEXT_BOUNDARY, CONTEXT_BOUNDARY.length);
    if (endIndex <= CONTEXT_BOUNDARY.length) {
        return null;
    }

    const context = value.slice(CONTEXT_BOUNDARY.length, endIndex).trim();
    const body = value.slice(endIndex + CONTEXT_BOUNDARY.length).trim();
    return context && body ? { context, text: body } : null;
}

function parseLegacySourceText(text) {
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
    return parseMarkedSourceText(value) || parseLegacySourceText(value) || { context: "", text: value };
}

function stripContextHeader(text) {
    const value = String(text ?? "").trim();
    const parsed = parseMarkedSourceText(value);
    return parsed ? parsed.text : value;
}

function stripLeadingContextBoundary(text) {
    let value = String(text ?? "").trim();
    while (value.startsWith(CONTEXT_BOUNDARY)) {
        value = value.slice(CONTEXT_BOUNDARY.length).trim();
    }
    return value;
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

function stripKnownContextHeader(text, contexts) {
    let value = stripContextHeader(text);
    const knownContexts = normalizeContextList(contexts);
    if (!value || knownContexts.length === 0) {
        return value;
    }

    value = stripLeadingContextBoundary(value);

    while (value) {
        const newlineMatch = value.match(/\r?\n/);
        if (!newlineMatch) {
            return knownContexts.includes(value.trim()) ? "" : value;
        }

        const firstLine = value.slice(0, newlineMatch.index).trim();
        if (!knownContexts.includes(firstLine)) {
            return value;
        }

        value = value.slice(newlineMatch.index + newlineMatch[0].length).trim();
    }

    return value;
}

function buildContextHeader(contexts) {
    const uniqueContexts = normalizeContextList(contexts);
    return uniqueContexts.length > 0 ? `${CONTEXT_BOUNDARY}${uniqueContexts.join("\n")}${CONTEXT_BOUNDARY}` : "";
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

export { buildContextHeader, buildContextLine, buildSourceText, parseSourceText, removeContextLine, repairTranslatedText, stripContextHeader, stripKnownContextHeader };
