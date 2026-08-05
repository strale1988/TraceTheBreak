/**
 * TraceTheBreak photo-storage Worker.
 *
 * Sits between the browser and an R2 bucket. Never hands out R2 credentials
 * (there aren't any to hand out — Workers talk to R2 via a binding). Instead
 * it:
 *   - verifies the user's existing Supabase login token itself (HS256,
 *     checked locally against SUPABASE_JWT_SECRET — no network round trip)
 *   - lets a logged-in user PUT/DELETE objects under their own `${uid}/...`
 *     prefix (mirrors the old Supabase Storage RLS-by-path setup)
 *   - issues short-lived, HMAC-signed URLs to read an object, instead of
 *     Supabase's createSignedUrl. A signed URL only proves "someone with a
 *     valid login was allowed to ask for this path within the last N
 *     seconds" — same trust level as before.
 *
 * Routes:
 *   POST   /upload?path=<key>        body = raw image bytes
 *   DELETE /upload?path=<key>
 *   GET    /sign?path=<key>&variant=full|thumb&ttl=<seconds>
 *   GET    /o?path=<key>&variant=&exp=&sig=      (the actual signed fetch)
 */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'authorization,content-type,x-photo-content-type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { ...JSON_HEADERS, ...cors(origin) } });
}

function err(status, message, origin) {
  return json({ error: message }, status, origin);
}

// ---- base64url helpers (Workers runtime has atob/btoa but not base64url) ----
function b64urlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64url.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function textToBytes(str) {
  return new TextEncoder().encode(str);
}

// ---- verify a Supabase-issued JWT locally ----
//
// Supabase projects can sign tokens either way, and the Worker has to
// support both since which one you get depends on the project's current
// JWT Keys setting (Dashboard -> Project Settings -> API -> JWT Keys):
//   - ES256 (asymmetric, current default): verified against Supabase's
//     public JWKS, fetched over the network and cached in memory across
//     requests in the same isolate. No secret material needed on our side.
//   - HS256 (legacy shared secret): verified locally against
//     SUPABASE_JWT_SECRET, same as before, no network call. Kept for
//     projects still on the legacy setting.

let jwksCache = { keys: [], fetchedAt: 0, url: null };
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour; a forced refetch also
// happens below whenever a kid isn't found, so a mid-window key rotation
// on Supabase's end still resolves within one request, not just once an
// hour.

async function getJwks(supabaseUrl, forceRefetch) {
  const now = Date.now();
  if (!forceRefetch && jwksCache.url === supabaseUrl && jwksCache.keys.length && (now - jwksCache.fetchedAt) < JWKS_CACHE_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(`${supabaseUrl}/auth/v1/.well-known/jwks.json`);
  if (!res.ok) throw new Error(`jwks fetch failed (${res.status})`);
  const data = await res.json();
  jwksCache = { keys: (data && data.keys) || [], fetchedAt: now, url: supabaseUrl };
  return jwksCache.keys;
}

async function verifyEs256(headerB64, payloadB64, sigB64, kid, supabaseUrl) {
  let keys = await getJwks(supabaseUrl, false);
  let jwk = keys.find(k => k.kid === kid);
  if (!jwk) {
    // Not in our cache — could be a just-rotated key, so force one refetch
    // before giving up rather than waiting out the full cache TTL.
    keys = await getJwks(supabaseUrl, true);
    jwk = keys.find(k => k.kid === kid);
  }
  if (!jwk) return false;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: jwk.crv || 'P-256' }, false, ['verify']);
  // WebCrypto's ECDSA verify expects the raw r||s signature format, which
  // is exactly what a JWS ES256 signature already is — no DER conversion
  // needed here.
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64urlToBytes(sigB64), textToBytes(`${headerB64}.${payloadB64}`));
}

async function verifyHs256(headerB64, payloadB64, sigB64, secret) {
  if (!secret) return false;
  const key = await crypto.subtle.importKey('raw', textToBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, b64urlToBytes(sigB64), textToBytes(`${headerB64}.${payloadB64}`));
}

async function verifySupabaseJwt(token, env) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(headerB64)));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64)));
  } catch (e) {
    return null;
  }
  if (!payload || !payload.sub) return null;
  if (payload.exp && Date.now() / 1000 > payload.exp) return null;

  let ok = false;
  try {
    if (header.alg === 'ES256') {
      if (!env.SUPABASE_URL) return null; // required to fetch the JWKS
      ok = await verifyEs256(headerB64, payloadB64, sigB64, header.kid, env.SUPABASE_URL);
    } else if (header.alg === 'HS256') {
      ok = await verifyHs256(headerB64, payloadB64, sigB64, env.SUPABASE_JWT_SECRET);
    } else {
      return null; // unsupported/unexpected alg
    }
  } catch (e) {
    return null;
  }
  return ok ? payload : null;
}

async function requireUser(request, env) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  return verifySupabaseJwt(token, env);
}

async function isAdmin(uid, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return false;
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}&select=is_admin`, {
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
    });
    if (!res.ok) return false;
    const rows = await res.json();
    return !!(rows && rows[0] && rows[0].is_admin);
  } catch (e) {
    return false;
  }
}

// A path may only be written/deleted by its owner (first path segment must
// be their uid) — this mirrors the old per-user storage-RLS folder rule.
// Admins may delete anything (needed to moderate/remove rejected photos).
function ownsPath(uid, path) {
  return path === `${uid}/${path.split('/').slice(1).join('/')}` && path.split('/')[0] === uid;
}
function pathPrefixUid(path) {
  if (path.startsWith('gallery/')) return path.split('/')[1];
  return path.split('/')[0];
}

async function hmacHex(str, secret) {
  const key = await crypto.subtle.importKey('raw', textToBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, textToBytes(str));
  return bytesToHex(sig);
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const VARIANT_TTL = { thumb: 21600, display: 21600, full: 3600 };
const CACHE_CONTROL_IMMUTABLE = 'public, max-age=31536000, immutable';

function thumbPathFor(path) {
  return path.replace(/(\.[a-zA-Z0-9]+)$/, '-thumb$1');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });

    try {
      // ---- POST /upload?path=... : store one object under the caller's own uid prefix ----
      if (url.pathname === '/upload' && request.method === 'POST') {
        const payload = await requireUser(request, env);
        if (!payload) return err(401, 'not authenticated', origin);
        const path = url.searchParams.get('path');
        if (!path) return err(400, 'missing path', origin);
        if (pathPrefixUid(path) !== payload.sub) return err(403, 'path does not belong to you', origin);

        const contentType = request.headers.get('x-photo-content-type') || request.headers.get('content-type') || 'application/octet-stream';
        const body = await request.arrayBuffer();
        if (!body.byteLength) return err(400, 'empty body', origin);
        if (body.byteLength > 6 * 1024 * 1024) return err(413, 'too large', origin);

        await env.PHOTOS_BUCKET.put(path, body, {
          httpMetadata: { contentType, cacheControl: CACHE_CONTROL_IMMUTABLE },
        });
        return json({ ok: true, path }, 200, origin);
      }

      // ---- DELETE /upload?path=... : owner or admin only ----
      if (url.pathname === '/upload' && request.method === 'DELETE') {
        const payload = await requireUser(request, env);
        if (!payload) return err(401, 'not authenticated', origin);
        const path = url.searchParams.get('path');
        if (!path) return err(400, 'missing path', origin);
        if (pathPrefixUid(path) !== payload.sub && !(await isAdmin(payload.sub, env))) {
          return err(403, 'not allowed', origin);
        }
        await env.PHOTOS_BUCKET.delete(path);
        await env.PHOTOS_BUCKET.delete(thumbPathFor(path));
        return json({ ok: true }, 200, origin);
      }

      // ---- GET /sign?path=&variant=&ttl= : mint a short-lived read URL ----
      if (url.pathname === '/sign' && request.method === 'GET') {
        const payload = await requireUser(request, env);
        if (!payload) return err(401, 'not authenticated', origin);
        const path = url.searchParams.get('path');
        const variant = url.searchParams.get('variant') || 'full';
        if (!path) return err(400, 'missing path', origin);
        const ttl = Math.min(parseInt(url.searchParams.get('ttl') || '', 10) || VARIANT_TTL[variant] || 3600, 21600);
        const exp = Math.floor(Date.now() / 1000) + ttl;
        const sig = await hmacHex(`${path}::${variant}::${exp}`, env.SIGNING_SECRET);
        const signedUrl = `${url.origin}/o?path=${encodeURIComponent(path)}&variant=${encodeURIComponent(variant)}&exp=${exp}&sig=${sig}`;
        return json({ url: signedUrl, expiresAt: exp * 1000 }, 200, origin);
      }

      // ---- GET /o?path=&variant=&exp=&sig= : the actual signed fetch, streamed from R2 ----
      if (url.pathname === '/o' && request.method === 'GET') {
        const path = url.searchParams.get('path');
        const variant = url.searchParams.get('variant') || 'full';
        const exp = parseInt(url.searchParams.get('exp') || '0', 10);
        const sig = url.searchParams.get('sig') || '';
        if (!path || !exp || !sig) return err(400, 'bad request', origin);
        if (Math.floor(Date.now() / 1000) > exp) return err(410, 'link expired', origin);
        const expected = await hmacHex(`${path}::${variant}::${exp}`, env.SIGNING_SECRET);
        if (!safeEqual(expected, sig)) return err(403, 'bad signature', origin);

        const key = variant === 'thumb' ? thumbPathFor(path) : path;
        const obj = await env.PHOTOS_BUCKET.get(key);
        if (!obj) return err(404, 'not found', origin);
        const headers = new Headers(cors(origin));
        obj.writeHttpMetadata(headers);
        headers.set('cache-control', CACHE_CONTROL_IMMUTABLE);
        headers.set('etag', obj.httpEtag);
        return new Response(obj.body, { headers });
      }

      return err(404, 'not found', origin);
    } catch (e) {
      return err(500, (e && e.message) || 'internal error', origin);
    }
  },
};
