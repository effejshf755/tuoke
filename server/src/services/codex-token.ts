import { encrypt, decrypt } from '../lib/crypto.js';


export function encryptCodexToken(token: string) {
  return encrypt(token);
}


export function decryptCodexToken(
  encrypted: string,
  iv: string,
  authTag: string,
) {
  return decrypt(
    encrypted,
    iv,
    authTag,
  );
}