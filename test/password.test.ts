import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "../src/server/password.ts";

describe("Password Authentication Core (scrypt)", () => {
    it("hashes and verifies matching password", async () => {
        const password = "SuperSecretPassword123!";
        const hash = await hashPassword(password);

        assert.ok(hash.startsWith("scrypt$"), "hash must start with scrypt$");
        const parts = hash.split("$");

        assert.equal(parts.length, 3, "format: scrypt$salt$derivedKey");
        assert.equal(parts[1]!.length, 32, "salt hex length (16 bytes)");
        assert.equal(parts[2]!.length, 128, "derivedKey hex length (64 bytes)");

        const valid = await verifyPassword(password, hash);

        assert.equal(valid, true, "matching password must verify true");
    });

    it("rejects non-matching password", async () => {
        const password = "CorrectPassword";
        const hash = await hashPassword(password);

        const valid = await verifyPassword("WrongPassword", hash);

        assert.equal(valid, false, "wrong password must verify false");
    });

    it("handles two different hashes for same password due to random salt", async () => {
        const password = "IdenticalPassword";
        const hash1 = await hashPassword(password);
        const hash2 = await hashPassword(password);

        assert.notEqual(hash1, hash2, "hashes must have distinct salts");
        assert.equal(await verifyPassword(password, hash1), true);
        assert.equal(await verifyPassword(password, hash2), true);
    });

    it("rejects malformed hashes safely without throwing", async () => {
        assert.equal(await verifyPassword("password", ""), false);
        assert.equal(await verifyPassword("password", "md5$notvalid"), false);
        assert.equal(await verifyPassword("password", "scrypt$short"), false);
        assert.equal(await verifyPassword("password", "scrypt$invalidhex$invalidhex"), false);
    });

    it("enforces minimum password length in hashPassword", async () => {
        await assert.rejects(async () => {
            await hashPassword("short");
        }, /at least 6 characters/);
    });
});
