// 获取响应体
let body = $response.body;

// 获取 Loon 插件面板传入的文本参数
let preferredLanguage = "zh-CN";

if (typeof $argument === "object") {
    preferredLanguage = $argument.preferredLanguage.trim();
} else if (typeof $argument === "string") {
    preferredLanguage = $argument.replace(/^\[|\]$/g, "").trim();
}

try {
    const obj = JSON.parse(body);

    // 确保响应体包含 images 字段
    if (obj?.images) {
        let targetLang = null;
        let targetRegion = null;

        // 解析用户输入的语言代码 (例如从 "zh-CN" 提取 lang="zh", region="CN")
        const match = preferredLanguage.match(/([a-zA-Z]{2})(?:-([a-zA-Z]{2}))?/);
        if (match) {
            targetLang = match[1] ? match[1].toLowerCase() : null;
            targetRegion = match[2] ? match[2].toUpperCase() : null;
        }

        // 提取成功后执行打分排序
        if (targetLang) {
            const sortImages = (a, b) => {
                const getScore = (item) => {
                    let score = 0;
                    const itemLang = item.iso_639_1 ? item.iso_639_1.toLowerCase() : null;
                    const itemRegion = item.iso_3166_1 ? item.iso_3166_1.toUpperCase() : null;

                    if (itemLang === targetLang) {
                        // 语言和地区双重精确匹配 (2分)
                        if (targetRegion && itemRegion === targetRegion) {
                            score = 2;
                        }
                        // 仅语言匹配 (1分)
                        else {
                            score = 1;
                        }
                    }
                    return score;
                };

                return getScore(b) - getScore(a);
            };

            // 批量应用排序逻辑到海报、背景和 Logo
            const imageTypes = ["logos", "posters", "backdrops"];
            imageTypes.forEach((type) => {
                if (Array.isArray(obj.images[type])) {
                    obj.images[type].sort(sortImages);
                }
            });

            // 将修改后的对象转回 JSON 字符串
            body = JSON.stringify(obj);
        }
    }

    // 返回修改后的 body
    $done({ body });
} catch (e) {
    console.log(`TMDB 图片自定义排序脚本错误: ${e}`);
    $done({});
}
