import assert from "node:assert/strict";
import test from "node:test";
import { buildV2OverrideFields, buildV2StringEntries, parseArgs, runMigration } from "../scripts/migrate-cache-v2.mjs";
import { FOUND_TTL_MS } from "../trakt_simplified_chinese/src/utils/cache.mjs";

function assertFoundTranslationEntry(entry, key, title) {
    assert.equal(entry.key, key);
    assert.equal(entry.value.status, 1);
    assert.deepEqual(entry.value.translation, { title, overview: null, tagline: null });
    assert.ok(entry.value.expiresAt > Date.now());
    assert.ok(entry.value.expiresAt <= Date.now() + FOUND_TTL_MS);
}

function assertFoundImageEntry(entry, key, url) {
    assert.equal(entry.key, key);
    assert.equal(entry.value.poster.status, 1);
    assert.equal(entry.value.poster.url, url);
    assert.ok(entry.value.poster.expiresAt > Date.now());
    assert.ok(entry.value.poster.expiresAt <= Date.now() + FOUND_TTL_MS);
}

test("migrate-cache-v2 把翻译 JSON 文档展开为 locale String key", () => {
    const entries = buildV2StringEntries("trakt:translation:movies:123", {
        cn: { status: 1, translation: { title: "简体" } },
        tw: { status: 1, translation: { title: "台灣" } },
    });
    assert.equal(entries.length, 2);
    assertFoundTranslationEntry(entries[0], "translation:movies:123:cn", "简体");
    assertFoundTranslationEntry(entries[1], "translation:movies:123:tw", "台灣");
});

test("migrate-cache-v2 兼容旧根字段、图片和 credits", () => {
    const [person] = buildV2StringEntries("trakt:person-name:42", { name: { sourceTextHash: "hash", translatedText: "姓名", source: "tmdb" } });
    assert.equal(person.key, "person:name:42:cn");
    assert.equal(person.value.status, 1);
    assert.equal(person.value.name, "姓名");
    assert.equal(person.value.sourceTextHash, "hash");
    assert.equal(person.value.source, "tmdb");
    assert.ok(person.value.expiresAt > Date.now());
    assert.equal(person.value.providers, undefined);

    assert.deepEqual(buildV2StringEntries("trakt:person-name:43", { notFound: { expiresAt: 1760000000000 } }), [
        {
            key: "person:name:43:cn",
            value: { status: 3, expiresAt: 1760000000000, tmdbMissing: true },
        },
    ]);
    const [booleanNotFound] = buildV2StringEntries("trakt:person-name:44", { notFound: true });
    assert.equal(booleanNotFound.key, "person:name:44:cn");
    assert.equal(booleanNotFound.value.status, 3);
    assert.equal(booleanNotFound.value.tmdbMissing, true);
    assert.ok(booleanNotFound.value.expiresAt > Date.now());
    const [chineseImage] = buildV2StringEntries("trakt:image:chinese:movies:123", { poster: { status: 1, url: "https://img/movie.jpg" } });
    assertFoundImageEntry(chineseImage, "image:chinese:movies:123:cn", "https://img/movie.jpg");
    const [legacyChineseImage] = buildV2StringEntries("trakt:image:movies:123", { poster: { status: 1, url: "https://img/movie.jpg" } });
    assertFoundImageEntry(legacyChineseImage, "image:chinese:movies:123:cn", "https://img/movie.jpg");
    const [originalImage] = buildV2StringEntries("original:movies:123", { poster: { status: 1, url: "https://img/movie.jpg" } });
    assertFoundImageEntry(originalImage, "image:original:movies:123:cn", "https://img/movie.jpg");
    const [credit] = buildV2StringEntries("trakt:credit:movies:123", { subject: { title: "电影" } });
    assert.equal(credit.key, "credit:movies:123");
    assert.equal(credit.value.subject.title, "电影");
    assert.ok(credit.value.expiresAt > Date.now());
});

test("migrate-cache-v2 同时保留旧 cn 根字段和已有 tw 数据", () => {
    const entries = buildV2StringEntries("trakt:translation:movies:123", {
        status: 1,
        translation: { title: "旧根简体" },
        tw: { status: 1, translation: { title: "台灣" } },
    });
    assert.equal(entries.length, 2);
    assertFoundTranslationEntry(entries[0], "translation:movies:123:cn", "旧根简体");
    assertFoundTranslationEntry(entries[1], "translation:movies:123:tw", "台灣");

    const fields = buildV2OverrideFields({
        movies: {
            123: {
                translation: { title: "旧根人工" },
                tw: { translation: { title: "台灣人工" } },
                updatedAt: 1710000000000,
            },
        },
    });
    assert.deepEqual(Object.keys(fields).sort(), ["movies:123:cn", "movies:123:tw"]);
});

test("migrate-cache-v2 把旧的永久 expiresAt:null 转为 365 天", () => {
    const [translation] = buildV2StringEntries("trakt:translation:movies:124", {
        cn: { status: 1, translation: { title: "永久翻译" }, expiresAt: null },
    });
    assertFoundTranslationEntry(translation, "translation:movies:124:cn", "永久翻译");

    const [image] = buildV2StringEntries("trakt:image:chinese:movies:124", {
        poster: { status: 1, url: "https://img/permanent.jpg", expiresAt: null },
    });
    assertFoundImageEntry(image, "image:chinese:movies:124:cn", "https://img/permanent.jpg");
});

test("migrate-cache-v2 把旧 overrides 文档展开为 Hash fields", () => {
    const fields = buildV2OverrideFields({
        movies: {
            123: {
                cn: { translation: { title: "人工" } },
                tw: { translation: { title: "人工台灣" } },
                updatedAt: 1710000000000,
            },
        },
        episodes: {
            "301:1:1": { translation: { title: "旧根字段" }, updatedAt: 1710000001000 },
        },
        shows: {
            "555:1": { cn: { translation: { title: "第一季人工" } }, updatedAt: 1710000002000 },
        },
    });
    assert.deepEqual(Object.keys(fields).sort(), ["episodes:301:1:1:cn", "movies:123:cn", "movies:123:tw", "shows:555:1:cn"]);
    assert.deepEqual(JSON.parse(fields["shows:555:1:cn"]), { translation: { title: "第一季人工" }, updatedAt: 1710000002000 });
    assert.deepEqual(JSON.parse(fields["movies:123:cn"]), { translation: { title: "人工" }, updatedAt: 1710000000000 });
});

test("migrate-cache-v2 参数默认 dry-run，execute 显式开启", () => {
    assert.equal(parseArgs([]).execute, false);
    assert.equal(parseArgs(["--execute"]).execute, true);
    assert.equal(parseArgs(["--redis-url", "redis://localhost:6380"]).redisUrl, "redis://localhost:6380");
    assert.equal(parseArgs(["--max-output-keys", "1000"]).maxOutputKeys, 1000);
    assert.equal(parseArgs(["--max-output-bytes", "1048576"]).maxOutputBytes, 1048576);
});

function createFakeRedis(initial, stringKeys = new Set(), ttlByKey = new Map()) {
    const strings = new Map(initial);
    const hashes = new Map();
    const msetCommands = [];
    const delCommands = [];
    return {
        strings,
        hashes,
        msetCommands,
        delCommands,
        async scan(_cursor, _match, pattern) {
            const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
            return ["0", [...strings.keys()].filter((key) => regex.test(key))];
        },
        async call(command, key) {
            const value = strings.get(key);
            if (value === undefined) {
                return null;
            }
            if (command === "GET") {
                return value;
            }
            if (stringKeys.has(key)) {
                throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
            }
            return JSON.stringify([JSON.parse(value)]);
        },
        async pttl(key) {
            return ttlByKey.has(key) ? ttlByKey.get(key) : -1;
        },
        async mset(...pairs) {
            msetCommands.push(pairs);
            for (let index = 0; index < pairs.length; index += 2) {
                strings.set(pairs[index], pairs[index + 1]);
            }
            return "OK";
        },
        async hset(key, ...pairs) {
            const hash = hashes.get(key) || new Map();
            for (let index = 0; index < pairs.length; index += 2) {
                hash.set(pairs[index], pairs[index + 1]);
            }
            hashes.set(key, hash);
            return pairs.length / 2;
        },
        async del(...keys) {
            delCommands.push(keys);
            let deleted = 0;
            keys.forEach((key) => {
                if (strings.delete(key)) {
                    deleted += 1;
                }
            });
            return deleted;
        },
    };
}

test("migrate-cache-v2 迁移两代旧图片 key 并清理原 key", async () => {
    const fake = createFakeRedis(
        new Map([
            ["original:movies:123", JSON.stringify({ poster: { status: 1 } })],
            ["trakt:image:movies:456", JSON.stringify({ poster: { status: 1 } })],
            ["trakt:image:chinese:shows:789", JSON.stringify({ logo: { status: 1 } })],
            ["trakt:image:original:seasons:42:1", JSON.stringify({ poster: { status: 1 } })],
        ]),
    );
    const stats = await runMigration(fake, { execute: true, maxOutputBytes: 1_000_000 });
    assert.equal(stats.newStringKeys, 4);
    assert.equal(fake.strings.has("image:original:movies:123:cn"), true);
    assert.equal(fake.strings.has("image:chinese:movies:456:cn"), true);
    assert.equal(fake.strings.has("image:chinese:shows:789:cn"), true);
    assert.equal(fake.strings.has("image:original:seasons:42:1:cn"), true);
    assert.equal(fake.strings.has("original:movies:123"), false);
    assert.equal(fake.strings.has("trakt:image:movies:456"), false);
    assert.equal(fake.strings.has("trakt:image:chinese:shows:789"), false);
    assert.equal(fake.strings.has("trakt:image:original:seasons:42:1"), false);
});

test("migrate-cache-v2 在数据缺少 expiresAt 时保留旧 key 的 PTTL", async () => {
    const legacyKey = "trakt:translation:movies:123";
    const fake = createFakeRedis(new Map([[legacyKey, JSON.stringify({ cn: { status: 1, translation: { title: "简体" } } })]]), new Set(), new Map([[legacyKey, 45_000]]));
    const before = Date.now();

    const stats = await runMigration(fake, { execute: true, maxOutputBytes: 1_000_000 });

    assert.equal(stats.newStringKeys, 1);
    const migrated = JSON.parse(fake.strings.get("translation:movies:123:cn"));
    assert.ok(migrated.expiresAt >= before + 40_000, "expected the legacy PTTL to become expiresAt");
    assert.ok(migrated.expiresAt <= Date.now() + 45_000, "expected the legacy PTTL to remain bounded");
    assert.equal(fake.strings.has(legacyKey), false);
});

test("migrate-cache-v2 保留布尔 notFound 的 PTTL", async () => {
    const legacyKey = "trakt:person-name:44";
    const fake = createFakeRedis(new Map([[legacyKey, JSON.stringify({ notFound: true })]]), new Set(), new Map([[legacyKey, 12_000]]));
    const before = Date.now();

    await runMigration(fake, { execute: true, maxOutputBytes: 1_000_000 });

    const migrated = JSON.parse(fake.strings.get("person:name:44:cn"));
    assert.equal(migrated.status, 3);
    assert.equal(migrated.tmdbMissing, true);
    assert.ok(migrated.expiresAt >= before + 10_000);
    assert.ok(migrated.expiresAt <= Date.now() + 12_000);
});

test("migrate-cache-v2 在写入前执行输出门禁", async () => {
    const fake = createFakeRedis(
        new Map([
            ["trakt:translation:movies:123", JSON.stringify({ cn: { status: 1, translation: { title: "简体" } } })],
            ["trakt:translation:movies:456", JSON.stringify({ cn: { status: 1, translation: { title: "另一部" } } })],
        ]),
    );

    await assert.rejects(() => runMigration(fake, { execute: true, maxOutputKeys: 1, maxOutputBytes: 1_000_000 }), /max-output-keys/);
    assert.equal(fake.msetCommands.length, 0);
    assert.equal(fake.delCommands.length, 0);
});

test("migrate-cache-v2 execute 必须提供字节安全门禁", async () => {
    const fake = createFakeRedis(new Map([["trakt:translation:movies:123", JSON.stringify({ cn: { status: 1, translation: { title: "简体" } } })]]));
    await assert.rejects(() => runMigration(fake, { execute: true }), /--max-output-bytes/);
    assert.equal(fake.strings.has("translation:movies:123:cn"), false);
});

test("migrate-cache-v2 兼容旧 String JSON，并跳过非 JSON String", async () => {
    const validKey = "trakt:translation:movies:123";
    const invalidKey = "trakt:translation:movies:999";
    const overridesKey = "trakt:translation:overrides";
    const fake = createFakeRedis(
        new Map([
            [validKey, JSON.stringify({ cn: { status: 1, translation: { title: "旧字符串简体" } } })],
            [invalidKey, "not-json"],
            [overridesKey, JSON.stringify({ movies: { 123: { cn: { translation: { title: "旧字符串人工" } }, updatedAt: 1 } } })],
        ]),
        new Set([validKey, invalidKey, overridesKey]),
    );

    const stats = await runMigration(fake, { execute: true, maxOutputBytes: 1_000_000 });

    assert.equal(stats.legacyKeys, 3);
    assert.equal(stats.newStringKeys, 1);
    assert.equal(stats.skippedKeys, 1);
    assert.equal(stats.overrideFields, 1);
    assert.equal(fake.strings.has("translation:movies:123:cn"), true);
    assert.equal(fake.strings.has(validKey), false);
    assert.equal(fake.strings.has(invalidKey), true);
    assert.equal(fake.strings.has(overridesKey), false);
    assert.equal(fake.hashes.get("translation:overrides").get("movies:123:cn").includes("旧字符串人工"), true);
});

test("migrate-cache-v2 dry-run 不写入，execute 可重复执行", async () => {
    const fake = createFakeRedis(
        new Map([
            ["trakt:translation:movies:123", JSON.stringify({ cn: { status: 1, translation: { title: "简体" } } })],
            ["trakt:translation:overrides", JSON.stringify({ movies: { 123: { cn: { translation: { title: "人工" } }, updatedAt: 1 } } })],
        ]),
    );

    const dryRun = await runMigration(fake, { execute: false });
    assert.equal(dryRun.newStringKeys, 1);
    assert.equal(dryRun.overrideFields, 1);
    assert.equal(fake.strings.has("translation:movies:123:cn"), false);

    const executed = await runMigration(fake, { execute: true, maxOutputBytes: 1_000_000 });
    assert.equal(executed.deletedLegacyKeys, 2);
    assert.equal(fake.strings.has("translation:movies:123:cn"), true);
    assert.equal(fake.hashes.get("translation:overrides").get("movies:123:cn").includes("人工"), true);

    const repeated = await runMigration(fake, { execute: true, maxOutputBytes: 1_000_000 });
    assert.equal(repeated.legacyKeys, 0);
    assert.equal(repeated.newStringKeys, 0);
});
