// Encryption for Reddit tokens at rest in KV, and signing for the OAuth
// `state` parameter. Both keys are derived from the single
// TOKEN_ENCRYPTION_KEY secret with HKDF, so one secret covers both uses
// without reusing the same key material for two purposes.
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function deriveKey(secret, info, algorithm, usages) {
  if (!secret) throw new Error("TOKEN_ENCRYPTION_KEY is not set.");
  const baseKey = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(info) },
    baseKey,
    algorithm,
    false,
    usages
  );
}

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(str) {
  const binary = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function encryptJson(secret, value) {
  const key = await deriveKey(secret, "token-encryption", { name: "AES-GCM", length: 256 }, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(value)));
  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptJson(secret, sealed) {
  const [iv, ciphertext] = sealed.split(".");
  const key = await deriveKey(secret, "token-encryption", { name: "AES-GCM", length: 256 }, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(iv) },
    key,
    fromBase64Url(ciphertext)
  );
  return JSON.parse(decoder.decode(plaintext));
}

function hmacKey(secret, usage) {
  return deriveKey(secret, "oauth-state", { name: "HMAC", hash: "SHA-256" }, [usage]);
}

// Returns `payload.signature`, both base64url. Tamper-proof but not secret,
// so never put anything sensitive in the payload.
export async function signPayload(secret, payload) {
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), encoder.encode(body));
  return `${body}.${toBase64Url(new Uint8Array(signature))}`;
}

// Returns the payload if the signature is valid, otherwise null.
export async function verifyPayload(secret, token) {
  const [body, signature] = String(token ?? "").split(".");
  if (!body || !signature) return null;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret, "verify"),
      fromBase64Url(signature),
      encoder.encode(body)
    );
    return valid ? JSON.parse(decoder.decode(fromBase64Url(body))) : null;
  } catch {
    return null;
  }
}
