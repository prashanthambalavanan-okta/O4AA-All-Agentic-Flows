// Display-only decoding for the step cards' "Decoded" view: URL-decode form bodies and
// query strings, and expand JWT strings into their header + payload. Never used for
// anything sent on the wire — the Raw view and the cURL tab keep the exact bytes.
import { decodeJwt, looksLikeJwt } from './decodeJwt.js';

const isForm = (headers) =>
  (headers?.['Content-Type'] || headers?.['content-type'] || '').toLowerCase().includes('x-www-form-urlencoded');

/** "a=1&b=x%3Ay" → "a=1\n&b=x:y" (one decoded param per line). */
export function decodeFormText(text) {
  const params = new URLSearchParams(text);
  return [...params.entries()].map(([k, v]) => `${k}=${v}`).join('\n&');
}

/** Split a URL into its base and decoded query (null when there is no query). */
export function splitUrl(url) {
  const i = typeof url === 'string' ? url.indexOf('?') : -1;
  if (i === -1) return { base: url, query: null };
  return { base: url.slice(0, i), query: decodeFormText(url.slice(i + 1)) };
}

/** Request body as displayed in the Decoded view. */
export function decodedRequestBody(body, headers) {
  if (typeof body === 'string' && isForm(headers) && body.includes('=')) return decodeFormText(body);
  return body;
}

function safeDecodeURIComponent(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// Recursively replace JWT strings with { header, payload } so a response like
// { access_token: "eyJ…", id_token: "eyJ…" } reads as claims instead of base64.
function expandJwts(value) {
  if (looksLikeJwt(value)) {
    const d = decodeJwt(value);
    return d ? { '(decoded JWT) header': d.header, '(decoded JWT) payload': d.payload } : value;
  }
  if (Array.isArray(value)) return value.map(expandJwts);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandJwts(v)]));
  }
  return value;
}

/** Response body as displayed in the Decoded view (string bodies may be JSON). */
export function decodedResponseBody(body) {
  if (typeof body === 'string') {
    try {
      return expandJwts(JSON.parse(body));
    } catch {
      return body;
    }
  }
  return expandJwts(body);
}

/** Headers with URL-valued entries (e.g. Location) decoded for reading. */
export function decodedHeaders(headers) {
  if (!headers || typeof headers !== 'object') return headers;
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k, /^location$/i.test(k) && typeof v === 'string' ? safeDecodeURIComponent(v) : v])
  );
}
