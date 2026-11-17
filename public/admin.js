const apiPath = "/api/trakt/translations/admin";
const fields = ["title", "overview", "tagline"];
const state = {
    selected: null,
    items: [],
    nextCursor: "0",
    hasQueriedList: false,
    editorBaseline: {},
    editorDirty: false,
    pendingDraft: null,
    authenticated: false,
    activeToken: "",
    listRequestId: 0,
};

const $ = (id) => document.getElementById(id);
const controls = {
    appShell: $("appShell"),
    tokenDialog: $("tokenDialog"),
    tokenDialogForm: $("tokenDialogForm"),
    tokenDialogInput: $("tokenDialogInput"),
    tokenDialogError: $("tokenDialogError"),
    unlockAdmin: $("unlockAdmin"),
    filters: $("filters"),
    type: $("type"),
    locale: $("locale"),
    query: $("query"),
    override: $("override"),
    rows: $("rows"),
    listMeta: $("listMeta"),
    listStatus: $("listStatus"),
    loadMoreWrap: $("loadMoreWrap"),
    loadMore: $("loadMore"),
    editorTitle: $("editorTitle"),
    editorMeta: $("editorMeta"),
    expiresMeta: $("expiresMeta"),
    overrideHint: $("overrideHint"),
    traktLink: $("traktLink"),
    editorEmpty: $("editorEmpty"),
    editorForm: $("editorForm"),
    titleInput: $("titleInput"),
    overviewInput: $("overviewInput"),
    taglineInput: $("taglineInput"),
    titleOverride: $("titleOverride"),
    overviewOverride: $("overviewOverride"),
    taglineOverride: $("taglineOverride"),
    effectiveView: $("effectiveView"),
    status: $("status"),
    deleteOverride: $("deleteOverride"),
    deleteAll: $("deleteAll"),
    saveTranslation: $("saveTranslation"),
    confirmDialog: $("confirmDialog"),
    confirmTitle: $("confirmTitle"),
    confirmMessage: $("confirmMessage"),
    confirmAccept: $("confirmAccept"),
};

function setListMeta(message) {
    controls.listMeta.textContent = message;
}

function setListStatus(message, type = "") {
    controls.listStatus.textContent = message;
    controls.listStatus.className = `status ${type}`;
}

function setStatus(message, type = "") {
    controls.status.textContent = message;
    controls.status.className = `status ${type}`;
}

function getToken() {
    return state.activeToken;
}

function confirmAction({ title, message, confirmLabel = "确认" }) {
    controls.confirmTitle.textContent = title;
    controls.confirmMessage.textContent = message;
    controls.confirmAccept.textContent = confirmLabel;
    controls.confirmDialog.returnValue = "";

    if (!controls.confirmDialog.open) {
        controls.confirmDialog.showModal();
    }

    return new Promise((resolve) => {
        controls.confirmDialog.addEventListener(
            "close",
            () => {
                resolve(controls.confirmDialog.returnValue === "confirm");
            },
            { once: true },
        );
    });
}

function confirmDiscardChanges() {
    return confirmAction({
        title: "放弃未保存的修改？",
        message: "当前条目有未保存的修改，继续将丢失这些修改。",
        confirmLabel: "放弃修改",
    });
}

function openTokenDialog(message = "") {
    if (!state.pendingDraft && state.selected) {
        state.pendingDraft = {
            item: state.selected,
            values: {
                title: controls.titleInput.value,
                overview: controls.overviewInput.value,
                tagline: controls.taglineInput.value,
                titleOverride: controls.titleOverride.checked,
                overviewOverride: controls.overviewOverride.checked,
                taglineOverride: controls.taglineOverride.checked,
            },
            dirty: state.editorDirty,
        };
    }

    state.authenticated = false;
    controls.tokenDialogError.textContent = message;
    controls.tokenDialogInput.value = state.activeToken;
    controls.tokenDialogInput.setAttribute("aria-invalid", message ? "true" : "false");

    if (!controls.tokenDialog.open) {
        controls.tokenDialog.showModal();
    }

    requestAnimationFrame(() => {
        controls.tokenDialogInput.focus();
        controls.tokenDialogInput.select();
    });
}

function closeTokenDialog() {
    state.authenticated = true;
    if (controls.tokenDialog.open) {
        controls.tokenDialog.close();
    }
    requestAnimationFrame(() => controls.query.focus());
}

function enterAdmin(token) {
    const draft = state.pendingDraft;
    state.pendingDraft = null;
    state.activeToken = token;
    state.items = [];
    state.selected = null;
    state.hasQueriedList = false;
    state.editorDirty = false;
    closeTokenDialog();
    setListMeta("等待查询");
    setListStatus("", "");
    setStatus("", "");
    state.nextCursor = "0";
    controls.loadMoreWrap.hidden = true;
    controls.loadMore.disabled = true;
    renderEditor(null);

    if (draft?.item) {
        renderEditor(draft.item);
        controls.titleInput.value = draft.values.title;
        controls.overviewInput.value = draft.values.overview;
        controls.taglineInput.value = draft.values.tagline;
        controls.titleOverride.checked = draft.values.titleOverride;
        controls.overviewOverride.checked = draft.values.overviewOverride;
        controls.taglineOverride.checked = draft.values.taglineOverride;
        state.editorDirty = draft.dirty;
    }
}

async function validateAdminToken(token) {
    const previousToken = state.activeToken;
    state.activeToken = token;
    try {
        await requestAdmin({
            action: "auth",
        });
    } catch (error) {
        state.activeToken = previousToken;
        throw error;
    }
}

async function unlockAdmin() {
    const token = controls.tokenDialogInput.value.trim();
    if (!token) {
        controls.tokenDialogError.textContent = "请输入 ADMIN_TOKEN";
        controls.tokenDialogInput.setAttribute("aria-invalid", "true");
        return;
    }

    controls.unlockAdmin.disabled = true;
    controls.tokenDialogError.textContent = "验证中...";
    try {
        await validateAdminToken(token);
        enterAdmin(token);
    } catch (error) {
        controls.tokenDialogError.textContent = error.message || "管理员验证失败";
        controls.tokenDialogInput.setAttribute("aria-invalid", "true");
        controls.tokenDialogInput.focus();
        controls.tokenDialogInput.select();
    } finally {
        controls.unlockAdmin.disabled = false;
    }
}

async function requestAdmin(params, options = {}) {
    const token = getToken();
    const url = new URL(apiPath, window.location.origin);
    Object.entries(params || {}).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== "") {
            url.searchParams.set(key, value);
        }
    });

    const response = await fetch(url, {
        ...options,
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            ...(options.headers || {}),
        },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(data.error || `HTTP ${response.status}`);
        error.status = response.status;
        if (response.status === 401 && state.authenticated) {
            openTokenDialog(data.error || "管理员验证失败");
        }
        throw error;
    }
    return data;
}

function getTranslation(entry) {
    return entry?.translation || {};
}

function getTranslationOverrides(entry) {
    // entry 是原始覆盖条目：编辑器只展示当前地区自己的槽位；
    // cn 回退由 effectiveEntry 预览，避免把回退值误当成当前地区覆盖保存
    const localized = entry?.[controls.locale.value]?.translation;
    return localized || entry?.translation || {};
}

function getFieldControls(field) {
    return {
        title: {
            input: controls.titleInput,
            override: controls.titleOverride,
        },
        overview: {
            input: controls.overviewInput,
            override: controls.overviewOverride,
        },
        tagline: {
            input: controls.taglineInput,
            override: controls.taglineOverride,
        },
    }[field];
}

function trimInputValue(value) {
    return String(value || "").trim();
}

function isEmptyTranslationValue(value) {
    return value === undefined || value === null || value === "";
}

function updateOverrideMark(field) {
    const fieldControls = getFieldControls(field);
    if (!fieldControls || !state.selected) {
        return;
    }

    const baseline = trimInputValue(state.editorBaseline[field]);
    const current = trimInputValue(fieldControls.input.value);
    fieldControls.override.checked = current !== baseline;
}

function hasOverriddenFields() {
    return fields.some((field) => getFieldControls(field).override.checked);
}

function restoreOriginalTranslation(field) {
    const fieldControls = getFieldControls(field);
    if (!fieldControls || !state.selected || fieldControls.override.checked) {
        return;
    }

    fieldControls.input.value = state.editorBaseline[field] || "";
}

function getTranslationOverridesPayload() {
    return {
        ...(controls.titleOverride.checked && controls.titleInput.value.trim() ? { title: controls.titleInput.value.trim() } : {}),
        ...(controls.overviewOverride.checked && controls.overviewInput.value.trim() ? { overview: controls.overviewInput.value.trim() } : {}),
        ...(controls.taglineOverride.checked && controls.taglineInput.value.trim() ? { tagline: controls.taglineInput.value.trim() } : {}),
    };
}

function statusLabel(entry) {
    if (!entry || entry.status === 3) {
        return "翻译程度：无";
    }
    if (entry.status === 2) {
        return "翻译程度：部分";
    }
    return "翻译程度：完整";
}

function mediaTypeLabel(type) {
    if (type === "movies") {
        return "电影";
    }
    if (type === "shows") {
        return "剧集";
    }
    if (type === "episodes") {
        return "单集";
    }
    return type || "";
}

function getTraktUrl(item) {
    if (!item?.type || !item.id) {
        return "";
    }

    if (item.type === "movies") {
        return `https://app.trakt.tv/movies/${encodeURIComponent(item.id)}`;
    }

    if (item.type === "shows") {
        return `https://app.trakt.tv/shows/${encodeURIComponent(item.id)}`;
    }

    const episodeParts = String(item.id).split(":");
    if (item.type === "episodes" && episodeParts.length === 3) {
        const [showId, season, episode] = episodeParts.map((part) => encodeURIComponent(part));
        return `https://app.trakt.tv/shows/${showId}/seasons/${season}/episodes/${episode}`;
    }

    return `https://app.trakt.tv/search?query=${encodeURIComponent(item.id)}`;
}

function renderRows() {
    controls.rows.replaceChildren();
    if (state.items.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty-state";
        empty.textContent = state.hasQueriedList ? "没有匹配结果" : "输入 ID / 标题或点击筛选后查询";
        controls.rows.append(empty);
        return;
    }

    const header = document.createElement("div");
    header.className = "row-header";
    for (const label of ["ID", "标题", "媒体类型", "覆盖状态"]) {
        const cell = document.createElement("span");
        cell.textContent = label;
        header.append(cell);
    }
    controls.rows.append(header);

    for (const item of state.items) {
        const translation = getTranslation(item.effectiveEntry);
        const effectiveOverrides = getTranslation(item.override);
        const overrideCount = fields.filter((field) => !isEmptyTranslationValue(effectiveOverrides[field])).length;
        const button = document.createElement("button");
        button.type = "button";
        button.className = `row ${state.selected && state.selected.type === item.type && state.selected.id === item.id ? "active" : ""}`;

        const idCell = document.createElement("span");
        idCell.className = "id";
        idCell.textContent = item.id;

        const titleCell = document.createElement("span");
        titleCell.className = "title";
        titleCell.textContent = translation.title || "(无标题)";

        const typeCell = document.createElement("span");
        typeCell.className = "media-type";
        typeCell.textContent = mediaTypeLabel(item.type);

        const badge = document.createElement("span");
        badge.className = `badge ${overrideCount ? "overridden" : ""}`;
        badge.textContent = overrideCount ? "已覆盖" : "未覆盖";

        button.append(idCell, titleCell, typeCell, badge);
        button.addEventListener("click", () => {
            loadEditor(item).catch((error) => {
                setStatus(error.message || String(error), "error");
            });
        });
        controls.rows.append(button);
    }
}

function updateListItem(updatedItem) {
    if (!updatedItem?.type || !updatedItem.id) {
        return;
    }
    state.items = state.items.map((item) => (item.type === updatedItem.type && item.id === updatedItem.id ? updatedItem : item));
}

async function loadEditor(item) {
    const selected = state.selected;
    const isSame = !!(selected && item?.type && item.id && selected.type === item.type && selected.id === item.id);
    const isSwitching = !!(selected && item?.type && item.id && !isSame);
    if (isSwitching && state.editorDirty && !(await confirmDiscardChanges())) {
        return null;
    }
    if (isSame && state.editorDirty) {
        return item;
    }

    renderEditor(item);
    if (!item?.type || !item.id) {
        return null;
    }
    if (!item.autoEntry || Object.hasOwn(item.autoEntry, "expiresAt")) {
        return item;
    }

    const locale = controls.locale.value;
    controls.expiresMeta.textContent = "到期：读取中...";
    const detail = await requestAdmin({
        action: "item",
        type: item.type,
        id: item.id,
        locale,
    });
    updateListItem(detail);
    if (!state.selected || state.selected.type !== item.type || state.selected.id !== item.id) {
        renderRows();
        return detail;
    }
    if (locale !== controls.locale.value) {
        renderRows();
        return detail;
    }
    if (state.editorDirty) {
        renderRows();
        controls.expiresMeta.textContent = getExpiresLabel(detail);
        return detail;
    }
    renderEditor(detail);
    return detail;
}

function renderEditor(item) {
    state.selected = item;
    renderRows();
    controls.editorEmpty.hidden = !!item;
    controls.editorForm.hidden = !item;

    if (!item) {
        controls.editorTitle.textContent = "未选择条目";
        controls.editorMeta.textContent = "";
        controls.expiresMeta.textContent = "";
        controls.overrideHint.hidden = true;
        controls.overrideHint.textContent = "";
        controls.traktLink.hidden = true;
        controls.traktLink.href = "https://app.trakt.tv";
        state.editorBaseline = {};
        state.editorDirty = false;
        return;
    }

    const translationOverrides = getTranslationOverrides(item.overrideEntry ?? item.override);
    const effectiveOverrides = getTranslation(item.override);
    const ignoredOverrideFields = fields.filter((field) => !isEmptyTranslationValue(translationOverrides[field]) && isEmptyTranslationValue(effectiveOverrides[field]));
    const originalTranslation = getTranslation(item.autoEntry);
    const effectiveTranslation = getTranslation(item.effectiveEntry);
    const traktUrl = getTraktUrl(item);
    controls.editorTitle.textContent = `${mediaTypeLabel(item.type)} / ${item.id}`;
    controls.editorMeta.textContent = statusLabel(item.effectiveEntry);
    controls.expiresMeta.textContent = getExpiresLabel(item);
    controls.overrideHint.hidden = ignoredOverrideFields.length === 0;
    controls.overrideHint.textContent = ignoredOverrideFields.length > 0 ? "与简体中文相同，已被忽略" : "";
    controls.traktLink.href = traktUrl;
    controls.traktLink.hidden = !traktUrl;
    controls.titleInput.value = translationOverrides.title || effectiveTranslation.title || "";
    controls.overviewInput.value = translationOverrides.overview || effectiveTranslation.overview || "";
    controls.taglineInput.value = translationOverrides.tagline || effectiveTranslation.tagline || "";
    state.editorBaseline = {
        title: originalTranslation.title || "",
        overview: originalTranslation.overview || "",
        tagline: originalTranslation.tagline || "",
    };
    controls.titleOverride.checked = Object.hasOwn(translationOverrides, "title");
    controls.overviewOverride.checked = Object.hasOwn(translationOverrides, "overview");
    controls.taglineOverride.checked = Object.hasOwn(translationOverrides, "tagline");
    highlightJson(item.effectiveEntry);
    state.editorDirty = false;
}

let querySearchTimer = 0;

function shouldOpenFirstResult() {
    return controls.query.value.trim() !== "";
}

function shouldSkipListRequest(options = {}) {
    if (options.append === true) {
        return false;
    }

    return controls.query.value.trim() === "" && controls.type.value === "all" && controls.override.value === "all";
}

function resetListToIdleState() {
    state.listRequestId += 1;
    state.items = [];
    state.hasQueriedList = false;
    state.nextCursor = "0";
    controls.loadMoreWrap.hidden = true;
    controls.loadMore.disabled = true;
    setListMeta("等待查询");
    setListStatus("", "");
}

function refreshFirstPage(options = {}) {
    if (shouldSkipListRequest(options)) {
        resetListToIdleState();
        return Promise.resolve(null);
    }

    state.nextCursor = "0";
    return loadList({ ...options, append: false, cursor: "" });
}

async function loadList(options = {}) {
    if (shouldSkipListRequest(options)) {
        resetListToIdleState();
        return null;
    }

    if (!getToken()) {
        setListStatus("请输入 ADMIN_TOKEN", "error");
        return;
    }

    const requestId = ++state.listRequestId;
    const query = controls.query.value.trim();
    const append = options.append === true;
    setListMeta(append ? "正在加载更多..." : "正在筛选...");
    setListStatus("", "");
    controls.loadMore.disabled = true;
    let data;
    try {
        data = await requestAdmin({
            action: "list",
            type: controls.type.value,
            cursor: options.cursor || "",
            limit: 100,
            q: query,
            override: controls.override.value,
            locale: controls.locale.value,
        });
    } catch (error) {
        if (requestId !== state.listRequestId) {
            return null;
        }
        throw error;
    }

    if (requestId !== state.listRequestId) {
        return null;
    }

    const incomingItems = data.items || [];
    state.items = append ? [...state.items, ...incomingItems] : incomingItems;
    state.hasQueriedList = true;
    state.nextCursor = data.cursor || "0";
    controls.loadMoreWrap.hidden = state.nextCursor === "0";
    controls.loadMore.disabled = state.nextCursor === "0";
    controls.listMeta.textContent = `已显示 ${state.items.length} 条 · 本次 ${incomingItems.length} 条${state.nextCursor === "0" ? "" : " · 还有更多"}`;
    renderRows();
    if (!append && options.openFirstResult && !state.editorDirty && query && state.items.length > 0) {
        await loadEditor(state.items[0]);
    }
    return data;
}

function scheduleQuerySearch() {
    window.clearTimeout(querySearchTimer);
    querySearchTimer = window.setTimeout(
        () => {
            refreshFirstPage({ openFirstResult: shouldOpenFirstResult() }).catch((error) => setListStatus(error.message, "error"));
        },
        controls.query.value.trim() ? 300 : 0,
    );
}

const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
});

function formatDateTime(timestamp) {
    return dateTimeFormatter.format(new Date(timestamp));
}

function getExpiresLabel(item) {
    if (!item?.autoEntry) {
        return "到期：无缓存";
    }
    if (!Object.hasOwn(item.autoEntry, "expiresAt")) {
        return "到期：未知";
    }
    return Number.isFinite(item.autoEntry.expiresAt) ? `到期：${formatDateTime(item.autoEntry.expiresAt)}` : "到期：永久";
}

const jsonTokenPattern = /("(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?/g;

function appendJsonToken(fragment, className, text) {
    const span = document.createElement("span");
    span.className = className;
    span.textContent = text;
    fragment.append(span);
}

function highlightJson(value) {
    const json = JSON.stringify(value, null, 2) ?? "null";
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;

    for (const match of json.matchAll(jsonTokenPattern)) {
        if (match.index > lastIndex) {
            fragment.append(document.createTextNode(json.slice(lastIndex, match.index)));
        }

        const [token, stringValue, keySuffix, literalValue] = match;
        if (stringValue) {
            appendJsonToken(fragment, keySuffix ? "json-key" : "json-string", stringValue);
            if (keySuffix) {
                fragment.append(document.createTextNode(keySuffix));
            }
        } else if (literalValue === "true" || literalValue === "false") {
            appendJsonToken(fragment, "json-boolean", literalValue);
        } else if (literalValue === "null") {
            appendJsonToken(fragment, "json-null", "null");
        } else {
            appendJsonToken(fragment, "json-number", token);
        }

        lastIndex = match.index + token.length;
    }

    if (lastIndex < json.length) {
        fragment.append(document.createTextNode(json.slice(lastIndex)));
    }

    controls.effectiveView.replaceChildren(fragment);
}

controls.tokenDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
});

controls.tokenDialogForm.addEventListener("submit", (event) => {
    event.preventDefault();
    unlockAdmin();
});

controls.filters.addEventListener("submit", (event) => {
    event.preventDefault();
    refreshFirstPage({ openFirstResult: shouldOpenFirstResult() }).catch((error) => setListStatus(error.message, "error"));
});

[controls.type, controls.override].forEach((control) => {
    control.addEventListener("change", () => {
        refreshFirstPage({ openFirstResult: shouldOpenFirstResult() }).catch((error) => setListStatus(error.message, "error"));
    });
});

let activeLocale = controls.locale.value;
controls.locale.addEventListener("change", async () => {
    if (state.editorDirty && !(await confirmDiscardChanges())) {
        controls.locale.value = activeLocale;
        return;
    }

    activeLocale = controls.locale.value;
    renderEditor(null);
    refreshFirstPage({ openFirstResult: shouldOpenFirstResult() }).catch((error) => setListStatus(error.message, "error"));
});

controls.query.addEventListener("input", scheduleQuerySearch);
controls.query.addEventListener("search", (event) => {
    if (controls.query.value.trim() !== "") {
        return;
    }

    event.preventDefault();
    window.clearTimeout(querySearchTimer);
    refreshFirstPage({ openFirstResult: false }).catch((error) => setListStatus(error.message, "error"));
});
fields.forEach((field) => {
    const fieldControls = getFieldControls(field);
    fieldControls.input.addEventListener("input", () => {
        updateOverrideMark(field);
        state.editorDirty = true;
    });
    fieldControls.override.addEventListener("change", () => {
        restoreOriginalTranslation(field);
        state.editorDirty = true;
    });
});

controls.loadMore.addEventListener("click", () => {
    if (state.nextCursor === "0") {
        return;
    }
    loadList({ append: true, cursor: state.nextCursor }).catch((error) => setListStatus(error.message, "error"));
});

controls.editorForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const selected = state.selected;
    if (!selected || controls.saveTranslation.disabled) {
        return;
    }

    controls.saveTranslation.disabled = true;
    setStatus("保存中...", "loading");
    try {
        if (!hasOverriddenFields() && selected.override) {
            const data = await requestAdmin(
                {
                    type: selected.type,
                    id: selected.id,
                    target: "override",
                    locale: controls.locale.value,
                },
                { method: "DELETE" },
            );
            renderEditor(data);
            await loadList({ cursor: "" });
            setStatus("已清除覆盖", "ok");
            return;
        }

        const data = await requestAdmin(
            {},
            {
                method: "PUT",
                body: JSON.stringify({
                    type: selected.type,
                    id: selected.id,
                    locale: controls.locale.value,
                    translation: getTranslationOverridesPayload(),
                }),
            },
        );
        renderEditor(data);
        await loadList({ cursor: "" });
        setStatus("已保存", "ok");
    } catch (error) {
        setStatus(error.message || "保存失败", "error");
    } finally {
        controls.saveTranslation.disabled = false;
    }
});

async function deleteTarget(target, labels) {
    if (!state.selected) {
        return;
    }
    setStatus(labels.loading, "loading");
    const data = await requestAdmin(
        {
            type: state.selected.type,
            id: state.selected.id,
            target,
            locale: controls.locale.value,
        },
        { method: "DELETE" },
    );
    renderEditor(data);
    await loadList({ cursor: "" });
    setStatus(labels.done, "ok");
}

controls.deleteOverride.addEventListener("click", async () => {
    const confirmed = await confirmAction({
        title: "清除当前覆盖？",
        message: `将删除该条目在“${controls.locale.selectedOptions[0]?.textContent || "当前地区"}”下的手工覆盖，缓存翻译不受影响。`,
        confirmLabel: "清除覆盖",
    });
    if (!confirmed) {
        return;
    }
    deleteTarget("override", {
        loading: "正在清除覆盖...",
        done: "已清除覆盖",
    }).catch((error) => setStatus(error.message || String(error), "error"));
});

controls.deleteAll.addEventListener("click", async () => {
    const confirmed = await confirmAction({
        title: "删除全部翻译？",
        message: `将同时删除该条目在“${controls.locale.selectedOptions[0]?.textContent || "当前地区"}”下的缓存翻译和手工覆盖，且无法撤销。`,
        confirmLabel: "删除翻译",
    });
    if (!confirmed) {
        return;
    }
    deleteTarget("all", {
        loading: "正在删除翻译...",
        done: "已删除翻译",
    }).catch((error) => setStatus(error.message || String(error), "error"));
});

controls.tokenDialogInput.addEventListener("input", () => {
    controls.tokenDialogInput.setAttribute("aria-invalid", "false");
});

window.addEventListener("beforeunload", (event) => {
    if (!state.editorDirty) {
        return;
    }
    event.preventDefault();
    event.returnValue = "";
});

openTokenDialog();
