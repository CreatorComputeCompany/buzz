import nacl from "tweetnacl";

if (globalThis.crypto?.getRandomValues) {
  nacl.setPRNG((bytes, count) => {
    globalThis.crypto.getRandomValues(
      bytes.subarray(0, count) as Uint8Array<ArrayBuffer>,
    );
  });
}

export function createSharedKey(serverPublicKeyB64: string) {
  const pair = nacl.box.keyPair();
  const serverPublicKey = fromBase64(serverPublicKeyB64);
  if (serverPublicKey.length !== nacl.box.publicKeyLength) {
    throw new Error("Invalid Orca server public key.");
  }
  return {
    publicKeyB64: toBase64(pair.publicKey),
    sharedKey: nacl.box.before(serverPublicKey, pair.secretKey),
  };
}

export function encryptOrcaMessage(value: unknown, sharedKey: Uint8Array) {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = nacl.box.after(plaintext, nonce, sharedKey);
  const bundle = new Uint8Array(nonce.length + ciphertext.length);
  bundle.set(nonce);
  bundle.set(ciphertext, nonce.length);
  return toBase64(bundle);
}

export function decryptOrcaMessage(
  value: string,
  sharedKey: Uint8Array,
): unknown | null {
  const bundle = fromBase64(value);
  if (bundle.length < nacl.box.nonceLength + nacl.box.overheadLength) {
    return null;
  }
  const plaintext = nacl.box.open.after(
    bundle.slice(nacl.box.nonceLength),
    bundle.slice(0, nacl.box.nonceLength),
    sharedKey,
  );
  if (!plaintext) return null;
  return JSON.parse(new TextDecoder().decode(plaintext));
}

function fromBase64(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return globalThis.btoa(binary);
}
