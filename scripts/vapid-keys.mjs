// Prints a new VAPID key pair. Store the values as Worker secrets; never commit them.
import { toBase64Url } from '../webpush.js';
const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
const jwk = await crypto.subtle.exportKey('jwk', privateKey);
const raw = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey));
console.log('VAPID_PUBLIC_KEY=' + toBase64Url(raw));
console.log('VAPID_PRIVATE_KEY=' + jwk.d);
