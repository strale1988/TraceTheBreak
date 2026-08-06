/**
 * TraceTheBreak photo-storage Worker.
 *
 * Sits between the browser and an R2 bucket. Never hands out R2 credentials
 * (there aren't any to hand out — Workers talk to R2 via a binding). Instead
 * it:
 *   - verifies the user's existing Supabase login token itself (ES256,
 *     checked locally against Supabase's published JWKS public keys — no
 *     network round trip beyond a cached JWKS fetch)
 *   - lets a logged-in user PUT/DELETE objects under their own `${uid}/...`
 *     prefix (mirrors the old Supabase Storage RLS-by-path setup)
 *   - issues short-lived, HMAC-signed URLs to read an object, instead of
 *     Supabase's createSignedUrl. A signed URL only proves "someone with a
 *     valid login was allowed to ask for this path within the last N
 *     seconds" — same trust level as before.
 *   - throttles uploads per-user (UPLOAD_RATE_LIMITER, see wrangler.toml),
 *     so one account can't run up R2 storage costs or hammer the Worker.
 *
 * Routes:
 *   POST   /upload?path=<key>        body = raw image bytes
 *   DELETE /upload?path=<key>
 *   GET    /sign?path=<key>&variant=full|thumb&ttl=<seconds>
 *   GET    /o?path=<key>&variant=&exp=&sig=      (the actual signed fetch)
 *   POST   /admin-upload?path=<key>  (ADMIN_MIGRATION_SECRET-gated, one-off migration)
 *   GET    /admin-exists?path=<key>  (ADMIN_MIGRATION_SECRET-gated, migration helper)
 */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'authorization,content-type,x-photo-content-type,x-admin-secret',
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

// ---- JWKS cache (Supabase publishes public keys for ES256 verification) ----
let jwksCache = null; // { keys, fetchedAt }

async function getJwks(jwksUrl, forceRefetch) {
  const now = Date.now();
  // Cache for 1 hour; Supabase rotates keys infrequently. A forced refetch
  // also happens below whenever a kid isn't found, so a mid-window key
  // rotation on Supabase's end still resolves within one request, not just
  // once an hour.
  if (!forceRefetch && jwksCache && now - jwksCache.fetchedAt < 3600_000) {
    return jwksCache.keys;
  }
  const res = await fetch(jwksUrl);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const data = await res.json();
  jwksCache = { keys: data.keys || [], fetchedAt: now };
  return jwksCache.keys;
}

// ---- verify a Supabase-issued ES256 JWT using JWKS public keys ----
//
// IMPORTANT: WebCrypto's ECDSA verify() expects the RAW r||s signature
// format (32+32 bytes for P-256) — exactly what a JWS ES256 signature
// already is per RFC 7518. Do NOT convert to DER here; DER is what
// Node's crypto module and OpenSSL expect, but WebCrypto (the runtime
// this Worker uses) is not that. Converting to DER before calling
// crypto.subtle.verify() makes every signature fail verification,
// valid or not.
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
    console.error('verifySupabaseJwt: token json parse failed');
    return null;
  }

  if (!payload || !payload.sub) {
    console.error('verifySupabaseJwt: token missing payload/sub');
    return null;
  }
  if (payload.exp && Date.now() / 1000 > payload.exp) {
    console.error(`verifySupabaseJwt: token expired at ${payload.exp}, now ${Math.floor(Date.now() / 1000)}`);
    return null;
  }
  if (header.alg !== 'ES256') {
    console.error(`verifySupabaseJwt: unsupported alg "${header.alg}"`);
    return null;
  }
  if (!env.SUPABASE_URL) {
    console.error('verifySupabaseJwt: SUPABASE_URL is not set on the Worker');
    return null;
  }

  const jwksUrl = `${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`;
  let keys;
  try {
    keys = await getJwks(jwksUrl, false);
  } catch (e) {
    console.error(`verifySupabaseJwt: jwks fetch failed — ${e && e.message}`);
    return null;
  }

  let jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) {
    // Not in our cache — could be a just-rotated key, so force one refetch
    // before giving up rather than waiting out the full cache TTL.
    try {
      keys = await getJwks(jwksUrl, true);
    } catch (e) {
      console.error(`verifySupabaseJwt: jwks refetch failed — ${e && e.message}`);
      return null;
    }
    jwk = keys.find(k => k.kid === header.kid);
  }
  if (!jwk) {
    console.error(`verifySupabaseJwt: no JWKS key found for kid=${header.kid} (${keys.length} keys cached)`);
    return null;
  }

  let keyObj;
  try {
    keyObj = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: jwk.crv || 'P-256' }, false, ['verify']);
  } catch (e) {
    console.error(`verifySupabaseJwt: key import failed — ${e && e.message}`);
    return null;
  }

  let ok;
  try {
    // Raw r||s bytes straight from the token — no DER conversion.
    ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      keyObj,
      b64urlToBytes(sigB64),
      textToBytes(`${headerB64}.${payloadB64}`)
    );
  } catch (e) {
    console.error(`verifySupabaseJwt: verify threw — ${e && e.message}`);
    return null;
  }

  if (!ok) {
    console.error(`verifySupabaseJwt: signature invalid (kid=${header.kid})`);
    return null;
  }
  return payload;
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

function requireAdminSecret(request, env) {
  if (!env.ADMIN_MIGRATION_SECRET) return false;
  const provided = request.headers.get('x-admin-secret') || '';
  return safeEqual(provided, env.ADMIN_MIGRATION_SECRET);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });

    try {
      // ---- POST /admin-upload?path=... : write any path, for one-off migration only.
      // Guarded by ADMIN_MIGRATION_SECRET (a Worker secret, never shipped to the
      // browser app). Remove the secret in the dashboard once migration is done
      // to disable this route again.
      if (url.pathname === '/admin-upload' && request.method === 'POST') {
        if (!requireAdminSecret(request, env)) return err(401, 'not authorized', origin);
        const path = url.searchParams.get('path');
        if (!path) return err(400, 'missing path', origin);
        const contentType = request.headers.get('x-photo-content-type') || request.headers.get('content-type') || 'application/octet-stream';
        const body = await request.arrayBuffer();
        if (!body.byteLength) return err(400, 'empty body', origin);
        if (body.byteLength > 6 * 1024 * 1024) return err(413, 'too large', origin);
        await env.PHOTOS_BUCKET.put(path, body, { httpMetadata: { contentType, cacheControl: CACHE_CONTROL_IMMUTABLE } });
        return json({ ok: true, path }, 200, origin);
      }

      // ---- GET /admin-exists?path=... : lets the migration page skip work it already did ----
      if (url.pathname === '/admin-exists' && request.method === 'GET') {
        if (!requireAdminSecret(request, env)) return err(401, 'not authorized', origin);
        const path = url.searchParams.get('path');
        if (!path) return err(400, 'missing path', origin);
        const head = await env.PHOTOS_BUCKET.head(path);
        return json({ exists: !!head }, 200, origin);
      }

      // ---- POST /upload?path=... : store one object under the caller's own uid prefix ----
      if (url.pathname === '/upload' && request.method === 'POST') {
        const payload = await requireUser(request, env);
        if (!payload) return err(401, 'not authenticated', origin);
        const path = url.searchParams.get('path');
        if (!path) return err(400, 'missing path', origin);
        if (pathPrefixUid(path) !== payload.sub) return err(403, 'path does not belong to you', origin);

        // Per-user upload throttle — blunts a compromised/malicious account
        // running up R2 storage costs or hammering the Worker. Keyed on uid
        // (not IP), since every caller here is already authenticated.
        if (env.UPLOAD_RATE_LIMITER) {
          const { success } = await env.UPLOAD_RATE_LIMITER.limit({ key: payload.sub });
          if (!success) return err(429, 'too many uploads, slow down', origin);
        }

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
        let obj = await env.PHOTOS_BUCKET.get(key);
        // Migrated/legacy photos may not have a pre-made thumbnail object
        // (thumbnails used to be generated on the fly). Fall back to the
        // full-size object rather than showing a broken image — the app
        // will still work, just without the bandwidth savings for that
        // one photo until backfill-thumbs.mjs (see /migration) runs.
        if (!obj && variant === 'thumb') obj = await env.PHOTOS_BUCKET.get(path);
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
