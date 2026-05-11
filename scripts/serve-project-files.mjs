import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const projectPrefix = `/${rootDir.split(/[\\/]/).at(-1)}`;
// Intentionally bind to all interfaces so mobile proxy clients on the LAN can fetch local module files.
const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 8080);

const contentTypes = new Map([
    [".css", "text/css; charset=utf-8"],
    [".html", "text/html; charset=utf-8"],
    [".js", "text/javascript; charset=utf-8"],
    [".json", "application/json; charset=utf-8"],
    [".mjs", "text/javascript; charset=utf-8"],
    [".png", "image/png"],
    [".sgmodule", "text/plain; charset=utf-8"],
    [".snippet", "text/plain; charset=utf-8"],
    [".svg", "image/svg+xml; charset=utf-8"],
    [".webp", "image/webp"],
]);

function setNoCacheHeaders(res) {
    res.removeHeader("ETag");
    res.removeHeader("Last-Modified");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0, no-transform");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
}

function sendText(res, statusCode, text) {
    res.writeHead(statusCode, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": Buffer.byteLength(text),
    });
    res.end(text);
}

function resolveRequestPath(req) {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === "/health") {
        return { health: true };
    }

    if (!pathname.startsWith(`${projectPrefix}/`)) {
        return {
            error: `Path must start with ${projectPrefix}/`,
            statusCode: 404,
        };
    }

    const relativePath = pathname.slice(projectPrefix.length + 1);
    const filePath = resolve(rootDir, relativePath);
    const relativeToRoot = relative(rootDir, filePath);
    const isInsideRoot = relativeToRoot && !relativeToRoot.startsWith("..") && !relativeToRoot.includes(`..${sep}`);

    if (!isInsideRoot) {
        return {
            error: "Path is outside project root",
            statusCode: 403,
        };
    }

    return { filePath };
}

async function handleRequest(req, res) {
    setNoCacheHeaders(res);

    if (req.method !== "GET" && req.method !== "HEAD") {
        res.setHeader("Allow", "GET, HEAD");
        sendText(res, 405, "Method Not Allowed\n");
        return;
    }

    const resolvedPath = resolveRequestPath(req);

    if (resolvedPath.health) {
        sendText(res, 200, "ok\n");
        return;
    }

    if (resolvedPath.error) {
        sendText(res, resolvedPath.statusCode, `${resolvedPath.error}\n`);
        return;
    }

    try {
        const fileStats = await stat(resolvedPath.filePath);

        if (!fileStats.isFile()) {
            sendText(res, 404, "Not Found\n");
            return;
        }

        res.writeHead(200, {
            "Content-Type": contentTypes.get(extname(resolvedPath.filePath)) || "application/octet-stream",
            "Content-Length": fileStats.size,
        });

        if (req.method === "HEAD") {
            res.end();
            return;
        }

        createReadStream(resolvedPath.filePath).pipe(res);
    } catch (error) {
        if (error?.code === "ENOENT") {
            sendText(res, 404, "Not Found\n");
            return;
        }

        console.error(error);
        sendText(res, 500, "Internal Server Error\n");
    }
}

const server = createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
        console.error(error);
        setNoCacheHeaders(res);
        sendText(res, 500, "Internal Server Error\n");
    });
});

server.listen(port, host, () => {
    console.log(`Serving ${rootDir}`);
    console.log(`URL prefix: ${projectPrefix}/`);
    console.log(`Listening on http://${host}:${port}`);
});
