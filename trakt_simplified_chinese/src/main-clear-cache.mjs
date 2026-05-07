import { Env } from "../../scripts/vendor/Env.module.mjs";

import { TRAKT_SCRIPT_TITLE } from "./module-manifest.mjs";
import { UNIFIED_CACHE_KEY } from "./utils/cache.mjs";

const env = new Env(TRAKT_SCRIPT_TITLE);

(() => {
    const cleared = env.setdata(null, UNIFIED_CACHE_KEY);

    if (cleared) {
        env.msg(TRAKT_SCRIPT_TITLE, "本地缓存已清除", "");
    } else {
        env.msg(TRAKT_SCRIPT_TITLE, "本地缓存清除失败", "");
    }

    env.done({});
})();
