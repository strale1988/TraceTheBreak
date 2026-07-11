import { createClient } from 'npm:@supabase/supabase-js@2';

const OSM_AUTH_URL = 'https://www.openstreetmap.org/oauth2/authorize';
const OSM_TOKEN_URL = 'https://www.openstreetmap.org/oauth2/token';
const OSM_USER_URL = 'https://api.openstreetmap.org/api/0.6/user/details.json';

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

function fakeEmailForOsm(osmId: number) {
  return `osm_${osmId}@tracethebreak.local`;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const redirectTo = url.searchParams.get('redirect_to') || url.searchParams.get('state');

  // Step 1: no ?code yet -> send the browser to OSM to authorize.
  // We stash the app's own redirectTo in `state` so we still have it when
  // OSM calls us back below.
  if (!code) {
    const appRedirect = url.searchParams.get('redirect_to') || '/';
    const authorize = new URL(OSM_AUTH_URL);
    authorize.searchParams.set('client_id', Deno.env.get('OSM_CLIENT_ID')!);
    authorize.searchParams.set('redirect_uri', Deno.env.get('OSM_REDIRECT_URI')!);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('scope', 'read_prefs');
    authorize.searchParams.set('state', appRedirect);
    return Response.redirect(authorize.toString(), 302);
  }

  // Step 2: OSM called back with ?code=...&state=<appRedirect>. Exchange
  // the code for a token, then fetch the OSM user's id + display name.
  try {
    const tokenRes = await fetch(OSM_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: Deno.env.get('OSM_REDIRECT_URI')!,
        client_id: Deno.env.get('OSM_CLIENT_ID')!,
        client_secret: Deno.env.get('OSM_CLIENT_SECRET')!,
      }),
    });
    if (!tokenRes.ok) throw new Error(`OSM token exchange failed: ${await tokenRes.text()}`);
    const { access_token } = await tokenRes.json();

    const userRes = await fetch(OSM_USER_URL, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!userRes.ok) throw new Error(`OSM user lookup failed: ${await userRes.text()}`);
    const { user: osmUser } = await userRes.json();
    const osmId: number = osmUser.id;
    const displayName: string = osmUser.display_name;

    // Find an existing profile for this OSM id, otherwise create the
    // auth.users row (which fires the handle_new_user trigger from the SQL
    // migration) and stamp osm_id/provider onto the resulting profile.
    const email = fakeEmailForOsm(osmId);
    let { data: existing } = await admin
      .from('profiles')
      .select('id')
      .eq('osm_id', osmId)
      .maybeSingle();

    let userId: string;
    if (existing) {
      userId = existing.id;
    } else {
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: { name: displayName, osm_id: osmId, provider: 'osm' },
      });
      if (createErr) throw createErr;
      userId = created.user.id;

      await admin
        .from('profiles')
        .update({ osm_id: osmId, provider: 'osm' })
        .eq('id', userId);
    }
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: { redirectTo: redirectTo || '/' },
    });
    if (linkErr) throw linkErr;

    return Response.redirect(linkData.properties.action_link, 302);
  } catch (err) {
    console.error('osm-login error:', err);
    return new Response(`OSM sign-in failed: ${err.message}`, { status: 500 });
  }
});
