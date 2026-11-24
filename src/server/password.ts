import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const SALT_BYTES = 16;
const KEY_LEN = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 };
const PREFIX = "scrypt$";

export const MIN_PASSWORD_LENGTH = 6;

function scryptAsync(
    password: string,
    salt: Buffer,
    keyLen: number,
    options: { N: number; r: number; p: number },
): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        scrypt(password, salt, keyLen, options, (err, derivedKey) => {
            if (err) {
                reject(err);
            } else {
                resolve(derivedKey);
            }
        });
    });
}

/**
 * Hash a password using Node.js native crypto.scrypt with a random 16-byte salt.
 * Returns formatted string: "scrypt$<saltHex>$<derivedKeyHex>".
 */
export async function hashPassword(password: string): Promise<string> {
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
        throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }

    const salt = randomBytes(SALT_BYTES);
    const derivedKey = (await scryptAsync(password, salt, KEY_LEN, SCRYPT_OPTIONS)) as Buffer;

    return `${PREFIX}${salt.toString("hex")}$${derivedKey.toString("hex")}`;
}

/**
 * Verify a plaintext password against a stored scrypt hash.
 * Timing-safe, returns false gracefully on mismatch or malformed hash format.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
    if (
        typeof password !== "string" ||
        typeof storedHash !== "string" ||
        !storedHash.startsWith(PREFIX)
    ) {
        return false;
    }

    const parts = storedHash.slice(PREFIX.length).split("$");

    if (parts.length !== 2) {
        return false;
    }

    const saltHex = parts[0]!;
    const keyHex = parts[1]!;

    if (saltHex.length !== SALT_BYTES * 2 || keyHex.length !== KEY_LEN * 2) {
        return false;
    }

    try {
        const salt = Buffer.from(saltHex, "hex");
        const expectedKey = Buffer.from(keyHex, "hex");

        const actualKey = (await scryptAsync(
            password,
            salt,
            KEY_LEN,
            SCRYPT_OPTIONS,
        )) as Buffer;

        return timingSafeEqual(actualKey, expectedKey);
    } catch {
        return false;
    }
}
