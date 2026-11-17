const tools = {
    loon: {
        id: "loon",
        name: "Loon",
        buildImportUrl(resourceUrl) {
            return `https://www.nsloon.com/openloon/import?plugin=${encodeURIComponent(resourceUrl)}`;
        },
    },
    surge: {
        id: "surge",
        name: "Surge",
        buildImportUrl(resourceUrl) {
            return `surge:///install-module?url=${encodeURIComponent(resourceUrl)}`;
        },
    },
    egern: {
        id: "egern",
        name: "Egern",
        buildImportUrl(resourceUrl, moduleItem) {
            return `egern:/modules/new?name=${encodeURIComponent(moduleItem.name)}&url=${encodeURIComponent(resourceUrl)}`;
        },
    },
    qx: {
        id: "qx",
        name: "QX",
        buildImportUrl(resourceUrl, moduleItem) {
            const payload = {
                rewrite_remote: [`${resourceUrl}, tag=${moduleItem.qxTag}, enabled=true`],
            };
            return `https://quantumult.app/x/open-app/add-resource?remote-resource=${encodeURIComponent(JSON.stringify(payload))}`;
        },
    },
};

const modules = [
    {
        id: "trakt_simplified_chinese",
        name: "Trakt 增强",
        description:
            "Trakt App 各页面从英文改为简体中文或港台繁体，包括海报；历史页面剧集类别的已观看记录按电视剧合并；Trakt 的影片详情页添加 Forward、Infuse、Rex 跳转按钮；部分兼容其它使用了 Trakt API 的应用。",
        qxTag: "Trakt Simplified Chinese",
        icon: "trakt.webp",
        githubFolder: "https://github.com/DemoJameson/Proxy.Modules/tree/main/trakt_simplified_chinese",
        resources: {
            loon: "https://raw.githubusercontent.com/DemoJameson/Proxy.Modules/main/trakt_simplified_chinese/trakt_simplified_chinese.plugin",
            surge: "https://raw.githubusercontent.com/DemoJameson/Proxy.Modules/main/trakt_simplified_chinese/trakt_simplified_chinese.sgmodule",
            egern: "https://raw.githubusercontent.com/DemoJameson/Proxy.Modules/main/trakt_simplified_chinese/trakt_simplified_chinese.plugin",
            qx: "https://raw.githubusercontent.com/DemoJameson/Proxy.Modules/main/trakt_simplified_chinese/trakt_simplified_chinese.snippet",
        },
    },
    {
        id: "imdbapi_redirect_to_tiffara",
        name: "修复 imdbapi.dev",
        description: "将 imdbapi.dev 及其所有子域名的请求重定向到 tiffara.com，保留子域名、路径和查询参数",
        qxTag: "修复 imdbapi.dev",
        // 与 imdbapi_redirect_to_tiffara/imdb.png 保持同步
        icon: "imdb.png",
        githubFolder: "https://github.com/DemoJameson/Proxy.Modules/tree/main/imdbapi_redirect_to_tiffara",
        resources: {
            loon: "https://raw.githubusercontent.com/DemoJameson/Proxy.Modules/main/imdbapi_redirect_to_tiffara/imdbapi_redirect_to_tiffara.plugin",
            surge: "https://raw.githubusercontent.com/DemoJameson/Proxy.Modules/main/imdbapi_redirect_to_tiffara/imdbapi_redirect_to_tiffara.sgmodule",
            egern: "https://raw.githubusercontent.com/DemoJameson/Proxy.Modules/main/imdbapi_redirect_to_tiffara/imdbapi_redirect_to_tiffara.plugin",
            qx: "https://raw.githubusercontent.com/DemoJameson/Proxy.Modules/main/imdbapi_redirect_to_tiffara/imdbapi_redirect_to_tiffara.snippet",
        },
    },
];

function findResource(moduleItem, toolId) {
    return moduleItem?.resources ? moduleItem.resources[toolId] : "";
}

function buildImportUrl(moduleItem, toolId) {
    const tool = tools[toolId];
    const resourceUrl = findResource(moduleItem, toolId);
    if (!tool || !resourceUrl) {
        return "#";
    }
    return tool.buildImportUrl(resourceUrl, moduleItem);
}

function createToolLink(moduleItem, toolId) {
    const link = document.createElement("a");
    link.className = "tool-link";
    link.href = buildImportUrl(moduleItem, toolId);

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = tools[toolId].name;
    link.append(label);
    return link;
}

function renderModuleCard(moduleItem) {
    const card = document.createElement("article");
    card.className = "module-card";

    const head = document.createElement("div");
    head.className = "module-head";

    const icon = document.createElement("img");
    icon.className = "module-icon";
    icon.src = moduleItem.icon;
    icon.alt = "";
    icon.width = 58;
    icon.height = 58;
    icon.loading = "lazy";
    icon.decoding = "async";

    const heading = document.createElement("h3");
    heading.textContent = moduleItem.name;
    head.append(icon, heading);

    const description = document.createElement("p");
    description.textContent = moduleItem.description || "";

    const details = document.createElement("details");
    details.className = "import-group import-panel";

    const summary = document.createElement("summary");
    summary.className = "button primary import-toggle";
    summary.textContent = "安装";

    const toggleIcon = document.createElement("span");
    toggleIcon.className = "import-toggle-icon";
    toggleIcon.setAttribute("aria-hidden", "true");
    toggleIcon.textContent = "+";
    summary.append(toggleIcon);

    const toolGrid = document.createElement("div");
    toolGrid.className = "tool-grid";
    for (const toolId of ["egern", "loon", "surge", "qx"]) {
        toolGrid.append(createToolLink(moduleItem, toolId));
    }
    details.append(summary, toolGrid);

    const linkRow = document.createElement("div");
    linkRow.className = "link-row";

    const folderLink = document.createElement("a");
    folderLink.className = "button secondary folder-link";
    folderLink.href = moduleItem.githubFolder;
    folderLink.target = "_blank";
    folderLink.rel = "noreferrer";
    folderLink.textContent = "查看代码";
    linkRow.append(folderLink);

    card.append(head, description, details, linkRow);
    return card;
}

function renderModules() {
    const list = document.getElementById("module-list");
    list.replaceChildren(...modules.map(renderModuleCard));
}
renderModules();
