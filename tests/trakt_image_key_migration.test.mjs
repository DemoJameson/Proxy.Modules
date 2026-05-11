import assert from "node:assert/strict";
import test from "node:test";

import { runMigration } from "../scripts/migrate-trakt-image-cache-keys.mjs";

const TEST_CONFIG = {
    url: "https://kv.example",
    token: "test-token",
};

function createRedisFetch(store) {
    return async (url, init = {}) => {
        const parsed = new URL(url);
        assert.equal(parsed.pathname, "/pipeline");
        assert.equal(init.headers.Authorization, "Bearer test-token");
        const commands = JSON.parse(init.body || "[]");
        store.pipelineRequests = [...(store.pipelineRequests || []), commands];
        const results = [];

        for (const command of commands) {
            const [name] = command;
            if (name === "SCAN") {
                store.scanCommands = [...(store.scanCommands || []), command];
                const cursor = Number.parseInt(command[1] || "0", 10) || 0;
                const matchIndex = command.indexOf("MATCH");
                const countIndex = command.indexOf("COUNT");
                const match = matchIndex >= 0 ? command[matchIndex + 1] || "" : "";
                const count = countIndex >= 0 ? Number.parseInt(command[countIndex + 1] || "10", 10) || 10 : 10;
                const prefix = match.endsWith("*") ? match.slice(0, -1) : match;
                const keys = Array.from(store.keys()).filter((key) => key.startsWith(prefix));
                const nextCursor = cursor + count >= keys.length ? "0" : String(cursor + count);
                results.push([nextCursor, keys.slice(cursor, cursor + count)]);
            } else if (name === "RENAME") {
                store.renameCommands = [...(store.renameCommands || []), command];
                const [, from, to] = command;
                if (!store.has(from)) {
                    return {
                        ok: true,
                        json: async () => [{ error: "ERR no such key" }],
                    };
                }
                store.set(to, store.get(from));
                store.delete(from);
                if (store.ttlByKey?.has(from)) {
                    store.ttlByKey.set(to, store.ttlByKey.get(from));
                    store.ttlByKey.delete(from);
                }
                results.push("OK");
            } else {
                results.push(null);
            }
        }

        return {
            ok: true,
            json: async () => results.map((result) => ({ result })),
        };
    };
}

test("trakt image key migration dry-run 只扫描旧命名空间", async () => {
    const store = new Map([
        ["original:movies:123", { value: "original movie" }],
        ["trakt:image:movies:123", { value: "chinese movie" }],
        ["trakt:image:chinese:movies:456", { value: "new chinese movie" }],
        ["trakt:image:original:movies:789", { value: "new original movie" }],
    ]);

    const summary = await runMigration({
        config: TEST_CONFIG,
        fetch: createRedisFetch(store),
        scanCount: 2,
    });

    assert.equal(summary.mode, "dry-run");
    assert.equal(summary.scanned, 2);
    assert.equal(summary.plannedRenames, 2);
    assert.equal(summary.executedRenames, 0);
    assert.equal(store.renameCommands, undefined);
    assert.deepEqual(
        store.scanCommands.map((command) => command[3]),
        ["original:movies:*", "original:shows:*", "original:seasons:*", "trakt:image:movies:*", "trakt:image:shows:*", "trakt:image:seasons:*"],
    );
});

test("trakt image key migration execute 使用 RENAME 直接覆盖并保留 TTL", async () => {
    const store = new Map([
        ["original:movies:123", { value: "fresh original movie" }],
        ["trakt:image:original:movies:123", { value: "stale original movie" }],
        ["trakt:image:movies:123", { value: "fresh chinese movie" }],
        ["trakt:image:chinese:movies:123", { value: "stale chinese movie" }],
    ]);
    store.ttlByKey = new Map([
        ["original:movies:123", 12345],
        ["trakt:image:movies:123", 67890],
    ]);

    const summary = await runMigration({
        config: TEST_CONFIG,
        fetch: createRedisFetch(store),
        execute: true,
        scanCount: 10,
        renameBatchSize: 1,
    });

    assert.equal(summary.mode, "execute");
    assert.equal(summary.scanned, 2);
    assert.equal(summary.plannedRenames, 2);
    assert.equal(summary.executedRenames, 2);
    assert.deepEqual(store.renameCommands, [
        ["RENAME", "original:movies:123", "trakt:image:original:movies:123"],
        ["RENAME", "trakt:image:movies:123", "trakt:image:chinese:movies:123"],
    ]);
    assert.equal(store.has("original:movies:123"), false);
    assert.equal(store.has("trakt:image:movies:123"), false);
    assert.deepEqual(store.get("trakt:image:original:movies:123"), { value: "fresh original movie" });
    assert.deepEqual(store.get("trakt:image:chinese:movies:123"), { value: "fresh chinese movie" });
    assert.equal(store.ttlByKey.get("trakt:image:original:movies:123"), 12345);
    assert.equal(store.ttlByKey.get("trakt:image:chinese:movies:123"), 67890);
});
