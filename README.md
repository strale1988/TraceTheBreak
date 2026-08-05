# TraceTheBreak photo storage — Cloudflare Worker + R2

Replaces Supabase Storage for report photos. Supabase still owns the
database (reports, RLS, auth, admin review) — only the image bytes move.

## 1. Create the R2 bucket

```
npx wrangler r2 bucket create report-photos
```

Keep it **private** (default — do not enable public access / a custom
r2.dev domain on it). All reads go through the Worker's signed URLs.

## 2. Install & configure

```
cd worker
npm init -y
npm install --save-dev wrangler
```

`wrangler.toml` is already set up to bind that bucket.

## 3. Set secrets

```
npx wrangler secret put SUPABASE_JWT_SECRET
# paste the value from Supabase Dashboard -> Project Settings -> API -> JWT Secret

npx wrangler secret put SIGNING_SECRET
# paste output of: openssl rand -hex 32

# Optional, only used so an admin (not just the uploader) can delete a photo:
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

## 4. Deploy

```
npx wrangler deploy
```

This prints your Worker URL, e.g. `https://tracethebreak-photos.<you>.workers.dev`.
You can later map a custom domain (e.g. `photos.tracethebreak.app`) to it for
free in the Cloudflare dashboard — Workers Routes / Custom Domains.

## 5. Point the app at it

In `app.js`, set:

```js
const PHOTO_WORKER_URL = 'https://tracethebreak-photos.<you>.workers.dev';
```

That's the only thing left to configure — everything else (upload, delete,
signed reads, thumbnails) is already wired in `app.js`.

## Notes

- **Cost**: R2 has no egress fees at all, and its free tier is 10 GB storage
  + 1M Class-A (write) + 10M Class-B (read) ops/month. Workers free tier is
  100k requests/day. For a civic-reporting app's photo volume this should
  comfortably stay free.
- **Security model**: matches what you had before — a logged-in user can
  only write under their own `<uid>/...` prefix, and every read is a
  short-lived signed link (thumb/display links last 6h, full-size 1h),
  minted only for someone with a valid Supabase session. Nothing is
  publicly listable or guessable-and-permanent.
- **Existing photos in Supabase Storage**: this does not migrate old
  photos automatically. If you want the ~existing~ `report-photos` bucket
  contents copied into R2 too, say the word and I'll write a one-off
  migration script (`rclone` between the two S3-compatible endpoints is the
  simplest route).
