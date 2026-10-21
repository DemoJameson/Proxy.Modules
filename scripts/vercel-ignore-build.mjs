import { execFileSync } from "node:child_process";

const previousSha = String(process.env.VERCEL_GIT_PREVIOUS_SHA || "").trim();
const base = previousSha || "HEAD^";
const deployPaths = ["api", "lib", "public", "vercel.json", "package.json", "package-lock.json", "scripts/vercel-ignore-build.mjs"];

try {
    execFileSync("git", ["diff", "--quiet", base, "HEAD", "--", ...deployPaths], { stdio: "ignore" });
    process.exit(0);
} catch (error) {
    // 1 表示存在部署相关改动；其它错误（例如浅克隆缺少基准 SHA）按需要构建处理。
    if (error && typeof error === "object" && error.status === 1) {
        process.exit(1);
    }
    console.error(`Vercel ignore check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}
