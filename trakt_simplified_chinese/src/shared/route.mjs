import * as commonUtils from "../utils/common.mjs";

const DEFAULT_HOST_PATTERN = /^apiz?\.trakt\.tv$/i;

function createRoute(definition) {
    const hostPattern = definition.host ? definition.host : DEFAULT_HOST_PATTERN;

    return {
        id: definition.id,
        test(context) {
            const host = String(context.url.hostname).toLowerCase();
            if (!hostPattern.test(host)) {
                return false;
            }

            const pathname = context.url.shortPathname ?? commonUtils.normalizePathname(context.url.pathname);
            return definition.pattern.test(pathname);
        },
        handler: definition.handler,
        describe() {
            return definition.id;
        },
    };
}

async function dispatchRoutes(routesProvider) {
    for (const route of routesProvider()) {
        if (route.test(globalThis.$ctx)) {
            return route.handler();
        }
    }
    return { type: "passThrough" };
}

export { createRoute, DEFAULT_HOST_PATTERN, dispatchRoutes };
