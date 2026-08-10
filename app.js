
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then(() => {
      let reloadPending = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloadPending) return;
        reloadPending = true;
        const wizardEl = document.getElementById('reportWizard');
        const wizardOpen = !!(wizardEl && wizardEl.style.display !== 'none');
        if (drivingMode || wizardOpen) {

          toast(t('appUpdateReadyToast'), 'success');
        } else {
          window.location.reload();
        }
      });
    }).catch(err => {
      console.warn('Service worker registration failed:', err.message);
    });
  });
}


window.addEventListener('error', (event) => {
  console.error('Uncaught error:', event.error || event.message, event.filename ? `(${event.filename}:${event.lineno})` : '');
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
});

function updateHeaderHeightVar() {
  const header = document.querySelector('header');
  if (header) document.documentElement.style.setProperty('--header-h', header.offsetHeight + 'px');
  if (typeof map !== 'undefined' && map.invalidateSize) map.invalidateSize({ animate: false, pan: false });
}

(function initAppPanelHeightTracking() {
  const panel = document.getElementById('appPanel');
  if (!panel) return;
  const sync = () => {
    document.documentElement.style.setProperty('--legend-bottom-gap', panel.offsetHeight + 'px');
    try { if (map && map.invalidateSize) map.invalidateSize({ animate: false, pan: false }); } catch (e) {}
  };
  sync();
  if (window.ResizeObserver) {
    new ResizeObserver(sync).observe(panel);
  } else {
    window.addEventListener('resize', sync);
    window.addEventListener('orientationchange', sync);
  }
})();

(function initLegendHeightTracking() {
  const legendRow = document.querySelector('.legend-row');
  if (!legendRow) return;
  const sync = () => document.documentElement.style.setProperty('--legend-row-h', legendRow.offsetHeight + 'px');
  sync();
  if (window.ResizeObserver) {
    new ResizeObserver(sync).observe(legendRow);
  } else {
    window.addEventListener('resize', sync);
    window.addEventListener('orientationchange', sync);
  }
})();

setTimeout(() => {
  const el = document.getElementById('mapLoadingOverlay');
  if (el) el.classList.add('map-loading-hidden');
}, 8000);
const SUPABASE_URL = 'https://fnkqmwweljsupbmerbkh.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZua3Ftd3dlbGpzdXBibWVyYmtoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3OTcwODUsImV4cCI6MjA5NzM3MzA4NX0.eX3mxnSpGmJ6Ebw7Y4F_jHiJarPH4ri9WNYXwmLi16I';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const TABLE = 'brake_reports';
const BUMPS_TABLE = 'bumps';

const PROFILES_TABLE = 'profiles';
const MUNICIPALITIES_TABLE = 'municipalities';
const UTILITY_COMPANIES_TABLE = 'utility_companies';
const COUNTRIES_TABLE = 'countries';
const REPORT_CONTACT_EVENTS_TABLE = 'report_contact_events';
const REPORT_STATUS_VOTES_TABLE = 'report_status_votes';
const MUNICIPALITY_STATS_TABLE = 'municipality_report_stats';
const UTILITY_COMPANY_STATS_TABLE = 'utility_company_report_stats';

// ---------------------------------------------------------------------------
// TESTER MODE — sandbox for accounts flagged `is_tester` on their profile.
//
// Goal: a tester can click through the *entire* app — file a report, delete
// one, upload a photo, vote, flag something, and (if they also happen to be
// an admin) use admin actions too — and get completely normal success
// feedback, but NOTHING is actually written to the real database.
//
// Rather than hunting down and rewriting every single insert/update/delete
// call site across the app (there are dozens), this hooks the one choke
// point they all share: window.fetch, which is what the Supabase JS client
// uses under the hood for every REST/RPC/storage/function call. When the
// signed-in user is a tester, any *mutating* request (POST/PATCH/PUT/DELETE)
// aimed at our own Supabase project is short-circuited into a fake
// successful response instead of hitting the network — reads (GET) always
// go through for real, so testers still see the real map/data.
//
// brake_reports gets special handling on top of that generic guard: faked
// inserts/updates/deletes are also mirrored into an in-memory shadow store
// so a tester's fake reports still appear on their own map, can be opened,
// edited, and deleted, exactly like a real one — just never actually saved,
// and gone the moment they reload.
// ---------------------------------------------------------------------------

function isTesterMode() {
  return !!(currentProfile && currentProfile.is_tester);
}

let testerAddedReports = [];          // fully-fake reports a tester "created"
let testerDeletedReportIds = new Set(); // ids (fake or real) a tester "deleted"
let testerReportOverrides = {};       // reportId -> patch, for edits/status changes tester made to REAL reports

function applyTesterReportOverlay(reports) {
  if (!Array.isArray(reports)) return reports;
  let out = reports.filter(r => !testerDeletedReportIds.has(String(r.id)));
  out = out.map(r => testerReportOverrides[r.id] ? { ...r, ...testerReportOverrides[r.id] } : r);
  const extra = testerAddedReports.filter(r => !testerDeletedReportIds.has(String(r.id)));
  return out.concat(extra);
}

let testerModeToastShownAt = 0;
function showTesterModeToast() {
  // Rate-limited so a flurry of rapid actions (e.g. an admin bulk action)
  // doesn't spam the toast stack — the persistent banner already makes the
  // sandbox state obvious, this is just a light reassurance per action.
  const now = Date.now();
  if (now - testerModeToastShownAt < 1200) return;
  testerModeToastShownAt = now;
  try { toast('🧪 ' + (t('testerModeActionSimulated') || 'Tester mode (nothing saved)'), 'success'); } catch (e) {}
}

function ensureTesterModeBanner() {
  let el = document.getElementById('testerModeBanner');
  if (isTesterMode()) {
    if (!el) {
      el = document.createElement('div');
      el.id = 'testerModeBanner';
      el.style.cssText = 'position:fixed; top:0; left:0; right:0; z-index:99999; background:#5847e6; color:#fff; text-align:center; font-size:12.5px; font-weight:600; padding:6px 10px; box-shadow:0 2px 6px rgba(0,0,0,.25);';
      el.textContent = '🧪 Tester mode (nothing you do here is saved for real)';
      document.body.appendChild(el);
    }
  } else if (el) {
    el.remove();
  }
}

(function initTesterModeFetchGuard() {
  const REAL_FETCH = window.fetch.bind(window);
  const READ_ONLY_RPC_ALLOWLIST = new Set(['get_report_contact_counts']);

  function fakeResponse(body, status) {
    return new Response(JSON.stringify(body), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  function idFromUrl(url) {
    const m = url.match(/[?&]id=eq\.([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function handleBrakeReportsWrite(method, url, body) {
    showTesterModeToast();
    if (method === 'POST') {
      const rows = Array.isArray(body) ? body : [body || {}];
      const created = rows.map(r => {
        const id = 'tester_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
        const full = {
          status: 'reported',
          priority: 'normal',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          ...r,
          id
        };
        testerAddedReports.push(full);
        return full;
      });
      return fakeResponse(created, 201);
    }
    const id = idFromUrl(url);
    if (method === 'DELETE') {
      if (id) {
        testerDeletedReportIds.add(id);
        testerAddedReports = testerAddedReports.filter(r => String(r.id) !== id);
      }
      return fakeResponse([], 200);
    }
    // PATCH/PUT — status changes, edits, municipality attach, etc.
    const patch = body || {};
    if (id) {
      const fake = testerAddedReports.find(r => String(r.id) === id);
      if (fake) Object.assign(fake, patch);
      else testerReportOverrides[id] = { ...(testerReportOverrides[id] || {}), ...patch };
    }
    return fakeResponse([{ id, ...patch }], 200);
  }

  window.fetch = async function (input, init) {
    const isReq = (typeof Request !== 'undefined') && (input instanceof Request);
    const url = isReq ? input.url : String(input);
    const method = ((init && init.method) || (isReq && input.method) || 'GET').toUpperCase();

    if (!isTesterMode() || method === 'GET' || method === 'HEAD' || !url.startsWith(SUPABASE_URL)) {
      return REAL_FETCH(input, init);
    }
    // Auth and read-style storage access (signed/public URLs, downloads) always go through for real.
    if (url.includes('/auth/v1/')) return REAL_FETCH(input, init);
    if (/\/storage\/v1\/object\/(sign|public|authenticated)\//.test(url)) return REAL_FETCH(input, init);

    const rpcMatch = url.match(/\/rest\/v1\/rpc\/([^?]+)/);
    if (rpcMatch && READ_ONLY_RPC_ALLOWLIST.has(rpcMatch[1])) return REAL_FETCH(input, init);

    let bodyText = null;
    try {
      bodyText = isReq ? await input.clone().text() : (init && init.body && typeof init.body === 'string' ? init.body : null);
    } catch (e) {}
    let parsedBody = null;
    try { parsedBody = bodyText ? JSON.parse(bodyText) : null; } catch (e) {}

    if (url.includes('/functions/v1/')) {
      showTesterModeToast();
      return fakeResponse({ ok: true, status: 'test_sent', simulated: true });
    }
    if (url.includes('/storage/v1/object/')) {
      showTesterModeToast();
      if (method === 'DELETE') return fakeResponse([{ name: 'tester-simulated' }], 200);
      return fakeResponse({ Key: 'tester-simulated/' + Date.now(), Id: 'sim-' + Date.now() });
    }

    const tableMatch = url.match(/\/rest\/v1\/([^?\/]+)/);
    const table = tableMatch ? tableMatch[1] : null;
    if (table === TABLE) return handleBrakeReportsWrite(method, url, parsedBody);

    // Generic fallback for every other table (profiles, gallery, flags, votes, utility_companies, ...)
    showTesterModeToast();
    if (method === 'DELETE') return fakeResponse([], 200);
    if (method === 'POST') {
      const rows = Array.isArray(parsedBody) ? parsedBody : [parsedBody || {}];
      const echoed = rows.map(r => ({ id: r.id || ('sim_' + Math.random().toString(36).slice(2)), ...r }));
      return fakeResponse(echoed, 201);
    }
    return fakeResponse([{ ...(parsedBody || {}) }], 200);
  };
})();

function isValidLat(lat) { return typeof lat === 'number' && isFinite(lat) && lat >= -90  && lat <= 90; }
function isValidLng(lng) { return typeof lng === 'number' && isFinite(lng) && lng >= -180 && lng <= 180; }
function isValidLatLng(lat, lng) { return isValidLat(lat) && isValidLng(lng); }

function isValidCoordObj(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const lat = obj.lat ?? obj.latitude;
  const lng = obj.lon ?? obj.lng ?? obj.longitude;
  return isValidLatLng(lat, lng);
}

function toFiniteNumber(value) {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  return typeof n === 'number' && isFinite(n) ? n : null;
}

function sanitizePath(path) {
  if (!Array.isArray(path)) return [];
  return path.filter(p => Array.isArray(p) && isValidLatLng(p[0], p[1]));
}

let currentSession = null;
let currentProfile = null;

let voteProgressByReport = new Map();

function describeAuthError(err) {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  const msg = err.message || err.error_description || err.msg || err.hint || err.details;
  if (msg) return msg + (err.status ? ` (status ${err.status})` : '') + (err.code ? ` [${err.code}]` : '');
  try {
    const full = JSON.stringify(err, Object.getOwnPropertyNames(err));
    if (full && full !== '{}') return full;
  } catch (e) {}
  return 'Unknown error (check Supabase Dashboard \u2192 Logs \u2192 Auth Logs for details)';
}

async function signInWithProvider(provider) {
  try {
    const inWrappedApp = navigator.userAgent.includes('TraceTheStuffApp');
    const redirectTo = inWrappedApp
      ? 'tracehub://auth-callback'
      : window.location.origin + window.location.pathname;

    const { error } = await sb.auth.signInWithOAuth({
      provider,
      options: { redirectTo }
    });
    if (error) throw error;
  } catch (err) {
    console.error('OAuth sign-in error:', err);
    toast(t('authSignInFailedPrefix') + describeAuthError(err), 'error');
  }
}

function signInWithOsm() {
  const cleanUrl = window.location.origin + window.location.pathname;
  const redirectTo = encodeURIComponent(cleanUrl);
  window.location.href = `${SUPABASE_URL}/functions/v1/osm-login?redirect_to=${redirectTo}`;
}

async function submitUsername() {
  const input = document.getElementById('chosenUsernameInput');
  const username = cyrillicToLatin(input.value.trim());
  if (!username || username.length < 3) {
    toast(t('usernameMinLength'), 'error');
    return;
  }
  if (blockIfProfane(username)) return;
  if (!currentSession) return;
  try {
    const { error } = await sb.from(PROFILES_TABLE)
      .update({ username })
      .eq('id', currentSession.user.id);
    if (error) throw error;
    input.value = '';
    await loadProfile();
  } catch (err) {
    console.error('Username save error (full):', err);
    const taken = err && err.code === '23505';
    toast(taken
      ? t('usernameTaken')
      : t('genericErrorPrefix') + describeAuthError(err), 'error');
  }
}

async function signOutUser() {
  if (!(await themedConfirm(t('signOutConfirm')))) return;
  try {
    const { error } = await sb.auth.signOut();
    if (error) throw error;
  } catch (err) {
    console.error('Sign out failed:', err.message);
    toast(t('loadFailed'), 'error');
    return;
  }
  currentSession = null;
  currentProfile = null;

  hideLeaderboardModal();
  hideSettingsModal();
  hideReportDetailModal();
  hideCompanyDetailModal();
  hideLegalContentModal();
  hideNotificationModal();
  if (typeof drivingMode !== 'undefined' && drivingMode) toggleDrivingMode();
  if (typeof heatmapActive !== 'undefined' && heatmapActive) toggleHeatmap();
  clearNavigation();
  if (pinMode || manualMarker) resetReportingForm();
  setFollowMode(!!userCoords);

  updateAuthUI();
  refreshRenderedPopups();
}

// Account deletion is admin-mediated now: this only flags the account and
// notifies admins (see request_account_deletion() RPC) — it does NOT sign
// the user out or delete anything. An admin reviews it in Admin panel >
// Account requests and confirms via admin-delete-account, which is the only
// thing that actually deletes the account.
async function requestAccountDeletion() {
  if (!currentSession || !currentProfile) return;
  if (currentProfile.account_status === 'pending_deletion') return;

  const confirmed = await themedConfirm(t('deleteAccountConfirmMessage'), {
    okLabel: t('deleteAccountConfirmOk'),
    cancelLabel: t('cancelBtn')
  });
  if (!confirmed) return;

  const btn = document.getElementById('deleteAccountBtn');
  if (btn) btn.disabled = true;

  try {
    const { data, error } = await sb.rpc('request_account_deletion');
    if (error) throw error;
    if (!data || data.ok === false) throw new Error((data && data.reason) || 'request_failed');

    currentProfile.account_status = 'pending_deletion';
    currentProfile.deletion_requested_at = new Date().toISOString();
    updateAccountDangerSection();
    toast(t('deleteAccountRequestSuccess'), 'success');
  } catch (err) {
    console.error('Account deletion request failed:', err);
    toast(t('deleteAccountError'), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function cancelAccountDeletionRequest() {
  if (!currentSession || !currentProfile) return;
  const btn = document.getElementById('cancelDeletionBtn');
  if (btn) btn.disabled = true;
  try {
    const { error } = await sb.rpc('cancel_account_deletion');
    if (error) throw error;
    currentProfile.account_status = 'active';
    currentProfile.deletion_requested_at = null;
    updateAccountDangerSection();
    toast(t('deleteAccountCancelSuccess'), 'success');
  } catch (err) {
    console.error('Cancel deletion request failed:', err);
    toast(t('deleteAccountError'), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loadProfile() {
  if (!currentSession) return;
  try {
    const { data, error } = await sb.from(PROFILES_TABLE)
      .select('*')
      .eq('id', currentSession.user.id)
      .maybeSingle();
    if (error) throw error;

    if (data) {
      currentProfile = data;
    } else {
      const meta = currentSession.user.user_metadata || {};
      const { data: created, error: insertError } = await sb.from(PROFILES_TABLE)
        .insert({
          id: currentSession.user.id,
          username: null,
          avatar_url: meta.avatar_url || null,
          provider: (currentSession.user.app_metadata && currentSession.user.app_metadata.provider) || 'unknown'
        })
        .select('*')
        .maybeSingle();
      if (insertError) throw insertError;
      currentProfile = created;
    }
    updateAuthUI();
    syncPreferredLanguageToProfile(lang);
    touchLastActiveHeartbeat();
  } catch (err) {
    console.error('Failed to load profile:', err.message);
  }
}

// Bumps profiles.last_active_at so the dormancy job (mark-dormant-accounts,
// 1 year of inactivity) sees this account as alive. Also auto-reactivates a
// dormant account the moment its owner logs back in — fire-and-forget, never
// blocks the UI, and silently no-ops if it fails (heartbeat, not critical).
async function touchLastActiveHeartbeat() {
  if (!currentSession) return;
  try {
    const { data, error } = await sb.rpc('touch_last_active');
    if (error) throw error;
    if (data && data.reactivated && currentProfile) {
      currentProfile.account_status = 'active';
      currentProfile.dormant_at = null;
      currentProfile.dormant_warning_sent_at = null;
      updateAccountDangerSection();
      toast(t('accountReactivatedToast'), 'success');
    }
  } catch (err) {
    console.error('touch_last_active failed:', err.message || err);
  }
}

// Shows the right state in the Settings > Account section: normal delete
// button (active), or a "pending review" box with a cancel option
// (pending_deletion / dormant — dormant accounts can also just cancel back
// to active, same as a pending deletion request, since both just mean "an
// admin will look at this").
function updateAccountDangerSection() {
  const btn = document.getElementById('deleteAccountBtn');
  const pendingBox = document.getElementById('deleteAccountPendingBox');
  const pendingHint = document.getElementById('deleteAccountPendingHint');
  if (!btn || !pendingBox) return;
  const status = currentProfile && currentProfile.account_status;
  if (status === 'pending_deletion' || status === 'dormant') {
    btn.style.display = 'none';
    pendingBox.style.display = 'block';
    if (pendingHint) pendingHint.textContent = t(status === 'dormant' ? 'deleteAccountDormantHint' : 'deleteAccountPendingHint');
  } else {
    btn.style.display = '';
    pendingBox.style.display = 'none';
  }
}

// Theme/map/driving/notification settings only make sense (and are only
// worth the visual clutter) once someone actually has an account — a signed-
// out visitor gets a single sign-in prompt in their place instead of a wall
// of controls that don't apply to them yet.
function updateSettingsAccountGate() {
  const hasAccount = !!currentSession;
  const gate = document.getElementById('settingsSignInGate');
  const group = document.getElementById('settingsAccountGatedGroup');
  if (gate) gate.style.display = hasAccount ? 'none' : 'flex';
  if (group) group.style.display = hasAccount ? '' : 'none';
}
function updateAuthUI() {
  ensureTesterModeBanner();
  const reportFormPanel = document.getElementById('reportFormPanel');
  const desktopBlockedPanel = document.getElementById('desktopBlockedPanel');
  const lockedFormPanel = document.getElementById('lockedFormPanel');
  const chooseUsernamePanel = document.getElementById('chooseUsernamePanel');
  const pinBtn = document.getElementById('pinMapBtn');
  const reportFabBtn = document.getElementById('reportFabBtn');

  const hasAccount = !!currentSession;
  [document.getElementById('leaderboardBtn'), document.getElementById('navigateModeBtn'), document.getElementById('heatmapBtn'), document.getElementById('notificationBtn')]
    .forEach(btn => { if (btn) btn.classList.toggle('map-btn-locked', !hasAccount); });
  updateSettingsAccountGate();
  updateAccountDangerSection();

  if (currentSession && currentProfile && currentProfile.username) {
    updateAdminPanelButtonVisibility();

    const canReportHere = !!currentProfile.is_admin || isMobileDevice();
    reportFormPanel.style.display = canReportHere ? 'flex' : 'none';
    desktopBlockedPanel.style.display = canReportHere ? 'none' : 'flex';
    if (pinBtn) pinBtn.style.display = canReportHere ? 'flex' : 'none';
    if (reportFabBtn) reportFabBtn.style.display = canReportHere ? 'flex' : 'none';

    lockedFormPanel.style.display = 'none';
    chooseUsernamePanel.style.display = 'none';
    if (canReportHere) maybeStartOnboardingTour();
  } else if (currentSession && currentProfile && !currentProfile.username) {
    reportFormPanel.style.display = 'none';
    desktopBlockedPanel.style.display = 'none';
    lockedFormPanel.style.display = 'none';
    chooseUsernamePanel.style.display = 'flex';
    if (reportFabBtn) reportFabBtn.style.display = 'none';
    updateAdminPanelButtonVisibility();
  } else {
    reportFormPanel.style.display = 'none';
    desktopBlockedPanel.style.display = 'none';
    lockedFormPanel.style.display = 'flex';
    chooseUsernamePanel.style.display = 'none';
    if (reportFabBtn) reportFabBtn.style.display = 'none';
    updateAdminPanelButtonVisibility();
  }
  updateCsvExportVisibility();
  if (reportFabBtn && reportFabBtn.style.display === 'none') closeReportWizard();
  checkFormReady();
  updateReportFabState();
  refreshRenderedPopups();
  if (document.getElementById('leaderboardModal').style.display !== 'none') {
    renderDashboardTab();
  }
  refreshUnreadNotificationCount();
}

const ONBOARDING_SEEN_KEY = 'ttb_onboarding_seen_v1';
let onboardingActiveSteps = [];
let onboardingStepIndex = 0;
let onboardingResizeHandlerBound = null;

function hasSeenOnboarding() {
  try { return localStorage.getItem(ONBOARDING_SEEN_KEY) === '1'; } catch (e) { return true; }
}
function markOnboardingSeen() {
  try { localStorage.setItem(ONBOARDING_SEEN_KEY, '1'); } catch (e) {}
}

function getOnboardingSteps() {
  return [
    { id: null,             titleKey: 'onboardingStepWelcomeTitle',     textKey: 'onboardingStepWelcomeText' },
    { id: 'reportFabBtn',   titleKey: 'onboardingStepReportTitle',      textKey: 'onboardingStepReportText' },
    { id: null,             titleKey: 'onboardingStepSendTitle',        textKey: 'onboardingStepSendText' },
    { id: 'pinMapBtn',      titleKey: 'onboardingStepPinTitle',         textKey: 'onboardingStepPinText' },
    { id: 'notificationBtn', titleKey: 'onboardingStepNotifTitle',      textKey: 'onboardingStepNotifText' },
    { id: 'navigateModeBtn', titleKey: 'onboardingStepNavTitle',         textKey: 'onboardingStepNavText' },
    { id: 'leaderboardBtn', titleKey: 'onboardingStepLeaderboardTitle', textKey: 'onboardingStepLeaderboardText' }
  ];
}

function isOnboardingTargetVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function maybeStartOnboardingTour() {
  if (hasSeenOnboarding()) return;

  setTimeout(() => startOnboardingTour(false), 500);
}

function startOnboardingTour(isReplay) {
  const overlay = document.getElementById('onboardingOverlay');
  if (!overlay) return;
  const candidates = getOnboardingSteps()
    .map(step => ({ ...step, el: step.id ? document.getElementById(step.id) : null }))
    .filter(step => !step.id || isOnboardingTargetVisible(step.el));
  if (!candidates.length) {
    if (!isReplay) markOnboardingSeen();
    return;
  }
  onboardingActiveSteps = candidates;
  onboardingStepIndex = 0;
  document.getElementById('onboardingSkipBtn').textContent = t('onboardingSkipBtn');
  overlay.style.display = 'block';
  renderOnboardingStep();
  if (!onboardingResizeHandlerBound) {
    onboardingResizeHandlerBound = () => {
      if (overlay.style.display !== 'none') positionOnboardingStep();
    };
    window.addEventListener('resize', onboardingResizeHandlerBound);
  }
}

function renderOnboardingStep() {
  const step = onboardingActiveSteps[onboardingStepIndex];
  if (!step) { endOnboardingTour(); return; }
  document.getElementById('onboardingStepCounter').textContent =
    `${onboardingStepIndex + 1} / ${onboardingActiveSteps.length}`;
  document.getElementById('onboardingStepTitle').textContent = t(step.titleKey);
  document.getElementById('onboardingStepText').textContent = t(step.textKey);
  document.getElementById('onboardingNextBtn').textContent =
    (onboardingStepIndex === onboardingActiveSteps.length - 1) ? t('onboardingDoneBtn') : t('onboardingNextBtn');
  positionOnboardingStep();
}

function positionOnboardingStep() {
  const step = onboardingActiveSteps[onboardingStepIndex];
  if (!step) { advanceOnboardingTour(); return; }
  const spot = document.getElementById('onboardingSpotlight');
  const tooltip = document.getElementById('onboardingTooltip');

  if (!step.id) {
    // No-anchor step (e.g. welcome intro): dim the whole screen with no highlighted
    // element, and center the tooltip card instead of pointing at something.
    const vw = window.innerWidth, vh = window.innerHeight;
    spot.style.top = (vh / 2) + 'px';
    spot.style.left = (vw / 2) + 'px';
    spot.style.width = '0px';
    spot.style.height = '0px';

    tooltip.style.visibility = 'hidden';
    tooltip.style.display = 'block';
    const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
    tooltip.style.top = Math.max(12, (vh - th) / 2) + 'px';
    tooltip.style.left = Math.max(12, (vw - tw) / 2) + 'px';
    tooltip.style.visibility = 'visible';
    return;
  }

  if (!isOnboardingTargetVisible(step.el)) { advanceOnboardingTour(); return; }
  const rect = step.el.getBoundingClientRect();
  const pad = 8;
  spot.style.top = (rect.top - pad) + 'px';
  spot.style.left = (rect.left - pad) + 'px';
  spot.style.width = (rect.width + pad * 2) + 'px';
  spot.style.height = (rect.height + pad * 2) + 'px';

  tooltip.style.visibility = 'hidden';
  tooltip.style.display = 'block';
  const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  const left = Math.min(Math.max(rect.left + rect.width / 2 - tw / 2, 12), vw - tw - 12);
  const spaceAbove = rect.top, spaceBelow = vh - rect.bottom;
  let top = (spaceBelow > th + 24 || spaceBelow > spaceAbove) ? (rect.bottom + pad + 12) : (rect.top - pad - 12 - th);
  top = Math.min(Math.max(top, 12), vh - th - 12);
  tooltip.style.top = top + 'px';
  tooltip.style.left = left + 'px';
  tooltip.style.visibility = 'visible';
}

function advanceOnboardingTour() {
  onboardingStepIndex++;
  if (onboardingStepIndex >= onboardingActiveSteps.length) { endOnboardingTour(); return; }
  renderOnboardingStep();
}

function skipOnboardingTour() { endOnboardingTour(); }

function endOnboardingTour() {
  const overlay = document.getElementById('onboardingOverlay');
  if (overlay) overlay.style.display = 'none';
  markOnboardingSeen();
}

const USER_LEVELS = [
  { level:0, threshold:0,  weight:0,   nameEn:'Observer',             nameSr:'Posmatrač' },
  { level:1, threshold:0,  weight:1,   nameEn:'Citizen',               nameSr:'Građanin' },
  { level:2, threshold:8,  weight:1.5, nameEn:'Reporter',              nameSr:'Reporter' },
  { level:3, threshold:16, weight:2,   nameEn:'Inspector',             nameSr:'Inspektor' },
  { level:4, threshold:32, weight:2.5, nameEn:'Guardian',              nameSr:'Čuvar' },
  { level:5, threshold:64, weight:3,   nameEn:'Community Hero',        nameSr:'Heroj zajednice' },
];

function levelName(lvl) { return isSerbianLang() ? lvl.nameSr : lvl.nameEn; }
function levelForPoints(points) {
  let current = USER_LEVELS[0];
  for (const lvl of USER_LEVELS) { if (points >= lvl.threshold) current = lvl; }
  return current;
}
function currentUserLevel() {
  if (!currentSession || !currentProfile) return USER_LEVELS[0];
  return levelForPoints(currentProfile.total_contributions || 0);
}
function nextUserLevel(lvl) {
  return USER_LEVELS.find(l => l.level === lvl.level + 1) || null;
}

const BADGES = [
  { id:'citizen',        icon:'badge-citizen.png',        nameEn:'Citizen',        nameSr:'Građanin',
    descEn:'Create your profile and join TraceTheBreak.',            descSr:'Napravite profil i pridružite se TraceTheBreak-u.',
    check: p => !!p },
  { id:'reporter',       icon:'badge-reporter.png',       nameEn:'Reporter',       nameSr:'Reporter',
    descEn:'Reach Level 2: earn 8 civic points.',                     descSr:'Dostignite Nivo 2: osvojite 8 građanskih poena.',
    check: p => (p && p.total_contributions || 0) >= 8 },
  { id:'inspector',      icon:'badge-inspector.png',      nameEn:'Inspector',      nameSr:'Inspektor',
    descEn:'Reach Level 3: earn 16 civic points.',                     descSr:'Dostignite Nivo 3: osvojite 16 građanskih poena.',
    check: p => (p && p.total_contributions || 0) >= 16 },
  { id:'guardian',       icon:'badge-guardian.png',       nameEn:'Guardian',       nameSr:'Čuvar',
    descEn:'Reach Level 4: earn 32 civic points.',                    descSr:'Dostignite Nivo 4: osvojite 32 građanska poena.',
    check: p => (p && p.total_contributions || 0) >= 32 },
  { id:'community_hero', icon:'badge-community-hero.png', nameEn:'Community Hero', nameSr:'Heroj zajednice',
    descEn:'Reach Level 5: earn 64 civic points.',                    descSr:'Dostignite Nivo 5: osvojite 64 građanska poena.',
    check: p => (p && p.total_contributions || 0) >= 64 },
  { id:'first_fix',      icon:'badge-first-fix.png',      nameEn:'First Fix',      nameSr:'Prva popravka',
    descEn:'Have one of your reports confirmed fixed.',               descSr:'Neka vam jedna prijava bude potvrđeno rešena.',
    check: p => (p && p.successful_contributions || 0) >= 1 },
  { id:'problem_solver', icon:'badge-problem-solver.png', nameEn:'Problem Solver', nameSr:'Rešavač problema',
    descEn:'Have 10 of your reports confirmed fixed.',                descSr:'Neka vam 10 prijava bude potvrđeno rešeno.',
    check: p => (p && p.successful_contributions || 0) >= 10 },
];

const USER_BADGES_EXTRA = [
  { id:'the_daily_herald', icon:'badge-the-daily-herald.png', nameEn:'The Daily Herald', nameSr:'Dnevne novine',
    descEn:'Log in or submit a report 7 days in a row.', descSr:'Prijavite se ili pošaljite prijavu 7 dana zaredom.',
    category:'Activity', comingSoon:true, check: () => false },
  { id:'night_owl', icon:'badge-night-owl.png', nameEn:'Night Owl', nameSr:'Noćna ptica',
    descEn:'Submit a report or vote between midnight and 4 AM.', descSr:'Pošaljite prijavu ili glasajte između ponoći i 4 ujutru.',
    category:'Activity', check: (p, s) => s.hasNightOwlReport },
  { id:'weekend_warrior', icon:'badge-weekend-warrior.png', nameEn:'Weekend Warrior', nameSr:'Vikend ratnik',
    descEn:'Submit 5 successful reports over a weekend.', descSr:'Pošaljite 5 uspešnih prijava tokom vikenda.',
    category:'Activity', comingSoon:true, check: () => false },
  { id:'local_legend', icon:'badge-local-legend.png', nameEn:'Local Legend', nameSr:'Lokalna legenda',
    descEn:'Get 10 verified reports within the same 1-mile radius.', descSr:'Dobijte 10 potvrđenih prijava u istom radijusu od 1.6 km.',
    category:'Community', comingSoon:true, check: () => false },
  { id:'trailblazer', icon:'badge-trailblazer.png', nameEn:'Trailblazer', nameSr:'Pionir',
    descEn:'Submit the first report in a new zone or category.', descSr:'Pošaljite prvu prijavu u novoj zoni ili kategoriji.',
    category:'Community', comingSoon:true, check: () => false },
  { id:'good_samaritan', icon:'badge-good-samaritan.png', nameEn:'Good Samaritan', nameSr:'Dobri Samarićanin',
    descEn:'Upvote or validate a new user\'s report.', descSr:'Podržite ili potvrdite prijavu novog korisnika.',
    category:'Community', comingSoon:true, check: () => false },
  { id:'first_steps', icon:'badge-first-steps.png', nameEn:'First Steps', nameSr:'Prvi koraci',
    descEn:'Open the map 3 days in one week.', descSr:'Otvorite mapu 3 dana u jednoj nedelji.',
    category:'Activity', comingSoon:true, check: () => false },
  { id:'the_upvoter', icon:'badge-the-upvoter.png', nameEn:'The Upvoter', nameSr:'Podrška komšiluku',
    descEn:'Upvote 5 reports in your neighborhood.', descSr:'Podržite 5 prijava u svom komšiluku.',
    category:'Community', comingSoon:true, check: () => false },
  { id:'on_the_move', icon:'badge-on-the-move.png', nameEn:'On the Move', nameSr:'U pokretu',
    descEn:'Open the app more than 2 miles from your usual location.', descSr:'Otvorite aplikaciju više od 3 km od uobičajene lokacije.',
    category:'Exploration', comingSoon:true, check: () => false },
  { id:'conversation_starter', icon:'badge-conversation-starter.png', nameEn:'Conversation Starter', nameSr:'Pokretač razgovora',
    descEn:'Leave your first report comment.', descSr:'Ostavite svoj prvi komentar na prijavu.',
    category:'Community', check: (p, s) => s.commentCount >= 1 },
  { id:'civic_voice', icon:'badge-civic-voice.png', nameEn:'Civic Voice', nameSr:'Građanski glas',
    descEn:'Cast 25 votes.', descSr:'Date 25 glasova.',
    category:'Community', check: (p, s) => s.voteCount >= 25 },
  { id:'team_player', icon:'badge-team-player.png', nameEn:'Team Player', nameSr:'Timski igrač',
    descEn:'Help verify 25 reports.', descSr:'Pomozite u potvrđivanju 25 prijava.',
    category:'Community', comingSoon:true, check: () => false },
  { id:'community_favorite', icon:'badge-community-favorite.png', nameEn:'Community Favorite', nameSr:'Ljubimac zajednice',
    descEn:'Receive 50 upvotes.', descSr:'Dobijte 50 podrški (upvote).',
    category:'Community', comingSoon:true, check: () => false },
  { id:'explorer', icon:'badge-explorer.png', nameEn:'Explorer', nameSr:'Istraživač',
    descEn:'Visit 10 neighborhoods.', descSr:'Posetite 10 komšiluka.',
    category:'Exploration', comingSoon:true, check: () => false },
  { id:'world_traveler', icon:'badge-world-traveler.png', nameEn:'World Traveler', nameSr:'Svetski putnik',
    descEn:'Submit reports in 5 different cities.', descSr:'Pošaljite prijave u 5 različitih gradova.',
    category:'Exploration', check: (p, s) => s.distinctCities >= 5 },
  { id:'bike_patrol', icon:'badge-bike-patrol.png', nameEn:'Bike Patrol', nameSr:'Biciklistička patrola',
    descEn:'Submit 20 reports while cycling.', descSr:'Pošaljite 20 prijava dok vozite bicikl.',
    category:'Exploration', comingSoon:true, check: () => false },
  { id:'street_scout', icon:'badge-street-scout.png', nameEn:'Street Scout', nameSr:'Ulični izviđač',
    descEn:'Walk 25 miles using the app.', descSr:'Pređite 25 milja koristeći aplikaciju.',
    category:'Exploration', comingSoon:true, check: () => false },
  { id:'sharp_eye', icon:'badge-sharp-eye.png', nameEn:'Sharp Eye', nameSr:'Oštro oko',
    descEn:'Get your first report verified.', descSr:'Neka vam prva prijava bude potvrđena.',
    category:'Reporting', check: (p, s) => s.successfulContributions >= 1 },
  { id:'eagle_eye', icon:'badge-eagle-eye.png', nameEn:'Eagle Eye', nameSr:'Orlovo oko',
    descEn:'Spot 10 duplicate reports.', descSr:'Uočite 10 duplih prijava.',
    category:'Reporting', comingSoon:true, check: () => false },
  { id:'photo_expert', icon:'badge-photo-expert.png', nameEn:'Photo Expert', nameSr:'Foto ekspert',
    descEn:'Submit 100 reports with photos.', descSr:'Pošaljite 100 prijava sa fotografijama.',
    category:'Reporting', check: (p, s) => s.photoCount >= 100 },
  { id:'quick_response', icon:'badge-quick-response.png', nameEn:'Quick Response', nameSr:'Brz odgovor',
    descEn:'Submit a report within 15 minutes.', descSr:'Pošaljite prijavu u roku od 15 minuta.',
    category:'Reporting', comingSoon:true, check: () => false },
  { id:'on_fire', icon:'badge-on-fire.png', nameEn:'On Fire', nameSr:'U vatri',
    descEn:'Keep a 14-day activity streak.', descSr:'Održite niz aktivnosti od 14 dana.',
    category:'Streak', comingSoon:true, check: () => false },
  { id:'unstoppable', icon:'badge-unstoppable.png', nameEn:'Unstoppable', nameSr:'Nezaustavljiv',
    descEn:'Keep a 30-day activity streak.', descSr:'Održite niz aktivnosti od 30 dana.',
    category:'Streak', comingSoon:true, check: () => false },
  { id:'one_year_strong', icon:'badge-one-year-strong.png', nameEn:'One Year Strong', nameSr:'Godinu dana jak',
    descEn:'Stay active for 365 days.', descSr:'Budite aktivni 365 dana.',
    category:'Streak', comingSoon:true, check: () => false },
  { id:'early_bird', icon:'badge-early-bird.png', nameEn:'Early Bird', nameSr:'Rana ptica',
    descEn:'Submit a report before 6 AM.', descSr:'Pošaljite prijavu pre 6 ujutru.',
    category:'Fun', check: (p, s) => s.hasEarlyBirdReport },
  { id:'rain_reporter', icon:'badge-rain-reporter.png', nameEn:'Rain Reporter', nameSr:'Kišni reporter',
    descEn:'Submit a report while it\'s raining.', descSr:'Pošaljite prijavu dok pada kiša.',
    category:'Fun', comingSoon:true, check: () => false },
  { id:'snow_patrol', icon:'badge-snow-patrol.png', nameEn:'Snow Patrol', nameSr:'Snežna patrola',
    descEn:'Submit a report during snowfall.', descSr:'Pošaljite prijavu tokom snežnih padavina.',
    category:'Fun', comingSoon:true, check: () => false },
  { id:'anniversary', icon:'badge-anniversary.png', nameEn:'Anniversary', nameSr:'Godišnjica',
    descEn:'Reach your 1-year account anniversary.', descSr:'Proslavite godišnjicu naloga.',
    category:'Fun', comingSoon:true, check: () => false },
  { id:'birthday_reporter', icon:'badge-birthday-reporter.png', nameEn:'Birthday Reporter', nameSr:'Rođendanski reporter',
    descEn:'Open the app on your birthday.', descSr:'Otvorite aplikaciju na svoj rođendan.',
    category:'Fun', comingSoon:true, check: () => false },
  { id:'halloween_hero', icon:'badge-halloween-hero.png', nameEn:'Halloween Hero', nameSr:'Noć veštica heroj',
    descEn:'Submit a report on Halloween.', descSr:'Pošaljite prijavu na Noć veštica.',
    category:'Fun', check: (p, s) => s.hasHalloweenReport },
  { id:'holiday_helper', icon:'badge-holiday-helper.png', nameEn:'Holiday Helper', nameSr:'Praznični pomoćnik',
    descEn:'Submit a report on a major holiday.', descSr:'Pošaljite prijavu na veliki praznik.',
    category:'Fun', check: (p, s) => s.hasHolidayReport },
  { id:'silent_guardian', icon:'badge-silent-guardian.png', nameEn:'Silent Guardian', nameSr:'Tihi čuvar',
    descEn:'Submit 50 reports with no rejections.', descSr:'Pošaljite 50 prijava bez ijednog odbijanja.',
    category:'Secret', comingSoon:true, check: () => false },
  { id:'ghost_hunter', icon:'badge-ghost-hunter.png', nameEn:'Ghost Hunter', nameSr:'Lovac na duhove',
    descEn:'Submit a report between 3 and 4 AM.', descSr:'Pošaljite prijavu između 3 i 4 ujutru.',
    category:'Secret', check: (p, s) => s.hasGhostHourReport },
  { id:'speed_demon', icon:'badge-speed-demon.png', nameEn:'Speed Demon', nameSr:'Demon brzine',
    descEn:'Get 3 reports verified within 30 minutes.', descSr:'Neka vam 3 prijave budu potvrđene u roku od 30 minuta.',
    category:'Secret', comingSoon:true, check: () => false },
  { id:'completionist', icon:'badge-completionist.png', nameEn:'Completionist', nameSr:'Kompletista',
    descEn:'Earn every standard badge.', descSr:'Osvojite svaku standardnu značku.',
    category:'Secret', check: (p, s) => s.allNonSecretEarned },
  { id:'legend_user', icon:'badge-legend.png', nameEn:'Legend', nameSr:'Legenda',
    descEn:'Reach the highest civic level.', descSr:'Dostignite najviši građanski nivo.',
    category:'Secret', check: (p, s) => s.maxLevelReached },
  { id:'mythic_citizen', icon:'badge-mythic-citizen.png', nameEn:'Mythic Citizen', nameSr:'Mitski građanin',
    descEn:'Unlock every badge.', descSr:'Otključajte svaku značku.',
    category:'Secret', check: (p, s) => s.allEarned },
];
function badgeName(b) { return isSerbianLang() ? b.nameSr : b.nameEn; }
function badgeDesc(b) { return isSerbianLang() ? b.descSr : b.descEn; }
function isBadgeEarned(badge, profile, stats) { return !!badge.check(profile, stats); }

function badgeProgressDetail(badge, profile, stats) {
  try {
    const src = badge.check.toString();
    const numMatch = src.match(/>=\s*(\d+(?:\.\d+)?)/);
    if (!numMatch) return null;
    const threshold = parseFloat(numMatch[1]);
    if (!threshold) return null;
    const fieldMatches = [...src.matchAll(/\.([a-zA-Z_$]\w*)\b/g)].map(m => m[1]);
    const field = fieldMatches[fieldMatches.length - 1];
    if (!field) return null;
    const current = (stats && stats[field] !== undefined) ? stats[field]
      : (profile && profile[field] !== undefined ? profile[field] : 0);
    return { current: Number(current) || 0, threshold };
  } catch (e) {
    return null;
  }
}

function findNextBadge(list, profile, stats) {
  let best = null;
  for (const badge of list) {
    if (badge.comingSoon) continue;
    if (isBadgeEarned(badge, profile, stats)) continue;
    const detail = badgeProgressDetail(badge, profile, stats);
    if (!detail) continue;
    const fraction = Math.max(0, Math.min(1, detail.current / detail.threshold));
    if (!best || fraction > best.fraction) best = { badge, fraction, current: detail.current, threshold: detail.threshold };
  }
  return best;
}

function renderNextBadgeCard(idPrefix, list, profile, stats) {
  const card = document.getElementById(idPrefix + 'NextBadgeCard');
  if (!card) return;
  const next = findNextBadge(list, profile, stats);
  if (!next) { card.style.display = 'none'; return; }
  card.style.display = 'flex';
  const iconSrc = cachedIconUrl(`icons/badges/${next.badge.icon}`);
  const pair = badgeColorPair(next.badge);
  const iconEl = document.getElementById(idPrefix + 'NextBadgeIcon');
  if (iconEl) {
    iconEl.style.background = pair ? pair.fg : 'var(--accent)';
    const glyph = pair ? pair.bg : 'var(--accent-contrast)';
    iconEl.innerHTML = `<span class="dashboard-next-badge-icon-glyph" style="background-color:${glyph};-webkit-mask:url('${iconSrc}') center / contain no-repeat;mask:url('${iconSrc}') center / contain no-repeat;"></span>`;
  }
  const nameEl = document.getElementById(idPrefix + 'NextBadgeName');
  if (nameEl) nameEl.textContent = badgeName(next.badge);
  const fillEl = document.getElementById(idPrefix + 'NextBadgeFill');
  if (fillEl) { fillEl.style.width = (next.fraction * 100) + '%'; fillEl.style.background = pair ? pair.fg : 'var(--accent)'; }
  const textEl = document.getElementById(idPrefix + 'NextBadgeText');
  if (textEl) textEl.textContent = `${Math.floor(next.current)} / ${next.threshold}`;
}

function renderBadgeCountHeader(idPrefix, list, profile, stats) {
  const el = document.getElementById(idPrefix + 'BadgesCount');
  if (!el) return;
  const obtainable = list.filter(b => !b.comingSoon);
  const earned = obtainable.filter(b => isBadgeEarned(b, profile, stats));
  el.textContent = `${earned.length} / ${obtainable.length}`;
}

function badgeProgressFraction(badge, earned, profile, stats) {
  if (earned) return 1;
  if (badge.comingSoon) return 0;
  try {
    const src = badge.check.toString();
    const numMatch = src.match(/>=\s*(\d+(?:\.\d+)?)/);
    if (!numMatch) return 0;
    const threshold = parseFloat(numMatch[1]);
    if (!threshold) return 0;
    const fieldMatches = [...src.matchAll(/\.([a-zA-Z_$]\w*)\b/g)].map(m => m[1]);
    const field = fieldMatches[fieldMatches.length - 1];
    if (!field) return 0;
    const current = (stats && stats[field] !== undefined) ? stats[field]
      : (profile && profile[field] !== undefined ? profile[field] : 0);
    return Math.max(0, Math.min(1, (Number(current) || 0) / threshold));
  } catch (e) {
    return 0;
  }
}

const DASHBOARD_TIER_COLORS = ['#9ca3af', '#93c5fd', '#5eead4', '#5ec98a', '#f0b429', '#c084fc'];
const BADGE_CATEGORY_COLORS = {
  Reporting:   { fg:'#f0b429', bg:'#3a2a0f' },
  Community:   { fg:'#93c5fd', bg:'#1f2937' },
  Exploration: { fg:'#5ec98a', bg:'#123a26' },
  Activity:    { fg:'#84cc16', bg:'#1a3a14' },
  Streak:      { fg:'#c084fc', bg:'#2a1245' },
  Fun:         { fg:'#f472b6', bg:'#3a1530' },
  Secret:      { fg:'#5eead4', bg:'#0f3b36' },
  Moderation:  { fg:'#818cf8', bg:'#1e1b4b' },
  'Anti-Spam': { fg:'#f87171', bg:'#3a1414' },
  Local:       { fg:'#ca8a04', bg:'#2e2410' },
  Performance: { fg:'#fb923c', bg:'#3a2210' },
  Development: { fg:'#a78bfa', bg:'#241a3a' },
  Elite:       { fg:'#f0b429', bg:'#3a2a0f' },
};
function badgeColorPair(badge) { return BADGE_CATEGORY_COLORS[badge.category] || null; }
function tierColorForLevel(level) {
  const i = Math.max(0, Math.min(DASHBOARD_TIER_COLORS.length - 1, Math.round(level)));
  return DASHBOARD_TIER_COLORS[i];
}
function buildStarRowHtml(filled, total, color) {
  total = total || 5;
  filled = Math.max(0, Math.min(total, Math.round(filled)));
  let html = '';
  for (let i = 1; i <= total; i++) {
    const isFilled = i <= filled;
    html += `<span class="dashboard-star${isFilled ? ' filled' : ''}"${isFilled ? ` style="color:${color};"` : ''}>★</span>`;
  }
  return html;
}
function setIdentityRingFraction(fraction, color) {
  const ring = document.getElementById('dashboardIdentityRingFill');
  if (!ring) return;
  const c = 106.81;
  const offset = c * (1 - Math.max(0, Math.min(1, fraction)));
  ring.style.strokeDashoffset = offset.toFixed(2);
  if (color) ring.style.stroke = color;
}

function badgeProgressRingSvg(fraction, color) {
  const r = 46;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - Math.max(0, Math.min(1, fraction)));
  const fillStyle = `stroke-dasharray:${c.toFixed(2)};stroke-dashoffset:${offset.toFixed(2)};${color ? `stroke:${color};` : ''}`;
  return `<svg class="badge-progress-ring" viewBox="0 0 100 100" aria-hidden="true">
    <circle class="badge-progress-ring-track" cx="50" cy="50" r="${r}"></circle>
    <circle class="badge-progress-ring-fill" cx="50" cy="50" r="${r}" style="${fillStyle}"></circle>
  </svg>`;
}
function levelBadgeIcon(level) {
  const b = BADGES[level - 1];
  return b ? b.icon : null;
}
function buildBadgeIconHtml(badge, earnedIn, profile, stats) {
  const soon = !!badge.comingSoon;
  const earned = soon ? false : earnedIn;
  const iconSrc = cachedIconUrl(`icons/badges/${badge.icon}`);
  const pair = badgeColorPair(badge);
  const bg    = earned ? (pair ? pair.fg : 'var(--accent)') : 'var(--bg-surface-alt)';
  const glyph = earned ? (pair ? pair.bg : 'var(--accent-contrast)') : 'var(--text-secondary)';
  const ringColor = pair ? pair.fg : null;
  const titleSuffix = soon ? ` (${t('badgeComingSoon')})` : '';
  const fraction = soon ? 0 : badgeProgressFraction(badge, earned, profile, stats);
  return `<div class="badge-tile${earned ? ' earned' : ''}${soon ? ' badge-tile-soon' : ''}" title="${escapeHtml(badgeName(badge))}: ${escapeHtml(badgeDesc(badge))}${titleSuffix}" onclick="showBadgeInfo('${badge.id}', ${earned}, ${soon}, ${fraction})">
    <div class="badge-tile-circle-wrap">
      ${earned ? '' : badgeProgressRingSvg(fraction, ringColor)}
      <div class="badge-tile-circle" style="background:${bg};">
        <span class="badge-tile-glyph" style="background-color:${glyph};-webkit-mask:url('${iconSrc}') center / contain no-repeat;mask:url('${iconSrc}') center / contain no-repeat;"></span>
        ${soon ? `<span class="badge-tile-soon-ribbon">${escapeHtml(t('badgeComingSoonShort'))}</span>` : ''}
      </div>
    </div>
    <div class="badge-tile-name">${escapeHtml(badgeName(badge))}</div>
  </div>`;
}

function findBadgeById(id) {
  return [...BADGES, ...USER_BADGES_EXTRA, ...ADMIN_BADGES, ...ADMIN_BADGES_EXTRA].find(b => b.id === id);
}
function showBadgeInfo(id, earned, soon, fraction) {
  const badge = findBadgeById(id);
  if (!badge) return;
  const iconSrc = cachedIconUrl(`icons/badges/${badge.icon}`);
  const pair = badgeColorPair(badge);
  const bg    = earned ? (pair ? pair.fg : 'var(--accent)') : 'var(--bg-surface-alt)';
  const glyph = earned ? (pair ? pair.bg : 'var(--accent-contrast)') : 'var(--text-secondary)';
  document.getElementById('badgeInfoIconCircle').style.background = bg;
  const glyphEl = document.getElementById('badgeInfoIconGlyph');
  glyphEl.style.backgroundColor = glyph;
  glyphEl.style.webkitMask = `url('${iconSrc}') center / contain no-repeat`;
  glyphEl.style.mask = `url('${iconSrc}') center / contain no-repeat`;
  const ringSlot = document.getElementById('badgeInfoIconRing');
  const isEarnedForRing = soon ? false : earned;
  if (ringSlot) ringSlot.innerHTML = isEarnedForRing ? '' : badgeProgressRingSvg(typeof fraction === 'number' ? fraction : 0, pair ? pair.fg : null);
  document.getElementById('badgeInfoName').textContent = badgeName(badge);
  document.getElementById('badgeInfoDesc').textContent = badgeDesc(badge) + (soon ? ` (${t('badgeComingSoon')})` : '');
  const statusEl = document.getElementById('badgeInfoStatus');
  const isEarned = soon ? false : earned;
  statusEl.textContent = isEarned ? t('badgeEarnedLabel') : t('badgeLockedLabel');
  statusEl.className = 'badge-info-status ' + (isEarned ? 'is-earned' : 'is-locked');
  const modal = document.getElementById('badgeInfoModal');
  bringModalToFront(modal);
  modal.style.display = 'flex';
  openOverlay('badgeInfoModal', hideBadgeInfo);
}
function hideBadgeInfo() {
  const modal = document.getElementById('badgeInfoModal');
  if (modal) modal.style.display = 'none';
  closeOverlay('badgeInfoModal');
}

const ADMIN_LEVELS = [
  { level:1, nameEn:'Municipal Controller',  nameSr:'Opštinski kontrolor' },
  { level:2, nameEn:'Regional Director',     nameSr:'Regionalni direktor' },
  { level:3, nameEn:'Continental Director',  nameSr:'Kontinentalni direktor' },
  { level:4, nameEn:'Global Overseer',       nameSr:'Globalni nadzornik' },
];
// Was 3 back when level 3 meant "sees everything". Level 3 now means
// continent-scoped and level 4 is the new global tier — bumped to 4 so any
// existing admin profile without an explicit admin_level (which relied on
// this fallback to mean "global") keeps global access instead of silently
// becoming an unconfigured, locked-out continent admin.
const ADMIN_DEFAULT_LEVEL = 4;

function adminLevelInfo(lvl) { return ADMIN_LEVELS.find(a => a.level === lvl) || null; }
function adminLevelName(lvl) {
  const info = adminLevelInfo(lvl);
  if (!info) return '';
  return isSerbianLang() ? info.nameSr : info.nameEn;
}

function currentAdminLevel() {
  if (!currentProfile || !currentProfile.is_admin) return 0;
  return currentProfile.admin_level || ADMIN_DEFAULT_LEVEL;
}

function updateAdminPanelButtonVisibility() {
  const btn = document.getElementById('adminPanelBtn');
  if (!btn) return;
  const isAdmin = !!(currentSession && currentProfile && currentProfile.is_admin);
  btn.style.display = isAdmin ? 'flex' : 'none';
  if (!isAdmin) return;
  const lvl = currentAdminLevel();
  const icon = document.getElementById('adminPanelBtnIcon');
  if (icon) icon.src = 'icons/badges/badge-admin-admin-' + lvl + '.png';
}

// CSV export (Settings > Time Window Filter) is restricted to level-4
// (global) admins only — everyone else shouldn't even see the option
// exists, not just have the button fail/refuse if pressed.
function updateCsvExportVisibility() {
  const section = document.getElementById('timeWindowFilterSection');
  if (!section) return;
  section.style.display = currentAdminLevel() >= 4 ? '' : 'none';
}

const ADMIN_BADGES = [
  { id:'first_review',   icon:'badge-first-review.png',    nameEn:'First Review',      nameSr:'Prva provera',
    descEn:'Resolve your first flagged report.',                  descSr:'Rešite svoju prvu prijavljenu prijavu.',
    check: (p, s) => s.resolvedFlagCount >= 1 },
  { id:'trusted_reviewer', icon:'badge-trusted-reviewer.png', nameEn:'Trusted Reviewer', nameSr:'Pouzdani proveravač',
    descEn:'Resolve 20 flagged reports.',                          descSr:'Rešite 20 prijavljenih prijava.',
    check: (p, s) => s.resolvedFlagCount >= 20 },
  { id:'veteran_moderator', icon:'badge-veteran-moderator.png', nameEn:'Veteran Moderator', nameSr:'Iskusni moderator',
    descEn:'Resolve 100 flagged reports.',                          descSr:'Rešite 100 prijavljenih prijava.',
    check: (p, s) => s.resolvedFlagCount >= 100 },
];

const ADMIN_BADGES_EXTRA = [
  { id:'a_first_approval', icon:'badge-admin-first-approval.png', nameEn:'First Approval', nameSr:'Prvo odobrenje',
    descEn:'Approve your first report.', descSr:'Odobrite svoju prvu prijavu.',
    category:'Moderation', check: (p, s) => s.resolvedReportCount >= 1 },
  { id:'a_cleanup_crew', icon:'badge-admin-cleanup-crew.png', nameEn:'Cleanup Crew', nameSr:'Ekipa za čišćenje',
    descEn:'Resolve 200 reports.', descSr:'Rešite 200 prijava.',
    category:'Moderation', check: (p, s) => s.resolvedReportCount >= 200 },
  { id:'a_fair_judge', icon:'badge-admin-fair-judge.png', nameEn:'Fair Judge', nameSr:'Pravedan sudija',
    descEn:'Make 150 moderation decisions.', descSr:'Donesite 150 moderatorskih odluka.',
    category:'Moderation', check: (p, s) => s.moderationCount >= 150 },
  { id:'a_fast_responder', icon:'badge-admin-fast-responder.png', nameEn:'Fast Responder', nameSr:'Brz odgovor',
    descEn:'Resolve 50 reports within 1 hour.', descSr:'Rešite 50 prijava u roku od 1 sata.',
    category:'Moderation', check: (p, s) => s.fastResolves >= 50 },
  { id:'a_precision_moderator', icon:'badge-admin-precision-moderator.png', nameEn:'Precision Moderator', nameSr:'Precizan moderator',
    descEn:'Make 750 moderation decisions.', descSr:'Donesite 750 moderatorskih odluka.',
    category:'Moderation', check: (p, s) => s.moderationCount >= 750 },
  { id:'a_eagle_eye', icon:'badge-admin-eagle-eye.png', nameEn:'Eagle Eye', nameSr:'Orlovo oko',
    descEn:'Resolve 60 flagged reports.', descSr:'Rešite 60 prijavljenih prijava.',
    category:'Moderation', check: (p, s) => s.resolvedFlagCount >= 60 },
  { id:'a_guardian', icon:'badge-admin-guardian.png', nameEn:'Guardian', nameSr:'Čuvar',
    descEn:'Moderate 1500 reports.', descSr:'Modirajte 1500 prijava.',
    category:'Moderation', check: (p, s) => s.moderationCount >= 1500 },
  { id:'a_chief_moderator', icon:'badge-admin-chief-moderator.png', nameEn:'Chief Moderator', nameSr:'Šef moderator',
    descEn:'Moderate 15000 reports.', descSr:'Modirajte 15000 prijava.',
    category:'Moderation', check: (p, s) => s.moderationCount >= 15000 },
  { id:'a_detective', icon:'badge-admin-detective.png', nameEn:'Detective', nameSr:'Detektiv',
    descEn:'Resolve 30 flagged reports.', descSr:'Rešite 30 prijavljenih prijava.',
    category:'Anti-Spam', check: (p, s) => s.resolvedFlagCount >= 30 },
  { id:'a_spam_slayer', icon:'badge-admin-spam-slayer.png', nameEn:'Spam Slayer', nameSr:'Ubica spama',
    descEn:'Resolve 120 flagged reports.', descSr:'Rešite 120 prijavljenih prijava.',
    category:'Anti-Spam', check: (p, s) => s.resolvedFlagCount >= 120 },
  { id:'a_clean_feed', icon:'badge-admin-clean-feed.png', nameEn:'Clean Feed', nameSr:'Čist feed',
    descEn:'Keep a 4-week moderation streak.', descSr:'Održite niz moderisanja od 4 nedelje.',
    category:'Anti-Spam', check: (p, s) => s.streakWeeks >= 4 },
  { id:'a_community_helper', icon:'badge-admin-community-helper.png', nameEn:'Community Helper', nameSr:'Pomoćnik zajednice',
    descEn:'Resolve 60 reports.', descSr:'Rešite 60 prijava.',
    category:'Community', check: (p, s) => s.resolvedReportCount >= 60 },
  { id:'a_good_communicator', icon:'badge-admin-good-communicator.png', nameEn:'Good Communicator', nameSr:'Dobar komunikator',
    descEn:'Make 250 moderation decisions.', descSr:'Donesite 250 moderatorskih odluka.',
    category:'Community', check: (p, s) => s.moderationCount >= 250 },
  { id:'a_mentor', icon:'badge-admin-mentor.png', nameEn:'Mentor', nameSr:'Mentor',
    descEn:'Resolve 20 flagged reports.', descSr:'Rešite 20 prijavljenih prijava.',
    category:'Community', check: (p, s) => s.resolvedFlagCount >= 20 },
  { id:'a_peacemaker', icon:'badge-admin-peacemaker.png', nameEn:'Peacemaker', nameSr:'Mirotvorac',
    descEn:'Resolve 35 flagged reports.', descSr:'Rešite 35 prijavljenih prijava.',
    category:'Community', check: (p, s) => s.resolvedFlagCount >= 35 },
  { id:'a_district_keeper', icon:'badge-admin-district-keeper.png', nameEn:'District Keeper', nameSr:'Čuvar okruga',
    descEn:'Keep a 26-week moderation streak.', descSr:'Održite niz moderisanja od 26 nedelja.',
    category:'Local', check: (p, s) => s.streakWeeks >= 26 },
  { id:'a_regional_hero', icon:'badge-admin-regional-hero.png', nameEn:'Regional Hero', nameSr:'Regionalni heroj',
    descEn:'Moderate 2500 reports.', descSr:'Modirajte 2500 prijava.',
    category:'Local', check: (p, s) => s.moderationCount >= 2500 },
  { id:'a_city_steward', icon:'badge-admin-city-steward.png', nameEn:'City Steward', nameSr:'Gradski upravitelj',
    descEn:'Moderate 4000 reports.', descSr:'Modirajte 4000 prijava.',
    category:'Local', check: (p, s) => s.moderationCount >= 4000 },
  { id:'a_on_duty', icon:'badge-admin-on-duty.png', nameEn:'On Duty', nameSr:'Na dužnosti',
    descEn:'Keep a 21-day moderation streak.', descSr:'Održite niz moderisanja od 21 dana.',
    category:'Performance', check: (p, s) => s.streakDays >= 21 },
  { id:'a_dedicated', icon:'badge-admin-dedicated.png', nameEn:'Dedicated', nameSr:'Posvećen',
    descEn:'Moderate weekly for 3 months.', descSr:'Modirajte nedeljno 3 meseca.',
    category:'Performance', check: (p, s) => s.streakWeeks >= 13 },
  { id:'a_lightning_review', icon:'badge-admin-lightning-review.png', nameEn:'Lightning Review', nameSr:'Munjevita provera',
    descEn:'Resolve 150 reports in one day.', descSr:'Rešite 150 prijava u jednom danu.',
    category:'Performance', check: (p, s) => s.maxDayCount >= 150 },
  { id:'a_marathon_moderator', icon:'badge-admin-marathon-moderator.png', nameEn:'Marathon Moderator', nameSr:'Maratonski moderator',
    descEn:'Resolve 7500 reports.', descSr:'Rešite 7500 prijava.',
    category:'Performance', check: (p, s) => s.moderationCount >= 7500 },
  { id:'a_builder', icon:'badge-admin-builder.png', nameEn:'Builder', nameSr:'Graditelj',
    descEn:'Add your first utility company.', descSr:'Dodajte svoje prvo komunalno preduzeće.',
    category:'Development', check: (p, s) => s.companiesAdded >= 1 },
  { id:'a_organizer', icon:'badge-admin-organizer.png', nameEn:'Organizer', nameSr:'Organizator',
    descEn:'Add 20 utility companies.', descSr:'Dodajte 20 komunalnih preduzeća.',
    category:'Development', check: (p, s) => s.companiesAdded >= 20 },
  { id:'a_mapper', icon:'badge-admin-mapper.png', nameEn:'Mapper', nameSr:'Kartograf',
    descEn:'Add 100 utility companies.', descSr:'Dodajte 100 komunalnih preduzeća.',
    category:'Development', check: (p, s) => s.companiesAdded >= 100 },
  { id:'a_cartographer', icon:'badge-admin-cartographer.png', nameEn:'Cartographer', nameSr:'Kartograf terena',
    descEn:'Add 250 utility companies.', descSr:'Dodajte 250 komunalnih preduzeća.',
    category:'Development', check: (p, s) => s.companiesAdded >= 250 },
  { id:'a_top_moderator', icon:'badge-admin-top-moderator.png', nameEn:'Top Moderator', nameSr:'Moderator meseca',
    descEn:'Resolve 60 reports in one day.', descSr:'Rešite 60 prijava u jednom danu.',
    category:'Elite', check: (p, s) => s.maxDayCount >= 60 },
  { id:'a_diamond_admin', icon:'badge-admin-diamond-admin.png', nameEn:'Diamond Admin', nameSr:'Dijamantski administrator',
    descEn:'Reach the highest moderator level.', descSr:'Dostignite najviši nivo moderatora.',
    category:'Elite', check: (p, s) => s.adminXpLevelNum >= 8 },
  { id:'a_hall_of_fame', icon:'badge-admin-hall-of-fame.png', nameEn:'Hall of Fame', nameSr:'Kuća slavnih',
    descEn:'Moderate 20000 reports.', descSr:'Modirajte 20000 prijava.',
    category:'Elite', check: (p, s) => s.moderationCount >= 20000 },
  { id:'legend_admin', icon:'badge-admin-legend.png', nameEn:'Legend', nameSr:'Legenda',
    descEn:'Earn every admin badge.', descSr:'Osvojite svaku administratorsku značku.',
    category:'Elite', check: (p, s) => s.allEarned },
  { id:'a_super_admin', icon:'badge-admin-super-admin.png', nameEn:'Super Admin', nameSr:'Super administrator',
    descEn:'Resolve 120 reports in one day.', descSr:'Rešite 120 prijava u jednom danu.',
    category:'Secret', check: (p, s) => s.maxDayCount >= 120 },
  { id:'a_night_shift', icon:'badge-admin-night-shift.png', nameEn:'Night Shift', nameSr:'Noćna smena',
    descEn:'Resolve 75 reports between midnight and 5 AM.', descSr:'Rešite 75 prijava između ponoći i 5 ujutru.',
    category:'Secret', check: (p, s) => s.nightShiftCount >= 75 },
  { id:'a_coffee_powered', icon:'badge-admin-coffee-powered.png', nameEn:'Coffee Powered', nameSr:'Na kafi',
    descEn:'Resolve 40 reports within 1 hour of being reported.', descSr:'Rešite 40 prijava u roku od 1 sata od prijave.',
    category:'Secret', check: (p, s) => s.fastResolves >= 40 },
  { id:'a_mind_reader', icon:'badge-admin-mind-reader.png', nameEn:'Mind Reader', nameSr:'Čitač misli',
    descEn:'Resolve 150 flagged reports.', descSr:'Rešite 150 prijavljenih prijava.',
    category:'Secret', check: (p, s) => s.resolvedFlagCount >= 150 },
  { id:'a_invisible_hero', icon:'badge-admin-invisible-hero.png', nameEn:'Invisible Hero', nameSr:'Nevidljivi heroj',
    descEn:'Resolve 1200 reports.', descSr:'Rešite 1200 prijava.',
    category:'Secret', check: (p, s) => s.resolvedReportCount >= 1200 },
  { id:'a_launch_control', icon:'badge-admin-launch-control.png', nameEn:'Launch Control', nameSr:'Kontrola lansiranja',
    descEn:'Keep a 7-day moderation streak.', descSr:'Održite niz moderisanja od 7 dana.',
    category:'Secret', check: (p, s) => s.streakDays >= 7 },
];

const ADMIN_XP_LEVELS = [
  { level:1, xp:0,     nameEn:'Moderator I',             nameSr:'Moderator I' },
  { level:2, xp:500,   nameEn:'Moderator II',            nameSr:'Moderator II' },
  { level:3, xp:1500,  nameEn:'Senior Moderator',        nameSr:'Viši moderator' },
  { level:4, xp:3500,  nameEn:'Area Manager',            nameSr:'Rukovodilac oblasti' },
  { level:5, xp:7000,  nameEn:'Regional Manager',        nameSr:'Regionalni rukovodilac' },
  { level:6, xp:12000, nameEn:'Chief Moderator',         nameSr:'Šef moderatora' },
  { level:7, xp:20000, nameEn:'Master Moderator',        nameSr:'Majstor moderator' },
  { level:8, xp:35000, nameEn:'Legendary Administrator', nameSr:'Legendarni administrator' },
];
function adminXpLevelForXp(xp) {
  let cur = ADMIN_XP_LEVELS[0];
  for (const l of ADMIN_XP_LEVELS) { if (xp >= l.xp) cur = l; else break; }
  return cur;
}
function nextAdminXpLevel(lvl) { return ADMIN_XP_LEVELS.find(l => l.level === lvl.level + 1) || null; }
function adminXpLevelName(lvl) { return isSerbianLang() ? lvl.nameSr : lvl.nameEn; }

async function getAdminModerationStats() {
  const empty = {
    resolvedFlagCount:0, resolvedReportCount:0, moderationCount:0, resolvedThisWeek:0,
    weeklyBreakdown:[0,0,0,0,0,0,0],
    fastResolves:0, maxDayCount:0, streakDays:0, streakWeeks:0,
    nightShiftCount:0, adminXpLevelNum:1, companiesAdded:0, allEarned:false,
  };
  if (!currentSession) return empty;
  try {
    const [{ count: flagCount, error: flagErr }, { data: resolvedRows, error: reportErr }, { count: companiesAddedCount, error: companiesErr }] = await Promise.all([
      sb.from('report_flags').select('id', { count: 'exact', head: true }).eq('resolved_by', currentSession.user.id),
      sb.from(TABLE).select('created_at, photo_reviewed_at').eq('photo_reviewed_by', currentSession.user.id),
      sb.from(UTILITY_COMPANIES_TABLE).select('id', { count: 'exact', head: true }).eq('created_by', currentSession.user.id),
    ]);
    if (flagErr) throw flagErr;
    if (reportErr) throw reportErr;
    if (companiesErr) throw companiesErr;
    const companiesAdded = companiesAddedCount || 0;

    const rows = resolvedRows || [];
    const resolvedFlagCount = flagCount || 0;
    const resolvedReportCount = rows.length;
    const moderationCount = resolvedReportCount + resolvedFlagCount;
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const resolvedThisWeek = rows.filter(r => r.photo_reviewed_at && new Date(r.photo_reviewed_at).getTime() >= weekAgo).length;

    const nowD = new Date();
    const mondayIdx = (nowD.getDay() + 6) % 7;
    const monday = new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate() - mondayIdx);
    const weeklyBreakdown = [0, 0, 0, 0, 0, 0, 0];
    rows.forEach(r => {
      if (!r.photo_reviewed_at) return;
      const diffDays = Math.floor((new Date(r.photo_reviewed_at) - monday) / 86400000);
      if (diffDays >= 0 && diffDays < 7) weeklyBreakdown[diffDays]++;
    });

    const fastResolves = rows.filter(r => r.created_at && r.photo_reviewed_at &&
      (new Date(r.photo_reviewed_at) - new Date(r.created_at)) <= 60 * 60 * 1000).length;

    const nightShiftCount = rows.filter(r => {
      if (!r.photo_reviewed_at) return false;
      const h = new Date(r.photo_reviewed_at).getHours();
      return h >= 0 && h < 5;
    }).length;

    const dayKey = d => { const dt = new Date(d); return `${dt.getFullYear()}-${dt.getMonth()}-${dt.getDate()}`; };
    const dayCounts = {};
    rows.forEach(r => { if (r.photo_reviewed_at) dayCounts[dayKey(r.photo_reviewed_at)] = (dayCounts[dayKey(r.photo_reviewed_at)] || 0) + 1; });
    const maxDayCount = Object.keys(dayCounts).length ? Math.max(...Object.values(dayCounts)) : 0;

    const dayMs = 24 * 60 * 60 * 1000;
    const distinctDays = [...new Set(rows.filter(r => r.photo_reviewed_at).map(r => {
      const dt = new Date(r.photo_reviewed_at);
      return Math.floor(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()) / dayMs);
    }))].sort((a, b) => a - b);
    let streakDays = 0, runDays = 0;
    for (let i = 0; i < distinctDays.length; i++) {
      runDays = (i > 0 && distinctDays[i] === distinctDays[i - 1] + 1) ? runDays + 1 : 1;
      streakDays = Math.max(streakDays, runDays);
    }

    const distinctWeeks = [...new Set(distinctDays.map(d => Math.floor(d / 7)))].sort((a, b) => a - b);
    let streakWeeks = 0, runWeeks = 0;
    for (let i = 0; i < distinctWeeks.length; i++) {
      runWeeks = (i > 0 && distinctWeeks[i] === distinctWeeks[i - 1] + 1) ? runWeeks + 1 : 1;
      streakWeeks = Math.max(streakWeeks, runWeeks);
    }

    const adminXpLevelNum = adminXpLevelForXp(moderationCount).level;

    const stats = {
      resolvedFlagCount, resolvedReportCount, moderationCount, resolvedThisWeek, weeklyBreakdown, fastResolves,
      maxDayCount, streakDays, streakWeeks, nightShiftCount, adminXpLevelNum, companiesAdded,
      allEarned:false,
    };
    const everyOtherAdminBadge = [...ADMIN_BADGES, ...ADMIN_BADGES_EXTRA].filter(b => b.id !== 'legend_admin');
    stats.allEarned = everyOtherAdminBadge.every(b => b.check(null, stats));
    return stats;
  } catch (err) {
    console.error('Failed to load admin moderation stats:', err.message || err);
    return empty;
  }
}

const _adminMuniLookupWarned = new Set();
function getMunicipalityForAdminAssignment(value) {
  if (value == null) return null;
  const byId = municipalityById.get(String(value));
  if (byId) return byId;
  const bySlug = municipalityCache.find(m => m.slug === value);
  if (bySlug) return bySlug;
  const byOsmId = municipalityCache.find(m => String(m.osm_id) === String(value));
  if (byOsmId) return byOsmId;
  const byName = municipalityCache.find(m =>
    normalizeMuniNameForMatch(m.name) === normalizeMuniNameForMatch(value) ||
    normalizeMuniNameForMatch(m.name_en) === normalizeMuniNameForMatch(value));
  if (byName) return byName;
  if (!_adminMuniLookupWarned.has(String(value)) && municipalityCacheLoaded) {
    _adminMuniLookupWarned.add(String(value));
    console.warn(
      `admin_municipality_id "${value}" does not match any cached municipality's id, slug, or osm_id.`,
      'Available municipalities (id | slug | name):',
      municipalityCache.map(m => `${m.id} | ${m.slug || '—'} | ${m.name_en || m.name}`)
    );
  }
  return null;
}

// Resolves the continent for a level-3 (continent-scoped) admin. Prefers an
// explicit admin_continent if set, but falls back to deriving it from
// admin_country_code — so an admin can simply be given a country code (which
// may already be set from when they were a level-2 country admin) and the
// app automatically widens their domain to that country's whole continent,
// without needing a separate continent value assigned.
function resolveAdminContinent(profileLike) {
  if (!profileLike) return '';
  if (profileLike.admin_continent) return profileLike.admin_continent;
  return profileLike.admin_country_code ? continentOfCountry(profileLike.admin_country_code) : '';
}

function currentAdminTag() {
  const lvl = currentAdminLevel();
  if (!lvl) return '';
  if (lvl >= 4) return t('adminTagGlobal');
  if (lvl === 3) {
    const continent = resolveAdminContinent(currentProfile);
    return continent ? t('adminTagContinent').replace('{continent}', continentDisplayName(continent)) : t('adminTagUnset');
  }
  if (lvl === 2) return currentProfile.admin_country_code ? countryDisplayName(currentProfile.admin_country_code) : t('adminTagUnset');
  const muni = currentProfile.admin_municipality_id != null
    ? getMunicipalityForAdminAssignment(currentProfile.admin_municipality_id) : null;
  return muni ? municipalityDisplayName(muni) : t('adminTagUnset');
}

function isMunicipalityInAdminDomain(muni) {
  const lvl = currentAdminLevel();
  if (!lvl) return false;
  if (lvl >= 4) return true;
  if (!muni) return false;
  if (lvl === 3) {
    const continent = resolveAdminContinent(currentProfile);
    return !!(continent && continentOfCountry(muni.country_code) === continent);
  }
  if (lvl === 2) {
    return !!(currentProfile.admin_country_code && muni.country_code === currentProfile.admin_country_code);
  }
  if (currentProfile.admin_municipality_id == null) return false;
  const ownMuni = getMunicipalityForAdminAssignment(currentProfile.admin_municipality_id);
  return !!(ownMuni && String(ownMuni.id) === String(muni.id));
}

function isMunicipalityInAdminRowDomain(muni, row) {
  if (!row) return false;
  const lvl = row.admin_level || ADMIN_DEFAULT_LEVEL;
  if (lvl >= 4) return true;
  if (!muni) return false;
  if (lvl === 3) {
    const continent = resolveAdminContinent(row);
    return !!(continent && continentOfCountry(muni.country_code) === continent);
  }
  if (lvl === 2) {
    return !!(row.admin_country_code && muni.country_code === row.admin_country_code);
  }
  if (row.admin_municipality_id == null) return false;
  const ownMuni = getMunicipalityForAdminAssignment(row.admin_municipality_id);
  return !!(ownMuni && String(ownMuni.id) === String(muni.id));
}

function isReportInAdminDomain(report) {
  if (!currentAdminLevel()) return false;
  if (currentAdminLevel() >= 4) return true;
  if (!report) return false;
  let muni = report.municipality_id != null ? getMunicipalityById(report.municipality_id) : null;
  if (!muni && isValidLatLng(report.latitude, report.longitude)) {

    muni = findMunicipalityInCache(report.latitude, report.longitude);
  }
  return isMunicipalityInAdminDomain(muni);
}

function isAdminOnSiteOf(report) {
  if (!userCoords || !report || !isValidLatLng(report.latitude, report.longitude)) return false;
  return distMeters(userCoords, { lat: report.latitude, lon: report.longitude }) <= VOTE_PROXIMITY_MAX_M;
}

function hasFullPowerOverReport(report) {
  if (!currentProfile || !currentProfile.is_admin) return false;
  return isReportInAdminDomain(report) || isAdminOnSiteOf(report);
}

function reporterBanControlHtml(report) {
  if (!currentSession || !report || !report.owner_id) return '';
  if (currentAdminLevel() < 2) return '';
  if (report.owner_id === currentSession.user.id) return '';
  return `<button type="button" class="detail-ban-btn" id="banBtn-${report.id}" disabled onclick="toggleBanReportOwner('${report.id}','${report.owner_id}')">${t('banLoadingBtn')}</button>`;
}

async function refreshBanButtonState(reportId, ownerId) {
  const btn = document.getElementById(`banBtn-${reportId}`);
  if (!btn) return;
  try {
    const { data, error } = await sb.from('profiles').select('is_banned').eq('id', ownerId).maybeSingle();
    if (error) throw error;
    const banned = !!(data && data.is_banned);
    btn.dataset.banned = banned ? '1' : '0';
    btn.textContent = banned ? t('unbanBtn') : t('banBtn');
    btn.classList.toggle('is-banned', banned);
  } catch (err) {
    console.error('Failed to load ban status:', err.message);
    btn.textContent = t('banBtn');
    btn.dataset.banned = '0';
  } finally {
    btn.disabled = false;
  }
}

async function toggleBanReportOwner(reportId, ownerId) {
  const btn = document.getElementById(`banBtn-${reportId}`);
  const currentlyBanned = !!(btn && btn.dataset.banned === '1');
  let reason = null;
  if (!currentlyBanned) {
    reason = await themedPrompt(t('banReasonPrompt'), '');
    if (reason === null) return;

  } else if (!(await themedConfirm(t('unbanConfirm')))) {
    return;
  }
  if (btn) btn.disabled = true;
  try {
    const { data, error } = await sb.rpc('set_user_banned', {
      p_user_id: ownerId,
      p_banned: !currentlyBanned,
      p_reason: reason ? cyrillicToLatin(reason) : null
    });
    if (error) throw error;
    if (!data || !data.ok) {
      const reasonMap = {
        not_permitted:    t('banNotPermitted'),
        cannot_ban_admin: t('banCannotBanAdmin'),
        cannot_ban_self:  t('banCannotBanSelf'),
        user_not_found:   t('banUserNotFound')
      };
      toast((data && reasonMap[data.reason]) || t('banActionFailed'), 'error');
      if (btn) btn.disabled = false;
      return;
    }
    toast(currentlyBanned ? t('unbanSuccess') : t('banSuccess'), 'success');
    await refreshBanButtonState(reportId, ownerId);
  } catch (err) {
    console.error('Failed to update ban status:', err.message);
    toast(t('banActionFailed'), 'error');
    if (btn) btn.disabled = false;
  }
}

let leaderboardCityMuni = null;

function showLeaderboardModal() {
  document.getElementById('leaderboardModalTitle').innerHTML = '<img class="icon-img icon-img-inline" src="icons/trophy.png" alt=""> ' + t('leaderboardTitle');
  const lbModal = document.getElementById('leaderboardModal');
  bringModalToFront(lbModal);
  lbModal.style.display = 'flex';
  leaderboardCityMuni = null;
  renderDashboardTab();
  openOverlay('leaderboardModal', hideLeaderboardModal);
}
function hideLeaderboardModal() {
  document.getElementById('leaderboardModal').style.display = 'none';
  closeOverlay('leaderboardModal');
}

let userNotificationsCache = [];

function showNotificationModal() {
  document.getElementById('notificationModalTitle').innerHTML =
    '<img class="icon-img icon-img-inline" src="icons/notification.png" alt=""> ' + t('notificationModalTitle');
  const notifModal = document.getElementById('notificationModal');
  bringModalToFront(notifModal);
  notifModal.style.display = 'flex';
  renderNotificationModalBody();
  startNotificationInboxAutoRefresh();
  openOverlay('notificationModal', hideNotificationModal);
}
function hideNotificationModal() {
  document.getElementById('notificationModal').style.display = 'none';
  if (!anyAdminQueueModalOpen()) stopWaitingListAutoRefresh();
  stopNotificationInboxAutoRefresh();
  closeOverlay('notificationModal');
}

function renderNotificationModalBody() {
  const isAdmin = !!(currentProfile && currentProfile.is_admin);
  const composePanel = document.getElementById('notificationComposePanel');
  const wlTitle = document.getElementById('notificationWaitingListSectionTitle');
  const wlList = document.getElementById('notificationWaitingList');
  const wlSearch = document.getElementById('adminSearchInput');
  const inboxTitle = document.getElementById('notificationInboxSectionTitle');
  const userList = document.getElementById('notificationUserList');

  document.getElementById('notificationComposeTitle').textContent = t('notificationComposeTitle');
  document.getElementById('notificationTargetAllLabel').textContent = t('notificationTargetAll');
  document.getElementById('notificationTargetUserLabel').textContent = t('notificationTargetUser');
  document.getElementById('notificationUsernameInput').placeholder = t('notificationUsernamePH');
  document.getElementById('notificationMessageInput').placeholder = t('notificationMessagePH');
  document.getElementById('notificationSendBtn').textContent = t('notificationSendBtn');
  if (wlTitle) wlTitle.textContent = t('waitingListSectionTitle');
  if (wlSearch) wlSearch.placeholder = t('adminSearchPH');
  if (inboxTitle) {
    const inboxTitleText = document.getElementById('notificationInboxSectionTitleText');
    if (inboxTitleText) inboxTitleText.textContent = t('notificationInboxSectionTitle');
  }
  const clearBtn = document.getElementById('notificationClearBtn');
  if (clearBtn) clearBtn.textContent = t('notificationClearBtn');

  if (isAdmin) {
    composePanel.style.display = 'block';
    wlTitle.style.display = 'block';
    wlList.style.display = 'block';
    if (wlSearch) wlSearch.style.display = 'block';
    resetAdminSearch();
    loadWaitingListAdmin();
    startWaitingListAutoRefresh();
    updateNotificationScopeUi();
  } else {
    composePanel.style.display = 'none';
    wlTitle.style.display = 'none';
    wlList.style.display = 'none';
    if (wlSearch) wlSearch.style.display = 'none';
  }
  if (inboxTitle) inboxTitle.style.display = 'flex';
  userList.style.display = 'block';
  loadUserNotifications();
}

// Shows the admin who they're actually about to reach when they broadcast —
// their moderation scope (municipality/country/continent/global), derived
// from the same admin_level/admin_municipality_id/admin_country_code/
// admin_continent fields used for report moderation, plus a live estimate
// of how many users that resolves to right now (send_broadcast_notification
// enforces the same scope server-side, so this is a preview, not the source
// of truth).
async function updateNotificationScopeUi() {
  const hintEl = document.getElementById('notificationScopeHint');
  const allRadio = document.getElementById('notificationTargetAll');
  if (!hintEl || !allRadio) return;
  const lvl = currentAdminLevel();
  if (lvl >= 4) {
    hintEl.textContent = t('notificationScopeGlobal');
    allRadio.disabled = false;
  } else {
    const scopeLabel = currentAdminTag();
    if (!scopeLabel || scopeLabel === t('adminTagUnset')) {
      hintEl.textContent = t('notificationScopeUnset');
      allRadio.disabled = true;
      if (allRadio.checked) {
        allRadio.checked = false;
        document.getElementById('notificationTargetUser').checked = true;
        onNotificationTargetChange();
      }
      return;
    }
    allRadio.disabled = false;
    const key = lvl === 1 ? 'notificationScopeMuni' : lvl === 2 ? 'notificationScopeCountry' : 'notificationScopeContinent';
    hintEl.textContent = t(key).replace('{scope}', scopeLabel);
  }
  try {
    const { data, error } = await sb.rpc('admin_broadcast_recipient_count');
    if (!error && typeof data === 'number') {
      hintEl.textContent += t('notificationScopeCount').replace('{count}', data);
    }
  } catch (err) {
    console.error('Failed to load broadcast recipient count:', err.message || err);
  }
}

function onNotificationTargetChange() {
  const toUser = document.getElementById('notificationTargetUser').checked;
  document.getElementById('notificationUsernameWrap').style.display = toUser ? 'block' : 'none';
  if (!toUser) {
    document.getElementById('notificationUsernameInput').value = '';
    document.getElementById('notificationUsernameResults').innerHTML = '';
  }
}

let notificationUsernameSearchTimer = null;
function handleNotificationUsernameInput() {
  clearTimeout(notificationUsernameSearchTimer);
  const q = document.getElementById('notificationUsernameInput').value.trim();
  const resultsEl = document.getElementById('notificationUsernameResults');
  if (!q) { resultsEl.innerHTML = ''; return; }
  notificationUsernameSearchTimer = setTimeout(() => searchNotificationUsernames(q), 300);
}

async function searchNotificationUsernames(q) {
  const resultsEl = document.getElementById('notificationUsernameResults');
  try {
    const { data, error } = await sb.from(PROFILES_TABLE)
      .select('id, username, avatar_url')
      .not('username', 'is', null)
      .ilike('username', '%' + q.replace(/[%_]/g, '\\$&') + '%')
      .order('username')
      .limit(8);
    if (error) throw error;
    if (!data || !data.length) {
      resultsEl.innerHTML = `<div class="navigate-result-empty">${t('notificationUserNotFound')}</div>`;
      return;
    }
    resultsEl.innerHTML = '';
    data.forEach(p => {
      const item = document.createElement('div');
      item.className = 'navigate-result-item';
      item.textContent = p.username;
      item.onclick = () => {
        document.getElementById('notificationUsernameInput').value = p.username;
        resultsEl.innerHTML = '';
      };
      resultsEl.appendChild(item);
    });
  } catch (err) {
    console.error('Username search failed:', err.message);
    resultsEl.innerHTML = `<div class="navigate-result-empty">${t('notificationSendFailed')}</div>`;
  }
}

async function sendNotificationFromAdmin() {
  const message = document.getElementById('notificationMessageInput').value.trim();
  if (!message) { toast(t('notificationEmptyMessage'), 'error'); return; }
  const toUser = document.getElementById('notificationTargetUser').checked;
  const btn = document.getElementById('notificationSendBtn');
  btn.disabled = true;
  try {
    let data, error;
    if (toUser) {
      const username = document.getElementById('notificationUsernameInput').value.trim();
      if (!username) { toast(t('notificationNoUsername'), 'error'); return; }
      ({ data, error } = await sb.rpc('send_direct_notification', { p_username: username, p_message: message }));
    } else {
      ({ data, error } = await sb.rpc('send_broadcast_notification', { p_message: message }));
    }
    if (error) throw error;
    if (data && data.ok === false) {
      if (data.reason === 'user_not_found') toast(t('notificationUserNotFound'), 'error');
      else if (data.reason === 'user_out_of_scope') toast(t('notificationUserOutOfScope'), 'error');
      else toast(t('notificationSendFailed'), 'error');
      return;
    }
    document.getElementById('notificationMessageInput').value = '';
    document.getElementById('notificationUsernameInput').value = '';
    document.getElementById('notificationUsernameResults').innerHTML = '';
    toast(t('notificationSent'), 'success');
  } catch (err) {
    console.error('Send notification failed:', err.message);
    toast(t('notificationSendFailed'), 'error');
  } finally {
    btn.disabled = false;
  }
}

async function loadUserNotifications(silent) {
  if (!currentSession) { userNotificationsCache = []; renderUserNotifications(); return; }
  const listEl = document.getElementById('notificationUserList');
  if (!silent) listEl.innerHTML = `<div class="detail-loading">${t('detailLoading')}</div>`;
  try {
    const { data, error } = await sb.from('notifications')
      .select('*')
      .eq('recipient_id', currentSession.user.id)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    userNotificationsCache = data || [];
    renderUserNotifications();
    markVisibleNotificationsRead();
  } catch (err) {
    console.error('Failed to load notifications:', err.message);
    listEl.innerHTML = `<div class="detail-empty">${t('notificationLoadFailed')}</div>`;
  }
}

function renderUserNotifications() {
  const listEl = document.getElementById('notificationUserList');
  if (!listEl) return;
  const clearBtn = document.getElementById('notificationClearBtn');
  if (clearBtn) clearBtn.style.display = userNotificationsCache.length ? '' : 'none';
  if (!userNotificationsCache.length) {
    listEl.innerHTML = `<div class="detail-empty">${t('notificationsEmpty')}</div>`;
    return;
  }
  listEl.innerHTML = userNotificationsCache.map(n => {

    const reportId = n.report_id || n.related_report_id || null;
    const clickable = !!reportId;
    return `
    <div class="notification-item${n.is_read ? '' : ' unread'}"${clickable ? ` onclick="openNotificationReportTarget('${reportId}')" style="cursor:pointer;"` : ''}>
      <div class="notification-item-top">
        <span class="notification-item-sender">${escapeHtml((n.notif_type === 'admin_message' || n.sender_is_admin) ? t('notificationAdminTag') : (n.sender_username || t('detailUnknown')))}</span>
        ${n.is_read ? '' : '<span class="notification-item-dot"></span>'}
      </div>
      <div class="notification-item-message">${escapeHtml(n.message)}</div>
      <div class="notification-item-meta">${formatDate(n.created_at)}</div>
    </div>`;
  }).join('');
}

function showClearNotificationsConfirm() {
  const modal = document.getElementById('clearNotifsConfirmModal');
  const inner = document.getElementById('clearNotifsConfirmModalInner');
  if (!modal || !inner) return;
  inner.innerHTML = `
    <h2>${t('notificationClearConfirmTitle')}</h2>
    <p>${t('notificationClearConfirmDesc')}</p>
    <div style="display:flex;gap:var(--space-8);">
      <button type="button" class="settings-btn" style="flex:1;" onclick="hideClearNotificationsConfirm()">${t('contactConfirmNoBtn')}</button>
      <button type="button" style="background:var(--danger, #d33);color:white;flex:1;border:none;border-radius:14px;padding:12px 20px;font-size:var(--fs-14);font-weight:var(--fw-semibold);cursor:pointer;min-height:44px;" onclick="confirmClearNotifications()">${t('notificationClearBtn')}</button>
    </div>
  `;
  bringModalToFront(modal);
  modal.style.display = 'flex';
  openOverlay('clearNotifsConfirmModal', hideClearNotificationsConfirm);
}

function hideClearNotificationsConfirm() {
  const modal = document.getElementById('clearNotifsConfirmModal');
  if (modal) modal.style.display = 'none';
  closeOverlay('clearNotifsConfirmModal');
}

async function confirmClearNotifications() {
  hideClearNotificationsConfirm();
  if (!currentSession) return;
  try {
    const { error } = await sb.from('notifications').delete().eq('recipient_id', currentSession.user.id);
    if (error) throw error;
    userNotificationsCache = [];
    renderUserNotifications();
    refreshUnreadNotificationCount();
    toast(t('notificationCleared'), 'success');
  } catch (err) {
    console.error('Failed to clear notifications:', err.message || err);
    toast(t('notificationClearFailed'), 'error');
  }
}

async function openNotificationReportTarget(reportId) {
  hideNotificationModal();
  await ensureReportLoadedThenShow(reportId);
}

async function markVisibleNotificationsRead() {
  const unreadIds = userNotificationsCache.filter(n => !n.is_read).map(n => n.id);
  if (!unreadIds.length) return;
  try {
    const { error } = await sb.from('notifications')
      .update({ is_read: true })
      .in('id', unreadIds);
    if (error) throw error;
    userNotificationsCache.forEach(n => { if (unreadIds.includes(n.id)) n.is_read = true; });
    renderUserNotifications();
  } catch (err) {
    console.error('Failed to mark notifications read:', err.message);
  }
  refreshUnreadNotificationCount();
}

async function refreshUnreadNotificationCount() {
  const badge = document.getElementById('notificationBadge');
  if (!badge) return;
  if (!currentSession) { badge.style.display = 'none'; return; }
  try {
    const { count, error } = await sb.from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('recipient_id', currentSession.user.id)
      .eq('is_read', false);
    if (error) throw error;
    if (count && count > 0) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.style.display = 'block';
    } else {
      badge.style.display = 'none';
    }
  } catch (err) {
    console.error('Failed to refresh notification count:', err.message);
  }
}

let notificationInboxRefreshIntervalId = null;
const NOTIFICATION_INBOX_REFRESH_MS = 15000;
function startNotificationInboxAutoRefresh() {
  if (notificationInboxRefreshIntervalId !== null) return;
  notificationInboxRefreshIntervalId = setInterval(() => {
    if (!anyAdminQueueModalOpen()) { stopNotificationInboxAutoRefresh(); return; }
    loadUserNotifications(true);
    refreshUnreadNotificationCount();
  }, NOTIFICATION_INBOX_REFRESH_MS);
}
function stopNotificationInboxAutoRefresh() {
  if (notificationInboxRefreshIntervalId !== null) {
    clearInterval(notificationInboxRefreshIntervalId);
    notificationInboxRefreshIntervalId = null;
  }
}

async function resolveLeaderboardCity() {
  if (leaderboardCityMuni) return leaderboardCityMuni;
  if (userCoords) {
    try {
      const muni = await resolveMunicipality(userCoords.lat, userCoords.lon);
      if (muni) { leaderboardCityMuni = muni; return muni; }
    } catch (err) {   }
  }
  if (currentSession) {
    try {
      const { data } = await sb.from(TABLE).select('municipality_id')
        .eq('owner_id', currentSession.user.id)
        .not('municipality_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1);
      const row = data && data[0];
      if (row && row.municipality_id != null) {
        const muni = getMunicipalityById(row.municipality_id);
        if (muni) { leaderboardCityMuni = muni; return muni; }
      }
    } catch (err) {   }
  }
  return null;
}

async function loadDashboardCityContribution() {
  const card = document.getElementById('dashboardCityCard');
  if (!card) return;
  try {
    const muni = await resolveLeaderboardCity();
    if (!muni || !currentSession || !currentProfile || currentProfile.is_admin) { card.style.display = 'none'; return; }
    // Both counts must be scoped to the SAME municipality, or "mine" (which
    // used to be the user's lifetime report count across every city they've
    // ever reported in) can end up bigger than "total" (reports in just this
    // one city) — e.g. "72 of 35 are yours". Run both queries scoped to
    // muni.id so mine is always <= total.
    const [totalRes, mineRes] = await Promise.all([
      sb.from(TABLE).select('id', { count: 'exact', head: true }).eq('municipality_id', muni.id),
      sb.from(TABLE).select('id', { count: 'exact', head: true }).eq('municipality_id', muni.id).eq('owner_id', currentSession.user.id),
    ]);
    if (totalRes.error) throw totalRes.error;
    if (mineRes.error) throw mineRes.error;
    if (!currentSession || !currentProfile || currentProfile.is_admin) return;
    const total = totalRes.count || 0;
    const myReportCount = mineRes.count || 0;
    const pct = total > 0 ? Math.min(100, (myReportCount / total) * 100) : 0;
    card.style.display = 'flex';
    const nameEl = document.getElementById('dashboardCityName');
    if (nameEl) nameEl.textContent = municipalityDisplayName(muni);
    const pctEl = document.getElementById('dashboardCityPct');
    if (pctEl) pctEl.textContent = (pct < 10 ? pct.toFixed(1) : Math.round(pct)) + '%';
    const detailEl = document.getElementById('dashboardCityDetailText');
    if (detailEl) detailEl.textContent = t('dashboardCityDetail').replace('{mine}', myReportCount).replace('{total}', total);
    const ring = document.getElementById('dashboardCityRingFill');
    if (ring) {
      const c = 2 * Math.PI * 46;
      ring.style.strokeDasharray = c.toFixed(2);
      ring.style.strokeDashoffset = (c * (1 - pct / 100)).toFixed(2);
    }
  } catch (err) {
    console.error('Failed to load city contribution stat:', err.message || err);
    card.style.display = 'none';
  }
}

async function getUserBadgeStats() {
  const empty = {
    reportCount:0, voteCount:0, photoCount:0, commentCount:0, distinctCities:0,
    reportsThisWeek:0, weeklyBreakdown:[0,0,0,0,0,0,0], successfulContributions:0, hasEarlyBirdReport:false,
    hasNightOwlReport:false, hasGhostHourReport:false, hasHalloweenReport:false,
    hasHolidayReport:false, maxLevelReached:false, allNonSecretEarned:false, allEarned:false,
  };
  if (!currentSession || !currentProfile) return empty;
  try {
    const { data, error } = await sb.from(TABLE)
      .select('created_at, comment, photo_path, municipality_id')
      .eq('owner_id', currentSession.user.id);
    if (error) throw error;
    const rows = data || [];

    const totalContributions = currentProfile.total_contributions || 0;
    const successfulContributions = currentProfile.successful_contributions || 0;
    const reportCount = rows.length;
    const voteCount = Math.max(0, totalContributions - reportCount);
    const photoCount = rows.filter(r => r.photo_path).length;
    const commentCount = rows.filter(r => r.comment && r.comment.trim()).length;
    const distinctCities = new Set(rows.map(r => r.municipality_id).filter(v => v != null)).size;
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const reportsThisWeek = rows.filter(r => r.created_at && new Date(r.created_at).getTime() >= weekAgo).length;

    const now = new Date();
    const mondayIdx = (now.getDay() + 6) % 7;
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - mondayIdx);
    const weeklyBreakdown = [0, 0, 0, 0, 0, 0, 0];
    rows.forEach(r => {
      if (!r.created_at) return;
      const diffDays = Math.floor((new Date(r.created_at) - monday) / 86400000);
      if (diffDays >= 0 && diffDays < 7) weeklyBreakdown[diffDays]++;
    });

    const hour = iso => new Date(iso).getHours();
    const hasEarlyBirdReport = rows.some(r => r.created_at && hour(r.created_at) < 6);
    const hasNightOwlReport  = rows.some(r => r.created_at && hour(r.created_at) < 4);
    const hasGhostHourReport = rows.some(r => r.created_at && hour(r.created_at) === 3);
    const isHalloween = d => { const dt = new Date(d); return dt.getMonth() === 9 && dt.getDate() === 31; };
    const isMajorHoliday = d => {
      const dt = new Date(d), m = dt.getMonth(), day = dt.getDate();
      return (m === 0 && day === 1) || (m === 11 && (day === 25 || day === 31));
    };
    const hasHalloweenReport = rows.some(r => r.created_at && isHalloween(r.created_at));
    const hasHolidayReport = rows.some(r => r.created_at && isMajorHoliday(r.created_at));

    const maxLevelReached = levelForPoints(totalContributions).level >= USER_LEVELS[USER_LEVELS.length - 1].level;

    const stats = {
      reportCount, voteCount, photoCount, commentCount, distinctCities, reportsThisWeek, weeklyBreakdown,
      successfulContributions, hasEarlyBirdReport, hasNightOwlReport, hasGhostHourReport,
      hasHalloweenReport, hasHolidayReport, maxLevelReached,
      allNonSecretEarned:false, allEarned:false,
    };
    const allBadges = [...BADGES, ...USER_BADGES_EXTRA];
    const metaIds = ['completionist', 'legend_user', 'mythic_citizen'];
    const nonMeta = allBadges.filter(b => !metaIds.includes(b.id));
    const nonMetaNonSecret = nonMeta.filter(b => b.category !== 'Secret');
    stats.allNonSecretEarned = nonMetaNonSecret.every(b => isBadgeEarned(b, currentProfile, stats));
    stats.allEarned = nonMeta.every(b => isBadgeEarned(b, currentProfile, stats));
    return stats;
  } catch (err) {
    console.error('Failed to load user badge stats:', err.message || err);
    return empty;
  }
}

const WEEKDAY_LABELS_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAY_LABELS_SR = ['Pon', 'Uto', 'Sre', 'Čet', 'Pet', 'Sub', 'Ned'];
function renderWeeklyChart(elId, breakdown) {
  const el = document.getElementById(elId);
  if (!el) return;
  const counts = breakdown || [0, 0, 0, 0, 0, 0, 0];
  const labels = isSerbianLang() ? WEEKDAY_LABELS_SR : WEEKDAY_LABELS_EN;
  const max = Math.max(1, ...counts);
  el.innerHTML = counts.map((c, i) => {
    const pct = Math.max(4, Math.round((c / max) * 100));
    return `
    <div class="weekly-chart-col">
      <div class="weekly-chart-bar-wrap">
        <div class="weekly-chart-value">${c}</div>
        <div class="weekly-chart-bar" style="height:${pct}%"></div>
      </div>
      <div class="weekly-chart-day">${escapeHtml(labels[i])}</div>
    </div>`;
  }).join('');
}

async function renderUserDashboard() {
  const section = document.getElementById('dashboardSection');
  if (!section) return;

  if (!currentSession || !currentProfile || currentProfile.is_admin) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'flex';

  const points = currentProfile.total_contributions || 0;
  const successful = currentProfile.successful_contributions || 0;
  const lvl = currentUserLevel();
  const next = nextUserLevel(lvl);

  const badgeIcon = levelBadgeIcon(lvl.level);

  const idBadgeEl = document.getElementById('dashboardIdentityBadge');
  if (idBadgeEl) {
    idBadgeEl.className = 'leaderboard-rank dashboard-identity-badge tier-level-' + lvl.level;
    idBadgeEl.innerHTML = badgeIcon
      ? `<img src="icons/badges/${badgeIcon}" alt="" onerror="this.style.display='none';">`
      : '';
  }
  const idStatusEl = document.getElementById('dashboardIdentityStatus');
  if (idStatusEl) idStatusEl.textContent = levelName(lvl);

  const tierColor = tierColorForLevel(lvl.level);
  const starRowEl = document.getElementById('dashboardStarRow');
  if (starRowEl) starRowEl.innerHTML = buildStarRowHtml(lvl.level, 5, tierColor);

  const fillEl = document.getElementById('dashboardProgressFill');
  const progressText = document.getElementById('dashboardProgressText');
  fillEl.style.background = tierColor;
  if (!next) {
    fillEl.style.width = '100%';
    progressText.textContent = t('profileMaxLevel');
    setIdentityRingFraction(1, tierColor);
  } else {
    const remaining = Math.max(0, next.threshold - points);
    const span = next.threshold - lvl.threshold;
    const into = Math.max(0, points - lvl.threshold);
    const fraction = span > 0 ? Math.min(1, into / span) : 1;
    fillEl.style.width = (fraction * 100) + '%';
    progressText.textContent = t('profileProgressToNext')
      .replace('{n}', remaining).replace('{level}', levelName(next));
    setIdentityRingFraction(fraction, tierColor);
  }

  document.getElementById('dashboardStatPoints').textContent = points;
  document.getElementById('dashboardStatSuccessful').textContent = successful;
  document.getElementById('dashboardStatWeight').textContent = 'x' + lvl.weight;

  const [stats] = await Promise.all([getUserBadgeStats()]);
  if (!currentSession || !currentProfile || currentProfile.is_admin) return;

  renderWeeklyChart('dashboardWeeklyChart', stats.weeklyBreakdown);

  const setStat = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setStat('dashboardStatReports', stats.reportCount || 0);
  setStat('dashboardStatPhotos', stats.photoCount || 0);
  setStat('dashboardStatComments', stats.commentCount || 0);
  setStat('dashboardStatCities', stats.distinctCities || 0);
  setStat('dashboardStatVotes', stats.voteCount || 0);

  loadDashboardCityContribution();
  loadDashboardStreakAndQuests();

  const allBadges = [...BADGES, ...USER_BADGES_EXTRA];
  renderBadgeCountHeader('dashboard', allBadges, currentProfile, stats);
  renderNextBadgeCard('dashboard', allBadges, currentProfile, stats);

  const badgeGrid = document.getElementById('dashboardBadgeGrid');
  if (badgeGrid) {
    badgeGrid.innerHTML = allBadges.map(b => buildBadgeIconHtml(b, isBadgeEarned(b, currentProfile, stats), currentProfile, stats)).join('');
  }
}

// ---- Streak card + quest cards (engagement_rules / user_engagement_progress / user_streaks) ----
// Quests are entirely data-driven: engagement_rules rows define what exists, this just renders
// whatever's active. Adding a new quest later needs zero changes here.
function dashboardQuestPeriodStart(period) {
  const now = new Date();
  if (period === 'weekly') {
    const day = now.getUTCDay();
    const diff = (day === 0 ? -6 : 1) - day;
    const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + diff));
    return monday.toISOString().slice(0, 10);
  }
  if (period === 'daily') return now.toISOString().slice(0, 10);
  return '1970-01-01';
}

async function loadDashboardStreakAndQuests() {
  if (!currentSession || !currentProfile || currentProfile.is_admin) return;
  const uid = currentSession.user.id;

  try {
    const { data: streak, error: streakErr } = await sb.from('user_streaks')
      .select('current_streak, longest_streak, last_report_date')
      .eq('user_id', uid).maybeSingle();
    if (streakErr) throw streakErr;
    if (!currentSession || currentSession.user.id !== uid) return;
    renderDashboardStreak(streak);
  } catch (err) {
    console.error('Failed to load streak:', err.message);
    if (currentSession && currentSession.user.id === uid) {
      // The streak card may already be showing a previous value (stale-but-
      // not-wrong) or may never have loaded at all — either way, a silent
      // console.error gives the user no signal anything went wrong, so
      // surface it distinctly from a genuine "no streak yet" state.
      const card = document.getElementById('dashboardStreakCard');
      const hadPriorValue = card && card.style.display === 'flex';
      toast(t(hadPriorValue ? 'dashboardQuestsRefreshFailed' : 'dashboardStreakLoadError'), 'error');
    }
  }

  await loadQuestsInto(uid, 'user', document.getElementById('dashboardQuestsList'));

  const historyBtn = document.getElementById('dashboardQuestHistoryToggle');
  if (historyBtn && !historyBtn.dataset.bound) {
    historyBtn.dataset.bound = '1';
    historyBtn.textContent = t('dashboardQuestHistoryShow');
    historyBtn.addEventListener('click', toggleDashboardQuestHistory);
  }
}

async function loadAdminQuests() {
  if (!currentSession || !currentProfile || !currentProfile.is_admin) return;
  await loadQuestsInto(currentSession.user.id, 'admin', document.getElementById('adminQuestsList'));
}

async function loadQuestsInto(uid, scope, listEl) {
  if (!listEl) return;
  try {
    const { data: rules, error: rulesErr } = await sb.from('engagement_rules')
      .select('*').eq('active', true).eq('type', 'quest').eq('scope', scope).order('created_at', { ascending: true });
    if (rulesErr) throw rulesErr;
    const withPeriods = (rules || []).map(rule => ({ rule, period: dashboardQuestPeriodStart(rule.config && rule.config.period) }));

    let progressRows = [];
    const ruleKeys = withPeriods.map(x => x.rule.key);
    if (ruleKeys.length) {
      const { data: prog, error: progErr } = await sb.from('user_engagement_progress')
        .select('rule_key, period_start, progress, status')
        .eq('user_id', uid).in('rule_key', ruleKeys);
      if (progErr) throw progErr;
      progressRows = prog || [];
    }
    if (!currentSession || currentSession.user.id !== uid) return;
    renderDashboardQuests(withPeriods, progressRows, listEl);
    listEl.dataset.loadedOnce = '1';
  } catch (err) {
    console.error('Failed to load ' + scope + ' quests:', err.message);
    if (!currentSession || currentSession.user.id !== uid) return;
    showQuestLoadError(listEl, uid, scope);
  }
}

// Distinguishes "never successfully loaded" (show an inline error + retry
// button in place of the empty list, since silently leaving it blank looks
// identical to "you have no quests") from "had a good render before, this
// refresh just failed" (leave the last-known cards up rather than yanking
// them, just flag via toast that it's possibly stale).
function showQuestLoadError(listEl, uid, scope) {
  if (listEl.dataset.loadedOnce === '1') {
    toast(t('dashboardQuestsRefreshFailed'), 'error');
    return;
  }
  listEl.innerHTML = `<div class="dashboard-quests-load-error">
    <span>${escapeHtml(t('dashboardQuestsLoadError'))}</span>
    <button type="button" class="dashboard-quests-retry-btn">${escapeHtml(t('retryBtn'))}</button>
  </div>`;
  const btn = listEl.querySelector('.dashboard-quests-retry-btn');
  if (btn) btn.addEventListener('click', () => loadQuestsInto(uid, scope, listEl));
}

function renderDashboardStreak(streak) {
  const card = document.getElementById('dashboardStreakCard');
  if (!card) return;
  const current = (streak && streak.current_streak) || 0;
  const longest = (streak && streak.longest_streak) || 0;
  card.style.display = 'flex';

  const daysEl = document.getElementById('dashboardStreakDays');
  if (daysEl) daysEl.textContent = current;
  const bestEl = document.getElementById('dashboardStreakBest');
  if (bestEl) bestEl.textContent = longest;
  const flameEl = document.getElementById('dashboardStreakFlame');
  if (flameEl) flameEl.classList.toggle('is-cold', current === 0);

  const subEl = document.getElementById('dashboardStreakSub');
  if (subEl) {
    if (current === 0) {
      subEl.textContent = t('dashboardStreakStartHint');
    } else {
      const today = new Date().toISOString().slice(0, 10);
      const reportedToday = streak && streak.last_report_date === today;
      subEl.textContent = reportedToday ? t('dashboardStreakTodayDone') : t('dashboardStreakKeepGoing');
    }
  }
}

function renderDashboardQuests(withPeriods, progressRows, listEl) {
  listEl = listEl || document.getElementById('dashboardQuestsList');
  if (!listEl) return;
  if (!withPeriods.length) {
    listEl.innerHTML = `<div class="dashboard-quests-empty">${t('dashboardQuestsEmpty')}</div>`;
    return;
  }

  listEl.innerHTML = withPeriods.map(({ rule, period }) => {
    const row = progressRows.find(p => p.rule_key === rule.key && p.period_start === period);
    const count = (row && row.progress && row.progress.count) || 0;
    const target = (rule.config && rule.config.target) || 1;
    const complete = !!row && row.status === 'completed';
    const fraction = target > 0 ? Math.max(0, Math.min(1, count / target)) : 0;
    const title = (isSerbianLang() ? rule.title_sr : rule.title_en) || rule.key;
    const desc = isSerbianLang() ? rule.description_sr : rule.description_en;

    return `<div class="dashboard-quest-card${complete ? ' is-complete' : ''}">
      <div class="dashboard-quest-top">
        <span class="dashboard-quest-title"><span class="dashboard-quest-title-icon" style="background-color:${complete ? '#5ec98a' : '#93c5fd'};-webkit-mask:url('${complete ? 'icons/quest-complete.png' : 'icons/quest-target.png'}') center/contain no-repeat;mask:url('${complete ? 'icons/quest-complete.png' : 'icons/quest-target.png'}') center/contain no-repeat;"></span>${escapeHtml(title)}</span>
        ${rule.points_reward ? `<span class="dashboard-quest-reward">+${rule.points_reward} pts</span>` : ''}
      </div>
      ${desc ? `<div class="dashboard-quest-desc">${escapeHtml(desc)}</div>` : ''}
      <div class="dashboard-quest-track"><div class="dashboard-quest-fill${complete ? ' is-complete' : ''}" style="width:${(fraction * 100).toFixed(0)}%"></div></div>
      <div class="dashboard-quest-progress-text">${complete ? t('dashboardQuestComplete') : `${Math.min(count, target)}/${target}`}</div>
    </div>`;
  }).join('');
}

// ---- Quest history (past completed quest periods) ----
// Quests reset automatically every period (a new period_start = a fresh,
// re-completable quest), but old completed rows stay in
// user_engagement_progress. This surfaces them read-only so people can see
// what they've finished over time, without affecting the live quest cards
// above (which only ever look at the *current* period_start).
let questHistoryLoaded = false;

function toggleDashboardQuestHistory() {
  const panel = document.getElementById('dashboardQuestHistory');
  if (!panel) return;
  const showing = panel.style.display !== 'none';
  panel.style.display = showing ? 'none' : 'block';
  const btn = document.getElementById('dashboardQuestHistoryToggle');
  if (btn) btn.textContent = showing ? t('dashboardQuestHistoryShow') : t('dashboardQuestHistoryHide');
  if (!showing && !questHistoryLoaded) {
    questHistoryLoaded = true;
    loadDashboardQuestHistory();
  }
}

async function loadDashboardQuestHistory() {
  if (!currentSession || !currentProfile || currentProfile.is_admin) return;
  const uid = currentSession.user.id;
  const listEl = document.getElementById('dashboardQuestHistoryList');
  if (!listEl) return;
  listEl.innerHTML = `<div class="dashboard-quests-empty">${t('dashboardQuestHistoryLoading')}</div>`;
  try {
    const { data: rows, error: rowsErr } = await sb.from('user_engagement_progress')
      .select('rule_key, period_start, completed_at, progress')
      .eq('user_id', uid).eq('status', 'completed')
      .order('completed_at', { ascending: false })
      .limit(30);
    if (rowsErr) throw rowsErr;
    if (!currentSession || currentSession.user.id !== uid) return;

    if (!rows || !rows.length) {
      listEl.innerHTML = `<div class="dashboard-quests-empty">${t('dashboardQuestHistoryEmpty')}</div>`;
      return;
    }

    // Historical rows can reference quests that are now inactive (or since
    // removed), so pull rule titles for whatever keys actually show up here
    // rather than reusing the 'active' quest list.
    const keys = [...new Set(rows.map(r => r.rule_key))];
    const { data: rules, error: rulesErr } = await sb.from('engagement_rules')
      .select('key, title_en, title_sr, points_reward').in('key', keys);
    if (rulesErr) throw rulesErr;
    const rulesByKey = {};
    (rules || []).forEach(r => { rulesByKey[r.key] = r; });

    listEl.innerHTML = rows.map(row => {
      const rule = rulesByKey[row.rule_key];
      // engagement_rules RLS only lets non-admins read active=true rows, so a
      // retired quest's title/points won't resolve here — fall back to a
      // readable version of the key rather than the raw snake_case string.
      const title = rule ? (isSerbianLang() ? rule.title_sr : rule.title_en)
        : row.rule_key.replace(/^(weekly|daily)_/, '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const points = rule ? rule.points_reward : null;
      return `<div class="dashboard-quest-history-item">
        <div class="dashboard-quest-history-item-main">
          <span class="dashboard-quest-history-item-title">${escapeHtml(title)}</span>
          <span class="dashboard-quest-history-item-date">${formatDate(row.completed_at)}</span>
        </div>
        ${points ? `<span class="dashboard-quest-history-item-reward">+${points} pts</span>` : ''}
      </div>`;
    }).join('');
  } catch (err) {
    console.error('Failed to load quest history:', err.message);
    listEl.innerHTML = `<div class="dashboard-quests-empty">${t('dashboardQuestHistoryError')}</div>`;
  }
}

let myReportsCache = null;

let myReportsFilter = 'all';
let myReportsLoadToken = 0;

function buildMyReportCardHtml(report) {
  const catCol = categoryColor(report.category);
  const sCol = statusColor(report.status);
  const iconSrc = categoryIcon(report.category);
  const title = report.subcategory
    ? `${translateCategory(report.category)} / ${subcategoryLabel(report.category, report.subcategory)}`
    : translateCategory(report.category);
  return `<div class="my-report-card" onclick="openMyReportDetail('${report.id}')">
    <div class="my-report-card-icon" style="background:${catCol};">
      <span class="my-report-card-glyph" style="-webkit-mask-image:url('${iconSrc}');mask-image:url('${iconSrc}');-webkit-mask-size:contain;mask-size:contain;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;-webkit-mask-position:center;mask-position:center;"></span>
    </div>
    <div class="my-report-card-body">
      <div class="my-report-card-title">${escapeHtml(title)}</div>
      <div class="my-report-card-meta">${formatDate(report.created_at)}</div>
    </div>
    <span class="my-report-card-status" style="background:${sCol};">${statusLabel(report.status)}</span>
  </div>`;
}

// Shared helper: showReportDetailModal() only reads from globalActiveData (the map's
// currently-loaded dataset). Several UI surfaces (dashboard "My Reports" list, the contact
// reminder popup, etc.) load their own report data independently and can reference a report
// that isn't in globalActiveData yet (e.g. an older or already-fixed report not currently
// visible on the map). This helper fetches it into globalActiveData first when needed, then
// opens the modal. Returns true on success, false if the report couldn't be loaded.
async function ensureReportLoadedThenShow(reportId, failMessageKey) {
  if (!globalActiveData.some(r => r.id === reportId)) {
    try {
      const { data, error } = await sb.from(TABLE).select('*').eq('id', reportId).single();
      if (error || !data) throw (error || new Error('Report not found'));
      if (!globalActiveData.some(r => r.id === data.id)) { globalActiveData.push(data); markActiveDataChanged(); }
    } catch (err) {
      console.error('Failed to load report detail:', err.message || err);
      toast(t(failMessageKey || 'myReportOpenFailed'), 'error');
      return false;
    }
  }
  showReportDetailModal(reportId);
  return true;
}

// Opens the report detail modal from the dashboard's "My Reports" list (used by both
// regular users and admins). See ensureReportLoadedThenShow() above for why this is needed.
async function openMyReportDetail(reportId) {
  await ensureReportLoadedThenShow(reportId);
}

function setMyReportsFilter(filter) {
  myReportsFilter = filter;
  const row = document.getElementById('myReportsFilterRow');
  if (row) row.querySelectorAll('.theme-segment-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  renderMyReportsList();
}

function renderMyReportsList() {
  const list = document.getElementById('myReportsList');
  const empty = document.getElementById('myReportsEmpty');
  const countEl = document.getElementById('myReportsCount');
  if (!list || !empty) return;
  if (!Array.isArray(myReportsCache)) return;

  const filtered = myReportsFilter === 'all'
    ? myReportsCache
    : myReportsCache.filter(r => r.status === myReportsFilter);

  if (countEl) countEl.textContent = myReportsCache.length ? `${myReportsCache.length} ${t('myReportsCountSuffix')}` : '';

  if (!filtered.length) {
    list.innerHTML = '';
    empty.style.display = 'block';
    empty.textContent = myReportsCache.length ? t('myReportsEmptyFiltered') : t('myReportsEmpty');
    return;
  }
  empty.style.display = 'none';
  list.innerHTML = filtered.map(buildMyReportCardHtml).join('');
}

async function renderMyReportsSection() {
  const section = document.getElementById('myReportsSection');
  if (!section) return;
  if (!currentSession || !currentProfile) { section.style.display = 'none'; return; }
  section.style.display = 'flex';

  const loading = document.getElementById('myReportsLoading');
  const empty = document.getElementById('myReportsEmpty');
  const list = document.getElementById('myReportsList');
  const token = ++myReportsLoadToken;

  if (!Array.isArray(myReportsCache)) {
    if (loading) { loading.style.display = 'block'; loading.textContent = t('myReportsLoading'); loading.classList.remove('my-reports-error'); loading.onclick = null; }
    if (empty) empty.style.display = 'none';
    if (list) list.innerHTML = '';
  }

  try {
    const { data, error } = await sb.from(TABLE)
      .select('id,category,subcategory,status,priority,created_at,latitude,longitude')
      .eq('owner_id', currentSession.user.id)
      .order('created_at', { ascending: false });
    if (token !== myReportsLoadToken) return;
    if (error) throw error;
    myReportsCache = data || [];
    if (isTesterMode()) myReportsCache = applyTesterReportOverlay(myReportsCache);
    if (loading) loading.style.display = 'none';
    renderMyReportsList();
  } catch (err) {
    if (token !== myReportsLoadToken) return;
    console.error('Failed to load my reports:', err.message);
    if (loading) {
      loading.style.display = 'block';
      loading.textContent = t('myReportsError');
      loading.classList.add('my-reports-error');
      loading.onclick = () => { myReportsCache = null; renderMyReportsSection(); };
    }
  }
}

async function renderAdminDashboard() {
  updateAdminPanelButtonVisibility();
  updateCsvExportVisibility();
  const section = document.getElementById('adminDashboardSection');
  if (!section) return;

  if (!currentSession || !currentProfile || !currentProfile.is_admin) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'flex';

  if (currentAdminLevel() === 1 || currentAdminLevel() === 2 || currentAdminLevel() === 3) await loadMunicipalityCache();
  if (currentAdminLevel() === 3) await loadCountryContinentCache();
  if (!currentSession || !currentProfile || !currentProfile.is_admin) return;

  const lvl = currentAdminLevel();
  const tag = currentAdminTag();

  document.getElementById('adminDashboardTagValue').textContent = tag;

  const idBadgeEl = document.getElementById('dashboardIdentityBadge');
  if (idBadgeEl) {
    idBadgeEl.className = 'leaderboard-admin-badge dashboard-identity-badge tier-level-' + lvl;
    idBadgeEl.innerHTML = `<img src="icons/badges/badge-admin-admin-${lvl}.png" alt="" onerror="this.style.display='none';">`;
  }
  const idStatusEl = document.getElementById('dashboardIdentityStatus');
  if (idStatusEl) idStatusEl.textContent = adminLevelName(lvl);

  const noteKey = lvl === 1 ? 'adminDashboardScopeNote1' : lvl === 2 ? 'adminDashboardScopeNote2' : lvl === 3 ? 'adminDashboardScopeNote3' : 'adminDashboardScopeNote4';
  document.getElementById('adminDashboardScopeNote').textContent = t(noteKey);

  const stats = await getAdminModerationStats();
  if (!currentSession || !currentProfile || !currentProfile.is_admin) return;

  const resolvedValueEl = document.getElementById('adminDashboardResolvedValue');
  if (resolvedValueEl) resolvedValueEl.textContent = stats.resolvedFlagCount;

  const setAdminStat = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setAdminStat('adminDashboardStatReviewed', stats.resolvedReportCount || 0);
  setAdminStat('adminDashboardStatFast', stats.fastResolves || 0);
  setAdminStat('adminDashboardStatStreak', stats.streakDays || 0);
  setAdminStat('adminDashboardStatBusiest', stats.maxDayCount || 0);
  setAdminStat('adminDashboardStatNight', stats.nightShiftCount || 0);

  renderWeeklyChart('adminDashboardWeeklyChart', stats.weeklyBreakdown);
  loadAdminQuests();

  const xpLevel = adminXpLevelForXp(stats.moderationCount);
  const xpNext = nextAdminXpLevel(xpLevel);
  const cappedTier = Math.min(5, Math.max(1, xpLevel.level));
  const xpColor = tierColorForLevel(cappedTier);
  const xpPill = document.getElementById('adminDashboardXpPill');
  if (xpPill) {
    xpPill.textContent = xpLevel.level;
    xpPill.className = 'tier-pill dashboard-level-pill tier-level-' + cappedTier;
  }
  const xpNameEl = document.getElementById('adminDashboardXpName');
  if (xpNameEl) xpNameEl.textContent = adminXpLevelName(xpLevel);
  const starRowEl = document.getElementById('dashboardStarRow');
  if (starRowEl) starRowEl.innerHTML = buildStarRowHtml(cappedTier, 5, xpColor);
  const xpFillEl = document.getElementById('adminDashboardXpFill');
  const xpTextEl = document.getElementById('adminDashboardXpText');
  if (xpFillEl && xpTextEl) {
    xpFillEl.style.background = xpColor;
    if (!xpNext) {
      xpFillEl.style.width = '100%';
      xpTextEl.textContent = t('adminDashboardXpMax');
      setIdentityRingFraction(1, xpColor);
    } else {
      const span = xpNext.xp - xpLevel.xp;
      const into = Math.max(0, stats.moderationCount - xpLevel.xp);
      const fraction = span > 0 ? Math.min(1, into / span) : 1;
      xpFillEl.style.width = (fraction * 100) + '%';
      xpTextEl.textContent = t('adminDashboardXpProgress')
        .replace('{n}', Math.max(0, xpNext.xp - stats.moderationCount)).replace('{level}', adminXpLevelName(xpNext));
      setIdentityRingFraction(fraction, xpColor);
    }
  }

  const adminBadgeGrid = document.getElementById('adminDashboardBadgeGrid');
  const allAdminBadges = [...ADMIN_BADGES, ...ADMIN_BADGES_EXTRA];
  renderBadgeCountHeader('adminDashboard', allAdminBadges, null, stats);
  renderNextBadgeCard('adminDashboard', allAdminBadges, null, stats);
  if (adminBadgeGrid) {
    adminBadgeGrid.innerHTML = allAdminBadges.map(b => buildBadgeIconHtml(b, b.check(null, stats), null, stats)).join('');
  }

  loadAdminDigestHistory();
}

// Weekly Digest History (admin dashboard) — read-only log of the weekly
// municipality-admin digest for this admin (see admin_digest_log / the
// weekly-admin-digest cron job). Level-1 (municipal) admins only, since
// that's the only tier the digest is scoped to. "Download PDF" re-invokes
// the edge function on demand rather than storing PDFs in the DB — mirrors
// exportCompanyReportsPdf's weekly-utility-digest call, just with an
// adminId + weekStart instead of a companyId. NOTE: confirm the
// weekly-admin-digest edge function actually accepts { adminId, weekStart }
// and returns { results: [{ status, pdfBase64 }] } the same way — wire this
// up to whatever the real contract is if it differs.
async function loadAdminDigestHistory() {
  const titleEl = document.getElementById('adminDigestHistoryTitle');
  const listEl = document.getElementById('adminDigestHistoryList');
  if (!titleEl || !listEl) return;

  if (!currentSession || !currentProfile || !currentProfile.is_admin || currentAdminLevel() !== 1) {
    titleEl.style.display = 'none';
    listEl.style.display = 'none';
    return;
  }
  titleEl.style.display = '';
  listEl.style.display = 'flex';
  listEl.innerHTML = `<p class="detail-export-hint" style="margin:0;">${t('adminDigestHistoryLoading')}</p>`;

  try {
    const { data, error } = await sb
      .from('admin_digest_log')
      .select('week_start,status,report_count,created_at')
      .eq('admin_id', currentSession.user.id)
      .order('created_at', { ascending: false })
      .limit(12);
    if (error) throw error;

    if (!currentSession || !currentProfile || !currentProfile.is_admin) return;

    if (!data || !data.length) {
      listEl.innerHTML = `<p class="detail-export-hint" style="margin:0;">${t('adminDigestHistoryEmpty')}</p>`;
      return;
    }
    listEl.innerHTML = data.map(buildAdminDigestHistoryRowHtml).join('');
  } catch (err) {
    console.error('loadAdminDigestHistory error:', err.message || err);
    listEl.innerHTML = `<p class="detail-export-hint" style="margin:0;">${t('adminDigestHistoryError')}</p>`;
  }
}

function buildAdminDigestHistoryRowHtml(r) {
  const weekLabel = r.week_start ? formatDate(r.week_start) : '—';
  const sent = r.status === 'sent';
  const skipped = r.status === 'skipped';
  const pillColor = sent ? STATUS_COLORS.fixed : (skipped ? '#8b949e' : STATUS_COLORS.reported);
  const statusText = sent ? t('adminDigestStatusSent') : (skipped ? t('adminDigestStatusSkipped') : t('adminDigestStatusFailed'));
  const countText = sent ? t('adminDigestReportCount').replace('{n}', r.report_count ?? 0) : '';
  const downloadBtn = sent
    ? `<button type="button" class="detail-edit-btn" onclick="downloadAdminDigestPdf('${r.week_start}')">${t('adminDigestDownloadBtn')}</button>`
    : '';
  return `
    <div class="detail-row" style="align-items:center;">
      <span class="detail-row-label">${escapeHtml(weekLabel)}</span>
      <span class="detail-row-value" style="display:flex; align-items:center; justify-content:flex-end; gap:8px; white-space:nowrap;">
        ${countText ? `<span style="color:var(--text-muted); font-size:var(--fs-11);">${escapeHtml(countText)}</span>` : ''}
        <span class="status-pill" style="background:${pillColor};">${statusText}</span>
        ${downloadBtn}
      </span>
    </div>
  `;
}

let adminDigestPdfBusy = false;
async function downloadAdminDigestPdf(weekStart) {
  if (adminDigestPdfBusy || !currentSession) return;
  adminDigestPdfBusy = true;
  toast(t('adminDigestGenerating'), 'success');
  try {
    const { data, error } = await sb.functions.invoke('weekly-admin-digest', {
      body: { adminId: currentSession.user.id, weekStart }
    });
    if (error) throw error;

    const result = (data && Array.isArray(data.results)) ? data.results[0] : data;
    if (!result || !result.pdfBase64) {
      toast(t('adminDigestNoPdf'), 'error');
      return;
    }
    const blob = base64ToBlob(result.pdfBase64, 'application/pdf');
    const fileName = `admin-digest-${weekStart}.pdf`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileName;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast(t('adminDigestDownloaded'), 'success');
  } catch (err) {
    console.error('downloadAdminDigestPdf error:', err.message || err);
    toast(t('adminDigestFailed'), 'error');
  } finally {
    adminDigestPdfBusy = false;
  }
}

function renderDashboardTab() {
  const idRow = document.getElementById('dashboardIdentityCard');
  const title = document.getElementById('leaderboardModalTitle');
  const signOutBtn = document.getElementById('dashboardSignOutBtn');
  const hint = document.getElementById('dashboardSignedOutHint');
  const signedIn = !!(currentSession && currentProfile && currentProfile.username);

  idRow.style.display = signedIn ? 'flex' : 'none';
  title.style.display = signedIn ? 'none' : 'flex';
  signOutBtn.style.display = signedIn ? 'inline-block' : 'none';
  if (hint) hint.style.display = signedIn ? 'none' : 'block';

  if (signedIn) {
    document.getElementById('dashboardIdentityName').textContent = currentProfile.username;
    document.getElementById('dashboardIdentityAdminPill').style.display = currentProfile.is_admin ? 'inline-block' : 'none';
  }

  renderUserDashboard();
  renderAdminDashboard();
  renderMyReportsSection();
}

async function initAuth() {
  try {
    const { data: { session }, error } = await sb.auth.getSession();
    if (error) throw error;
    currentSession = session;
    if (currentSession) await loadProfile();
  } catch (err) {
    console.error('Failed to restore session:', err.message);
    currentSession = null;
    currentProfile = null;
  }
  updateAuthUI();
  stripAuthHashFromUrl();
  if (currentSession) {
    setupQuestProgressRealtimeSync(currentSession.user.id);
    setupNotificationsRealtimeSync(currentSession.user.id);
    setTimeout(maybeShowPushPrompt, 1500);
  }

  sb.auth.onAuthStateChange(async (event, session) => {
    currentSession = session;
    if (session) {
      await loadProfile();
      stripAuthHashFromUrl();
      setupQuestProgressRealtimeSync(session.user.id);
      setupNotificationsRealtimeSync(session.user.id);
      setTimeout(maybeShowPushPrompt, 1500);
    } else {
      currentProfile = null;
      updateAuthUI();
      teardownQuestProgressRealtimeSync();
      teardownNotificationsRealtimeSync();
    }
  });
}

// Quests/streak previously only refreshed when the dashboard tab was (re)opened
// (loadDashboardStreakAndQuests / loadAdminQuests). Since the actual writes to
// user_engagement_progress and user_streaks happen entirely server-side (DB
// triggers on report/vote/photo actions — see bump_quest_progress), the client
// had no way to know progress changed unless it re-opened the dashboard. This
// subscribes to just the current user's rows so quest cards update live.
let questProgressRealtimeChannel = null;
let questProgressRealtimeUid = null;

function setupQuestProgressRealtimeSync(uid) {
  if (!uid) return;
  if (questProgressRealtimeChannel && questProgressRealtimeUid === uid) return; // already subscribed for this user
  teardownQuestProgressRealtimeSync();
  questProgressRealtimeUid = uid;
  questProgressRealtimeChannel = sb.channel('quest-progress-live-sync-' + uid)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'user_engagement_progress', filter: 'user_id=eq.' + uid
    }, () => {
      try {
        if (!currentSession || currentSession.user.id !== uid) return;
        // Re-pull rather than hand-patch the payload row — the quest list also
        // needs the joined engagement_rules data, so this keeps rendering
        // logic in the one place (loadQuestsInto) instead of duplicating it.
        const scope = (currentProfile && currentProfile.is_admin) ? 'admin' : 'user';
        const listEl = document.getElementById(scope === 'admin' ? 'adminQuestsList' : 'dashboardQuestsList');
        loadQuestsInto(uid, scope, listEl);
      } catch (err) {
        console.error('Realtime quest progress sync error:', err);
      }
    })
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'user_streaks', filter: 'user_id=eq.' + uid
    }, payload => {
      try {
        if (!currentSession || currentSession.user.id !== uid) return;
        renderDashboardStreak(payload.new);
      } catch (err) {
        console.error('Realtime streak sync error:', err);
      }
    })
    .subscribe();
}

function teardownQuestProgressRealtimeSync() {
  if (questProgressRealtimeChannel) {
    sb.removeChannel(questProgressRealtimeChannel);
    questProgressRealtimeChannel = null;
  }
  questProgressRealtimeUid = null;
}

// Live badge count + in-app chime for the notifications inbox. This only
// covers the app being open in a tab (foreground or background) — actual
// push notifications when the browser/app isn't open are handled by the
// service worker's 'push' event instead (see sw.js), not this channel.
let notificationsRealtimeChannel = null;
let notificationsRealtimeUid = null;

function setupNotificationsRealtimeSync(uid) {
  if (!uid) return;
  if (notificationsRealtimeChannel && notificationsRealtimeUid === uid) return; // already subscribed for this user
  teardownNotificationsRealtimeSync();
  notificationsRealtimeUid = uid;
  notificationsRealtimeChannel = sb.channel('notifications-live-sync-' + uid)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'notifications', filter: 'recipient_id=eq.' + uid
    }, (payload) => {
      try {
        if (!currentSession || currentSession.user.id !== uid) return;
        playNotificationChime();
        refreshUnreadNotificationCount();
        const notifModal = document.getElementById('notificationModal');
        if (notifModal && notifModal.style.display !== 'none') renderNotificationModalBody();
      } catch (err) {
        console.error('Realtime notification sync error:', err);
      }
    })
    .subscribe((status, err) => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        console.error('[notifications realtime] failed to connect:', status, err);
      }
    });
}

function teardownNotificationsRealtimeSync() {
  if (notificationsRealtimeChannel) {
    sb.removeChannel(notificationsRealtimeChannel);
    notificationsRealtimeChannel = null;
  }
  notificationsRealtimeUid = null;
}

function stripAuthHashFromUrl() {
  if (!window.location.hash) return;
  if (!/access_token=|refresh_token=/.test(window.location.hash)) return;
  history.replaceState(null, '', window.location.pathname + window.location.search);
}

// ---------------------------------------------------------------------------
// Internationalization (i18n)
// ---------------------------------------------------------------------------
// Every UI string lives in /languages/<code>.json — one plain JSON file per
// language, shaped like:
//   { "name": "German", "nativeName": "Deutsch", "strings": { "key": "..." } }
//
// English (languages/en.json) is the base language: any language file that
// is missing a key silently falls back to the English string, then to the
// key name itself, so nothing ever renders blank.
//
// TO ADD A NEW LANGUAGE: copy languages/en.json, translate the "strings"
// object, set "name"/"nativeName", and save it as languages/<code>.json
// using one of the codes listed in EUROPEAN_LANGUAGES below. That's it —
// no other file needs to change. On the next page load the app probes for
// that file, finds it, and automatically enables + lists it in the language
// dropdown. (If you need a code that isn't in the list yet, add one line to
// EUROPEAN_LANGUAGES too.)
//
// Data that comes from the database rather than these files (report/badge
// names, municipality names, etc.) currently only ever has English/Serbian
// columns, so it always falls back to the English column for any other
// language — translating that content means adding columns server-side,
// which is a separate project from this file-based UI translation system.

// Every language we know how to *list* in the dropdown. Only the ones we
// can actually load a file for (checked at startup — see discoverLanguages)
// are enabled; the rest are shown disabled as a hint that a translation
// would be welcome.
// The full list of languages the app *knows how to list* -- code + native
// display name -- now lives in languages/languages.json instead of here, so
// adding a brand-new language code no longer requires touching app.js at
// all: add the entry to languages.json, drop in languages/<code>.json (and
// optionally languages/legal/<code>.json), done.
//
// TO ADD A NEW LANGUAGE:
//  1. Add { "code": "xx", "nativeName": "..." } to languages/languages.json
//  2. Copy languages/en.json to languages/<code>.json and translate "strings"
//  3. (optional) Copy languages/legal/en.json to languages/legal/<code>.json
// On the next page load the app fetches languages.json, then probes for a
// matching languages/<code>.json file per entry -- found files are enabled
// and listed in the language dropdown, missing ones show up disabled.
let EUROPEAN_LANGUAGES = [];

async function loadLanguageManifest() {
  try {
    const res = await fetch('languages/languages.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('languages.json ' + res.status);
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) throw new Error('languages.json empty/invalid');
    EUROPEAN_LANGUAGES = data.filter(l => l && typeof l.code === 'string' && typeof l.nativeName === 'string');
    // Alphabetical by each language's own native name (locale-aware, so
    // diacritics like Č/Š/Ž sort next to their base letter rather than at
    // the end) -- keeps the dropdown ordered without hand-sorting the JSON.
    EUROPEAN_LANGUAGES.sort((a, b) => a.nativeName.localeCompare(b.nativeName, undefined, { sensitivity: 'base' }));
  } catch (e) {
    console.error('Failed to load languages/languages.json, falling back to English only:', e.message);
    EUROPEAN_LANGUAGES = [{ code: 'en', nativeName: 'English' }];
  }
}

const DEFAULT_LANG = 'en'; // base/fallback language — always ships with the app

// Loaded string tables, keyed by language code, e.g. LANG_STRINGS.en.someKey
let LANG_STRINGS = {};
// Codes we've confirmed have a real languages/<code>.json file on this load.
let AVAILABLE_LANG_CODES = [];

// langOverride lets a caller ask for a string in a specific language instead
// of the current UI language — used for utility-company emails, where the
// preset subject/body should be in the *company's* language (see
// utilityLangFor below), not necessarily the reporting user's own UI lang.
function t(k, langOverride) {
  const l = langOverride || lang;
  const own = LANG_STRINGS[l] && LANG_STRINGS[l][k];
  if (own != null) return own;
  const fallback = LANG_STRINGS[DEFAULT_LANG] && LANG_STRINGS[DEFAULT_LANG][k];
  return fallback != null ? fallback : k;
}

async function loadLanguageFile(code) {
  try {
    const res = await fetch(`languages/${code}.json`, { cache: 'no-store' });
    if (!res.ok) {
      console.warn(`Language file languages/${code}.json not found (HTTP ${res.status})`);
      return false;
    }
    const data = await res.json();
    if (!data || typeof data !== 'object' || !data.strings) {
      console.warn(`Language file languages/${code}.json loaded but is missing a "strings" object`);
      return false;
    }
    LANG_STRINGS[code] = data.strings;
    if (!AVAILABLE_LANG_CODES.includes(code)) AVAILABLE_LANG_CODES.push(code);
    return true;
  } catch (e) {
    console.warn(`Language file languages/${code}.json failed to load/parse:`, e.message);
    return false;
  }
}

// Probes every known European language code for a matching file. This is
// what makes new languages appear automatically: nothing here needs to
// change when a translation file is added or removed from /languages.
async function discoverLanguages() {
  await loadLanguageManifest();
  await Promise.all(EUROPEAN_LANGUAGES.map(l => loadLanguageFile(l.code)));
  if (!AVAILABLE_LANG_CODES.includes(DEFAULT_LANG)) AVAILABLE_LANG_CODES.push(DEFAULT_LANG);
  renderLangSelect();
}

const LANG_STORAGE_KEY = 'ttb_lang';
const LANG_PREF_STORAGE_KEY = 'ttb_lang_pref';
let langPref = (function () {
  try { return localStorage.getItem(LANG_PREF_STORAGE_KEY) || localStorage.getItem(LANG_STORAGE_KEY) || 'auto'; } catch (e) { return 'auto'; }
})();
// Migrates the legacy 'sr' code (saved by anyone who picked Serbian before
// the Latin/Cyrillic split) to 'sr-Lat' so their choice keeps working. Without
// this, AVAILABLE_LANG_CODES never contains plain 'sr' anymore (only
// 'sr-Lat'/'sr-Cyrl'), so a returning user's saved language silently fails
// to match and they get bumped to English with no explanation.
function migrateLegacyLangCode(code) {
  return code === 'sr' ? 'sr-Lat' : code;
}
let lang = (function () {
  try { return migrateLegacyLangCode(localStorage.getItem(LANG_STORAGE_KEY)) || DEFAULT_LANG; } catch (e) { return DEFAULT_LANG; }
})();
let globalActiveData = [];

let activeDataVersion = 0;
function markActiveDataChanged() { activeDataVersion++; }
let fp = null;

// Serbian is offered in two scripts (sr-Lat / sr-Cyrl). Anywhere the app
// falls back to Serbian-language DB columns, date/number locales, TTS, etc.
// both codes should count as "Serbian" -- plus the legacy 'sr' code some
// users may still have saved in localStorage from before the split.
function isSerbianLang(l) {
  l = l || lang;
  return l === 'sr' || l === 'sr-Lat' || l === 'sr-Cyrl';
}

function renderLangSelect() {
  const sel = document.getElementById('langSelect');
  if (!sel) return;
  sel.innerHTML = EUROPEAN_LANGUAGES.map(l => {
    const available = AVAILABLE_LANG_CODES.includes(l.code);
    const label = available ? l.nativeName : `${l.nativeName} (${t('langNotAvailable')})`;
    return `<option value="${l.code}" ${available ? '' : 'disabled'}>${escapeHtml(label)}</option>`;
  }).join('');
  sel.value = AVAILABLE_LANG_CODES.includes(lang) ? lang : DEFAULT_LANG;
  updateLangAutoBtnUI();
}

function updateLangAutoBtnUI() {
  const btn = document.getElementById('langAutoBtn');
  if (btn) btn.classList.toggle('active', langPref === 'auto');
}

function setLang(l) {
  langPref = l;
  try { localStorage.setItem(LANG_PREF_STORAGE_KEY, l); } catch (e) {}
  updateLangAutoBtnUI();
  if (l === 'auto') {
    detectLanguageByLocation();
  } else {
    applyResolvedLang(l);
  }
}

function applyResolvedLang(l){
  lang = AVAILABLE_LANG_CODES.includes(l) ? l : DEFAULT_LANG;
  try { localStorage.setItem(LANG_STORAGE_KEY, lang); } catch (e) {}
  renderLangSelect();
  applyLang();
  syncPreferredLanguageToProfile(lang);

  if (fp) {
    const savedDates = fp.selectedDates;
    fp.destroy();
    initCalendarFilter(savedDates);
    loadPinsByWindow();
  }
}

let lastSyncedPreferredLanguage = null;
async function syncPreferredLanguageToProfile(l) {
  if (!currentSession || !currentProfile) return;
  if (lastSyncedPreferredLanguage === l && currentProfile.preferred_language === l) return;
  lastSyncedPreferredLanguage = l;
  try {
    const { error } = await sb.from(PROFILES_TABLE)
      .update({ preferred_language: l })
      .eq('id', currentSession.user.id);
    if (error) throw error;
    currentProfile.preferred_language = l;
  } catch (err) {
    console.error('Failed to sync preferred language:', err.message);
  }
}

// Persists the "show my username on reports" privacy toggle. The actual
// enforcement (retroactively syncing owner_username across all of this
// user's reports) happens server-side via a trigger on this column — see
// the show_username_on_reports migration — so this just needs to save the
// preference and then refresh whatever's currently on screen to match.
async function setShowUsernameOnReports(checked) {
  if (!currentSession || !currentProfile) return;
  const toggleEl = document.getElementById('showUsernameToggleInput');
  try {
    const { error } = await sb.from(PROFILES_TABLE)
      .update({ show_username_on_reports: checked })
      .eq('id', currentSession.user.id);
    if (error) throw error;
    currentProfile.show_username_on_reports = checked;

    // Reflect it immediately in whatever's already loaded, rather than
    // waiting for a refetch — the DB trigger already did the same update
    // to every one of this user's report rows.
    const ownUsername = checked ? currentProfile.username : null;
    globalActiveData.forEach(r => {
      if (r.owner_id === currentSession.user.id) {
        r.owner_username = ownUsername;
        refreshReportViews(r.id);
      }
    });
    toast(checked ? t('showUsernameOnMsg') : t('showUsernameOffMsg'), 'success');
  } catch (err) {
    console.error('Failed to update username visibility preference:', err.message);
    if (toggleEl) toggleEl.checked = !checked;
    toast(t('settingsSaveFailed'), 'error');
  }
}

// Heuristic country -> language mapping for auto-detect. Only used when the
// target language actually has a file loaded (see countryCodeToLang); a
// detected language we don't have yet just falls back to English rather
// than failing. A few multi-lingual countries (e.g. Switzerland, Belgium)
// are mapped to a single dominant language for simplicity.
const COUNTRY_TO_LANG = {
  rs:'sr-Lat', me:'sr-Lat', ba:'sr-Lat',
  al:'sq', xk:'sq',
  by:'be',
  bg:'bg',
  hr:'hr',
  cz:'cs',
  dk:'da',
  nl:'nl',
  ee:'et',
  fi:'fi',
  fr:'fr', mc:'fr',
  ge:'ka',
  de:'de', at:'de', li:'de', ch:'de',
  gr:'el', cy:'el',
  hu:'hu',
  is:'is',
  ie:'ga',
  it:'it', sm:'it', va:'it',
  lv:'lv',
  lt:'lt',
  lu:'lb',
  mk:'mk',
  mt:'mt',
  no:'no',
  pl:'pl',
  pt:'pt',
  ro:'ro', md:'ro',
  ru:'ru',
  sk:'sk',
  si:'sl',
  es:'es', ad:'es',
  se:'sv',
  tr:'tr',
  ua:'uk',
  gb:'en', ie_en:'en', mt_en:'en',
};

const LANG_AUTO_TIMEZONE_MAP_SR = ['Europe/Belgrade', 'Europe/Podgorica', 'Europe/Sarajevo'];

function countryCodeToLang(countryCode) {
  if (!countryCode) return null;
  const mapped = COUNTRY_TO_LANG[String(countryCode).toLowerCase()];
  if (mapped && AVAILABLE_LANG_CODES.includes(mapped)) return mapped;
  return DEFAULT_LANG;
}

async function detectLanguageWithoutCoords() {
  try {
    const res = await fetch('https://ipapi.co/json/');
    if (res && res.ok) {
      const json = await res.json();
      const fromIp = countryCodeToLang(json && json.country_code);
      if (fromIp) return fromIp;
    }
  } catch (err) {
    console.warn('IP-based language detection failed:', err.message);
  }

  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && LANG_AUTO_TIMEZONE_MAP_SR.includes(tz) && AVAILABLE_LANG_CODES.includes('sr-Lat')) return 'sr-Lat';
  } catch (err) {
 }

  const browserLangs = navigator.languages && navigator.languages.length
    ? navigator.languages : [navigator.language].filter(Boolean);
  for (const bl of browserLangs) {
    const code = String(bl).toLowerCase().split('-')[0];
    if (AVAILABLE_LANG_CODES.includes(code)) return code;
  }
  if (browserLangs.length) return DEFAULT_LANG;

  return null;
}

let langAutoDetectInFlight = false;
async function detectLanguageByLocation(){
  if (langAutoDetectInFlight) return;
  langAutoDetectInFlight = true;
  try {
    let coords = userCoords || manualCoords;
    if (!coords && navigator.geolocation) {
      coords = await new Promise(resolve => {
        navigator.geolocation.getCurrentPosition(
          pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
          () => resolve(null),
          { timeout: 8000, maximumAge: 10 * 60 * 1000 }
        );
      });
    }
    if (!coords) {
      const fallback = await detectLanguageWithoutCoords();
      applyResolvedLang(fallback || lang);
      return;
    }
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${coords.lat}&lon=${coords.lon}&zoom=5&addressdetails=1`;
    const res = await nominatimFetch(url, { headers: { 'Accept': 'application/json' } });
    const json = res && res.ok ? await res.json() : null;
    const countryCode = json && json.address && json.address.country_code
      ? String(json.address.country_code).toLowerCase() : null;
    const detected = countryCode ? countryCodeToLang(countryCode) : (await detectLanguageWithoutCoords()) || lang;
    applyResolvedLang(detected);
  } catch (err) {
    console.error('Language auto-detect failed:', err.message);
    const fallback = await detectLanguageWithoutCoords().catch(() => null);
    applyResolvedLang(fallback || lang);
  } finally {
    langAutoDetectInFlight = false;
  }
}

// Boots the whole i18n system: probe /languages for every file we know how
// to list, then resolve the language actually shown to the user (either
// their saved pick, or a fresh auto-detect based on location).
async function initLang(){
  await discoverLanguages();
  if (langPref === 'auto') {
    await detectLanguageByLocation();
  } else {
    if (!AVAILABLE_LANG_CODES.includes(lang)) lang = DEFAULT_LANG;
    try { localStorage.setItem(LANG_STORAGE_KEY, lang); } catch (e) {}
    renderLangSelect();
    applyLang();
  }
}

function applyLang(){
  // Generic pass: any element in index.html tagged with data-i18n / data-i18n-title /
  // data-i18n-placeholder / data-i18n-aria-label gets its text/attr set from the current
  // language's string table automatically. Adding a new translated element to the HTML
  // needs ONLY that data attribute -- no matching line has to be added here.
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.getAttribute('data-i18n')); });
  document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.getAttribute('data-i18n-title')); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.getAttribute('data-i18n-placeholder')); });
  document.querySelectorAll('[data-i18n-aria-label]').forEach(el => { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label'))); });

  // Everything below still needs code: dynamic lists (render*()), strings built from
  // multiple pieces (icon + text), or elements not always present in the DOM.
  renderQuickGrid('car');
  renderQuickGrid('bike');
  updateOfflineQueueBadge();

  if (document.getElementById('notificationModal').style.display !== 'none') renderNotificationModalBody();
  const lbTitleEl = document.getElementById('leaderboardModalTitle');
  if (lbTitleEl) lbTitleEl.innerHTML = '<img class="icon-img icon-img-inline" src="icons/trophy.png" alt=""> ' + t('leaderboardTitle');
  if (document.getElementById('leaderboardModal').style.display !== 'none') {
    renderDashboardTab();
  }
  renderLegalCopyrightLine();
  if (document.getElementById('legalContentModal').style.display !== 'none' && legalContentModalOpenKey) {
    renderLegalContentModalBody(legalContentModalOpenKey);
  }
  populateMapStyleSelects();
  renderIconPackSegment();
  renderStatusFilterSettings();
  renderLangSelect();
  document.getElementById('settingsHelpBtn').lastChild.textContent = ' ' + t('settingsHelpBtn');
  renderNotifTypeToggles();
  updateSavedAreaStatusText();
  updateOfflineMapStorageText();
  populateQuickDefaultSelect('car');
  populateQuickDefaultSelect('bike');
  updateCommentPlaceholder();
  document.getElementById('category').options[0].text     = t('catPH');

  const catEl = document.getElementById('category');
  Array.from(catEl.options).slice(1).forEach(opt => { opt.textContent = translateCategory(opt.value); });

  const subEl = document.getElementById('subcategory');
  if (subEl && catEl.value) {
    populateSubcategoryOptions(subEl, catEl.value, subEl.value);
  }

  const prioEl = document.getElementById('priority');
  if (prioEl) {
    const prevPrio = prioEl.value;
    prioEl.innerHTML =
      `<option value="" disabled${prevPrio ? '' : ' selected'}>${t('prioPH')}</option>` +
      `<option value="low">${t('priorityLow')}</option>` +
      `<option value="normal">${t('priorityNormal')}</option>` +
      `<option value="high">${t('priorityHigh')}</option>`;
    prioEl.value = prevPrio;
  }

  document.querySelectorAll('.leg').forEach(el=>{
    const label = el.dataset[lang] || el.dataset.en;
    el.textContent = label;
    const item = el.closest('.legend-item');
    if (item) item.title = label;
  });

  const gm = document.getElementById('gpsModal');
  if (gm && gm.style.display !== 'none') updateGpsModalText();

  const dashIdAdminPillEl = document.getElementById('dashboardIdentityAdminPill');
  if (dashIdAdminPillEl) dashIdAdminPillEl.textContent = '\u2605 ' + t('adminBadge');



  buildHelpModalContent();
  refreshRenderedPopups();

  if (document.getElementById('analyticsModal').style.display !== 'none') {
    renderAnalyticsRangeChips();
    loadAndRenderAnalytics();
  }

  if (currentProfile && currentProfile.is_admin && document.getElementById('adminPanelModal').style.display !== 'none') {
    renderAdminActivityFeed();
    populateUcMunicipalitySelect();
    populateUcCatChecks();
    applyUcFormTranslations();
    renderUcList();
    renderWaitingList();
  }

  updateDrivingGpsStatus();
  updateSectionButtonUI();
  updateTravelModeSwitchBtn();

  // The bottom municipality bar (name + reported/in-progress/fixed counts)
  // is normally only re-rendered when the map moves into a new municipality
  // (see renderMunicipalityBoundary), so switching the app's language while
  // it's already showing left it stuck in the old language until the next
  // map pan. Re-render it here too so it picks up the new language right
  // away, same as everything else on the page.
  if (currentContactsMunicipality) {
    updateBottomMunicipalityBar(currentContactsMunicipality);
    showMunicipalityLabel(currentContactsMunicipality);
  }

  updateNavStatusText();

  const historyBtnEl = document.getElementById('dashboardQuestHistoryToggle');
  if (historyBtnEl) {
    const historyPanelEl = document.getElementById('dashboardQuestHistory');
    const isOpen = historyPanelEl && historyPanelEl.style.display !== 'none';
    historyBtnEl.textContent = isOpen ? t('dashboardQuestHistoryHide') : t('dashboardQuestHistoryShow');
    if (isOpen) { questHistoryLoaded = false; loadDashboardQuestHistory(); }
  }
  if (document.getElementById('dashboardQuestsList') && currentSession && currentProfile && !currentProfile.is_admin) {
    loadDashboardStreakAndQuests();
  }
  renderMyReportsList();
  populateCategoryFilterList();
  if (document.getElementById('leaderboardModal').style.display !== 'none') {
    renderDashboardTab();
  }
  updateProximityUi();
  loadLegalContent();
}

function showHelpModal() {
  buildHelpModalContent();
  const modal = document.getElementById('helpModal');
  bringModalToFront(modal);
  modal.style.display = 'flex';
  openOverlay('helpModal', hideHelpModal);
}
function hideHelpModal() {
  document.getElementById('helpModal').style.display = 'none';
  closeOverlay('helpModal');
}
function showSettingsModal() {
  document.getElementById('settingsModalTitle').textContent = t('settingsModalTitle');
  const modal = document.getElementById('settingsModal');
  bringModalToFront(modal);
  modal.style.display = 'flex';
  updateSettingsAccountGate();
  const showUsernameToggleEl = document.getElementById('showUsernameToggleInput');
  if (showUsernameToggleEl) showUsernameToggleEl.checked = !currentProfile || currentProfile.show_username_on_reports !== false;
  const pulseToggleEl = document.getElementById('pulseToggleInput');
  if (pulseToggleEl) pulseToggleEl.checked = statusPulseEnabled;
  renderStatusFilterSettings();
  initSoundSettingsUi();
  initVoiceNavSettingsUi();
  initDrivingSafetySettingsUi();
  initOverspeedAlertSettingsUi();
  initBumpDetectionSettingsUi();
  initQuickDefaultCategorySettingsUi();
  initMapButtonToggleUi();
  updateNearbyCheckinSegmentUI();
  updateContactReminderSegmentUI();
  initOfflineMapSettingsUi();
  syncPushToggleUi();
  renderNotifTypeToggles();
  updateSavedAreaStatusText();
  openOverlay('settingsModal', hideSettingsModal);
}
function hideSettingsModal() {
  document.getElementById('settingsModal').style.display = 'none';
  closeOverlay('settingsModal');
}
function showAdminPanelModal() {
  if (!currentProfile || !currentProfile.is_admin) return;
  document.getElementById('adminPanelModalTitle').textContent = t('adminPanelModalTitle');
  const modal = document.getElementById('adminPanelModal');
  bringModalToFront(modal);
  modal.style.display = 'flex';
  cancelUcForm();
  loadUtilityCompaniesAdmin();
  loadAdminActivityFeed(true);
  resetAdminSearch();
  const accountRequestsSection = document.getElementById('accountRequestsSection');
  if (accountRequestsSection) {
    const canManage = canManageAccountRequests();
    accountRequestsSection.style.display = canManage ? '' : 'none';
    if (canManage) loadAccountRequests();
  }
  openOverlay('adminPanelModal', hideAdminPanelModal);
}
function hideAdminPanelModal() {
  document.getElementById('adminPanelModal').style.display = 'none';
  closeOverlay('adminPanelModal');
}

const ANALYTICS_RANGE_OPTIONS = [7, 30, 90];
let analyticsRangeDays = 30;
let analyticsLoadToken = 0;

function openAnalyticsModal() {
  if (!currentProfile || !currentProfile.is_admin) return;
  document.getElementById('analyticsModalTitle').textContent = t('analyticsModalTitle');
  document.getElementById('analyticsTrendTitle').textContent = t('analyticsTrendTitle');
  document.getElementById('analyticsCategoryTitle').textContent = t('analyticsCategoryTitle');
  document.getElementById('analyticsAreaTitle').textContent = t('analyticsAreaTitle');
  const modal = document.getElementById('analyticsModal');
  bringModalToFront(modal);
  modal.style.display = 'flex';
  renderAnalyticsRangeChips();
  loadAndRenderAnalytics();
  openOverlay('analyticsModal', closeAnalyticsModal);
}
function closeAnalyticsModal() {
  document.getElementById('analyticsModal').style.display = 'none';
  closeOverlay('analyticsModal');
}

function renderAnalyticsRangeChips() {
  const row = document.getElementById('analyticsRangeRow');
  if (!row) return;
  row.innerHTML = ANALYTICS_RANGE_OPTIONS.map(d => `
    <span class="analytics-range-chip${d === analyticsRangeDays ? ' active' : ''}" onclick="setAnalyticsRange(${d})">${d}${t('analyticsRangeDaysSuffix') || 'd'}</span>
  `).join('');
}

function setAnalyticsRange(days) {
  if (analyticsRangeDays === days) return;
  analyticsRangeDays = days;
  renderAnalyticsRangeChips();
  loadAndRenderAnalytics();
}

async function loadAndRenderAnalytics() {
  const myToken = ++analyticsLoadToken;
  const summaryGrid = document.getElementById('analyticsSummaryGrid');
  const emptyEl = document.getElementById('analyticsEmpty');
  if (summaryGrid) summaryGrid.innerHTML = `<div class="dashboard-stat-box"><div class="dashboard-stat-body"><div class="dashboard-stat-value">…</div></div></div>`;
  if (emptyEl) emptyEl.style.display = 'none';

  const since = new Date(Date.now() - analyticsRangeDays * 24 * 60 * 60 * 1000);
  let rows = [];
  try {
    const { data, error } = await sb.from(TABLE)
      .select('id, category, status, priority, created_at, municipality_id, latitude, longitude')
      .gte('created_at', since.toISOString())
      .order('created_at', { ascending: true })
      .limit(20000);
    if (error) throw error;
    rows = data || [];
  } catch (err) {
    console.error('Failed to load analytics data:', err.message || err);
    if (myToken === analyticsLoadToken && summaryGrid) {
      summaryGrid.innerHTML = '';
      if (emptyEl) { emptyEl.style.display = 'block'; emptyEl.textContent = t('loadFailed'); }
    }
    return;
  }
  if (myToken !== analyticsLoadToken) return;

  const scoped = rows.filter(isReportInAdminDomain);
  renderAnalytics(scoped);
}

function renderAnalytics(rows) {
  const summaryGrid = document.getElementById('analyticsSummaryGrid');
  const emptyEl = document.getElementById('analyticsEmpty');

  if (!rows.length) {
    if (summaryGrid) summaryGrid.innerHTML = '';
    document.getElementById('analyticsTrendChart').innerHTML = '';
    document.getElementById('analyticsCategoryList').innerHTML = '';
    document.getElementById('analyticsAreaList').innerHTML = '';
    if (emptyEl) { emptyEl.style.display = 'block'; emptyEl.textContent = t('analyticsEmptyState') || 'No reports in this range.'; }
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  const total = rows.length;
  const fixedCount = rows.filter(r => r.status === 'fixed').length;
  const activeCount = total - fixedCount;
  const resolveRate = total ? Math.round((fixedCount / total) * 100) : 0;

  if (summaryGrid) {
    summaryGrid.innerHTML = `
      <div class="dashboard-stat-box">
        <div class="dashboard-stat-body">
          <div class="dashboard-stat-value">${total}</div>
          <div class="dashboard-stat-label">${t('analyticsStatTotal') || 'Total reports'}</div>
        </div>
      </div>
      <div class="dashboard-stat-box">
        <div class="dashboard-stat-body">
          <div class="dashboard-stat-value">${activeCount}</div>
          <div class="dashboard-stat-label">${t('analyticsStatActive') || 'Still open'}</div>
        </div>
      </div>
      <div class="dashboard-stat-box">
        <div class="dashboard-stat-body">
          <div class="dashboard-stat-value">${resolveRate}%</div>
          <div class="dashboard-stat-label">${t('analyticsStatResolveRate') || 'Resolved'}</div>
        </div>
      </div>`;
  }

  renderAnalyticsTrend(rows);
  renderAnalyticsBarList('analyticsCategoryList', analyticsGroupByCategory(rows), r => translateCategory(r.key), r => categoryColor(r.key));
  renderAnalyticsBarList('analyticsAreaList', analyticsGroupByArea(rows), r => r.key, () => 'var(--accent)');
}

function analyticsTrendBucketCount(days) {

  return days <= 30 ? days : Math.ceil(days / 7);
}

function renderAnalyticsTrend(rows) {
  const el = document.getElementById('analyticsTrendChart');
  if (!el) return;
  const days = analyticsRangeDays;
  const useWeekly = days > 30;
  const bucketMs = (useWeekly ? 7 : 1) * 24 * 60 * 60 * 1000;
  const bucketCount = analyticsTrendBucketCount(days);
  const now = Date.now();
  const counts = new Array(bucketCount).fill(0);
  rows.forEach(r => {
    if (!r.created_at) return;
    const age = now - new Date(r.created_at).getTime();
    const idx = bucketCount - 1 - Math.floor(age / bucketMs);
    if (idx >= 0 && idx < bucketCount) counts[idx]++;
  });
  const max = Math.max(1, ...counts);
  el.innerHTML = counts.map((c, i) => {
    const pct = Math.max(4, Math.round((c / max) * 100));
    const label = useWeekly ? `${t('analyticsWeekAbbrev') || 'W'}${bucketCount - i}` : '';
    return `
    <div class="weekly-chart-col">
      <div class="weekly-chart-bar-wrap">
        <div class="weekly-chart-value">${c}</div>
        <div class="weekly-chart-bar" style="height:${pct}%"></div>
      </div>
      <div class="weekly-chart-day">${label}</div>
    </div>`;
  }).join('');
}

function analyticsGroupByCategory(rows) {
  const counts = {};
  rows.forEach(r => { counts[r.category || 'Other'] = (counts[r.category || 'Other'] || 0) + 1; });
  return Object.keys(counts).map(key => ({ key, count: counts[key] })).sort((a, b) => b.count - a.count);
}

function analyticsGroupByArea(rows) {
  const counts = {};
  rows.forEach(r => {
    const muni = r.municipality_id != null ? getMunicipalityById(r.municipality_id) : null;
    const name = muni ? (isSerbianLang() ? muni.name : (muni.name_en || muni.name)) : (t('analyticsUnknownArea') || 'Unknown area');
    counts[name] = (counts[name] || 0) + 1;
  });
  return Object.keys(counts).map(key => ({ key, count: counts[key] }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

function renderAnalyticsBarList(elId, items, labelFn, colorFn) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!items.length) { el.innerHTML = ''; return; }
  const max = Math.max(1, ...items.map(i => i.count));
  el.innerHTML = items.map(item => {
    const pct = Math.max(3, Math.round((item.count / max) * 100));
    return `
    <div class="analytics-bar-row">
      <span class="analytics-bar-label">${escapeHtml(labelFn(item))}</span>
      <span class="analytics-bar-track"><span class="analytics-bar-fill" style="width:${pct}%;background:${colorFn(item)};"></span></span>
      <span class="analytics-bar-count">${item.count}</span>
    </div>`;
  }).join('');
}

function buildHelpModalContent() {
  document.getElementById('helpModalTitle').textContent = t('helpTitle');
  document.getElementById('helpModalBtn').textContent = t('helpClose');
  const contentEl = document.getElementById('helpModalContent');

  const acc = (iconSrc, titleKey, bodyKey, openByDefault) => `
    <details${openByDefault ? ' open' : ''} style="border:1px solid var(--border-color); border-radius:var(--radius-xl); background:var(--bg-surface-alt); overflow:hidden;">
      <summary style="list-style:none; cursor:pointer; padding:10px 12px; font-size:13px; font-weight:var(--fw-semibold); display:flex; align-items:center; gap:8px; -webkit-tap-highlight-color:transparent;">
        ${iconSrc ? `<img class="icon-img icon-img-inline" src="${iconSrc}" alt="">` : ''}
        <span style="flex:1;">${t(titleKey)}</span>
        <span class="help-accordion-caret" style="font-size:10px; color:var(--text-muted); transition:transform .15s ease;">&#9662;</span>
      </summary>
      <div style="padding:0 12px 12px 12px; font-size:12.5px; line-height:1.6; color:var(--text-secondary);">
        ${t(bodyKey)}
      </div>
    </details>`;

  contentEl.innerHTML = `
    <style>
      #helpModalContent details > summary::-webkit-details-marker{ display:none; }
      #helpModalContent details[open] .help-accordion-caret{ transform:rotate(180deg); }
    </style>
    <div style="text-align: left; font-size: 13px; line-height: 1.6; display: flex; flex-direction: column; gap: 12px; margin-top: 10px;">
      <p><strong>${t('helpStep1')}</strong> ${t('helpStep1Body')}</p>
      <p><strong>${t('helpStep2')}</strong> ${t('helpStep2Body')}</p>
      <p><strong>${t('helpStep3')}</strong> ${t('helpStep3Body')}</p>
      <p><strong>${t('helpStep4')}</strong> ${t('helpStep4Body')}</p>
      <p><strong>${t('helpStep5')}</strong> ${t('helpStep5Body')}</p>
      <p><strong><img class="icon-img icon-img-inline" src="icons/target.png" alt="compass"></strong> ${t('helpFollowModeText')}</p>
      <p><strong>${t('helpOnSiteReportingTitle')}</strong> ${t('helpOnSiteReportingBody')}</p>

      <div style="font-size:10px; font-weight:var(--fw-bold); letter-spacing:.4px; text-transform:uppercase; color:var(--text-muted); margin-top:4px;">
        ${t('helpDetailedGuideLabel')}
      </div>

      <div style="display:flex; flex-direction:column; gap:8px;">
        ${(() => {
          const navBtn = document.getElementById('navigateModeBtn');
          const navModeVisible = !!navBtn && navBtn.style.display !== 'none';
          return acc('icons/search.png', 'helpAccNavTitle', 'helpAccNavBody', navModeVisible);
        })()}
        ${acc('icons/close.png', 'helpAccEditDeleteTitle', 'helpAccEditDeleteBody')}
        ${acc('icons/user.png', 'helpAccLevelsTitle', 'helpAccLevelsBody')}
        ${acc('icons/suggest.png', 'helpAccVotingTitle', 'helpAccVotingBody')}
        ${acc('icons/phone.png', 'helpAccContactsTitle', 'helpAccContactsBody')}
        ${acc('icons/camera.png', 'helpAccPhotosTitle', 'helpAccPhotosBody')}
        ${acc('icons/notification.png', 'helpAccNotifTitle', 'helpAccNotifBody')}
        ${acc('icons/settings.png', 'helpAccSettingsTitle', 'helpAccSettingsBody')}
      </div>
    </div>
  `;
}

function initCalendarFilter(optionalDefaultDates) {
  let initialDates = optionalDefaultDates;
  if (!initialDates || initialDates.length === 0) {
    const defaultStart = new Date();
    defaultStart.setDate(defaultStart.getDate() - 14);
    const defaultEnd = new Date();
    initialDates = [defaultStart, defaultEnd];
  }
  fp = flatpickr("#dateRangePicker", {
    mode: "range",
    theme: "dark",
    dateFormat: "d.m.Y",
    locale: isSerbianLang() ? flatpickr.l10ns.sr : 'default',
    defaultDate: initialDates,
    onClose: async function(selectedDates) {
      if (selectedDates.length === 2) await loadPinsByWindow();
    }
  });
}

const MAP_VIEW_STORAGE_KEY = 'tracethebreak_last_map_view';
const EUROPE_DEFAULT_CENTER = [50, 15];
const EUROPE_DEFAULT_ZOOM = 4;

function loadSavedMapView() {
  try {
    const raw = localStorage.getItem(MAP_VIEW_STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (isValidLatLng(v.lat, v.lng) && typeof v.zoom === 'number') return v;
  } catch (err) {
    console.warn('Could not read saved map view:', err);
  }
  return null;
}

function saveMapView() {
  try {
    const c = map.getCenter();
    localStorage.setItem(MAP_VIEW_STORAGE_KEY, JSON.stringify({ lat: c.lat, lng: c.lng, zoom: map.getZoom() }));
  } catch (err) {
    console.warn('Could not save map view:', err);
  }
}

const savedMapView = loadSavedMapView();
const WORLD_BOUNDS = L.latLngBounds([-90, -180], [90, 180]);
const map = L.map('map', {
  zoomControl: false,
  markerZoomAnimation: true,
  worldCopyJump: false,
  maxBounds: WORLD_BOUNDS,
  maxBoundsViscosity: 1.0,
  minZoom: 2,
  zoomSnap: 0.25,
  zoomDelta: 0.25
  // touchZoom left at its default (enabled): pinch-to-zoom is handled by
  // Leaflet's own native touchZoom now — see initTwoFingerRotate below for
  // the two-finger rotate gesture layered on top of it.

}).setView(
  savedMapView ? [savedMapView.lat, savedMapView.lng] : EUROPE_DEFAULT_CENTER,
  savedMapView ? savedMapView.zoom : EUROPE_DEFAULT_ZOOM
);
(function initHeaderHeightTracking() {
  const header = document.querySelector('header');
  if (!header) return;
  updateHeaderHeightVar();
  if (window.ResizeObserver) {
    new ResizeObserver(updateHeaderHeightVar).observe(header);
  } else {
    window.addEventListener('resize', updateHeaderHeightVar);
    window.addEventListener('orientationchange', updateHeaderHeightVar);
  }
})();

// --- Pull-to-refresh on the header ---
// Dragging down from the header doesn't move the header itself; it just
// grows/fades in #ptrIndicator beneath it. Release past PTR_THRESHOLD and
// the page reloads. Small vertical wiggles (PTR_DEADZONE) are ignored so a
// normal tap on a header button still works; once a real drag is detected
// we preventDefault so the ghost click that would otherwise fire on
// touchend doesn't also trigger whatever button the drag started on.
(function initPullToRefresh(){
  const header = document.querySelector('header');
  const indicator = document.getElementById('ptrIndicator');
  if (!header || !indicator) return;

  const PTR_THRESHOLD = 70;   // px of pull needed to arm the refresh
  const PTR_MAX       = 110;  // px pull distance at which visual growth caps out
  const PTR_DEADZONE  = 8;    // px before a touch is treated as a drag, not a tap

  let startY = null, startX = null, dragging = false, triggered = false;

  function resetIndicator(){
    indicator.classList.remove('ptr-dragging', 'ptr-ready');
    indicator.style.opacity = '';
    indicator.style.transform = '';
  }

  header.addEventListener('touchstart', (e) => {
    if (triggered) return;
    if (e.touches.length !== 1) { startY = null; return; }
    startY = e.touches[0].clientY;
    startX = e.touches[0].clientX;
    dragging = false;
  }, { passive:true });

  header.addEventListener('touchmove', (e) => {
    if (startY === null || triggered || e.touches.length !== 1) return;
    const dy = e.touches[0].clientY - startY;
    const dx = e.touches[0].clientX - startX;

    if (!dragging) {
      if (dy < PTR_DEADZONE || Math.abs(dx) > dy) return; // not a downward drag yet
      dragging = true;
      indicator.classList.add('ptr-dragging');
    }

    if (dy <= 0) { resetIndicator(); return; }

    e.preventDefault();
    const pull = Math.min(dy, PTR_MAX);
    const progress = Math.min(pull / PTR_THRESHOLD, 1);
    indicator.style.opacity = progress;
    indicator.style.transform = `translate(-50%,-50%) translateY(${pull * 0.55}px) scale(${.5 + progress * .5})`;
    indicator.classList.toggle('ptr-ready', progress >= 1);
  }, { passive:false });

  function onTouchEnd(e){
    if (startY === null) return;
    const wasDragging = dragging;
    const ready = indicator.classList.contains('ptr-ready');
    startY = null;
    dragging = false;
    if (!wasDragging) return; // untouched tap — let the normal click go through
    e.preventDefault();
    if (ready) {
      triggered = true;
      indicator.classList.remove('ptr-dragging');
      indicator.classList.add('ptr-loading');
      indicator.style.opacity = 1;
      indicator.style.transform = 'translate(-50%,-50%) scale(1)';
      setTimeout(() => window.location.reload(), 180);
    } else {
      resetIndicator();
    }
  }
  header.addEventListener('touchend', onTouchEnd, { passive:false });
  header.addEventListener('touchcancel', () => { startY = null; dragging = false; resetIndicator(); }, { passive:true });
})();

map.on('moveend', saveMapView);

requestAnimationFrame(() => map.invalidateSize());
window.addEventListener('load', () => map.invalidateSize());

const mapContainerEl = map.getContainer();
// Leaflet can't run its own smooth zoom animation while the map is rotated
// (its zoom-anim math assumes bearing 0), so updateZoomAnimationForRotation()
// forces map._zoomAnimated = false whenever rotated. Without any animation,
// every zoom (double-tap, scroll wheel, a committed pinch step, or any
// programmatic setView/flyTo) falls back to Leaflet's instant _resetView:
// the whole map snaps to the new position/scale in one frame. That instant
// cut is what read as "choppy"/"going away and back" — the previous frame's
// content disappears and the new one pops in with no motion between them.
// zoomRotatedFromZoom below bridges that with our own CSS transform
// animation on rotWrapper, the same wrapper element the rotation itself is
// applied to.
let zoomRotatedFromZoom = null;
// A single "zoom" gesture — a scroll-wheel session, a pinch, a double-tap —
// can land as a rapid burst of separate, instant zoomstart/zoomend pairs
// (one per committed step) rather than one smooth animated zoom, especially
// while rotated (Leaflet can't animate zoom at all while rotated, see below).
// Removing
// map-zooming on every individual zoomend used to flip pins/reports back on
// (and re-run marker/viewport sync) between each of those steps, then hide
// them again a moment later for the next one — that on/off/on/off is the
// "flashes a lot" / "constantly reloads mid-zoom" glitch. Debouncing the
// class removal instead coalesces a whole burst into a single hide, with
// pins/reports staying hidden — showing only the map — for the entire
// gesture, then one reveal (with fresh data already loaded underneath,
// since the marker/viewport refresh below runs while still hidden) once
// zooming genuinely stops.
let zoomEndTimer = null;
const ZOOM_END_DELAY_MS = 250;
// Broader guard than the old isRotatedZoomBursting(): true for ANY in-progress
// zoom gesture (rotated or not). The marker-sync / viewport-reload / company-
// marker schedulers below skip work while this is true.
function isMapZooming() {
  return mapContainerEl.classList.contains('map-zooming');
}
// --- Why rotated zoom used to flicker/reload differently from north-up ---
// North-up zooming (scroll wheel, pinch, double-tap) goes through Leaflet's
// own native handlers, which run ONE continuous, CSS-animated zoom transition
// per gesture — Leaflet fires a single zoomstart at the start and holds off
// zoomend until that ~250ms animation actually finishes. Our old code only
// cleared map-zooming on a debounced timer AFTER zoomend, so north-up got two
// stacked buffers (Leaflet's own animation + our debounce) and pins/reports
// stayed hidden smoothly for the whole gesture.
//
// Rotated zooming can't use that path at all — Leaflet has no idea the map is
// visually rotated via CSS, so rotation-corrected zoom is done by hand
// (onRotatedWheelZoom): each committed step calls setZoomAround with animation disabled, which fires zoomstart+zoomend back
// to back, INSTANTLY, with no built-in animation buffer at all. For a
// physical mouse wheel or a slower pinch, the real gap between one committed
// step and the next can easily exceed our 250ms debounce, so our own timer
// fired in between commits — flipping pins back on and re-running marker/
// viewport sync mid-gesture, then hiding everything again a moment later for
// the next step. That on/off/on/off, only while rotated, is exactly what
// looked like "constantly reloading" and flickering.
//
// Fix: stop treating each discrete Leaflet zoomstart/zoomend pair as the
// thing that defines "still zooming". Instead, noteZoomActivity() is called
// on every sign of the user actively working the zoom — not just each
// committed Leaflet step — including every raw wheel tick and every animation
// frame of a manual pinch, whether or not that particular tick/frame actually
// crossed a full committed zoom step. That keeps the hidden window continuous
// for the whole real-world gesture, independent of how choppy Leaflet's own
// commit cadence happens to be underneath it.
function noteZoomActivity(rotated) {
  mapContainerEl.classList.add('map-zooming');
  if (rotated) mapContainerEl.classList.add('map-zooming-rotated');
  if (zoomEndTimer) clearTimeout(zoomEndTimer);
  zoomEndTimer = setTimeout(endZoomBurst, ZOOM_END_DELAY_MS);
}
function endZoomBurst() {
  zoomEndTimer = null;
  mapContainerEl.classList.remove('map-zooming');
  mapContainerEl.classList.remove('map-zooming-rotated');
  // The burst is genuinely over now — run the marker/viewport refreshes that
  // were being held off during it (see scheduleMarkerSyncOnSettle,
  // scheduleViewportReloadIfNeeded, scheduleCompanyMarkersReload below), so
  // the map still ends up up to date, just without the mid-burst churn.
  if (typeof scheduleMarkerSyncOnSettle === 'function') scheduleMarkerSyncOnSettle();
  if (typeof scheduleViewportReloadIfNeeded === 'function') scheduleViewportReloadIfNeeded();
  if (typeof scheduleCompanyMarkersReload === 'function') scheduleCompanyMarkersReload();
}
map.on('zoomstart', () => {
  noteZoomActivity(rotationActive());
  if (rotationActive()) {
    // zoomstart fires before Leaflet applies the new zoom, so this is still
    // the pre-zoom value.
    zoomRotatedFromZoom = map.getZoom();
  } else {
    zoomRotatedFromZoom = null;
  }
});
map.on('zoom', () => {
  noteZoomActivity(rotationActive());
  if (zoomRotatedFromZoom == null || !rotWrapper) return;
  const startZoom = zoomRotatedFromZoom;
  const newZoom = map.getZoom();
  zoomRotatedFromZoom = null;
  if (startZoom === newZoom) return;
  // By the 'zoom' event, Leaflet has already committed the new zoom and
  // repositioned everything — but synchronously, in the same tick, before
  // the browser paints. So we can instantly (no transition) scale rotWrapper
  // up/down so the very first paint still *looks* like the old zoom level,
  // then on the next frame transition that scale back to 1 — a manual
  // stand-in for the zoom animation Leaflet can't do itself while rotated.
  const scaleRatio = Math.pow(2, startZoom - newZoom);
  rotWrapper.style.transition = 'none';
  rotWrapper.style.transform = `rotate(${mapBearing}deg) scale(${scaleRatio})`;
  void rotWrapper.offsetHeight; // force the "old look" frame to commit
  requestAnimationFrame(() => {
    rotWrapper.style.transition = 'transform .25s ease';
    rotWrapper.style.transform = `rotate(${mapBearing}deg) scale(1)`;
  });
});
map.on('zoomend', () => {
  // Just extends the window; the actual class removal + resync only happens
  // once this fires uninterrupted, in endZoomBurst().
  noteZoomActivity(rotationActive());
});


const TILE_CACHE_NAME = 'ttb-osm-tiles-v1';

const tileCacheReady = ('caches' in window) ? caches.open(TILE_CACHE_NAME) : Promise.resolve(null);

// A big pinch-zoom can suddenly need dozens of new tiles at once, which is
// exactly the kind of burst that trips tile-server rate limiting or just
// hits an ordinary transient network hiccup. A couple of retries with a
// short backoff clears up the vast majority of those on their own.
const TILE_FETCH_MAX_ATTEMPTS = 3;
const TILE_FETCH_RETRY_DELAY_MS = 300;

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchTileCached(url, attempt = 0) {
  const cache = await tileCacheReady;
  if (cache) {
    const cached = await cache.match(url);
    if (cached) return cached;
  }
  let response;
  try {
    response = await fetch(url);
  } catch (networkErr) {
    if (attempt < TILE_FETCH_MAX_ATTEMPTS - 1) {
      await delay(TILE_FETCH_RETRY_DELAY_MS * (attempt + 1));
      return fetchTileCached(url, attempt + 1);
    }
    throw networkErr;
  }
  if (response.ok) {
    if (cache) cache.put(url, response.clone()).catch(() => {});
    return response;
  }
  // A non-ok response (e.g. 429 from a rate-limited tile server) is often
  // just as transient as a network error — worth the same retry treatment
  // before giving up on it.
  if (attempt < TILE_FETCH_MAX_ATTEMPTS - 1) {
    await delay(TILE_FETCH_RETRY_DELAY_MS * (attempt + 1));
    return fetchTileCached(url, attempt + 1);
  }
  return response;
}

// 1x1 transparent GIF. Used as the final fallback when a tile genuinely
// can't be loaded after retries — rather than leaving the <img> pointed at
// a failed URL, which renders as the browser's broken-image icon sitting
// on the map. An empty tile is a much less jarring failure mode: it just
// reads as a gap in the map, not an error.
const BLANK_TILE_SRC = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

// --- Per-tile overzoom for Esri's "no imagery" placeholder -------------
// Esri's World_Imagery service doesn't 404 when it has no aerial coverage
// for a tile — it returns a flat gray placeholder image instead, which
// happens a lot above z14-ish in rural/sparse areas. Previously the only
// fallback for "no real imagery here" was Leaflet's *global* overzoom past
// maxNativeZoom (stretching the last native tile once you zoom in further
// than the provider supports at all). This handles the other case: a
// single tile, still within native zoom, that individually has no data.
// Detect that specific tile, climb to the nearest ancestor zoom that DOES
// have real imagery for that spot, and stretch the matching crop in —
// real per-tile overzoom, not a map-wide style change.
//
// Detection is pixel-based rather than a byte hash: real aerial photos
// always have sensor/compression grain, so a tile that decodes as
// essentially flat, mid-gray is almost certainly the placeholder rather
// than genuine imagery (even a calm lake or fresh snow isn't this uniform).
const NODATA_GRAY_MIN = 140;
const NODATA_GRAY_MAX = 235;
const NODATA_CHROMA_TOL = 4;        // max |r-g|, |g-b| to still count as "gray"
const NODATA_GRAY_FRACTION = 0.85;  // fraction of sampled pixels that must be gray + mid-value
const NODATA_STDDEV_MAX = 10;       // allowed spread among those gray samples

// First placeholder hit we confirm via full pixel decode gets its blob
// byte-size remembered here, so later placeholder tiles (very common
// together — a whole no-coverage region is many sibling tiles) can be
// recognized from response size alone, skipping the decode+sample cost.
const knownPlaceholderByteSizes = new Set();

function looksLikeEsriNoDataTile(bitmap) {
  const size = 16; // downsample to a 16x16 grid — cheap, evenly-spaced sample
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);
  let grayCount = 0;
  const grayValues = [];
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const isGray = Math.abs(r - g) <= NODATA_CHROMA_TOL && Math.abs(g - b) <= NODATA_CHROMA_TOL;
    const midValue = r >= NODATA_GRAY_MIN && r <= NODATA_GRAY_MAX;
    if (isGray && midValue) { grayCount++; grayValues.push(r); }
  }
  const total = data.length / 4;
  if (grayCount / total < NODATA_GRAY_FRACTION) return false;
  const mean = grayValues.reduce((a, v) => a + v, 0) / grayValues.length;
  const variance = grayValues.reduce((a, v) => a + (v - mean) * (v - mean), 0) / grayValues.length;
  return Math.sqrt(variance) <= NODATA_STDDEV_MAX;
}

async function isPlaceholderBlob(blob) {
  if (knownPlaceholderByteSizes.has(blob.size)) return true; // fast path
  let bitmap;
  try { bitmap = await createImageBitmap(blob); } catch (e) { return false; }
  const isPlaceholder = looksLikeEsriNoDataTile(bitmap);
  if (isPlaceholder) knownPlaceholderByteSizes.add(blob.size);
  bitmap.close && bitmap.close();
  return isPlaceholder;
}

// Decoded ancestor tiles get cached by URL (in addition to fetchTileCached's
// own Cache Storage layer) so a whole sparse-coverage region — often dozens
// of sibling tiles missing the same ancestor — doesn't redecode that same
// parent image over and over.
const ancestorBitmapCache = new Map(); // url -> Promise<ImageBitmap|null>
const ANCESTOR_BITMAP_CACHE_MAX = 200;

function fetchTileBitmap(url) {
  if (ancestorBitmapCache.has(url)) return ancestorBitmapCache.get(url);
  const p = (async () => {
    try {
      const res = await fetchTileCached(url);
      if (!res.ok) return null;
      const blob = await res.blob();
      if (await isPlaceholderBlob(blob)) return null; // ancestor is itself a placeholder
      return await createImageBitmap(blob);
    } catch (e) {
      return null;
    }
  })();
  if (ancestorBitmapCache.size >= ANCESTOR_BITMAP_CACHE_MAX) {
    const oldestKey = ancestorBitmapCache.keys().next().value;
    ancestorBitmapCache.delete(oldestKey);
  }
  ancestorBitmapCache.set(url, p);
  return p;
}

// Builds a raw tile URL for an arbitrary z/x/y against a layer's own URL
// template, bypassing Leaflet's normal getTileUrl() zoom clamping so we can
// explicitly ask for an off-schedule, lower (ancestor) zoom level.
function rawTileUrl(layer, z, x, y) {
  const data = L.extend({}, layer.options, { x, y, z });
  if (typeof layer._getSubdomain === 'function') data.s = layer._getSubdomain({ x, y, z });
  return L.Util.template(layer._url, data);
}

const OVERZOOM_MAX_CLIMB = 10; // ancestor levels to try before giving up
const OVERZOOM_TILE_SIZE = 256;

// Climbs z-1, z-2, ... looking for an ancestor tile with real coverage,
// then returns a canvas holding the matching crop of that ancestor,
// stretched to full tile size. Returns null if no ancestor up to the
// climb limit has real imagery either (in which case the caller falls
// back to showing Esri's own placeholder tile, never a blank gap).
async function buildOverzoomFallbackTile(layer, coords) {
  const { x, y, z } = coords;
  for (let climbed = 1; climbed <= OVERZOOM_MAX_CLIMB && z - climbed >= 0; climbed++) {
    const pz = z - climbed;
    const factor = Math.pow(2, climbed);
    const px = Math.floor(x / factor);
    const py = Math.floor(y / factor);
    const bitmap = await fetchTileBitmap(rawTileUrl(layer, pz, px, py));
    if (!bitmap) continue; // fetch failed, or that ancestor is also a placeholder — climb further
    const cropSize = OVERZOOM_TILE_SIZE / factor;
    const sx = (x - px * factor) * cropSize;
    const sy = (y - py * factor) * cropSize;
    const canvas = document.createElement('canvas');
    canvas.width = OVERZOOM_TILE_SIZE;
    canvas.height = OVERZOOM_TILE_SIZE;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(bitmap, sx, sy, cropSize, cropSize, 0, 0, OVERZOOM_TILE_SIZE, OVERZOOM_TILE_SIZE);
    return canvas;
  }
  return null;
}

const CachedTileLayer = L.TileLayer.extend({
  createTile(coords, done) {
    const img = document.createElement('img');
    img.setAttribute('role', 'presentation');
    const url = this.getTileUrl(coords);
    const finish = () => {
      done(null, img);
    };
    const giveUpBlank = () => {
      img.onload = null;
      img.onerror = null;
      img.src = BLANK_TILE_SRC;
      done(null, img); // report success (with blank content) so Leaflet doesn't retry forever and our zoom/tile-load bridging still sees this tile as settled
    };
    const fallbackToPlainImg = () => {
      img.onload = finish;
      img.onerror = giveUpBlank;
      img.src = url;
    };
    const showBlob = (blob) => {
      const objectUrl = URL.createObjectURL(blob);
      img.onload = () => { URL.revokeObjectURL(objectUrl); finish(); };
      img.onerror = () => { URL.revokeObjectURL(objectUrl); fallbackToPlainImg(); };
      img.src = objectUrl;
    };
    const showCanvas = (canvas) => {
      canvas.toBlob(blob => {
        if (!blob) { fallbackToPlainImg(); return; } // shouldn't happen, but never worse than the old behavior
        showBlob(blob);
      });
    };
    if (!('caches' in window)) { fallbackToPlainImg(); return img; }
    fetchTileCached(url)
      .then(res => { if (!res.ok) throw new Error('tile-http-' + res.status); return res.blob(); })
      .then(async blob => {
        if (this.options.overzoomFallback && await isPlaceholderBlob(blob)) {
          const fallbackCanvas = await buildOverzoomFallbackTile(this, coords);
          if (fallbackCanvas) { showCanvas(fallbackCanvas); return; }
          // No ancestor up to the climb limit had real imagery either —
          // show Esri's own placeholder rather than a blank gap.
        }
        showBlob(blob);
      })
      .catch(fallbackToPlainImg);
    return img;
  }
});

// --- Map styles ------------------------------------------------------
// Each style has a "light" tile source, and either a "dark" tile source
// (a genuinely different, dark-designed basemap) or a CSS filter that
// adapts the light tiles to dark theme. Either way, the app's light/dark
// theme setting is layered on top of whatever style the user picked.
const INVERT_DARK_FILTER = 'invert(1) hue-rotate(180deg) brightness(.92) contrast(.92)';
const MAP_STYLES = {
  standard: {
    nameEn:'Standard', nameSr:'Standardna',
    light:{ url:'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', subdomains:'abc', maxNativeZoom:19, maxZoom:20,
            attribution:'© OpenStreetMap contributors' },
    dark:{ filter: INVERT_DARK_FILTER }
  },
  streets:{
    nameEn:'Streets', nameSr:'Ulice',
    light:{ url:'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', subdomains:'abcd', maxNativeZoom:20, maxZoom:20,
            attribution:'© OpenStreetMap contributors © CARTO' },
    dark:{ filter: INVERT_DARK_FILTER }
  },
  minimal:{
    nameEn:'Minimal', nameSr:'Minimalna',
    light:{ url:'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', subdomains:'abcd', maxNativeZoom:20, maxZoom:20,
            attribution:'© OpenStreetMap contributors © CARTO' },
    dark:{ url:'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', subdomains:'abcd', maxNativeZoom:20, maxZoom:20,
           attribution:'© OpenStreetMap contributors © CARTO' }
  },
  satellite: {
    nameEn:'Satellite', nameSr:'Satelitska',
    // Real imagery tops out around z19 in most places (lower in rural
    // areas). Two overzoom mechanisms cover that, stacked:
    //  1. Past maxNativeZoom, Leaflet's own built-in overzoom just keeps
    //     requesting the z19 tile and stretches it further per zoom level.
    //  2. Within native zoom, individual tiles can still come back as
    //     Esri's flat gray "no imagery" placeholder (common in sparse rural
    //     regions even at z14-17). CachedTileLayer's overzoomFallback below
    //     detects that per-tile and climbs to the nearest ancestor zoom
    //     that DOES have coverage, stretching just that crop in.
    // Either way we keep the user on Satellite rather than switching them
    // to Standard out from under themselves — worse resolution sometimes,
    // but never a surprise style change.
    light:{ url:'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', subdomains:'', maxNativeZoom:19, maxZoom:22,
            attribution:'Esri, Maxar, Earthstar Geographics', overzoomFallback:true }
    // Deliberately no `dark` filter here: it's real aerial photography, not
    // themed UI, so it should look identical in light and dark mode rather
    // than getting dimmed/tinted just because the app theme is dark.
  },
  hybrid:{
    nameEn:'Hybrid', nameSr:'Hibridna',
    // Same imagery as Satellite, with a transparent Esri reference layer
    // (place names, roads, borders) drawn on top so labels stay readable.
    // Same zoom-cap reasoning as Satellite above.
    light:{ url:'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', subdomains:'', maxNativeZoom:19, maxZoom:22,
            attribution:'Esri, Maxar, Earthstar Geographics', overzoomFallback:true,
            overlayUrl:'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
            overlaySubdomains:'', overlayMaxNativeZoom:19,
            overlayAttribution:'Esri' }
    // Same reasoning as Satellite above: no dark filter, real imagery stays as-is.
  }
};
const MAP_STYLE_ORDER = ['standard', 'streets', 'minimal', 'satellite', 'hybrid'];
// Smart per-context defaults: best-suited style for each travel mode, and
// for the map when not navigating. Everything defaults to standard now
// (car used to default to streets and bike to terrain, back when terrain
// was an option — terrain's gone, so there's no reason for car/bike to
// diverge from the plain default anymore).
const MAP_STYLE_SMART_DEFAULTS = { overview:'standard', car:'standard', bike:'standard', foot:'standard' };

const MAP_STYLE_DEFAULT_KEY = 'ttb_map_style_default';
const MAP_STYLE_NAV_PREFIX = 'ttb_map_style_nav_';

function mapStyleName(id) {
  const s = MAP_STYLES[id];
  if (!s) return id;
  return isSerbianLang() ? s.nameSr : s.nameEn;
}

let mapStyleDefault = localStorage.getItem(MAP_STYLE_DEFAULT_KEY) || MAP_STYLE_SMART_DEFAULTS.overview;
if (!MAP_STYLES[mapStyleDefault]) mapStyleDefault = MAP_STYLE_SMART_DEFAULTS.overview;

// Per-mode nav preference is just the user's last explicit pick for that
// mode — no "auto" fallback anymore. Defaults to the plain Standard style
// until the user picks something else, and whatever they pick is what
// sticks (persisted in localStorage, same as the general default).
function getNavMapStylePref(mode) {
  const v = localStorage.getItem(MAP_STYLE_NAV_PREFIX + mode);
  return (v && MAP_STYLES[v]) ? v : (MAP_STYLE_SMART_DEFAULTS[mode] || 'standard');
}

function setMapStyleDefault(styleId) {
  if (!MAP_STYLES[styleId]) return;
  mapStyleDefault = styleId;
  try { localStorage.setItem(MAP_STYLE_DEFAULT_KEY, styleId); } catch (e) {}
  refreshActiveMapStyle();
}

function setNavMapStylePref(mode, styleId) {
  if (!MAP_STYLES[styleId]) return;
  try { localStorage.setItem(MAP_STYLE_NAV_PREFIX + mode, styleId); } catch (e) {}
  refreshActiveMapStyle();
}

// Resolves which style should currently be shown: the per-mode nav
// preference while navigating, otherwise the general default style.
function resolveActiveMapStyleId() {
  if (typeof drivingMode !== 'undefined' && drivingMode) {
    const mode = (typeof travelMode !== 'undefined') ? travelMode : 'car';
    return getNavMapStylePref(mode);
  }
  return mapStyleDefault;
}

function currentThemeResolved() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function buildOneTileLayer(url, opts, fallbackMaxZoom) {
  return new CachedTileLayer(url, {
    attribution: opts.attribution,
    subdomains: opts.subdomains !== undefined ? opts.subdomains : 'abc',
    maxZoom: opts.maxZoom || fallbackMaxZoom || 20,
    maxNativeZoom: opts.maxNativeZoom || 19,
    keepBuffer: 8,
    updateWhenZooming: false,
    noWrap: true,
    // Left off on purpose: with it on, Leaflet requests tiles one zoom level past
    // maxNativeZoom on high-DPI screens (via zoomOffset), which 404s once you're
    // zoomed past what a given tile provider actually supports — showing up as the
    // map tiles going blank instead of the intended "stretch the last good tile"
    // fallback below. Since this is a mobile-first app, that hit most phones.
    detectRetina: false,
    // Per-tile placeholder detection + ancestor-crop overzoom (see the
    // satellite/hybrid style definitions above) — off by default, only the
    // Esri imagery sources opt in.
    overzoomFallback: !!opts.overzoomFallback
  });
}

// Builds the map layer for a style. Normally this is a single tile layer,
// but styles like Hybrid combine a base (satellite) layer with a second,
// transparent labels/boundaries layer drawn on top — so this can return
// either a single CachedTileLayer or an L.layerGroup of two. Callers that
// need "the base layer" specifically (e.g. to know when tiles have loaded)
// should use the group's `_ttbBaseLayer` reference.
function buildTileLayer(styleId, theme) {
  const style = MAP_STYLES[styleId] || MAP_STYLES.standard;
  const source = (theme === 'dark' && style.dark && style.dark.url) ? style.dark : style.light;
  const base = buildOneTileLayer(source.url, source, 20);
  if (!source.overlayUrl) return base;
  const overlay = buildOneTileLayer(source.overlayUrl, {
    attribution: source.overlayAttribution,
    subdomains: source.overlaySubdomains,
    maxZoom: source.maxZoom,
    maxNativeZoom: source.overlayMaxNativeZoom || source.maxNativeZoom
  }, 20);
  const group = L.layerGroup([base, overlay]);
  group._ttbBaseLayer = base;
  return group;
}

function applyMapStyleFilter(styleId, theme) {
  const style = MAP_STYLES[styleId] || MAP_STYLES.standard;
  let filter = 'none';
  if (theme === 'dark') {
    // Only apply a CSS filter when this style doesn't already have its own
    // purpose-built dark tile set (e.g. Minimal's dark_all layer needs none).
    if (style.dark && style.dark.filter && !style.dark.url) filter = style.dark.filter;
  }
  document.documentElement.style.setProperty('--map-tile-filter', filter);
}

let activeTileLayer = null;
let activeMapStyleId = null;
let activeMapStyleTheme = null;

function setActiveMapStyle(styleId) {
  const resolved = MAP_STYLES[styleId] ? styleId : 'standard';
  const theme = currentThemeResolved();
  if (resolved === activeMapStyleId && theme === activeMapStyleTheme && activeTileLayer) {
    applyMapStyleFilter(resolved, theme);
    return;
  }
  const previousLayer = activeTileLayer;
  activeMapStyleId = resolved;
  activeMapStyleTheme = theme;
  const newLayer = buildTileLayer(resolved, theme);
  newLayer.addTo(map);
  activeTileLayer = newLayer;
  if (previousLayer) {
    let removed = false;
    const removeOld = () => { if (!removed && map.hasLayer(previousLayer)) { removed = true; map.removeLayer(previousLayer); } };
    const baseForLoadEvent = newLayer._ttbBaseLayer || newLayer;
    baseForLoadEvent.once('load', removeOld);
    setTimeout(removeOld, 3000);
  }
  applyMapStyleFilter(resolved, theme);
}

function refreshActiveMapStyle() {
  setActiveMapStyle(resolveActiveMapStyleId());
}

function populateMapStyleSelects() {
  const defaultSel = document.getElementById('mapStyleDefaultSelect');
  if (defaultSel) {
    defaultSel.innerHTML = MAP_STYLE_ORDER.map(id =>
      `<option value="${id}">${escapeHtml(mapStyleName(id))}</option>`).join('');
    defaultSel.value = mapStyleDefault;
  }
  const navSelectIds = { car:'mapStyleCarSelect', bike:'mapStyleBikeSelect', foot:'mapStyleFootSelect' };
  ['car', 'bike', 'foot'].forEach(mode => {
    const sel = document.getElementById(navSelectIds[mode]);
    if (!sel) return;
    sel.innerHTML = MAP_STYLE_ORDER.map(id => `<option value="${id}">${escapeHtml(mapStyleName(id))}</option>`).join('');
    sel.value = getNavMapStylePref(mode);
  });
}

// Initial layer: at startup drivingMode/travelMode haven't been declared
// yet, so use the plain default style — navigation styling kicks in once
// toggleDrivingMode()/switchTravelMode() run.
setActiveMapStyle(mapStyleDefault);

const OSM_TILE_SUBDOMAINS = ['a', 'b', 'c'];
const OFFLINE_PRECACHE_CONCURRENCY = 2;

const AUTO_CACHE_MAX_RADIUS_KM = 120;

const AUTO_CACHE_TILE_BUDGET = 6000;

const AUTO_CACHE_STORAGE_KEY = 'ttb_auto_cache_state_v1';
const AUTO_CACHE_ENABLED_KEY = 'ttb_auto_cache_enabled_v1';

function lonToTileX(lon, z) { return Math.floor((lon + 180) / 360 * Math.pow(2, z)); }
function latToTileY(lat, z) {
  const rad = Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * Math.pow(2, z));
}
function bboxAroundKm(lat, lon, radiusKm) {
  const latDelta = radiusKm / 111;
  const lonDelta = radiusKm / (111 * Math.cos(lat * Math.PI / 180 || 0.01));
  return { minLat: lat - latDelta, maxLat: lat + latDelta, minLon: lon - lonDelta, maxLon: lon + lonDelta };
}
function tilesForBBoxZoom(bbox, z) {
  const xMin = lonToTileX(bbox.minLon, z), xMax = lonToTileX(bbox.maxLon, z);
  const yMin = latToTileY(bbox.maxLat, z), yMax = latToTileY(bbox.minLat, z);
  const tiles = [];
  for (let x = xMin; x <= xMax; x++) {
    for (let y = yMin; y <= yMax; y++) tiles.push({ x, y, z });
  }
  return tiles;
}
function tilesForBBoxZoomRange(bbox, minZ, maxZ) {
  const tiles = [];
  for (let z = minZ; z <= maxZ; z++) tiles.push(...tilesForBBoxZoom(bbox, z));
  return tiles;
}
function tileUrl(tile, i) {
  const s = OSM_TILE_SUBDOMAINS[i % OSM_TILE_SUBDOMAINS.length];
  return `https://${s}.tile.openstreetmap.org/${tile.z}/${tile.x}/${tile.y}.png`;
}

async function precacheTiles(tiles, { onProgress, shouldAbort } = {}) {
  const cache = await tileCacheReady;
  if (!cache) return { done: 0, fetched: 0, failed: 0, aborted: false };
  let done = 0, fetched = 0, failed = 0, aborted = false;
  let idx = 0;
  async function worker() {
    while (idx < tiles.length) {
      if (shouldAbort && shouldAbort()) { aborted = true; return; }
      const i = idx++;
      const url = tileUrl(tiles[i], i);
      try {
        const existing = await cache.match(url);
        if (!existing) {
          const res = await fetch(url);
          if (res && res.ok) { await cache.put(url, res.clone()); fetched++; }
          else failed++;
        }
      } catch (e) { failed++; }
      done++;
      if (onProgress) onProgress(done, tiles.length);
    }
  }
  await Promise.all(Array.from({ length: OFFLINE_PRECACHE_CONCURRENCY }, worker));
  return { done, fetched, failed, aborted };
}

function readAutoCacheState() {
  try {
    const raw = localStorage.getItem(AUTO_CACHE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : { doneRingKm: 0, tilesUsed: 0, center: null };
  } catch (e) { return { doneRingKm: 0, tilesUsed: 0, center: null }; }
}
function writeAutoCacheState(state) {
  try { localStorage.setItem(AUTO_CACHE_STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
}
function isAutoCacheEnabled() {
  try { return localStorage.getItem(AUTO_CACHE_ENABLED_KEY) !== '0'; } catch (e) { return true; }
}
function setOfflineAutoCacheEnabled(enabled) {
  try { localStorage.setItem(AUTO_CACHE_ENABLED_KEY, enabled ? '1' : '0'); } catch (e) {}
  const input = document.getElementById('offlineAutoCacheToggleInput');
  if (input) input.checked = enabled;
}

const AUTO_CACHE_RING_STEP_KM = 10;

const AUTO_CACHE_RING_TILE_CAP = 800;

let autoCacheRunning = false;

async function runAutoCacheTick() {
  if (autoCacheRunning || !isAutoCacheEnabled() || !('caches' in window)) return;
  if (!navigator.onLine) return;

  const conn = navigator.connection;
  if (conn && conn.type && conn.type !== 'wifi' && conn.saveData) return;

  const state = readAutoCacheState();
  if (state.tilesUsed >= AUTO_CACHE_TILE_BUDGET) return;
  if (state.doneRingKm >= AUTO_CACHE_MAX_RADIUS_KM) return;

  const center = userCoords || (state.center ? state.center : (map ? { lat: map.getCenter().lat, lon: map.getCenter().lng } : null));
  if (!center) return;
  state.center = center;

  autoCacheRunning = true;
  try {
    const ringOuter = Math.min(AUTO_CACHE_MAX_RADIUS_KM, state.doneRingKm + AUTO_CACHE_RING_STEP_KM);
    const outerBbox = bboxAroundKm(center.lat, center.lon, ringOuter);

    const maxZ = ringOuter <= 20 ? 15 : ringOuter <= 50 ? 13 : 11;
    let tiles = tilesForBBoxZoomRange(outerBbox, 6, maxZ);
    if (state.doneRingKm > 0) {
      const innerBbox = bboxAroundKm(center.lat, center.lon, state.doneRingKm);
      const innerSet = new Set(tilesForBBoxZoomRange(innerBbox, 6, maxZ).map(t => `${t.z}/${t.x}/${t.y}`));
      tiles = tiles.filter(t => !innerSet.has(`${t.z}/${t.x}/${t.y}`));
    }
    const remaining = AUTO_CACHE_TILE_BUDGET - state.tilesUsed;
    tiles = tiles.slice(0, Math.min(AUTO_CACHE_RING_TILE_CAP, remaining));

    if (tiles.length) {
      const result = await precacheTiles(tiles, { shouldAbort: () => !isAutoCacheEnabled() });
      state.tilesUsed += result.done;
    }
    state.doneRingKm = ringOuter;
    writeAutoCacheState(state);
    updateOfflineMapStorageText();
  } finally {
    autoCacheRunning = false;
  }
}

const AUTO_CACHE_TICK_MS = 45000;
setInterval(() => {
  const kickoff = () => runAutoCacheTick();
  if ('requestIdleCallback' in window) requestIdleCallback(kickoff, { timeout: 5000 });
  else setTimeout(kickoff, 0);
}, AUTO_CACHE_TICK_MS);

async function updateOfflineMapStorageText() {
  const el = document.getElementById('offlineMapStorageText');
  if (!el) return;
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      const mb = est.usage ? Math.round(est.usage / 1024 / 1024) : 0;
      el.textContent = (t('offlineMapStorageUsed') || 'Offline data stored: {mb} MB').replace('{mb}', mb);
    }
  } catch (e) {}
}

function initOfflineMapSettingsUi() {
  const input = document.getElementById('offlineAutoCacheToggleInput');
  if (input) input.checked = isAutoCacheEnabled();
  updateOfflineMapStorageText();
}

// ---- Web Push notifications ------------------------------------------------
// The VAPID public key is not secret; it's meant to travel to the client.
// (Its matching private key lives only as an edge function secret in Supabase.)
const VAPID_PUBLIC_KEY = 'BBz_1Cd0JiiLAWXQP-mPl3gHhMnsjNsABwpbt6Ldm6I05OzvlEzXaveFWqBKLpgfCac9Zil663dPZM05xr-yFjw';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function getExistingPushSubscription() {
  if (!pushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.ready;
    return await reg.pushManager.getSubscription();
  } catch (e) { return null; }
}

// Called on load and whenever the settings modal opens, to keep the toggle
// in sync with the real browser permission/subscription state (it can drift
// if the user revokes notification permission from browser settings, etc).
async function syncPushToggleUi() {
  const row = document.getElementById('pushNotifToggleRow');
  const input = document.getElementById('pushNotifToggleInput');
  if (!row || !input) return;
  if (!pushSupported() || !currentSession) {
    row.style.display = 'none';
    return;
  }
  row.style.display = '';
  if (Notification.permission === 'denied') {
    input.checked = false;
    input.disabled = true;
    return;
  }
  input.disabled = false;
  const sub = await getExistingPushSubscription();
  input.checked = !!sub;
}

const PUSH_PROMPT_DISMISSED_KEY = 'ttb_push_prompt_dismissed';

function showPushPrompt() {
  const modal = document.getElementById('pushPromptModal');
  const inner = document.getElementById('pushPromptModalInner');
  if (!modal || !inner) return;
  inner.innerHTML = `
    <h2>${t('pushPromptTitle')}</h2>
    <p>${t('pushPromptDesc')}</p>
    <div style="display:flex;gap:var(--space-8);">
      <button type="button" class="settings-btn" style="flex:1;" onclick="respondToPushPrompt(false)">${t('pushPromptNo')}</button>
      <button type="button" style="background:var(--accent);color:white;flex:1;border:none;border-radius:14px;padding:12px 20px;font-size:var(--fs-14);font-weight:var(--fw-semibold);cursor:pointer;min-height:44px;" onclick="respondToPushPrompt(true)">${t('pushPromptYes')}</button>
    </div>
  `;
  bringModalToFront(modal);
  modal.style.display = 'flex';
  openOverlay('pushPromptModal', hidePushPrompt);
}

function hidePushPrompt() {
  const modal = document.getElementById('pushPromptModal');
  if (modal) modal.style.display = 'none';
  closeOverlay('pushPromptModal');
}

async function respondToPushPrompt(accepted) {
  try { localStorage.setItem(PUSH_PROMPT_DISMISSED_KEY, '1'); } catch (err) {}
  hidePushPrompt();
  const input = document.getElementById('pushNotifToggleInput');
  await setPushNotificationsEnabled(accepted);
  if (input) input.checked = accepted && Notification.permission === 'granted';
}

// Asks a signed-in user once (per device) whether they want push notifications,
// instead of leaving the toggle off by default and buried in settings. Only
// asks if: push is supported here, permission hasn't already been decided at
// the browser level, they don't already have a subscription, we haven't
// asked on this device before, and nothing else is already on screen.
async function maybeShowPushPrompt() {
  if (!currentSession || !pushSupported()) return;
  if (Notification.permission !== 'default') return;
  let alreadyAsked = false;
  try { alreadyAsked = localStorage.getItem(PUSH_PROMPT_DISMISSED_KEY) === '1'; } catch (err) {}
  if (alreadyAsked) return;
  const existing = await getExistingPushSubscription();
  if (existing) return;
  if (overlayStack.length > 0) return;
  showPushPrompt();
}

async function subscribeToPush() {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }
  const json = sub.toJSON();
  const { error } = await sb.from('push_subscriptions').upsert({
    user_id: currentSession.user.id,
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth,
    user_agent: navigator.userAgent,
  }, { onConflict: 'endpoint' });
  if (error) throw error;
}

async function unsubscribeFromPush() {
  const sub = await getExistingPushSubscription();
  if (sub) {
    const endpoint = sub.endpoint;
    await sub.unsubscribe().catch(() => {});
    if (currentSession) {
      await sb.from('push_subscriptions').delete().eq('endpoint', endpoint).eq('user_id', currentSession.user.id);
    }
  }
}

async function setPushNotificationsEnabled(enabled) {
  const input = document.getElementById('pushNotifToggleInput');
  if (!pushSupported()) {
    toast(t('pushNotSupported'), 'error');
    if (input) input.checked = false;
    return;
  }
  if (!currentSession) {
    if (input) input.checked = false;
    return;
  }
  if (enabled) {
    try {
      if (Notification.permission === 'denied') {
        toast(t('pushPermissionBlocked'), 'error');
        if (input) input.checked = false;
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        if (input) input.checked = false;
        return;
      }
      await subscribeToPush();
    } catch (err) {
      console.error('Push subscribe failed:', err);
      toast(t('pushEnableFailed'), 'error');
      if (input) input.checked = false;
    }
  } else {
    try {
      await unsubscribeFromPush();
    } catch (err) {
      console.error('Push unsubscribe failed:', err);
    }
  }
}

// ---- Per-type push notification preferences --------------------------------
// Stored as profiles.disabled_push_types (text[]). A type absent from that
// array is enabled by default, so new types added later are opt-out, not
// opt-in — nobody silently stops getting a notification kind that didn't
// exist when they last touched this screen.
const NOTIF_TYPES = [
  { key: 'status_change',        labelKey: 'notifTypeStatusChange',      descKey: 'notifTypeStatusChangeDesc' },
  { key: 'report_fixed_thankyou',labelKey: 'notifTypeReportFixed',       descKey: 'notifTypeReportFixedDesc' },
  { key: 'report_submitted',     labelKey: 'notifTypeReportSubmitted',   descKey: 'notifTypeReportSubmittedDesc' },
  { key: 'nearby_new_report',    labelKey: 'notifTypeNearbyReport',      descKey: 'notifTypeNearbyReportDesc' },
  { key: 'admin_message',        labelKey: 'notifTypeAdminMessage',      descKey: 'notifTypeAdminMessageDesc' },
];

function renderNotifTypeToggles() {
  const list = document.getElementById('notifTypeTogglesList');
  if (!list) return;
  const disabled = (currentProfile && currentProfile.disabled_push_types) || [];
  list.innerHTML = NOTIF_TYPES.map(nt => `
    <label class="notif-type-row">
      <span class="notif-type-row-text">
        <span>${t(nt.labelKey)}</span>
        <span class="notif-type-row-desc">${t(nt.descKey)}</span>
      </span>
      <span class="toggle-switch">
        <input type="checkbox" ${disabled.includes(nt.key) ? '' : 'checked'} onchange="toggleNotifTypePush('${nt.key}', this.checked)">
        <span class="toggle-switch-track"><span class="toggle-switch-thumb"></span></span>
      </span>
    </label>
  `).join('');
}

async function toggleNotifTypePush(typeKey, enabled) {
  if (!currentSession || !currentProfile) return;
  const prev = (currentProfile.disabled_push_types || []).slice();
  const next = enabled
    ? prev.filter(k => k !== typeKey)
    : (prev.includes(typeKey) ? prev : [...prev, typeKey]);
  currentProfile.disabled_push_types = next;
  try {
    const { error } = await sb.from(PROFILES_TABLE)
      .update({ disabled_push_types: next })
      .eq('id', currentSession.user.id);
    if (error) throw error;
  } catch (err) {
    console.error('Failed to update push notification preference:', err.message);
    currentProfile.disabled_push_types = prev;
    renderNotifTypeToggles();
    toast(t('settingsSaveFailed'), 'error');
  }
}

// ---- Saved area (for the "new report near your saved area" push type) -----
function updateSavedAreaStatusText() {
  const el = document.getElementById('savedAreaStatusText');
  const radiusSelect = document.getElementById('savedAreaRadiusSelect');
  if (!el) return;
  const hasArea = currentProfile && currentProfile.saved_area_lat != null && currentProfile.saved_area_lon != null;
  const radius = (currentProfile && currentProfile.saved_area_radius_km) || 3;
  if (radiusSelect) radiusSelect.value = String(radius);
  el.textContent = hasArea
    ? t('savedAreaSetLabel').replace('{radius}', radius)
    : t('savedAreaNotSet');
}

function useCurrentLocationForSavedArea() {
  if (!currentSession || !currentProfile) return;
  if (!navigator.geolocation) {
    toast(t('savedAreaLocationFail'), 'error');
    return;
  }
  const btn = document.getElementById('savedAreaUseLocationBtn');
  if (btn) btn.disabled = true;
  navigator.geolocation.getCurrentPosition(async (pos) => {
    try {
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      const { error } = await sb.from(PROFILES_TABLE)
        .update({ saved_area_lat: lat, saved_area_lon: lon })
        .eq('id', currentSession.user.id);
      if (error) throw error;
      currentProfile.saved_area_lat = lat;
      currentProfile.saved_area_lon = lon;
      updateSavedAreaStatusText();
      toast(t('savedAreaSetSuccess'), 'success');
    } catch (err) {
      console.error('Failed to save area:', err.message);
      toast(t('settingsSaveFailed'), 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }, () => {
    if (btn) btn.disabled = false;
    toast(t('savedAreaLocationFail'), 'error');
  }, { enableHighAccuracy: false, timeout: 10000 });
}

async function clearSavedArea() {
  if (!currentSession || !currentProfile) return;
  const prev = {
    lat: currentProfile.saved_area_lat,
    lon: currentProfile.saved_area_lon,
  };
  currentProfile.saved_area_lat = null;
  currentProfile.saved_area_lon = null;
  updateSavedAreaStatusText();
  try {
    const { error } = await sb.from(PROFILES_TABLE)
      .update({ saved_area_lat: null, saved_area_lon: null })
      .eq('id', currentSession.user.id);
    if (error) throw error;
    toast(t('savedAreaClearedMsg'), 'success');
  } catch (err) {
    console.error('Failed to clear saved area:', err.message);
    currentProfile.saved_area_lat = prev.lat;
    currentProfile.saved_area_lon = prev.lon;
    updateSavedAreaStatusText();
    toast(t('settingsSaveFailed'), 'error');
  }
}

async function setSavedAreaRadius(value) {
  if (!currentSession || !currentProfile) return;
  const prev = currentProfile.saved_area_radius_km;
  const radiusKm = Number(value) || 3;
  currentProfile.saved_area_radius_km = radiusKm;
  updateSavedAreaStatusText();
  try {
    const { error } = await sb.from(PROFILES_TABLE)
      .update({ saved_area_radius_km: radiusKm })
      .eq('id', currentSession.user.id);
    if (error) throw error;
  } catch (err) {
    console.error('Failed to update saved area radius:', err.message);
    currentProfile.saved_area_radius_km = prev;
    updateSavedAreaStatusText();
    toast(t('settingsSaveFailed'), 'error');
  }
}

const ICON_CACHE_NAME = 'ttb-icons-v2';
const iconObjectUrlCache = new Map();

async function fetchIconCached(url) {
  const cache = await caches.open(ICON_CACHE_NAME);
  const cached = await cache.match(url);
  const networkFetch = fetch(url).then(response => {
    if (response && response.ok) cache.put(url, response.clone()).catch(() => {});
    return response;
  }).catch(() => null);
  if (cached) return cached;
  return networkFetch;
}

async function warmIconObjectUrl(path) {
  if (iconObjectUrlCache.has(path)) return iconObjectUrlCache.get(path);
  try {
    const res = await fetchIconCached(path);
    if (!res || !res.ok) return null;
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    iconObjectUrlCache.set(path, objUrl);
    return objUrl;
  } catch (e) {
    return null;
  }
}

function cachedIconUrl(path) {
  return iconObjectUrlCache.get(path) || path;
}

function applyCachedIconSrc(root) {
  const imgs = root.matches && root.matches('img[src^="icons/"], img[src^="./icons/"]')
    ? [root]
    : Array.from(root.querySelectorAll ? root.querySelectorAll('img[src^="icons/"], img[src^="./icons/"]') : []);
  imgs.forEach(img => {
    const path = img.getAttribute('src').replace(/^\.\//, '');
    const cachedUrl = iconObjectUrlCache.get(path);
    if (cachedUrl && img.src !== cachedUrl) img.src = cachedUrl;
  });
}

function collectAllIconPaths() {
  const staticIcons = [
    'icons/TraceTheBreak.png', 'icons/settings.png', 'icons/fullscreen-enter.png', 'icons/fullscreen-exit.png',
    'icons/user.png', 'icons/notification.png', 'icons/target.png', 'icons/pin.png', 'icons/car.png',
    'icons/category-filter.png', 'icons/heatmap.png', 'icons/camera.png', 'icons/gallery.png',
    'icons/reports/report_new.png',
    'icons/google.png', 'icons/github.png', 'icons/osm.png', 'icons/close.png', 'icons/help.png',
    'icons/arrow.png', 'icons/search.png', 'icons/trophy.png',
    'icons/public.png', 'icons/email.png', 'icons/phone.png', 'icons/link.png',
    'icons/badges/badge-admin-admin-1.png', 'icons/badges/badge-admin-admin-2.png', 'icons/badges/badge-admin-admin-3.png', 'icons/badges/badge-admin-admin-4.png',
    'icons/turn-arrive.png', 'icons/turn-roundabout.png', 'icons/turn-merge.png',
    'icons/turn-fork.png', 'icons/turn-end-of-road.png', 'icons/turn-ramp.png',
    'icons/email-sent.png', 'icons/email-resent.png', 'icons/sleep.png',
    'icons/like.png', 'icons/check.png', 'icons/vote.png',
    'icons/hourglass.png', 'icons/warning-symbol.png',
  ];
  const badgeArrays = [
    (typeof BADGES !== 'undefined') ? BADGES : [],
    (typeof USER_BADGES_EXTRA !== 'undefined') ? USER_BADGES_EXTRA : [],
    (typeof ADMIN_BADGES !== 'undefined') ? ADMIN_BADGES : [],
    (typeof ADMIN_BADGES_EXTRA !== 'undefined') ? ADMIN_BADGES_EXTRA : [],
  ];
  const badgeIcons = badgeArrays.flat().map(b => `icons/badges/${b.icon}`);
  const turnIcons = (typeof TURN_ICONS !== 'undefined')
    ? Object.values(TURN_ICONS).map(f => `icons/${f}`)
    : [];

  const wizCategoryIcons = (typeof WIZ_CATEGORY_ICONS !== 'undefined')
    ? Object.values(WIZ_CATEGORY_ICONS).map(f => `icons/reports/${f}`)
    : [];
  const wizSubcategoryIcons = (typeof WIZ_SUBCATEGORY_ICONS !== 'undefined')
    ? Object.values(WIZ_SUBCATEGORY_ICONS).flatMap(group => Object.values(group)).map(f => `icons/reports/${f}`)
    : [];
  const wizPriorityIcons = (typeof WIZ_PRIORITY_ICONS !== 'undefined')
    ? Object.values(WIZ_PRIORITY_ICONS).map(f => `icons/reports/${f}`)
    : [];
  const wizStatusIcons = (typeof WIZ_STATUS_ICONS !== 'undefined')
    ? Object.values(WIZ_STATUS_ICONS).map(f => `icons/reports/${f}`)
    : [];
  return [...new Set([
    ...staticIcons, ...badgeIcons, ...turnIcons,
    ...wizCategoryIcons, ...wizSubcategoryIcons, ...wizPriorityIcons, ...wizStatusIcons,
  ])];
}

async function initIconCaching() {
  if (!('caches' in window)) return;
  const paths = collectAllIconPaths();
  await Promise.all(paths.map(p => warmIconObjectUrl(p)));
  applyCachedIconSrc(document.body);
  refreshVisibleBadgeGrids();

  new MutationObserver(mutations => {
    for (const m of mutations) {
      m.addedNodes.forEach(node => {
        if (node.nodeType !== 1) return;
        applyCachedIconSrc(node);
      });
    }
  }).observe(document.body, { childList: true, subtree: true });
}

function refreshVisibleBadgeGrids() {
  try {
    const lbModal = document.getElementById('leaderboardModal');
    if (lbModal && lbModal.style.display !== 'none') renderUserDashboard();
  } catch (e) { console.warn('refreshVisibleBadgeGrids: renderUserDashboard failed', e); }
  try {
    const adminSection = document.getElementById('adminDashboardSection');
    if (adminSection && adminSection.style.display !== 'none') renderAdminDashboard();
  } catch (e) { console.warn('refreshVisibleBadgeGrids: renderAdminDashboard failed', e); }
}

setTimeout(initIconCaching, 0);

const CLUSTER_STATUS_RANK = { reported: 2, in_progress: 1, fixed: 0 };
const CLUSTER_PRIORITY_RANK = { high: 2, normal: 1, low: 0 };

function clusterWorstReport(cluster) {
  let worstStatus = null, worstPriority = null;
  cluster.getAllChildMarkers().forEach(m => {
    const report = (typeof globalActiveData !== 'undefined') ? globalActiveData.find(r => r.id === m._reportId) : null;
    if (!report) return;
    if (worstStatus === null || (CLUSTER_STATUS_RANK[report.status] || 0) > (CLUSTER_STATUS_RANK[worstStatus] || 0)) {
      worstStatus = report.status;
    }
    if (worstPriority === null || (CLUSTER_PRIORITY_RANK[report.priority] || 1) > (CLUSTER_PRIORITY_RANK[worstPriority] || 1)) {
      worstPriority = report.priority;
    }
  });
  return { status: worstStatus, priority: worstPriority };
}

function makeClusterIcon(cluster) {
  const count = cluster.getChildCount();
  let size = 32, fontSize = 12;
  if (count >= 10 && count < 100) { size = 40; fontSize = 13; }
  else if (count >= 100) { size = 48; fontSize = 14; }

  const { status, priority } = clusterWorstReport(cluster);
  const wrapSize = size + 16;
  let statusMarker = '';
  if (status && status !== 'fixed') {
    const groupCol = 'var(--nav-accent)';
    const pulseDuration = status === 'reported' ? 3.2 : 4.4;
    const pulseSize = priority === 'high' ? size + 10 : priority === 'low' ? size - 4 : size + 2;
    const pulseDelay = -(Math.random() * pulseDuration).toFixed(2);
    statusMarker = statusPulseEnabled
      ? `<span class="cluster-status-halo" style="background:${groupCol};width:${pulseSize}px;height:${pulseSize}px;animation-duration:${pulseDuration}s;animation-delay:${pulseDelay}s;"></span>`
      : `<span class="pin-status-ring" style="border-color:${groupCol};width:${size + 6}px;height:${size + 6}px;opacity:.5;"></span>`;
  }

  return L.divIcon({
    html: `<div class="pin-upright" style="position:relative;width:${wrapSize}px;height:${wrapSize}px;">` +
      statusMarker +
      `<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:${size}px;height:${size}px;box-sizing:border-box;border-radius:50%;` +
      `background:var(--nav-accent);border:3px solid #fff;` +
      `display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,.5);` +
      `color:#fff;font-weight:var(--fw-bold);font-size:${fontSize}px;">${count}</div>` +
      `</div>`,
    className: '',
    iconSize: [wrapSize, wrapSize]
  });
}
// Leaflet.markercluster groups markers purely by screen-pixel distance, with
// zero idea what's underneath -- it doesn't know if two pins are 5m apart on
// the same sidewalk or on opposite sides of a two-lane road. A flat 50px
// radius is fine at a city-wide zoom (that's real decluttering, not
// precision people rely on), but the SAME 50px at a street-level zoom can
// correspond to 60-80+ real-world meters, which is exactly wide enough to
// bundle a sign on one side of the street with a sign on the other into a
// single bubble. So the radius now shrinks as you zoom in: generous while
// zoomed out, tight by the time buildings/street names are legible, so pins
// split apart into individuals right around the zoom level where people can
// actually tell the two sides of a street apart.
function reportsClusterRadius(zoom) {
  if (zoom <= 13) return 50;
  if (zoom <= 15) return 30;
  return 12;
}
const pinCluster = L.markerClusterGroup({
  maxClusterRadius: reportsClusterRadius,
  disableClusteringAtZoom: 16,
  spiderfyOnMaxZoom: true,
  showCoverageOnHover: false,
  // Fly/split (regroup) animation is OFF. It was only ever meant to run
  // after a zoom gesture settled and pins were becoming visible again (see
  // endZoomBurst / scheduleMarkerSyncOnSettle) — never during the zoom
  // itself. In practice it was still producing visibility glitches (pins
  // flickering/mispositioned), so it's disabled outright for now rather
  // than half-working. Pins/clusters now just appear instantly once
  // map-zooming is cleared. Flip both flags back to true here if the
  // underlying glitch gets tracked down later.
  animate: false,
  animateAddingMarkers: false,
  iconCreateFunction: makeClusterIcon
});

function removeReportLayer(layer) {
  if (pinCluster.hasLayer(layer)) pinCluster.removeLayer(layer);
  else map.removeLayer(layer);
}

function makePublicClusterIcon(cluster) {
  const count = cluster.getChildCount();
  let size = 32, fontSize = 12;
  if (count >= 10 && count < 100) { size = 40; fontSize = 13; }
  else if (count >= 100) { size = 48; fontSize = 14; }
  return L.divIcon({
    html: `<div class="pin-upright" style="width:${size}px;height:${size}px;box-sizing:border-box;border-radius:50%;` +
      `background:#2f8f5b;border:3px solid #fff;` +
      `display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,.5);` +
      `color:#fff;font-weight:var(--fw-bold);font-size:${fontSize}px;">${count}</div>`,
    className: '',
    iconSize: [size, size]
  });
}
const companyMarkersLayer = L.markerClusterGroup({
  maxClusterRadius: 50,
  disableClusteringAtZoom: 17,
  spiderfyOnMaxZoom: true,
  showCoverageOnHover: false,
  // Same as pinCluster above — animation off.
  animate: false,
  animateAddingMarkers: false,
  iconCreateFunction: makePublicClusterIcon
}).addTo(map);

pinCluster.addTo(map);

let rotWrapper = null;
function initRotationWrapper() {
  const mapPane = map.getPane('mapPane');
  if (!mapPane || !mapPane.parentElement) return;
  rotWrapper = document.createElement('div');
  rotWrapper.className = 'leaflet-rotate-wrapper';
  mapPane.parentElement.insertBefore(rotWrapper, mapPane);
  rotWrapper.appendChild(mapPane);
}
initRotationWrapper();

let userCoords    = null;
let userMarker    = null;
let userMarkerNavStyle = false;
let markerById    = new Map();
let sectionPinById = new Map();
let dateRangeOnlyData = [];

// Kept tight on purpose: this only needs to catch the same physical issue
// reported twice (GPS jitter on a phone is typically well under this), not
// "roughly the same spot". Two reports on opposite sides of a street --
// opposite curbs, opposite lanes, a sign across the road from another sign
// -- are almost always farther apart than this once you account for the
// road width plus sidewalks/verges on both sides, so they should NOT match.
// If real duplicates ever slip through at this radius in a specific area,
// that's a sign it needs tuning per-category (e.g. wide highways vs.
// narrow lanes), not a reason to loosen it back up broadly.
const DUPLICATE_MERGE_RADIUS_M = 8;
let duplicateGroupByReportId = new Map();

let _duplicateGroupsComputedForVersion = -1;

function recomputeDuplicateGroups() {

  if (_duplicateGroupsComputedForVersion === activeDataVersion) return;
  _duplicateGroupsComputedForVersion = activeDataVersion;

  duplicateGroupByReportId = new Map();
  const candidates = globalActiveData
    .filter(r => r.status !== 'fixed' && isValidLatLng(r.latitude, r.longitude) && !isSectionReport(r))
    .slice()
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  const groups = [];
  candidates.forEach(r => {
    // Same category AND same subcategory (e.g. "Road/signage" no longer
    // matches "Road/pothole" just because both are Road) -- and close to
    // EVERY report already in the group, not just the first one filed.
    // Matching only against the anchor let groups "drift": A near B, B near
    // C, but A and C themselves too far apart (or on opposite sides of the
    // street) to actually be the same issue -- that chain no longer links up.
    const group = groups.find(g =>
      g.anchor.category === r.category &&
      (g.anchor.subcategory || null) === (r.subcategory || null) &&
      g.ids.every(id => {
        const member = candidates.find(c => c.id === id);
        return member && distMeters({ lat: member.latitude, lon: member.longitude }, { lat: r.latitude, lon: r.longitude }) <= DUPLICATE_MERGE_RADIUS_M;
      })
    );
    if (group) group.ids.push(r.id);
    else groups.push({ anchor: r, ids: [r.id] });
  });

  groups.forEach(g => {
    if (g.ids.length < 2) return;

    const info = { ids: g.ids.slice(), primaryId: g.ids[0], count: g.ids.length };
    g.ids.forEach(id => duplicateGroupByReportId.set(id, info));
  });
}

function duplicateGroupFor(reportId) {
  return duplicateGroupByReportId.get(reportId) || null;
}

let pinMode       = false;
let manualCoords  = null;
let manualMarker  = null;
let manualPinMunicipality = null;
let navPinMode    = false;

let followMode        = false;
let drivingMode        = false;

let travelMode         = 'car';
function isBikeMode() { return drivingMode && travelMode === 'bike'; }
function isCarMode()  { return drivingMode && travelMode === 'car'; }
let sectionRecording   = false;
let sectionAwaitingCategory = false;
let sectionPoints      = [];
let sectionPolyline    = null;
const SECTION_MIN_DISTANCE_M = 8;

const SECTION_PATH_GAP_MS = 20000;
let sectionLastAt      = null;
let sectionGapFilling  = false;

let currentHeading            = null;
let compassActive             = false;
let mapBearing                 = 0;
let headingUpMode             = true;
let walkingHeadingMode        = false;

function isHeadingUpActive() {
  return drivingMode ? headingUpMode : walkingHeadingMode;
}
let orientationListenersBound = false;
let orientationPermissionAsked = false;
let lastAbsoluteHeadingAt      = 0;

function shortestAngleDelta(fromDeg, toDeg) {
  let d = (toDeg - fromDeg) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

function updateRotationOrigin() {
  if (!rotWrapper) return;
  rotWrapper.style.transformOrigin = '50% 50%';
}
window.addEventListener('resize', updateRotationOrigin);

// Sets mapBearing to an absolute value directly, with no shortest-path
// smoothing. applyMapBearing() below (compass/heading-driven) still wants
// that smoothing so a heading jump doesn't spin the map the "long way
// round" — but gesture-driven rotation (two-finger twist, shift+drag) is
// the user directly, continuously controlling bearing frame-by-frame, so
// it must track 1:1 with no smoothing/shortest-path reinterpretation.
function applyMapBearingRaw(newBearingDeg) {
  mapBearing = newBearingDeg;
  const cssRotation = `rotate(${mapBearing}deg)`;
  if (rotWrapper) rotWrapper.style.transform = cssRotation;
  document.querySelectorAll('.compass-needle').forEach(needle => { needle.style.transform = cssRotation; });
  if (typeof setNativeDraggingEnabled === 'function') setNativeDraggingEnabled(!rotationActive());
  if (typeof setNativeZoomEnabled === 'function') setNativeZoomEnabled(!rotationActive());
  document.documentElement.style.setProperty('--pin-counter-rotate', `${-mapBearing}deg`);
  updateAllPopupRotations();
  updateUserMarkerRotation();
  updateZoomAnimationForRotation();
}

function applyMapBearing(targetHeadingDeg) {
  const delta = shortestAngleDelta(mapBearing % 360, targetHeadingDeg);
  applyMapBearingRaw(mapBearing + delta);
}

const ROTATION_EPSILON_DEG = 0.5;
function updateZoomAnimationForRotation() {
  if (!map) return;
  const rotated = Math.abs(((mapBearing % 360) + 360) % 360) > ROTATION_EPSILON_DEG &&
    Math.abs(((mapBearing % 360) + 360) % 360) < 360 - ROTATION_EPSILON_DEG;
  const shouldAnimate = !rotated && L.Browser.any3d;
  if (map._zoomAnimated !== shouldAnimate) {
    map._zoomAnimated = shouldAnimate;

    try { map._resetView(map.getCenter(), map.getZoom(), true); } catch (e) {}
  }
}

function ensurePopupRotationWrap(popupEl) {
  if (!popupEl) return null;
  let wrap = popupEl.querySelector(':scope > .popup-rotate-wrap');
  if (wrap) return wrap;
  const contentWrapper = popupEl.querySelector('.leaflet-popup-content-wrapper');
  if (!contentWrapper) return null;
  wrap = document.createElement('div');
  wrap.className = 'popup-rotate-wrap';
  const tipContainer = popupEl.querySelector('.leaflet-popup-tip-container');
  contentWrapper.parentNode.insertBefore(wrap, contentWrapper);
  wrap.appendChild(contentWrapper);
  if (tipContainer) wrap.appendChild(tipContainer);
  return wrap;
}

function rotatePopupElement(popupEl) {
  const wrap = ensurePopupRotationWrap(popupEl);
  if (wrap) wrap.style.transform = `rotate(${-mapBearing}deg)`;
}

function updateAllPopupRotations() {
  document.querySelectorAll('.leaflet-popup').forEach(rotatePopupElement);
}

const mobilePopupOverlay = document.getElementById('mobilePopupOverlay');
let mobilePopupOriginalParent = null;

map.on('popupopen', e => {
  const uc = e.popup && e.popup._source && e.popup._source._utilityCompany;
  if (uc) e.popup.setContent(buildCompanyPopupHtml(uc.c, uc.lat, uc.lon));
  const popupEl = e.popup && e.popup._container;
  if (popupEl) rotatePopupElement(popupEl);
  if (popupEl && mobilePopupOverlay) {
    mobilePopupOriginalParent = popupEl.parentNode;
    mobilePopupOverlay.appendChild(popupEl);
    mobilePopupOverlay.classList.add('showing');
  }
  openOverlay('mapPopup', () => map.closePopup());
});
map.on('popupclose', e => {
  const popupEl = e.popup && e.popup._container;
  if (popupEl && mobilePopupOriginalParent) {
    mobilePopupOriginalParent.appendChild(popupEl);
    mobilePopupOriginalParent = null;
  }
  if (mobilePopupOverlay) mobilePopupOverlay.classList.remove('showing');
  closeOverlay('mapPopup');
});

let mobilePopupOverlayPointerDownOnBackdrop = false;
if (mobilePopupOverlay) {
  mobilePopupOverlay.addEventListener('pointerdown', e => {
    mobilePopupOverlayPointerDownOnBackdrop = (e.target === mobilePopupOverlay);
  });
  mobilePopupOverlay.addEventListener('click', e => {
    if (e.target === mobilePopupOverlay && mobilePopupOverlayPointerDownOnBackdrop) {
      map.closePopup();
    }
    mobilePopupOverlayPointerDownOnBackdrop = false;
  });
}

function resetMapBearing() {
  applyMapBearing(0);
}

function getFollowCenter(lat, lon, zoom) {
  return L.latLng(lat, lon);
}

function followMapTo(lat, lon, options) {
  const zoom = Math.max(map.getZoom(), drivingMode ? 17 : 16);
  map.setView(getFollowCenter(lat, lon, zoom), zoom, options || { animate: true });
}

function buildDroppedPinHtml() {
  return '<img src="icons/pin.png" alt="pin" class="dropped-pin-icon pin-upright">';
}

function buildUserMarkerHtml(navStyle) {
  if (navStyle) {
    return '<div class="user-nav-marker">' +
             '<div class="user-nav-pulse"></div>' +
             '<div class="user-nav-halo"></div>' +
             '<div class="user-nav-arrow">' +
               '<svg viewBox="0 0 24 24" width="32" height="32">' +
                 '<path d="M12 2.2 L19.3 20 L12 15.6 L4.7 20 Z" fill="var(--accent)" stroke="rgba(0,0,0,.35)" stroke-width="1" stroke-linejoin="round"/>' +
               '</svg>' +
             '</div>' +
           '</div>';
  }
  return '<div class="user-dot-marker">' +
           '<div class="user-dot-pulse"></div>' +
           '<div class="user-dot"></div>' +
         '</div>';
}

function setUserMarkerStyle(navStyle) {
  userMarkerNavStyle = navStyle;
  if (!userMarker) return;
  const size = navStyle ? 46 : 34;
  userMarker.setIcon(L.divIcon({
    className: 'user-location-icon',
    html: buildUserMarkerHtml(navStyle),
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2]
  }));
  updateUserMarkerRotation();
}

let arrowContinuousAngle = 0;

function updateUserMarkerRotation() {
  if (!userMarker || !userMarkerNavStyle) return;
  const el = userMarker.getElement();
  if (!el) return;
  const arrow = el.querySelector('.user-nav-arrow');
  if (!arrow) return;
  let angle;
  if (isHeadingUpActive()) {
    angle = -mapBearing;
  } else {
    const target = (drivingMode && animatedDrivingHeading !== null) ? animatedDrivingHeading : (currentHeading || 0);
    arrowContinuousAngle += shortestAngleDelta(arrowContinuousAngle % 360, target);
    angle = arrowContinuousAngle;
  }
  arrow.style.transform = `rotate(${angle}deg)`;
}

function toggleHeadingUpMode() {
  headingUpMode = !headingUpMode;
  const btn = document.getElementById('mapCompass');
  if (btn) {
    btn.classList.toggle('heading-up-disabled', !headingUpMode);
    btn.setAttribute('aria-pressed', String(headingUpMode));
  }
  if (!headingUpMode) {
    resetMapBearing();
  } else if (drivingMode && currentHeading !== null) {
    applyMapBearing(-currentHeading);
  }
  updateUserMarkerRotation();
}

function toggleWalkingCompassMode() {
  walkingHeadingMode = !walkingHeadingMode;
  const btn = document.getElementById('mainMapCompass');
  if (btn) {
    btn.classList.toggle('heading-up-disabled', !walkingHeadingMode);
    btn.setAttribute('aria-pressed', String(walkingHeadingMode));
  }
  requestOrientationPermission();
  if (!walkingHeadingMode) {
    resetMapBearing();
  } else if (currentHeading !== null) {
    applyMapBearing(-currentHeading);
  }
  updateUserMarkerRotation();
}

function requestOrientationPermission() {
  if (orientationPermissionAsked) return;
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    orientationPermissionAsked = true;
    DeviceOrientationEvent.requestPermission().then(state => {
      if (state === 'granted') attachOrientationListeners();
    }).catch(() => {});
  } else {
    orientationPermissionAsked = true;
    attachOrientationListeners();
  }
}

function attachOrientationListeners() {
  if (orientationListenersBound) return;
  orientationListenersBound = true;
  orientationListenersAttachedAt = Date.now();
  window.addEventListener('deviceorientationabsolute', handleOrientationEvent, true);
  window.addEventListener('deviceorientation', handleOrientationEvent, true);
}

const ABSOLUTE_HEADING_STALE_MS = 3000;
const ORIENTATION_ABSOLUTE_GIVEUP_MS = 5000;
let orientationListenersAttachedAt = 0;
const ORIENTATION_FLAT_BETA_DEG = 25;
function isDeviceNearlyFlat(beta) {
  if (typeof beta !== 'number' || isNaN(beta)) return false;
  const b = Math.abs(beta);
  return b < ORIENTATION_FLAT_BETA_DEG || b > 180 - ORIENTATION_FLAT_BETA_DEG;
}
const ORIENTATION_MAX_JUMP_DEG = 120;

function handleOrientationEvent(event) {
  if (drivingMode && travelMode !== 'foot') return;

  if ((Date.now() - lastGpsHeadingAt) < GPS_HEADING_FRESH_MS) {
    return;
  }

  if (isDeviceNearlyFlat(event.beta)) return;

  let heading = null;
  let isAbsolute = false;

  if (typeof event.webkitCompassHeading === 'number' && !isNaN(event.webkitCompassHeading)) {
    heading = event.webkitCompassHeading;
    isAbsolute = true;
  } else if (event.absolute && typeof event.alpha === 'number') {
    heading = 360 - event.alpha;
    isAbsolute = true;
  }

  if (isAbsolute) {
    lastAbsoluteHeadingAt = Date.now();
  } else if (
    typeof event.alpha === 'number' &&
    (
      (compassActive && Date.now() - lastAbsoluteHeadingAt > ABSOLUTE_HEADING_STALE_MS) ||
      (!compassActive && Date.now() - orientationListenersAttachedAt > ORIENTATION_ABSOLUTE_GIVEUP_MS)
    )
  ) {
    heading = 360 - event.alpha;
  }
  if (heading === null || isNaN(heading)) return;

  if (currentHeading !== null && Math.abs(shortestAngleDelta(currentHeading, (heading + 360) % 360)) > ORIENTATION_MAX_JUMP_DEG) {
    return;
  }

  compassActive = true;
  smoothedHeading = smoothHeading(smoothedHeading, (heading + 360) % 360, HEADING_SMOOTHING_FACTOR);
  currentHeading = smoothedHeading;
  if (isHeadingUpActive()) applyMapBearing(-currentHeading);
  updateUserMarkerRotation();
}

function isNavigationActive() {
  return navState === NavState.NAVIGATING || navState === NavState.OFF_ROUTE || navState === NavState.RECALCULATING;
}

function distMeters(a, b) {
  if (!a || !b) return Infinity;
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function bearingBetween(a, b) {
  const toRad = d => d * Math.PI / 180;
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function isMobileDevice() {
  if (navigator.userAgent.includes('TraceTheStuffApp')) return true;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) return true;
  return !!(window.matchMedia && window.matchMedia('(pointer:coarse)').matches);
}

const VPN_CHECK_URL = 'https://ipwho.is/?fields=success,security';
const VPN_RECHECK_INTERVAL_MS = 5 * 60 * 1000;
let vpnCheckResult = null;
let vpnCheckedAt = 0;
let vpnCheckInFlight = null;

async function ensureVpnStatus() {
  const isFresh = vpnCheckResult && (Date.now() - vpnCheckedAt) < VPN_RECHECK_INTERVAL_MS;
  if (isFresh) return vpnCheckResult;
  if (vpnCheckInFlight) return vpnCheckInFlight;

  vpnCheckInFlight = (async () => {
    try {
      const res = await fetch(VPN_CHECK_URL);
      const data = await res.json();
      const sec = data && data.success !== false ? data.security : null;
      vpnCheckResult = { isVpn: !!(sec && (sec.vpn || sec.proxy || sec.tor)) };
    } catch (err) {
      vpnCheckResult = { isVpn: false };
    }
    vpnCheckedAt = Date.now();
    vpnCheckInFlight = null;
    return vpnCheckResult;
  })();
  return vpnCheckInFlight;
}
ensureVpnStatus();

const REPORT_PROXIMITY_MAX_M = 50;

const VOTE_PROXIMITY_MAX_M = 50;

function offsetLatLng(lat, lon, bearingDeg, meters) {
  const R = 6371000;
  const brng = bearingDeg * Math.PI / 180;
  const latRad = lat * Math.PI / 180;
  const dLat = (meters * Math.cos(brng)) / R;
  const dLon = (meters * Math.sin(brng)) / (R * Math.cos(latRad));
  return { lat: lat + dLat * 180 / Math.PI, lon: lon + dLon * 180 / Math.PI };
}

function nearestPointOnSegment(p, a, b) {
  const latRef = (a[0] + b[0]) / 2;
  const cosLat = Math.cos(latRef * Math.PI / 180) || 1e-9;
  const ax = a[1] * cosLat, ay = a[0];
  const bx = b[1] * cosLat, by = b[0];
  const px = p.lon * cosLat, py = p.lat;

  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let tt = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
  tt = Math.max(0, Math.min(1, tt));
  return { lat: a[0] + tt * (b[0] - a[0]), lon: a[1] + tt * (b[1] - a[1]) };
}

function toLatLon(raw) {
  return Array.isArray(raw) ? { lat: raw[0], lon: raw[1] } : { lat: raw.lat, lon: raw.lng };
}

function findNearestSegmentOnPolyline(point, latlngs) {
  if (!point || !Array.isArray(latlngs) || latlngs.length < 2) return null;
  let bestIndex = -1, bestPoint = null, bestDist = Infinity;
  for (let i = 0; i < latlngs.length - 1; i++) {
    const raw1 = latlngs[i], raw2 = latlngs[i + 1];
    const a = Array.isArray(raw1) ? raw1 : [raw1.lat, raw1.lng];
    const b = Array.isArray(raw2) ? raw2 : [raw2.lat, raw2.lng];
    if (!isValidLatLng(a[0], a[1]) || !isValidLatLng(b[0], b[1])) continue;
    const candidate = nearestPointOnSegment(point, a, b);
    const d = distMeters(point, candidate);
    if (d < bestDist) { bestDist = d; bestPoint = candidate; bestIndex = i; }
  }
  return bestIndex === -1 ? null : { index: bestIndex, point: bestPoint, dist: bestDist };
}

function nearestPointOnPolyline(point, latlngs) {
  const seg = findNearestSegmentOnPolyline(point, latlngs);
  return seg ? { lat: seg.point.lat, lon: seg.point.lon, dist: seg.dist } : null;
}

function distanceToPolylineMeters(point, latlngs) {
  const nearest = nearestPointOnPolyline(point, latlngs);
  return nearest ? nearest.dist : Infinity;
}

function pointAheadOnPolyline(point, latlngs, aheadMeters) {
  const seg = findNearestSegmentOnPolyline(point, latlngs);
  if (!seg) return null;

  let remaining = aheadMeters;
  let current = seg.point;
  for (let i = seg.index + 1; i < latlngs.length; i++) {
    const next = toLatLon(latlngs[i]);
    const segmentLength = distMeters(current, next);
    if (segmentLength >= remaining) {
      const frac = remaining / segmentLength;
      return { lat: current.lat + (next.lat - current.lat) * frac, lon: current.lon + (next.lon - current.lon) * frac };
    }
    remaining -= segmentLength;
    current = next;
  }
  return current; // route ends before we travel the full lookahead distance
}

function toast(msg, kind) {
  const container = document.getElementById('toastContainer');
  if (!container) { alert(msg); return; }
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' toast-' + kind : '');
  const iconGlyph = kind === 'error' ? '✕' : kind === 'success' ? '✓' : '';
  el.innerHTML = (iconGlyph ? `<span class="toast-icon">${iconGlyph}</span>` : '') +
                 `<span class="toast-msg"></span>`;
  el.querySelector('.toast-msg').textContent = msg;
  container.prepend(el);
  requestAnimationFrame(() => el.classList.add('toast-show'));
  setTimeout(() => {
    el.classList.remove('toast-show');
    setTimeout(() => el.remove(), 250);
  }, 2600);
}

let themedDialogResolver = null;
function closeThemedDialog(result) {
  const overlay = document.getElementById('themedDialogModal');
  if (overlay) overlay.style.display = 'none';
  closeOverlay('themedDialogModal');
  const resolve = themedDialogResolver;
  themedDialogResolver = null;
  if (resolve) resolve(result);
}
function renderThemedDialog(message, { okLabel, cancelLabel, showInput, inputValue } = {}) {
  const overlay = document.getElementById('themedDialogModal');
  const inner = document.getElementById('themedDialogModalInner');
  bringModalToFront(overlay);
  inner.innerHTML = `
    <p style="white-space:pre-wrap;">${escapeHtml(message || '')}</p>
    ${showInput ? `<input type="text" id="themedDialogInput" style="width:100%;box-sizing:border-box;margin-bottom:12px;" value="${escapeHtml(inputValue || '')}">` : ''}
    <div style="display:flex;gap:10px;">
      ${cancelLabel !== null ? `<button type="button" class="generic-modal-close" style="background:var(--bg-surface-alt);" onclick="closeThemedDialog(${showInput ? 'null' : 'false'})">${escapeHtml(cancelLabel || t('cancelLabelDefault'))}</button>` : ''}
      <button type="button" class="generic-modal-close" style="background:var(--accent);color:var(--accent-contrast);" id="themedDialogOkBtn">${escapeHtml(okLabel || 'OK')}</button>
    </div>`;
  overlay.style.display = 'flex';
  openOverlay('themedDialogModal', () => closeThemedDialog(showInput ? null : false));
  const okBtn = document.getElementById('themedDialogOkBtn');
  const inputEl = document.getElementById('themedDialogInput');
  if (inputEl) { inputEl.focus(); inputEl.select(); }
  okBtn.onclick = () => closeThemedDialog(showInput ? (inputEl ? inputEl.value : '') : true);
}
function themedConfirm(message, opts) {
  return new Promise(resolve => {
    themedDialogResolver = resolve;
    renderThemedDialog(message, { ...opts, showInput: false });
  });
}
function themedPrompt(message, defaultValue, opts) {
  return new Promise(resolve => {
    themedDialogResolver = resolve;
    renderThemedDialog(message, { ...opts, showInput: true, inputValue: defaultValue });
  });
}

let photoSourceResolver = null;
function closePhotoSourceModal(file) {
  const overlay = document.getElementById('photoSourceModal');
  if (overlay) overlay.style.display = 'none';
  closeOverlay('photoSourceModal');
  const resolve = photoSourceResolver;
  photoSourceResolver = null;
  if (resolve) resolve(file || null);
}
function pickReportPhotoSource() {
  return new Promise(resolve => {
    photoSourceResolver = resolve;
    const overlay = document.getElementById('photoSourceModal');
    const inner = document.getElementById('photoSourceModalInner');
    bringModalToFront(overlay);
    inner.innerHTML = `
      <h2>${escapeHtml(t('photoSourceTitle') || 'Add a photo')}</h2>
      <div style="display:flex; gap:10px;">
        <button type="button" class="settings-btn" style="flex:1;" id="photoSourceCameraBtn"><img class="icon-img icon-img-inline" src="icons/camera.png" alt="">${escapeHtml(t('reportPhotoAddBtn'))}</button>
        <button type="button" class="settings-btn" style="flex:1;" id="photoSourceGalleryBtn"><img class="icon-img icon-img-inline" src="icons/gallery.png" alt="">${escapeHtml(t('reportPhotoGalleryBtn'))}</button>
      </div>`;
    overlay.style.display = 'flex';
    openOverlay('photoSourceModal', () => closePhotoSourceModal(null));
    const cameraInput = document.getElementById('reportPhotoPickerCamera');
    const libraryInput = document.getElementById('reportPhotoPickerLibrary');
    const onPicked = (inputEl) => {
      const file = inputEl.files && inputEl.files[0];
      inputEl.value = '';
      closePhotoSourceModal(file);
    };
    cameraInput.onchange = () => onPicked(cameraInput);
    libraryInput.onchange = () => onPicked(libraryInput);
    document.getElementById('photoSourceCameraBtn').onclick = () => cameraInput.click();
    document.getElementById('photoSourceGalleryBtn').onclick = () => libraryInput.click();
  });
}

function pickReportPhotoDirect(source) {
  return new Promise(resolve => {
    const inputEl = document.getElementById(source === 'camera' ? 'reportPhotoPickerCamera' : 'reportPhotoPickerLibrary');
    if (!inputEl) { resolve(null); return; }
    const onPicked = () => {
      const file = inputEl.files && inputEl.files[0];
      inputEl.value = '';
      inputEl.onchange = null;
      resolve(file || null);
    };
    inputEl.onchange = onPicked;
    inputEl.click();
  });
}

let deleteReasonResolver = null;
function hideDeleteReasonOverlay() {
  const overlay = document.getElementById('deleteReasonModal');
  if (overlay) overlay.style.display = 'none';
  closeOverlay('deleteReasonModal');
}
function closeDeleteReasonModal(reason) {
  hideDeleteReasonOverlay();
  const resolve = deleteReasonResolver;
  deleteReasonResolver = null;
  if (resolve) resolve(reason || null);
}
const DELETE_REASONS = [
  { code:'accidental_nav',  labelKey:'deleteReasonAccidentalNav' },
  { code:'wrong_location',  labelKey:'deleteReasonWrongLocation' },
  { code:'duplicate',       labelKey:'deleteReasonDuplicate' },
  { code:'already_fixed',   labelKey:'deleteReasonAlreadyFixed' },
  { code:'not_real',        labelKey:'deleteReasonNotReal' },
  { code:'privacy',         labelKey:'deleteReasonPrivacy' },
  { code:'test_report',     labelKey:'deleteReasonTestReport' },
  { code:'other',           labelKey:'deleteReasonOther' }
];
// Asks the reporter why they're deleting their own report before doing so.
// Resolves to { code, text } on a chosen reason, or null if they cancel.
function pickDeleteReason() {
  return new Promise(resolve => {
    deleteReasonResolver = resolve;
    const overlay = document.getElementById('deleteReasonModal');
    const inner = document.getElementById('deleteReasonModalInner');
    bringModalToFront(overlay);
    inner.innerHTML = `
      <h2>${escapeHtml(t('deleteReasonTitle'))}</h2>
      <div style="display:flex; flex-direction:column; gap:8px;">
        ${DELETE_REASONS.map(r => `<button type="button" class="settings-btn" style="justify-content:flex-start;" data-reason-code="${r.code}">${escapeHtml(t(r.labelKey))}</button>`).join('')}
      </div>`;
    overlay.style.display = 'flex';
    openOverlay('deleteReasonModal', () => closeDeleteReasonModal(null));
    inner.querySelectorAll('[data-reason-code]').forEach(btn => {
      btn.onclick = async () => {
        const code = btn.getAttribute('data-reason-code');
        if (code === 'other') {
          deleteReasonResolver = null; // this picker resolves via the prompt below now, not via cancel/backdrop
          hideDeleteReasonOverlay();
          const text = await themedPrompt(t('deleteReasonOtherPrompt'), '');
          resolve(text === null ? null : { code, text: text || null });
        } else {
          closeDeleteReasonModal({ code, text: null });
        }
      };
    });
  });
}

const NavState = Object.freeze({
  IDLE:          'idle',
  SEARCHING:     'searching',
  CALCULATING:   'calculating',
  PREVIEW:       'preview',
  NAVIGATING:    'navigating',
  OFF_ROUTE:     'off_route',
  RECALCULATING: 'recalculating',
  ARRIVED:       'arrived',
  FINISHED:      'finished'
});

const NAV_TRANSITIONS = {
  [NavState.IDLE]:          [NavState.SEARCHING],
  [NavState.SEARCHING]:     [NavState.CALCULATING, NavState.IDLE],
  [NavState.CALCULATING]:   [NavState.PREVIEW, NavState.IDLE],
  [NavState.PREVIEW]:       [NavState.NAVIGATING, NavState.SEARCHING, NavState.IDLE],
  [NavState.NAVIGATING]:    [NavState.OFF_ROUTE, NavState.ARRIVED, NavState.IDLE],
  [NavState.OFF_ROUTE]:     [NavState.RECALCULATING, NavState.NAVIGATING, NavState.IDLE],
  [NavState.RECALCULATING]: [NavState.NAVIGATING, NavState.OFF_ROUTE, NavState.IDLE],
  [NavState.ARRIVED]:       [NavState.FINISHED, NavState.IDLE],
  [NavState.FINISHED]:      [NavState.IDLE]
};

let navState = NavState.IDLE;

function setNavState(next) {
  if (next === navState) return;
  const allowed = NAV_TRANSITIONS[navState] || [];
  if (!allowed.includes(next)) {
    console.warn(`Blocked invalid nav transition: ${navState} -> ${next}`);
    return;
  }
  const prev = navState;
  navState = next;
  onNavStateChange(prev, next);
}

function onNavStateChange(prev, next) {
  updateNavStatusText();

  const navCardVisible = (next !== NavState.IDLE && next !== NavState.SEARCHING);
  const navCard = document.getElementById('drivingNavCard');
  if (navCard) navCard.style.display = navCardVisible ? 'flex' : 'none';
  const navCloseBtn = document.getElementById('navigateClearBtn');
  if (navCloseBtn) navCloseBtn.style.display = navCardVisible ? 'flex' : 'none';
  document.body.classList.toggle('nav-card-open', navCardVisible);

  if (next === NavState.PREVIEW) {
    setNavState(NavState.NAVIGATING);
    return;
  }

  if (next === NavState.NAVIGATING) {
    setFollowMode(true);
    const from = userCoords || manualCoords;
    if (from) followMapTo(from.lat, from.lon);

    if (prev !== NavState.OFF_ROUTE && prev !== NavState.RECALCULATING) {
      if (drivenPathLine) { map.removeLayer(drivenPathLine); drivenPathLine = null; }
      drivenPathCoords = from ? [[from.lat, from.lon]] : [];
      drivenPathLastAt = from ? Date.now() : null;
      if (drivenPathCoords.length) {
        // Same color/weight/opacity as navigationLine (drawNavigationLine) so the
        // traveled and remaining halves of the route read as one continuous spline —
        // just with a dotted dash here to keep the breadcrumb trail visually distinct.
        drivenPathLine = L.polyline(drivenPathCoords, { color: 'var(--nav-route-color)', weight: 5, opacity: .9, dashArray: '1 10', lineCap: 'round' }).addTo(map);
      }
    }
  }

  if (next === NavState.ARRIVED) {
    toast(t('navigateArrived'), 'success');
    setTimeout(() => {
      setNavState(NavState.FINISHED);
      setNavState(NavState.IDLE);
      clearNavigation();
    }, 2500);
  }

  if (next === NavState.IDLE) {
    setFollowMode(false);
    cancelAutoRefollowTimer();
  }
}

function updateNavStatusText() {
  const el = document.getElementById('navigateStatusText');
  if (!el) return;
  const labels = {
    [NavState.CALCULATING]:   t('navCalculating'),
    [NavState.PREVIEW]:       t('navPreview'),
    [NavState.OFF_ROUTE]:     t('navOffRoute'),
    [NavState.RECALCULATING]: t('navRecalculating'),
    [NavState.ARRIVED]:       t('navigateArrived')
  };
  const text = labels[navState] || '';
  el.textContent = text;
  el.style.display = text ? 'block' : 'none';
}

function navArrivalRadiusM()          { return travelMode === 'bike' ? 20    : travelMode === 'foot' ? 15 : 25; }
function navOffRouteThresholdM()      { return travelMode === 'bike' ? 25    : travelMode === 'foot' ? 20 : 40; }
function navOnRouteRecoverThresholdM(){ return travelMode === 'bike' ? 15    : travelMode === 'foot' ? 12 : 25; }
let destinationCoords  = null;
let destinationMarker  = null;
let navigationLine     = null;
let drivenPathLine     = null;
let drivenPathCoords   = [];
const NAV_DRIVEN_PATH_MIN_DISTANCE_M = 8;

const NAV_DRIVEN_PATH_GAP_MS = 20000;
let drivenPathLastAt    = null;
let drivenPathGapFilling = false;
let navRouteSteps      = [];
let navStepIndex       = 0;
let navPanelOpen       = false;
let navRouteFetching   = false;
let navLastRouteAt     = 0;
let navLastRouteFrom   = null;

function navRerouteIntervalMs() { return travelMode === 'bike' ? 20000 : travelMode === 'foot' ? 12000 : 15000; }
function navRerouteDriftM()     { return travelMode === 'bike' ? 25    : travelMode === 'foot' ? 15 : 40; }

const OSRM_ROUTE_ENDPOINTS = {
  car:  'https://routing.openstreetmap.de/routed-car/route/v1/driving/',
  bike: 'https://routing.openstreetmap.de/routed-bike/route/v1/bike/',
  foot: 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/'
};
const OSRM_NEAREST_ENDPOINTS = {
  car:  'https://routing.openstreetmap.de/routed-car/nearest/v1/driving/',
  bike: 'https://routing.openstreetmap.de/routed-bike/nearest/v1/bike/',
  foot: 'https://routing.openstreetmap.de/routed-foot/nearest/v1/foot/'
};
function currentRouteEndpoint()  { return OSRM_ROUTE_ENDPOINTS[travelMode] || OSRM_ROUTE_ENDPOINTS.car; }
function currentSnapEndpoint()   { return OSRM_NEAREST_ENDPOINTS[travelMode] || OSRM_NEAREST_ENDPOINTS.car; }

function roadSnapMaxAcceptM() { return travelMode === 'bike' ? 20  : 30; }
function roadSideOffsetM()    { return travelMode === 'bike' ? 1.5 : 3; }
const ROAD_SNAP_MIN_INTERVAL_MS = 1200;
const ROAD_SNAP_FALLBACK_MS     = 1800;
let roadSnapFetching        = false;
let lastRoadSnapAt          = 0;
let roadSnapFallbackTimer   = null;

const DEST_SNAP_MAX_ACCEPT_M = 60;
async function snapToNearestRoad(lat, lon, maxAcceptM) {
  try {
    const res = await fetch(`${currentSnapEndpoint()}${lon},${lat}?number=1`);
    const data = await res.json();
    const wp = data && data.code === 'Ok' && data.waypoints && data.waypoints[0];
    if (!wp) return null;
    const snapped = { lat: wp.location[1], lon: wp.location[0] };
    return distMeters(snapped, { lat, lon }) <= maxAcceptM ? snapped : null;
  } catch (err) {
    return null;
  }
}

function showDrivingPosition(lat, lon, fixToken) {
  if (!userMarker) return;
  if (lastAcceptedFix && lastAcceptedFix.t !== fixToken) return;
  userMarker.setLatLng([lat, lon]);
  // While driving, markerAnimTick() recenters the map every animation frame using a
  // dead-reckoned position, so the viewport glides continuously instead of jumping once
  // per GPS/road-snap fix. Only pan directly here outside of that continuous loop.
  if (followMode && !drivingMode) followMapTo(lat, lon);
}

function snapUserToRoadThenShow(lat, lon) {
  const fixToken = lastAcceptedFix ? lastAcceptedFix.t : Date.now();

  if (roadSnapFallbackTimer) clearTimeout(roadSnapFallbackTimer);
  roadSnapFallbackTimer = setTimeout(() => {
    showDrivingPosition(lat, lon, fixToken);
  }, ROAD_SNAP_FALLBACK_MS);

  const now = Date.now();
  if (roadSnapFetching || now - lastRoadSnapAt < ROAD_SNAP_MIN_INTERVAL_MS) {
    return;
  }

  roadSnapFetching = true;
  lastRoadSnapAt = now;

  fetch(`${currentSnapEndpoint()}${lon},${lat}?number=1`)
    .then(res => res.json())
    .then(data => {
      const wp = data && data.code === 'Ok' && data.waypoints && data.waypoints[0];
      let snapped = wp ? { lat: wp.location[1], lon: wp.location[0] } : null;
      const useSnap = snapped && distMeters(snapped, { lat, lon }) <= roadSnapMaxAcceptM();
      if (useSnap) {
        if (typeof currentHeading === 'number' && !isNaN(currentHeading)) {
          const sideBearing = (currentHeading + 90) % 360;
          snapped = offsetLatLng(snapped.lat, snapped.lon, sideBearing, roadSideOffsetM());
        }
      }
      if (roadSnapFallbackTimer) clearTimeout(roadSnapFallbackTimer);
      showDrivingPosition(useSnap ? snapped.lat : lat, useSnap ? snapped.lon : lon, fixToken);
    })
    .catch(() => {
      if (roadSnapFallbackTimer) clearTimeout(roadSnapFallbackTimer);
      showDrivingPosition(lat, lon, fixToken);
    })
    .finally(() => { roadSnapFetching = false; });
}

function enterNavigationMode() {
  if (drivingMode) return;
  toggleDrivingMode(travelMode);
}

function toggleNavigatePanel() {
  navPanelOpen = !navPanelOpen;
  document.getElementById('navigatePanel').style.display = navPanelOpen ? 'flex' : 'none';
  document.body.classList.toggle('nav-panel-open', navPanelOpen);
  const sBtn = document.getElementById('drivingSearchBtn');
  if (sBtn) sBtn.classList.toggle('active', navPanelOpen);
  const mainNavBtn = document.getElementById('navigateModeBtn');
  if (mainNavBtn) mainNavBtn.classList.toggle('active', navPanelOpen);
  if (navPanelOpen) {
    setTimeout(() => document.getElementById('navigateSearchInput').focus(), 50);
    if (navState === NavState.IDLE) setNavState(NavState.SEARCHING);

    const navCloseBtn = document.getElementById('navigateClearBtn');
    if (navCloseBtn) navCloseBtn.style.display = 'none';
    openOverlay('navigatePanel', closeNavigatePanel);
  } else {
    if (navState === NavState.SEARCHING) setNavState(NavState.IDLE);
    restoreNavCloseBtnVisibility();
    closeOverlay('navigatePanel');
  }
}

function restoreNavCloseBtnVisibility() {
  const navCloseBtn = document.getElementById('navigateClearBtn');
  if (navCloseBtn && navState !== NavState.IDLE && navState !== NavState.SEARCHING) {
    navCloseBtn.style.display = 'flex';
  }
}

function closeNavigatePanel() {
  clearTimeout(navigateSearchDebounceTimer);
  navPanelOpen = false;
  document.getElementById('navigatePanel').style.display = 'none';
  document.body.classList.remove('nav-panel-open');
  const sBtn = document.getElementById('drivingSearchBtn');
  if (sBtn) sBtn.classList.remove('active');
  const mainNavBtn = document.getElementById('navigateModeBtn');
  if (mainNavBtn) mainNavBtn.classList.remove('active');
  navPinMode = false;
  const pinBtn = document.getElementById('navigatePinBtn');
  const pinHint = document.getElementById('navigatePinHint');
  if (pinBtn) pinBtn.classList.remove('active');
  if (pinHint) pinHint.style.display = 'none';
  restoreNavCloseBtnVisibility();
  closeOverlay('navigatePanel');
}

function toggleNavPinMode() {
  navPinMode = !navPinMode;
  const btn = document.getElementById('navigatePinBtn');
  const hint = document.getElementById('navigatePinHint');
  if (btn) btn.classList.toggle('active', navPinMode);
  if (hint) hint.style.display = navPinMode ? 'block' : 'none';
}

let navigateSearchDebounceTimer = null;
function handleNavigateSearchInput() {
  clearTimeout(navigateSearchDebounceTimer);
  const q = document.getElementById('navigateSearchInput').value.trim();
  if (!q) {
    document.getElementById('navigateResults').innerHTML = '';
    return;
  }
  navigateSearchDebounceTimer = setTimeout(searchDestination, 450);
}

async function searchDestination() {
  const input = document.getElementById('navigateSearchInput');
  const q = input.value.trim();
  if (!q) return;

  const resultsEl = document.getElementById('navigateResults');
  resultsEl.innerHTML = `<div class="navigate-result-empty">${t('navigateSearching')}</div>`;

  try {
    const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=5&q=' + encodeURIComponent(q);
    const res = await nominatimFetch(url, { headers: { 'Accept-Language': lang } });
    const data = await res.json();

    if (!data || !data.length) {
      resultsEl.innerHTML = `<div class="navigate-result-empty">${t('navigateNoResults')}</div>`;
      return;
    }

    const usable = data.filter(place => isValidLatLng(toFiniteNumber(place.lat), toFiniteNumber(place.lon)));
    if (!usable.length) {
      resultsEl.innerHTML = `<div class="navigate-result-empty">${t('navigateNoResults')}</div>`;
      return;
    }

    resultsEl.innerHTML = '';
    usable.forEach(place => {
      const item = document.createElement('div');
      item.className = 'navigate-result-item';
      item.textContent = place.display_name;
      item.onclick = () => selectDestination(parseFloat(place.lat), parseFloat(place.lon), place.display_name);
      resultsEl.appendChild(item);
    });
  } catch (err) {
    resultsEl.innerHTML = `<div class="navigate-result-empty">${t('navigateSearchFailed')}</div>`;
  }
}

async function selectDestination(lat, lon, label) {
  if (!isValidLatLng(lat, lon)) {
    console.error('Rejected destination with invalid coordinates:', lat, lon);
    toast(t('invalidLocation'), 'error');
    return;
  }
  if (!drivingMode) toggleDrivingMode('car');
  if (navState === NavState.IDLE) setNavState(NavState.SEARCHING);
  setNavState(NavState.CALCULATING);

  const snapped = travelMode === 'foot' ? null : await snapToNearestRoad(lat, lon, DEST_SNAP_MAX_ACCEPT_M);
  const destLat = snapped ? snapped.lat : lat;
  const destLon = snapped ? snapped.lon : lon;

  destinationCoords = { lat: destLat, lon: destLon, label };
  navLastRouteAt = 0;
  navLastRouteFrom = null;
  document.getElementById('navigateResults').innerHTML = '';
  document.getElementById('navigateSearchInput').value = '';
  document.getElementById('navigateDestText').textContent = label;
  document.getElementById('navigateActiveInfo').style.display = 'flex';
  closeNavigatePanel();

  if (destinationMarker) map.removeLayer(destinationMarker);
  destinationMarker = L.marker([destLat, destLon], {
    icon: L.divIcon({ className: '', html: buildDroppedPinHtml(), iconSize: [30, 36], iconAnchor: [15, 34] })
  }).addTo(map);

  const from = userCoords || manualCoords;
  if (!from) {
    toast(t('navigateNeedLocation'), 'error');
    map.setView([destLat, destLon], 14);
    return;
  }

  drawNavigationLine().then(() => {
    if (navigationLine) map.fitBounds(navigationLine.getBounds(), { padding: [60, 60] });
    if (navState === NavState.CALCULATING) setNavState(NavState.PREVIEW);
  });
}

async function fillDrivenPathGap(from, to) {
  if (drivenPathGapFilling || !drivenPathLine) return;
  drivenPathGapFilling = true;
  try {
    const route = await fetchRoute(from, to);

    route.coords.slice(1).forEach(coord => {
      drivenPathCoords.push(coord);
      drivenPathLine.addLatLng(coord);
    });
  } catch (err) {
    console.warn('Driven-path gap fill failed, drawing straight segment instead:', err.message);
    drivenPathCoords.push([to.lat, to.lon]);
    drivenPathLine.addLatLng([to.lat, to.lon]);
  } finally {
    drivenPathLastAt = Date.now();
    drivenPathGapFilling = false;
  }
}

async function fillSectionPathGap(from, to) {
  if (sectionGapFilling || !sectionPolyline) return;
  sectionGapFilling = true;
  try {
    const route = await fetchRoute(from, to);
    route.coords.slice(1).forEach(coord => {
      sectionPoints.push({ lat: coord[0], lon: coord[1] });
      sectionPolyline.addLatLng(coord);
    });
  } catch (err) {
    console.warn('Section-path gap fill failed, drawing straight segment instead:', err.message);
    sectionPoints.push({ lat: to.lat, lon: to.lon });
    sectionPolyline.addLatLng([to.lat, to.lon]);
  } finally {
    sectionLastAt = Date.now();
    sectionGapFilling = false;
  }
}

async function fetchRoute(from, to) {
  if (!isValidCoordObj(from) || !isValidCoordObj(to)) {
    throw new Error('invalid coordinates for routing');
  }
  const url = `${currentRouteEndpoint()}${from.lon},${from.lat};${to.lon},${to.lat}` +
              `?overview=full&geometries=geojson&steps=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`routing request failed (HTTP ${res.status})`);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes || !data.routes.length) {
    throw new Error(data.message || 'no route found');
  }
  const route = data.routes[0];
  const leg = route.legs && route.legs[0];
  return {
    coords: route.geometry.coordinates.map(([rlon, rlat]) => [rlat, rlon]),
    distance: route.distance,
    duration: route.duration,
    steps: buildTurnSteps(leg)
  };
}

function buildTurnSteps(leg) {
  if (!leg || !Array.isArray(leg.steps)) return [];
  return leg.steps.map(step => ({
    type: step.maneuver?.type || 'continue',
    modifier: step.maneuver?.modifier || null,
    exit: step.maneuver?.exit || null,
    name: step.name || '',
    location: step.maneuver?.location
      ? { lat: step.maneuver.location[1], lon: step.maneuver.location[0] }
      : null
  })).filter(s => s.location);
}

async function drawNavigationLine(force) {
  if (!destinationCoords) return;
  const from = userCoords || manualCoords;
  if (!from) return;

  const driftedFar = navLastRouteFrom && distMeters(from, navLastRouteFrom) >= navRerouteDriftM();
  const stale = Date.now() - navLastRouteAt >= navRerouteIntervalMs();
  const needsRoute = !navigationLine || driftedFar || stale || force;

  if (needsRoute && !navRouteFetching) {
    navRouteFetching = true;
    try {
      const route = await fetchRoute(from, destinationCoords);
      navLastRouteAt = Date.now();
      navLastRouteFrom = { lat: from.lat, lon: from.lon };

      if (navigationLine) map.removeLayer(navigationLine);
      navigationLine = L.polyline(route.coords, { color: 'var(--nav-route-color)', weight: 5, opacity: .9 }).addTo(map);
      navigationLine._isFallback = false;

      navRouteSteps = route.steps;
      navStepIndex = navRouteSteps.length > 1 ? 1 : 0;
      updateTurnByTurnDisplay(from);

      updateNavInfoText(route.distance, route.duration);
    } catch (err) {
      console.warn('Routing failed, falling back to straight line:', err.message);
      navLastRouteAt = Date.now();
      navLastRouteFrom = { lat: from.lat, lon: from.lon };
      const latlngs = [[from.lat, from.lon], [destinationCoords.lat, destinationCoords.lon]];
      if (navigationLine) map.removeLayer(navigationLine);
      navigationLine = L.polyline(latlngs, {
        color: 'var(--nav-route-color)', weight: 4, opacity: .85, dashArray: '8 8'
      }).addTo(map);
      navigationLine._isFallback = true;
      navRouteSteps = [];
      navStepIndex = 0;
      hideTurnByTurnDisplay();
      updateNavInfoText(distMeters(from, destinationCoords), null);
    } finally {
      navRouteFetching = false;
    }
  } else if (navigationLine && !navigationLine._isFallback) {
    const remaining = distMeters(from, destinationCoords);
    updateNavInfoText(remaining, null, true);
  } else if (navigationLine && navigationLine._isFallback) {
    navigationLine.setLatLngs([[from.lat, from.lon], [destinationCoords.lat, destinationCoords.lon]]);
    updateNavInfoText(distMeters(from, destinationCoords), null);
  }
}

// Cuts the already-driven portion off the front of navigationLine so the remaining
// blue line visibly shortens/disappears as the arrow moves along it, instead of the
// full origin-to-destination line sitting there unchanged until the next reroute.
// Called from the same position-update block that grows drivenPathLine, so the two
// lines meet at (approximately) the same point every time.
function trimNavigationLineBehindPosition(pos) {
  if (!navigationLine || navigationLine._isFallback || !pos) return;
  const latlngs = navigationLine.getLatLngs();
  if (!Array.isArray(latlngs) || latlngs.length < 2) return;
  const seg = findNearestSegmentOnPolyline(pos, latlngs);
  if (!seg || seg.index <= 0) return; // already at (or before) the first segment — nothing behind to drop
  const rest = latlngs.slice(seg.index + 1).map(ll => Array.isArray(ll) ? ll : [ll.lat, ll.lng]);
  const remaining = [[seg.point.lat, seg.point.lon], ...rest];
  if (remaining.length >= 2) navigationLine.setLatLngs(remaining);
}

function updateNavInfoText(meters, seconds, approximate) {
  const distEl = document.getElementById('navigateDistanceText');
  const timeEl = document.getElementById('navigateTimeText');
  const etaEl = document.getElementById('navigateEtaText');
  if (!distEl) return;
  distEl.textContent = (approximate ? '~' : '') + formatDistance(meters);

  if (seconds != null) {
    if (timeEl) timeEl.textContent = formatDuration(seconds);
    if (etaEl) {
      const arrival = new Date(Date.now() + seconds * 1000);
      etaEl.textContent = arrival.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }
  }
}

const NAV_BTN_PREF_KEY = 'ttb_show_nav_btn';
const HEATMAP_BTN_PREF_KEY = 'ttb_show_heatmap_btn';

function getBoolPref(key, defaultVal) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? defaultVal : v === '1';
  } catch (err) { return defaultVal; }
}
function setBoolPref(key, val) {
  try { localStorage.setItem(key, val ? '1' : '0'); } catch (err) {}
}
let showNavBtnPref = getBoolPref(NAV_BTN_PREF_KEY, false);
let showHeatmapBtnPref = getBoolPref(HEATMAP_BTN_PREF_KEY, false);

function setNavBtnVisible(enabled) {
  showNavBtnPref = !!enabled;
  setBoolPref(NAV_BTN_PREF_KEY, showNavBtnPref);
  const btn = document.getElementById('navigateModeBtn');
  if (btn) btn.style.display = showNavBtnPref ? 'flex' : 'none';
  if (!showNavBtnPref && typeof drivingMode !== 'undefined' && drivingMode) toggleDrivingMode();
}
function setHeatmapBtnVisible(enabled) {
  showHeatmapBtnPref = !!enabled;
  setBoolPref(HEATMAP_BTN_PREF_KEY, showHeatmapBtnPref);
  const btn = document.getElementById('heatmapBtn');
  if (btn) btn.style.display = showHeatmapBtnPref ? 'flex' : 'none';
  if (!showHeatmapBtnPref && typeof heatmapActive !== 'undefined' && heatmapActive) toggleHeatmap();
}
function initMapButtonToggleUi() {
  const navInput = document.getElementById('navBtnToggleInput');
  if (navInput) navInput.checked = showNavBtnPref;
  const heatInput = document.getElementById('heatmapBtnToggleInput');
  if (heatInput) heatInput.checked = showHeatmapBtnPref;
}

const SOUND_PREF_KEY = 'ttb_sound_enabled';
function getSoundEnabledPref() {
  try {
    const v = localStorage.getItem(SOUND_PREF_KEY);
    return v === null ? true : v === '1';
  } catch (err) { return true; }
}
let soundEnabled = getSoundEnabledPref();
let sharedAudioCtx = null;
function getAudioCtx() {
  if (!sharedAudioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    sharedAudioCtx = new Ctx();
  }
  if (sharedAudioCtx.state === 'suspended') sharedAudioCtx.resume().catch(() => {});
  return sharedAudioCtx;
}
function playTone(freq, durationMs, startDelayMs, gainLevel) {
  if (!soundEnabled) return;
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    const t0 = ctx.currentTime + (startDelayMs || 0) / 1000;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    const peak = gainLevel || 0.18;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + 0.02);
    gain.gain.linearRampToValueAtTime(0, t0 + durationMs / 1000);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + durationMs / 1000 + 0.02);
  } catch (err) {
    console.warn('playTone failed:', err.message);
  }
}
function setSoundEnabled(enabled) {
  soundEnabled = !!enabled;
  try { localStorage.setItem(SOUND_PREF_KEY, soundEnabled ? '1' : '0'); } catch (err) {}
  if (soundEnabled) getAudioCtx();
}
function playTurnUpcomingChime() {
  playTone(880, 110, 0, 0.16);
  playTone(1175, 130, 130, 0.16);
}
function playMissedTurnChime() {
  playTone(330, 180, 0, 0.2);
  playTone(262, 220, 190, 0.2);
}
function playNearbyReportChime() {
  playTone(660, 90, 0, 0.14);
  playTone(660, 90, 160, 0.14);
}
function playNotificationChime() {
  playTone(784, 100, 0, 0.16);
  playTone(988, 140, 120, 0.16);
}
function initSoundSettingsUi() {
  const input = document.getElementById('soundToggleInput');
  if (input) input.checked = soundEnabled;
}

const VOICE_NAV_PREF_KEY = 'ttb_voice_nav_enabled';
function getVoiceNavPref() {
  try {
    const v = localStorage.getItem(VOICE_NAV_PREF_KEY);
    return v === null ? false : v === '1';
  } catch (err) { return false; }
}
let voiceNavEnabled = getVoiceNavPref();
function setVoiceNavEnabled(enabled) {
  voiceNavEnabled = !!enabled;
  try { localStorage.setItem(VOICE_NAV_PREF_KEY, voiceNavEnabled ? '1' : '0'); } catch (err) {}
  if (!voiceNavEnabled) cancelVoiceNav();
}
function initVoiceNavSettingsUi() {
  const input = document.getElementById('voiceNavToggleInput');
  if (input) input.checked = voiceNavEnabled;
}
// Spoken turn-by-turn directions, layered on top of the existing chime/tone
// alerts rather than replacing them — this only fires when voiceNavEnabled
// is on, using the browser's built-in speech synthesis (no network request,
// no audio asset to ship). Reuses the same localized instruction phrases
// (t('turnLeft'), t('turnRight'), ...) the on-screen turn-by-turn card
// already shows, so English/Serbian stay in sync automatically.
function formatDistanceForSpeech(m) {
  if (!isFinite(m)) return '';
  if (m >= 1000) return (m / 1000).toFixed(1) + ' ' + t('voiceKilometers');
  return Math.round(m) + ' ' + t('voiceMeters');
}
function speakNavInstruction(text) {
  if (!voiceNavEnabled || !text) return;
  if (!('speechSynthesis' in window)) return;
  try {
    // Cancel rather than queue: if a new instruction is ready, any
    // still-speaking older one is stale and shouldn't talk over it.
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = isSerbianLang() ? 'sr-RS' : 'en-US';
    window.speechSynthesis.speak(utter);
  } catch (err) {
    console.warn('speakNavInstruction failed:', err.message);
  }
}
function cancelVoiceNav() {
  if (!('speechSynthesis' in window)) return;
  try { window.speechSynthesis.cancel(); } catch (err) {}
}

const DRIVING_SAFETY_REMINDER_KEY = 'ttb_driving_safety_reminder';
function getDrivingSafetyReminderPref() {
  try {
    const v = localStorage.getItem(DRIVING_SAFETY_REMINDER_KEY);
    return v === null ? true : v === '1';
  } catch (err) { return true; }
}
let drivingSafetyReminderEnabled = getDrivingSafetyReminderPref();
function setDrivingSafetyReminderEnabled(enabled) {
  drivingSafetyReminderEnabled = !!enabled;
  try { localStorage.setItem(DRIVING_SAFETY_REMINDER_KEY, drivingSafetyReminderEnabled ? '1' : '0'); } catch (err) {}
}
function initDrivingSafetySettingsUi() {
  const input = document.getElementById('drivingSafetyToggleInput');
  if (input) input.checked = drivingSafetyReminderEnabled;
}

const OVERSPEED_ALERT_PREF_KEY   = 'ttb_overspeed_alert_enabled';
const OVERSPEED_THRESHOLD_KMH    = 5;
const OVERSPEED_RESET_MARGIN_KMH = 3;
const OVERSPEED_ALERT_COOLDOWN_MS = 5000;

function getOverspeedAlertPref() {
  try {
    const v = localStorage.getItem(OVERSPEED_ALERT_PREF_KEY);
    return v === null ? true : v === '1';
  } catch (err) { return true; }
}
let overspeedAlertEnabled = getOverspeedAlertPref();
function setOverspeedAlertEnabled(enabled) {
  overspeedAlertEnabled = !!enabled;
  try { localStorage.setItem(OVERSPEED_ALERT_PREF_KEY, overspeedAlertEnabled ? '1' : '0'); } catch (err) {}
}
function initOverspeedAlertSettingsUi() {
  const input = document.getElementById('overspeedAlertToggleInput');
  if (input) input.checked = overspeedAlertEnabled;
}

const BUMP_DETECTION_PREF_KEY = 'ttb_bump_detection_enabled';
function getBumpDetectionPref() {
  try {
    const v = localStorage.getItem(BUMP_DETECTION_PREF_KEY);
    return v === null ? true : v === '1';
  } catch (err) { return true; }
}
let bumpDetectionEnabled = getBumpDetectionPref();
function setBumpDetectionEnabled(enabled) {
  bumpDetectionEnabled = !!enabled;
  try { localStorage.setItem(BUMP_DETECTION_PREF_KEY, bumpDetectionEnabled ? '1' : '0'); } catch (err) {}
  // requestMotionPermission() bails out early if bumpDetectionEnabled was
  // false, so turning the setting on while already mid-drive used to leave
  // detection silently off until the next toggleDrivingMode()/switchTravelMode()
  // call happened to re-request it. Kick it off right away instead.
  if (bumpDetectionEnabled && typeof drivingMode !== 'undefined' && drivingMode && travelMode !== 'foot') {
    requestMotionPermission();
  }
}
function initBumpDetectionSettingsUi() {
  const input = document.getElementById('bumpDetectionToggleInput');
  if (input) input.checked = bumpDetectionEnabled;
}

let currentSpeedLimitKmh  = null;
let overspeedArmed        = true;
let lastOverspeedAlertAt  = 0;

function checkOverspeed() {
  if (!isCarMode() || !overspeedAlertEnabled) return;
  if (currentSpeedLimitKmh === null || smoothedSpeedKmh === null) return;

  const over = smoothedSpeedKmh - currentSpeedLimitKmh;
  if (over < OVERSPEED_RESET_MARGIN_KMH) { overspeedArmed = true; return; }
  if (over < OVERSPEED_THRESHOLD_KMH) return;

  const now = Date.now();
  if (!overspeedArmed && (now - lastOverspeedAlertAt) < OVERSPEED_ALERT_COOLDOWN_MS) return;

  overspeedArmed = false;
  lastOverspeedAlertAt = now;
  triggerOverspeedAlert();
}

function triggerOverspeedAlert() {
  playOverspeedAlertSound();
  const capsule = document.getElementById('drivingSpeedCapsule');
  if (!capsule) return;
  capsule.classList.remove('overspeed-flash');
  void capsule.offsetWidth;

  capsule.classList.add('overspeed-flash');
  capsule.addEventListener('animationend', () => capsule.classList.remove('overspeed-flash'), { once: true });
}

function playOverspeedAlertSound() {
  playTone(880, 140, 0, 0.22);
  playTone(880, 140, 220, 0.22);
  playTone(880, 140, 440, 0.22);
}

function showDrivingSafetyModal() {
  const modal = document.getElementById('drivingSafetyModal');
  const inner = document.getElementById('drivingSafetyModalInner');
  if (!modal || !inner) return;
  const isBike = travelMode === 'bike';
  const icon  = isBike ? 'icons/bicycle.png' : 'icons/car.png';
  const title = isBike ? t('drivingSafetyBikeTitle') : t('drivingSafetyTitle');
  const body  = isBike ? t('drivingSafetyBikeBody')  : t('drivingSafetyBody');
  const ackLabel = isBike ? t('drivingSafetyBikeAckBtn') : t('drivingSafetyAckBtn');
  inner.innerHTML = `
    <div class="generic-modal-icon"><img class="icon-img icon-img-modal" src="${icon}" alt=""></div>
    <h2>${title}</h2>
    <p>${escapeHtml(body)}</p>
    <div style="display:flex;flex-direction:column;gap:var(--space-8);">
      <button type="button" style="background:var(--accent);color:white;border:none;border-radius:14px;padding:12px 20px;font-size:var(--fs-14);font-weight:var(--fw-semibold);cursor:pointer;min-height:44px;" onclick="hideDrivingSafetyModal()">${ackLabel}</button>
      <button type="button" class="settings-btn" style="background:transparent;box-shadow:none;" onclick="dismissDrivingSafetyModalPermanently()">${t('drivingSafetyDontShowAgain')}</button>
    </div>`;
  bringModalToFront(modal);
  modal.style.display = 'flex';
  openOverlay('drivingSafetyModal', hideDrivingSafetyModal);
}
function hideDrivingSafetyModal() {
  const modal = document.getElementById('drivingSafetyModal');
  if (modal) modal.style.display = 'none';
  closeOverlay('drivingSafetyModal');
}
function dismissDrivingSafetyModalPermanently() {
  setDrivingSafetyReminderEnabled(false);
  initDrivingSafetySettingsUi();
  hideDrivingSafetyModal();
}

const DRIVING_AUDIO_ALERT_COOLDOWN_MS = 10 * 60 * 1000;
const drivingAudioAlertedAt = new Map();
function maybeDrivingAudioAlert() {
  if (!drivingMode || !soundEnabled || !userCoords) return;
  const now = Date.now();
  for (const r of globalActiveData) {
    if (r.status === 'fixed' || !isValidLatLng(r.latitude, r.longitude)) continue;
    const dist = distMeters(userCoords, { lat: r.latitude, lon: r.longitude });
    if (dist > VOTE_PROXIMITY_MAX_M) continue;
    const last = drivingAudioAlertedAt.get(r.id) || 0;
    if (now - last < DRIVING_AUDIO_ALERT_COOLDOWN_MS) continue;
    drivingAudioAlertedAt.set(r.id, now);
    playNearbyReportChime();
    break;

  }
}

const TURN_ARRIVE_RADIUS_M = 25;

const TBT_LEAD_SECONDS = 10;
const TBT_MIN_POPIN_M  = 60;
const TBT_MAX_POPIN_M  = 500;
const TBT_FADE_MS      = 350;

function showTurnByTurnCard() {
  const card = document.getElementById('turnByTurnCard');
  if (!card) return;
  card.style.display = 'flex';
  requestAnimationFrame(() => card.classList.add('tbt-visible'));
}

function fadeOutTurnByTurnCard() {
  const card = document.getElementById('turnByTurnCard');
  if (card) card.classList.remove('tbt-visible');
}

const TURN_ICONS = {
  'sharp left':  'turn-sharp-left.png', 'left':  'turn-left.png', 'slight left':  'turn-slight-left.png',
  'sharp right': 'turn-sharp-right.png', 'right': 'turn-right.png', 'slight right': 'turn-slight-right.png',
  straight: 'turn-straight.png', uturn: 'turn-uturn.png'
};

function instructionForStep(step) {
  if (!step) return null;
  const { type, modifier, exit, name } = step;

  if (type === 'arrive') return { icon: 'turn-arrive.png', text: t('turnArrive'), isArrive: true };
  if (type === 'depart')  return null;

  if (type === 'roundabout' || type === 'rotary' || type === 'roundabout turn') {
    const label = exit ? `${t('turnRoundabout')}, ${t('turnExit')} ${exit}` : t('turnRoundabout');
    return { icon: 'turn-roundabout.png', text: name ? `${label} (${name})` : label };
  }

  let icon = 'turn-straight.png';
  let text = t('turnContinue');
  if (modifier && TURN_ICONS[modifier]) {
    icon = TURN_ICONS[modifier];
    const key = {
      'sharp left': 'turnSharpLeft', left: 'turnLeft', 'slight left': 'turnSlightLeft',
      'sharp right': 'turnSharpRight', right: 'turnRight', 'slight right': 'turnSlightRight',
      straight: 'turnStraight', uturn: 'turnUturn'
    }[modifier];
    text = t(key);
  } else if (type === 'merge')      { icon = 'turn-merge.png'; text = t('turnMerge'); }
  else if (type === 'fork')         { icon = 'turn-fork.png';  text = t('turnFork'); }
  else if (type === 'end of road')  { icon = 'turn-end-of-road.png'; text = t('turnEndOfRoad'); }
  else if (type === 'on ramp' || type === 'off ramp') { icon = 'turn-ramp.png'; text = t('turnRamp'); }

  return { icon, text: name ? `${text}, ${name}` : text };
}

let tbtChimePlayedForStep = -1;
function updateTurnByTurnDisplay(from) {
  const card = document.getElementById('turnByTurnCard');
  if (!card) return;
  if (!drivingMode) { hideTurnByTurnDisplay(); return; }
  if (!from || !navRouteSteps.length || navState === NavState.PREVIEW) { hideTurnByTurnDisplay(); return; }

  const prevStepIndex = navStepIndex;
  while (
    navStepIndex < navRouteSteps.length - 1 &&
    distMeters(from, navRouteSteps[navStepIndex].location) <= TURN_ARRIVE_RADIUS_M
  ) {
    navStepIndex++;
  }
  const justTookTurn = navStepIndex !== prevStepIndex;
  if (justTookTurn) fadeOutTurnByTurnCard();

  const step = navRouteSteps[navStepIndex];
  const info = instructionForStep(step);
  if (!info) { hideTurnByTurnDisplay(); return; }

  if (justTookTurn) tbtChimePlayedForStep = -1;

  const distToTurn = distMeters(from, step.location);
  document.getElementById('turnByTurnIcon').src = 'icons/' + info.icon;
  document.getElementById('turnByTurnText').textContent = info.text;
  document.getElementById('turnByTurnDist').textContent = formatDistance(distToTurn);

  const speedMps = (smoothedSpeedKmh || 0) / 3.6;
  const popInDistanceM = Math.min(TBT_MAX_POPIN_M, Math.max(TBT_MIN_POPIN_M, speedMps * TBT_LEAD_SECONDS));

  if (distToTurn <= popInDistanceM) {
    showTurnByTurnCard();
    if (tbtChimePlayedForStep !== navStepIndex) {
      tbtChimePlayedForStep = navStepIndex;
      playTurnUpcomingChime();
      const spokenText = info.isArrive
        ? info.text
        : t('voiceLeadIn').replace('{dist}', formatDistanceForSpeech(distToTurn)) + info.text;
      speakNavInstruction(spokenText);
    }
  } else if (!justTookTurn) {
  }
}

function hideTurnByTurnDisplay() {
  const card = document.getElementById('turnByTurnCard');
  if (!card) return;
  card.classList.remove('tbt-visible');
  setTimeout(() => {
    if (!card.classList.contains('tbt-visible')) card.style.display = 'none';
  }, TBT_FADE_MS);
}

(function observeDrivingSheetHeight() {
  const sheet = document.getElementById('drivingReportSheet');
  if (!sheet || typeof ResizeObserver === 'undefined') return;
  const sync = () => document.documentElement.style.setProperty('--driving-sheet-height', sheet.offsetHeight + 'px');
  new ResizeObserver(sync).observe(sheet);
  sync();
})();

(function observeDrivingActionRowHeight() {
  const row = document.getElementById('drivingFloatActionRow');
  if (!row || typeof ResizeObserver === 'undefined') return;
  const sync = () => document.documentElement.style.setProperty('--driving-action-row-h', row.offsetHeight + 'px');
  new ResizeObserver(sync).observe(row);
  sync();
})();

function evaluateNavigationProgress() {
  if (!destinationCoords) return;
  if (![NavState.NAVIGATING, NavState.OFF_ROUTE, NavState.RECALCULATING].includes(navState)) return;

  const from = userCoords || manualCoords;
  if (!from) return;

  const distToDest = distMeters(from, destinationCoords);
  if (distToDest <= navArrivalRadiusM()) {
    setNavState(NavState.ARRIVED);
    return;
  }

  if (!navigationLine || navigationLine._isFallback) return;

  const offRouteDist = distanceToPolylineMeters(from, navigationLine.getLatLngs());
  const currentlyOffRoute = navState === NavState.OFF_ROUTE || navState === NavState.RECALCULATING;
  const threshold = currentlyOffRoute ? navOnRouteRecoverThresholdM() : navOffRouteThresholdM();
  const isOffRoute = offRouteDist > threshold;

  if (isOffRoute && navState === NavState.NAVIGATING) {
    setNavState(NavState.OFF_ROUTE);
    playMissedTurnChime();
  }

  if (isOffRoute && navState === NavState.OFF_ROUTE && !navRouteFetching) {
    setNavState(NavState.RECALCULATING);
    drawNavigationLine(true).then(() => {
      if (navState === NavState.RECALCULATING) setNavState(NavState.NAVIGATING);
    });
  }

  if (!isOffRoute && navState === NavState.OFF_ROUTE) {
    setNavState(NavState.NAVIGATING);
  }
}

function formatDistance(m) {
  if (!isFinite(m)) return '';
  return m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m';
}

function formatDuration(s) {
  if (!isFinite(s)) return '';
  const mins = Math.round(s / 60);
  if (mins < 60) return mins + ' min';
  return Math.floor(mins / 60) + ' h ' + (mins % 60) + ' min';
}

function clearNavigation() {
  cancelVoiceNav();
  destinationCoords = null;
  navLastRouteAt = 0;
  navLastRouteFrom = null;
  navRouteSteps = [];
  navStepIndex = 0;
  hideTurnByTurnDisplay();
  if (navigationLine)    { map.removeLayer(navigationLine); navigationLine = null; }
  if (drivenPathLine)    { map.removeLayer(drivenPathLine); drivenPathLine = null; }
  drivenPathCoords = [];
  if (destinationMarker) { map.removeLayer(destinationMarker); destinationMarker = null; }
  document.getElementById('navigateActiveInfo').style.display = 'none';
  document.getElementById('navigateDestText').textContent = '';
  document.getElementById('navigateSearchInput').value = '';
  document.getElementById('navigateResults').innerHTML = '';
  setNavState(NavState.IDLE);
}

function closeNavigationAndExit() {
  clearNavigation();
  if (typeof drivingMode !== 'undefined' && drivingMode) toggleDrivingMode();
}

function setFollowMode(enabled) {
  followMode = enabled;
  const btn = document.getElementById('drivingCenterBtn');
  if (btn) { btn.classList.toggle('active', enabled); btn.setAttribute('aria-pressed', String(enabled)); }
  const generalBtn = document.getElementById('followLocationBtn');
  if (generalBtn) { generalBtn.classList.toggle('active', enabled); generalBtn.setAttribute('aria-pressed', String(enabled)); }
}

function toggleFollowMode() {
  setFollowMode(!followMode);
  if (followMode && userCoords) {
    followMapTo(userCoords.lat, userCoords.lon);
    cancelAutoRefollowTimer();
  }
}

// Auto re-follow: once the map has been idle (no active gesture, and no
// overlay covering it) for AUTO_REFOLLOW_DELAY_MS, follow mode quietly turns
// itself back on and recenters on the user. Every gesture-end call site
// below (pan fling settling, drag/rotate ending, etc.) already calls
// scheduleAutoRefollow(), and every gesture-start / openOverlay call site
// already calls cancelAutoRefollowTimer() — so opening anything on top of
// the map, or touching the map again, always restarts the full 10s from
// scratch rather than resuming a partial countdown.
const AUTO_REFOLLOW_DELAY_MS = 10000;
let autoRefollowTimerId = null;

function cancelAutoRefollowTimer() {
  if (autoRefollowTimerId) { clearTimeout(autoRefollowTimerId); autoRefollowTimerId = null; }
}

function scheduleAutoRefollow() {
  cancelAutoRefollowTimer();
  if (followMode) return; // already following — nothing to re-enable
  autoRefollowTimerId = setTimeout(performAutoRefollow, AUTO_REFOLLOW_DELAY_MS);
}

// Previously this snapped the map back onto the GPS position ~10s after any
// manual pan or zoom, but always forced the zoom back up to at least 16/17
// (via followMapTo) even if you'd deliberately zoomed out to look around —
// that forced re-zoom on top of an unrequested snap-back was what made the
// old timer feel broken, not the timer itself. This version recenters at
// whatever zoom the map is already at, and leaves the zoom-forcing behavior
// to the explicit follow button tap (toggleFollowMode -> followMapTo).
function performAutoRefollow() {
  autoRefollowTimerId = null;
  if (followMode || !userCoords || overlayStack.length > 0) return;
  setFollowMode(true);
  map.setView([userCoords.lat, userCoords.lon], map.getZoom(), { animate: true });
}

function onUserMapInteractionStart() {
  cancelAutoRefollowTimer();
  if (followMode) {
    setFollowMode(false);
  }
}

map.on('dragstart', onUserMapInteractionStart);
map.on('zoomstart', onUserMapInteractionStart);


let customDragActive = false;
let customDragLast   = null;
let customDragPointerId = null;
let customDragSamples = [];
const activeTouchPointerIds = new Set();

// --- Momentum ("fling") for manually-driven panning ---
// Leaflet's own single-finger drag already glides to a stop on release (its
// default inertia option) — but that only covers Leaflet's native handler.
// Our manual two-finger pan (needed for rotation-correction + twist-to-
// rotate, see below) and our manual single-finger drag while rotated both
// bypass Leaflet's dragging entirely, so neither got that glide before.
// This reimplements the same idea: sample recent positions, and on release
// keep panning at the last measured velocity, decaying it every frame.
let panFlingRAF = null;
const PAN_VELOCITY_SAMPLE_MS   = 80;    // rolling window used to measure release velocity
const PAN_FLING_DECAY_PER_MS   = 0.998; // velocity multiplier applied per elapsed ms while coasting
const PAN_FLING_MIN_SPEED      = 0.04;  // px/ms below which we just stop rather than crawl forever
// If the finger-to-finger distance changed by more than this much (as a
// log2 ratio) over the velocity sample window, the release was still
// actively pinching, not panning. Natural asymmetric finger motion while
// scaling makes the midpoint drift a little even when the user has no
// intention of panning at all — without this check, that drift got read as
// swipe velocity and the map kept gliding for a moment right after every
// pinch-zoom.
const FLING_SUPPRESS_ZOOM_RATIO = 0.06;

// Manual rotated panning/fling drives the map with map.panBy() directly.
// Unlike Leaflet's own drag handler, panBy() has no idea about
// maxBoundsViscosity — the map only gets pulled back onto WORLD_BOUNDS
// reactively, on 'moveend', once the gesture is already over. That let a
// rotated drag or fling sail well past the edge of the world map and then
// snap back hard the instant you released. clampPanToBounds() calls the
// same private _limitCenter() Leaflet's own dragging uses internally,
// right after every manual panBy, so the map hard-stops at the edge (to
// match maxBoundsViscosity:1.0) instead of overshooting and correcting
// after the fact. Returns true when clamping actually kicked in (i.e. the
// map is sitting right at a world edge), so the fling loop below can stop
// coasting there instead of continuing to push into the boundary.
function clampPanToBounds() {
  const bounds = map.options.maxBounds;
  if (!bounds) return false;
  const center = map.getCenter();
  const limited = map._limitCenter(center, map.getZoom(), bounds);
  if (limited.lat !== center.lat || limited.lng !== center.lng) {
    map.panTo(limited, { animate: false });
    return true;
  }
  return false;
}

function cancelPanFling() {
  if (panFlingRAF) { cancelAnimationFrame(panFlingRAF); panFlingRAF = null; }
}

function startPanFlingFromSamples(samples) {
  if (!samples || samples.length < 2) return;
  const first = samples[0], last = samples[samples.length - 1];
  const dt = last.t - first.t;
  if (dt <= 0) return;
  if (first.d && last.d) {
    const zoomRatio = Math.abs(Math.log2(last.d / first.d));
    if (zoomRatio > FLING_SUPPRESS_ZOOM_RATIO) return;
  }
  let vx = (last.x - first.x) / dt;
  let vy = (last.y - first.y) / dt;
  if (Math.hypot(vx, vy) < PAN_FLING_MIN_SPEED) return;

  cancelPanFling();
  let lastTs = null;
  function step(ts) {
    if (lastTs == null) { lastTs = ts; panFlingRAF = requestAnimationFrame(step); return; }
    const dtFrame = ts - lastTs;
    lastTs = ts;
    const decay = Math.pow(PAN_FLING_DECAY_PER_MS, dtFrame);
    vx *= decay; vy *= decay;
    const d = unrotateDelta(vx * dtFrame, vy * dtFrame);
    map.panBy([-d.dx, -d.dy], { animate: false });
    const hitBound = clampPanToBounds();
    if (!hitBound && Math.hypot(vx, vy) >= PAN_FLING_MIN_SPEED) {
      panFlingRAF = requestAnimationFrame(step);
    } else {
      panFlingRAF = null;
      scheduleAutoRefollow();
    }
  }
  panFlingRAF = requestAnimationFrame(step);
}


function rotationActive() {

  return Math.abs(((mapBearing % 360) + 360) % 360) > ROTATION_EPSILON_DEG;
}

function setNativeDraggingEnabled(enabled) {
  if (!map.dragging) return;
  // Pinch-zoom is native Leaflet touchZoom, and two-finger rotate is a
  // separate touchstart/touchmove listener (see initTwoFingerRotate) that
  // doesn't touch Leaflet's dragging state at all. What's toggled here is
  // just single-finger dragging: native while north-up, switching to the
  // manual, rotation-corrected path below while the map is rotated (native
  // single-finger dragging has no idea the map is visually rotated via CSS
  // on rotWrapper, so it drags in the wrong direction once rotated).
  if (enabled) {
    if (!map.dragging.enabled()) map.dragging.enable();
    map.getContainer().style.touchAction = '';
  } else {
    if (map.dragging.enabled()) map.dragging.disable();
    map.getContainer().style.touchAction = 'none';
  }
}

// Same problem as native dragging/touchZoom above, but for scroll-wheel and
// double-click zoom: Leaflet anchors both around a container point taken
// straight from the mouse event, with no idea the map is visually rotated
// via CSS on rotWrapper. Once rotated, that anchor point is off — scrolling
// or double-clicking near an edge of the map visibly yanks the map sideways
// as it zooms ("tripping"), because Leaflet is zooming around the point as
// if the map were still north-up. We disable Leaflet's own handlers while
// rotated and drive rotation-corrected equivalents ourselves below
// (onRotatedWheelZoom / onRotatedDblClickZoom).
function setNativeZoomEnabled(enabled) {
  if (map.doubleClickZoom) {
    if (enabled) { if (!map.doubleClickZoom.enabled()) map.doubleClickZoom.enable(); }
    else if (map.doubleClickZoom.enabled()) map.doubleClickZoom.disable();
  }
  if (map.scrollWheelZoom) {
    if (enabled) { if (!map.scrollWheelZoom.enabled()) map.scrollWheelZoom.enable(); }
    else if (map.scrollWheelZoom.enabled()) map.scrollWheelZoom.disable();
  }
}

function customDragPointerDown(e) {
  if (e.pointerType === 'touch') {
    // Defensive: e.isPrimary means this is a genuinely fresh contact (no
    // other touch of this type is already active). If a prior gesture's
    // pointerup/pointercancel was ever missed (e.g. a two-finger rotate
    // that ended in a way that didn't clean up every id), a stale entry
    // could sit in this set forever, making every future single-finger
    // drag look like "multi-touch" below and get silently ignored — which
    // is exactly a total, hard-to-reproduce "drag doesn't work" failure.
    // A fresh primary contact means there is nothing left to track from
    // before, so it's always safe to clear here.
    if (e.isPrimary) activeTouchPointerIds.clear();
    activeTouchPointerIds.add(e.pointerId);
    // A second finger just touched down — this is now a multi-touch gesture,
    // hand it off entirely to the two-finger handler below and stop any
    // single-finger drag in progress so the two systems don't fight.
    if (activeTouchPointerIds.size > 1) {
      customDragActive = false;
      customDragLast = null;
      customDragPointerId = null;
      return;
    }
  }
  if (!rotationActive()) return;
  cancelPanFling();
  customDragActive = true;
  customDragPointerId = e.pointerId;
  customDragLast = { x: e.clientX, y: e.clientY };
  customDragSamples = [{ t: performance.now(), x: e.clientX, y: e.clientY }];
  // Claims all subsequent pointer events for this pointerId regardless of
  // what DOM element ends up under the finger as it moves (a marker, a
  // cluster icon, a popup, tile boundaries) — without this, the browser is
  // free to re-target/hand the gesture to whatever's underneath, which can
  // silently starve customDragPointerMove of events partway through a drag.
  if (e.pointerId != null && map.getContainer().setPointerCapture) {
    try { map.getContainer().setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  }

  onUserMapInteractionStart();
}

function customDragPointerMove(e) {
  if (e.pointerType === 'touch' && activeTouchPointerIds.size > 1) return;
  if (!customDragActive) return;
  if (customDragPointerId != null && e.pointerId !== customDragPointerId) return;
  const dx = e.clientX - customDragLast.x;
  const dy = e.clientY - customDragLast.y;
  customDragLast = { x: e.clientX, y: e.clientY };
  const rad = (-mapBearing * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const mapDx = dx * cos - dy * sin;
  const mapDy = dx * sin + dy * cos;
  map.panBy([-mapDx, -mapDy], { animate: false });
  clampPanToBounds();

  const now = performance.now();
  customDragSamples.push({ t: now, x: e.clientX, y: e.clientY });
  while (customDragSamples.length > 1 && now - customDragSamples[0].t > PAN_VELOCITY_SAMPLE_MS) customDragSamples.shift();
}

function customDragPointerUp(e) {
  if (e && e.pointerType === 'touch') activeTouchPointerIds.delete(e.pointerId);
  // A different finger than the one actually driving the drag lifted (e.g. a
  // stray extra touch) — the drag itself is still live, don't stop it.
  if (e && customDragPointerId != null && e.pointerId !== customDragPointerId) return;
  if (e && e.pointerId != null) {
    const container = map.getContainer();
    if (container.hasPointerCapture && container.hasPointerCapture(e.pointerId)) {
      try { container.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }
  }
  customDragActive = false;
  customDragLast = null;
  customDragPointerId = null;
  // customDragSamples only grows on pointermove, so if the finger slows to a
  // stop and is held briefly before lifting, the newest sample can be stale
  // by tens/hundreds of ms — startPanFlingFromSamples would then measure
  // velocity from before the stop and glide the map as if released while
  // still moving fast. Record one more sample at the actual release moment
  // so a deliberate stop-then-lift correctly reads as near-zero velocity.
  // pointercancel is skipped entirely: its coordinates aren't meaningful and
  // an interrupted gesture shouldn't fling at all.
  const isCancel = e && e.type === 'pointercancel';
  if (!isCancel && e && typeof e.clientX === 'number') {
    const now = performance.now();
    customDragSamples.push({ t: now, x: e.clientX, y: e.clientY });
    while (customDragSamples.length > 1 && now - customDragSamples[0].t > PAN_VELOCITY_SAMPLE_MS) customDragSamples.shift();
  }
  if (!isCancel) startPanFlingFromSamples(customDragSamples);
  customDragSamples = [];
  // Restores Leaflet's native single-finger dragging once nothing manual
  // is driving the map anymore (north-up state). While rotated this is a
  // no-op (native dragging stays off, as before) — this only fixes the
  // case introduced by the two-finger-rotate handoff (see
  // beginSingleFingerContinuation) where a north-up manual drag session
  // needs to hand control back to Leaflet when it ends.
  setNativeDraggingEnabled(!rotationActive());
  scheduleAutoRefollow();
}

(function initRotationAwareDragging(){
  const el = map.getContainer();
  el.addEventListener('pointerdown', customDragPointerDown, { passive: true });
  el.addEventListener('pointermove', customDragPointerMove, { passive: true });
  window.addEventListener('pointerup', customDragPointerUp, { passive: true });
  window.addEventListener('pointercancel', customDragPointerUp, { passive: true });
})();


// Rotation-corrected double-click zoom. Only acts while rotated — Leaflet's
// own doubleClickZoom handler is disabled for that case (setNativeZoomEnabled
// above) and re-enabled the instant the map is north-up again, so this is a
// pure stand-in rather than a full replacement.
function onRotatedDblClick(e) {
  if (!rotationActive()) return;
  L.DomEvent.stop(e);
  const rawPoint = map.mouseEventToContainerPoint(e);
  const correctedPoint = unrotateContainerPoint(rawPoint);
  const oldZoom = map.getZoom();
  const delta = map.options.zoomDelta || 1;
  const targetZoom = e.shiftKey ? oldZoom - delta : oldZoom + delta;
  map.setZoomAround(correctedPoint, targetZoom);
}

// Rotation-corrected scroll-wheel zoom. Same idea as the pinch handling
// above: debounce a burst of wheel ticks into one committed zoom step so a
// fast scroll doesn't force a full instant re-render (choppy) on every
// single tick, and rotation-correct the anchor point so the zoom stays
// under the cursor instead of drifting once the map is rotated.
let rotatedWheelAccum = 0;
let rotatedWheelPoint = null;
let rotatedWheelTimer = null;
const ROTATED_WHEEL_DEBOUNCE_MS = 60;
function commitRotatedWheelZoom() {
  rotatedWheelTimer = null;
  const point = rotatedWheelPoint;
  const accum = rotatedWheelAccum;
  rotatedWheelPoint = null;
  rotatedWheelAccum = 0;
  if (!point || !accum) return;
  const targetZoom = Math.min(map.getMaxZoom(), Math.max(map.getMinZoom(), map.getZoom() + accum));
  map.setZoomAround(point, targetZoom);
}
function onRotatedWheelZoom(e) {
  if (!rotationActive()) return;
  e.preventDefault();
  // Every raw tick counts as zoom activity, not just the ticks that happen to
  // cross a full committed 0.25 step below — this is what keeps pins/reports
  // hidden continuously for a real-world scroll session made of many small,
  // irregularly-spaced wheel notches, instead of gapping open between commits
  // (see the big comment above map.on('zoomstart', ...) for why this matters
  // specifically while rotated).
  noteZoomActivity(true);
  const rawPoint = map.mouseEventToContainerPoint(e);
  // Re-derive the anchor point every tick (not just on the first one of a
  // burst) so a scroll that drifts across the map while rotated still zooms
  // toward wherever the cursor currently is, matching native scroll-zoom feel.
  rotatedWheelPoint = unrotateContainerPoint(rawPoint);
  const step = map.options.zoomDelta || 0.25;
  rotatedWheelAccum += (e.deltaY > 0 ? -step : step);
  if (rotatedWheelTimer) clearTimeout(rotatedWheelTimer);
  rotatedWheelTimer = setTimeout(commitRotatedWheelZoom, ROTATED_WHEEL_DEBOUNCE_MS);
}
(function initRotationAwareZoom(){
  const el = map.getContainer();
  el.addEventListener('dblclick', onRotatedDblClick);
  el.addEventListener('wheel', onRotatedWheelZoom, { passive: false });
})();

// =====================================================================
// Shared rotation-math helpers. Used by the rotated scroll-wheel/
// double-click zoom handlers above (Leaflet's own handlers assume the
// map is never visually rotated, so those are hand-rolled equivalents),
// by the two-finger rotate gesture below, and by the rotated single-
// finger pan fling.

function getContainerCenter() {
  // map.getSize() returns Leaflet's cached container size (no DOM read),
  // safe to call from hot paths.
  const s = map.getSize();
  return { x: s.x / 2, y: s.y / 2 };
}

function rotateVec(x, y, deg) {
  const rad = deg * Math.PI / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  return { x: x * c - y * s, y: x * s + y * c };
}

// Converts a screen/container point into the "local" (north-up,
// pre-CSS-rotation) container point Leaflet's own coordinate math
// expects — Leaflet has no idea rotWrapper is visually rotated via CSS.
// Used both by the pre-existing rotated wheel/dblclick handlers above
// and by the pinch gesture below. bearingDeg defaults to the map's
// current bearing; the pinch commit passes the gesture's *final*
// bearing explicitly since mapBearing hasn't been updated yet at that
// point.
function unrotateContainerPoint(pt, bearingDeg) {
  const b = bearingDeg == null ? mapBearing : bearingDeg;
  const O = getContainerCenter();
  const v = rotateVec(pt.x - O.x, pt.y - O.y, -b);
  return L.point(O.x + v.x, O.y + v.y);
}

function unrotateDelta(dx, dy) {
  const v = rotateVec(dx, dy, -mapBearing);
  return { dx: v.x, dy: v.y };
}

// --- Gesture state -----------------------------------------------------
// Pinch-to-zoom itself is native Leaflet touchZoom now (see
// initTwoFingerRotate below for the rotate layer on top of it).

// --- Two-finger rotate gesture (coexists with Leaflet's native pinch-zoom) ---
// Pinch-to-zoom is handled entirely by Leaflet's own native touchZoom now —
// it's well-tested, it keeps markers/tiles perfectly in sync throughout the
// zoom (they share the same CSS transform during Leaflet's built-in zoom
// animation), and it already has its own graceful "scale what's already
// loaded while new tiles load in" behavior, so there's no separate
// tile-loading gap to paper over on top of it. All that's layered on top
// here is rotation: a two-finger twist gesture running alongside it. A
// pinch naturally introduces a little unintended finger-angle drift, which
// is enough to fool a naive angle threshold into rotating when the user
// only meant to zoom — so we decide, once per gesture, whether it's a
// "rotate" or a "zoom" gesture (whichever signal, angle change or distance
// change, crosses its threshold first) and lock into that interpretation
// for the rest of the touch, so one can't drift into the other partway
// through.
let twoFingerRotateActive       = false;
let twoFingerRotateStartAngle   = 0;
let twoFingerRotateStartBearing = 0;
let twoFingerStartDistance      = 0;
let twoFingerGestureLock        = null; // null | 'rotate' | 'zoom'
const TWO_FINGER_ROTATE_DEADZONE_DEG = 8;
const TWO_FINGER_ZOOM_LOCK_RATIO     = 0.06; // 6% pinch-distance change locks in "zoom" first

function angleBetweenTouches(t0, t1) {
  return Math.atan2(t1.clientY - t0.clientY, t1.clientX - t0.clientX) * 180 / Math.PI;
}
function distanceBetweenTouches(t0, t1) {
  return Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
}

function disableAutoHeadingForManualRotation() {
  if (drivingMode) {
    if (headingUpMode) {
      headingUpMode = false;
      const btn = document.getElementById('mapCompass');
      if (btn) btn.classList.add('heading-up-disabled');
    }
  } else if (walkingHeadingMode) {
    walkingHeadingMode = false;
    const btn = document.getElementById('mainMapCompass');
    if (btn) btn.classList.add('heading-up-disabled');
  }
}

// When one finger of a two-finger rotate lifts and one remains down, keep
// panning with it rather than dropping into a dead zone until it's lifted
// and pressed again — hands the now-solo touch over to the app's existing
// manual single-finger drag machinery (see customDragPointerDown/Move/Up
// above), which works correctly at any bearing. pointerId is null here
// because touch events (Touch.identifier) and Pointer events
// (PointerEvent.pointerId) aren't guaranteed to correlate — customDrag
// treats a null id as "accept whichever pointer moves next", which is
// unambiguous since only the one continuing finger is still down.
function beginSingleFingerContinuation(pointerId, point) {
  activeTouchPointerIds.clear();
  activeTouchPointerIds.add(pointerId);
  cancelPanFling();
  customDragActive = true;
  customDragPointerId = pointerId;
  customDragLast = { x: point.clientX, y: point.clientY };
  customDragSamples = [{ t: performance.now(), x: point.clientX, y: point.clientY }];
}

function onMapTouchStart(e) {
  if (e.touches.length === 2) {
    twoFingerRotateActive = true;
    twoFingerGestureLock = null;
    twoFingerRotateStartAngle = angleBetweenTouches(e.touches[0], e.touches[1]);
    twoFingerRotateStartBearing = mapBearing;
    twoFingerStartDistance = distanceBetweenTouches(e.touches[0], e.touches[1]);
    onUserMapInteractionStart();
  }
}
function onMapTouchMove(e) {
  if (!twoFingerRotateActive || e.touches.length !== 2) return;
  const angle = angleBetweenTouches(e.touches[0], e.touches[1]);
  let delta = angle - twoFingerRotateStartAngle;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;

  const distance = distanceBetweenTouches(e.touches[0], e.touches[1]);
  const distanceRatio = twoFingerStartDistance > 0
    ? Math.abs(distance - twoFingerStartDistance) / twoFingerStartDistance
    : 0;

  if (twoFingerGestureLock === null) {
    if (Math.abs(delta) >= TWO_FINGER_ROTATE_DEADZONE_DEG) {
      twoFingerGestureLock = 'rotate';
    } else if (distanceRatio >= TWO_FINGER_ZOOM_LOCK_RATIO) {
      twoFingerGestureLock = 'zoom'; // let Leaflet's native touchZoom keep driving this one
    } else {
      return; // still ambiguous — wait for a clearer signal before committing either way
    }
  }

  if (twoFingerGestureLock !== 'rotate') return;
  disableAutoHeadingForManualRotation();
  applyMapBearing(twoFingerRotateStartBearing + delta);
}
function onMapTouchEnd(e) {
  if (e.touches.length >= 2 || !twoFingerRotateActive) return;
  twoFingerRotateActive = false;
  const wasRotating = twoFingerGestureLock === 'rotate';
  twoFingerGestureLock = null;
  if (wasRotating && e.touches.length === 1 && rotationActive()) {
    beginSingleFingerContinuation(null, e.touches[0]);
  } else {
    scheduleAutoRefollow();
  }
}
(function initTwoFingerRotate(){
  const el = map.getContainer();
  el.addEventListener('touchstart', onMapTouchStart, { passive: true });
  el.addEventListener('touchmove', onMapTouchMove, { passive: true });
  el.addEventListener('touchend', onMapTouchEnd, { passive: true });
  el.addEventListener('touchcancel', onMapTouchEnd, { passive: true });
})();

// Same legacy-Safari pinch-zoom guard as above, but for the whole document —
// covers an accidental two-finger pinch landing on the top bar, side panels,
// modals, etc. (anywhere outside the map container), not just the map.
document.addEventListener('gesturestart', e => e.preventDefault());
document.addEventListener('gesturechange', e => e.preventDefault());

// --- Desktop: Shift + drag to rotate (optional, per Google Earth/Mapbox
// convention — plain drag still pans; holding Shift switches a mouse
// drag into a bearing control instead). Wheel-zoom and drag-pan are
// untouched (existing native/rotation-aware handlers above already cover
// those, including trackpad pinch: browsers report that as ctrl+wheel,
// which both the native scrollWheelZoom and onRotatedWheelZoom paths
// already handle and preventDefault on).
let shiftRotateActive = false;
let shiftRotateLast = null;
let shiftRotateBearing = 0;
const SHIFT_ROTATE_DEG_PER_PX = 0.5;

function shiftRotatePointerDown(e) {
  if (e.pointerType !== 'mouse' || !e.shiftKey || e.button !== 0) return;
  shiftRotateActive = true;
  shiftRotateLast = { x: e.clientX, y: e.clientY };
  shiftRotateBearing = mapBearing;
  cancelPanFling();
  onUserMapInteractionStart();
  setNativeDraggingEnabled(false);
  e.preventDefault();
}

function shiftRotatePointerMove(e) {
  if (!shiftRotateActive) return;
  const dx = e.clientX - shiftRotateLast.x;
  shiftRotateLast = { x: e.clientX, y: e.clientY };
  shiftRotateBearing += dx * SHIFT_ROTATE_DEG_PER_PX;
  applyMapBearingRaw(shiftRotateBearing);
}

function shiftRotatePointerUp() {
  if (!shiftRotateActive) return;
  shiftRotateActive = false;
  shiftRotateLast = null;
  setNativeDraggingEnabled(!rotationActive());
  scheduleAutoRefollow();
}

(function initShiftDragRotate() {
  mapContainerEl.addEventListener('pointerdown', shiftRotatePointerDown);
  window.addEventListener('pointermove', shiftRotatePointerMove, { passive: true });
  window.addEventListener('pointerup', shiftRotatePointerUp, { passive: true });
})();



const TRAVEL_MODE_CYCLE = ['car', 'bike', 'foot'];
function toggleDrivingMode(mode) {
  const requestedMode = TRAVEL_MODE_CYCLE.includes(mode) ? mode : 'car';
  drivingMode = !drivingMode;
  const compassBtn = document.getElementById('mapCompass');

  document.body.classList.toggle('driving-active', drivingMode);

  if (drivingMode) travelMode = requestedMode;
  document.body.classList.toggle('bike-mode-active', drivingMode && travelMode === 'bike');
  document.body.classList.toggle('walk-mode-active', drivingMode && travelMode === 'foot');
  updateTravelModeSwitchBtn();
  if (typeof refreshActiveMapStyle === 'function') refreshActiveMapStyle();

  if (map.invalidateSize) map.invalidateSize({ animate: false, pan: false });
  updateRotationOrigin();

  if (drivingMode) {

    navLastRouteAt = 0;
    navLastRouteFrom = null;
    bumpBaselineMag = null;
    bumpCalibrationCount = 0;
    updateDrivingGpsStatus();
    if (!followMode) toggleFollowMode();
    setUserMarkerStyle(true);
    if (userCoords) followMapTo(userCoords.lat, userCoords.lon);
    if (compassBtn) compassBtn.style.display = 'flex';
    requestOrientationPermission();
    if (travelMode !== 'foot') requestMotionPermission();
    if (userCoords) maybeReloadBumpsNear(userCoords.lat, userCoords.lon);
    if (headingUpMode && currentHeading !== null) applyMapBearing(-currentHeading);
    if (destinationCoords && userCoords) updateTurnByTurnDisplay(userCoords);
    openOverlay('drivingMode', () => { if (drivingMode) toggleDrivingMode(); });
    if (drivingSafetyReminderEnabled && travelMode !== 'foot') showDrivingSafetyModal();
    startMarkerAnimLoop();
  } else {
    closeOverlay('drivingMode');
    if (document.getElementById('drivingSafetyModal')?.style.display === 'flex') hideDrivingSafetyModal();
    if (sectionRecording) {
      toggleSectionRecording();
    }
    if (sectionAwaitingCategory) {
      cancelPendingSection();
    }
    if (navPanelOpen) closeNavigatePanel();
    hideTurnByTurnDisplay();
    cancelVoiceNav();
    resetQuickGrids();
    setUserMarkerStyle(false);
    stopMarkerAnimLoop();
    if (!walkingHeadingMode) {
      resetMapBearing();
    } else if (currentHeading !== null) {
      applyMapBearing(-currentHeading);
    }
    if (compassBtn) compassBtn.style.display = 'none';
    currentSpeedLimitKmh = null;
    overspeedArmed = true;
    clearSpeedSignMarkers();
    const capsule = document.getElementById('drivingSpeedCapsule');
    if (capsule) capsule.classList.remove('overspeed-flash');
  }

  setTimeout(() => { if (typeof map !== 'undefined' && map.invalidateSize) { map.invalidateSize(); updateRotationOrigin(); } }, 60);
}

const TRAVEL_MODE_ICON = {
  car:  { type: 'img', src: 'icons/car.png' },
  bike: { type: 'img', src: 'icons/bicycle.png' },
  foot: { type: 'img', src: 'icons/walking.png' }
};
function travelModeIconHtml(mode) {
  const cfg = TRAVEL_MODE_ICON[mode] || TRAVEL_MODE_ICON.car;
  return cfg.type === 'svg' ? cfg.markup : `<img class="icon-img" src="${cfg.src}" alt="">`;
}
function updateTravelModeSwitchBtn() {
  const btn = document.getElementById('travelModeSwitchBtn');
  if (!btn) return;
  btn.innerHTML = travelModeIconHtml(travelMode);
  const titles = { car: t('drivingBtnTitle'), bike: t('bikeBtnTitle'), foot: t('walkBtnTitle') };
  btn.title = titles[travelMode] || '';
}
function cycleTravelMode() {
  if (!drivingMode) return;
  const idx = TRAVEL_MODE_CYCLE.indexOf(travelMode);
  const next = TRAVEL_MODE_CYCLE[(idx + 1) % TRAVEL_MODE_CYCLE.length];
  switchTravelMode(next);
}
function switchTravelMode(nextMode) {
  if (!TRAVEL_MODE_CYCLE.includes(nextMode) || nextMode === travelMode || !drivingMode) return;
  travelMode = nextMode;
  document.body.classList.toggle('bike-mode-active', travelMode === 'bike');
  document.body.classList.toggle('walk-mode-active', travelMode === 'foot');
  updateTravelModeSwitchBtn();
  if (typeof refreshActiveMapStyle === 'function') refreshActiveMapStyle();
  resetQuickGrids();
  navLastRouteAt = 0;
  navLastRouteFrom = null;
  currentSpeedLimitKmh = null;
  overspeedArmed = true;
  clearSpeedSignMarkers();
  if (travelMode !== 'foot') requestMotionPermission();
  if (userCoords) maybeReloadBumpsNear(userCoords.lat, userCoords.lon);
  if (destinationCoords) drawNavigationLine(true);
}

let motionPermissionAsked = false;
let motionListenerAttached = false;
let gravityEstimate  = null;

let bumpBaselineMag  = null;
let bumpCalibrationCount = 0;
const BUMP_CALIBRATION_SAMPLES = 20; // ~a couple seconds of accelerometer samples before the baseline is trusted

let lastBumpAt       = 0;

const GRAVITY_LOWPASS_ALPHA  = 0.12;
const BUMP_BASELINE_ALPHA    = 0.05;

function bumpRatioThreshold() { return travelMode === 'bike' ? 2.2 : 2.5; }

function bumpAbsFloorMs2()    { return travelMode === 'bike' ? 3.0 : 3.5; }

function bumpMinSpeedKmh()    { return travelMode === 'bike' ? 5   : 8; }

const BUMP_REFRACTORY_MS     = 550;

const BUMP_DEDUPE_RADIUS_M   = 12;

const BUMP_LOAD_RADIUS_KM    = 3;

const BUMP_RELOAD_DISTANCE_M = 800;

function requestMotionPermission() {
  if (motionPermissionAsked || !bumpDetectionEnabled) return;
  if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
    motionPermissionAsked = true;
    DeviceMotionEvent.requestPermission().then(state => {
      if (state === 'granted') attachMotionListener();
    }).catch(() => {});
  } else {
    motionPermissionAsked = true;
    attachMotionListener();

  }
}

function attachMotionListener() {
  if (motionListenerAttached) return;
  motionListenerAttached = true;
  window.addEventListener('devicemotion', handleDeviceMotion, true);
}

function handleDeviceMotion(event) {
  if (!drivingMode || !bumpDetectionEnabled || travelMode === 'foot') return;

  let ax, ay, az;
  const lin = event.acceleration;
  const raw = event.accelerationIncludingGravity;
  if (lin && typeof lin.x === 'number' && !isNaN(lin.x)) {
    ax = lin.x; ay = lin.y; az = lin.z;
  } else if (raw && typeof raw.x === 'number' && !isNaN(raw.x)) {
    if (!gravityEstimate) gravityEstimate = { x: raw.x, y: raw.y, z: raw.z };
    gravityEstimate.x += (raw.x - gravityEstimate.x) * GRAVITY_LOWPASS_ALPHA;
    gravityEstimate.y += (raw.y - gravityEstimate.y) * GRAVITY_LOWPASS_ALPHA;
    gravityEstimate.z += (raw.z - gravityEstimate.z) * GRAVITY_LOWPASS_ALPHA;
    ax = raw.x - gravityEstimate.x;
    ay = raw.y - gravityEstimate.y;
    az = raw.z - gravityEstimate.z;
  } else {
    return;

  }

  const mag = Math.sqrt(ax * ax + ay * ay + az * az);

  if (bumpBaselineMag === null) { bumpBaselineMag = mag; bumpCalibrationCount = 1; return; }
  if (bumpCalibrationCount < BUMP_CALIBRATION_SAMPLES) {
    bumpCalibrationCount++;
    bumpBaselineMag += (mag - bumpBaselineMag) / bumpCalibrationCount;
    return;
  }

  const isSpike = mag > bumpBaselineMag * bumpRatioThreshold() && mag > bumpAbsFloorMs2();

  if (!isSpike) {
    bumpBaselineMag += (mag - bumpBaselineMag) * BUMP_BASELINE_ALPHA;
    return;
  }

  if (Date.now() - lastBumpAt < BUMP_REFRACTORY_MS) return;
  if (smoothedSpeedKmh === null || smoothedSpeedKmh < bumpMinSpeedKmh()) return;

  lastBumpAt = Date.now();

  const severity = mag / bumpBaselineMag;
  const pos = estimateCurrentPosition();
  if (pos) recordBump(pos.lat, pos.lon, severity);
}

function estimateCurrentPosition() {
  if (!userCoords) return null;
  let pos;
  if (!lastAcceptedFix || currentHeading === null || !smoothedSpeedKmh || smoothedSpeedKmh < 0.5) {
    pos = { lat: userCoords.lat, lon: userCoords.lon };
  } else {
    const dtSeconds = Math.min((Date.now() - lastAcceptedFix.t) / 1000, 3);
    const distanceM = (smoothedSpeedKmh / 3.6) * dtSeconds;
    pos = distanceM < 0.5
      ? { lat: userCoords.lat, lon: userCoords.lon }
      : projectPoint(userCoords.lat, userCoords.lon, currentHeading, distanceM);
  }
  return snapToRouteIfClose(pos);
}

function snapToRouteIfClose(pos) {
  if (!pos || !drivingMode || !navigationLine || navigationLine._isFallback) return pos;
  const nearest = nearestPointOnPolyline(pos, navigationLine.getLatLngs());
  if (!nearest || nearest.dist > navOnRouteRecoverThresholdM()) return pos;
  return { lat: nearest.lat, lon: nearest.lon };
}

let markerAnimFrameId = null;
let markerAnimLastTs = null;
let animatedDrivingHeading = null;
const DRIVING_BEARING_EASE_TAU_MS = 350; // lower = snappier, higher = smoother/laggier

function markerAnimTick(ts) {
  if (!drivingMode || !userMarker) { markerAnimFrameId = null; markerAnimLastTs = null; animatedDrivingHeading = null; return; }

  const dt = markerAnimLastTs === null ? 16 : Math.max(1, ts - markerAnimLastTs);
  markerAnimLastTs = ts;

  // A two-finger rotate gesture owns rotWrapper's CSS transform (via
  // applyMapBearing) for the duration of the gesture — see
  // onMapTouchMove/onMapTouchStart above. This loop used to keep calling
  // map.setView() and applyMapBearing() every frame regardless, which also
  // write to the map's real center and to that same rotWrapper transform.
  // Two rAF loops overwriting the same state in unpredictable order made
  // the GPS marker visibly jitter/jump whenever you rotated the map while
  // navigating. So: while a rotate gesture is active, keep the marker's
  // own lat/lon current (harmless, and means there's no jump when the
  // gesture ends) but don't touch the view or rotation — the gesture's own
  // handling picks the driving position back up cleanly next frame. (Pinch
  // *zoom* no longer needs this: it's native Leaflet touchZoom now, not a
  // custom rotWrapper transform, so it doesn't conflict with this loop.)
  const pinchInProgress = twoFingerRotateActive;

  const pos = estimateCurrentPosition();
  if (pos) {
    userMarker.setLatLng([pos.lat, pos.lon]);
    // Recenter the map every frame (instead of once per GPS fix) so it glides continuously
    // with the vehicle rather than jumping in discrete steps.
    if (followMode && !pinchInProgress) {
      const zoom = Math.max(map.getZoom(), 17);
      map.setView([pos.lat, pos.lon], zoom, { animate: false });
    }
  }

  if (currentHeading !== null) {
    if (animatedDrivingHeading === null) animatedDrivingHeading = currentHeading;
    const delta = shortestAngleDelta(animatedDrivingHeading, currentHeading);
    if (Math.abs(delta) > 0.05) {
      const alpha = 1 - Math.exp(-dt / DRIVING_BEARING_EASE_TAU_MS);
      animatedDrivingHeading = ((animatedDrivingHeading + delta * alpha) % 360 + 360) % 360;
    } else {
      animatedDrivingHeading = currentHeading;
    }
    // Ease the map's rotation continuously toward the latest heading, rather than snapping
    // it once per GPS fix. applyMapBearing() already updates the arrow rotation internally.
    if (headingUpMode && !pinchInProgress) {
      applyMapBearing(-animatedDrivingHeading);
    } else {
      updateUserMarkerRotation();
    }
  } else {
    updateUserMarkerRotation();
  }

  markerAnimFrameId = requestAnimationFrame(markerAnimTick);
}
function startMarkerAnimLoop() {
  if (markerAnimFrameId !== null) return;
  markerAnimLastTs = null;
  animatedDrivingHeading = null;
  markerAnimFrameId = requestAnimationFrame(markerAnimTick);
}
function stopMarkerAnimLoop() {
  if (markerAnimFrameId !== null) { cancelAnimationFrame(markerAnimFrameId); markerAnimFrameId = null; }
  markerAnimLastTs = null;
  animatedDrivingHeading = null;
}

function projectPoint(lat, lon, bearingDeg, distanceM) {
  const R = 6371000;
  const brng = bearingDeg * Math.PI / 180;
  const lat1 = lat * Math.PI / 180;
  const lon1 = lon * Math.PI / 180;
  const dOverR = distanceM / R;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(dOverR) + Math.cos(lat1) * Math.sin(dOverR) * Math.cos(brng));
  const lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(dOverR) * Math.cos(lat1), Math.cos(dOverR) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: lat2 * 180 / Math.PI, lon: ((lon2 * 180 / Math.PI) + 540) % 360 - 180 };
}

let bumpMarkersLayer     = null;
let loadedBumps          = [];

let lastBumpLoadCenter   = null;

function ensureBumpLayer() {
  if (!bumpMarkersLayer) bumpMarkersLayer = L.layerGroup().addTo(map);
  return bumpMarkersLayer;
}

function findNearbyBump(lat, lon) {
  return loadedBumps.find(b => distMeters({ lat: b.lat, lon: b.lon }, { lat, lon }) <= BUMP_DEDUPE_RADIUS_M) || null;
}

const BUMP_SEVERITY_MIN   = 2.5;

const BUMP_SEVERITY_MAX   = 6;

const BUMP_RADIUS_MIN     = 2.5;
const BUMP_RADIUS_MAX     = 4.5;
const BUMP_OPACITY_MIN    = 0.45;
const BUMP_OPACITY_MAX    = 0.85;
const BUMP_COLOR_MILD     = { r: 0xff, g: 0x90, b: 0x34 };

const BUMP_COLOR_SEVERE   = { r: 0xd6, g: 0x1f, b: 0x1f };

function bumpSeverityFactor(severity) {
  const s = typeof severity === 'number' && !isNaN(severity) ? severity : BUMP_SEVERITY_MIN;
  return Math.max(0, Math.min(1, (s - BUMP_SEVERITY_MIN) / (BUMP_SEVERITY_MAX - BUMP_SEVERITY_MIN)));
}

function bumpColorForFactor(t) {
  const lerp = (a, b) => Math.round(a + (b - a) * t);
  return `rgb(${lerp(BUMP_COLOR_MILD.r, BUMP_COLOR_SEVERE.r)},${lerp(BUMP_COLOR_MILD.g, BUMP_COLOR_SEVERE.g)},${lerp(BUMP_COLOR_MILD.b, BUMP_COLOR_SEVERE.b)})`;
}

function drawBumpDot(lat, lon, severity) {
  const t = bumpSeverityFactor(severity);
  L.circleMarker([lat, lon], {
    radius: BUMP_RADIUS_MIN + t * (BUMP_RADIUS_MAX - BUMP_RADIUS_MIN),
    weight: 0,
    fillOpacity: BUMP_OPACITY_MIN + t * (BUMP_OPACITY_MAX - BUMP_OPACITY_MIN),
    fillColor: bumpColorForFactor(t)
  }).addTo(ensureBumpLayer());
}

async function recordBump(lat, lon, severity) {
  if (findNearbyBump(lat, lon)) return;

  const placeholder = { id: `local-${Date.now()}`, lat, lon, severity };
  loadedBumps.push(placeholder);
  drawBumpDot(lat, lon, severity);

  try {

    const { data, error } = await sb.from(BUMPS_TABLE).insert([{ latitude: lat, longitude: lon, severity }]).select('id').single();
    if (error) throw error;
    if (data && data.id) placeholder.id = data.id;
  } catch (err) {

    console.warn('Bump insert failed:', err);
  }
}

async function loadBumpsNear(lat, lon) {
  const latDelta = BUMP_LOAD_RADIUS_KM / 111;
  const lonDelta = BUMP_LOAD_RADIUS_KM / (111 * Math.cos(lat * Math.PI / 180) || 1);
  try {
    const { data, error } = await sb.from(BUMPS_TABLE)
      .select('id,latitude,longitude,severity')
      .gte('latitude', lat - latDelta).lte('latitude', lat + latDelta)
      .gte('longitude', lon - lonDelta).lte('longitude', lon + lonDelta)
      .limit(1000);
    if (error) throw error;
    (data || []).forEach(row => {
      if (loadedBumps.some(b => b.id === row.id)) return;
      loadedBumps.push({ id: row.id, lat: row.latitude, lon: row.longitude, severity: row.severity });
      drawBumpDot(row.latitude, row.longitude, row.severity);
    });
  } catch (err) {
    console.warn('Bump load failed:', err);
  }
}

function maybeReloadBumpsNear(lat, lon) {
  if (lastBumpLoadCenter && distMeters(lastBumpLoadCenter, { lat, lon }) < BUMP_RELOAD_DISTANCE_M) return;
  lastBumpLoadCenter = { lat, lon };
  loadBumpsNear(lat, lon);
}

let reportSubmissionInFlight = false;

const REPORT_RATE_LIMIT_BASE_MAX = 5;
const REPORT_RATE_LIMIT_BASE_WINDOW_MS = 5 * 60 * 1000;
const REPORT_RATE_LIMIT_MIN_WINDOW_MS = 90 * 1000;

const REPORT_RATE_LIMIT_EXTRA_PER_LEVEL = 1;

const REPORT_RATE_LIMIT_SHRINK_PER_LEVEL_MS = 45 * 1000;

const REPORT_RATE_LIMIT_STORAGE_KEY = 'ttb_recent_report_times';

function reportRateLimitParamsForLevel(level) {
  const max = REPORT_RATE_LIMIT_BASE_MAX + level * REPORT_RATE_LIMIT_EXTRA_PER_LEVEL;
  const windowMs = Math.max(
    REPORT_RATE_LIMIT_MIN_WINDOW_MS,
    REPORT_RATE_LIMIT_BASE_WINDOW_MS - level * REPORT_RATE_LIMIT_SHRINK_PER_LEVEL_MS
  );
  return { max, windowMs };
}

function getRecentReportTimestamps(windowMs) {
  try {
    const raw = localStorage.getItem(REPORT_RATE_LIMIT_STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    const cutoff = Date.now() - (windowMs != null ? windowMs : REPORT_RATE_LIMIT_BASE_WINDOW_MS);
    return Array.isArray(arr) ? arr.filter(ts => typeof ts === 'number' && ts > cutoff) : [];
  } catch (e) {
    return [];
  }
}

function reportRateLimitWaitSeconds() {
  const { max, windowMs } = reportRateLimitParamsForLevel(currentUserLevel().level);
  const recent = getRecentReportTimestamps(windowMs);
  if (recent.length < max) return null;
  const oldest = Math.min(...recent);
  const waitMs = (oldest + windowMs) - Date.now();
  return Math.max(1, Math.ceil(waitMs / 1000));
}

function recordReportSubmission() {

  const recent = getRecentReportTimestamps(REPORT_RATE_LIMIT_BASE_WINDOW_MS);
  recent.push(Date.now());
  try { localStorage.setItem(REPORT_RATE_LIMIT_STORAGE_KEY, JSON.stringify(recent)); } catch (e) {}
  myReportsCache = null;

}

function shouldBlockReportSubmission() {
  if (reportSubmissionInFlight) return true;
  if (currentProfile && currentProfile.is_admin) return false;

  const waitSeconds = reportRateLimitWaitSeconds();
  if (waitSeconds !== null) {
    toast(t('reportRateLimitedPrefix') + waitSeconds + t('reportRateLimitedSuffix'), 'error');
    return true;
  }
  return false;
}

const CAR_QUICK_CATEGORIES = ['Road', 'Streetlight', 'SECTION_RECORD', 'Waste', 'Parking', 'Electricity'];
const BIKE_QUICK_CATEGORIES = ['BikeLanes', 'Road', 'SECTION_RECORD', 'Streetlight', 'Waste', 'Parking'];

const QUICK_DEFAULT_CATEGORY_KEYS = { car: 'ttb_quick_default_car', bike: 'ttb_quick_default_bike' };
const QUICK_DEFAULT_CATEGORY_FALLBACK = { car: 'Road', bike: 'BikeLanes' };

// Categories that are valid choices for "default quick-report category" in a given mode:
// real categories with at least one subcategory (SECTION_RECORD isn't a category to report into).
function quickDefaultCategoryOptions(modeKey) {
  const { categories } = quickGridConfig(modeKey);
  return categories.filter(cat => cat !== 'SECTION_RECORD' && quickSubcategoryList(modeKey, cat).length > 0);
}

// Cheaper validity check (mode's category list only) usable at script-load time, before
// SUBCATEGORIES (defined further down the file) exists yet.
function isQuickCategoryChoice(modeKey, cat) {
  if (!cat || cat === 'SECTION_RECORD') return false;
  const { categories } = quickGridConfig(modeKey);
  return categories.includes(cat);
}

function getQuickDefaultCategoryPref(modeKey) {
  const key = QUICK_DEFAULT_CATEGORY_KEYS[modeKey];
  const fallback = QUICK_DEFAULT_CATEGORY_FALLBACK[modeKey];
  try {
    const v = localStorage.getItem(key);
    if (v === null) return isQuickCategoryChoice(modeKey, fallback) ? fallback : '';
    if (v === '') return '';
    return isQuickCategoryChoice(modeKey, v) ? v : '';
  } catch (err) {
    return isQuickCategoryChoice(modeKey, fallback) ? fallback : '';
  }
}

let carQuickDefaultCategoryPref = getQuickDefaultCategoryPref('car');
let bikeQuickDefaultCategoryPref = getQuickDefaultCategoryPref('bike');

function setQuickDefaultCategoryPref(modeKey, cat) {
  const key = QUICK_DEFAULT_CATEGORY_KEYS[modeKey];
  const value = cat || '';
  if (modeKey === 'car') carQuickDefaultCategoryPref = value; else bikeQuickDefaultCategoryPref = value;
  try { localStorage.setItem(key, value); } catch (err) {}
  // Re-apply immediately: whichever grid is currently showing its resting (top-level or
  // already-default) state should reflect the new preference right away.
  resetQuickGrids();
}

function populateQuickDefaultSelect(modeKey) {
  const select = document.getElementById(modeKey === 'car' ? 'quickDefaultCarSelect' : 'quickDefaultBikeSelect');
  if (!select) return;
  const options = quickDefaultCategoryOptions(modeKey);
  const current = modeKey === 'car' ? carQuickDefaultCategoryPref : bikeQuickDefaultCategoryPref;
  const noneLabel = t('quickDefaultNoneOption') || 'None (show all categories)';
  select.innerHTML = `<option value="">${noneLabel}</option>` +
    options.map(cat => `<option value="${cat}">${translateCategory(cat)}</option>`).join('');
  select.value = current || '';
}
function initQuickDefaultCategorySettingsUi() {
  populateQuickDefaultSelect('car');
  populateQuickDefaultSelect('bike');
}
// The category the quick-report grid should rest on for a given mode: the user's chosen
// default (if it's a valid category for that mode), otherwise the plain top-level category
// grid (null).
function defaultQuickCategoryFor(modeKey) {
  const pref = modeKey === 'car' ? carQuickDefaultCategoryPref : bikeQuickDefaultCategoryPref;
  if (!pref) return null;
  const { categories } = quickGridConfig(modeKey);
  return categories.includes(pref) ? pref : null;
}

const QUICK_SUBCATEGORY_OVERRIDES = {
  car: { Electricity: ['pole_damage', 'exposed_wire', 'other'] }
};
function quickSubcategoryList(modeKey, cat) {
  const full = SUBCATEGORIES[cat] || [];
  const overrideKeys = QUICK_SUBCATEGORY_OVERRIDES[modeKey] && QUICK_SUBCATEGORY_OVERRIDES[modeKey][cat];
  if (!overrideKeys) return full;
  return overrideKeys.map(key => full.find(s => s.key === key)).filter(Boolean);
}

let carQuickCategory = defaultQuickCategoryFor('car');
let bikeQuickCategory = defaultQuickCategoryFor('bike');

function quickGridConfig(modeKey) {
  return modeKey === 'car'
    ? { gridId: 'carQuickGrid', categories: CAR_QUICK_CATEGORIES }
    : { gridId: 'bikeQuickGrid', categories: BIKE_QUICK_CATEGORIES };
}
function getQuickCategory(modeKey) { return modeKey === 'car' ? carQuickCategory : bikeQuickCategory; }
function setQuickCategory(modeKey, cat) { if (modeKey === 'car') carQuickCategory = cat; else bikeQuickCategory = cat; }

function renderQuickGrid(modeKey) {
  const { gridId, categories } = quickGridConfig(modeKey);
  const grid = document.getElementById(gridId);
  if (!grid) return;
  const current = getQuickCategory(modeKey);
  if (current) {
    renderQuickSubcategoryTiles(grid, current, modeKey);
  } else {
    renderQuickCategoryTiles(grid, categories, modeKey);
  }
}

function renderQuickCategoryTiles(grid, categories, modeKey) {
  grid.innerHTML = categories.map(cat => {
    if (cat === 'SECTION_RECORD') return renderSectionRecordTile();
    const label = translateCategory(cat);
    const icon = categoryIcon(cat);
    return `<div class="quick-tile" style="background:${categoryColor(cat)};" onclick="handleQuickCategoryTap('${modeKey}','${cat}')" title="${label}" aria-label="${label}"><div class="quick-tile-icon" style="-webkit-mask-image:url('${icon}');mask-image:url('${icon}');"></div><span class="quick-tile-label">${label}</span></div>`;
  }).join('');
}

function renderSectionRecordTile() {
  const label = sectionRecording ? (t('endSectionBtn') || 'Stop Recording') : (t('startSectionBtn') || 'Start Section Report');
  const recordingClass = sectionRecording ? ' recording' : '';
  const disabledClass = sectionAwaitingCategory ? ' section-record-disabled' : '';
  return `<div class="quick-tile quick-tile-record section-record-tile${recordingClass}${disabledClass}" onclick="toggleSectionRecording()" title="${label}" aria-label="${label}">
    <div class="quick-record-shape"></div>
    <span class="quick-tile-label section-record-label">${label}</span>
  </div>`;
}

function renderQuickSubcategoryTiles(grid, cat, modeKey) {
  const list = quickSubcategoryList(modeKey, cat);
  const icons = WIZ_SUBCATEGORY_ICONS[cat] || {};
  const backLabel = t('bikeQuickBack') || 'Back';
  const backTile = `<div class="quick-tile quick-tile-back" onclick="quickGridGoBack('${modeKey}')" title="${backLabel}" aria-label="${backLabel}"><div class="quick-tile-icon" style="-webkit-mask-image:url('icons/arrow.png');mask-image:url('icons/arrow.png');"></div><span class="quick-tile-label">${backLabel}</span></div>`;
  const subTiles = list.map(s => {
    const subLabel = isSerbianLang() ? s.sr : s.en;
    const iconFile = icons[s.key];
    const iconHtml = iconFile ? `<div class="quick-tile-icon" style="-webkit-mask-image:url('icons/reports/${iconFile}');mask-image:url('icons/reports/${iconFile}');"></div>` : '';
    return `<div class="quick-tile" style="background:${categoryColor(cat)};" onclick="handleQuickSubcategoryTap('${modeKey}','${cat}','${s.key}')" title="${subLabel}" aria-label="${subLabel}">${iconHtml}<span class="quick-tile-label">${subLabel}</span></div>`;
  }).join('');
  // Back tile goes last, after the subcategory tiles.
  grid.innerHTML = subTiles + backTile;
}

function handleQuickCategoryTap(modeKey, cat) {
  const list = quickSubcategoryList(modeKey, cat);
  if (!list.length) { handleTileTap(cat, null); return; }
  setQuickCategory(modeKey, cat);
  renderQuickGrid(modeKey);
}

function handleQuickSubcategoryTap(modeKey, cat, subKey) {
  handleTileTap(cat, subKey);
  // Whatever category was just reported, rest back on the default (Road subcategories,
  // when enabled) rather than always dropping back to the top-level category grid.
  setQuickCategory(modeKey, defaultQuickCategoryFor(modeKey));
  renderQuickGrid(modeKey);
}

function quickGridGoBack(modeKey) {
  // Explicit back navigation always goes to the top-level category grid, so the user can
  // pick a different category — the default only re-applies after a report is submitted.
  setQuickCategory(modeKey, null);
  renderQuickGrid(modeKey);
}

function resetQuickGrids() {
  carQuickCategory = defaultQuickCategoryFor('car');
  bikeQuickCategory = defaultQuickCategoryFor('bike');
  renderQuickGrid('car');
  renderQuickGrid('bike');
}

function handleTileTap(category, subcategoryKey) {
  if (sectionAwaitingCategory) {
    finalizeSectionReport(category, subcategoryKey);
  } else {
    quickReportTap(category, subcategoryKey);
  }
}

async function quickReportTap(category, subcategoryKey) {
  if (!currentSession || !currentProfile) { toast(t('signInFirst') || 'Sign in first', 'error'); return; }
  if (!currentProfile.is_admin && !isMobileDevice()) { toast(t('mobileOnlyReport'), 'error'); return; }

  const isAdmin = !!currentProfile.is_admin;
  const inOwnDomain = isAdmin && isMunicipalityInAdminDomain(manualPinMunicipality);

  // Prefer the manually-placed pin over the raw GPS fix, same as the main report wizard:
  // GPS gives a rough dot, but if the user dropped a pin to fine-tune the exact spot,
  // that's the location they mean to report.
  const coords = pinMode && manualCoords ? manualCoords : userCoords;
  if (!coords) { toast(t('waitGps'), 'error'); return; }
  if (!isValidCoordObj(coords)) { toast(t('invalidLocation'), 'error'); return; }
  if (!isAdmin && !hasReliableGps()) { toast(t('gpsTooWeak'), 'error'); return; }
  if ((await ensureVpnStatus()).isVpn) { toast(t('vpnBlockedReport'), 'error'); return; }
  if (shouldBlockReportSubmission()) return;

  if (!isAdmin && !inOwnDomain && pinMode && manualCoords) {
    if (!userCoords || !hasReliableGps()) { toast(t('waitGps'), 'error'); return; }
    const dist = distMeters(userCoords, manualCoords);
    if (dist > REPORT_PROXIMITY_MAX_M) {
      toast(t('tooFarToReport').replace('{d}', Math.round(dist)), 'error');
      return;
    }
  }

  const freshSession = await ensureFreshSession();
  if (!freshSession) return;

  reportSubmissionInFlight = true;
  const carGrid = document.getElementById('carQuickGrid');
  const bikeGrid = document.getElementById('bikeQuickGrid');
  if (carGrid) carGrid.classList.add('submitting');
  if (bikeGrid) bikeGrid.classList.add('submitting');
  try {
    const { data, error } = await sb.from(TABLE).insert([{
      latitude: coords.lat,
      longitude: coords.lon,
      category: category,
      subcategory: subcategoryKey,
      priority: 'normal',
      status: 'reported',
      comment: '',
      created_at: new Date().toISOString(),
      owner_id: currentSession.user.id,
      owner_username: currentProfile.username
    }]).select('id').single();
    if (error) throw error;
    recordReportSubmission();
    resolveAndAttachMunicipality(data && data.id, coords.lat, coords.lon);
    toast('✓ ' + t('submitted'), 'success');
    await loadPinsByWindow();
  } catch (err) {
    console.error('Quick report error (full):', err);
    toast(describeAuthError(err), 'error');
  } finally {
    reportSubmissionInFlight = false;
    if (carGrid) carGrid.classList.remove('submitting');
    if (bikeGrid) bikeGrid.classList.remove('submitting');
  }
}

function toggleSectionRecording() {
  if (!sectionRecording) {
    if (!userCoords) { toast(t('waitGps'), 'error'); return; }
    if (!isValidCoordObj(userCoords)) { toast(t('invalidLocation'), 'error'); return; }
    if (!(currentProfile && currentProfile.is_admin) && !hasReliableGps()) { toast(t('gpsTooWeak'), 'error'); return; }
    sectionRecording = true;
    sectionPoints = [{ lat: userCoords.lat, lon: userCoords.lon }];
    sectionLastAt = Date.now();
    sectionPolyline = L.polyline([[userCoords.lat, userCoords.lon]], {
      color: '#ff4b4b', weight: 6, opacity: 0.85, lineCap: 'round'
    }).addTo(map);
    updateSectionButtonUI();
    toast(t('sectionStarted') || 'Section recording started', 'success');
  } else {
    sectionRecording = false;
    if (sectionPoints.length < 2) {
      updateSectionButtonUI();
      toast(t('sectionTooShort') || 'Not enough movement recorded. Section discarded.', 'error');
      discardSectionDraft();
      return;
    }
    sectionAwaitingCategory = true;
    updateSectionButtonUI();
    resetQuickGrids();
  }
}

function cancelPendingSection() {
  sectionAwaitingCategory = false;
  updateSectionButtonUI();
  discardSectionDraft();
  resetQuickGrids();
  toast(t('sectionDiscarded') || 'Section discarded', 'error');
}

async function finalizeSectionReport(category, subcategoryKey) {
  if (!currentSession || !currentProfile) { toast(t('signInFirst') || 'Sign in first', 'error'); return; }
  if (!currentProfile.is_admin && !isMobileDevice()) { toast(t('mobileOnlyReport'), 'error'); return; }
  if (sectionPoints.length < 2) {
    sectionAwaitingCategory = false;
    updateSectionButtonUI();
    discardSectionDraft();
    return;
  }

  const rawPath = sectionPoints.map(p => [p.lat, p.lon]);
  const pathJson = sanitizePath(rawPath);
  if (pathJson.length < 2) {
    sectionAwaitingCategory = false;
    updateSectionButtonUI();
    discardSectionDraft();
    toast(t('invalidLocation'), 'error');
    return;
  }
  if (shouldBlockReportSubmission()) return;
  if ((await ensureVpnStatus()).isVpn) {
    sectionAwaitingCategory = false;
    updateSectionButtonUI();
    toast(t('vpnBlockedReport'), 'error');
    return;
  }

  const freshSession = await ensureFreshSession();
  if (!freshSession) { discardSectionDraft(); sectionAwaitingCategory = false; updateSectionButtonUI(); return; }

  const mid = pathJson[Math.floor(pathJson.length / 2)];

  reportSubmissionInFlight = true;
  const carGrid = document.getElementById('carQuickGrid');
  const bikeGrid = document.getElementById('bikeQuickGrid');
  if (carGrid) carGrid.classList.add('submitting');
  if (bikeGrid) bikeGrid.classList.add('submitting');
  try {
    const { data, error } = await sb.from(TABLE).insert([{
      latitude: mid[0],
      longitude: mid[1],
      category: category,
      subcategory: subcategoryKey,
      priority: 'normal',
      status: 'reported',
      comment: '',
      path: pathJson,
      created_at: new Date().toISOString(),
      owner_id: currentSession.user.id,
      owner_username: currentProfile.username
    }]).select('id').single();
    if (error) throw error;
    recordReportSubmission();
    resolveAndAttachMunicipality(data && data.id, mid[0], mid[1]);
    sectionAwaitingCategory = false;
    updateSectionButtonUI();
    discardSectionDraft();
    toast('✓ ' + t('submitted'), 'success');
    await loadPinsByWindow();
  } catch (err) {
    console.error('Section report submit error (full):', err);
    toast(describeAuthError(err), 'error');
  } finally {
    reportSubmissionInFlight = false;
    if (carGrid) carGrid.classList.remove('submitting');
    if (bikeGrid) bikeGrid.classList.remove('submitting');
  }
}

function updateSectionButtonUI() {
  const bar  = document.getElementById('sectionAwaitingBar');
  const barText = document.getElementById('sectionAwaitingText');

  if (bar) bar.style.display = sectionAwaitingCategory ? 'flex' : 'none';
  if (barText) barText.textContent = t('pickSectionType') || 'Tap a type below to save this section';

  const label = sectionRecording
    ? (t('endSectionBtn') || 'Stop Recording')
    : (t('startSectionBtn') || 'Start Section Report');
  document.querySelectorAll('.section-record-tile').forEach(tile => {
    tile.classList.toggle('recording', sectionRecording);
    tile.classList.toggle('section-record-disabled', sectionAwaitingCategory);
    tile.title = label;
    tile.setAttribute('aria-label', label);
    const labelEl = tile.querySelector('.section-record-label');
    if (labelEl) labelEl.textContent = label;
  });
}

function discardSectionDraft() {
  if (sectionPolyline) { map.removeLayer(sectionPolyline); sectionPolyline = null; }
  sectionPoints = [];
  sectionLastAt = null;
  sectionGapFilling = false;
}

function updateGpsModalText(){
  const el = id => document.getElementById(id);
  if (el('gpsModalTitle')) el('gpsModalTitle').textContent = t('gpsTitle');
  if (el('gpsModalBody'))  el('gpsModalBody').textContent  = t('gpsBody');
  if (el('gpsModalAlt'))   el('gpsModalAlt').innerHTML     = t('gpsAlt');
  if (el('gpsModalBtn'))   el('gpsModalBtn').textContent   = t('gpsBtn');
}

function bringModalToFront(el){
  if (el && el.parentNode) document.body.appendChild(el);
}

let overlayStack = [];
let suppressOverlayPopstate = false;
let closingViaOverlayStack = false;

// ---- Modal accessibility: focus trap, dialog semantics, focus restore ----
// Centralized here (rather than in each show*/hide* function) since every
// modal already funnels through openOverlay/closeOverlay.
const MODAL_FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), ' +
  'input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
  '[tabindex]:not([tabindex="-1"])';

function getModalDialogPanel(wrapperEl) {
  // The centered "generic-modal-overlay" dialogs are a full-screen backdrop
  // with a smaller ".generic-modal" panel inside — that panel is the actual
  // dialog surface. Fullscreen modals have no separate panel; the wrapper
  // itself is the dialog surface.
  if (wrapperEl.classList.contains('generic-modal-overlay')) {
    return wrapperEl.querySelector('.generic-modal') || wrapperEl;
  }
  return wrapperEl;
}

function getModalFocusables(panelEl) {
  return Array.from(panelEl.querySelectorAll(MODAL_FOCUSABLE_SELECTOR))
    .filter(el => el.offsetParent !== null); // skip hidden/collapsed controls
}

function setupModalA11y(key) {
  const wrapperEl = document.getElementById(key);
  if (!wrapperEl) return;
  const panel = getModalDialogPanel(wrapperEl);

  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');

  const heading = panel.querySelector('h1, h2, h3');
  if (heading) {
    if (!heading.id) heading.id = key + 'A11yHeading';
    panel.setAttribute('aria-labelledby', heading.id);
  }

  const focusables = getModalFocusables(panel);
  if (focusables.length) {
    focusables[0].focus();
  } else {
    panel.setAttribute('tabindex', '-1');
    panel.focus();
  }
}

// Tab/Shift+Tab is confined to the topmost open modal's panel so keyboard
// focus can never land on the map or report form underneath it.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || !overlayStack.length) return;
  const top = overlayStack[overlayStack.length - 1];
  const wrapperEl = document.getElementById(top.key);
  if (!wrapperEl) return;
  const panel = getModalDialogPanel(wrapperEl);
  const focusables = getModalFocusables(panel);
  if (!focusables.length) { e.preventDefault(); return; }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (e.shiftKey) {
    if (active === first || !panel.contains(active)) { e.preventDefault(); last.focus(); }
  } else {
    if (active === last || !panel.contains(active)) { e.preventDefault(); first.focus(); }
  }
});

function openOverlay(key, closeFn) {
  if (overlayStack.some(o => o.key === key)) return;
  const wasEmpty = overlayStack.length === 0;
  const triggerEl = document.activeElement && document.activeElement !== document.body
    ? document.activeElement
    : null;
  overlayStack.push({ key, closeFn, triggerEl });
  history.pushState({ overlayKey: key }, '');

  if (wasEmpty) cancelAutoRefollowTimer();
  setupModalA11y(key);
}
function closeOverlay(key, extraHistorySteps) {
  const idx = overlayStack.findIndex(o => o.key === key);
  if (idx === -1) return;
  const entry = overlayStack[idx];
  overlayStack.splice(idx, 1);
  if (!suppressOverlayPopstate) {
    closingViaOverlayStack = true;
    if (extraHistorySteps > 0) {
      history.go(-(extraHistorySteps + 1));
    } else {
      history.back();
    }
  }

  if (overlayStack.length === 0) scheduleAutoRefollow();

  // Return focus to whatever triggered this modal (e.g. the button that
  // opened it), rather than leaving it stranded on a now-hidden element.
  if (entry && entry.triggerEl && document.contains(entry.triggerEl) && typeof entry.triggerEl.focus === 'function') {
    entry.triggerEl.focus();
  }
}
window.addEventListener('popstate', () => {
  if (wizSuppressPopstate) {
    wizSuppressPopstate = false;
    return;
  }
  // A wizard step-forward pushed this entry (see wizAdvance), so unwinding it
  // is just "go back one step and re-render" -- no need to touch overlayStack
  // at all, since the wizard's own single entry there still represents the
  // modal as a whole and was never popped for these in-between steps.
  const wizardEl = document.getElementById('reportWizard');
  if (wizardEl && wizardEl.style.display !== 'none' && wizHistoryDepth > 0) {
    wizHistoryDepth -= 1;
    wizState.step -= 1;
    wizRender();
    return;
  }
  if (closingViaOverlayStack) {
    closingViaOverlayStack = false;
    return;
  }
  if (overlayStack.length) {
    const top = overlayStack.pop();
    suppressOverlayPopstate = true;
    top.closeFn();
    suppressOverlayPopstate = false;
  } else {
    history.pushState({ overlayGuard: true }, '');
  }
});
history.pushState({ overlayGuard: true }, '');

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !overlayStack.length) return;
  const active = document.activeElement;
  const isEditable = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
  if (isEditable) return;
  const top = overlayStack[overlayStack.length - 1];
  if (top && typeof top.closeFn === 'function') top.closeFn();
});

let gpsModalShownOnce = false;
function showGpsModal(){
  if (gpsModalShownOnce) return;
  const modal = document.getElementById('gpsModal');
  if (!modal) return;
  gpsModalShownOnce = true;
  updateGpsModalText();
  bringModalToFront(modal);
  modal.style.display = 'flex';
  openOverlay('gpsModal', hideGpsModal);
}
function hideGpsModal(){
  const modal = document.getElementById('gpsModal');
  if (modal) modal.style.display = 'none';
  closeOverlay('gpsModal');
}
function resetGpsModalGate(){
  gpsModalShownOnce = false;
}

function enableManualPinMode() {
  checkFormReady();
}

let lastAcceptedFix   = null;
let lastMuniRetryAt = 0;
const MUNI_RETRY_INTERVAL_MS = 8000;
let lastFixAccuracy   = null;

let lastFixAccuracyAt = 0;

let smoothedHeading   = null;
let smoothedSpeedKmh  = null;
let smoothedFixCoords = null;
const GPS_MAX_PLAUSIBLE_SPEED_MPS = 55;
const GPS_MAX_ACCEPTABLE_ACCURACY_M = 100;
const GPS_STALE_FIX_MS = 10000;
const HEADING_SMOOTHING_FACTOR     = 0.35;
let lastGpsHeadingAt = 0;
const GPS_HEADING_FRESH_MS = 4000;
const SPEED_SMOOTHING_FACTOR       = 0.45;
const POSITION_SMOOTH_MIN_FACTOR   = 0.5;
const POSITION_SMOOTH_MAX_FACTOR   = 1.0;
const POSITION_SMOOTH_FULL_SNAP_M  = 8;

const GPS_ACCURACY_TRUSTED_M = 15;
const GPS_ACCURACY_POOR_M    = 60;
const GPS_ACCURACY_MIN_TRUST = 0.12;
function smoothPositionFix(candidate, accuracy) {
  if (!smoothedFixCoords) { smoothedFixCoords = { lat: candidate.lat, lon: candidate.lon }; return smoothedFixCoords; }
  const jumpM = distMeters(smoothedFixCoords, candidate);
  let factor = jumpM >= POSITION_SMOOTH_FULL_SNAP_M
    ? POSITION_SMOOTH_MAX_FACTOR
    : POSITION_SMOOTH_MIN_FACTOR + (POSITION_SMOOTH_MAX_FACTOR - POSITION_SMOOTH_MIN_FACTOR) * (jumpM / POSITION_SMOOTH_FULL_SNAP_M);

  if (typeof accuracy === 'number' && !isNaN(accuracy) && accuracy > GPS_ACCURACY_TRUSTED_M) {
    const span = GPS_ACCURACY_POOR_M - GPS_ACCURACY_TRUSTED_M;
    const badness = Math.min(1, (accuracy - GPS_ACCURACY_TRUSTED_M) / span);
    const accuracyTrust = 1 - badness * (1 - GPS_ACCURACY_MIN_TRUST);
    factor *= accuracyTrust;
  }

  smoothedFixCoords = {
    lat: smoothedFixCoords.lat + (candidate.lat - smoothedFixCoords.lat) * factor,
    lon: smoothedFixCoords.lon + (candidate.lon - smoothedFixCoords.lon) * factor
  };
  return smoothedFixCoords;
}
function smoothHeading(previous, rawHeading, factor) {
  if (previous === null) return ((rawHeading % 360) + 360) % 360;
  const next = previous + shortestAngleDelta(previous, rawHeading) * factor;
  return ((next % 360) + 360) % 360;
}

const GPS_SIGNAL_LOST_MS = 8000;

let _gpsIssuePillHideTimer = null;
function showGpsIssuePill(msg) {
  const el = document.getElementById('gpsIssuePill');
  const textEl = document.getElementById('gpsIssuePillText');
  if (!el || !textEl) return;
  textEl.textContent = msg;
  el.classList.add('show');
  clearTimeout(_gpsIssuePillHideTimer);
  _gpsIssuePillHideTimer = setTimeout(hideGpsIssuePill, 4000);
}
function hideGpsIssuePill() {
  clearTimeout(_gpsIssuePillHideTimer);
  const el = document.getElementById('gpsIssuePill');
  if (el) el.classList.remove('show');
}

function showPinsLoadingPill() {
  const el = document.getElementById('pinsLoadingPill');
  const textEl = document.getElementById('pinsLoadingPillText');
  if (!el || !textEl) return;
  textEl.textContent = t('pinsLoadingPill');
  el.classList.add('show');
}
function hidePinsLoadingPill() {
  const el = document.getElementById('pinsLoadingPill');
  if (el) el.classList.remove('show');
}

function hasReliableGps() {
  if (!userCoords) return false;
  if (lastFixAccuracy == null) return false;
  if (lastFixAccuracy > GPS_MAX_ACCEPTABLE_ACCURACY_M) return false;
  if (!lastFixAccuracyAt || (Date.now() - lastFixAccuracyAt) > GPS_STALE_FIX_MS) return false;
  return true;
}

function updateDrivingGpsStatus() {
  const capsule = document.getElementById('drivingSpeedCapsule');
  if (!capsule || !drivingMode) return;
  const stale = !lastAcceptedFix || (Date.now() - lastAcceptedFix.t) > GPS_SIGNAL_LOST_MS;
  capsule.title = stale ? t('drivingNoGps') : t('drivingGpsLabel');
  capsule.classList.toggle('gps-lost', stale);
}
setInterval(updateDrivingGpsStatus, 2000);

setInterval(updateReportFabState, 2000);

let speedLimitFetching     = false;
let lastSpeedLimitFetchAt  = 0;
let lastSpeedLimitFetchLoc = null;
let lastSpeedLimitSuccessAt = 0;
const SPEED_LIMIT_REFRESH_MS      = 8000;
const SPEED_LIMIT_REFRESH_DRIFT_M = 60;

const SPEED_SIGN_LOOKAHEAD_M      = 250; // how far ahead on the route we look for upcoming signs
const SPEED_SIGN_QUERY_MARGIN_M   = 80;  // padding added around the corridor so we don't miss signs right at its edge
const SPEED_SIGN_ROUTE_MATCH_M    = 30;  // how far a way can be from the route and still count as "on it"

const SPEED_LIMIT_FETCH_TIMEOUT_MS = 6000;
const SPEED_LIMIT_STALE_CLEAR_MS   = 45000; // if fetches keep failing this long, stop showing a possibly-wrong readout

function isActivelyNavigatingRoute() {
  return drivingMode && !!destinationCoords && !!navigationLine && !navigationLine._isFallback;
}

function speedSignQueryArea(originLat, originLon) {
  const origin = { lat: originLat, lon: originLon };
  const routeLatLngs = navigationLine.getLatLngs();
  const lookahead = pointAheadOnPolyline(origin, routeLatLngs, SPEED_SIGN_LOOKAHEAD_M) || origin;
  const center = { lat: (origin.lat + lookahead.lat) / 2, lon: (origin.lon + lookahead.lon) / 2 };
  const radius = Math.round(distMeters(origin, lookahead) / 2 + SPEED_SIGN_QUERY_MARGIN_M);
  return { center, radius };
}

function maybeFetchSpeedLimit(lat, lon) {
  if (speedLimitFetching || !isCarMode()) return;

  if (!isActivelyNavigatingRoute()) {
    // Nothing to check speed limits against without a real route — don't keep polling
    // Overpass in the background, and don't leave a stale readout from a previous leg up.
    if (currentSpeedLimitKmh !== null) updateSpeedLimitDisplay(null);
    clearSpeedSignMarkers();
    return;
  }

  const now = Date.now();
  const driftedFar = !lastSpeedLimitFetchLoc || distMeters(lastSpeedLimitFetchLoc, { lat, lon }) >= SPEED_LIMIT_REFRESH_DRIFT_M;
  const stale = now - lastSpeedLimitFetchAt >= SPEED_LIMIT_REFRESH_MS;
  if (!driftedFar && !stale) return;

  speedLimitFetching = true;
  lastSpeedLimitFetchAt = now;
  lastSpeedLimitFetchLoc = { lat, lon };

  const { center, radius } = speedSignQueryArea(lat, lon);
  // "geom" (not "center") so every element comes back with its full node-by-node
  // geometry. A single center point can't tell us where a way's speed limit
  // actually starts/ends along our route, and it can't tell a way that merely
  // grazes the query circle apart from one that runs along it — geometry can.
  const query = `[out:json][timeout:5];way(around:${radius},${center.lat},${center.lon})[highway][maxspeed];out tags geom 24;`;
  const url = 'https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(query);

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), SPEED_LIMIT_FETCH_TIMEOUT_MS);

  try {
    fetch(url, { signal: abortController.signal }).then(res => {
      if (!res.ok) throw new Error(`Speed limit fetch: HTTP ${res.status}`);
      return res.json();
    }).then(data => {
      const routeLatLngs = navigationLine.getLatLngs();
      const originSeg = findNearestSegmentOnPolyline({ lat, lon }, routeLatLngs);
      const originIndex = originSeg ? originSeg.index : 0;

      const raw = data.elements || [];
      const projected = raw
        .filter(el => el.tags && el.tags.maxspeed && Array.isArray(el.geometry) && el.geometry.length)
        .map(el => ({ el, way: projectWayOntoRoute(el, routeLatLngs) }));

      // Keeping a way only if MOST of its nodes hug the route (not just one
      // point) is what actually excludes parallel service roads and crossing
      // streets — those typically touch the corridor at a single node (an
      // intersection) while the rest of their geometry sits well outside it.
      const onRoute = projected
        .filter(p => p.way && p.way.onRouteFraction >= SPEED_SIGN_ONROUTE_FRACTION_MIN)
        .map(p => ({
          value: parseSpeedLimitTag(p.el.tags.maxspeed),
          startIndex: p.way.startIndex,
          endIndex: p.way.endIndex,
          startPoint: p.way.startPoint,
          endPoint: p.way.endPoint,
          onRouteFraction: p.way.onRouteFraction,
          tags: p.el.tags
        }))
        .filter(w => w.value !== null);

      // The limit that governs right now is whichever zone's [startIndex, endIndex]
      // interval actually contains our position along the route — not whichever
      // OSM way happens to be geometrically nearest, which could be the *next*
      // zone just ahead on a bend.
      let current = onRoute.find(w => originIndex >= w.startIndex && originIndex <= w.endIndex) || null;
      if (!current) {
        // Between two mapped ways (a small gap in OSM data) — use the most
        // recently passed zone instead of leaving the dashboard blank.
        let bestEnd = -1;
        for (const w of onRoute) {
          if (w.endIndex <= originIndex && w.endIndex > bestEnd) { current = w; bestEnd = w.endIndex; }
        }
      }
      if (!current) {
        // Nothing behind us yet in this corridor (e.g. navigation just started) —
        // fall back to nearest by straight-line distance so the dashboard isn't
        // left blank until the first sign is actually crossed.
        let nearestDist = Infinity;
        for (const w of onRoute) {
          const d = distMeters({ lat, lon }, w.startPoint);
          if (d < nearestDist) { nearestDist = d; current = w; }
        }
      }

      if (SPEED_SIGN_DEBUG) {
        console.groupCollapsed(`[speed-limit] fetch @ ${lat.toFixed(5)},${lon.toFixed(5)} — ${raw.length} raw, ${onRoute.length} on-route`);
        console.log('query area', { center, radius });
        console.table(projected.map(p => ({
          highway: p.el.tags && p.el.tags.highway,
          maxspeed: p.el.tags && p.el.tags.maxspeed,
          onRouteFraction: p.way ? p.way.onRouteFraction.toFixed(2) : 'n/a',
          startIndex: p.way ? p.way.startIndex : 'n/a',
          endIndex: p.way ? p.way.endIndex : 'n/a',
          kept: !!(p.way && p.way.onRouteFraction >= SPEED_SIGN_ONROUTE_FRACTION_MIN)
        })));
        console.log('originIndex', originIndex, 'chosen current', current ? { value: current.value, startIndex: current.startIndex, endIndex: current.endIndex } : null);
        console.groupEnd();
      }

      lastSpeedLimitSuccessAt = Date.now();
      updateSpeedLimitDisplay(current ? current.value : null);
      renderSpeedSignMarkers(onRoute, originIndex);
    }).catch(err => {
      const reason = err && err.name === 'AbortError' ? 'timed out' : (err && err.message) || err;
      console.warn('Speed limit fetch failed:', reason);
      if (Date.now() - lastSpeedLimitSuccessAt > SPEED_LIMIT_STALE_CLEAR_MS) {
        updateSpeedLimitDisplay(null);
        clearSpeedSignMarkers();
      }
    }).finally(() => {
      clearTimeout(timeoutId);
      speedLimitFetching = false;
    });
  } catch (err) {
    clearTimeout(timeoutId);
    speedLimitFetching = false;
    console.warn('Speed limit fetch failed to start:', err && err.message);
  }
}

// Flip to false to silence the console diagnostics below once you've confirmed
// the corridor matching looks right for your area.
const SPEED_SIGN_DEBUG = false;

// A way only counts as "on our route" if at least this fraction of its nodes
// fall within SPEED_SIGN_ROUTE_MATCH_M of the route polyline. A single close
// node (e.g. a crossing street's intersection point, or a parallel service
// road that briefly touches the corridor) is not enough.
const SPEED_SIGN_ONROUTE_FRACTION_MIN = 0.75;

// Projects every node of an OSM way's geometry onto the route polyline, and
// reports the route-index span the way covers plus what fraction of its
// nodes actually sit inside the matching corridor. This is what lets us
// treat a speed limit as a zone with a real start and end point along the
// route, instead of a single centroid guess.
function projectWayOntoRoute(el, routeLatLngs) {
  const geom = el.geometry;
  if (!Array.isArray(geom) || !geom.length) return null;

  let minIndex = Infinity, maxIndex = -Infinity;
  let startPoint = null, endPoint = null;
  let onRouteCount = 0;

  for (const pt of geom) {
    const seg = findNearestSegmentOnPolyline({ lat: pt.lat, lon: pt.lon }, routeLatLngs);
    if (!seg) continue;
    if (seg.dist <= SPEED_SIGN_ROUTE_MATCH_M) onRouteCount++;
    if (seg.index < minIndex) { minIndex = seg.index; startPoint = { lat: pt.lat, lon: pt.lon }; }
    if (seg.index > maxIndex) { maxIndex = seg.index; endPoint = { lat: pt.lat, lon: pt.lon }; }
  }
  if (minIndex === Infinity) return null;

  return {
    startIndex: minIndex,
    endIndex: maxIndex,
    startPoint,
    endPoint,
    onRouteFraction: onRouteCount / geom.length
  };
}

let speedSignMarkersLayer = null;
function ensureSpeedSignLayer() {
  if (!speedSignMarkersLayer) speedSignMarkersLayer = L.layerGroup().addTo(map);
  return speedSignMarkersLayer;
}
function clearSpeedSignMarkers() {
  if (speedSignMarkersLayer) speedSignMarkersLayer.clearLayers();
}

const SPEED_SIGN_DEDUPE_RADIUS_M = 80;

function buildSpeedSignIcon(value) {
  const digits = String(value).length;
  const fontSize = digits >= 3 ? '10px' : '13px';
  return L.divIcon({
    className: '',
    html: `<div class="speed-sign-marker pin-upright" style="font-size:${fontSize}">${value}</div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17]
  });
}

function renderSpeedSignMarkers(onRoute, originIndex) {
  const layer = ensureSpeedSignLayer();
  clearSpeedSignMarkers();
  if (!isActivelyNavigatingRoute()) return;

  // A zone still ahead (or one we're currently inside) is worth showing a sign
  // for; one whose end we've already passed is not. Placing the marker at
  // startPoint — the actual node where the way (and so the real sign) begins —
  // is what makes these line up with where the limit actually changes, rather
  // than sitting at some arbitrary centroid partway along a long stretch.
  const ahead = onRoute
    .filter(w => w.endIndex >= originIndex)
    .sort((a, b) => a.startIndex - b.startIndex);

  const placed = [];
  for (const w of ahead) {
    const tooClose = placed.some(p => p.value === w.value && distMeters(p.startPoint, w.startPoint) < SPEED_SIGN_DEDUPE_RADIUS_M);
    if (tooClose) continue;
    placed.push(w);
    L.marker([w.startPoint.lat, w.startPoint.lon], {
      icon: buildSpeedSignIcon(w.value),
      interactive: false,
      keyboard: false
    }).addTo(layer);
  }
}

function parseSpeedLimitTag(raw) {
  const match = String(raw).match(/\d+/);
  return match ? parseInt(match[0], 10) : null;
}

function updateSpeedLimitDisplay(value) {
  const el = document.getElementById('drivingSpeedLimit');
  currentSpeedLimitKmh = value || null;
  if (!el) return;
  if (value) {
    el.textContent = value;
    el.classList.remove('no-data');
  } else {
    el.textContent = '--';
    el.classList.add('no-data');
  }
  checkOverspeed();
}

let gpsWatchId = null;
let gpsRetryIntervalId = null;

function stopGpsRetryLoop() {
  if (gpsRetryIntervalId !== null) {
    clearInterval(gpsRetryIntervalId);
    gpsRetryIntervalId = null;
  }
}
function startGpsRetryLoop() {
  if (gpsRetryIntervalId !== null) return;
  gpsRetryIntervalId = setInterval(() => {
    if (gpsWatchId === null) startWatching();
  }, 4000);
}

let lastGpsWatchdogRestartAt = 0;
const GPS_WATCHDOG_RESTART_COOLDOWN_MS = 3000;
function gpsWatchdogTick() {
  const stale = !lastAcceptedFix || (Date.now() - lastAcceptedFix.t) > GPS_SIGNAL_LOST_MS;
  if (!stale || gpsWatchId === null) return;
  if (Date.now() - lastGpsWatchdogRestartAt < GPS_WATCHDOG_RESTART_COOLDOWN_MS) return;
  lastGpsWatchdogRestartAt = Date.now();
  navigator.geolocation.clearWatch(gpsWatchId);
  gpsWatchId = null;
  startWatching();
}
setInterval(gpsWatchdogTick, 1000);

function startWatching() {
  if (gpsWatchId !== null) return;
  gpsWatchId = navigator.geolocation.watchPosition(
    pos => {
      if (!isValidLatLng(pos.coords.latitude, pos.coords.longitude)) {
        console.error('Ignored GPS fix with invalid coordinates:', pos.coords);
        return;
      }

      const candidate = { lat: pos.coords.latitude, lon: pos.coords.longitude };

      const accuracy = pos.coords.accuracy;

      lastFixAccuracy = (typeof accuracy === 'number' && !isNaN(accuracy)) ? accuracy : null;
      lastFixAccuracyAt = Date.now();

      if (
        typeof accuracy === 'number' && !isNaN(accuracy) &&
        accuracy > GPS_MAX_ACCEPTABLE_ACCURACY_M &&
        lastAcceptedFix && (pos.timestamp - lastAcceptedFix.t) < GPS_STALE_FIX_MS
      ) {
        showGpsIssuePill(t('gpsIssuePillWeak').replace('{acc}', String(Math.round(accuracy))));
        return;
      }

      if (lastAcceptedFix) {
        const dtSeconds = (pos.timestamp - (lastAcceptedFix.t || pos.timestamp)) / 1000;
        const jumpMeters = distMeters(lastAcceptedFix, candidate);
        if (dtSeconds > 0 && (jumpMeters / dtSeconds) > GPS_MAX_PLAUSIBLE_SPEED_MPS) {
          console.warn(`Ignored implausible GPS jump: ${jumpMeters.toFixed(0)}m in ${dtSeconds.toFixed(1)}s`);
          showGpsIssuePill(t('gpsIssuePillJump'));
          return;
        }
      }
      lastAcceptedFix = { lat: candidate.lat, lon: candidate.lon, t: pos.timestamp };
      hideGpsIssuePill();

      userCoords = smoothPositionFix(candidate, accuracy);
      hideGpsModal();
      resetGpsModalGate();
      stopGpsRetryLoop();
      updateDrivingGpsStatus();
      updateProximityUi();
      maybeShowNearbyCheckin();
      maybeDrivingAudioAlert();
      if (!userMarker) {
        userMarker = L.marker([userCoords.lat, userCoords.lon], {
          icon: L.divIcon({
            className: 'user-location-icon',
            html: buildUserMarkerHtml(userMarkerNavStyle),
            iconSize: userMarkerNavStyle ? [46, 46] : [34, 34],
            iconAnchor: userMarkerNavStyle ? [23, 23] : [17, 17]
          }),
          zIndexOffset: 5000,
          interactive: false

        }).addTo(map);
        map.setView(getFollowCenter(userCoords.lat, userCoords.lon, 13), 13);
        showMunicipalityBoundaryForPoint(userCoords.lat, userCoords.lon, userMarker, 'gps');

        setFollowMode(true);
      } else if (drivingMode || isNavigationActive()) {
        if (travelMode === 'foot') {
          userMarker.setLatLng([userCoords.lat, userCoords.lon]);
          if (followMode) followMapTo(userCoords.lat, userCoords.lon);
        } else {
          snapUserToRoadThenShow(userCoords.lat, userCoords.lon);
        }
        if (!drivingMode && !currentContactsMunicipality && Date.now() - lastMuniRetryAt > MUNI_RETRY_INTERVAL_MS) {
          lastMuniRetryAt = Date.now();
          showMunicipalityBoundaryForPoint(userCoords.lat, userCoords.lon, userMarker, 'gps');
        }
      } else {
        userMarker.setLatLng([userCoords.lat, userCoords.lon]);
        if (followMode) followMapTo(userCoords.lat, userCoords.lon);

        if (!currentContactsMunicipality && Date.now() - lastMuniRetryAt > MUNI_RETRY_INTERVAL_MS) {
          lastMuniRetryAt = Date.now();
          showMunicipalityBoundaryForPoint(userCoords.lat, userCoords.lon, userMarker, 'gps');
        }
      }

      const GPS_HEADING_MIN_SPEED_MPS = 1.0;
      const useGpsCourseHeading = !(drivingMode && travelMode === 'foot');
      if (
        useGpsCourseHeading &&
        typeof pos.coords.heading === 'number' && !isNaN(pos.coords.heading) &&
        typeof pos.coords.speed === 'number' && !isNaN(pos.coords.speed) &&
        pos.coords.speed >= GPS_HEADING_MIN_SPEED_MPS
      ) {
        lastGpsHeadingAt = Date.now();
        smoothedHeading = smoothHeading(smoothedHeading, pos.coords.heading, HEADING_SMOOTHING_FACTOR);
        currentHeading = smoothedHeading;
        // While driving, the per-frame nav animation loop (markerAnimTick) eases the map
        // bearing and arrow continuously toward currentHeading instead of snapping it here
        // on every GPS fix, so the map doesn't visibly jump/rotate each update.
        if (!drivingMode) {
          if (isHeadingUpActive()) applyMapBearing(-currentHeading);
          updateUserMarkerRotation();
        }
      }

      const SPEED_DISPLAY_DEADZONE_KMH = 1.5;
      if (drivingMode) {
        const speedEl = document.getElementById('drivingSpeedValue');
        if (speedEl) {
          if (typeof pos.coords.speed === 'number' && !isNaN(pos.coords.speed) && pos.coords.speed >= 0) {
            const kmh = pos.coords.speed * 3.6;
            smoothedSpeedKmh = smoothedSpeedKmh === null ? kmh : smoothedSpeedKmh + (kmh - smoothedSpeedKmh) * SPEED_SMOOTHING_FACTOR;
            speedEl.textContent = smoothedSpeedKmh < SPEED_DISPLAY_DEADZONE_KMH ? 0 : Math.round(smoothedSpeedKmh);
          } else {
            smoothedSpeedKmh = null;
            speedEl.textContent = '--';
          }
        }
        checkOverspeed();
        maybeFetchSpeedLimit(userCoords.lat, userCoords.lon);
        maybeReloadBumpsNear(userCoords.lat, userCoords.lon);
      }

      if (sectionRecording && !sectionGapFilling) {
        const last = sectionPoints[sectionPoints.length - 1];
        if (distMeters(last, userCoords) >= SECTION_MIN_DISTANCE_M) {
          const gapMs = sectionLastAt ? Date.now() - sectionLastAt : 0;
          if (gapMs >= SECTION_PATH_GAP_MS) {
            fillSectionPathGap(last, { lat: userCoords.lat, lon: userCoords.lon });
          } else {
            sectionPoints.push({ lat: userCoords.lat, lon: userCoords.lon });
            if (sectionPolyline) sectionPolyline.addLatLng([userCoords.lat, userCoords.lon]);
            sectionLastAt = Date.now();
          }
        }
      }

      if (destinationCoords) {
        drawNavigationLine();
        evaluateNavigationProgress();
        updateTurnByTurnDisplay(userCoords);
        trimNavigationLineBehindPosition(userCoords);
        if (drivenPathLine && !drivenPathGapFilling) {
          const lastDriven = drivenPathCoords[drivenPathCoords.length - 1];
          const lastDrivenPt = lastDriven ? { lat: lastDriven[0], lon: lastDriven[1] } : null;
          if (!lastDrivenPt) {
            drivenPathCoords.push([userCoords.lat, userCoords.lon]);
            drivenPathLine.addLatLng([userCoords.lat, userCoords.lon]);
            drivenPathLastAt = Date.now();
          } else if (distMeters(lastDrivenPt, userCoords) >= NAV_DRIVEN_PATH_MIN_DISTANCE_M) {
            const gapMs = drivenPathLastAt ? Date.now() - drivenPathLastAt : 0;
            if (gapMs >= NAV_DRIVEN_PATH_GAP_MS) {
              fillDrivenPathGap(lastDrivenPt, { lat: userCoords.lat, lon: userCoords.lon });
            } else {
              drivenPathCoords.push([userCoords.lat, userCoords.lon]);
              drivenPathLine.addLatLng([userCoords.lat, userCoords.lon]);
              drivenPathLastAt = Date.now();
            }
          }
        }
      }

      checkFormReady();
    },
    err => {
      if (err.code === err.PERMISSION_DENIED) {
        lastFixAccuracy = null;
        lastFixAccuracyAt = 0;
        updateReportFabState();
        showGpsModal();
        if (gpsWatchId !== null) {
          navigator.geolocation.clearWatch(gpsWatchId);
          gpsWatchId = null;
        }
        startGpsRetryLoop();
      } else if (err.code === err.POSITION_UNAVAILABLE) {
        lastFixAccuracy = null;
        lastFixAccuracyAt = 0;
        updateReportFabState();
        showGpsModal();
        if (gpsWatchId !== null) {
          navigator.geolocation.clearWatch(gpsWatchId);
          gpsWatchId = null;
        }
        startGpsRetryLoop();
      }
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 1000 }
  );
}

function initGps() {
  if (!navigator.geolocation) { enableManualPinMode(); return; }
  if (!navigator.permissions || typeof navigator.permissions.query !== 'function') {
    startWatching();
    return;
  }
  try {
    navigator.permissions.query({ name: 'geolocation' }).then(result => {
      if (result.state === 'denied') { showGpsModal(); enableManualPinMode(); startGpsRetryLoop(); }
      else { startWatching(); }

      result.onchange = () => {
        if (result.state === 'denied') {
          showGpsModal();
        } else {
          hideGpsModal();
          resetGpsModalGate();
          stopGpsRetryLoop();
          startWatching();
        }
      };
    }).catch(() => { startWatching(); });
  } catch (err) {
    startWatching();
  }
}
initGps();

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (gpsWatchId !== null) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
  }

  if (sectionRecording) sectionLastAt = 0;
  if (drivenPathLine) drivenPathLastAt = 0;
  startWatching();
});

document.getElementById('followLocationBtn').style.display = 'flex';
document.getElementById('pinMapBtn').style.display = 'flex';
document.getElementById('navigateModeBtn').style.display = showNavBtnPref ? 'flex' : 'none';
document.getElementById('heatmapBtn').style.display = showHeatmapBtnPref ? 'flex' : 'none';
document.getElementById('mainMapCompass').style.display = 'flex';

const NavigatePanelControl = L.Control.extend({
  options:{ position:'topleft' },
  onAdd(){
    const panel = document.getElementById('navigatePanel');
    L.DomEvent.disableClickPropagation(panel);
    return panel;
  }
});
new NavigatePanelControl().addTo(map);

let proximityCircle = null;

function isReportReady() {
  if (!currentSession || !currentProfile) return false;
  if (hasReliableGps()) return true;
  if (!pinMode || !manualCoords) return false;
  if (currentProfile.is_admin) return true;
  return !!userCoords && distMeters(userCoords, manualCoords) <= REPORT_PROXIMITY_MAX_M;
}
function updateReportFabState() {
  const notReady = !isReportReady();
  const btn = document.getElementById('reportFabBtn');
  if (btn) btn.disabled = notReady;
  const walkBtn = document.getElementById('walkQuickFabBtn');
  if (walkBtn) walkBtn.disabled = notReady;
}

function updateProximityUi() {
  updateReportFabState();
  renderWizDuplicateNotice();
  const isAdmin = !!(currentProfile && currentProfile.is_admin);
  const inOwnDomain = isAdmin && isMunicipalityInAdminDomain(manualPinMunicipality);
  const indicator = document.getElementById('proximityIndicator');
  const active = !isAdmin && !inOwnDomain && pinMode && manualCoords;

  if (!active) {
    if (proximityCircle) { map.removeLayer(proximityCircle); proximityCircle = null; }
    if (indicator) indicator.style.display = 'none';
    return;
  }

  const hasGps = !!userCoords;
  const near = hasGps && distMeters(userCoords, manualCoords) <= REPORT_PROXIMITY_MAX_M;
  const color = near ? UI_COLORS.success : UI_COLORS.danger;

  if (hasGps) {
    if (!proximityCircle) {
      proximityCircle = L.circle([userCoords.lat, userCoords.lon], {
        radius: REPORT_PROXIMITY_MAX_M, color, weight: 2, dashArray: '6 6',
        fillColor: color, fillOpacity: 0.12, interactive: false
      }).addTo(map);
    } else {
      proximityCircle.setLatLng([userCoords.lat, userCoords.lon]);
      proximityCircle.setStyle({ color, fillColor: color });
    }
  } else if (proximityCircle) {
    map.removeLayer(proximityCircle);
    proximityCircle = null;
  }

  if (manualMarker) {
    const el = manualMarker.getElement();
    const img = el && el.querySelector('img.dropped-pin-icon');
    if (img) {
      img.classList.toggle('pin-in-range', hasGps && near);
      img.classList.toggle('pin-out-of-range', hasGps && !near);
    }
  }

  if (indicator) {
    indicator.style.display = 'flex';
    document.getElementById('proximityDot').classList.toggle('near', near);
    document.getElementById('proximityText').textContent = !userCoords
      ? t('waitGps')
      : near
        ? t('proximityInRange')
        : t('proximityTooFar').replace('{d}', Math.round(distMeters(userCoords, manualCoords)));
  }
}

function togglePinMode() {
  pinMode = !pinMode;
  const btn = document.getElementById('pinMapBtn');
  btn.classList.toggle('active', pinMode);
  btn.setAttribute('aria-pressed', pinMode ? 'true' : 'false');

  if (pinMode) {
    clearMarkers();
    toast(t('tapMapToPlacePin'), 'success');
  } else {
    if (manualMarker) { map.removeLayer(manualMarker); manualMarker = null; }
    manualCoords = null;
    manualPinMunicipality = null;
    loadPinsByWindow();
    scheduleMapCenterMunicipalityUpdate();
  }
  updateProximityUi();
  checkFormReady();
}

map.on('click', function(e) {
  if (navPinMode) {
    if (!isValidLatLng(e.latlng.lat, e.latlng.lng)) {
      console.error('Ignored map click with invalid coordinates:', e.latlng);
      toast(t('invalidLocation'), 'error');
      return;
    }
    navPinMode = false;
    const btn = document.getElementById('navigatePinBtn');
    const hint = document.getElementById('navigatePinHint');
    if (btn) btn.classList.remove('active');
    if (hint) hint.style.display = 'none';
    selectDestination(e.latlng.lat, e.latlng.lng, t('navigatePinnedLabel'));
    return;
  }
  if (!pinMode) return;
  if (!isValidLatLng(e.latlng.lat, e.latlng.lng)) {
    console.error('Ignored map click with invalid coordinates:', e.latlng);
    toast(t('invalidLocation'), 'error');
    return;
  }
  manualCoords = { lat: e.latlng.lat, lon: e.latlng.lng };
  if (manualMarker) {
    manualMarker.setLatLng(e.latlng);
  } else {
    manualMarker = L.marker(e.latlng, {
      icon: L.divIcon({
        className: '',
        html: buildDroppedPinHtml(),
        iconSize: [30, 36],
        iconAnchor: [15, 34]
      }),
      interactive: false

    }).addTo(map);
  }
  manualPinMunicipality = null;
  showMunicipalityBoundaryForPoint(manualCoords.lat, manualCoords.lon, manualMarker, 'pin')
    .then(muni => { manualPinMunicipality = muni; updateProximityUi(); })
    .catch(() => {});
  updateProximityUi();
  checkFormReady();
});

// Plain "wait until events stop" debouncing starves completely while driving:
// markerAnimTick recenters the map with map.setView(..., {animate:false}) on every
// animation frame to glide smoothly with the vehicle, and each of those commits its
// own synchronous moveend. A timer that just gets cleared/reset on every moveend
// therefore never actually fires as long as you keep moving — reports, speed-limit
// signs, and utility markers stop refreshing the moment you drive past the bounds
// that were loaded when navigation started, and only catch up once you stop. This
// wrapper keeps the normal "settle" debounce for ordinary panning/zooming, but also
// guarantees the callback fires at least every maxWaitMs regardless of how often
// it's re-triggered, so the map keeps loading in new data as you actually drive.
function debounceWithMaxWait(fn, debounceMs, maxWaitMs) {
  let timer = null;
  let burstStartedAt = null;
  return function scheduled() {
    const now = Date.now();
    if (burstStartedAt === null) burstStartedAt = now;
    if (timer) clearTimeout(timer);
    const delay = Math.max(0, Math.min(debounceMs, maxWaitMs - (now - burstStartedAt)));
    timer = setTimeout(() => {
      timer = null;
      burstStartedAt = null;
      fn();
    }, delay);
  };
}

// During a pinch-zoom (and pan+zoom) gesture, Leaflet can commit real
// zoom/pan changes multiple times per second — each commit fires its own
// synchronous moveend/zoomend. Wiring syncMarkers() straight to
// those events meant it ran a dozen+ times *during* a single gesture,
// repeatedly adding/removing markers from the cluster group and forcing
// Leaflet.markercluster to regroup mid-zoom — that's the flashing/"reports
// disappear then reappear" glitch. Debouncing means we wait for the map to
// actually go quiet (gesture finished, or a plain single zoomend/moveend)
// before touching markers at all — capped by MARKER_SYNC_MAX_WAIT_MS so it
// still runs periodically during a long, continuous drive.
const MARKER_SYNC_SETTLE_MS = 200;
const MARKER_SYNC_MAX_WAIT_MS = 3000;
const runMarkerSyncOnSettle = debounceWithMaxWait(() => syncMarkers(false), MARKER_SYNC_SETTLE_MS, MARKER_SYNC_MAX_WAIT_MS);
function scheduleMarkerSyncOnSettle() {
  if (pinMode) return;
  if (isMapZooming()) return;
  runMarkerSyncOnSettle();
}
map.on('moveend', scheduleMarkerSyncOnSettle);
map.on('zoomend', scheduleMarkerSyncOnSettle);

const VIEWPORT_RELOAD_DEBOUNCE_MS = 400;
const VIEWPORT_RELOAD_MAX_WAIT_MS = 3000;

const runViewportReloadIfNeeded = debounceWithMaxWait(() => {
  if (typeof lastLoadedBBox === 'undefined' || typeof currentViewportBBox !== 'function') return;
  const b = map.getBounds();
  const visible = { minLat: b.getSouthWest().lat, maxLat: b.getNorthEast().lat, minLon: b.getSouthWest().lng, maxLon: b.getNorthEast().lng };
  if (!viewportBBoxContains(lastLoadedBBox, visible)) loadPinsByWindow();
}, VIEWPORT_RELOAD_DEBOUNCE_MS, VIEWPORT_RELOAD_MAX_WAIT_MS);
function scheduleViewportReloadIfNeeded() {
  if (pinMode) return;
  if (isMapZooming()) return;
  runViewportReloadIfNeeded();
}
map.on('moveend', scheduleViewportReloadIfNeeded);
map.on('zoomend', scheduleViewportReloadIfNeeded);

// Bottom bar contacts follow wherever the admin/user is currently looking on
// the map, not just their GPS position -- so panning around to check a
// different neighborhood shows that neighborhood's utility contacts. A
// manually-dropped report pin still wins outright (that's a precise,
// deliberate location pick), and this stays out of the way during
// driving/navigation so it doesn't fight the route-following GPS updates.
const MUNI_CENTER_SETTLE_MS = 400;
const MUNI_CENTER_MAX_WAIT_MS = 3000;
const runMapCenterMunicipalityUpdate = debounceWithMaxWait(() => {
  if (manualCoords) return;
  if (drivingMode || isNavigationActive()) return;
  const center = map.getCenter();
  if (!isValidLatLng(center.lat, center.lng)) return;
  showMunicipalityBoundaryForPoint(center.lat, center.lng, null, 'center');
}, MUNI_CENTER_SETTLE_MS, MUNI_CENTER_MAX_WAIT_MS);
function scheduleMapCenterMunicipalityUpdate() {
  if (pinMode) return;
  if (isMapZooming()) return;
  runMapCenterMunicipalityUpdate();
}
map.on('moveend', scheduleMapCenterMunicipalityUpdate);
map.on('zoomend', scheduleMapCenterMunicipalityUpdate);

const CATEGORY_COLORS = {
  'Water':        '#1e90ff',
  'Electricity':  '#f5c518',
  'Sewage':       '#8b4513',
  'Gas':          '#ff6b35',
  'Heating':      '#b71c1c',
  'Road':         '#6b6b6b',
  'Streetlight':  '#c9a227',
  'Waste':        '#6d8b3a',
  'Walkways':     '#9c8570',
  'BikeLanes':    '#14b8a6',
  'GreenSpaces':  '#3fa34d',
  'Parking':      '#5c6bc0',
  'Suggestion':   '#26a69a',
  'Forest':       '#1b5e20',
  'FarmersMarket':'#c77d1e',
  'Other':        '#8342a1',
};

const CATEGORY_ICONS = {
  'Water':        'water.png',
  'Electricity':  'electricity.png',
  'Sewage':       'sewage.png',
  'Gas':          'gas.png',
  'Heating':      'heating.png',
  'Road':         'road.png',
  'Streetlight':  'streetlight.png',
  'Waste':        'waste.png',
  'Walkways':     'walkways.png',
  'BikeLanes':    'bike_lanes.png',
  'GreenSpaces':  'green_spaces.png',
  'Parking':      'parking.png',
  'Suggestion':   'ui_suggestion.png',
  'Forest':       'forest.png',
  'FarmersMarket':'farmers_market.png',
  'Other':        'ui_other.png',
};
const SUBCATEGORIES = {
  Water: [
    { key:'burst_leak',    en:'Burst pipe / Leak',            sr:'Puknuta cev / Curenje' },
    { key:'no_supply',     en:'No water supply',              sr:'Nema vode' },
    { key:'low_pressure',  en:'Low pressure',                 sr:'Nizak pritisak' },
    { key:'discoloration', en:'Water quality / discoloration',sr:'Kvalitet vode / zamućenost' },
    { key:'other',         en:'Other',                        sr:'Drugo' }
  ],
  Electricity: [
    { key:'outage',       en:'Power outage',                       sr:'Nestanak struje' },
    { key:'exposed_wire', en:'Exposed / damaged wire',             sr:'Oštećen ili otkriven kabl' },
    { key:'transformer',  en:'Transformer / substation issue',     sr:'Kvar na trafostanici' },
    { key:'voltage',      en:'Voltage fluctuation',                sr:'Kolebanje napona' },
    { key:'pole_damage',  en:'Pole damage',                        sr:'Oštećen stub' },
    { key:'other',        en:'Other',                              sr:'Drugo' }
  ],
  Sewage: [
    { key:'blockage', en:'Blockage / overflow',                sr:'Začepljenje / izlivanje' },
    { key:'manhole',  en:'Manhole cover damaged / missing',    sr:'Oštećen ili nedostaje šaht poklopac' },
    { key:'odor',     en:'Bad odor',                           sr:'Neprijatan miris' },
    { key:'other',    en:'Other',                              sr:'Drugo' }
  ],
  Gas: [
    { key:'leak',   en:'Gas leak / smell', sr:'Curenje / miris gasa' },
    { key:'outage', en:'Gas outage',       sr:'Nestanak gasa' },
    { key:'other',  en:'Other',            sr:'Drugo' }
  ],
  Heating: [
    { key:'no_heat',  en:'No heat',           sr:'Nema grejanja' },
    { key:'leak',     en:'Leak',              sr:'Curenje' },
    { key:'low_temp', en:'Low temperature',   sr:'Niska temperatura' },
    { key:'other',    en:'Other',             sr:'Drugo' }
  ],
  Road: [
    { key:'pothole',  en:'Pothole',                          sr:'Rupa na putu' },
    { key:'cracked',  en:'Cracked / damaged pavement',       sr:'Oštećen kolovoz' },
    { key:'signage',  en:'Missing / damaged signage',        sr:'Nedostaje ili oštećena signalizacija' },
    { key:'flooding', en:'Flooding on road',                 sr:'Poplavljen put' },
    { key:'other',    en:'Other',                            sr:'Drugo' }
  ],
  Streetlight: [
    { key:'out',         en:'Light out',   sr:'Ne radi' },
    { key:'flickering',  en:'Flickering',  sr:'Treperi' },
    { key:'pole_damage', en:'Pole damage', sr:'Oštećen stub' },
    { key:'other',       en:'Other',       sr:'Drugo' }
  ],
  Waste: [
    { key:'overflow', en:'Overflowing bin',    sr:'Prepunjena kanta' },
    { key:'missed',   en:'Missed collection',  sr:'Propušteno odnošenje' },
    { key:'dumping',  en:'Illegal dumping',    sr:'Nelegalno odlaganje' },
    { key:'other',    en:'Other',              sr:'Drugo' }
  ],
  Walkways: [
    { key:'cracked_concrete', en:'Cracked concrete',              sr:'Napukao beton' },
    { key:'blocked_path',     en:'Blocked path',                  sr:'Blokirana staza' },
    { key:'missing_ramp',     en:'Missing ramp',                  sr:'Nedostatak rampe' },
    { key:'trip_hazard',      en:'Trip hazard / uneven surface',  sr:'Neravna površina / opasnost od spoticanja' },
    { key:'other',            en:'Other',                         sr:'Drugo' }
  ],
  BikeLanes: [
    { key:'surface_damage',    en:'Surface damage',              sr:'Oštećenje površine staze' },
    { key:'missing_separation',en:'Missing separation',          sr:'Nedostatak fizičke barijere' },
    { key:'faded_markings',    en:'Faded markings',              sr:'Izbledela signalizacija' },
    { key:'blocked_lane',      en:'Blocked by parked vehicles',  sr:'Blokirana parkiranim vozilima' },
    { key:'other',             en:'Other',                       sr:'Drugo' }
  ],
  GreenSpaces: [
    { key:'broken_equipment', en:'Broken equipment',       sr:'Polomljen parkovski inventar' },
    { key:'fallen_trees',     en:'Fallen trees',           sr:'Palo drveće' },
    { key:'overgrown_grass',  en:'Overgrown grass',        sr:'Nepokošena trava' },
    { key:'illegal_dumping',  en:'Illegal dumping / litter',sr:'Nelegalno odlaganje otpada / smeće' },
    { key:'other',            en:'Other',                  sr:'Drugo' }
  ],
  Forest: [
    { key:'illegal_logging', en:'Illegal logging',                  sr:'Nelegalna seča' },
    { key:'fire_hazard',     en:'Fire hazard',                      sr:'Opasnost od požara' },
    { key:'fallen_trees',    en:'Fallen trees blocking trail',      sr:'Palo drveće na stazi' },
    { key:'illegal_dumping', en:'Illegal dumping',                  sr:'Nelegalno odlaganje otpada' },
    { key:'trail_damage',    en:'Damaged trail / markings',         sr:'Oštećena staza / markacija' },
    { key:'other',           en:'Other',                            sr:'Drugo' }
  ],
  FarmersMarket: [
    { key:'hygiene',        en:'Hygiene / cleanliness issue',        sr:'Higijena / čistoća' },
    { key:'overpricing',    en:'Suspected overpricing',              sr:'Sumnja na prekomerne cene' },
    { key:'illegal_vendor', en:'Unregistered / illegal vendor',      sr:'Neregistrovan prodavac' },
    { key:'infrastructure', en:'Damaged stall / infrastructure',     sr:'Oštećen štand / infrastruktura' },
    { key:'parking',        en:'Parking / access issue',             sr:'Problem sa parkingom / pristupom' },
    { key:'other',          en:'Other',                              sr:'Drugo' }
  ],
  Parking: [],
  Suggestion: [],
  Other: []
};
const CATEGORIES_REQUIRING_COMMENT = new Set(['Suggestion']);

const CATEGORIES_SKIPPING_IN_PROGRESS = new Set(['Parking']);
function categorySkipsInProgress(category) { return CATEGORIES_SKIPPING_IN_PROGRESS.has(category); }

const PERSONAL_PROBLEM_CATEGORIES = new Set(['Water', 'Electricity', 'Sewage', 'Gas', 'Heating']);
const PUBLIC_SUBCATEGORY_OVERRIDES = {
  Water:       new Set(['burst_leak']),
  Electricity: new Set(['pole_damage', 'exposed_wire', 'transformer']),
  Sewage:      new Set(['manhole', 'blockage']),
  Gas:         new Set(['leak']),
  Heating:     new Set([]),
};

function reportIsPersonalProblem(report) {
  if (!PERSONAL_PROBLEM_CATEGORIES.has(report.category)) return false;
  const overrides = PUBLIC_SUBCATEGORY_OVERRIDES[report.category];
  if (overrides && report.subcategory && overrides.has(report.subcategory)) return false;
  return true;
}
const STATUS_COLORS = {
  'reported':    '#ff4b4b',
  'in_progress': '#f5a623',
  'fixed':       '#2ecc71',
};
const UI_COLORS = {
  success: '#2ecc71',
  danger: '#ff4b4b',
  dangerStrong: '#7a1f1f',
};
const PRIORITY_COLORS = {
  'low':    '#8a8a86',
  'normal': '#0090ab',
  'high':   '#e63946',
};
function priorityColor(p) { return PRIORITY_COLORS[p] || PRIORITY_COLORS.normal; }
function priorityLabelText(p, langOverride) {
  if (p === 'low')  return t('priorityLow', langOverride);
  if (p === 'high') return t('priorityHigh', langOverride);
  return t('priorityNormal', langOverride);
}
function categoryColor(cat) { return CATEGORY_COLORS[cat] || '#aaaaaa'; }

// Tints a #rrggbb (or #rgb) hex color to rgba(...) at the given alpha —
// used to wash panel backgrounds with a category color without touching
// the base --bg-surface tokens.
function hexToRgba(hex, alpha) {
  if (!hex) return `rgba(170,170,170,${alpha})`;
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const num = parseInt(h, 16);
  const r = (num >> 16) & 255, g = (num >> 8) & 255, b = num & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

// Detail panels used to get a soft category-color wash here. That's been
// removed so .detail-section panels always use the plain theme surface/
// border colors from style.css — no more per-category tinting. Kept as a
// no-op (rather than deleting the call sites) in case this needs to come
// back later.
function detailPanelBg(cat) {
  return '';
}
function categoryIcon(cat)  { return 'icons/reports/' + (CATEGORY_ICONS[cat] || CATEGORY_ICONS.Other); }
function subcategoryIcon(cat, subcat) {
  const group = (typeof WIZ_SUBCATEGORY_ICONS !== 'undefined') ? WIZ_SUBCATEGORY_ICONS[cat] : null;
  const file = group && subcat ? group[subcat] : null;
  return file ? ('icons/reports/' + file) : null;
}

let categoryMarkerFilter = null;

function categoryFilterList() { return Object.keys(CATEGORY_COLORS); }

function isCategoryVisible(cat) {
  return !categoryMarkerFilter || categoryMarkerFilter.has(cat);
}

let statusMarkerFilter = new Set(['reported', 'in_progress', 'fixed']);

const PULSE_STORAGE_KEY = 'ttb_status_pulse';
function getPulseEnabledPref() {
  try { return localStorage.getItem(PULSE_STORAGE_KEY) !== '0'; } catch (e) { return true; }
}
let statusPulseEnabled = getPulseEnabledPref();
function setPulseEnabled(enabled) {
  statusPulseEnabled = enabled;
  try { localStorage.setItem(PULSE_STORAGE_KEY, enabled ? '1' : '0'); } catch (e) {}
  syncMarkers(true);
}

function isStatusVisible(status) {
  return statusMarkerFilter.has(status);
}

function onStatusFilterToggle(status) {
  if (statusMarkerFilter.has(status)) statusMarkerFilter.delete(status);
  else statusMarkerFilter.add(status);

  const idByStatus = { reported: 'legendItemReported', in_progress: 'legendItemInProgress', fixed: 'legendItemFixed' };
  const el = document.getElementById(idByStatus[status]);
  if (el) el.classList.toggle('status-off', !isStatusVisible(status));

  renderStatusFilterSettings();
  syncMarkers(true);
  refreshHeatLayer();
}

const STATUS_FILTER_SETTINGS_OPTS = [
  { status: 'reported',    color: '#ff4b4b',         labelKey: 'statusReported' },
  { status: 'in_progress', color: '#f5a623',         labelKey: 'statusInProgress' },
  { status: 'fixed',       color: 'var(--success)',  labelKey: 'statusFixed' },
];
function renderStatusFilterSettings() {
  const seg = document.getElementById('statusFilterSettingsSegment');
  if (!seg) return;
  seg.innerHTML = STATUS_FILTER_SETTINGS_OPTS.map(o => `
    <button type="button" class="theme-segment-btn status-filter-settings-btn${isStatusVisible(o.status) ? ' active' : ''}" onclick="onStatusFilterToggle('${o.status}')">
      <span class="legend-badge" style="background:${o.color}"></span> ${escapeHtml(t(o.labelKey))}
    </button>`).join('');
}

function populateCategoryFilterList() {
  const el = document.getElementById('categoryFilterList');
  if (!el) return;
  el.innerHTML = categoryFilterList().map(cat => {
    const checked = isCategoryVisible(cat);
    return `
    <label class="cat-filter-row">
      <input type="checkbox" ${checked ? 'checked' : ''} data-cat="${cat}" onchange="onCategoryFilterToggle('${cat}', this.checked)">
      <span class="cat-filter-dot" style="background:${categoryColor(cat)}"></span>
      <span>${escapeHtml(translateCategory(cat))}</span>
    </label>`;
  }).join('');
  const allBox = document.getElementById('categoryFilterAll');
  if (allBox) allBox.checked = categoryMarkerFilter === null;
}

function updateCategoryFilterBtnState() {
  const dot = document.getElementById('mapFilterActiveDot');
  if (dot) dot.style.display = categoryMarkerFilter !== null ? 'block' : 'none';
}

function applyCategoryFilterChange() {
  syncMarkers(true);
  refreshHeatLayer();
  updateCategoryFilterBtnState();
}

function onCategoryFilterAllToggle(checked) {
  categoryMarkerFilter = checked ? null : new Set();
  document.querySelectorAll('#categoryFilterList input[type=checkbox]').forEach(cb => { cb.checked = checked; });
  applyCategoryFilterChange();
}

function onCategoryFilterToggle(cat, checked) {
  if (categoryMarkerFilter === null) categoryMarkerFilter = new Set(categoryFilterList());
  if (checked) categoryMarkerFilter.add(cat); else categoryMarkerFilter.delete(cat);
  const allBox = document.getElementById('categoryFilterAll');
  if (allBox) allBox.checked = categoryMarkerFilter.size === categoryFilterList().length;
  applyCategoryFilterChange();
}

function toggleCategoryFilterModal() {
  populateCategoryFilterList();
  const modal = document.getElementById('categoryFilterModal');
  bringModalToFront(modal);
  modal.style.display = 'flex';
  openOverlay('categoryFilterModal', hideCategoryFilterModal);
}
function hideCategoryFilterModal() {
  document.getElementById('categoryFilterModal').style.display = 'none';
  closeOverlay('categoryFilterModal');
}

let heatmapActive = false;
let heatLayer = null;

function getHeatPoints() {
  const pts = [];
  globalActiveData.forEach(r => {
    if (!isCategoryVisible(r.category)) return;
    if (!isStatusVisible(r.status)) return;
    if (isSectionReport(r)) {
      sanitizePath(r.path).forEach(([lat, lon]) => pts.push([lat, lon, 0.45]));
    } else if (isValidLatLng(r.latitude, r.longitude)) {
      pts.push([r.latitude, r.longitude, 1]);
    }
  });
  return pts;
}

function buildHeatLayer() {
  return L.heatLayer(getHeatPoints(), {
    radius: 26, blur: 20, maxZoom: 17, minOpacity: 0.35,
    gradient: { 0.2:'#1e90ff', 0.4:'#2ecc71', 0.6:'#f5d33f', 0.8:'#f5a623', 1.0:'#e74c3c' }
  });
}

function refreshHeatLayer() {
  if (!heatmapActive) return;
  if (heatLayer) map.removeLayer(heatLayer);
  heatLayer = buildHeatLayer().addTo(map);
}

function toggleHeatmap() {
  heatmapActive = !heatmapActive;
  const btn = document.getElementById('heatmapBtn');
  if (heatmapActive) {
    if (map.hasLayer(pinCluster)) map.removeLayer(pinCluster);
    if (map.hasLayer(companyMarkersLayer)) map.removeLayer(companyMarkersLayer);
    heatLayer = buildHeatLayer().addTo(map);
    btn.classList.add('active');
    btn.setAttribute('aria-pressed', 'true');
  } else {
    if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
    if (!map.hasLayer(pinCluster)) map.addLayer(pinCluster);
    if (!map.hasLayer(companyMarkersLayer)) map.addLayer(companyMarkersLayer);
    btn.classList.remove('active');
    btn.setAttribute('aria-pressed', 'false');
  }
}

// Labels come from the languages/<code>.json files (keys "cat<Cat>" and
// "sub_<Cat>_<key>"), same t()-driven system as the rest of the UI/emails —
// this is what makes adding a new language a translation-only change instead
// of a code change. SUBCATEGORIES itself still supplies the canonical list
// of keys/ordering per category; only the *label* text now comes from t().
function subcategoryLabel(cat, subKey, langOverride) {
  if (!subKey) return '';
  const list = SUBCATEGORIES[cat] || [];
  const found = list.find(s => s.key === subKey);
  return found ? t(`sub_${cat}_${subKey}`, langOverride) : subKey;
}
function populateSubcategoryOptions(selectEl, cat, selectedKey) {
  const list = SUBCATEGORIES[cat] || [];
  if (!list.length) {
    selectEl.innerHTML = '';
    return false;
  }
  const placeholder = t('subcategoryDetailPlaceholder');
  selectEl.innerHTML = `<option value="">${placeholder}</option>` +
    list.map(s => `<option value="${s.key}" ${s.key === selectedKey ? 'selected' : ''}>${t(`sub_${cat}_${s.key}`)}</option>`).join('');
  return true;
}
function onCategoryChange() {
  const cat = document.getElementById('category').value;
  const subSelect = document.getElementById('subcategory');
  const subRow = document.getElementById('subcategoryRow');
  const hasSubs = populateSubcategoryOptions(subSelect, cat, null);
  subRow.style.display = hasSubs ? 'flex' : 'none';
  updateCommentPlaceholder();
  checkFormReady();
}
function updateCommentPlaceholder() {
  const cat = document.getElementById('category').value;
  const el = document.getElementById('comment');
  if (el) el.placeholder = CATEGORIES_REQUIRING_COMMENT.has(cat) ? t('commentPHRequired') : t('commentPH');
}
function statusColor(s)     { return STATUS_COLORS[s] || '#aaaaaa'; }
function statusLabel(s, langOverride) {
  if (s === 'in_progress') return t('statusInProgress', langOverride);
  if (s === 'fixed') return t('statusFixed', langOverride);
  return t('statusReported', langOverride);
}
function translateCategory(cat, langOverride) {
  return t(`cat${cat}`, langOverride) || cat;
}

// Used for free-text search matching (map search, company category chips) —
// deliberately searches every *loaded* language's label, not just the
// active one, so a report still matches if someone searches in a language
// other than the one it happens to be displayed in.
function categorySearchText(cat) {
  const seen = new Set();
  const parts = [cat];
  for (const code of Object.keys(LANG_STRINGS)) {
    const label = LANG_STRINGS[code] && LANG_STRINGS[code][`cat${cat}`];
    if (label && !seen.has(label)) { seen.add(label); parts.push(label); }
  }
  return parts.filter(Boolean).join(' ');
}

function checkFormReady() {
  const category = document.getElementById('category').value;
  const priority = document.getElementById('priority').value;
  const hasLoc = !!(userCoords || manualCoords);
  const isAuthed = !!(currentSession && currentProfile);
  const commentOk = !CATEGORIES_REQUIRING_COMMENT.has(category) || document.getElementById('comment').value.trim().length > 0;
  document.getElementById('reportBtn').disabled = !(category && priority && hasLoc && isAuthed && commentOk);
}

// Photos live in a Cloudflare R2 bucket, brokered by a small Worker (see
// /worker in the repo) — Supabase only stores the object *path* string in
// photo_path / after_photo_path, same as before. Set this once you've run
// `wrangler deploy` (see worker/README.md).
const PHOTO_WORKER_URL = 'https://tracethebreak-photos.tracethestuff.workers.dev';
const REPORT_PHOTO_MAX_DIMENSION = 1024;
const REPORT_PHOTO_MIN_DIMENSION = 640; // floor for the dimension-shrink fallback pass
const REPORT_PHOTO_TARGET_BYTES = 160 * 1024; // aim for this size before giving up
const REPORT_PHOTO_QUALITY_STEPS = [0.62, 0.5, 0.4, 0.3]; // tried in order until target hit
const REPORT_PHOTO_MAX_INPUT_BYTES = 15 * 1024 * 1024;
const REPORT_PHOTO_SIGNED_URL_TTL = 3600; // 1h — click-to-open full size / share-image source
const REPORT_PHOTO_DISPLAY_URL_TTL = 21600; // 6h — the size shown inline in the detail modal
const REPORT_PHOTO_THUMB_URL_TTL = 21600; // 6h — list/queue thumbnails
// Thumbnail generated client-side at upload time (160x160 cover-crop),
// stored as a second, tiny object alongside the main photo. This replaces
// the on-the-fly resize Supabase Storage used to do — R2 has no free
// equivalent, so we just make the small version once, up front.
const REPORT_PHOTO_THUMB_SIZE = 160;
const REPORT_PHOTO_THUMB_QUALITY = 0.6;

function thumbPathFor(path) {
  return path.replace(/(\.[a-zA-Z0-9]+)$/, '-thumb$1');
}

async function photoAuthHeaders(extra) {
  // Always refresh first: currentSession can hold a token that already
  // expired (e.g. tab left open/backgrounded past the ~1h JWT lifetime and
  // supabase-js's background refresh timer hasn't caught up yet). Sending
  // that stale token gives the Worker a correct 401 (it checks payload.exp
  // itself). ensureFreshSession() forces a getSession() call, which
  // transparently refreshes the token via Supabase's refresh_token if needed.
  const session = await ensureFreshSession();
  const token = session && session.access_token;
  return Object.assign({ authorization: token ? `Bearer ${token}` : '' }, extra || {});
}

// Uploads one object (main photo or its thumbnail) through the Worker.
// Throws on failure so callers can decide how to react.
async function uploadPhotoObject(path, blob, contentType) {
  const res = await fetch(`${PHOTO_WORKER_URL}/upload?path=${encodeURIComponent(path)}`, {
    method: 'POST',
    headers: await photoAuthHeaders({ 'content-type': contentType }),
    body: blob
  });
  if (!res.ok) throw new Error(`upload failed (${res.status})`);
}

// Uploads the main photo and its thumbnail together.
async function uploadPhotoWithThumb(path, blob, thumbBlob, ext) {
  const contentType = reportPhotoContentType(ext);
  await uploadPhotoObject(path, blob, contentType);
  if (thumbBlob) {
    try { await uploadPhotoObject(thumbPathFor(path), thumbBlob, contentType); }
    catch (e) { console.error('Thumbnail upload failed (non-fatal):', e.message || e); }
  }
}

// Deletes a photo's main object and its thumbnail. Best-effort, like the
// old sb.storage.remove() calls this replaces.
async function deletePhotoObject(path) {
  if (!path) return;
  fetch(`${PHOTO_WORKER_URL}/upload?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
    headers: await photoAuthHeaders()
  }).catch(() => {});
}

// Note: thumb/display resizing used to be a Supabase Storage on-the-fly
// transform requested per-URL. R2 has no free equivalent, so the "thumb"
// variant now just points at a separate, pre-shrunk object made client-side
// at upload time (see makeCoverThumb / REPORT_PHOTO_THUMB_SIZE above). The
// "display" variant currently just serves the same ~1024px main object as
// "full" — it's already small since compressReportPhoto targets ~160KB.

// Detected once and reused — canvas.toBlob('image/webp', q) silently
// produces a PNG on browsers that can't encode WebP, so we can't just try
// it and hope; we probe once at load and fall back to JPEG everywhere if
// it's not supported.
let reportPhotoWebpSupportedPromise = null;
function reportPhotoWebpSupported() {
  if (!reportPhotoWebpSupportedPromise) {
    reportPhotoWebpSupportedPromise = new Promise(resolve => {
      try {
        const c = document.createElement('canvas');
        c.width = 1; c.height = 1;
        c.toBlob(blob => resolve(!!blob && blob.type === 'image/webp'), 'image/webp');
      } catch (e) {
        resolve(false);
      }
    });
  }
  return reportPhotoWebpSupportedPromise;
}

let pendingReportPhotoBlob = null;
let pendingReportPhotoPreviewUrl = null;

// Encodes canvas -> blob at a given quality, wrapped in a promise.
function canvasToBlobAsync(canvas, mimeType, quality) {
  return new Promise(resolve => canvas.toBlob(resolve, mimeType, quality));
}

// Cover-crops `img` to a square and resizes it down to `size`x`size` —
// the same "resize: cover" semantics Supabase's transform used to give us
// for thumbnails, done once client-side instead of on every request.
async function makeCoverThumb(img, size, mimeType, quality) {
  const srcSize = Math.min(img.width, img.height);
  const sx = (img.width - srcSize) / 2;
  const sy = (img.height - srcSize) / 2;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  canvas.getContext('2d').drawImage(img, sx, sy, srcSize, srcSize, 0, 0, size, size);
  return canvasToBlobAsync(canvas, mimeType, quality);
}

// Compresses an uploaded photo as hard as reasonably possible while
// staying legible: prefers WebP (25-35% smaller than JPEG at the same
// visual quality) with a JPEG fallback, tries progressively lower quality
// steps to hit a target byte size, and — if still oversized at the lowest
// quality step — shrinks the dimensions further and retries once. Also
// produces a small cover-cropped thumbnail from the same decoded image, so
// callers can upload both in one go. Returns { blob, ext, thumbBlob } so
// callers can pick the right storage extension/contentType.
async function compressReportPhoto(file) {
  if (!file.type || !file.type.startsWith('image/')) throw new Error('not-an-image');
  if (file.size > REPORT_PHOTO_MAX_INPUT_BYTES) throw new Error('too-large');

  const objectUrl = URL.createObjectURL(file);
  let img;
  try {
    img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('decode-failed'));
      i.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }

  const useWebp = await reportPhotoWebpSupported();
  const mimeType = useWebp ? 'image/webp' : 'image/jpeg';
  const ext = useWebp ? 'webp' : 'jpg';

  let dimension = REPORT_PHOTO_MAX_DIMENSION;
  let best = null;

  for (let pass = 0; pass < 2; pass++) {
    const scale = Math.min(1, dimension / Math.max(img.width, img.height));
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);

    for (const quality of REPORT_PHOTO_QUALITY_STEPS) {
      const blob = await canvasToBlobAsync(canvas, mimeType, quality);
      if (!blob) continue;
      if (!best || blob.size < best.size) best = blob;
      if (blob.size <= REPORT_PHOTO_TARGET_BYTES) {
        const thumbBlob = await makeCoverThumb(img, REPORT_PHOTO_THUMB_SIZE, mimeType, REPORT_PHOTO_THUMB_QUALITY).catch(() => null);
        return { blob, ext, thumbBlob };
      }
    }
    if (dimension <= REPORT_PHOTO_MIN_DIMENSION) break;
    dimension = Math.max(REPORT_PHOTO_MIN_DIMENSION, Math.round(dimension * 0.75));
  }

  if (!best) throw new Error('encode-failed');
  const thumbBlob = await makeCoverThumb(img, REPORT_PHOTO_THUMB_SIZE, mimeType, REPORT_PHOTO_THUMB_QUALITY).catch(() => null);
  return { blob: best, ext, thumbBlob };
}

function triggerReportPhotoCamera() {
  document.getElementById('reportPhotoInputCamera').click();
}
function triggerReportPhotoGallery() {
  document.getElementById('reportPhotoInputLibrary').click();
}

// Saves a copy of a freshly-taken report photo to the device itself (as a
// normal browser download), separate from whatever gets uploaded with the
// report. This is only for camera captures — a gallery pick already lives
// on the device, so there's nothing to save. Fire-and-forget: this must
// never block or fail the report photo flow above it.
function saveCapturedPhotoToDevice(file) {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const extMatch = /\.[a-zA-Z0-9]+$/.exec(file.name || '');
    const ext = extMatch ? extMatch[0] : (file.type === 'image/png' ? '.png' : '.jpg');
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = `TraceTheBreak-${ts}${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Give the browser a moment to actually start the download before
    // revoking the object URL out from under it.
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (err) {
    console.error('Saving captured photo to device failed:', err.message || err);
  }
}

async function onReportPhotoSelected(inputEl) {
  const file = inputEl.files && inputEl.files[0];
  const fromCamera = inputEl.id === 'reportPhotoInputCamera';
  inputEl.value = '';
  if (!file) return;
  if (fromCamera) saveCapturedPhotoToDevice(file);
  try {
    const { blob, ext, thumbBlob } = await compressReportPhoto(file);
    setPendingReportPhoto(blob, ext, thumbBlob);
  } catch (err) {
    console.error('Photo processing failed:', err.message || err);
    toast(t('reportPhotoInvalid'), 'error');
  }
}

let pendingReportPhotoExt = 'jpg';
let pendingReportPhotoThumbBlob = null;

function setPendingReportPhoto(blob, ext, thumbBlob) {
  clearPendingReportPhotoPreviewUrl();
  pendingReportPhotoBlob = blob;
  pendingReportPhotoExt = ext || 'jpg';
  pendingReportPhotoThumbBlob = thumbBlob || null;
  pendingReportPhotoPreviewUrl = URL.createObjectURL(blob);
  const img = document.getElementById('reportPhotoPreviewImg');
  const preview = document.getElementById('reportPhotoPreview');
  const dropdown = document.getElementById('reportPhotoDropdown');
  if (img) img.src = pendingReportPhotoPreviewUrl;
  if (preview) preview.style.display = 'flex';
  if (dropdown) dropdown.style.display = 'none';
}

function clearPendingReportPhotoPreviewUrl() {
  if (pendingReportPhotoPreviewUrl) {
    URL.revokeObjectURL(pendingReportPhotoPreviewUrl);
    pendingReportPhotoPreviewUrl = null;
  }
}

function removePendingReportPhoto() {
  clearPendingReportPhotoPreviewUrl();
  pendingReportPhotoBlob = null;
  pendingReportPhotoThumbBlob = null;
  const preview = document.getElementById('reportPhotoPreview');
  const dropdown = document.getElementById('reportPhotoDropdown');
  if (preview) preview.style.display = 'none';
  if (dropdown) dropdown.style.display = '';
}

// Paths are version-stamped below (a fresh token per upload) specifically
// so the Worker can set a long, non-revalidating Cache-Control on every
// object: a content change always gets a new path rather than overwriting
// the old one in place, so a cached URL can never later resolve to
// different bytes.
function reportPhotoContentType(ext) {
  return ext === 'webp' ? 'image/webp' : 'image/jpeg';
}

// Short, time-based token so repeated uploads to "the same" report photo
// slot land on a new object path instead of overwriting the old one. That
// makes every URL we ever sign for a given path permanently valid for its
// content, which is what lets us set a year-long, non-revalidating
// Cache-Control on it safely.
function reportPhotoVersionToken() {
  return Date.now().toString(36);
}

async function uploadReportPhoto(reportId, blob, ext, thumbBlob) {
  try {
    const path = `${currentSession.user.id}/${reportId}_${reportPhotoVersionToken()}.${ext || 'jpg'}`;
    await uploadPhotoWithThumb(path, blob, thumbBlob, ext);
    const { error: updateError } = await sb.from(TABLE).update({
      photo_path: path,
      photo_status: 'pending',
      photo_uploaded_at: new Date().toISOString()
    }).eq('id', reportId);
    if (updateError) throw updateError;
  } catch (err) {
    console.error('Photo upload failed:', err.message || err);
    toast(t('reportPhotoUploadFailed'), 'error');
  }
}

async function addPhotoToReport(reportId) {
  const file = await pickReportPhotoSource();
  if (!file) return;
  let blob, ext, thumbBlob;
  try {
    ({ blob, ext, thumbBlob } = await compressReportPhoto(file));
  } catch (err) {
    console.error('Photo processing failed:', err.message || err);
    toast(t('reportPhotoInvalid'), 'error');
    return;
  }
  const ok = await uploadOrReplaceReportPhoto(reportId, blob, ext, thumbBlob);
  if (ok) refreshReportViews(reportId);
}

async function uploadOrReplaceReportPhoto(reportId, blob, ext, thumbBlob) {
  const report = globalActiveData.find(r => r.id === reportId);
  try {
    const previousPath = report && report.photo_path;
    const path = `${currentSession.user.id}/${reportId}_${reportPhotoVersionToken()}.${ext || 'jpg'}`;
    await uploadPhotoWithThumb(path, blob, thumbBlob, ext);
    // Only remove the old object once the new one is safely stored, so a
    // failed upload never leaves a report with no photo at all.
    if (previousPath && previousPath !== path) {
      deletePhotoObject(previousPath);
      reportPhotoUrlCache.delete(`${previousPath}::full`);
      reportPhotoUrlCache.delete(`${previousPath}::display`);
      reportPhotoUrlCache.delete(`${previousPath}::thumb`);
    }
    const patch = {
      photo_path: path,
      photo_status: 'pending',
      photo_uploaded_at: new Date().toISOString(),
      flagged_for_review: false
    };
    const { error: updateError } = await sb.from(TABLE).update(patch).eq('id', reportId);
    if (updateError) throw updateError;
    toast(t('photoAddedPending'), 'success');
    await loadPinsByWindow();
    return true;
  } catch (err) {
    console.error('Photo upload failed:', err.message || err);
    toast(t('reportPhotoUploadFailed'), 'error');
    return false;
  }
}

async function addAfterPhotoToReport(reportId) {
  const file = await pickReportPhotoSource();
  if (!file) return;
  let blob, ext, thumbBlob;
  try {
    ({ blob, ext, thumbBlob } = await compressReportPhoto(file));
  } catch (err) {
    console.error('After-photo processing failed:', err.message || err);
    toast(t('reportPhotoInvalid'), 'error');
    return;
  }
  const ok = await uploadAfterReportPhoto(reportId, blob, ext, thumbBlob);
  if (ok) refreshReportViews(reportId);
}

async function uploadAfterReportPhoto(reportId, blob, ext, thumbBlob) {
  const report = globalActiveData.find(r => r.id === reportId);
  try {
    const previousPath = report && report.after_photo_path;
    const path = `${currentSession.user.id}/${reportId}_after_${reportPhotoVersionToken()}.${ext || 'jpg'}`;
    await uploadPhotoWithThumb(path, blob, thumbBlob, ext);
    if (previousPath && previousPath !== path) {
      deletePhotoObject(previousPath);
      reportPhotoUrlCache.delete(`${previousPath}::full`);
      reportPhotoUrlCache.delete(`${previousPath}::display`);
      reportPhotoUrlCache.delete(`${previousPath}::thumb`);
    }
    const patch = {
      after_photo_path: path,
      after_photo_status: 'pending',
      after_photo_uploaded_at: new Date().toISOString()
    };
    const { error: updateError } = await sb.from(TABLE).update(patch).eq('id', reportId);
    if (updateError) throw updateError;
    toast(t('afterPhotoAddedPending'), 'success');
    await loadPinsByWindow();
    return true;
  } catch (err) {
    console.error('After-photo upload failed:', err.message || err);
    toast(t('reportPhotoUploadFailed'), 'error');
    return false;
  }
}

const REPORT_GALLERY_TABLE = 'report_gallery_photos';

async function loadReportGalleryPhotos(reportId) {
  try {
    const { data, error } = await sb.from(REPORT_GALLERY_TABLE)
      .select('*')
      .eq('report_id', reportId)
      .order('created_at', { ascending: false })
      .limit(30);
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error('Failed to load gallery photos:', err.message || err);
    return null;
  }
}

async function renderReportGallery(reportId) {
  const strip = document.getElementById('detailGalleryStrip');
  if (!strip) return;
  const photos = await loadReportGalleryPhotos(reportId);
  if (photos === null) { strip.innerHTML = `<div class="detail-empty">${t('photoLoadFailed')}</div>`; return; }
  if (!photos.length) { strip.innerHTML = `<div class="detail-empty">${t('galleryEmpty')}</div>`; return; }
  strip.innerHTML = photos.map(p => `
    <div class="detail-gallery-item" id="gallery-item-${p.id}">
      <div class="detail-loading" style="width:88px;height:88px;display:flex;align-items:center;justify-content:center;">${t('detailLoading')}</div>
      <div class="detail-gallery-caption">
        <div class="detail-gallery-caption-name">${escapeHtml(p.uploader_username || t('detailUnknown'))}</div>
        <div class="detail-gallery-caption-date">${formatDate(p.created_at)}</div>
      </div>
    </div>`).join('');
  photos.forEach(p => {
    getReportPhotoSignedUrl(p.photo_path, null, 'thumb').then(url => {
      const item = document.getElementById(`gallery-item-${p.id}`);
      if (!item) return;
      const canDelete = !!currentSession && (currentSession.user.id === p.uploader_id || (currentProfile && currentProfile.is_admin));
      const deleteBtn = canDelete ? `<button type="button" class="detail-gallery-delete" onclick="deleteGalleryPhoto('${p.id}','${escapeHtml(p.photo_path)}','${reportId}')" aria-label="${t('deleteBtn')}" title="${t('deleteBtn')}">✕</button>` : '';
      const thumbHtml = url
        ? `<img src="${url}" alt="${t('photoViewFullSize')}" class="detail-gallery-thumb" role="button" tabindex="0" onclick="openFullSizeReportPhoto('${escapeHtml(p.photo_path)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openFullSizeReportPhoto('${escapeHtml(p.photo_path)}');}">${deleteBtn}`
        : `<div class="detail-empty">${t('photoLoadFailed')}</div>`;
      const caption = item.querySelector('.detail-gallery-caption');
      item.innerHTML = thumbHtml + (caption ? caption.outerHTML : '');
    });
  });
}

async function loadReportContactEventsForTimeline(reportId) {
  try {
    const { data, error } = await sb.from(REPORT_CONTACT_EVENTS_TABLE)
      .select('contact_type, created_at')
      .eq('report_id', reportId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error('Failed to load contact events for timeline:', err.message || err);
    return [];
  }
}

async function loadReportStatusVotesForTimeline(reportId) {
  try {
    const { data, error } = await sb.from(REPORT_STATUS_VOTES_TABLE)
      .select('suggested_status, created_at')
      .eq('report_id', reportId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error('Failed to load status votes for timeline:', err.message || err);
    return [];
  }
}

// Same as buildTimelineEventItem, but tagged so a later refresh can find
// and remove just these entries (see refreshDetailTimelineExtras) without
// touching the pipeline-stage / company-notify entries above them.
function buildTimelineExtraItem(dateStr, rightHtml) {
  return buildTimelineEventItem(dateStr, rightHtml).replace('class="timeline-item ', 'class="timeline-item timeline-extra ');
}

// Inserts the "extra" timeline entries — duplicate-report confirmations,
// company notify (+ reminder), gallery photos, and logged phone/email
// contact attempts — right after the current pipeline stage and before
// any not-yet-reached (pending) stage placeholder, via the anchor marker
// left in the timeline by buildDetailStatusReadonlyHtml. That's what keeps
// new things appearing below the latest real status change instead of at
// the very bottom under the "—" placeholders for stages that haven't
// happened yet.
// report.company_notified_at / photo_uploaded_at / after_photo_uploaded_at
// are already on the report row, so those go straight in without waiting
// on a fetch; confirmations come from the already-computed duplicate group
// (each other report in the group is one "confirmed" event, at its own
// created_at); gallery photos and contact events need a fetch. Sorted
// chronologically among themselves. No usernames, just date + icon/text,
// same privacy-light footprint as the rest of the timeline.
async function loadDetailTimelineExtras(report) {
  const events = companyNotifyTimelineEvents(report);
  const dupGroup = duplicateGroupFor(report.id);
  if (dupGroup) {
    dupGroup.ids.filter(id => id !== report.id).forEach(id => {
      const confirmingReport = globalActiveData.find(r => r.id === id);
      if (confirmingReport) {
        events.push({ time: confirmingReport.created_at, html: buildTimelineExtraItem(confirmingReport.created_at, `<span class="timeline-note">${t('timelineDuplicateConfirmedLabel') || 'Confirmed duplicate'}</span><img class="detail-row-icon" src="icons/check.png" alt="">`) });
      }
    });
  }
  if (report.photo_uploaded_at) {
    events.push({ time: report.photo_uploaded_at, html: buildTimelineExtraItem(report.photo_uploaded_at, `<span class="timeline-note">${t('timelinePhotoAddedLabel') || 'Photo added'}</span><img class="detail-row-icon" src="icons/camera.png" alt="">`) });
  }
  if (report.after_photo_uploaded_at) {
    events.push({ time: report.after_photo_uploaded_at, html: buildTimelineExtraItem(report.after_photo_uploaded_at, `<span class="timeline-note">${t('timelineAfterPhotoAddedLabel') || 'After photo added'}</span><img class="detail-row-icon" src="icons/camera.png" alt="">`) });
  }

  const [galleryPhotos, contactEvents, statusVotes] = await Promise.all([
    loadReportGalleryPhotos(report.id),
    loadReportContactEventsForTimeline(report.id),
    loadReportStatusVotesForTimeline(report.id)
  ]);
  (galleryPhotos || []).forEach(p => {
    events.push({ time: p.created_at, html: buildTimelineExtraItem(p.created_at, `<span class="timeline-note">${t('timelinePhotoAddedLabel') || 'Photo added'}</span><img class="detail-row-icon" src="icons/camera.png" alt="">`) });
  });
  contactEvents.forEach(c => {
    const isEmail = c.contact_type === 'email';
    const icon = isEmail ? 'icons/email.png' : 'icons/phone.png';
    const label = isEmail ? (t('timelineContactEmailLabel') || 'Email contact logged') : (t('timelineContactCallLabel') || 'Phone contact logged');
    events.push({ time: c.created_at, html: buildTimelineExtraItem(c.created_at, `<span class="timeline-note">${label}</span><img class="detail-row-icon" src="${icon}" alt="">`) });
  });
  statusVotes.forEach(v => {
    const voteLabel = (t('timelineVoteLabelPrefix') || 'Suggested') + ': ' + escapeHtml(statusLabel(v.suggested_status));
    events.push({ time: v.created_at, html: buildTimelineExtraItem(v.created_at, `<span class="timeline-note">${voteLabel}</span><img class="detail-row-icon" src="icons/vote.png" alt="">`) });
  });

  if (!events.length) return;
  events.sort((a, b) => new Date(a.time) - new Date(b.time));

  // The modal may have been closed, or switched to a different report,
  // while these fetches were in flight — bail rather than write into a
  // stale/gone timeline.
  const modal = document.getElementById('reportDetailModal');
  if (!modal || modal.dataset.openReportId !== report.id) return;
  const container = document.getElementById(`detailTimeline-${report.id}`);
  const anchor = document.getElementById(`detailTimelineAnchor-${report.id}`);
  if (!container || !anchor) return;
  events.forEach(e => insertTimelineEventChronologically(container, anchor, e));
}

// Inserts a single {time, html} timeline entry at its correct chronological
// slot among the pipeline-stage entries (reported/in_progress/fixed) and any
// extras already in the timeline — instead of always dropping it right after
// the anchor, which broke ordering whenever an extra (e.g. "sent to
// company") happened earlier than a later-reached pipeline stage (e.g.
// "fixed"). Every reached item (pipeline or extra) carries a data-time
// attribute, so we walk those in DOM order and insert before the first one
// that's chronologically later; if none is later, the event goes right
// before the anchor, which still keeps it ahead of any not-yet-reached
// (pending) placeholders. Ties keep existing entries first.
function insertTimelineEventChronologically(container, anchor, event) {
  const eventTime = new Date(event.time).getTime();
  const dated = Array.from(container.querySelectorAll('.timeline-item[data-time]'));
  const insertBeforeEl = dated.find(el => new Date(el.dataset.time).getTime() > eventTime);
  const temp = document.createElement('div');
  temp.innerHTML = event.html;
  const node = temp.firstElementChild;
  if (!node) return;
  (insertBeforeEl || anchor).insertAdjacentElement('beforebegin', node);
}

// Re-fetches and re-renders just the extra timeline entries (company
// notify, gallery photos, contact attempts, votes, stale badge) for
// whichever report the detail modal currently has open — used after
// actions that add one of those without doing a full modal re-render
// (gallery photo add, logging a call/email).
function refreshDetailTimelineExtras(reportId) {
  const modal = document.getElementById('reportDetailModal');
  if (!modal || modal.dataset.openReportId !== reportId) return;
  const report = globalActiveData.find(r => r.id === reportId);
  if (!report) return;
  const container = document.getElementById(`detailTimeline-${reportId}`);
  if (container) container.querySelectorAll('.timeline-extra').forEach(el => el.remove());
  loadDetailTimelineExtras(report);
  renderStaleBadgeForDetail(report);
}

async function addGalleryPhotoToReport(reportId, source) {
  if (!currentSession) { toast(t('signInFirst') || 'Sign in first', 'error'); return; }
  const file = source ? await pickReportPhotoDirect(source) : await pickReportPhotoSource();
  if (!file) return;
  let blob, ext, thumbBlob;
  try {
    ({ blob, ext, thumbBlob } = await compressReportPhoto(file));
  } catch (err) {
    console.error('Gallery photo processing failed:', err.message || err);
    toast(t('reportPhotoInvalid'), 'error');
    return;
  }
  try {
    const path = `gallery/${currentSession.user.id}/${reportId}_${reportPhotoVersionToken()}.${ext || 'jpg'}`;
    await uploadPhotoWithThumb(path, blob, thumbBlob, ext);
    const { error: insertError } = await sb.from(REPORT_GALLERY_TABLE).insert({
      report_id: reportId,
      uploader_id: currentSession.user.id,
      uploader_username: (currentProfile && currentProfile.username) || null,
      photo_path: path
    });
    if (insertError) throw insertError;
    toast(t('galleryPhotoAdded'), 'success');
    renderReportGallery(reportId);
    refreshDetailTimelineExtras(reportId);
  } catch (err) {
    console.error('Gallery photo upload failed:', err.message || err);
    toast(t('reportPhotoUploadFailed'), 'error');
  }
}

async function deleteGalleryPhoto(id, photoPath, reportId) {
  if (!(await themedConfirm(t('galleryPhotoDeleteConfirm')))) return;
  try {
    const { error } = await sb.from(REPORT_GALLERY_TABLE).delete().eq('id', id);
    if (error) throw error;
    deletePhotoObject(photoPath);
    toast(t('galleryPhotoDeleted'), 'success');
    renderReportGallery(reportId);
  } catch (err) {
    console.error('Failed to delete gallery photo:', err.message || err);
    toast(t('photoActionFailed'), 'error');
  }
}

async function maybeOfferAfterPhoto(reportId) {
  const report = globalActiveData.find(r => r.id === reportId);
  if (!currentSession || !report || report.after_photo_path) return;
  const isOwner = report.owner_id === currentSession.user.id;
  const isAdmin = !!(currentProfile && currentProfile.is_admin);
  if (!isOwner && !isAdmin) return;
  if (await themedConfirm(t('afterPhotoPrompt'))) addAfterPhotoToReport(reportId);
}

// Shows an "aging, no activity" entry in a report's Details timeline when
// it's still in the 'reported' state, was created 30+ days ago, and nobody
// has contacted a utility about it or voted on its status since. This used
// to be surfaced as a standing entry in the admin notifications feed; now
// it's only computed on demand for whichever report is currently open, and
// (as of this change) rendered as its own timeline row — dated the day the
// report actually crossed the staleness threshold — rather than as a badge
// glued onto the "Reported" pill, matching how every other timeline extra
// (company notify, photos, contact attempts, votes) gets its own row.
async function renderStaleBadgeForDetail(report) {
  if (report.status !== 'reported') return;
  const staleThresholdMs = STALE_REPORT_DAYS * 24 * 60 * 60 * 1000;
  const ageMs = Date.now() - new Date(report.created_at).getTime();
  if (ageMs < staleThresholdMs) return;
  try {
    const [contactRes, voteRes] = await Promise.all([
      sb.from(REPORT_CONTACT_EVENTS_TABLE).select('report_id').eq('report_id', report.id).limit(1),
      sb.from('report_status_vote_progress').select('report_id').eq('report_id', report.id).limit(1)
    ]);
    if (contactRes.error) throw contactRes.error;
    if (voteRes.error) throw voteRes.error;
    const touched = (contactRes.data && contactRes.data.length) || (voteRes.data && voteRes.data.length);
    if (touched) return;

    // Modal may have closed, or moved to a different report, while the
    // above fetches were in flight — bail rather than write into a
    // stale/gone timeline (and don't double-insert on a second call).
    const modal = document.getElementById('reportDetailModal');
    if (!modal || modal.dataset.openReportId !== report.id) return;
    const container = document.getElementById(`detailTimeline-${report.id}`);
    if (container && container.querySelector('.timeline-stale-badge')) return;
    const anchor = document.getElementById(`detailTimelineAnchor-${report.id}`);
    if (!anchor) return;

    const staleSince = new Date(new Date(report.created_at).getTime() + staleThresholdMs).toISOString();
    const html = buildTimelineExtraItem(staleSince, `<span class="timeline-note timeline-stale-badge">${escapeHtml(t('queueTypeStale'))}</span><img class="detail-row-icon" src="icons/sleep.png" alt="">`);
    anchor.insertAdjacentHTML('afterend', html);
  } catch (err) {
    console.error('Failed to check report staleness:', err.message || err);
  }
}

function refreshReportViews(reportId) {
  const report = globalActiveData.find(r => r.id === reportId);
  if (!report) return;
  const marker = markerById.get(reportId);
  const pin = sectionPinById.get(reportId);
  if (marker) marker.setPopupContent(buildPopupHtml(report));
  if (pin) pin.setPopupContent(buildPopupHtml(report));
  const modal = document.getElementById('reportDetailModal');
  if (modal && modal.style.display === 'flex' && modal.dataset.openReportId === reportId) {
    showReportDetailModal(reportId);
  }
}

// Cache of already-signed photo URLs, keyed by path+variant, so that
// repeated renders (list re-renders, polling refreshes, re-opening the
// same modal) reuse an existing URL instead of asking Storage to sign a
// new one — which would also force the browser to re-download the image,
// since a fresh signed URL always has a different token/cache key. Because
// upload paths are now version-stamped (see reportPhotoVersionToken), a
// given cache key's underlying bytes never change, so it's also safe to
// persist this across page loads in sessionStorage — a reload in the same
// tab reuses the exact same signed URL and gets a free browser-cache hit
// instead of re-signing and re-downloading.
const REPORT_PHOTO_URL_CACHE_STORAGE_KEY = 'ttb_photo_url_cache_v1';
const reportPhotoUrlCache = new Map();
(function hydrateReportPhotoUrlCache() {
  try {
    const raw = sessionStorage.getItem(REPORT_PHOTO_URL_CACHE_STORAGE_KEY);
    if (!raw) return;
    const now = Date.now();
    const entries = JSON.parse(raw);
    for (const [key, val] of entries) {
      if (val && val.expiresAt > now) reportPhotoUrlCache.set(key, val);
    }
  } catch (e) { /* sessionStorage unavailable or corrupt — just skip hydration */ }
})();
let reportPhotoUrlCachePersistScheduled = false;
function persistReportPhotoUrlCache() {
  if (reportPhotoUrlCachePersistScheduled) return;
  reportPhotoUrlCachePersistScheduled = true;
  // Coalesce bursts of sets (e.g. a list rendering 20 thumbs at once) into
  // a single sessionStorage write.
  setTimeout(() => {
    reportPhotoUrlCachePersistScheduled = false;
    try {
      sessionStorage.setItem(REPORT_PHOTO_URL_CACHE_STORAGE_KEY, JSON.stringify([...reportPhotoUrlCache.entries()]));
    } catch (e) { /* quota or unavailable — non-critical, just skip */ }
  }, 0);
}

const REPORT_PHOTO_VARIANT_TTLS = {
  thumb: REPORT_PHOTO_THUMB_URL_TTL,
  display: REPORT_PHOTO_DISPLAY_URL_TTL
};

async function getReportPhotoSignedUrl(path, ttlSeconds, variant) {
  if (!path) return null;
  if (!currentSession) return null; // the Worker requires a logged-in caller, same as before
  const ttl = ttlSeconds || REPORT_PHOTO_VARIANT_TTLS[variant] || REPORT_PHOTO_SIGNED_URL_TTL;
  const cacheKey = `${path}::${variant || 'full'}`;
  const cached = reportPhotoUrlCache.get(cacheKey);
  const now = Date.now();
  // Reuse the cached URL until shortly before it actually expires.
  if (cached && cached.expiresAt - now > 15000) return cached.url;
  try {
    const qs = new URLSearchParams({ path, variant: variant || 'full', ttl: String(ttl) });
    let res = await fetch(`${PHOTO_WORKER_URL}/sign?${qs.toString()}`, { headers: await photoAuthHeaders() });
    if (res.status === 401) {
      // Likely a stale token sent from a backgrounded tab whose refresh
      // timer hadn't caught up yet — force a real refresh and retry once
      // before giving up. (The Worker itself is fine; see photoAuthHeaders.)
      await sb.auth.refreshSession().catch(() => {});
      res = await fetch(`${PHOTO_WORKER_URL}/sign?${qs.toString()}`, { headers: await photoAuthHeaders() });
    }
    if (!res.ok) throw new Error(`sign failed (${res.status})`);
    const data = await res.json();
    const url = data && data.url;
    if (url) {
      reportPhotoUrlCache.set(cacheKey, { url, expiresAt: now + ttl * 1000 });
      persistReportPhotoUrlCache();
    }
    return url;
  } catch (err) {
    console.error('Failed to sign photo URL:', err.message || err);
    return null;
  }
}

// Used by thumbnail/display images (which load a smaller transformed
// variant) to fetch the untransformed full-size signed URL only when the
// user actually clicks through to view it at full resolution.
async function openFullSizeReportPhoto(path) {
  const url = await getReportPhotoSignedUrl(path);
  if (url) window.open(url, '_blank');
}

function resetReportingForm() {
  document.getElementById('category').selectedIndex = 0;
  document.getElementById('subcategory').innerHTML = '';
  document.getElementById('subcategoryRow').style.display = 'none';
  document.getElementById('priority').selectedIndex = 0;
  document.getElementById('comment').value = "";
  document.getElementById('reportBtn').disabled = true;
  removePendingReportPhoto();

  if (pinMode) {
    pinMode = false;
    document.getElementById('pinMapBtn').classList.remove('active');
  }
  if (manualMarker) { map.removeLayer(manualMarker); manualMarker = null; }
  manualCoords = null;
  manualPinMunicipality = null;
  updateProximityUi();
  scheduleMapCenterMunicipalityUpdate();

  wizState.status = null;
  closeReportWizard();
}

const WIZ_CATEGORY_ICONS = CATEGORY_ICONS;
const WIZ_SUBCATEGORY_ICONS = {
  Water: { burst_leak:'water_leak.png', no_supply:'water_no_supply.png', low_pressure:'water_low_pressure.png', discoloration:'water_discoloration.png', other:'ui_other.png' },
  Electricity: { outage:'electricity_outage.png', exposed_wire:'electricity_damaged_wire.png', transformer:'electricity_transformer_issue.png', voltage:'electricity_voltage_fluctuation.png', pole_damage:'electricity_pole_damage.png', other:'ui_other.png' },
  Sewage: { blockage:'sewage_overflow.png', manhole:'sewage_manhole_issue.png', odor:'sewage_odor.png', other:'ui_other.png' },
  Gas: { leak:'gas_leak.png', outage:'gas_outage.png', other:'ui_other.png' },
  Heating: { no_heat:'heating_no_heat.png', leak:'heating_leak.png', low_temp:'heating_low_temp.png', other:'ui_other.png' },
  Road: { pothole:'road_pothole.png', cracked:'road_damaged_pavement.png', signage:'road_missing_sign.png', flooding:'road_flooding.png', other:'ui_other.png' },
  Streetlight: { out:'street_light_out.png', flickering:'street_light_flickering.png', pole_damage:'street_light_damaged_pole.png', other:'ui_other.png' },
  Waste: { overflow:'waste_overflowing_bin.png', missed:'waste_missed_collection.png', dumping:'waste_illegal_dumping.png', other:'ui_other.png' },
  Walkways: { cracked_concrete:'walkway_cracked_concrete.png', blocked_path:'walkway_blocked_path.png', missing_ramp:'walkway_missing_ramp.png', trip_hazard:'walkway_trip_hazard.png', other:'ui_other.png' },
  BikeLanes: { surface_damage:'bike_surface_damage.png', missing_separation:'bike_missing_separation.png', faded_markings:'bike_faded_markings.png', blocked_lane:'bike_blocked_by_car.png', other:'ui_other.png' },
  GreenSpaces: { broken_equipment:'green_broken_equipment.png', fallen_trees:'green_fallen_tree.png', overgrown_grass:'green_overgrown_grass.png', illegal_dumping:'green_litter.png', other:'ui_other.png' },
  Forest: { illegal_logging:'forest_illegal_logging.png', fire_hazard:'forest_fire_hazard.png', fallen_trees:'forest_fallen_trees.png', illegal_dumping:'forest_illegal_dumping.png', trail_damage:'forest_trail_damage.png', other:'ui_other.png' },
  FarmersMarket: { hygiene:'farmers_market_hygiene.png', overpricing:'farmers_market_overpricing.png', illegal_vendor:'farmers_market_illegal_vendor.png', infrastructure:'farmers_market_infrastructure.png', parking:'farmers_market_parking.png', other:'ui_other.png' },
};
const WIZ_PRIORITY_ICONS = { low:'priority_low.png', normal:'priority_normal.png', high:'priority_high.png' };
const WIZ_STATUS_ICONS = { reported:'status_reported.png', in_progress:'status_in_progress.png' };

let wizState = { steps: wizStepsFor(null), step: 0, category: null, subcategory: null, priority: null, status: null };
let wizOwnsPinDrop = false;

function wizStepsFor(cat) {
  const steps = ['category'];
  if (cat && (SUBCATEGORIES[cat] || []).length) steps.push('subcategory');
  steps.push('priority');
  steps.push('details');
  return steps;
}

function reportFabTap() {
  if (!currentSession || !currentProfile) { toast(t('signInFirst') || 'Sign in first', 'error'); return; }
  const isAdmin = !!currentProfile.is_admin;
  if (!isAdmin && !isMobileDevice()) { toast(t('mobileOnlyReport'), 'error'); return; }
  if (vpnCheckResult && vpnCheckResult.isVpn) { toast(t('vpnBlockedReport'), 'error'); return; }

  if (!isReportReady()) { toast(hasReliableGps() ? t('gpsTooWeak') : t('waitGps'), 'error'); return; }

  // If the user already dropped a manual pin for precision, it's the location they
  // mean to report — leave it alone instead of snapping it back to the GPS dot.
  if (pinMode && manualCoords) {
    checkFormReady();
    openReportWizard();
    return;
  }

  if (hasReliableGps()) {

    if (!pinMode) {
      pinMode = true;
      wizOwnsPinDrop = true;
      document.getElementById('pinMapBtn').classList.add('active');
      document.getElementById('pinMapBtn').setAttribute('aria-pressed', 'true');
    }
    manualCoords = { lat: userCoords.lat, lon: userCoords.lon };
    if (manualMarker) {
      manualMarker.setLatLng([manualCoords.lat, manualCoords.lon]);
    } else {
      manualMarker = L.marker([manualCoords.lat, manualCoords.lon], {
        icon: L.divIcon({ className: '', html: buildDroppedPinHtml(), iconSize: [30, 36], iconAnchor: [15, 34] })
      }).addTo(map);
    }
    manualPinMunicipality = null;
    showMunicipalityBoundaryForPoint(manualCoords.lat, manualCoords.lon, manualMarker, 'pin')
      .then(muni => { manualPinMunicipality = muni; updateProximityUi(); })
      .catch(() => {});
    updateProximityUi();
    checkFormReady();
    openReportWizard();
    return;
  }

  wizOwnsPinDrop = true;
  checkFormReady();
  openReportWizard();
}

// Each forward step inside the wizard pushes its own history entry (see
// wizAdvance), so that stepping back through the flow -- one press, one step
// -- is handled by the browser's own history mechanics rather than by us
// racing to re-push a replacement entry from inside the popstate handler
// itself. wizHistoryDepth tracks how many of those step-entries are
// currently "open" so the popstate listener (installed further down, near
// openOverlay/closeOverlay) knows whether an incoming back-press belongs to
// the wizard or to whatever's underneath it.
let wizHistoryDepth = 0;
let wizSuppressPopstate = false;

function openReportWizard() {
  wizState = { steps: wizStepsFor(null), step: 0, category: null, subcategory: null, priority: null, status: null };
  wizHistoryDepth = 0;
  document.getElementById('reportWizard').style.display = 'flex';
  wizRender();
  openOverlay('reportWizard', closeReportWizard);
}

function closeReportWizard() {
  const overlay = document.getElementById('reportWizard');
  if (overlay) overlay.style.display = 'none';
  wizReturnRelocatedNodes();
  const extraHistorySteps = wizHistoryDepth;
  wizHistoryDepth = 0;
  if (wizOwnsPinDrop) {
    wizOwnsPinDrop = false;
    resetReportingForm();
  }
  closeOverlay('reportWizard', extraHistorySteps);
}

// On-screen ‹ button. Mirrors whatever wizAdvance() did to get to the current
// step: if that step's forward move pushed a history entry, undo it with a
// matching history.back() (suppressed so the resulting popstate doesn't also
// try to process it) so the browser's back-button count stays in sync with
// wizState.step no matter which control the person actually taps.
function wizGoBack() {
  if (wizState.step === 0) { closeReportWizard(); return; }
  wizState.step -= 1;
  wizRender();
  if (wizHistoryDepth > 0) {
    wizHistoryDepth -= 1;
    wizSuppressPopstate = true;
    history.back();
  }
}

function wizAdvance() {
  wizState.step += 1;
  wizHistoryDepth += 1;
  history.pushState({ wizStep: wizState.step }, '');
  wizRender();
}

const WIZ_RELOCATED_IDS = ['proximityIndicator', 'comment', 'reportPhotoPreview', 'offlineQueueBadge', 'reportSubmitRow'];
function wizReturnRelocatedNodes() {
  const home = document.getElementById('reportFormPanel');
  WIZ_RELOCATED_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el && el.parentElement !== home) home.appendChild(el);
  });
}

function wizRender() {
  wizReturnRelocatedNodes();
  const step = wizState.steps[wizState.step];
  const progressWrap = document.getElementById('wizProgress');
  progressWrap.innerHTML = wizState.steps.map((_, i) => `<span class="${i <= wizState.step ? 'done' : ''}"></span>`).join('');
  document.getElementById('wizBackBtn').style.visibility = 'visible';

  const body = document.getElementById('wizBody');
  if (step === 'category') return wizRenderCategory(body);
  if (step === 'subcategory') return wizRenderSubcategory(body);
  if (step === 'priority') return wizRenderPriority(body);
  if (step === 'details') return wizRenderDetails(body);
}

function wizRenderCategory(body) {
  const cats = Object.keys(WIZ_CATEGORY_ICONS);
  body.innerHTML = `
    <p class="wiz-step-label">${t('wizStepLabel') || 'Step 1'}</p>
    <h3 class="wiz-step-title">${t('wizCategoryTitle') || "What's the issue?"}</h3>
    <div class="wiz-grid">
      ${cats.map(cat => `
        <div class="wiz-tile wiz-tile-colored" style="background:${categoryColor(cat)};border-color:${categoryColor(cat)};" onclick="wizSelectCategory('${cat}')">
          <div class="wiz-tile-icon" style="-webkit-mask-image:url('icons/reports/${WIZ_CATEGORY_ICONS[cat]}');mask-image:url('icons/reports/${WIZ_CATEGORY_ICONS[cat]}');"></div>
          <span>${translateCategory(cat)}</span>
        </div>`).join('')}
    </div>`;
}

function wizSelectCategory(cat) {
  document.getElementById('category').value = cat;
  onCategoryChange();
  wizState.category = cat;
  wizState.subcategory = null;
  wizState.steps = wizStepsFor(cat);
  wizAdvance();
}

function wizRenderSubcategory(body) {
  const list = SUBCATEGORIES[wizState.category] || [];
  const icons = WIZ_SUBCATEGORY_ICONS[wizState.category] || {};
  body.innerHTML = `
    <p class="wiz-step-label">${t('wizStepLabel') || 'Step 2'}</p>
    <h3 class="wiz-step-title">${t('wizSubcategoryTitle') || 'Which one?'}</h3>
    <div class="wiz-grid">
      ${list.map(s => `
        <div class="wiz-tile wiz-tile-colored" style="background:${categoryColor(wizState.category)};border-color:${categoryColor(wizState.category)};" onclick="wizSelectSubcategory('${s.key}')">
          ${icons[s.key] ? `<div class="wiz-tile-icon" style="-webkit-mask-image:url('icons/reports/${icons[s.key]}');mask-image:url('icons/reports/${icons[s.key]}');"></div>` : ""}
          <span>${isSerbianLang() ? s.sr : s.en}</span>
        </div>`).join('')}
    </div>`;
}

function wizSelectSubcategory(key) {
  document.getElementById('subcategory').value = key || '';
  checkFormReady();
  wizState.subcategory = key || null;
  wizAdvance();
}

function wizRenderPriority(body) {
  const opts = [
    { key: 'low', icon: WIZ_PRIORITY_ICONS.low },
    { key: 'normal', icon: WIZ_PRIORITY_ICONS.normal },
    { key: 'high', icon: WIZ_PRIORITY_ICONS.high },
  ];
  body.innerHTML = `
    <p class="wiz-step-label">${t('wizStepLabel') || 'Step'}</p>
    <h3 class="wiz-step-title">${t('wizPriorityTitle') || 'How urgent is it?'}</h3>
    <div class="wiz-list">
      ${opts.map(o => `
        <div class="wiz-bar" onclick="wizSelectPriority('${o.key}')">
          <div class="wiz-bar-icon" style="background-color:${priorityColor(o.key)};-webkit-mask-image:url('icons/reports/${o.icon}');mask-image:url('icons/reports/${o.icon}');"></div>
          <span>${priorityLabelText(o.key)}</span>
        </div>`).join('')}
    </div>`;
}

function wizSelectPriority(p) {
  document.getElementById('priority').value = p;
  checkFormReady();
  wizState.priority = p;
  wizAdvance();
}

function wizRenderDetails(body) {
  body.innerHTML = `
    <p class="wiz-step-label">${t('wizStepLabel') || 'Last step'}</p>
    <h3 class="wiz-step-title">${t('wizDetailsTitle') || 'Add a photo & note'}</h3>
    <div id="wizDuplicateSlot"></div>
    <div id="wizProximitySlot" class="wiz-details-row"></div>
    <div class="wiz-details-row">
      <label>${t('wizNoteLabel') || 'Note (optional)'}</label>
      <div id="wizCommentSlot"></div>
    </div>
    <div class="wiz-details-row">
      <label>${t('wizPhotoLabel') || 'Photo (optional)'}</label>
      <div class="wiz-photo-row">
        <div class="wiz-photo-btn" onclick="triggerReportPhotoCamera()">
          <img class="icon-tint-dark" src="icons/camera.png" alt="">
          <span>${t('wizTakePhoto') || 'Take photo'}</span>
        </div>
        <div class="wiz-photo-btn" onclick="triggerReportPhotoGallery()">
          <img class="icon-tint-dark" src="icons/gallery.png" alt="">
          <span>${t('wizChoosePhoto') || 'Choose photo'}</span>
        </div>
      </div>
      <div id="wizPhotoPreviewSlot"></div>
    </div>
    <div id="wizOfflineBadgeSlot"></div>
    <div id="wizSubmitSlot" style="margin-top:8px;"></div>`;
  document.getElementById('wizProximitySlot').appendChild(document.getElementById('proximityIndicator'));
  document.getElementById('wizCommentSlot').appendChild(document.getElementById('comment'));
  document.getElementById('wizPhotoPreviewSlot').appendChild(document.getElementById('reportPhotoPreview'));
  document.getElementById('wizOfflineBadgeSlot').appendChild(document.getElementById('offlineQueueBadge'));
  document.getElementById('wizSubmitSlot').appendChild(document.getElementById('reportSubmitRow'));
  renderWizDuplicateNotice();
}

// Matches the same "same category isn't enough" + "keep the radius tight
// enough that opposite sides of a street don't qualify" reasoning as
// DUPLICATE_MERGE_RADIUS_M above -- this just shows an advisory heads-up
// while filing, but a false "already reported" nudge is exactly what sends
// someone away thinking a genuinely new issue (e.g. sign damage on the far
// side of the road) is already logged.
const DUPLICATE_REPORT_RADIUS_M = 15;
const DUPLICATE_REPORT_MAX_SHOWN = 3;
function findNearbyDuplicateReports(lat, lon, category, subcategory) {
  if (!isValidLatLng(lat, lon) || !category) return [];
  return globalActiveData
    .filter(r => r.category === category && (r.subcategory || null) === (subcategory || null) && r.status !== 'fixed' && isValidLatLng(r.latitude, r.longitude))
    .map(r => ({ r, d: distMeters({ lat, lon }, { lat: r.latitude, lon: r.longitude }) }))
    .filter(x => x.d <= DUPLICATE_REPORT_RADIUS_M)
    .sort((a, b) => a.d - b.d)
    .slice(0, DUPLICATE_REPORT_MAX_SHOWN)
    .map(x => x.r);
}

function renderWizDuplicateNotice() {
  const slot = document.getElementById('wizDuplicateSlot');
  if (!slot) return;
  const coords = pinMode && manualCoords ? manualCoords : userCoords;
  if (!coords) { slot.innerHTML = ''; return; }
  const dupes = findNearbyDuplicateReports(coords.lat, coords.lon, wizState.category, wizState.subcategory);
  if (!dupes.length) { slot.innerHTML = ''; return; }
  slot.innerHTML = `<div class="wiz-duplicate-notice">
    <div class="wiz-duplicate-notice-title">${t('duplicateNoticeTitle').replace('{n}', dupes.length)}</div>
    <div class="wiz-duplicate-notice-hint">${t('duplicateNoticeHint')}</div>
  </div>`;
}

const OFFLINE_DB_NAME = 'ttb_offline_queue';
const OFFLINE_DB_VERSION = 1;
const OFFLINE_STORE = 'pending_reports';
const OFFLINE_SYNC_POLL_MS = 30 * 1000;

function openOfflineDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('no-indexeddb')); return; }
    const req = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OFFLINE_STORE)) {
        db.createObjectStore(OFFLINE_STORE, { keyPath: 'localId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbTxDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function queueOfflineReport(insertPayload, photoBlob, photoExt, photoThumbBlob) {
  const db = await openOfflineDb();
  const localId = (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'offline_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  const entry = { localId, insertPayload, photoBlob: photoBlob || null, photoExt: photoExt || 'jpg', photoThumbBlob: photoThumbBlob || null, createdAt: Date.now() };
  const tx = db.transaction(OFFLINE_STORE, 'readwrite');
  tx.objectStore(OFFLINE_STORE).put(entry);
  await idbTxDone(tx);
  return localId;
}

async function getQueuedReports() {
  try {
    const db = await openOfflineDb();
    const tx = db.transaction(OFFLINE_STORE, 'readonly');
    const rows = await idbReq(tx.objectStore(OFFLINE_STORE).getAll());
    await idbTxDone(tx);
    return rows || [];
  } catch (e) {
    return [];
  }
}

async function deleteQueuedReport(localId) {
  try {
    const db = await openOfflineDb();
    const tx = db.transaction(OFFLINE_STORE, 'readwrite');
    tx.objectStore(OFFLINE_STORE).delete(localId);
    await idbTxDone(tx);
  } catch (e) {
    console.warn('deleteQueuedReport: failed to remove synced report from offline queue', localId, e);
  }
}

function isNetworkFailure(err) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  const msg = String((err && (err.message || err.error_description)) || err || '').toLowerCase();
  return msg.includes('failed to fetch')
      || msg.includes('networkerror')
      || msg.includes('network request failed')
      || msg.includes('load failed')
      || msg.includes('the internet connection appears to be offline');
}

async function updateOfflineQueueBadge() {
  const badge = document.getElementById('offlineQueueBadge');
  const textEl = document.getElementById('offlineQueueBadgeText');
  const banner = document.getElementById('globalOfflineBanner');
  const bannerTextEl = document.getElementById('globalOfflineBannerText');
  const rows = await getQueuedReports();

  if (badge && textEl) {
    if (!rows.length) {
      badge.style.display = 'none';
    } else {
      textEl.textContent = t('offlineQueueBadge').replace('{n}', rows.length);
      badge.style.display = 'flex';
    }
  }

  if (banner && bannerTextEl) {
    if (!rows.length) {
      banner.style.display = 'none';
      document.body.classList.remove('offline-banner-visible');
    } else {
      bannerTextEl.textContent = t('offlineQueueBadge').replace('{n}', rows.length);
      banner.style.display = 'flex';
      document.body.classList.add('offline-banner-visible');
    }
  }
}

let offlineSyncInFlight = false;

async function syncOfflineQueue(manual) {
  if (offlineSyncInFlight) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    if (manual) toast(t('offlineStillOffline'), 'error');
    return;
  }
  if (!currentSession || !currentProfile) { await updateOfflineQueueBadge(); return; }

  const rows = await getQueuedReports();
  if (!rows.length) { await updateOfflineQueueBadge(); return; }

  offlineSyncInFlight = true;
  let syncedCount = 0;
  let rateLimitedStop = false;
  try {
    rows.sort((a, b) => a.createdAt - b.createdAt);
    for (const row of rows) {
      try {
        const { data, error } = await sb.from(TABLE).insert([row.insertPayload]).select('id').single();
        if (error) throw error;
        resolveAndAttachMunicipality(data && data.id, row.insertPayload.latitude, row.insertPayload.longitude);
        if (row.photoBlob && data && data.id) {
          await uploadReportPhoto(data.id, row.photoBlob, row.photoExt, row.photoThumbBlob);
        }
        await deleteQueuedReport(row.localId);
        syncedCount++;
      } catch (err) {
        if (isNetworkFailure(err)) break;

        if (err && err.message === 'rate_limit_exceeded') { rateLimitedStop = true; break; }
        console.error('Dropping unsendable offline report:', row.localId, err);
        await deleteQueuedReport(row.localId);
      }
    }
  } finally {
    offlineSyncInFlight = false;
    await updateOfflineQueueBadge();
    if (syncedCount > 0) {
      toast(t('offlineSynced').replace('{n}', syncedCount), 'success');
      await loadPinsByWindow();
    }
    if (rateLimitedStop) {
      toast(t('offlineSyncRateLimited'), 'error');
    }
  }
}

window.addEventListener('online', () => syncOfflineQueue(false));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') syncOfflineQueue(false);
});
setInterval(() => syncOfflineQueue(false), OFFLINE_SYNC_POLL_MS);

async function ensureFreshSession() {
  try {
    const { data: { session }, error } = await sb.auth.getSession();
    if (error) throw error;
    if (!session) {
      currentSession = null;
      updateAuthUI();
      toast(t('sessionExpiredReauth'), 'error');
      return null;
    }
    currentSession = session;
    return session;
  } catch (err) {

    if (isNetworkFailure(err) && currentSession) return currentSession;
    currentSession = null;
    updateAuthUI();
    toast(t('sessionExpiredReauth'), 'error');
    return null;
  }
}

// A backgrounded/idle tab's auto-refresh timer can lag behind the token's
// actual expiry (throttled background timers, laptop sleep, etc). Refresh
// as soon as the tab is visible again so photo /sign, uploads, etc. don't
// have to discover the staleness via a 401 first. Only bother if we were
// signed in to begin with, so signed-out users don't get spurious
// "session expired" toasts every time they switch tabs.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentSession) ensureFreshSession();
});

async function reportBreak(){
  if (!currentSession || !currentProfile) { updateAuthUI(); return; }

  const freshSession = await ensureFreshSession();
  if (!freshSession) return;

  const isAdmin = !!currentProfile.is_admin;
  if (!isAdmin && !isMobileDevice()) { toast(t('mobileOnlyReport'), 'error'); return; }
  if ((await ensureVpnStatus()).isVpn) { toast(t('vpnBlockedReport'), 'error'); return; }

  const coords = pinMode && manualCoords ? manualCoords : userCoords;
  if (!coords) { toast(t('waitGps'), 'error'); return; }

  const inOwnDomain = isAdmin && isMunicipalityInAdminDomain(manualPinMunicipality);
  if (!isAdmin) {

    if (!hasReliableGps()) { toast(t('gpsTooWeak'), 'error'); return; }
  }

  if (!isAdmin && !inOwnDomain && pinMode && manualCoords) {

    if (!userCoords || !hasReliableGps()) { toast(isAdmin ? t('gpsTooWeak') : t('waitGps'), 'error'); return; }
    const dist = distMeters(userCoords, manualCoords);
    if (dist > REPORT_PROXIMITY_MAX_M) {
      toast(t('tooFarToReport').replace('{d}', Math.round(dist)), 'error');
      return;
    }
  }

  const lat = toFiniteNumber(coords.lat);
  const lon = toFiniteNumber(coords.lon);
  if (!isValidLatLng(lat, lon)) {
    console.error('Rejected report: invalid coordinates', coords);
    toast(t('invalidLocation'), 'error');
    return;
  }
  if (shouldBlockReportSubmission()) return;

  const category    = document.getElementById('category').value;
  const subcategory = document.getElementById('subcategory').value || null;
  const priority     = document.getElementById('priority').value || 'normal';
  const comment      = cyrillicToLatin(document.getElementById('comment').value);
  const status = (wizState.status === 'in_progress') ? 'in_progress' : 'reported';

  if (CATEGORIES_REQUIRING_COMMENT.has(category) && !comment.trim()) {
    toast(t('suggestionCommentRequired'), 'error');
    return;
  }
  if (blockIfProfane(comment)) return;

  reportSubmissionInFlight = true;
  const reportBtn = document.getElementById('reportBtn');
  if (reportBtn) reportBtn.disabled = true;
  try {
    const insertPayload = {
      latitude:  lat,
      longitude: lon,
      category,
      subcategory,
      priority,
      status,
      comment,
      created_at: new Date().toISOString(),
      owner_id: currentSession.user.id,
      owner_username: currentProfile.username
    };

    let data;
    try {
      const result = await sb.from(TABLE).insert([insertPayload]).select('id').single();
      if (result.error) throw result.error;
      data = result.data;
    } catch (err) {
      if (isNetworkFailure(err)) {
        await queueOfflineReport(insertPayload, pendingReportPhotoBlob, pendingReportPhotoExt, pendingReportPhotoThumbBlob);
        recordReportSubmission();
        toast('\ud83d\udcf6 ' + t('offlineQueued'), 'success');
        resetReportingForm();
        updateOfflineQueueBadge();
        return;
      }
      throw err;
    }

    recordReportSubmission();
    resolveAndAttachMunicipality(data && data.id, lat, lon);

    if (pendingReportPhotoBlob && data && data.id) {
      await uploadReportPhoto(data.id, pendingReportPhotoBlob, pendingReportPhotoExt, pendingReportPhotoThumbBlob);
    }

    toast('✓ ' + t('submitted'), 'success');
    resetReportingForm();
    await loadPinsByWindow();

    if (data && data.id) {
      offerContactFollowUp(data.id, { id: data.id, latitude: lat, longitude: lon, category, municipality_id: null });
    }
  } catch (err) {
    console.error('Report submit error (full):', err);

    if (err && err.message === 'rate_limit_exceeded') {
      toast(t('reportRateLimitedPrefix') + t('reportRateLimitedServerFallbackSuffix'), 'error');
    } else {
      toast(describeAuthError(err), 'error');
    }
  } finally {
    reportSubmissionInFlight = false;

    checkFormReady();
  }
}

let municipalityCache = [];
let municipalityCacheLoaded = false;

const loadedMuniIds = new Set();
// Kept in lockstep with loadedMuniIds/municipalityCache at every mutation
// point below, so getMunicipalityById() can do an O(1) map lookup instead of
// an O(n) linear scan over the whole cache (up to ~97k rows) — that scan was
// getting run once per report/company across list renders and analytics
// grouping, turning into O(n*m) and freezing the tab on any decent-sized
// dataset.
const municipalityById = new Map();

const loadedMuniCountries = new Set();

const MUNICIPALITY_CACHE_STORAGE_KEY = 'ttb_municipality_cache_v2';
const MUNI_SELECT_COLS = 'id,slug,osm_type,osm_id,admin_level,name,name_en,country_code,centroid_lat,centroid_lon,boundary,bbox';
// Same rows, minus `boundary`/`bbox` — those two columns hold full GeoJSON
// polygons and are what actually makes the municipalities table (97k+ rows)
// heavy. Screens that only need names/ids (like the utility-company admin
// list) never touch those columns, so there's no reason to pull them.
const MUNI_SELECT_COLS_LITE = 'id,slug,osm_type,osm_id,admin_level,name,name_en,country_code,centroid_lat,centroid_lon';

function readMunicipalityCacheFromStorage() {
  try {
    const raw = localStorage.getItem(MUNICIPALITY_CACHE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

let _muniCacheWriteTimer = null;
function writeMunicipalityCacheToStorage(rows) {

  if (_muniCacheWriteTimer) clearTimeout(_muniCacheWriteTimer);
  _muniCacheWriteTimer = setTimeout(() => {
    _muniCacheWriteTimer = null;
    const doWrite = () => {
      try {
        // boundary/bbox are full GeoJSON polygons — across 90k+ municipalities
        // that's easily tens of MB. Stringifying that much blocks the main
        // thread for a very long time (a real page freeze, not just a slow
        // network wait) and typically exceeds the ~5-10MB localStorage quota
        // anyway, failing silently in the catch below. This cache is only
        // ever a warm-start optimization — loadMunicipalityCache() always
        // re-fetches the full data (boundary included) from network right
        // after reading it — so persisting the lightweight columns only
        // loses nothing real and keeps this fast and safe.
        const lite = rows.map(r => ({
          id: r.id, slug: r.slug, osm_type: r.osm_type, osm_id: r.osm_id,
          admin_level: r.admin_level, name: r.name, name_en: r.name_en,
          country_code: r.country_code, centroid_lat: r.centroid_lat, centroid_lon: r.centroid_lon
        }));
        localStorage.setItem(MUNICIPALITY_CACHE_STORAGE_KEY, JSON.stringify(lite));
      } catch (e) {
      }
    };
    // Push even this smaller write off to an idle moment where possible, so
    // it never lands mid-interaction (e.g. right as the admin panel opens).
    if ('requestIdleCallback' in window) requestIdleCallback(doWrite, { timeout: 2000 });
    else doWrite();
  }, 1500);
}
let municipalityCacheLoadPromise = null;
let municipalityCacheFullSettled = false;

async function loadMunicipalityCache(forceRefresh) {
  if (municipalityCacheLoadPromise && !forceRefresh) return municipalityCacheLoadPromise;
  municipalityCacheFullSettled = false;
  municipalityCacheLoadPromise = (async () => {
    if (!forceRefresh) {
      const cached = readMunicipalityCacheFromStorage();
      if (cached && cached.length) {
        municipalityCache = cached;
        municipalityCache.forEach(m => { loadedMuniIds.add(m.id); municipalityById.set(String(m.id), m); });
        municipalityCacheLoaded = true;
      }
    }
    try {

      const PAGE_SIZE = 1000;
      let allRows = [];
      let from = 0;
      while (true) {
        const { data, error } = await sb.from(MUNICIPALITIES_TABLE).select(MUNI_SELECT_COLS)
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        allRows = allRows.concat(data || []);
        if (!data || data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }
      municipalityCache = allRows;
      loadedMuniIds.clear();
      municipalityById.clear();
      municipalityCache.forEach(m => {
        loadedMuniIds.add(m.id);
        municipalityById.set(String(m.id), m);
        if (m.country_code) loadedMuniCountries.add(String(m.country_code).toUpperCase());
      });
      municipalityCacheLoaded = true;
      writeMunicipalityCacheToStorage(municipalityCache);
    } catch (err) {
      console.error('Failed to load municipality cache:', err.message);
    }
  })();
  municipalityCacheLoadPromise.finally(() => { municipalityCacheFullSettled = true; });
  return municipalityCacheLoadPromise;
}

let municipalityCacheLiteLoadPromise = null;
let municipalityCacheLiteLoaded = false;
// Used by admin screens (like the utility-company panel) that only ever
// read m.name/m.name_en/m.country_code/m.id — never m.boundary/m.bbox — so
// they can skip the multi-megabyte geometry payload entirely instead of
// waiting on the same full, heavy fetch loadMunicipalityCache() does for
// map-boundary rendering. Writes into the exact same municipalityCache /
// loadedMuniIds structures via mergeMunicipalitiesIntoCache(), so every
// other helper (getMunicipalityById, municipalityDisplayName,
// isMunicipalityInAdminDomain, ...) keeps working unchanged.
async function loadMunicipalityCacheLite() {
  // Only piggyback on a full load that has ALREADY finished — reusing that
  // result is free. Don't wait on one that's still in flight: a full load
  // fetches every column (including multi-megabyte boundary/bbox geometry)
  // for 90k+ municipalities, sequentially, one page at a time, and can take
  // a long time on a slow connection. This panel only needs
  // id/name/name_en/country_code, so if the full load hasn't settled yet,
  // run our own fast parallel-paged fetch instead of getting stuck waiting
  // behind that unrelated heavy load.
  if (municipalityCacheLoadPromise && municipalityCacheFullSettled) return loadMunicipalityCache(false);
  // Otherwise de-dupe the lite load the same way: once done, later callers
  // (e.g. re-opening the admin panel) get an instant no-op instead of
  // re-fetching all 90k+ rows again.
  if (municipalityCacheLiteLoaded) return;
  if (municipalityCacheLiteLoadPromise) return municipalityCacheLiteLoadPromise;
  municipalityCacheLiteLoadPromise = (async () => {
    try {
      const PAGE_SIZE = 1000;
      const { count, error: countErr } = await sb
        .from(MUNICIPALITIES_TABLE)
        .select('id', { count: 'exact', head: true });
      if (countErr) throw countErr;
      const pageCount = Math.max(1, Math.ceil((count || 0) / PAGE_SIZE));
      // Firing every page at once instead of awaiting them one-by-one is
      // the other half of the fix: ~90k rows is ~90 pages, and awaiting
      // those sequentially means ~90 round trips back-to-back even once
      // each individual page is small and fast.
      const pages = await Promise.all(
        Array.from({ length: pageCount }, (_, i) => {
          const from = i * PAGE_SIZE;
          return sb.from(MUNICIPALITIES_TABLE).select(MUNI_SELECT_COLS_LITE).range(from, from + PAGE_SIZE - 1);
        })
      );
      for (const { data, error } of pages) {
        if (error) throw error;
        mergeMunicipalitiesIntoCache(data || []);
      }
      municipalityCacheLiteLoaded = true;
    } catch (err) {
      console.error('Failed to load lightweight municipality cache:', err.message);
    }
  })();
  return municipalityCacheLiteLoadPromise;
}

const MUNI_NEAR_PAD_DEG = 1.5;

const MUNI_COUNTRY_LOAD_DELAY_MS = 2500;

const muniCountryLoadInFlight = new Map();

function mergeMunicipalitiesIntoCache(rows) {
  if (!rows || !rows.length) return;
  for (const row of rows) {
    if (row.id != null && loadedMuniIds.has(row.id)) continue;
    if (row.id != null) { loadedMuniIds.add(row.id); municipalityById.set(String(row.id), row); }
    municipalityCache.push(row);
  }
  municipalityCacheLoaded = true;
  writeMunicipalityCacheToStorage(municipalityCache);
}

async function fetchMunicipalitiesNearPoint(lat, lon) {
  try {
    const { data, error } = await sb.from(MUNICIPALITIES_TABLE).select(MUNI_SELECT_COLS)
      .gte('centroid_lat', lat - MUNI_NEAR_PAD_DEG).lte('centroid_lat', lat + MUNI_NEAR_PAD_DEG)
      .gte('centroid_lon', lon - MUNI_NEAR_PAD_DEG).lte('centroid_lon', lon + MUNI_NEAR_PAD_DEG);
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error('Failed to load nearby municipalities:', err.message);
    return [];
  }
}

async function ensureCountryMunicipalitiesLoaded(countryCode) {
  if (!countryCode) return;
  countryCode = String(countryCode).toUpperCase();
  if (loadedMuniCountries.has(countryCode)) return;
  if (muniCountryLoadInFlight.has(countryCode)) return muniCountryLoadInFlight.get(countryCode);
  const promise = (async () => {
    try {
      const { data, error } = await sb.from(MUNICIPALITIES_TABLE).select(MUNI_SELECT_COLS)
        .eq('country_code', countryCode);
      if (error) throw error;
      mergeMunicipalitiesIntoCache(data || []);
      loadedMuniCountries.add(countryCode);
    } catch (err) {
      console.error(`Failed to load municipalities for country ${countryCode}:`, err.message);
    } finally {
      muniCountryLoadInFlight.delete(countryCode);
    }
  })();
  muniCountryLoadInFlight.set(countryCode, promise);
  return promise;
}

function scheduleCountryMunicipalityLoad(countryCode) {
  if (!countryCode) return;
  countryCode = String(countryCode).toUpperCase();
  if (loadedMuniCountries.has(countryCode) || muniCountryLoadInFlight.has(countryCode)) return;
  const promise = new Promise(resolve => {
    setTimeout(() => { ensureCountryMunicipalitiesLoaded(countryCode).then(resolve); }, MUNI_COUNTRY_LOAD_DELAY_MS);
  });
  muniCountryLoadInFlight.set(countryCode, promise);
}

async function ensureMunicipalitiesNear(lat, lon) {
  if (!isValidLatLng(lat, lon)) return;

  const already = findMunicipalityInCache(lat, lon);
  if (already && already.country_code && loadedMuniCountries.has(String(already.country_code).toUpperCase())) {
    return;

  }

  const rows = await fetchMunicipalitiesNearPoint(lat, lon);
  mergeMunicipalitiesIntoCache(rows);

  const hit = findMunicipalityInCache(lat, lon);
  if (hit && hit.country_code) scheduleCountryMunicipalityLoad(hit.country_code);
}

function pointInRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInBoundary(lat, lon, boundary) {
  if (!boundary || !boundary.coordinates) return false;
  const polys = boundary.type === 'MultiPolygon' ? boundary.coordinates : [boundary.coordinates];
  for (const poly of polys) {
    const outer = poly[0];
    if (outer && pointInRing(lat, lon, outer)) return true;
  }
  return false;
}

function bboxContains(bbox, lat, lon) {
  if (!bbox || bbox.length !== 4) return true;
  const [minLon, minLat, maxLon, maxLat] = bbox;
  return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
}

function findMunicipalityInCache(lat, lon) {
  let best = null;
  for (const m of municipalityCache) {
    if (!bboxContains(m.bbox, lat, lon)) continue;
    if (pointInBoundary(lat, lon, m.boundary)) {
      if (!best || (m.admin_level || 0) > (best.admin_level || 0)) best = m;
    }
  }
  return best;
}

function getMunicipalityById(id) {
  if (id == null) return null;
  return municipalityById.get(String(id)) || null;
}

function getMunicipalityBySlug(slug) {
  if (slug == null) return null;
  return municipalityCache.find(m => m.slug === slug) || null;
}

let _nominatimChain = Promise.resolve();
let _nominatimLastCallAt = 0;
const NOMINATIM_MIN_GAP_MS = 1100;
const NOMINATIM_MAX_RETRIES = 3;

async function _nominatimFetchOnce(url, options) {
  const wait = NOMINATIM_MIN_GAP_MS - (Date.now() - _nominatimLastCallAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _nominatimLastCallAt = Date.now();
  return fetch(url, options);
}

function nominatimFetch(url, options) {
  const task = _nominatimChain.then(async () => {
    let res = await _nominatimFetchOnce(url, options);
    let attempt = 0;
    while (res.status === 429 && attempt < NOMINATIM_MAX_RETRIES) {
      const retryAfter = Number(res.headers.get('Retry-After')) || (2 * (attempt + 1));
      console.warn(`Nominatim rate-limited (429) — retrying in ${retryAfter}s (attempt ${attempt + 1}/${NOMINATIM_MAX_RETRIES})`);
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      res = await _nominatimFetchOnce(url, options);
      attempt++;
    }
    return res;
  });
  _nominatimChain = task.catch(() => {});
  return task;
}

const NOMINATIM_MUNICIPALITY_ZOOM_LEVELS = [10, 8, 12, 6];

async function fetchBoundaryGeometryForPoint(lat, lon) {
  for (const zoom of NOMINATIM_MUNICIPALITY_ZOOM_LEVELS) {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=${zoom}&addressdetails=1&polygon_geojson=1&${NOMINATIM_LATIN_LANG}`;
    let json;
    try {
      const res = await nominatimFetch(url, { headers: { 'Accept': 'application/json' } });
      if (!res.ok) {
        console.warn(`Nominatim reverse failed at zoom ${zoom}: HTTP ${res.status}`);
        continue;
      }
      json = await res.json();
    } catch (err) {
      console.warn(`Nominatim reverse request error at zoom ${zoom}:`, err.message);
      continue;
    }
    if (!json || json.error) continue;

    const geo = json.geojson;
    if (!geo || (geo.type !== 'Polygon' && geo.type !== 'MultiPolygon')) continue;

    const ringCount = geo.type === 'MultiPolygon'
      ? (geo.coordinates || []).reduce((n, poly) => n + (poly && poly.length ? 1 : 0), 0)
      : (geo.coordinates || []).length;
    if (!ringCount) {
      console.warn(`Nominatim returned an empty ${geo.type} at zoom ${zoom} — skipping, trying next zoom level.`);
      continue;
    }

    const addr = json.address || {};
    const name = json.name || addr.municipality || addr.city || addr.town || addr.county;
    if (!name) continue;

    let bbox = null;
    if (Array.isArray(json.boundingbox) && json.boundingbox.length === 4) {
      const [south, north, west, east] = json.boundingbox.map(Number);
      bbox = [west, south, east, north];
    }

    return {
      osm_type: json.osm_type || null,
      osm_id: json.osm_id != null ? json.osm_id : null,
      name,
      country_code: (addr.country_code || '').toUpperCase() || null,
      centroid_lat: parseFloat(json.lat) || lat,
      centroid_lon: parseFloat(json.lon) || lon,
      boundary: geo,
      bbox
    };
  }
  return null;
}

async function fetchMunicipalityFromNominatim(lat, lon) {
  const geo = await fetchBoundaryGeometryForPoint(lat, lon);
  if (!geo) return null;

  const row = {
    osm_type: geo.osm_type,
    osm_id: geo.osm_id,
    admin_level: null,
    name: geo.name,
    name_en: null,
    country_code: geo.country_code,
    centroid_lat: geo.centroid_lat,
    centroid_lon: geo.centroid_lon,
    boundary: geo.boundary,
    bbox: geo.bbox,
    slug: generateMuniSlug()
  };

  try {
    const { data, error } = await sb.from(MUNICIPALITIES_TABLE)
      .upsert(row, { onConflict: 'osm_type,osm_id', ignoreDuplicates: false })
      .select()
      .single();
    if (error) throw error;
    municipalityCache.push(data);
    writeMunicipalityCacheToStorage(municipalityCache);
    return data;
  } catch (err) {
    console.error('Failed to cache municipality:', err.message);
    return row;
  }
}

async function resolveMunicipality(lat, lon) {
  if (!isValidLatLng(lat, lon)) return null;
  await ensureMunicipalitiesNear(lat, lon);
  let muni = findMunicipalityInCache(lat, lon);
  if (!muni) muni = await resolveMunicipalityViaGeocode(lat, lon);
  return muni;
}

const NOMINATIM_LATIN_LANG = 'accept-language=sr-Latn,en';

function normalizeMuniNameForMatch(s) {
  if (!s) return '';
  let out = cyrillicToLatin(s)
    .replace(/[đĐ]/g, 'dj')                            // đ has no accent decomposition under NFD, unlike š/č/ć/ž
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // strip remaining accents
    .replace(/\s*\([^)]*\)\s*/g, ' ')                  // drop parenthetical qualifiers, e.g. "(Central)"
    .toLowerCase().trim().replace(/\s+/g, ' ');
  // Strip generic administrative-unit words so "X Municipality"/"Urban
  // Municipality X"/"Opština X" match plain "X" from another source.
  out = out.replace(/^grad\s+/, '')
    .replace(/\b(urban|city|central)\s+municipality\b/g, ' ')
    .replace(/\bmunicipality\b/g, ' ')
    .replace(/\bopstina\b/g, ' ')
    .trim().replace(/\s+/g, ' ');
  return out;
}

function generateMuniSlug() {
  return Math.random().toString(36).slice(2, 10);
}

const _muniGeocodeCache = new Map();
async function reverseGeocodeMunicipalityCandidates(lat, lon) {
  const cacheKey = lat.toFixed(3) + ',' + lon.toFixed(3);
  if (_muniGeocodeCache.has(cacheKey)) return _muniGeocodeCache.get(cacheKey);

  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10&addressdetails=1&${NOMINATIM_LATIN_LANG}`;
  let result;
  try {
    const res = await nominatimFetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) {
      console.warn(`Reverse-geocode for municipality name-match failed: HTTP ${res.status}`);
      return { candidates: [], countryCode: null, bestName: null };
    }
    const json = await res.json();
    if (!json || json.error) return { candidates: [], countryCode: null, bestName: null };
    const addr = json.address || {};

    const candidates = [addr.municipality, addr.city, addr.town, addr.city_district, addr.county, json.name].filter(Boolean);

    const bestName = addr.municipality || addr.city || addr.town || addr.county || json.name || null;
    result = {
      candidates,
      countryCode: (addr.country_code || '').toUpperCase() || null,
      bestName: bestName ? cyrillicToLatin(bestName) : null,

      osmType: json.osm_type || null,
      osmId: json.osm_id != null ? json.osm_id : null
    };
  } catch (err) {
    console.warn('Reverse-geocode for municipality name-match failed:', err.message);
    return { candidates: [], countryCode: null, bestName: null };
  }
  if (result.candidates.length) _muniGeocodeCache.set(cacheKey, result);
  return result;
}

const _muniNameMatchWarned = new Set();
function findMunicipalityByNameMatch(candidateNames, countryCode) {
  const pool = countryCode
    ? municipalityCache.filter(m => (m.country_code || '').toUpperCase() === countryCode)
    : municipalityCache;
  for (const raw of candidateNames) {
    const norm = normalizeMuniNameForMatch(raw);
    if (!norm) continue;
    const hit = pool.find(m => normalizeMuniNameForMatch(m.name) === norm || normalizeMuniNameForMatch(m.name_en) === norm);
    if (hit) return hit;
  }
  const warnKey = countryCode + '|' + candidateNames.join(',');
  if (!_muniNameMatchWarned.has(warnKey)) {
    _muniNameMatchWarned.add(warnKey);
    console.warn(
      'No cached municipality matched any reverse-geocode candidate — auto-registering instead.',
      'Candidates:', candidateNames, '| countryCode:', countryCode,
      '| Cached names in this country:', pool.map(m => m.name_en || m.name)
    );
  }
  return null;
}

const _autoRegisterInFlight = new Map();

function isRealMunicipalityId(id) {
  return typeof id === 'number' || (typeof id === 'string' && /^\d+$/.test(id));
}

async function autoRegisterMunicipality(name, countryCode, lat, lon, osmType, osmId) {
  if (!name) return null;
  const key = normalizeMuniNameForMatch(name) + '|' + (countryCode || '');
  if (_autoRegisterInFlight.has(key)) return _autoRegisterInFlight.get(key);

  const promise = (async () => {
    const row = {
      osm_type: osmType || 'unknown',
      osm_id: osmId != null ? osmId : -Math.floor(Math.random() * 1e9),
      admin_level: null,
      name,
      name_en: null,
      country_code: countryCode || null,
      centroid_lat: lat,
      centroid_lon: lon,
      boundary: { type: 'Polygon', coordinates: [] },
      bbox: null,
      slug: generateMuniSlug()
    };
    try {
      const { data, error } = await sb.from(MUNICIPALITIES_TABLE).insert(row).select().single();
      if (error) throw error;
      municipalityCache.push(data);
      loadedMuniIds.add(data.id);
      municipalityById.set(String(data.id), data);
      writeMunicipalityCacheToStorage(municipalityCache);
      return data;
    } catch (err) {

      const isDuplicateKey = err.code === '23505' || /duplicate key/i.test(err.message || '');
      if (isDuplicateKey && osmType && osmId != null) {
        try {
          const { data: existing, error: fetchErr } = await sb.from(MUNICIPALITIES_TABLE)
            .select(MUNI_SELECT_COLS).eq('osm_type', osmType).eq('osm_id', osmId).maybeSingle();
          if (!fetchErr && existing) {
            mergeMunicipalitiesIntoCache([existing]);
            return existing;
          }
        } catch (fetchErr) {
          console.error('Failed to fetch existing municipality after duplicate-key conflict:', fetchErr.message);
        }
      }
      console.error('Failed to auto-register municipality (showing it for this session only):', err.message);
      row.id = 'session:' + key;
      return row;
    }
  })();
  _autoRegisterInFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    _autoRegisterInFlight.delete(key);
  }
}

async function resolveMunicipalityViaGeocode(lat, lon) {
  if (!isValidLatLng(lat, lon)) return null;
  await ensureMunicipalitiesNear(lat, lon);
  const { candidates, countryCode, bestName, osmType, osmId } = await reverseGeocodeMunicipalityCandidates(lat, lon);
  if (!candidates.length) return null;

  if (countryCode) await ensureCountryMunicipalitiesLoaded(countryCode);
  const hit = findMunicipalityByNameMatch(candidates, countryCode);
  if (hit) return hit;
  return autoRegisterMunicipality(bestName, countryCode, lat, lon, osmType, osmId);
}

async function resolveReportMunicipality(report) {
  await ensureMunicipalitiesNear(report.latitude, report.longitude);
  if (report.municipality_id != null) {
    const stored = getMunicipalityById(report.municipality_id);
    if (stored) return stored;
  }
  let muni = findMunicipalityInCache(report.latitude, report.longitude);
  if (!muni) muni = await resolveMunicipalityViaGeocode(report.latitude, report.longitude);
  if (muni && isRealMunicipalityId(muni.id)) {
    sb.from(TABLE).update({ municipality_id: muni.id }).eq('id', report.id)
      .then(({ error }) => { if (!error) report.municipality_id = muni.id; });
  }
  return muni;
}

function resolveAndAttachMunicipality(reportId, lat, lon) {
  resolveMunicipality(lat, lon).then(muni => {
    if (!muni || !isRealMunicipalityId(muni.id) || !reportId) return;
    sb.from(TABLE).update({ municipality_id: muni.id }).eq('id', reportId)
      .then(({ error }) => { if (error) console.error('Failed to attach municipality to report:', error.message); });
  }).catch(err => console.error('resolveAndAttachMunicipality error:', err.message));
}

function showMunicipalityLabel(muni) {
  const bar = document.getElementById('bottomMuniBar');
  const nameEl = document.getElementById('bottomMuniBarName');
  if (!bar || !nameEl) return;
  nameEl.textContent = muni ? (isSerbianLang() ? muni.name : (muni.name_en || muni.name)) : '-';
  bar.style.display = 'flex';
}

let bottomMuniStatsRequestId = 0;

function updateBottomMunicipalityBar(muni) {
  const contactsBtn = document.getElementById('municipalityContactsBtn');
  if (contactsBtn) {
    const canShowContacts = !!muni && isRealMunicipalityId(muni.id);
    contactsBtn.style.display = 'flex';
    contactsBtn.disabled = !canShowContacts;
    contactsBtn.classList.toggle('is-disabled', !canShowContacts);
  }
  loadBottomMuniStats(muni);
}

async function loadBottomMuniStats(muni) {
  const row = document.getElementById('bottomMuniStatsRow');
  if (!row) return;
  const requestId = ++bottomMuniStatsRequestId;
  const statuses = ['reported', 'in_progress', 'fixed'];
  if (!muni || !isRealMunicipalityId(muni.id)) {
    row.innerHTML = statuses.map(status => `
      <div class="bottom-muni-stat">
        <span class="bottom-muni-stat-dot" style="background:${statusColor(status)}"></span>
        <span class="bottom-muni-stat-val">-</span>
        <span>${statusLabel(status)}</span>
      </div>`).join('');
    row.style.display = 'flex';
    return;
  }
  try {
    const counts = await Promise.all(statuses.map(status =>
      sb.from(TABLE).select('id', { count: 'exact', head: true })
        .eq('municipality_id', muni.id).eq('status', status)
        .then(({ count, error }) => { if (error) throw error; return count || 0; })
    ));
    if (requestId !== bottomMuniStatsRequestId) return;

    row.innerHTML = statuses.map((status, i) => `
      <div class="bottom-muni-stat">
        <span class="bottom-muni-stat-dot" style="background:${statusColor(status)}"></span>
        <span class="bottom-muni-stat-val">${counts[i]}</span>
        <span>${statusLabel(status)}</span>
      </div>`).join('');
    row.style.display = 'flex';
  } catch (err) {
    console.warn('loadBottomMuniStats error:', err.message || err);
    if (requestId === bottomMuniStatsRequestId) {
      row.innerHTML = statuses.map(status => `
        <div class="bottom-muni-stat">
          <span class="bottom-muni-stat-dot" style="background:${statusColor(status)}"></span>
          <span class="bottom-muni-stat-val">-</span>
          <span>${statusLabel(status)}</span>
        </div>`).join('');
      row.style.display = 'flex';
    }
  }
}

let currentContactsMunicipality = null;

function renderMunicipalityBoundary(muni, source) {
  if (source === 'gps' || source === 'pin' || source === 'center') {
    currentContactsMunicipality = muni || null;
    updateBottomMunicipalityBar(currentContactsMunicipality);
  }
  showMunicipalityLabel(muni);
}

const companyGeocodeCache = {};

const utilityCompanyRegistry = new Map();

// Language used for the preset subject/body text of emails sent *to* a
// utility company (follow-up-after-call and the report-detail "email"
// button). Derived from the company's own municipality's country_code via
// the same COUNTRY_TO_LANG map the app already uses to auto-detect a
// reporting user's UI language — no separate per-company field to
// maintain, and no separate translation strings to keep in sync: it reuses
// exactly whatever's already loaded in languages/<code>.json (falling back
// to English if that country isn't mapped, or the mapped language isn't
// one we have a file for — same fallback countryCodeToLang() already does
// for UI auto-detect).
function utilityLangFor(municipality) {
  return countryCodeToLang(municipality && municipality.country_code) || DEFAULT_LANG;
}

function buildCompanyMarkerHtml() {
  return '<div class="map-pin-badge company-marker-icon-wrap pin-upright"><span class="map-pin-glyph company-marker-icon"></span></div>';
}
async function geocodeAddress(address, muniName, countryCode) {
  const query = [address, muniName].filter(Boolean).join(', ');
  const cacheKey = `${query}|${countryCode || ''}`;
  if (cacheKey in companyGeocodeCache) return companyGeocodeCache[cacheKey];
  let result = null;
  try {
    const params = new URLSearchParams({ format: 'jsonv2', q: query, limit: '1' });
    if (countryCode) params.set('countrycodes', countryCode.toLowerCase());
    const res = await nominatimFetch(`https://nominatim.openstreetmap.org/search?${params}`, { headers: { 'Accept': 'application/json' } });
    const json = res.ok ? await res.json() : [];
    const hit = Array.isArray(json) && json[0];
    if (hit) result = { lat: parseFloat(hit.lat), lon: parseFloat(hit.lon) };
  } catch (err) {
    console.error('geocodeAddress error:', err.message);
  }
  companyGeocodeCache[cacheKey] = result;
  return result;
}
async function focusUtilityCompanyAddress(id) {
  const c = utilityCompanyRegistry.get(String(id));
  if (!c || !c.address) return;
  if (isValidLatLng(c.lat, c.lon)) { viewLocationOnMap(c.lat, c.lon); return; }
  const muni = getMunicipalityById(c.municipality_id);
  const pos = await geocodeAddress(c.address, muni ? municipalityDisplayName(muni) : '', muni ? muni.country_code : null);
  if (!pos || !isValidLatLng(pos.lat, pos.lon)) return;
  viewLocationOnMap(pos.lat, pos.lon);
}

let lastLoadedCompanyBBox = null;
const loadedCompanyMarkerIds = new Set();

async function loadCompanyMarkersByWindow() {
  const bbox = currentViewportBBox();
  lastLoadedCompanyBBox = bbox;
  let companies;
  try {
    const { data, error } = await sb.from(UTILITY_COMPANIES_TABLE)
      .select('*')
      .eq('verified', true)
      .not('lat', 'is', null)
      .not('lon', 'is', null)
      .gte('lat', bbox.minLat).lte('lat', bbox.maxLat)
      .gte('lon', bbox.minLon).lte('lon', bbox.maxLon);
    if (error) throw error;
    companies = data || [];
  } catch (err) {
    console.error('Failed to load utility companies for map pins:', err.message);
    return;
  }
  if (!companies.length) return;

  for (const c of companies) {
    if (!isValidLatLng(c.lat, c.lon)) continue;
    if (c.id != null) {
      if (loadedCompanyMarkerIds.has(String(c.id))) {
        utilityCompanyRegistry.set(String(c.id), c);

        continue;
      }
      utilityCompanyRegistry.set(String(c.id), c);
      loadedCompanyMarkerIds.add(String(c.id));
    }
    const marker = L.marker([c.lat, c.lon], {
      icon: L.divIcon({ className: '', html: buildCompanyMarkerHtml(), iconSize: [26, 26], iconAnchor: [13, 13] }),
      zIndexOffset: 200
    });
    marker._utilityCompany = { c, lat: c.lat, lon: c.lon };
    marker.off('click');
    marker.on('click', () => {
      if (drivingMode) navigateToUtilityCompany(String(c.id), c.lat, c.lon);
      else showCompanyDetailModal(String(c.id));
    });
    marker.addTo(companyMarkersLayer);
  }
}

const scheduleCompanyMarkersReloadIfNeeded = debounceWithMaxWait(() => {
  const b = map.getBounds();
  const visible = { minLat: b.getSouthWest().lat, maxLat: b.getNorthEast().lat, minLon: b.getSouthWest().lng, maxLon: b.getNorthEast().lng };
  if (!viewportBBoxContains(lastLoadedCompanyBBox, visible)) loadCompanyMarkersByWindow();
}, VIEWPORT_RELOAD_DEBOUNCE_MS, VIEWPORT_RELOAD_MAX_WAIT_MS);
function scheduleCompanyMarkersReload() {
  if (isMapZooming()) return;
  scheduleCompanyMarkersReloadIfNeeded();
}
map.on('moveend', scheduleCompanyMarkersReload);
map.on('zoomend', scheduleCompanyMarkersReload);

const municipalityStatsCache = new Map();
const municipalityStatsFetchInFlight = new Map();
async function getMunicipalityStats(municipalityId) {
  if (municipalityStatsCache.has(municipalityId)) return municipalityStatsCache.get(municipalityId);
  if (municipalityStatsFetchInFlight.has(municipalityId)) return municipalityStatsFetchInFlight.get(municipalityId);
  const promise = (async () => {
    try {
      const { data, error } = await sb.from(MUNICIPALITY_STATS_TABLE).select('*')
        .eq('municipality_id', municipalityId).maybeSingle();
      if (error) throw error;
      municipalityStatsCache.set(municipalityId, data || null);
      return data || null;
    } catch (err) {
      console.error('Failed to load municipality stats:', err.message);
      return null;
    } finally {
      municipalityStatsFetchInFlight.delete(municipalityId);
    }
  })();
  municipalityStatsFetchInFlight.set(municipalityId, promise);
  return promise;
}

const utilityCompanyStatsCache = new Map();
const utilityCompanyStatsFetchInFlight = new Map();
async function getUtilityCompanyStats(companyId) {
  if (utilityCompanyStatsCache.has(companyId)) return utilityCompanyStatsCache.get(companyId);
  if (utilityCompanyStatsFetchInFlight.has(companyId)) return utilityCompanyStatsFetchInFlight.get(companyId);
  const promise = (async () => {
    try {
      const { data, error } = await sb.from(UTILITY_COMPANY_STATS_TABLE).select('*')
        .eq('company_id', companyId).maybeSingle();
      if (error) throw error;
      utilityCompanyStatsCache.set(companyId, data || null);
      return data || null;
    } catch (err) {
      console.error('Failed to load utility company stats:', err.message);
      return null;
    } finally {
      utilityCompanyStatsFetchInFlight.delete(companyId);
    }
  })();
  utilityCompanyStatsFetchInFlight.set(companyId, promise);
  return promise;
}

function buildMuniStatsGridHtml(stats) {
  if (!stats || !stats.total_reports) return '';
  const avgRepair = stats.avg_repair_days != null
    ? t('muniStatsDaysUnit').replace('{n}', String(Math.round(parseFloat(stats.avg_repair_days) * 10) / 10))
    : t('muniStatsNoRepairData');
  const responseRate = stats.response_rate_pct != null ? `${Math.round(parseFloat(stats.response_rate_pct))}%` : '—';
  return `<div class="muni-stats-grid">
    <div class="muni-stat">
      <span class="muni-stat-value">${Number(stats.total_reports || 0).toLocaleString()}</span>
      <span class="muni-stat-label">${t('muniStatsReportsLabel')}</span>
    </div>
    <div class="muni-stat">
      <span class="muni-stat-value">${Number(stats.fixed_reports || 0).toLocaleString()}</span>
      <span class="muni-stat-label">${t('muniStatsFixedLabel')}</span>
    </div>
    <div class="muni-stat">
      <span class="muni-stat-value">${escapeHtml(avgRepair)}</span>
      <span class="muni-stat-label">${t('muniStatsAvgRepairLabel')}</span>
    </div>
    <div class="muni-stat">
      <span class="muni-stat-value">${escapeHtml(responseRate)}</span>
      <span class="muni-stat-label">${t('muniStatsResponseRateLabel')}</span>
    </div>
  </div>`;
}
async function backfillUcCoordinates() {
  if (!currentProfile || !currentProfile.is_admin) return;
  const btn = document.getElementById('ucGeocodeBackfillBtn');
  if (btn) { btn.disabled = true; btn.textContent = t('ucGeocodeBackfillScanning'); }

  // This is a deliberate, opt-in sweep across the admin's whole domain (a
  // whole continent, for a level-3 admin) — unlike the lightweight per-
  // country browsing cache, so it fetches its own municipality/contact data
  // for every domain country here rather than relying on whatever happens to
  // be loaded for the currently open country.
  let candidates = [];
  try {
    for (const { code } of ucCountryIndex) {
      await ensureCountryMunicipalitiesLoaded(code);
      const muniIds = municipalityCache
        .filter(m => m.country_code === code && isMunicipalityInAdminDomain(m))
        .map(m => m.id);
      if (!muniIds.length) continue;
      const companies = await fetchCompaniesForMuniIds(muniIds);
      candidates.push(...companies.filter(c => c.address && !isValidLatLng(c.lat, c.lon)));
    }
  } catch (err) {
    console.error('Failed to gather geocode-backfill candidates:', err.message);
  }

  if (!candidates.length) {
    if (btn) {
      btn.textContent = t('ucGeocodeBackfillNone');
      btn.disabled = false;
    }
    setTimeout(() => { if (btn) btn.textContent = t('ucGeocodeBackfillBtn'); }, 3000);
    return;
  }
  let found = 0;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (btn) btn.textContent = t('ucGeocodeBackfillRunning').replace('{current}', String(i + 1)).replace('{total}', String(candidates.length));
    const muni = getMunicipalityById(c.municipality_id);
    const pos = await geocodeAddress(c.address, muni ? municipalityDisplayName(muni) : '', muni ? muni.country_code : null);
    if (pos && isValidLatLng(pos.lat, pos.lon)) {
      try {
        const { error } = await sb.from(UTILITY_COMPANIES_TABLE).update({ lat: pos.lat, lon: pos.lon }).eq('id', c.id);
        if (error) throw error;
        found++;
      } catch (err) {
        console.error('Failed to save backfilled coordinates for', c.name, ':', err.message);
      }
    }
  }
  if (btn) {
    btn.textContent = t('ucGeocodeBackfillDone').replace('{found}', String(found)).replace('{total}', String(candidates.length));
    btn.disabled = false;
    setTimeout(() => { btn.textContent = t('ucGeocodeBackfillBtn'); }, 4000);
  }
  loadCompanyMarkersByWindow();
  await refreshUcOpenCountry();
}

function boundaryHasRings(boundary) {
  if (!boundary || !boundary.coordinates) return false;
  const rings = boundary.type === 'MultiPolygon'
    ? (boundary.coordinates || []).reduce((n, p) => n + (p && p.length ? 1 : 0), 0)
    : boundary.coordinates.length;
  return rings > 0;
}

function isSessionOnlyMuniId(id) {
  return typeof id === 'string' && id.startsWith('session:');

}

// Known cross-language name aliases for municipalities where the local name
// and a foreign exonym don't share enough characters for plain text
// normalization to recognize them as the same place (e.g. "Belgrade" vs
// "Beograd"). Each inner array lists interchangeable normalized names —
// add more pairs here as they come up. Matching still also requires the
// same country_code, so this can't merge across countries.
const MUNI_NAME_ALIAS_GROUPS = [
  ['belgrade', 'beograd'],
];
const MUNI_NAME_ALIAS_MAP = new Map();
MUNI_NAME_ALIAS_GROUPS.forEach(group => group.forEach(name => MUNI_NAME_ALIAS_MAP.set(name, group[0])));

// A municipality can have its "duplicate identity" hiding in either name
// field (one record might only have name_en populated, another only name),
// so this returns every normalized/aliased key it could plausibly be filed
// under rather than picking a single preferred field.
function municipalityMergeKeys(m) {
  const country = (m.country_code || '').toUpperCase();
  const keys = new Set();
  [m.name, m.name_en].forEach(raw => {
    const norm = normalizeMuniNameForMatch(raw);
    if (!norm) return;
    keys.add((MUNI_NAME_ALIAS_MAP.get(norm) || norm) + '|' + country);
  });
  return keys;
}

// Groups municipalities that share ANY normalized/aliased key via
// union-find, so e.g. A↔B (via name) and B↔C (via name_en) end up in one
// group {A,B,C} even though A and C might not directly share a key.
function findDuplicateMunicipalityGroups(list) {
  const parent = list.map((_, i) => i);
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }

  const keyToIndices = new Map();
  list.forEach((m, i) => {
    municipalityMergeKeys(m).forEach(key => {
      if (!keyToIndices.has(key)) keyToIndices.set(key, []);
      keyToIndices.get(key).push(i);
    });
  });
  keyToIndices.forEach(indices => { for (let i = 1; i < indices.length; i++) union(indices[0], indices[i]); });

  const groups = new Map();
  list.forEach((m, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(m);
  });
  return [...groups.values()];
}

function pickCanonicalMunicipality(group, verifiedMuniIds) {
  // Never let a municipality with admin-confirmed contacts lose its row to
  // an arbitrary duplicate — prefer it as canonical so nothing has to move.
  const verified = verifiedMuniIds ? group.filter(m => verifiedMuniIds.has(String(m.id))) : [];
  const base = verified.length ? verified : group;
  const withRings = base.filter(m => boundaryHasRings(m.boundary));
  const pool = withRings.length ? withRings : base;
  return pool.slice().sort((a, b) => {
    const aSession = isSessionOnlyMuniId(a.id), bSession = isSessionOnlyMuniId(b.id);
    if (aSession !== bSession) return aSession ? 1 : -1;
    const an = Number(a.id), bn = Number(b.id);
    if (!isNaN(an) && !isNaN(bn)) return an - bn;
    return 0;
  })[0];
}

async function mergeDuplicateMunicipalities(onProgress) {
  const dupGroups = findDuplicateMunicipalityGroups(municipalityCache).filter(g => g.length > 1);
  const merges = [];
  let done = 0;
  const totalDupes = dupGroups.reduce((n, g) => n + g.length - 1, 0);

  // Look up which of these municipalities already have admin-verified
  // contacts, so pickCanonicalMunicipality can keep that one instead of an
  // arbitrary duplicate.
  const candidateIds = dupGroups.flat().filter(m => !isSessionOnlyMuniId(m.id)).map(m => m.id);
  const verifiedMuniIds = new Set();
  if (candidateIds.length) {
    try {
      const { data, error } = await sb.from(UTILITY_COMPANIES_TABLE)
        .select('municipality_id')
        .in('municipality_id', candidateIds)
        .eq('verified', true);
      if (error) throw error;
      (data || []).forEach(row => verifiedMuniIds.add(String(row.municipality_id)));
    } catch (err) {
      console.error('Failed to look up verified contacts for duplicate municipalities:', err.message);
    }
  }

  for (const group of dupGroups) {
    const canonical = pickCanonicalMunicipality(group, verifiedMuniIds);
    for (const dup of group) {
      if (dup === canonical) continue;
      done++;
      if (onProgress) onProgress(done, totalDupes);

      if (!isSessionOnlyMuniId(dup.id)) {
        try {
          const { error: reportErr } = await sb.from(TABLE)
            .update({ municipality_id: canonical.id })
            .eq('municipality_id', dup.id);
          if (reportErr) throw reportErr;
        } catch (err) {
          console.error(`Failed to reassign reports from municipality ${dup.id} to ${canonical.id}:`, err.message);
          continue;
        }
        try {
          // Utility contacts must move over too — verified or not — or
          // merging a duplicate away would silently delete/orphan any
          // contacts an admin already entered and confirmed for it.
          const { error: contactErr } = await sb.from(UTILITY_COMPANIES_TABLE)
            .update({ municipality_id: canonical.id })
            .eq('municipality_id', dup.id);
          if (contactErr) throw contactErr;
        } catch (err) {
          console.error(`Failed to reassign contacts from municipality ${dup.id} to ${canonical.id}:`, err.message);
          continue;
        }
        try {
          const { error: delErr } = await sb.from(MUNICIPALITIES_TABLE).delete().eq('id', dup.id);
          if (delErr) throw delErr;
        } catch (err) {
          console.error(`Failed to delete duplicate municipality ${dup.id}:`, err.message);
          continue;
        }
      }

      municipalityCache = municipalityCache.filter(m => m !== dup);
      merges.push({ removedId: dup.id, keptId: canonical.id, name: dup.name || dup.name_en });
    }
  }

  writeMunicipalityCacheToStorage(municipalityCache);
  return merges;
}

async function repairEmptyMunicipalityBoundaries(onProgress) {
  const broken = municipalityCache.filter(m => !boundaryHasRings(m.boundary) && isValidLatLng(m.centroid_lat, m.centroid_lon));
  let fixed = 0;
  for (let i = 0; i < broken.length; i++) {
    const m = broken[i];
    if (onProgress) onProgress(i + 1, broken.length);

    const geo = await fetchBoundaryGeometryForPoint(m.centroid_lat, m.centroid_lon);
    if (!geo) continue;

    const patch = {
      boundary: geo.boundary,
      bbox: geo.bbox,
      osm_type: geo.osm_type || m.osm_type,
      osm_id: geo.osm_id != null ? geo.osm_id : m.osm_id
    };

    if (isSessionOnlyMuniId(m.id)) {

      Object.assign(m, patch);
      fixed++;
      continue;
    }

    try {
      const { data, error } = await sb.from(MUNICIPALITIES_TABLE).update(patch).eq('id', m.id).select().single();
      if (error) throw error;
      Object.assign(m, data);
      fixed++;
    } catch (err) {
      console.error(`Failed to repair boundary for municipality ${m.id} (${m.name}):`, err.message);
    }
  }
  writeMunicipalityCacheToStorage(municipalityCache);
  return { fixed, total: broken.length };
}

async function fixAllMunicipalityBoundaries() {
  if (!currentProfile || !currentProfile.is_admin) return;
  const btn = document.getElementById('ucFixBoundariesBtn');
  await loadMunicipalityCache(true);

  const dupeCount = findDuplicateMunicipalityGroups(municipalityCache).filter(g => g.length > 1).length;
  const brokenCount = municipalityCache.filter(m => !boundaryHasRings(m.boundary) && isValidLatLng(m.centroid_lat, m.centroid_lon)).length;

  if (!dupeCount && !brokenCount) {
    if (btn) btn.textContent = t('ucFixBoundariesNone');
    setTimeout(() => { if (btn) btn.textContent = t('ucFixBoundariesBtn'); }, 3000);
    return;
  }

  if (!confirm(t('ucFixBoundariesConfirm').replace('{count}', String(brokenCount)))) return;

  const original = btn ? btn.innerHTML : '';
  if (btn) btn.disabled = true;

  const merges = await mergeDuplicateMunicipalities((current, total) => {
    if (btn) btn.textContent = t('ucFixBoundariesMerging').replace('{current}', String(current)).replace('{total}', String(total));
  });

  const { fixed, total } = await repairEmptyMunicipalityBoundaries((current, tot) => {
    if (btn) btn.textContent = t('ucFixBoundariesRunning').replace('{current}', String(current)).replace('{total}', String(tot));
  });

  if (btn) {
    btn.textContent = t('ucFixBoundariesDone')
      .replace('{merged}', String(merges.length))
      .replace('{fixed}', String(fixed))
      .replace('{total}', String(total));
    btn.disabled = false;
    setTimeout(() => { btn.innerHTML = original || t('ucFixBoundariesBtn'); }, 5000);
  }

  populateUcMunicipalitySelect();
  await refreshUcOpenCountry();
  toast(t('ucFixBoundariesDone')
    .replace('{merged}', String(merges.length))
    .replace('{fixed}', String(fixed))
    .replace('{total}', String(total)), 'success');
}

function buildCompanyCatsHtml(c, marginBottom) {
  const chips = (c.categories && c.categories.length)
    ? c.categories.map(cat => `<span class="uc-cat-chip" style="background:${categoryColor(cat)};">${escapeHtml(translateCategory(cat))}</span>`).join('')
    : `<span class="uc-cat-chip uc-cat-chip-empty">${escapeHtml(t('ucUncategorizedChip'))}</span>`;
  return `<div class="uc-item-cats" style="margin-bottom:${marginBottom || 0}px;">${chips}</div>`;
}

function buildCompanyPopupHtml(c, lat, lon) {

  const navigateBtnHtml = (drivingMode && isValidLatLng(lat, lon) && c.id != null)
    ? `<button class="status-action-btn" style="background:#2a2a2a;" onclick="navigateToUtilityCompany('${escapeHtml(String(c.id))}', ${lat}, ${lon})">${t('navigatePinPopupBtn')}</button>`
    : '';
  const headerColor = (c.categories && c.categories[0]) ? categoryColor(c.categories[0]) : '#3a3a3a';
  const catsHtml = buildCompanyCatsHtml(c, 8);
  if (c && c.id != null) utilityCompanyRegistry.set(String(c.id), c);
  const iconBtnsHtml = [
    ...contactEntries(c.phone).map(p => `<a class="poi-contact-icon-btn" href="tel:${escapeHtml(p.value)}" title="${escapeHtml(p.label ? `${p.label}: ${p.value}` : p.value)}"><img src="icons/phone.png" alt="phone"></a>`),
    ...contactEntries(c.email).map(e => `<a class="poi-contact-icon-btn" href="mailto:${escapeHtml(e.value)}" title="${escapeHtml(e.label ? `${e.label}: ${e.value}` : e.value)}"><img src="icons/email.png" alt="email"></a>`),
    c.website ? `<a class="poi-contact-icon-btn" href="${escapeHtml(c.website)}" target="_blank" rel="noopener" title="${escapeHtml(c.website)}"><img src="icons/link.png" alt="website"></a>` : ''
  ].filter(Boolean).join('');
  const iconRowHtml = iconBtnsHtml ? `<div class="poi-contact-icons">${iconBtnsHtml}</div>` : '';
  return `<div class="popup-inner popup-card">
    <div class="popup-header" style="background:${headerColor};">
      <span class="popup-header-title">${escapeHtml(c.name)}</span>
    </div>
    <div class="popup-body" style="padding:12px 14px;">
      ${catsHtml}
      ${iconRowHtml}
    </div>
    <div class="status-action-row" style="border-top:none;padding-top:0;">
      ${navigateBtnHtml}
      <button class="status-action-btn" style="background:#2a2a2a;" onclick="showCompanyDetailModal('${escapeHtml(String(c.id))}')">${t('detailsBtn')}</button>
      <button class="status-action-btn popup-close-btn" style="background:#ff4b4b;" onclick="map.closePopup();">${t('closeBtn')}</button>
    </div>
  </div>`;
}
function hideMunicipalityContactsModal() {
  const modal = document.getElementById('municipalityContactsModal');
  if (modal) modal.style.display = 'none';
  closeOverlay('municipalityContactsModal');
}

async function showMunicipalityContactsModal() {
  if (!currentContactsMunicipality || !isRealMunicipalityId(currentContactsMunicipality.id)) {
    toast(t('municipalityContactsNoMuni'), 'error');
    return;
  }
  const muni = currentContactsMunicipality;
  const modal = document.getElementById('municipalityContactsModal');
  const titleEl = document.getElementById('municipalityContactsTitle');
  const bodyEl = document.getElementById('municipalityContactsBody');
  if (!modal || !bodyEl) return;
  titleEl.textContent = municipalityDisplayName(muni);
  bodyEl.innerHTML = `<div class="detail-loading">${t('detailLoading')}</div>`;
  bringModalToFront(modal);
  modal.style.display = 'flex';
  openOverlay('municipalityContactsModal', hideMunicipalityContactsModal);

  try {

    // Prefer verified contacts, same as the report-detail contact lookup
    // (getReportContacts). Only fall back to unverified ones if there's
    // nothing verified yet, so the "verified contacts" hint and the
    // "not verified yet" warning are never shown for the same list at once.
    let { data, error } = await sb.from(UTILITY_COMPANIES_TABLE)
      .select('*')
      .eq('municipality_id', muni.id)
      .eq('verified', true)
      .order('name');
    if (error) throw error;
    let companies = data || [];
    let showingUnverified = false;
    if (!companies.length) {
      const fallback = await sb.from(UTILITY_COMPANIES_TABLE)
        .select('*')
        .eq('municipality_id', muni.id)
        .order('name');
      if (fallback.error) throw fallback.error;
      companies = fallback.data || [];
      showingUnverified = companies.length > 0;
    }

    bodyEl.innerHTML = companies.length
      ? `<p class="detail-export-hint">${t(showingUnverified ? 'municipalityContactsUnverifiedNote' : 'municipalityContactsHint')}</p>` +
        renderContactCards(companies, null)
      : `<div class="detail-empty">${t('detailNoContacts')}</div>`;
  } catch (err) {
    console.error('Failed to load municipality contacts:', err.message);
    bodyEl.innerHTML = `<div class="detail-empty">${t('detailNoContacts')}</div>`;
  }
}

function hideCompanyDetailModal() {
  const modal = document.getElementById('companyDetailModal');
  if (modal) modal.style.display = 'none';
  closeOverlay('companyDetailModal');
}

let companyDetailStatsRequestId = 0;
async function showCompanyDetailModal(id) {
  const c = utilityCompanyRegistry.get(String(id));
  if (!c) return;
  const modal = document.getElementById('companyDetailModal');
  const body = document.getElementById('companyDetailBody');
  const titleEl = document.getElementById('companyDetailTitle');
  const headerEl = document.getElementById('companyDetailHeader');
  if (!modal || !body || !titleEl) return;

  const requestId = ++companyDetailStatsRequestId;

  titleEl.textContent = c.name;
  if (headerEl) {
    headerEl.style.background = (c.categories && c.categories[0]) ? categoryColor(c.categories[0]) : '#3a3a3a';
    headerEl.classList.add('status-colored');
  }

  const catsHtml = buildCompanyCatsHtml(c, 2);

  const muni = c.municipality_id != null ? getMunicipalityById(c.municipality_id) : null;
  const muniSectionHtml = muni
    ? `<div class="detail-section">
        <div class="detail-row"><span class="detail-row-label"><img class="detail-row-icon" src="icons/pin.png" alt="">${t('detailMunicipalityLabel')}</span><span class="detail-row-value">${escapeHtml(municipalityDisplayName(muni))}</span></div>
      </div>`
    : '';

  body.innerHTML = `
    <div class="detail-section">
      <div class="detail-section-title">${t('detailContactsTitle')}</div>
      ${catsHtml}
      ${renderContactRows(c)}
    </div>
    <div id="companyDetailCompanyStatsSection"></div>
    ${muniSectionHtml}
    <div id="companyDetailStatsSection"></div>
  `;

  bringModalToFront(modal);
  modal.style.display = 'flex';
  openOverlay('companyDetailModal', hideCompanyDetailModal);

  const [companyStats, muniStats] = await Promise.all([
    getUtilityCompanyStats(c.id),
    c.municipality_id != null ? getMunicipalityStats(c.municipality_id) : Promise.resolve(null)
  ]);
  if (requestId !== companyDetailStatsRequestId) return;

  const companyStatsHtml = buildMuniStatsGridHtml(companyStats);
  const companyStatsSectionEl = document.getElementById('companyDetailCompanyStatsSection');
  if (companyStatsSectionEl && companyStatsHtml) {
    companyStatsSectionEl.innerHTML = `
      <div class="detail-section">
        <div class="detail-section-title">${t('companyStatsSectionLabel')}</div>
        ${companyStatsHtml}
      </div>`;
  }

  if (c.municipality_id != null) {
    const statsHtml = buildMuniStatsGridHtml(muniStats);
    const statsSectionEl = document.getElementById('companyDetailStatsSection');
    if (statsSectionEl && statsHtml) {
      statsSectionEl.innerHTML = `
        <div class="detail-section">
          <div class="detail-section-title">${t('muniStatsSectionLabel')}</div>
          ${statsHtml}
        </div>`;
    }
  }
}
function navigateToUtilityCompany(id, lat, lon) {
  const c = utilityCompanyRegistry.get(String(id));
  selectDestination(lat, lon, c ? c.name : '');
}
function buildMunicipalityPopupHtml(muni, lat, lon) {
  const name = muni ? municipalityDisplayName(muni) : t('detailUnknown');
  return `<div class="popup-inner popup-card">
    <div class="popup-header" style="background:#3a3a3a;">
      <span class="popup-header-title">${escapeHtml(t('detailMunicipalityLabel'))}</span>
    </div>
    <div class="popup-body">
      <div class="popup-row">
        <span class="popup-row-label">${t('detailMunicipalityLabel')}</span>
        <span class="popup-row-value">${escapeHtml(name)}</span>
      </div>
      <div class="popup-row">
        <span class="popup-row-label">${t('detailCoordsLabel')}</span>
        <span class="popup-row-value">${lat.toFixed(6)}, ${lon.toFixed(6)}</span>
      </div>
    </div>
  </div>`;
}

function bindMunicipalityPopupToMarker(marker, muni, lat, lon) {
  if (!marker) return;
  const html = buildMunicipalityPopupHtml(muni, lat, lon);
  if (marker.getPopup()) marker.setPopupContent(html);
  else marker.bindPopup(html, { autoPan: false, closeButton: false });
}
async function showMunicipalityBoundaryForPoint(lat, lon, marker, source) {
  const muni = await resolveMunicipality(lat, lon);
  renderMunicipalityBoundary(muni, source);
  if (marker) bindMunicipalityPopupToMarker(marker, muni, lat, lon);
  return muni;
}

const UC_CATEGORIES = ['Water','Electricity','Sewage','Gas','Heating','Road','Streetlight','Waste','Walkways','BikeLanes','GreenSpaces','Parking','Suggestion','Forest','FarmersMarket','Other'];
let ucCompaniesCache = [];
let ucEditingId = null;
let ucEditingVerified = false;
let ucEditingVerifiedAt = null;
let ucMuniSelectPopulateToken = 0;
// Set by editUtilityCompany/quickAddUcContact right before they try to set
// ucMunicipalitySelect's value. The select's options are (re)populated
// asynchronously in chunks (see populateUcMunicipalitySelect), so a direct
// `sel.value = x` right after opening a country can silently fail — no
// matching <option> exists yet. This lets the chunk-population completion
// apply the *intended* value once the options actually land, instead of
// falling back to whatever stale value the select happened to have.
let ucDesiredMuniSelectValue = null;
// In-memory rows for the admin form's phone/email multi-entry lists, each
// { value, label }. Kept separate from the DOM (rather than one input per
// entry with generated ids) so add/remove/reorder just re-render from this
// array instead of juggling ids.
let ucFormPhones = [];
let ucFormEmails = [];
let ucCountryIndex = [];      // [{code, continent}] — countries in the admin's domain, lightweight
let ucOpenCountryCode = null; // the single country currently expanded/loaded in the browse tree
let ucCountryLoadToken = 0;   // guards against a stale async load winning a race when switching countries fast
let ucCountryDataLoading = false;
let ucCountrySearchQuery = ''; // secondary, in-country search (municipality/contact/category)
let ucHomeCountryCode = null;

function municipalityDisplayName(m) {
  if (!m) return '';
  return (isSerbianLang() ? m.name : (m.name_en || m.name)) || m.name;
}
function canManageContactsForMunicipality(municipalityId) {
  if (!currentProfile || !currentProfile.is_admin) return false;
  if (currentAdminLevel() >= 4) return true;
  const muni = municipalityId != null ? getMunicipalityById(municipalityId) : null;
  return isMunicipalityInAdminDomain(muni);
}

async function resolveAdminHomeCountryCode() {
  const lvl = currentAdminLevel();
  if (lvl === 2 || lvl === 3) return currentProfile.admin_country_code || null;
  if (lvl === 1) {
    if (currentProfile.admin_municipality_id == null) return null;
    let muni = getMunicipalityForAdminAssignment(currentProfile.admin_municipality_id);
    if (!muni) {
      // Don't fall back to loading the whole municipality cache just to find
      // one row — fetch this single municipality directly.
      try {
        const { data, error } = await sb.from(MUNICIPALITIES_TABLE)
          .select(MUNI_SELECT_COLS_LITE)
          .eq('id', currentProfile.admin_municipality_id)
          .maybeSingle();
        if (error) throw error;
        if (data) { mergeMunicipalitiesIntoCache([data]); muni = data; }
      } catch (err) {
        console.error('Failed to resolve admin municipality country:', err.message);
      }
    }
    return muni ? muni.country_code : null;
  }
  return null; // level 4 (global) has no single "home" country
}

function isCountryInAdminDomain(countryCode) {
  const lvl = currentAdminLevel();
  if (!lvl || !countryCode) return false;
  if (lvl >= 4) return true;
  if (lvl === 3) {
    const continent = resolveAdminContinent(currentProfile);
    return !!(continent && continentOfCountry(countryCode) === continent);
  }
  if (lvl === 2) return countryCode === currentProfile.admin_country_code;
  return !!ucHomeCountryCode && countryCode === ucHomeCountryCode;
}

// Builds just the country list for the admin's domain from the small,
// already-loaded country/continent table — no municipality or contact rows
// are touched here. A given country's municipalities and utility contacts
// are only fetched once that country is opened (see openUcCountry), so a
// level-3 (continent) admin no longer pays for every municipality and
// contact worldwide just to open this panel.
function buildUcCountryIndex() {
  ucCountryIndex = Array.from(countryContinentCache.keys())
    .filter(isCountryInAdminDomain)
    .map(code => ({ code, continent: continentOfCountry(code) }));
}

async function fetchCompaniesForMuniIds(muniIds) {
  const CHUNK = 500;
  const rows = [];
  for (let i = 0; i < muniIds.length; i += CHUNK) {
    const slice = muniIds.slice(i, i + CHUNK);
    const { data, error } = await sb.from(UTILITY_COMPANIES_TABLE)
      .select('*').in('municipality_id', slice).order('name');
    if (error) throw error;
    rows.push(...(data || []));
  }
  return rows;
}

async function fetchFlagCountsForCompanyIds(companyIds) {
  const counts = new Map();
  const CHUNK = 500;
  for (let i = 0; i < companyIds.length; i += CHUNK) {
    const slice = companyIds.slice(i, i + CHUNK);
    const { data, error } = await sb.from('utility_contact_flags')
      .select('company_id').eq('resolved', false).in('company_id', slice);
    if (error) throw error;
    (data || []).forEach(row => {
      const key = String(row.company_id);
      counts.set(key, (counts.get(key) || 0) + 1);
    });
  }
  return counts;
}

// Loads (or switches to) a single country in the browse tree: its
// municipalities and utility contacts. Only one country's contacts are kept
// in memory at a time — opening a new country drops the previous one's
// instead of accumulating data for every country the admin has visited.
async function openUcCountry(countryCode, preserveSearch) {
  if (!countryCode || !isCountryInAdminDomain(countryCode)) return;
  const token = ++ucCountryLoadToken;
  ucOpenCountryCode = countryCode;
  if (!preserveSearch) ucCountrySearchQuery = '';
  ucCompaniesCache = [];
  ucContactFlagCountsCache = new Map();
  ucCountryDataLoading = true;
  renderUcList();
  try {
    await ensureCountryMunicipalitiesLoaded(countryCode);
    if (token !== ucCountryLoadToken) return; // superseded by a newer selection
    const muniIds = municipalityCache
      .filter(m => m.country_code === countryCode && isMunicipalityInAdminDomain(m))
      .map(m => m.id);
    if (muniIds.length) {
      const companies = await fetchCompaniesForMuniIds(muniIds);
      if (token !== ucCountryLoadToken) return;
      ucCompaniesCache = companies;
      const companyIds = companies.map(c => c.id);
      if (companyIds.length) {
        const flagCounts = await fetchFlagCountsForCompanyIds(companyIds);
        if (token !== ucCountryLoadToken) return;
        ucContactFlagCountsCache = flagCounts;
      }
    }
  } catch (err) {
    console.error(`Failed to load contacts for country ${countryCode}:`, err.message);
  } finally {
    if (token === ucCountryLoadToken) ucCountryDataLoading = false;
  }
  if (token === ucCountryLoadToken) {
    populateUcMunicipalitySelect();
    renderUcList();
  }
}

function closeUcCountry() {
  ucCountryLoadToken++; // cancel any in-flight load for the country being closed
  ucOpenCountryCode = null;
  ucCountrySearchQuery = '';
  ucCompaniesCache = [];
  ucContactFlagCountsCache = new Map();
  ucCountryDataLoading = false;
  populateUcMunicipalitySelect();
  renderUcList();
}

function toggleUcCountry(countryCode) {
  if (ucOpenCountryCode === countryCode) closeUcCountry();
  else openUcCountry(countryCode);
}

// Used after a contact is saved/deleted/unflagged: refreshes whichever
// country is currently open in place, instead of resetting the whole panel
// back to the admin's home country the way a full loadUtilityCompaniesAdmin()
// reload would.
async function refreshUcOpenCountry() {
  if (ucOpenCountryCode) {
    await openUcCountry(ucOpenCountryCode, true);
  } else {
    await loadUtilityCompaniesAdmin();
  }
}

function onUcCountrySearchInput(value) {
  ucCountrySearchQuery = (value || '').trim();
  const resultsEl = ucOpenCountryCode && !ucCountryDataLoading ? document.getElementById('ucCountryResultsBody') : null;
  if (resultsEl) {
    resultsEl.innerHTML = renderOpenCountryResultsBody(ucOpenCountryCode);
  } else {
    renderUcList();
  }
}

// ---- Admin panel: Recent activity feed -----------------------------------
// Jurisdiction-scoped feed (via get_admin_activity_feed RPC, which mirrors
// admin_can_manage_municipality's level 1-4 resolution) of report
// submissions, status changes, photo submissions/reviews, gallery photos,
// flags, and utility contact logs. Each item opens the normal report detail
// modal, so admins get the existing edit/delete/status/photo-review tools
// for free just by tapping an activity item.
const ACTIVITY_FEED_PAGE_SIZE = 25;
let adminActivityFeedItems = [];
let adminActivityFeedCursor = null; // ISO timestamp of the oldest loaded item, for keyset pagination
let adminActivityFeedLoading = false;
let adminActivityFeedExhausted = false;

const ACTIVITY_EVENT_META = {
  report_submitted:        { labelKey: 'activityEvReportSubmitted' },
  status_in_progress:      { labelKey: 'activityEvStatusInProgress' },
  status_fixed:             { labelKey: 'activityEvStatusFixed' },
  photo_submitted:          { labelKey: 'activityEvPhotoSubmitted',       icon: 'icons/camera.png' },
  photo_reviewed:           { labelKey: 'activityEvPhotoReviewed',        icon: 'icons/camera.png' },
  fixed_photo_submitted:    { labelKey: 'activityEvFixedPhotoSubmitted',  icon: 'icons/camera.png' },
  fixed_photo_reviewed:     { labelKey: 'activityEvFixedPhotoReviewed',   icon: 'icons/camera.png' },
  after_photo_submitted:    { labelKey: 'activityEvAfterPhotoSubmitted',  icon: 'icons/camera.png' },
  after_photo_reviewed:     { labelKey: 'activityEvAfterPhotoReviewed',   icon: 'icons/camera.png' },
  gallery_photo_added:      { labelKey: 'activityEvGalleryPhotoAdded',    icon: 'icons/gallery.png' },
  flagged_for_review:       { labelKey: 'activityEvFlagged' },
  contact_logged:           { labelKey: 'activityEvContactLogged',       icon: 'icons/phone.png' },
};

function activityFeedIconFor(item) {
  const meta = ACTIVITY_EVENT_META[item.event_type];
  return (meta && meta.icon) ? meta.icon : categoryIcon(item.category);
}

const PHOTO_EVENT_TYPES = new Set([
  'photo_submitted', 'photo_reviewed',
  'fixed_photo_submitted', 'fixed_photo_reviewed',
  'after_photo_submitted', 'after_photo_reviewed',
]);
const PHOTO_STATUS_BADGE_KEY = { pending: 'photoPendingBadge', approved: 'photoApprovedBadge', rejected: 'photoRejectedBadge' };
const CONTACT_TYPE_LABEL_KEY = { phone: 'contactTypePhoneLabel', email: 'contactTypeEmailLabel' };

function activityFeedLine2(item) {
  const parts = [];
  const catLabel = item.subcategory
    ? `${translateCategory(item.category)} / ${subcategoryLabel(item.category, item.subcategory)}`
    : translateCategory(item.category);
  parts.push(catLabel);
  if (item.municipality_name) parts.push(item.municipality_name);
  if (item.event_type === 'contact_logged' && CONTACT_TYPE_LABEL_KEY[item.extra]) {
    parts.push(t(CONTACT_TYPE_LABEL_KEY[item.extra]));
  }
  const actor = item.actor_username ? (t('activityFeedByPrefix') + item.actor_username) : t('activityFeedUnknownActor');
  parts.push(actor);
  parts.push(formatDate(item.event_time));
  return parts.filter(Boolean).join(' · ');
}

function activityFeedCircleBg(cat) {
  const hex = (categoryColor(cat) || '#aaaaaa').replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return `rgba(${r},${g},${b},0.18)`;
}

function renderActivityFeedItem(item) {
  const meta = ACTIVITY_EVENT_META[item.event_type] || { labelKey: null };
  const label = meta.labelKey ? t(meta.labelKey) : item.event_type;
  const flagBadge = item.event_type === 'flagged_for_review' && item.extra
    ? `<span class="activity-feed-flag-badge">${escapeHtml(item.extra)}</span>`
    : '';
  const photoBadgeKey = PHOTO_EVENT_TYPES.has(item.event_type) ? PHOTO_STATUS_BADGE_KEY[item.extra] : null;
  const photoBadge = photoBadgeKey
    ? `<span class="photo-status-badge ${escapeHtml(item.extra)}">${t(photoBadgeKey)}</span>`
    : '';
  return `
    <div class="activity-feed-item" onclick="openReportFromActivityFeed('${item.report_id}')">
      <div class="activity-feed-icon" style="background:${activityFeedCircleBg(item.category)};">
        <img class="icon-img" src="${activityFeedIconFor(item)}" alt="">
      </div>
      <div class="activity-feed-body">
        <div class="activity-feed-line1">${escapeHtml(label)}${flagBadge}${photoBadge}</div>
        <div class="activity-feed-line2">${escapeHtml(activityFeedLine2(item))}</div>
      </div>
    </div>`;
}

function renderAdminActivityFeed() {
  const titleEl = document.getElementById('activityFeedSectionTitle');
  if (titleEl) titleEl.textContent = t('activityFeedSectionTitle');
  const listEl = document.getElementById('activityFeedList');
  const emptyEl = document.getElementById('activityFeedEmpty');
  const loadMoreBtn = document.getElementById('activityFeedLoadMoreBtn');
  if (!listEl) return;

  if (!adminActivityFeedItems.length && !adminActivityFeedLoading) {
    listEl.innerHTML = '';
    if (emptyEl) { emptyEl.textContent = t('activityFeedEmpty'); emptyEl.style.display = ''; }
  } else {
    if (emptyEl) emptyEl.style.display = 'none';
    listEl.innerHTML = adminActivityFeedItems.map(renderActivityFeedItem).join('');
  }

  if (loadMoreBtn) {
    loadMoreBtn.textContent = adminActivityFeedLoading ? t('activityFeedLoadingBtn') : t('activityFeedLoadMoreBtn');
    loadMoreBtn.disabled = adminActivityFeedLoading;
    loadMoreBtn.style.display = (adminActivityFeedExhausted || !adminActivityFeedItems.length) ? 'none' : '';
  }
}

async function loadAdminActivityFeed(reset) {
  if (!currentProfile || !currentProfile.is_admin) return;
  if (adminActivityFeedLoading) return;
  if (reset) {
    adminActivityFeedItems = [];
    adminActivityFeedCursor = null;
    adminActivityFeedExhausted = false;
  }
  if (adminActivityFeedExhausted) return;

  adminActivityFeedLoading = true;
  renderAdminActivityFeed();
  try {
    const { data, error } = await sb.rpc('get_admin_activity_feed', {
      p_before: adminActivityFeedCursor || new Date().toISOString(),
      p_limit: ACTIVITY_FEED_PAGE_SIZE,
    });
    if (error) throw error;
    const rows = data || [];
    adminActivityFeedItems = adminActivityFeedItems.concat(rows);
    if (rows.length) adminActivityFeedCursor = rows[rows.length - 1].event_time;
    if (rows.length < ACTIVITY_FEED_PAGE_SIZE) adminActivityFeedExhausted = true;
  } catch (err) {
    console.error('Failed to load admin activity feed:', err.message || err);
    adminActivityFeedExhausted = true;
  } finally {
    adminActivityFeedLoading = false;
    renderAdminActivityFeed();
  }
}

// Account requests: pending deletion (user asked to be deleted) and dormant
// (1 year inactive, flagged by mark-dormant-accounts) queues. Global/
// continental admins only (level 3+) — this isn't scoped to a municipality
// or country the way most of the rest of the admin panel is, and deletion
// is irreversible, so it's kept out of reach of level 1/2 admins.
function canManageAccountRequests() {
  return currentAdminLevel() >= 3;
}

async function loadAccountRequests() {
  if (!canManageAccountRequests()) return;
  const pendingTitleEl = document.getElementById('accountRequestsPendingTitle');
  const dormantTitleEl = document.getElementById('accountRequestsDormantTitle');
  if (pendingTitleEl) pendingTitleEl.textContent = t('accountRequestsPendingTitle');
  if (dormantTitleEl) dormantTitleEl.textContent = t('accountRequestsDormantTitle');
  try {
    const [{ data: pending, error: pendingErr }, { data: dormant, error: dormantErr }] = await Promise.all([
      sb.from(PROFILES_TABLE).select('id, username, deletion_requested_at').eq('account_status', 'pending_deletion').order('deletion_requested_at', { ascending: true }),
      sb.from(PROFILES_TABLE).select('id, username, dormant_at, last_active_at').eq('account_status', 'dormant').order('dormant_at', { ascending: true }),
    ]);
    if (pendingErr) throw pendingErr;
    if (dormantErr) throw dormantErr;
    renderAccountRequestList('accountRequestsPendingList', 'accountRequestsPendingEmpty', pending || [], 'pending');
    renderAccountRequestList('accountRequestsDormantList', 'accountRequestsDormantEmpty', dormant || [], 'dormant');
  } catch (err) {
    console.error('Failed to load account requests:', err.message || err);
  }
}

function renderAccountRequestList(listId, emptyId, rows, kind) {
  const listEl = document.getElementById(listId);
  const emptyEl = document.getElementById(emptyId);
  if (!listEl) return;
  if (!rows.length) {
    listEl.innerHTML = '';
    if (emptyEl) { emptyEl.textContent = t('accountRequestsEmpty'); emptyEl.style.display = ''; }
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';
  listEl.innerHTML = rows.map(row => {
    const dateStr = new Date(kind === 'pending' ? row.deletion_requested_at : row.dormant_at).toLocaleDateString(isSerbianLang() ? 'sr-RS' : 'en-GB');
    const metaKey = kind === 'pending' ? 'accountRequestsRequestedOn' : 'accountRequestsDormantSince';
    return `
      <div class="acct-req-item">
        <div class="acct-req-name acct-req-name-link" onclick="showUserActivityModal('${row.id}', '${escapeHtml(row.username || '').replace(/'/g, "\\'")}')">${escapeHtml(row.username || '—')}</div>
        <div class="acct-req-meta">${t(metaKey)}: ${dateStr}</div>
        <div class="acct-req-actions">
          <button type="button" class="settings-btn" onclick="reactivateAccountFromAdmin('${row.id}')">${t('accountRequestsReactivateBtn')}</button>
          <button type="button" class="detail-delete-btn" onclick="confirmDeleteAccountFromAdmin('${row.id}', '${escapeHtml(row.username || '')}')">${t('accountRequestsConfirmDeleteBtn')}</button>
        </div>
      </div>`;
  }).join('');
}

async function reactivateAccountFromAdmin(userId) {
  if (!canManageAccountRequests()) return;
  try {
    const { data, error } = await sb.rpc('admin_reactivate_account', { p_user_id: userId });
    if (error) throw error;
    if (!data || data.ok === false) throw new Error((data && data.reason) || 'reactivate_failed');
    toast(t('accountRequestsReactivateSuccess'), 'success');
    loadAccountRequests();
  } catch (err) {
    console.error('Reactivate account failed:', err);
    toast(t('accountRequestsActionError'), 'error');
  }
}

async function confirmDeleteAccountFromAdmin(userId, username) {
  if (!canManageAccountRequests()) return;
  const confirmed = await themedConfirm(t('accountRequestsConfirmDeleteMessage').replace('{{username}}', username || ''), {
    okLabel: t('accountRequestsConfirmDeleteBtn'),
    cancelLabel: t('cancelBtn')
  });
  if (!confirmed) return;
  try {
    const { data, error } = await sb.functions.invoke('admin-delete-account', { body: { userId } });
    if (error) throw error;
    if (data && data.error) throw new Error(data.error);
    toast(t('accountRequestsDeleteSuccess'), 'success');
    loadAccountRequests();
  } catch (err) {
    console.error('Admin delete account failed:', err);
    toast(t('accountRequestsActionError'), 'error');
  }
}

function hideUserActivityModal() {
  const modal = document.getElementById('userActivityModal');
  if (modal) modal.style.display = 'none';
  closeOverlay('userActivityModal');
}

function userActivityReportRowHtml(report) {
  const catLabel = report.subcategory
    ? `${translateCategory(report.category)} / ${subcategoryLabel(report.category, report.subcategory)}`
    : translateCategory(report.category);
  const statusBadge = `<span class="status-pill" style="background:${statusColor(report.status)};margin-left:6px;">${statusLabel(report.status)}</span>`;
  return `
    <div class="activity-feed-item" onclick="openReportFromActivityFeed('${report.id}')">
      <div class="activity-feed-icon" style="background:${activityFeedCircleBg(report.category)};">
        <img class="icon-img" src="${subcategoryIcon(report.category, report.subcategory) || categoryIcon(report.category)}" alt="">
      </div>
      <div class="activity-feed-body">
        <div class="activity-feed-line1">${escapeHtml(catLabel)}${statusBadge}</div>
        <div class="activity-feed-line2">${formatDate(report.created_at)}${report.comment ? ' · ' + escapeHtml(report.comment) : ''}</div>
      </div>
    </div>`;
}

// Lets an admin see why someone might have asked to leave (or gone dormant)
// before confirming an irreversible deletion -- join date, contribution
// stats, and their recent reports (status included, since a string of
// reports stuck at "reported" with no follow-up is a common reason people
// give up on a civic-reporting app).
async function showUserActivityModal(userId, username) {
  if (!canManageAccountRequests()) return;
  const modal = document.getElementById('userActivityModal');
  const body = document.getElementById('userActivityBody');
  const titleEl = document.getElementById('userActivityTitle');
  if (!modal || !body || !titleEl) return;

  titleEl.textContent = username || '';
  body.innerHTML = '';
  modal.style.display = 'flex';
  openOverlay('userActivityModal', hideUserActivityModal);

  try {
    const [{ data: profile, error: profileErr }, { data: reports, error: reportsErr }] = await Promise.all([
      sb.from(PROFILES_TABLE)
        .select('created_at, last_active_at, total_contributions, successful_contributions, reputation_tier, deletion_requested_at, dormant_at')
        .eq('id', userId).maybeSingle(),
      sb.from(TABLE)
        .select('id, category, subcategory, status, created_at, comment')
        .eq('owner_id', userId).order('created_at', { ascending: false }).limit(30),
    ]);
    if (profileErr) throw profileErr;
    if (reportsErr) throw reportsErr;

    const summaryRows = [];
    if (profile?.created_at) summaryRows.push([t('userActivityJoined'), formatDate(profile.created_at)]);
    if (profile?.last_active_at) summaryRows.push([t('userActivityLastActive'), formatDate(profile.last_active_at)]);
    summaryRows.push([t('userActivityContributions'), String(profile?.total_contributions ?? 0)]);
    summaryRows.push([t('userActivitySuccessful'), String(profile?.successful_contributions ?? 0)]);
    if (profile?.reputation_tier) summaryRows.push([t('userActivityReputation'), profile.reputation_tier]);
    if (profile?.deletion_requested_at) summaryRows.push([t('userActivityRequestedOn'), formatDate(profile.deletion_requested_at)]);
    if (profile?.dormant_at) summaryRows.push([t('userActivityDormantSince'), formatDate(profile.dormant_at)]);

    const summaryHtml = `<div class="detail-section">${summaryRows.map(([label, value]) =>
      `<div class="detail-row"><span class="detail-row-label">${escapeHtml(label)}</span><span class="detail-row-value">${escapeHtml(value)}</span></div>`
    ).join('')}</div>`;

    const reportsHtml = (reports && reports.length)
      ? `<div class="detail-section-title">${t('userActivityReportsTitle')}</div><div class="activity-feed-list">${reports.map(userActivityReportRowHtml).join('')}</div>`
      : `<div class="detail-section-title">${t('userActivityReportsTitle')}</div><div class="acct-req-meta">${t('userActivityNoReports')}</div>`;

    body.innerHTML = summaryHtml + reportsHtml;
  } catch (err) {
    console.error('Failed to load user activity:', err.message || err);
    body.innerHTML = `<div class="acct-req-meta">${t('userActivityLoadError')}</div>`;
  }
}


// viewport (globalActiveData is viewport/filter scoped), so fetch the
// single report on demand before handing off to the normal detail modal --
// this way the feed reuses all existing edit/delete/status/photo-review UI
// instead of needing its own.
async function openReportFromActivityFeed(reportId) {
  if (!reportId) return;
  let report = globalActiveData.find(r => r.id === reportId);
  if (!report) {
    try {
      const { data, error } = await sb.from(TABLE).select('*').eq('id', reportId).maybeSingle();
      if (error || !data) {
        console.error('Activity feed: report not found', error && error.message);
        toast(t('activityFeedReportGone'), 'error');
        return;
      }
      report = data;
      globalActiveData = globalActiveData.concat([report]);
    } catch (err) {
      console.error('Failed to fetch report from activity feed:', err.message || err);
      toast(t('activityFeedReportGone'), 'error');
      return;
    }
  }
  showReportDetailModal(reportId);
}

async function loadUtilityCompaniesAdmin() {
  const titleEl = document.getElementById('ucSectionTitle');
  if (titleEl) titleEl.textContent = t('ucSectionTitle');
  const ucSearchEl = document.getElementById('ucSearchInput');
  if (ucSearchEl) ucSearchEl.placeholder = t('ucSearchPH');
  const backfillBtn = document.getElementById('ucGeocodeBackfillBtn');
  if (backfillBtn && !backfillBtn.disabled) backfillBtn.textContent = t('ucGeocodeBackfillBtn');
  const listEl = document.getElementById('ucList');
  if (listEl) listEl.innerHTML = '<div class="detail-loading">' + t('ucLoadingList') + '</div>';

  await loadCountryContinentCache();
  loadUcCountryMuniCounts().then(() => renderUcList()); // fire-and-forget: counts fill in once loaded
  ucHomeCountryCode = await resolveAdminHomeCountryCode();
  buildUcCountryIndex();

  ucOpenCountryCode = null;
  ucCompaniesCache = [];
  ucContactFlagCountsCache = new Map();
  populateUcMunicipalitySelect();
  populateUcCatChecks();
  applyUcFormTranslations();
  renderUcList();

  // Preload just the admin's own country so the panel opens with something
  // useful visible, without loading every other country in their domain
  // (their whole continent, for a level-3 admin) up front.
  if (ucHomeCountryCode && isCountryInAdminDomain(ucHomeCountryCode)) {
    await openUcCountry(ucHomeCountryCode);
  }
}
let ucContactFlagCountsCache = new Map();
let waitingListCache = [];

const WAITING_LIST_FETCH_LIMIT = 50;
const WAITING_LIST_DISPLAY_LIMIT = 150;
const STALE_REPORT_DAYS = 30;

async function loadWaitingListAdmin() {
  const items = new Map();

  function addReason(report, type, since, extra) {
    if (!report) return;
    const sinceDate = since ? new Date(since) : new Date();
    let item = items.get(report.id);
    if (!item) {
      item = { report, waitingSince: sinceDate, reasons: [], flags: [] };
      items.set(report.id, item);
    }
    if (sinceDate < item.waitingSince) item.waitingSince = sinceDate;
    if (!item.reasons.includes(type)) item.reasons.push(type);
    if (extra && extra.flag) item.flags.push(extra.flag);
    item.report = report;
  }

  try {
    const { data, error } = await sb.from(TABLE).select('*')
      .eq('photo_status', 'pending')
      .order('created_at', { ascending: true })
      .limit(WAITING_LIST_FETCH_LIMIT);
    if (error) throw error;
    (data || []).forEach(r => addReason(r, 'photo', r.photo_uploaded_at || r.created_at));
  } catch (err) {
    console.error('Failed to load photo review queue:', err.message);
  }

  try {
    const { data, error } = await sb.from(TABLE).select('*')
      .eq('after_photo_status', 'pending')
      .order('created_at', { ascending: true })
      .limit(WAITING_LIST_FETCH_LIMIT);
    if (error) throw error;
    (data || []).forEach(r => addReason(r, 'after_photo', r.after_photo_uploaded_at || r.created_at));
  } catch (err) {
    console.error('Failed to load after-photo review queue:', err.message);
  }

  try {
    const { data, error } = await sb.from(TABLE).select('*')
      .eq('flagged_for_review', true)
      .order('created_at', { ascending: true })
      .limit(WAITING_LIST_FETCH_LIMIT);
    if (error) throw error;
    (data || []).forEach(r => addReason(r, 'rejected_photo', r.photo_reviewed_at || r.created_at));
  } catch (err) {
    console.error('Failed to load flagged reports:', err.message);
  }

  try {
    const { data, error } = await sb.from('report_flags')
      .select('*, brake_reports(*), profiles!report_flags_flagged_by_fkey(username)')
      .eq('resolved', false)
      .order('created_at', { ascending: true })
      .limit(WAITING_LIST_FETCH_LIMIT);
    if (error) throw error;
    (data || []).forEach(row => {
      const report = row.brake_reports;
      if (!report) return;
      addReason(report, 'user_flag', row.created_at, { flag: row });
    });
  } catch (err) {
    console.error('Failed to load report flags:', err.message);
  }

  // Aging/no-activity reports used to be surfaced here too (reason: 'stale'),
  // but that cluttered the notifications feed. That signal now lives on the
  // report's own Details view instead — see renderStaleBadgeForDetail().

  waitingListCache = Array.from(items.values())
    .filter(item => item.reasons.includes('photo') || item.reasons.includes('after_photo') || item.reasons.includes('user_flag') || hasFullPowerOverReport(item.report))
    .sort((a, b) => a.waitingSince - b.waitingSince)
    .slice(0, WAITING_LIST_DISPLAY_LIMIT);
  renderWaitingList();
}

let waitingListRefreshIntervalId = null;
const WAITING_LIST_REFRESH_MS = 15000;
function anyAdminQueueModalOpen() {
  const notifEl = document.getElementById('notificationModal');
  return !!(notifEl && notifEl.style.display !== 'none');
}
function startWaitingListAutoRefresh() {
  if (waitingListRefreshIntervalId !== null) return;
  waitingListRefreshIntervalId = setInterval(() => {
    if (!anyAdminQueueModalOpen()) { stopWaitingListAutoRefresh(); return; }
    loadWaitingListAdmin();
  }, WAITING_LIST_REFRESH_MS);
}
function stopWaitingListAutoRefresh() {
  if (waitingListRefreshIntervalId !== null) {
    clearInterval(waitingListRefreshIntervalId);
    waitingListRefreshIntervalId = null;
  }
}

function reportSummaryTitle(r) {
  return r.subcategory
    ? `${translateCategory(r.category)} / ${subcategoryLabel(r.category, r.subcategory)}`
    : translateCategory(r.category);
}

const WAITING_REASON_LABEL = { photo: 'queueTypePhoto', after_photo: 'queueTypeAfterPhoto', rejected_photo: 'flagReasonRejectedPhoto', user_flag: 'reportFlagsSectionTitle' };

const WAITING_LIST_CONTAINER_IDS = ['notificationWaitingList'];

function renderWaitingList() {
  WAITING_LIST_CONTAINER_IDS.forEach(renderWaitingListInto);
}

function renderWaitingListInto(containerId) {
  const listEl = document.getElementById(containerId);
  if (!listEl) return;
  const searchInputEl = document.getElementById('adminSearchInput');
  const hasSearchQuery = !!(searchInputEl && searchInputEl.value.trim());
  if (!waitingListCache.length && !hasSearchQuery) {
    listEl.innerHTML = `<div class="detail-empty">${t('waitingListEmpty')}</div>`;
    return;
  }
  const filtered = filterWaitingListBySearch(waitingListCache);
  if (!filtered.length) {
    listEl.innerHTML = `<div class="detail-empty">${t('queueFilterNoResults')}</div>`;
    return;
  }
  listEl.innerHTML = filtered.map(item => {
    const r = item.report;
    const badgesHtml = item.reasons.map(reason =>
      `<span class="photo-status-badge" style="background:var(--accent);">${escapeHtml(t(WAITING_REASON_LABEL[reason]))}</span>`).join(' ');
    const historyHtml = item.flags.length ? `
        <div class="report-flag-history">
          <div class="report-flag-history-meta">${t('reportFlagsHistoryLabel')} (${item.flags.length})</div>
          ${item.flags.map(f => `
            <div class="report-flag-history-item">
              "${escapeHtml(f.reason)}"
              <div class="report-flag-history-meta">${escapeHtml((f.profiles && f.profiles.username) || t('detailUnknown'))} · ${formatDate(f.created_at)}</div>
            </div>`).join('')}
        </div>` : '';
    const thumbHtml = item.reasons.includes('photo')
      ? `<div class="photo-review-thumb" id="photo-review-thumb-${containerId}-${r.id}"><div class="detail-loading">${t('detailLoading')}</div></div>`
      : item.reasons.includes('after_photo')
        ? `<div class="photo-review-thumb" id="after-photo-review-thumb-${containerId}-${r.id}"><div class="detail-loading">${t('detailLoading')}</div></div>` : '';
    const actionsHtml = [
      `<button type="button" class="settings-btn" onclick="viewReportFromAdminQueue('${r.id}')">${t('detailsBtn')}</button>`,
      item.reasons.includes('photo') ? `<button type="button" style="background:${UI_COLORS.success};color:#fff;" onclick="approveReportPhoto('${r.id}')">${t('photoApproveBtn')}</button>` : '',
      item.reasons.includes('photo') ? `<button type="button" style="background:${UI_COLORS.dangerStrong};color:#fff;" onclick="rejectReportPhoto('${r.id}')">${t('photoRejectBtn')}</button>` : '',
      item.reasons.includes('after_photo') ? `<button type="button" style="background:${UI_COLORS.success};color:#fff;" onclick="approveAfterReportPhoto('${r.id}')">${t('photoApproveBtn')}</button>` : '',
      item.reasons.includes('after_photo') ? `<button type="button" style="background:${UI_COLORS.dangerStrong};color:#fff;" onclick="rejectAfterReportPhoto('${r.id}')">${t('photoRejectBtn')}</button>` : '',
      item.reasons.includes('rejected_photo') ? `<button type="button" class="settings-btn" onclick="clearReportFlag('${r.id}')">${t('flagClearBtn')}</button>` : '',
      item.reasons.includes('user_flag') ? `<button type="button" style="background:${UI_COLORS.success};color:#fff;" onclick="resolveReportFlags('${r.id}')">${t('reportFlagResolveBtn')}</button>` : '',
      `<button type="button" style="background:${UI_COLORS.dangerStrong};color:#fff;" onclick="deleteReport('${r.id}', false)">${t('deleteBtn')}</button>`
    ].filter(Boolean).join('');
    return `
    <div class="flagged-report-card">
      ${thumbHtml}
      <div class="photo-review-meta">
        <div class="photo-review-title">${escapeHtml(reportSummaryTitle(r))} ${badgesHtml}</div>
        <div class="photo-review-sub">${escapeHtml(reporterDisplayName(r))} · ${formatDate(item.waitingSince)}</div>
        ${historyHtml}
      </div>
      <div class="photo-review-actions">${actionsHtml}</div>
    </div>`;
  }).join('');

  filtered.forEach(item => {
    if (item.reasons.includes('photo')) {
      const path = item.report.photo_path;
      getReportPhotoSignedUrl(path, null, 'thumb').then(url => {
        const thumb = document.getElementById('photo-review-thumb-' + containerId + '-' + item.report.id);
        if (!thumb) return;
        thumb.innerHTML = url
          ? `<img src="${url}" alt="${t('photoViewFullSize')}" role="button" tabindex="0" onclick="openFullSizeReportPhoto('${escapeHtml(path)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openFullSizeReportPhoto('${escapeHtml(path)}');}">`
          : `<div class="detail-empty">${t('photoLoadFailed')}</div>`;
      });
    }
    if (item.reasons.includes('after_photo')) {
      const path = item.report.after_photo_path;
      getReportPhotoSignedUrl(path, null, 'thumb').then(url => {
        const thumb = document.getElementById('after-photo-review-thumb-' + containerId + '-' + item.report.id);
        if (!thumb) return;
        thumb.innerHTML = url
          ? `<img src="${url}" alt="${t('photoViewFullSize')}" role="button" tabindex="0" onclick="openFullSizeReportPhoto('${escapeHtml(path)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openFullSizeReportPhoto('${escapeHtml(path)}');}">`
          : `<div class="detail-empty">${t('photoLoadFailed')}</div>`;
      });
    }
  });
}
function filterWaitingListBySearch(cache) {
  const inputEl = document.getElementById('adminSearchInput');
  const rawQuery = inputEl ? inputEl.value.trim() : '';
  if (!rawQuery) return cache;
  const query = normalizeMuniNameForMatch(rawQuery);
  const localMatches = cache.filter(item => {
    const r = item.report;
    const haystack = normalizeMuniNameForMatch([
      r.comment, r.owner_username, categorySearchText(r.category),
      r.subcategory ? subcategoryLabel(r.category, r.subcategory) : '', r.id
    ].filter(Boolean).join(' '));
    return haystack.includes(query);
  });

  const localIds = new Set(localMatches.map(item => item.report.id));
  const broaderMatches = allReportsSearchCache
    .filter(r => !localIds.has(r.id))
    .map(r => ({ report: r, waitingSince: new Date(r.created_at), reasons: [], flags: [] }));
  return [...localMatches, ...broaderMatches];
}

async function resolveReportFlags(reportId) {
  try {
    const { data, error } = await sb.from('report_flags').update({
      resolved: true,
      resolved_at: new Date().toISOString(),
      resolved_by: currentSession ? currentSession.user.id : null
    }).eq('report_id', reportId).eq('resolved', false).select();
    if (error) throw error;
    if (!data || !data.length) throw new Error('no-row-updated');
    toast(t('reportFlagResolved'), 'success');
    await loadWaitingListAdmin();
  } catch (err) {
    console.error('Failed to resolve report flags:', err.message);
    toast(t('reportFlagActionFailed'), 'error');
  }
}

function viewReportFromAdminQueue(reportId) {
  const waitingItem = waitingListCache.find(item => item.report.id === reportId);
  const cached = (waitingItem && waitingItem.report) || allReportsSearchCache.find(r => r.id === reportId);
  if (cached && !globalActiveData.some(r => r.id === cached.id)) { globalActiveData.push(cached); markActiveDataChanged(); }
  showReportDetailModal(reportId);
}

let allReportsSearchCache = [];
let adminReportSearchTimer = null;
let adminReportSearchToken = 0;

function onAdminSearchInput() {
  renderWaitingList();

  const inputEl = document.getElementById('adminSearchInput');
  const q = inputEl ? inputEl.value.trim() : '';
  clearTimeout(adminReportSearchTimer);
  if (!q) { allReportsSearchCache = []; return; }

  adminReportSearchTimer = setTimeout(() => searchAllReportsAdmin(q), 350);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function searchAllReportsAdmin(query) {
  const token = ++adminReportSearchToken;
  const pattern = '%' + query.replace(/[%_]/g, '\\$&') + '%';
  try {
    // Some reporters have chosen to hide their username publicly, which
    // means owner_username is genuinely null on their rows (enforced
    // server-side) — a plain ilike on that column can't find them anymore.
    // Resolving matching profiles first and searching by owner_id keeps
    // admin search working for those reporters too.
    const matchingProfiles = await sb.from(PROFILES_TABLE).select('id').ilike('username', pattern).limit(50);
    const matchingOwnerIds = (matchingProfiles.data || []).map(p => p.id);

    const queries = [
      sb.from(TABLE).select('*').ilike('comment', pattern).order('created_at', { ascending: false }).limit(WAITING_LIST_FETCH_LIMIT),
      sb.from(TABLE).select('*').ilike('owner_username', pattern).order('created_at', { ascending: false }).limit(WAITING_LIST_FETCH_LIMIT)
    ];
    if (matchingOwnerIds.length) {
      queries.push(sb.from(TABLE).select('*').in('owner_id', matchingOwnerIds).order('created_at', { ascending: false }).limit(WAITING_LIST_FETCH_LIMIT));
    }

    if (UUID_RE.test(query.trim())) {
      queries.push(sb.from(TABLE).select('*').eq('id', query.trim()).limit(1));
    }
    const results = await Promise.all(queries);
    for (const r of results) if (r.error) throw r.error;
    if (token !== adminReportSearchToken) return;

    const merged = new Map();
    results.forEach(r => (r.data || []).forEach(row => merged.set(row.id, row)));
    allReportsSearchCache = Array.from(merged.values())
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, WAITING_LIST_FETCH_LIMIT);
    renderWaitingList();
  } catch (err) {
    console.error('Admin report search failed:', err.message);
  }
}

function resetAdminSearch() {
  clearTimeout(adminReportSearchTimer);
  adminReportSearchToken++;

  allReportsSearchCache = [];
  const inputEl = document.getElementById('adminSearchInput');
  if (inputEl) inputEl.value = '';
}

async function approveReportPhoto(reportId) {
  try {
    const { data, error } = await sb.from(TABLE).update({
      photo_status: 'approved',
      photo_reviewed_at: new Date().toISOString(),
      photo_reviewed_by: currentSession ? currentSession.user.id : null
    }).eq('id', reportId).select().single();
    if (error) throw error;
    if (!data) throw new Error('no-row-updated');
    toast(t('photoApproved'), 'success');
    await loadWaitingListAdmin();
    await loadPinsByWindow();
  } catch (err) {
    console.error('Failed to approve photo:', err.message);
    toast(t('photoActionFailed'), 'error');
  }
}

async function rejectReportPhoto(reportId) {
  if (!(await themedConfirm(t('photoRejectConfirm')))) return;
  try {
    const { data, error } = await sb.from(TABLE).update({
      photo_status: 'rejected',
      photo_reviewed_at: new Date().toISOString(),
      photo_reviewed_by: currentSession ? currentSession.user.id : null,
      flagged_for_review: true,
      flag_reason: 'rejected_photo'
    }).eq('id', reportId).select().single();
    if (error) throw error;
    if (!data) throw new Error('no-row-updated');
    toast(t('photoRejected'), 'success');
    await loadWaitingListAdmin();
  } catch (err) {
    console.error('Failed to reject photo:', err.message);
    toast(t('photoActionFailed'), 'error');
  }
}

async function approveAfterReportPhoto(reportId) {
  try {
    const { data, error } = await sb.from(TABLE).update({
      after_photo_status: 'approved',
      after_photo_reviewed_at: new Date().toISOString(),
      after_photo_reviewed_by: currentSession ? currentSession.user.id : null
    }).eq('id', reportId).select().single();
    if (error) throw error;
    if (!data) throw new Error('no-row-updated');
    toast(t('photoApproved'), 'success');
    await loadWaitingListAdmin();
    await loadPinsByWindow();
  } catch (err) {
    console.error('Failed to approve after-photo:', err.message);
    toast(t('photoActionFailed'), 'error');
  }
}

async function rejectAfterReportPhoto(reportId) {
  if (!(await themedConfirm(t('photoRejectConfirm')))) return;
  try {
    const { data, error } = await sb.from(TABLE).update({
      after_photo_status: 'rejected',
      after_photo_reviewed_at: new Date().toISOString(),
      after_photo_reviewed_by: currentSession ? currentSession.user.id : null
    }).eq('id', reportId).select().single();
    if (error) throw error;
    if (!data) throw new Error('no-row-updated');
    toast(t('photoRejected'), 'success');
    await loadWaitingListAdmin();
  } catch (err) {
    console.error('Failed to reject after-photo:', err.message);
    toast(t('photoActionFailed'), 'error');
  }
}

async function clearReportFlag(reportId) {
  try {
    const { error } = await sb.from(TABLE).update({ flagged_for_review: false }).eq('id', reportId);
    if (error) throw error;
    toast(t('flagCleared'), 'success');
    await loadWaitingListAdmin();
  } catch (err) {
    console.error('Failed to clear flag:', err.message);
    toast(t('photoActionFailed'), 'error');
  }
}

function applyUcFormTranslations() {
  const fieldMap = {
    ucName: 'ucNamePH',
    ucWebsite: 'ucWebsitePH', ucAddress: 'ucAddressPH', ucNotes: 'ucNotesPH'
  };
  Object.entries(fieldMap).forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (el) el.placeholder = t(key);
  });
  // Re-render rather than just re-labelling placeholders, since the rows
  // are generated markup (not static data-i18n-placeholder elements).
  renderUcMultiList('phone');
  renderUcMultiList('email');
  const cancelBtn = document.getElementById('ucCancelBtn');
  if (cancelBtn) cancelBtn.textContent = t('cancelBtn');
  const saveBtn = document.getElementById('ucSaveBtn');
  if (saveBtn) saveBtn.textContent = t('saveBtn');
  const hint = document.getElementById('ucNoMunicipalitiesHint');
  if (hint) hint.textContent = ucOpenCountryCode ? t('ucNoMunicipalitiesHint') : t('ucSelectCountryHint');
  const verifyBtn = document.getElementById('ucVerifyBtn');
  if (verifyBtn) verifyBtn.textContent = t('ucVerifyBtn');
  renderUcVerifyStatus();
}

function renderUcVerifyStatus() {
  const el = document.getElementById('ucVerifyStatus');
  if (!el) return;
  if (ucEditingVerified) {
    el.textContent = t('ucVerifiedStatus') + (ucEditingVerifiedAt ? ' · ' + formatDate(ucEditingVerifiedAt) : '');
    el.className = 'uc-verify-status is-verified';
  } else {
    el.textContent = t('ucUnverifiedStatus');
    el.className = 'uc-verify-status is-unverified';
  }
}

function populateUcMunicipalitySelect() {
  const sel = document.getElementById('ucMunicipalitySelect');
  if (!sel) return;
  const prevValue = sel.value;

  // Cascades from the browse tree below: the picker only ever needs to offer
  // municipalities from the one country currently open there, which is also
  // the only country whose municipalities are loaded at all — so this never
  // has to pull in the admin's whole domain (a whole continent, for a
  // level-3 admin) just to populate a dropdown.
  const selectable = ucOpenCountryCode
    ? municipalityCache.filter(m => m.country_code === ucOpenCountryCode && isMunicipalityInAdminDomain(m))
    : [];

  const collator = new Intl.Collator(isSerbianLang() ? 'sr' : 'en');
  const decorated = selectable.map(m => ({ m, name: municipalityDisplayName(m) }));
  decorated.sort((a, b) => collator.compare(a.name, b.name));

  const placeholder = '<option value="" disabled>' + t('ucSelectMunicipality') + '</option>';
  sel.innerHTML = placeholder;
  sel.disabled = !ucOpenCountryCode;

  const UC_SELECT_CHUNK_SIZE = 500;
  const token = ++ucMuniSelectPopulateToken;
  let i = 0;
  function appendNextChunk() {
    if (token !== ucMuniSelectPopulateToken) return; // a newer call superseded this one
    const slice = decorated.slice(i, i + UC_SELECT_CHUNK_SIZE);
    if (slice.length) {
      const frag = document.createDocumentFragment();
      slice.forEach(({ m, name }) => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = name + (m.country_code ? ' (' + m.country_code + ')' : '');
        frag.appendChild(opt);
      });
      sel.appendChild(frag);
    }
    i += UC_SELECT_CHUNK_SIZE;
    if (i < decorated.length) {
      requestAnimationFrame(appendNextChunk);
      return;
    }
    if (decorated.some(({ m }) => String(m.id) === ucDesiredMuniSelectValue)) {
      sel.value = ucDesiredMuniSelectValue;
    } else if (decorated.some(({ m }) => String(m.id) === prevValue)) {
      sel.value = prevValue;
    } else {
      sel.selectedIndex = 0;
    }
    ucDesiredMuniSelectValue = null;
    updateUcMuniLabel();
    const hint = document.getElementById('ucNoMunicipalitiesHint');
    if (hint) {
      if (!ucOpenCountryCode) {
        hint.textContent = t('ucSelectCountryHint');
        hint.style.display = 'block';
      } else {
        hint.textContent = t('ucNoMunicipalitiesHint');
        hint.style.display = decorated.length ? 'none' : 'block';
      }
    }
  }
  requestAnimationFrame(appendNextChunk);
}

function populateUcCatChecks(municipalityId) {
  const wrap = document.getElementById('ucCatChecks');
  if (!wrap) return;
  const checkedBefore = new Set(Array.from(wrap.querySelectorAll('input:checked')).map(cb => cb.value));
  let muniId = municipalityId;
  if (muniId == null) {
    const muniSel = document.getElementById('ucMunicipalitySelect');
    muniId = muniSel ? muniSel.value : null;
  }
  const conflicts = muniId ? findUcCategoryConflicts(muniId, UC_CATEGORIES, ucEditingId) : new Map();
  wrap.innerHTML = UC_CATEGORIES.map(c => {
    const isChecked = checkedBefore.has(c);
    const takenBy = conflicts.get(c);
    // A category already checked (e.g. this contact's own existing category
    // while editing) is never disabled — findUcCategoryConflicts already
    // excludes ucEditingId's own rows, so a conflict here always means some
    // *other* contact has it.
    const disabled = !!takenBy && !isChecked;
    const titleAttr = takenBy ? ' title="' + escapeHtml(t('ucCategoryTakenHint').replace('{name}', takenBy)) + '"' : '';
    return '<label class="uc-cat-check' + (disabled ? ' uc-cat-check-disabled' : '') + '"' + titleAttr + '>' +
      '<input type="checkbox" value="' + c + '" ' + (isChecked ? 'checked' : '') + (disabled ? ' disabled' : '') + '> ' + translateCategory(c) + '</label>';
  }).join('');
}

let countryContinentCache = new Map();
let countryContinentCacheLoaded = false;
async function loadCountryContinentCache() {
  if (countryContinentCacheLoaded) return;
  try {
    const { data, error } = await sb.from(COUNTRIES_TABLE).select('code,continent');
    if (error) throw error;
    countryContinentCache = new Map((data || []).map(r => [String(r.code || '').toUpperCase(), r.continent || '']));
    countryContinentCacheLoaded = true;
  } catch (err) {
    console.error('Failed to load country/continent list:', err.message);
  }
}

// Per-country municipality counts for the country list, without paying for
// full municipality rows (geometry, names, etc.) the way opening a country
// does. Just the country_code column, counted client-side, cached once —
// same "lightweight index" spirit as buildUcCountryIndex.
let ucCountryMuniCounts = new Map();
let ucCountryMuniCountsLoaded = false;
async function loadUcCountryMuniCounts() {
  if (ucCountryMuniCountsLoaded) return;
  try {
    const counts = new Map();
    const PAGE = 1000;
    let from = 0;
    while (true) {
      const { data, error } = await sb.from(MUNICIPALITIES_TABLE)
        .select('country_code').range(from, from + PAGE - 1);
      if (error) throw error;
      (data || []).forEach(r => {
        const code = String(r.country_code || '').toUpperCase();
        if (!code) return;
        counts.set(code, (counts.get(code) || 0) + 1);
      });
      if (!data || data.length < PAGE) break;
      from += PAGE;
    }
    ucCountryMuniCounts = counts;
    ucCountryMuniCountsLoaded = true;
  } catch (err) {
    console.error('Failed to load municipality counts:', err.message);
  }
}
const CONTINENT_LABEL_KEYS = {
  'Europe': 'continentEurope',
  'Asia': 'continentAsia',
  'Africa': 'continentAfrica',
  'North America': 'continentNorthAmerica',
  'South America': 'continentSouthAmerica',
  'Oceania': 'continentOceania',
  'Antarctica': 'continentAntarctica',
};
function continentOfCountry(countryCode) {
  const raw = countryCode ? countryContinentCache.get(String(countryCode).toUpperCase()) : '';
  return raw || '';
}
function continentDisplayName(continent) {
  if (!continent) return t('continentUnknown');
  const key = CONTINENT_LABEL_KEYS[continent];
  return key ? t(key) : continent;
}

let _countryNameDisplay = null;
function countryDisplayName(code) {
  if (!code) return t('detailUnknown');
  try {
    if (!_countryNameDisplay || _countryNameDisplay._lang !== lang) {
      _countryNameDisplay = new Intl.DisplayNames([isSerbianLang() ? 'sr' : 'en'], { type: 'region' });
      _countryNameDisplay._lang = lang;
    }
    return _countryNameDisplay.of(code) || code;
  } catch (e) {
    return code;
  }
}

function getOpenUcGroupIds() {
  return Array.from(document.querySelectorAll('#ucList details[open]')).map(d => d.id).filter(Boolean);
}
function restoreOpenUcGroupIds(ids) {
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.open = true;
  });
}

function renderOpenCountryBody(countryCode) {
  if (ucCountryDataLoading) {
    return '<div class="detail-loading">' + t('ucCountryLoading') + '</div>';
  }

  const searchInputHtml = '<div class="uc-country-search-wrap">' +
    '<img class="uc-country-search-icon" src="icons/search.png" alt="">' +
    '<input type="text" id="ucCountrySearchInput" class="uc-country-search-input" oninput="onUcCountrySearchInput(this.value)" ' +
    'value="' + escapeHtml(ucCountrySearchQuery) + '" placeholder="' + escapeHtml(t('ucCountrySearchPH')) + '">' +
    '</div>';

  return searchInputHtml + '<div id="ucCountryResultsBody">' + renderOpenCountryResultsBody(countryCode) + '</div>';
}

// Just the filtered municipality/contact list for the currently open
// country — no search bar. Kept separate from renderOpenCountryBody so
// re-filtering on every keystroke (see onUcCountrySearchInput) only ever
// touches this inner container, never the search <input> itself. Replacing
// the input's own DOM node on every keystroke was what caused it to lose
// focus/cursor position and made the surrounding page jump around while
// typing.
function renderOpenCountryResultsBody(countryCode) {
  const domainMunis = municipalityCache.filter(m => m.country_code === countryCode && isMunicipalityInAdminDomain(m));
  if (!domainMunis.length) {
    return '<div class="detail-empty uc-muni-empty">' + t('ucCountryNoContactsYet') + '</div>';
  }

  const companiesByMuni = new Map();
  ucCompaniesCache.forEach(c => {
    const key = c.municipality_id != null ? String(c.municipality_id) : '';
    if (!companiesByMuni.has(key)) companiesByMuni.set(key, []);
    companiesByMuni.get(key).push(c);
  });

  // Every municipality in this country gets a row, contacts or not — the
  // admin needs to see (and quick-add to) empty municipalities without
  // having to search for them by name first.
  let muniGroups = new Map();
  domainMunis.forEach(m => {
    const key = String(m.id);
    muniGroups.set(key, { muni: m, companies: companiesByMuni.get(key) || [] });
  });

  const query = ucCountrySearchQuery ? normalizeMuniNameForMatch(ucCountrySearchQuery) : '';
  if (query) {
    const filtered = new Map();
    muniGroups.forEach((group, key) => {
      const muniNameMatches = normalizeMuniNameForMatch(municipalityDisplayName(group.muni)).includes(query);
      if (muniNameMatches) { filtered.set(key, group); return; }
      const matchingCompanies = group.companies.filter(c => {
        const haystack = normalizeMuniNameForMatch([c.name, ...(c.categories || []).map(categorySearchText)].filter(Boolean).join(' '));
        return haystack.includes(query);
      });
      if (matchingCompanies.length) filtered.set(key, { muni: group.muni, companies: matchingCompanies });
    });
    muniGroups = filtered;
  }

  if (!muniGroups.size) {
    return '<div class="detail-empty">' + t(query ? 'ucNoSearchResults' : 'ucCountryNoContactsYet') + '</div>';
  }

  const sortedMuniKeys = Array.from(muniGroups.keys()).sort((a, b) =>
    municipalityDisplayName(muniGroups.get(a).muni).localeCompare(municipalityDisplayName(muniGroups.get(b).muni)));

  const muniHtml = sortedMuniKeys.map(muniKey => {
    const { muni, companies } = muniGroups.get(muniKey);
    const muniLabel = muni
      ? escapeHtml(municipalityDisplayName(muni)) + (muni.country_code ? ' (' + escapeHtml(muni.country_code) + ')' : '')
      : t('detailUnknown');

    // Quick-add row is computed from every contact in this municipality (not
    // the possibly search-filtered `companies` above), so it stays accurate
    // even while the admin is filtering the in-country list.
    const allMuniCompanies = companiesByMuni.get(muniKey) || [];
    const allContactsVerified = allMuniCompanies.length > 0 && allMuniCompanies.every(c => c.verified);
    const allVerifiedBadgeHtml = allContactsVerified
      ? ' <span class="uc-muni-all-verified" title="' + escapeHtml(t('ucMuniAllVerified')) + '">✓</span>'
      : '';
    const coveredCats = new Set();
    allMuniCompanies.forEach(c => (c.categories || []).forEach(cat => coveredCats.add(cat)));
    const missingCats = UC_CATEGORIES.filter(cat => !coveredCats.has(cat));

    const quickAddTagsHtml = muni && missingCats.length
      ? '<div class="uc-muni-missing-tags">' +
          '<span class="uc-muni-missing-label">' + escapeHtml(t('ucQuickAddTagsLabel')) + '</span>' +
          missingCats.map(cat =>
            '<button type="button" class="uc-cat-chip uc-cat-chip-add uc-cat-chip-missing" ' +
              'onclick="quickAddUcContact(\'' + muni.id + '\', \'' + cat + '\')">' +
              '+ ' + escapeHtml(translateCategory(cat)) +
            '</button>'
          ).join('') +
        '</div>'
      : '';

    // Coverage dot: red = no contacts yet, orange = some tags covered,
    // yellow = most tags covered, green = every tag has a contact.
    const coverageRatio = UC_CATEGORIES.length ? coveredCats.size / UC_CATEGORIES.length : 0;
    const coverageDotColor = coveredCats.size === 0 ? STATUS_COLORS.reported
      : coveredCats.size === UC_CATEGORIES.length ? STATUS_COLORS.fixed
      : coverageRatio >= 0.5 ? '#f1c40f'
      : STATUS_COLORS.in_progress;
    const coverageDotTitle = coveredCats.size === 0 ? t('ucCoverageNone')
      : coveredCats.size === UC_CATEGORIES.length ? t('ucCoverageFull')
      : coverageRatio >= 0.5 ? t('ucCoverageMost')
      : t('ucCoverageSome');
    const coverageDotHtml = muni
      ? '<span class="bottom-muni-stat-dot" style="background:' + coverageDotColor + ';" title="' + escapeHtml(coverageDotTitle) + '"></span> '
      : '';

    const itemsHtml = companies.length ? companies.map(c => {
      const catsHtml = (c.categories && c.categories.length)
        ? c.categories.map(cat => '<span class="uc-cat-chip" style="background:' + categoryColor(cat) + ';">' + translateCategory(cat) + '</span>').join('')
        : '<span class="uc-cat-chip uc-cat-chip-empty">' + t('ucUncategorizedChip') + '</span>';
      const verifiedChip = c.verified
        ? '<span class="uc-verified-chip">' + t('ucVerifiedChip') + '</span>'
        : '<span class="uc-unverified-chip">' + t('ucUnverifiedChip') + '</span>';
      const flagCount = ucContactFlagCountsCache.get(String(c.id)) || 0;
      const flagWarningHtml = flagCount > 0
        ? '<div class="uc-flag-warning">⚠ ' + escapeHtml(t('ucFlagWarning').replace('{n}', flagCount)) +
          ' <button type="button" class="settings-btn" style="display:inline;padding:2px 8px;" onclick="clearUtilityContactFlags(\'' + c.id + '\')">' + t('ucFlagClearBtn') + '</button></div>'
        : '';
      return '<div class="uc-item" id="uc-item-' + c.id + '">' +
        '<div class="uc-item-top" onclick="toggleUtilityCompanyEdit(\'' + c.id + '\')">' +
          '<div>' +
            '<div class="uc-item-name">' + escapeHtml(c.name) + '</div>' +
          '</div>' +
          '<div class="uc-item-actions">' +
            '<button type="button" style="background:var(--danger-strong);color:#fff;" onclick="event.stopPropagation(); deleteUtilityCompany(\'' + c.id + '\')">' + t('deleteBtn') + '</button>' +
          '</div>' +
        '</div>' +
        '<div class="uc-item-cats">' + verifiedChip + catsHtml + '</div>' +
        flagWarningHtml +
      '</div>';
    }).join('') : '<div class="detail-empty uc-muni-empty">' + t('ucMuniNoContacts') + '</div>';
    return '<details class="uc-muni-group" id="uc-muni-group-' + (muni ? muni.id : 'unknown') + '">' +
      '<summary><span class="uc-group-chevron"><img src="icons/arrow.png" alt=""></span> ' + coverageDotHtml + muniLabel + allVerifiedBadgeHtml +
        ' <span class="uc-country-count">(' + companies.length + ')</span></summary>' +
      quickAddTagsHtml +
      '<div class="uc-muni-items">' + itemsHtml + '</div>' +
    '</details>';
  }).join('');

  return muniHtml;
}

// Between "start refresh" and "data back", the list is briefly re-rendered
// in a loading state that has no municipality-level <details> elements at
// all. If we read open-ids fresh from the DOM at that moment we'd only see
// the country row and lose track of which municipality was open, so the
// group would collapse back once the real content lands — forcing the
// admin to search for it again. This remembers the last "real" (non-loading)
// set of open ids so it survives that gap.
let ucLastKnownOpenIds = [];

function renderUcList() {
  const listEl = document.getElementById('ucList');
  if (!listEl) return;
  const currentOpenCountryId = 'uc-country-group-' + (ucOpenCountryCode || 'unknown');
  // Country open/close is driven entirely by ucOpenCountryCode now, so don't
  // let a stale "this id was open before the re-render" snapshot force a
  // previously-open (now switched-away-from) country back open with no body.
  const freshIds = getOpenUcGroupIds();
  // Continent/country ids in freshIds are always trustworthy (they don't
  // disappear from the DOM during a reload — only municipality-level
  // <details> do, since the loading placeholder replaces the whole country
  // body). So we only need a fallback for the *municipality* ids specifically:
  // if none show up fresh but we remember some from the last real render,
  // assume we're mid-reload rather than the admin having genuinely closed
  // them all, and carry the remembered ones forward. This is what keeps
  // municipality/contact groups open across a save-triggered refresh instead
  // of collapsing back down to just the country row.
  const freshMuniIds = freshIds.filter(id => id.startsWith('uc-muni-group-'));
  const lastKnownMuniIds = ucLastKnownOpenIds.filter(id => id.startsWith('uc-muni-group-'));
  const muniIdsToUse = freshMuniIds.length ? freshMuniIds : lastKnownMuniIds;
  const openIds = freshIds
    .filter(id => !id.startsWith('uc-muni-group-'))
    .filter(id => !id.startsWith('uc-country-group-') || id === currentOpenCountryId)
    .concat(muniIdsToUse);
  if (freshMuniIds.length) ucLastKnownOpenIds = freshMuniIds;

  const searchEl = document.getElementById('ucSearchInput');
  const rawQuery = searchEl ? searchEl.value.trim() : '';
  const query = rawQuery ? normalizeMuniNameForMatch(rawQuery) : '';

  if (!ucCountryIndex.length) {
    listEl.innerHTML = '<div class="detail-empty">' + t('ucNoContacts') + '</div>';
    return;
  }

  // The top search only ever looks at country names — it's the cheap,
  // always-available part of the index. Municipality/contact-level search
  // happens separately, scoped to whichever country is currently open (see
  // renderOpenCountryBody), since those are the only rows actually loaded.
  const visibleCountries = query
    ? ucCountryIndex.filter(c => normalizeMuniNameForMatch(countryDisplayName(c.code)).includes(query))
    : ucCountryIndex;

  if (!visibleCountries.length) {
    listEl.innerHTML = '<div class="detail-empty">' + t('ucNoCountrySearchResults') + '</div>';
    return;
  }

  const continentGroups = new Map();
  visibleCountries.forEach(c => {
    if (!continentGroups.has(c.continent)) continentGroups.set(c.continent, []);
    continentGroups.get(c.continent).push(c.code);
  });
  continentGroups.forEach(codes => codes.sort((a, b) => countryDisplayName(a).localeCompare(countryDisplayName(b))));
  const sortedContinents = Array.from(continentGroups.keys()).sort((a, b) => {
    if (!a && b) return 1;
    if (a && !b) return -1;
    return continentDisplayName(a).localeCompare(continentDisplayName(b));
  });

  const countryRowHtml = (countryCode) => {
    const isOpen = countryCode === ucOpenCountryCode;
    const muniCount = ucCountryMuniCounts.get(String(countryCode).toUpperCase());
    const muniCountHtml = muniCount != null
      ? ' <span class="uc-muni-count-label">' + escapeHtml(t('ucMuniCountLabel').replace('{n}', String(muniCount))) + '</span>'
      : '';
    const summaryHtml = '<summary onclick="event.preventDefault(); toggleUcCountry(\'' + countryCode + '\')">' +
      '<span class="uc-group-chevron"><img src="icons/arrow.png" alt=""></span> ' +
      escapeHtml(countryDisplayName(countryCode)) +
      (countryCode ? ' (' + escapeHtml(countryCode) + ')' : '') +
      muniCountHtml +
      '</summary>';
    return '<details class="uc-country-group" id="uc-country-group-' + (countryCode || 'unknown') + '"' + (isOpen ? ' open' : '') + '>' +
      summaryHtml +
      (isOpen ? renderOpenCountryBody(countryCode) : '') +
    '</details>';
  };

  listEl.innerHTML = '<div class="uc-continent-list">' + sortedContinents.map(continent => {
    const codes = continentGroups.get(continent);
    const countryCountLabel = t('ucCountryCountLabel').replace('{n}', String(codes.length));
    return '<details class="uc-continent-group" id="uc-continent-group-' + (continent ? continent.replace(/\s+/g, '-') : 'other') + '">' +
      '<summary><span class="uc-group-chevron"><img src="icons/arrow.png" alt=""></span> ' + escapeHtml(continentDisplayName(continent)) +
        ' <span class="uc-muni-count-label">' + escapeHtml(countryCountLabel) + '</span></summary>' +
      '<div class="uc-group-list">' + codes.map(countryRowHtml).join('') + '</div>' +
    '</details>';
  }).join('') + '</div>';

  restoreOpenUcGroupIds(openIds);
}
function setUcMuniPickerVisible(visible) {
  // The dropdown is always auto-filled now (from the + tag or from the
  // contact being edited), so there's no case where the admin needs to pick
  // a municipality by hand any more — keep it hidden regardless of what's
  // passed in. The municipality name is surfaced via updateUcMuniLabel()
  // instead. Left as a no-op rather than removed so every existing call
  // site (editUtilityCompany, quickAddUcContact, cancelUcForm, etc.) keeps
  // working untouched.
  const picker = document.getElementById('ucMuniPicker');
  if (picker) picker.style.display = 'none';
}

function updateUcMuniLabel() {
  const labelEl = document.getElementById('ucMuniLabel');
  if (!labelEl) return;
  const sel = document.getElementById('ucMunicipalitySelect');
  const muniId = sel ? sel.value : '';
  const muni = muniId ? municipalityCache.find(m => String(m.id) === String(muniId)) : null;
  labelEl.textContent = muni
    ? municipalityDisplayName(muni) + (muni.country_code ? ' (' + muni.country_code + ')' : '')
    : '';
}

// Keeps exactly one contact card visually marked as "currently being
// edited" (or none, e.g. while quick-adding a brand new one that has no
// card yet). Called whenever the form is opened, moved, or closed.
function highlightUcEditingItem(id) {
  document.querySelectorAll('.uc-item.is-editing').forEach(el => el.classList.remove('is-editing'));
  if (id == null) return;
  const itemEl = document.getElementById('uc-item-' + id);
  if (itemEl) itemEl.classList.add('is-editing');
}

function toggleUtilityCompanyEdit(id) {
  const form = document.getElementById('ucForm');
  const itemEl = document.getElementById('uc-item-' + id);
  const isOpenForThis = form && String(ucEditingId) === String(id) && form.style.display !== 'none' &&
    itemEl && itemEl.nextElementSibling === form;
  if (isOpenForThis) {
    cancelUcForm();
    return;
  }
  editUtilityCompany(id);
}

function moveUcFormToAnchor() {
  const form = document.getElementById('ucForm');
  const anchor = document.getElementById('ucFormAnchor');
  if (form && anchor) anchor.insertAdjacentElement('afterend', form);
}

function resetUcForm() {
  ucEditingId = null;
  ucEditingVerified = false;
  ucEditingVerifiedAt = null;
  ucDesiredMuniSelectValue = null;
  const editIdEl = document.getElementById('ucEditId');
  if (editIdEl) editIdEl.value = '';
  ['ucName', 'ucWebsite', 'ucAddress', 'ucNotes'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  ucFormPhones = [];
  ucFormEmails = [];
  renderUcMultiList('phone');
  renderUcMultiList('email');
  document.querySelectorAll('#ucCatChecks input').forEach(cb => cb.checked = false);
  const sel = document.getElementById('ucMunicipalitySelect');
  if (sel) sel.selectedIndex = 0;
  updateUcMuniLabel();
  populateUcCatChecks();
  applyUcFormTranslations();
}

function cancelUcForm() {
  const form = document.getElementById('ucForm');
  if (form) form.style.display = 'none';
  moveUcFormToAnchor();
  setUcMuniPickerVisible(true);
  resetUcForm();
  highlightUcEditingItem(null);
}

function editUtilityCompany(id) {
  const c = ucCompaniesCache.find(x => String(x.id) === String(id));
  if (!c) return;
  if (!canManageContactsForMunicipality(c.municipality_id)) {
    toast(t('ucOutOfDomainError'), 'error');
    return;
  }
  resetUcForm();
  setUcMuniPickerVisible(true);
  ucEditingId = c.id;
  ucEditingVerified = !!c.verified;
  ucEditingVerifiedAt = c.verified_at || null;
  document.getElementById('ucEditId').value = c.id;
  const sel = document.getElementById('ucMunicipalitySelect');
  ucDesiredMuniSelectValue = c.municipality_id != null ? String(c.municipality_id) : null;
  if (sel) sel.value = c.municipality_id;
  updateUcMuniLabel();
  populateUcCatChecks(c.municipality_id);
  document.getElementById('ucName').value = c.name || '';
  ucFormPhones = contactEntries(c.phone);
  ucFormEmails = contactEntries(c.email);
  renderUcMultiList('phone');
  renderUcMultiList('email');
  document.getElementById('ucWebsite').value = c.website || '';
  document.getElementById('ucAddress').value = c.address || '';
  document.getElementById('ucNotes').value = c.notes || '';
  (c.categories || []).forEach(cat => {
    const cb = document.querySelector('#ucCatChecks input[value="' + cat + '"]');
    if (cb) cb.checked = true;
  });
  renderUcVerifyStatus();
  const form = document.getElementById('ucForm');

  const itemEl = document.getElementById('uc-item-' + id);
  if (itemEl) itemEl.insertAdjacentElement('afterend', form);
  form.style.display = 'flex';
  highlightUcEditingItem(id);
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function quickAddUcContact(municipalityId, category) {
  if (!canManageContactsForMunicipality(municipalityId)) {
    toast(t('ucOutOfDomainError'), 'error');
    return;
  }
  resetUcForm();
  setUcMuniPickerVisible(true);
  const sel = document.getElementById('ucMunicipalitySelect');
  ucDesiredMuniSelectValue = municipalityId != null ? String(municipalityId) : null;
  if (sel) sel.value = municipalityId;
  updateUcMuniLabel();
  populateUcCatChecks(municipalityId);
  const cb = document.querySelector('#ucCatChecks input[value="' + category + '"]');
  if (cb) cb.checked = true;
  renderUcVerifyStatus();
  const form = document.getElementById('ucForm');
  highlightUcEditingItem(null); // it's a brand new contact, no card to highlight yet
  // Anchor the form inside the municipality's own item list (same container
  // the existing contact cards live in), not just after the whole group —
  // that keeps it the exact same width as a contact card instead of the
  // slightly wider look it had when anchored one level up.
  const itemsEl = document.querySelector('#uc-muni-group-' + municipalityId + ' .uc-muni-items');
  if (itemsEl) itemsEl.insertBefore(form, itemsEl.firstChild);
  else moveUcFormToAnchor();
  form.style.display = 'flex';
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  const nameInput = document.getElementById('ucName');
  if (nameInput) nameInput.focus();
}

// Returns { value, valid }. `valid` reflects whether libphonenumber could
// actually parse/validate the number — it must NOT be inferred from
// "did the string change during formatting", since an already-correctly-
// formatted number (e.g. "+381 21 870570") legitimately comes back
// unchanged from formatInternational() and that's a *pass*, not a failure.
function formatPhoneNumberForSave(rawPhone, countryIso2) {
  const raw = (rawPhone || '').trim();
  if (!raw) return { value: raw, valid: true };
  try {
    if (window.libphonenumber && countryIso2) {
      const parsed = window.libphonenumber.parsePhoneNumberFromString(raw, String(countryIso2).toUpperCase());
      if (parsed && parsed.isValid()) return { value: parsed.formatInternational(), valid: true };
    }
    if (window.libphonenumber && raw.startsWith('+')) {
      const parsed = window.libphonenumber.parsePhoneNumberFromString(raw);
      if (parsed && parsed.isValid()) return { value: parsed.formatInternational(), valid: true };
    }
  } catch (e) {
    console.error('Failed to format phone number:', e.message || e);
  }
  // If libphonenumber itself isn't loaded, don't flag the number as
  // invalid — we simply couldn't check it, so leave it as entered.
  return { value: raw, valid: !window.libphonenumber };
}

// --- Contact formatting helpers -------------------------------------------
// These keep every admin-entered contact consistent (same spacing/casing/
// punctuation conventions) regardless of who typed it in or how. Silent,
// lossless clean-up (whitespace, casing) is just applied; anything that
// might change the *meaning* of the value (a possibly-invalid email,
// website, or phone) is surfaced to the admin for review instead of being
// guessed at.

// Collapses runs of whitespace and trims. Safe to apply silently to any
// free-text field.
function collapseWhitespace(str) {
  return (str || '').replace(/\s+/g, ' ').trim();
}

// Normalizes an email to lowercase + trimmed (the conventional storage
// format), without altering whether it's valid.
function normalizeEmailForSave(rawEmail) {
  return collapseWhitespace(rawEmail).toLowerCase();
}

const EMAIL_FORMAT_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmailFormat(email) {
  return EMAIL_FORMAT_RE.test(email);
}

// A utility company's phone/email can now hold more than one number or
// address (e.g. an office line + an emergency line). Stored as an array of
// { value, label } objects. This normalizer also accepts the two older
// shapes still sitting in the database — a single string, or an array of
// plain strings — so nothing needs a data migration to keep working; it
// just gets upgraded to the new shape the next time that row is saved.
function contactEntries(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map(e => (typeof e === 'string' ? { value: e, label: null } : { value: e && e.value, label: (e && e.label) || null }))
      .filter(e => e.value);
  }
  if (typeof raw === 'string') return raw.trim() ? [{ value: raw.trim(), label: null }] : [];
  return [];
}

// Turns the admin form's in-memory phone/email rows into the array shape
// that gets saved, dropping any row the admin left blank. Returns null
// (not []) when nothing is left, matching how every other optional field
// on this row is stored.
function buildContactEntriesForSave(entries) {
  const cleaned = (entries || [])
    .map(e => ({ value: (e.value || '').trim(), label: (e.label || '').trim() || null }))
    .filter(e => e.value);
  return cleaned.length ? cleaned : null;
}

// --- Admin form: multi-entry phone/email rows ------------------------------
// Renders ucFormPhones/ucFormEmails into #ucPhoneList/#ucEmailList. Only
// called after add/remove (or when the form opens/resets) — per-keystroke
// input changes just write into the array via updateUcContactEntry without
// re-rendering, so the input the admin is typing in never loses focus.
function ucMultiListElId(field) {
  return field === 'phone' ? 'ucPhoneList' : 'ucEmailList';
}
function ucFormEntries(field) {
  return field === 'phone' ? ucFormPhones : ucFormEmails;
}

function renderUcMultiList(field) {
  const listEl = document.getElementById(ucMultiListElId(field));
  if (!listEl) return;
  const entries = ucFormEntries(field);
  const valuePH = field === 'phone' ? t('ucPhonePH') : t('ucEmailPH');
  const labelPH = t('ucContactLabelPH');
  listEl.innerHTML = entries.map((entry, i) => `
    <div class="uc-multi-row">
      <input type="text" value="${escapeHtml(entry.value || '')}" placeholder="${escapeHtml(valuePH)}" class="uc-multi-row-value" oninput="updateUcContactEntry('${field}', ${i}, 'value', this.value)">
      <input type="text" value="${escapeHtml(entry.label || '')}" placeholder="${escapeHtml(labelPH)}" class="uc-multi-row-label" oninput="updateUcContactEntry('${field}', ${i}, 'label', this.value)">
      <button type="button" class="uc-multi-row-remove" onclick="removeUcContactEntry('${field}', ${i})" title="${escapeHtml(t('ucRemoveEntryBtn'))}" aria-label="${escapeHtml(t('ucRemoveEntryBtn'))}"><img class="icon-img" src="icons/waste.png" alt=""></button>
    </div>
  `).join('');
}

function addUcContactEntry(field) {
  ucFormEntries(field).push({ value: '', label: '' });
  renderUcMultiList(field);
  const listEl = document.getElementById(ucMultiListElId(field));
  const lastInput = listEl && listEl.querySelector('.uc-multi-row:last-child .uc-multi-row-value');
  if (lastInput) lastInput.focus();
}

function removeUcContactEntry(field, index) {
  ucFormEntries(field).splice(index, 1);
  renderUcMultiList(field);
}

// Deliberately does NOT re-render the list — see the comment above
// renderUcMultiList. It only keeps the in-memory row in sync with what the
// admin is typing.
function updateUcContactEntry(field, index, key, value) {
  const entries = ucFormEntries(field);
  if (entries[index]) entries[index][key] = value;
}

// Normalizes a website to a full https:// URL with no trailing slash
// dropped inconsistently (matches the "https://www.example.com/" style
// used across existing verified contacts). Only adds/adjusts the scheme;
// never invents a domain.
function normalizeWebsiteForSave(rawWebsite) {
  let site = collapseWhitespace(rawWebsite);
  if (!site) return site;
  if (!/^https?:\/\//i.test(site)) site = 'https://' + site;
  try {
    const u = new URL(site);
    let path = u.pathname === '' ? '/' : u.pathname;
    return u.protocol + '//' + u.host + path + u.search + u.hash;
  } catch (e) {
    return site; // couldn't parse as a URL at all; leave as-is, flag as invalid below
  }
}

function isValidWebsiteFormat(site) {
  try {
    const u = new URL(site);
    return /^https?:$/.test(u.protocol) && !!u.host && u.host.includes('.');
  } catch (e) {
    return false;
  }
}

function readUcFormRow() {
  const municipalityId = document.getElementById('ucMunicipalitySelect').value;
  const name = collapseWhitespace(cyrillicToLatin(document.getElementById('ucName').value));
  const categories = Array.from(document.querySelectorAll('#ucCatChecks input:checked')).map(cb => cb.value);
  if (!municipalityId || !name || !categories.length) {
    toast(t('ucValidationError'), 'error');
    return null;
  }
  const address = collapseWhitespace(document.getElementById('ucAddress').value);
  const notes   = collapseWhitespace(document.getElementById('ucNotes').value);
  const rawWebsite = document.getElementById('ucWebsite').value.trim();
  return {
    municipality_id: municipalityId,
    name,
    categories,
    phone:   buildContactEntriesForSave(ucFormPhones),
    email:   buildContactEntriesForSave(ucFormEmails),
    website: rawWebsite || null,
    address: address ? cyrillicToLatin(address) : null,
    notes:   notes   ? cyrillicToLatin(notes)   : null,
  };
}

// A given category/tag (Water, Electricity, ...) should map to exactly one
// contact per municipality — that's what lets the "no contact for X" quick-add
// chips and the coverage dot mean anything. This finds any other contact in
// the same municipality that already claims one of the categories being
// saved, so persistUcRow can block the save instead of creating an ambiguous
// duplicate.
function findUcCategoryConflicts(municipalityId, categories, excludingId) {
  const conflicts = new Map(); // category -> conflicting contact name
  ucCompaniesCache.forEach(c => {
    if (String(c.municipality_id) !== String(municipalityId)) return;
    if (excludingId != null && String(c.id) === String(excludingId)) return;
    (c.categories || []).forEach(cat => {
      if (categories.includes(cat) && !conflicts.has(cat)) conflicts.set(cat, c.name);
    });
  });
  return conflicts;
}

async function persistUcRow(verified) {
  const row = readUcFormRow();
  if (!row) return;
  if (!canManageContactsForMunicipality(row.municipality_id)) {
    toast(t('ucOutOfDomainError'), 'error');
    return;
  }

  const conflicts = findUcCategoryConflicts(row.municipality_id, row.categories, ucEditingId);
  if (conflicts.size) {
    const categories = Array.from(conflicts.keys()).map(cat => translateCategory(cat)).join(', ');
    const names = Array.from(new Set(conflicts.values())).join(', ');
    toast(t('ucCategoryConflictError').replace('{categories}', categories).replace('{names}', names), 'error');
    return;
  }

  row.updated_at = new Date().toISOString();
  row.verified = verified;
  row.verified_at = verified ? new Date().toISOString() : null;
  row.verified_by = verified ? (currentSession ? currentSession.user.id : null) : null;

  const muni = getMunicipalityById(row.municipality_id);

  // Normalize email/website to the standard stored format, and collect a
  // human-readable review list for anything that was changed or still
  // looks off, so the admin gets a chance to double-check rather than
  // having a bad value silently saved or silently "fixed" into something
  // wrong.
  const reviewNotes = [];
  if (row.phone) {
    row.phone = row.phone.map(entry => {
      const rawValue = entry.value;
      const phoneResult = formatPhoneNumberForSave(rawValue, muni ? muni.country_code : null);
      if (!phoneResult.valid) {
        reviewNotes.push(t('ucFormatInvalidPhone').replace('{value}', entry.label ? `${entry.label}: ${rawValue}` : rawValue));
      }
      return { value: phoneResult.value, label: entry.label };
    });
  }
  if (row.email) {
    row.email = row.email.map(entry => {
      const normalizedEmail = normalizeEmailForSave(entry.value);
      if (normalizedEmail !== entry.value) {
        reviewNotes.push(t('ucFormatAutoFixed').replace('{field}', entry.label || t('ucEmailPH')).replace('{before}', entry.value).replace('{after}', normalizedEmail));
      }
      if (!isValidEmailFormat(normalizedEmail)) {
        reviewNotes.push(t('ucFormatInvalidEmail').replace('{value}', entry.label ? `${entry.label}: ${normalizedEmail}` : normalizedEmail));
      }
      return { value: normalizedEmail, label: entry.label };
    });
  }
  if (row.website) {
    const normalizedWebsite = normalizeWebsiteForSave(row.website);
    if (normalizedWebsite !== row.website) {
      reviewNotes.push(t('ucFormatAutoFixed').replace('{field}', t('ucWebsitePH')).replace('{before}', row.website).replace('{after}', normalizedWebsite));
    }
    row.website = normalizedWebsite;
    if (!isValidWebsiteFormat(row.website)) {
      reviewNotes.push(t('ucFormatInvalidWebsite').replace('{value}', row.website));
    }
  }
  if (reviewNotes.length) {
    const proceed = await themedConfirm(
      t('ucFormatReviewTitle') + '\n\n' + reviewNotes.map(n => '• ' + n).join('\n'),
      { okLabel: t('ucFormatContinueBtn'), cancelLabel: t('ucFormatCancelBtn') }
    );
    if (!proceed) return;
  }

  const existing = ucEditingId ? ucCompaniesCache.find(c => String(c.id) === String(ucEditingId)) : null;
  if (!row.address) {
    row.lat = null;
    row.lon = null;
  } else if (existing && existing.address === row.address && existing.lat != null) {
    row.lat = existing.lat;
    row.lon = existing.lon;
  } else {
    const pos = await geocodeAddress(row.address, muni ? municipalityDisplayName(muni) : '', muni ? muni.country_code : null);
    row.lat = pos ? pos.lat : null;
    row.lon = pos ? pos.lon : null;
  }

  const saveBtn = document.getElementById('ucSaveBtn');
  const verifyBtn = document.getElementById('ucVerifyBtn');
  if (saveBtn) saveBtn.disabled = true;
  if (verifyBtn) verifyBtn.disabled = true;
  try {
    let error, insertedId;
    if (ucEditingId) {
      ({ error } = await sb.from(UTILITY_COMPANIES_TABLE).update(row).eq('id', ucEditingId));
    } else {
      row.created_by = currentSession ? currentSession.user.id : null;
      const inserted = await sb.from(UTILITY_COMPANIES_TABLE).insert(row).select().single();
      error = inserted.error;
      insertedId = inserted.data ? inserted.data.id : null;
    }
    if (error) throw error;
    // Keep the contact open in edit mode after saving — whether it already
    // existed or was just created — so the admin can go straight to hitting
    // "Verify" without having to scroll/search for it again in the list.
    const idToReopen = ucEditingId || insertedId;

    moveUcFormToAnchor();
    await refreshUcOpenCountry();
    if (idToReopen != null) {
      editUtilityCompany(idToReopen);
    } else {
      // Couldn't get an id back (e.g. insert().select() unsupported/blocked) —
      // fall back to resetting the form rather than leaving it in a broken state.
      resetUcForm();
      setUcMuniPickerVisible(true);
    }
  } catch (err) {
    console.error('Failed to save utility company:', err.message);
    toast(t('ucSaveError'), 'error');
  } finally {
    if (saveBtn) saveBtn.disabled = false;
    if (verifyBtn) verifyBtn.disabled = false;
  }
}

function saveUtilityCompany() {
  return persistUcRow(false);
}

async function verifyUtilityCompany() {
  if (!(await themedConfirm(t('ucVerifyConfirm')))) return;
  return persistUcRow(true);
}

async function clearUtilityContactFlags(companyId) {
  try {
    const { error } = await sb.from('utility_contact_flags').update({
      resolved: true,
      resolved_at: new Date().toISOString(),
      resolved_by: currentSession ? currentSession.user.id : null
    }).eq('company_id', companyId).eq('resolved', false);
    if (error) throw error;
    toast(t('ucFlagCleared'), 'success');
    await refreshUcOpenCountry();
  } catch (err) {
    console.error('Failed to clear utility contact flags:', err.message);
    toast(t('photoActionFailed'), 'error');
  }
}

async function deleteUtilityCompany(id) {
  const c = ucCompaniesCache.find(x => String(x.id) === String(id));
  if (!c || !canManageContactsForMunicipality(c.municipality_id)) {
    toast(t('ucOutOfDomainError'), 'error');
    return;
  }
  if (!(await themedConfirm(t('ucDeleteConfirm')))) return;
  try {
    const { error } = await sb.from(UTILITY_COMPANIES_TABLE).delete().eq('id', id);
    if (error) throw error;
    await refreshUcOpenCountry();
  } catch (err) {
    console.error('Failed to delete utility company:', err.message);
    toast(t('ucSaveError'), 'error');
  }
}

function clearMarkers(){
  markerById.forEach(m => removeReportLayer(m));
  markerById.clear();
  sectionPinById.forEach(m => removeReportLayer(m));
  sectionPinById.clear();
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Fallback identity shown when a reporter has chosen to hide their username
// (profiles.show_username_on_reports = false → brake_reports.owner_username
// is null for that row, enforced server-side). Short, stable, not reversible
// to the real account by looking at it.
function shortUserId(id) {
  if (!id) return t('shortUserIdUnknown');
  return '#' + String(id).replace(/-/g, '').slice(0, 8).toUpperCase();
}

// Admins still need to be able to identify a reporter behind a hidden report
// for moderation/support — the privacy setting only controls what the public
// sees. Since owner_username is genuinely null in the database for those
// rows (not just hidden in the UI), resolving the real name for an admin
// means a small lookup against profiles (readable by anyone per RLS, so this
// is not a privileged query — just an admin-only *use* of it) rather than
// reading it off the report row.
const resolvedOwnerUsernameCache = new Map();
const pendingOwnerUsernameResolves = new Set();
async function resolveOwnerUsernameForAdmin(ownerId, reportId) {
  if (!ownerId || resolvedOwnerUsernameCache.has(ownerId) || pendingOwnerUsernameResolves.has(ownerId)) return;
  pendingOwnerUsernameResolves.add(ownerId);
  try {
    const { data, error } = await sb.from(PROFILES_TABLE).select('username').eq('id', ownerId).maybeSingle();
    if (!error && data && data.username) {
      resolvedOwnerUsernameCache.set(ownerId, data.username);
      if (reportId) refreshReportViews(reportId);
    }
  } catch (err) {
    console.error('Failed to resolve hidden reporter username:', err.message || err);
  } finally {
    pendingOwnerUsernameResolves.delete(ownerId);
  }
}

// Single source of truth for "whose report is this, as far as the current
// viewer is concerned": your own reports always show your real name to you;
// admins get the real name (with a hidden-from-public marker) for
// moderation even when it's hidden from everyone else; everyone else sees
// either the public username or the short id fallback.
function reporterDisplayName(report) {
  if (!report) return shortUserId(null);
  const isOwner = !!(currentSession && report.owner_id === currentSession.user.id);
  if (isOwner && currentProfile && currentProfile.username) return currentProfile.username;
  if (report.owner_username) return report.owner_username;
  const isAdmin = !!(currentProfile && currentProfile.is_admin);
  if (isAdmin && report.owner_id) {
    const cached = resolvedOwnerUsernameCache.get(report.owner_id);
    if (cached) return cached + ' ' + t('reporterHiddenAdminSuffix');
    resolveOwnerUsernameForAdmin(report.owner_id, report.id);
  }
  return shortUserId(report.owner_id);
}

function buildTimelineItem(dateStr, reached, color, labelHtml) {
  // Reached dots get a solid fill in the stage's status color, set inline
  // since that color is dynamic per-report. Pending dots get no inline
  // background at all — the CSS ".timeline-item.pending .timeline-dot"
  // rule gives them a plain hollow ring instead, so they're still visible
  // (rather than the old near-invisible rgba(255,255,255,.18) fill) while
  // staying clearly "not there yet".
  const dotStyle = reached ? ` style="background:${color};"` : '';
  // Pending stages have no real date yet — leave the date slot empty rather
  // than showing a meaningless "—" placeholder. The dot + label (rendered
  // in a muted/disabled style) is enough to show the stage is upcoming.
  const dateText = reached ? formatDate(dateStr) : '';
  // data-time lets loadDetailTimelineExtras figure out where an extra entry
  // (company notify, contact attempt, gallery photo, etc.) belongs relative
  // to this item chronologically. Only set for reached items — pending
  // placeholders have no real date and always stay at the very bottom.
  const timeAttr = (reached && dateStr) ? ` data-time="${escapeHtml(dateStr)}"` : '';
  return `<div class="timeline-item ${reached ? '' : 'pending'}"${timeAttr}>
    <div class="timeline-line"></div>
    <div class="timeline-dot"${dotStyle}></div>
    <span class="timeline-date">${dateText}</span>
    ${labelHtml ? `<span class="timeline-status-slot">${labelHtml}</span>` : ''}
  </div>`;
}

// Neutral dot color for timeline entries that aren't one of the three
// pipeline stages (reported/in_progress/fixed) — company notifications,
// photos added, contact attempts. These are always "reached" (they only
// get rendered once they've actually happened).
const TIMELINE_EVENT_COLOR = '#8a93a6';
function buildTimelineEventItem(dateStr, rightHtml) {
  return buildTimelineItem(dateStr, true, TIMELINE_EVENT_COLOR, rightHtml);
}

// Icon shown next to each pipeline stage's label once that stage is
// reached — a warning symbol for "reported", an hourglass while
// "in progress", and a thumbs-up once "fixed".
const STAGE_ICONS = {
  reported:    'icons/warning-symbol.png',
  in_progress: 'icons/hourglass.png',
  fixed:       'icons/like.png',
};

// Label for one of the three pipeline stages (reported/in_progress/fixed).
// A not-yet-reached stage gets no label at all — just its dot on the line.
// Once reached, the current status gets its usual colored pill and an
// already-passed stage gets a plain (non-colored) label; either way it
// also gets that stage's icon, label text on the left and icon on the
// right to match the rest of the timeline's left-label/right-icon layout.
function buildPipelineStageLabel(stageKey, report, reached) {
  if (!reached) return '';
  const isCurrent = report.status === stageKey;
  const textHtml = isCurrent
    ? `<span class="status-pill" style="background:${statusColor(stageKey)};">${statusLabel(stageKey)}</span>`
    : `<span class="timeline-stage-label">${statusLabel(stageKey)}</span>`;
  const iconHtml = `<img class="detail-row-icon" src="${STAGE_ICONS[stageKey]}" alt="">`;
  return textHtml + iconHtml;
}

function buildPopupHtml(report) {
  const catCol = categoryColor(report.category);
  const sCol   = statusColor(report.status);
  const isOwner = !!(currentSession && report.owner_id === currentSession.user.id);
  const reporterName = reporterDisplayName(report);
  const dupGroup = duplicateGroupFor(report.id);
  const groupIdsJson = escapeHtml(JSON.stringify(dupGroup ? dupGroup.ids : [report.id]));

  const headerTitle = report.subcategory
    ? `${translateCategory(report.category)} / ${subcategoryLabel(report.category, report.subcategory)}`
    : translateCategory(report.category);

  const hasFullPower = hasFullPowerOverReport(report);
  const isPersonalProblem = reportIsPersonalProblem(report);
  let actionsHtml = '';
  if (hasFullPower) {

    const statuses = [
      { key: 'reported',    label: t('markReported'),   bg: STATUS_COLORS.reported },
      { key: 'in_progress', label: t('markInProgress'), bg: STATUS_COLORS.in_progress },
      { key: 'fixed',       label: t('markFixed'),      bg: STATUS_COLORS.fixed }
    ].filter(s => s.key !== report.status && !(s.key === 'in_progress' && categorySkipsInProgress(report.category)));
    actionsHtml = `<div class="status-action-row">
      ${statuses.map(s => `<button class="status-action-btn" style="background:${s.bg};" onclick='updateReportStatus(${groupIdsJson},"${s.key}")'>${s.label}</button>`).join('')}
    </div>`;
  } else if (isPersonalProblem && isOwner && report.status !== 'fixed') {

    const statuses = [
      { key: 'in_progress', label: t('markInProgress'), bg: STATUS_COLORS.in_progress },
      { key: 'fixed',       label: t('markFixed'),      bg: STATUS_COLORS.fixed }
    ].filter(s => s.key !== report.status && !(s.key === 'in_progress' && categorySkipsInProgress(report.category)));
    actionsHtml = `<div class="status-action-row">
      ${statuses.map(s => `<button class="status-action-btn" style="background:${s.bg};" onclick='updateReportStatus(${groupIdsJson},"${s.key}")'>${s.label}</button>`).join('')}
    </div>
    <div class="popup-personal-note">${t('personalProblemOwnerNote')}</div>`;
  } else if (currentSession && report.status !== 'fixed' && !isPersonalProblem) {
    const statuses = [
      { key: 'reported',    label: t('markReported'),   bg: STATUS_COLORS.reported },
      { key: 'in_progress', label: t('markInProgress'), bg: STATUS_COLORS.in_progress },
      { key: 'fixed',       label: t('markFixed'),      bg: STATUS_COLORS.fixed }
    ].filter(s => s.key !== report.status && !(s.key === 'in_progress' && categorySkipsInProgress(report.category)));

    actionsHtml = `<div class="status-action-row">
      ${statuses.map(s => {
        const isOwnerFastTrack = isOwner && s.key === 'in_progress' && report.status === 'reported';
        const handler = isOwnerFastTrack
          ? `updateReportStatus(${groupIdsJson},"${s.key}")`
          : `castStatusVote(${groupIdsJson},"${s.key}")`;
        return `<button class="status-action-btn" style="background:${s.bg};" onclick='${handler}'>${s.label}</button>`;
      }).join('')}
    </div>
    ${buildVoteProgressHtml(report)}`;
  }

  const noteRowHtml = report.comment
    ? `<div class="popup-note-row"><div class="popup-note">${escapeHtml(truncateForPopup(report.comment, 220))}</div></div>`
    : '';

  return `<div class="popup-inner popup-card">
    <div class="popup-header" style="background:${catCol};">
      <span class="popup-header-title">${headerTitle}</span>
      <span class="popup-header-date">${formatDate(report.created_at)}</span>
    </div>
    <div class="popup-body">
      <div class="popup-row">
        <span class="popup-row-label">${t('popupStatus')}</span>
        <span class="status-pill" style="background:${sCol};">${statusLabel(report.status)}</span>
      </div>
      <div class="popup-row">
        <span class="popup-row-label">${t('priorityLabel')}</span>
        <span class="status-pill" style="background:${priorityColor(report.priority)};">${priorityLabelText(report.priority)}</span>
      </div>
      <div class="popup-row">
        <span class="popup-row-label">${t('reportedByLabel')}</span>
        <span class="popup-row-value">${escapeHtml(reporterName)}${isOwner ? ` <span class="owner-tag">(${t('yourReport')})</span>` : ''}</span>
      </div>
      ${dupGroup ? `<div class="popup-row">
        <span class="popup-row-label"><img class="row-check-icon" src="icons/check.png" alt=""></span>
        <span class="popup-row-value">${t('confirmedByLabel').replace('{n}', dupGroup.count)}</span>
      </div>` : ''}
    </div>
    ${noteRowHtml}
    <div class="status-action-row" style="border-top:none;padding-top:0;">
      <button class="status-action-btn" style="background:#2a2a2a;" onclick="showReportDetailModal('${report.id}')">${t('detailsBtn')}</button>
      <button class="status-action-btn popup-close-btn" style="background:#ff4b4b;" onclick="map.closePopup();">${t('closeBtn')}</button>
    </div>
    ${actionsHtml}
  </div>`;
}

const VOTE_THRESHOLD = 3;
function buildVoteProgressHtml(report) {
  const progress = voteProgressByReport.get(report.id);
  if (!progress) return '';
  const rows = Object.keys(progress)
    .filter(status => status !== report.status && progress[status] > 0 && progress[status] < VOTE_THRESHOLD)
    .map(status => {
      const p = progress[status];
      const pct = Math.min(100, Math.round((p / VOTE_THRESHOLD) * 100));
      return `<div class="vote-progress-badge">
        <div class="vote-progress-badge-top">
          <img class="vote-progress-icon" src="icons/hourglass.png" alt="">
          <span>${t('voteProgress').replace('{status}', statusLabel(status)).replace('{p}', p)}</span>
        </div>
        <div class="vote-progress-track"><div class="vote-progress-fill" style="width:${pct}%"></div></div>
      </div>`;
    });
  return rows.length ? `<div class="vote-progress-row">${rows.join('')}</div>` : '';
}

async function fetchAddressForPoint(lat, lon) {
  if (!isValidLatLng(lat, lon)) return null;
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`;
    const res = await nominatimFetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json || json.error) return null;
    const addr = json.address || {};
    const street = addr.road
      ? (addr.house_number ? `${addr.road} ${addr.house_number}` : addr.road)
      : null;
    const area = addr.suburb || addr.neighbourhood || addr.quarter || addr.city_district || addr.village || null;
    return { street, area };
  } catch (err) {
    console.error('fetchAddressForPoint error:', err.message);
    return null;
  }
}

async function showReportDetailModal(reportId) {
  const report = globalActiveData.find(r => r.id === reportId);
  if (!report || !isValidLatLng(report.latitude, report.longitude)) return;

  const isOwner = !!(currentSession && report.owner_id === currentSession.user.id);
  const isAdmin = !!(currentProfile && currentProfile.is_admin);

  const modal = document.getElementById('reportDetailModal');
  const body = document.getElementById('reportDetailBody');
  const titleEl = document.getElementById('reportDetailTitle');
  const headerEl = document.getElementById('reportDetailHeader');
  const headerTitle = report.subcategory
    ? `${translateCategory(report.category)} / ${subcategoryLabel(report.category, report.subcategory)}`
    : translateCategory(report.category);
  titleEl.textContent = headerTitle;

  const idRowEl = document.getElementById('reportDetailIdRow');
  if (idRowEl) {
    const idTextEl = document.getElementById('reportDetailIdText');
    if (idTextEl) idTextEl.textContent = `ID: ${report.id}`;
    const idCopyIcon = document.getElementById('reportDetailIdCopyIcon');
    if (idCopyIcon) {
      clearTimeout(reportIdCopyIconRevertTimer);
      idCopyIcon.src = 'icons/copy.png';
    }
    idRowEl.title = t('copyReportIdTooltip');
    idRowEl.setAttribute('aria-label', t('copyReportIdTooltip'));
    idRowEl.onclick = () => copyReportIdToClipboard(report.id);
    idRowEl.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copyReportIdToClipboard(report.id); }
    };
  }

  if (headerEl) {
    headerEl.style.background = statusColor(report.status);
    headerEl.classList.add('status-colored');
  }
  const reporterName = reporterDisplayName(report);
  const showPhotoImage = !!report.photo_path && !!currentSession && (
    report.photo_status === 'approved' ||
    (report.photo_status === 'pending' && (isOwner || isAdmin)) ||
    (report.photo_status === 'rejected' && isAdmin)
  );
  const showPhotoLoginPrompt = !!report.photo_path && !currentSession && report.photo_status === 'approved';
  let photoSectionHtml = '';
  if (showPhotoImage) {
    const badge = report.photo_status === 'pending'
      ? `<span class="photo-status-badge pending">${t('photoPendingBadge')}</span>`
      : report.photo_status === 'rejected'
        ? `<span class="photo-status-badge rejected">${t('photoRejectedBadge')}</span>`
        : '';
    photoSectionHtml = `
    <div class="detail-subsection">
      <div class="detail-subsection-title">${t('detailPhotoTitle')}${badge}</div>
      <div class="detail-photo-wrap" id="detailPhotoWrap"><div class="detail-loading">${t('detailLoading')}</div></div>
    </div>`;
  } else if (showPhotoLoginPrompt) {
    photoSectionHtml = `
    <div class="detail-subsection">
      <div class="detail-subsection-title">${t('detailPhotoTitle')}</div>
      <div class="detail-photo-wrap"><div class="detail-empty">${t('photoLoginPrompt')}</div></div>
    </div>`;
  } else if (report.photo_path && isOwner && report.photo_status === 'rejected') {
    photoSectionHtml = `
    <div class="detail-subsection">
      <div class="detail-subsection-title">${t('detailPhotoTitle')}</div>
      <p class="detail-export-hint">${t('photoRejectedOwnerNote')}</p>
    </div>`;
  }
  if (photoSectionHtml) {
    photoSectionHtml = photoSectionHtml.replace(
      `>${t('detailPhotoTitle')}<`,
      `>${t('detailBeforePhotoTitle')}<`
    );
  }

  let afterPhotoSectionHtml = '';
  const showAfterPhotoImage = !!report.after_photo_path && !!currentSession && (
    report.after_photo_status === 'approved' ||
    (report.after_photo_status === 'pending' && (isOwner || isAdmin)) ||
    (report.after_photo_status === 'rejected' && isAdmin)
  );
  const showAfterPhotoLoginPrompt = !!report.after_photo_path && !currentSession && report.after_photo_status === 'approved';
  if (showAfterPhotoImage) {
    const badge = report.after_photo_status === 'pending'
      ? `<span class="photo-status-badge pending">${t('photoPendingBadge')}</span>`
      : report.after_photo_status === 'rejected'
        ? `<span class="photo-status-badge rejected">${t('photoRejectedBadge')}</span>`
        : '';
    afterPhotoSectionHtml = `
    <div class="detail-subsection">
      <div class="detail-subsection-title">${t('detailAfterPhotoTitle')}${badge}</div>
      <div class="detail-photo-wrap" id="detailAfterPhotoWrap"><div class="detail-loading">${t('detailLoading')}</div></div>
    </div>`;
  } else if (showAfterPhotoLoginPrompt) {
    afterPhotoSectionHtml = `
    <div class="detail-subsection">
      <div class="detail-subsection-title">${t('detailAfterPhotoTitle')}</div>
      <div class="detail-photo-wrap"><div class="detail-empty">${t('afterPhotoLoginPrompt')}</div></div>
    </div>`;
  } else if (report.after_photo_path && isOwner && report.after_photo_status === 'rejected') {
    afterPhotoSectionHtml = `
    <div class="detail-subsection">
      <div class="detail-subsection-title">${t('detailAfterPhotoTitle')}</div>
      <p class="detail-export-hint">${t('afterPhotoRejectedOwnerNote')}</p>
    </div>`;
  } else if (!report.after_photo_path && report.status === 'fixed' && (isOwner || isAdmin)) {
    afterPhotoSectionHtml = `
    <div class="detail-subsection">
      <div class="detail-subsection-title">${t('detailAfterPhotoTitle')}</div>
      <button type="button" class="settings-btn" onclick="addAfterPhotoToReport('${report.id}')"><img class="icon-img icon-img-inline" src="icons/camera.png" alt=""> ${t('addAfterPhotoBtn')}</button>
    </div>`;
  }

  const canFlagReport = !!(currentSession && !isOwner);
  const flagSectionHtml = canFlagReport ? `
    <div class="detail-subsection" id="reportFlagSection">
      <div class="detail-subsection-title">${t('flagReportTitle')}</div>
      <div id="reportFlagContent"><div class="detail-loading">${t('detailLoading')}</div></div>
    </div>` : '';

  // Once a report is fixed there's nothing left to document "before" the
  // fix, so the community upload buttons stop being actionable — same
  // reasoning as the before-photo icon and the company contact links below.
  const isFixed = report.status === 'fixed';
  const gallerySectionHtml = `
    <div class="detail-subsection">
      <div class="detail-subsection-title">${t('detailGalleryTitle')}</div>
      <div class="detail-gallery-strip" id="detailGalleryStrip"><div class="detail-loading">${t('detailLoading')}</div></div>
      ${currentSession ? `<div style="display:flex; gap:10px; margin-top:10px;">
        <button type="button" class="settings-btn" style="flex:1;" ${isFixed ? 'disabled' : ''} onclick="addGalleryPhotoToReport('${report.id}','camera')"><img class="icon-img icon-img-inline" src="icons/camera.png" alt="">${t('reportPhotoAddBtn')}</button>
        <button type="button" class="settings-btn" style="flex:1;" ${isFixed ? 'disabled' : ''} onclick="addGalleryPhotoToReport('${report.id}','library')"><img class="icon-img icon-img-inline" src="icons/gallery.png" alt="">${t('reportPhotoGalleryBtn')}</button>
      </div>` : ''}
    </div>`;

  // Before/after photos + the community gallery are all "pictures of this
  // report" — one card instead of three separate boxes.
  const panelBg = detailPanelBg(report.category);

  const photosGroupHtml = `
    <div class="detail-section" style="${panelBg}">
      ${photoSectionHtml}
      ${afterPhotoSectionHtml}
      ${gallerySectionHtml}
    </div>`;

  body.innerHTML = `
    <div class="detail-section" id="reportDetailStatusSection" style="${panelBg}">
      ${buildDetailStatusReadonlyHtml(report, reporterName)}
    </div>
    ${photosGroupHtml}
    <div class="detail-section" style="${panelBg}">
      <div class="detail-section-title-row">
        <div class="detail-section-title">${t('detailContactsTitle')}</div>
        <div class="contact-count-row" id="detailContactCountsContainer"></div>
      </div>
      <div id="detailContactNudge"></div>
      <div id="detailContactsContainer"><div class="detail-loading">${t('detailLoading')}</div></div>
      ${flagSectionHtml}
    </div>
    <div class="detail-section" style="${panelBg}">
      <div class="detail-section-title">${t('detailExportTitle')}</div>
      <div style="display:flex;gap:var(--space-8);">
        <button type="button" class="settings-btn" style="flex:1;" onclick="emailReport('${report.id}')" id="reportDetailExportBtn"><img class="icon-img icon-img-inline" src="icons/email.png" alt="email"> ${t('detailExportBtn')}</button>
        <button type="button" class="fullscreen-modal-share" onclick="copyReportLinkToClipboard('${report.id}')" id="reportDetailCopyLinkBtn" aria-label="${t('copyLinkBtn')}" title="${t('copyLinkBtn')}"><img class="icon-img" id="reportDetailCopyLinkIcon" src="icons/copy.png" alt="copy link"></button>
        <button type="button" class="fullscreen-modal-share" onclick="shareReport('${report.id}')" id="reportDetailShareBtn" aria-label="Share"><img class="icon-img" src="icons/link.png" alt="share"></button>
      </div>
    </div>
  `;

  bringModalToFront(modal);
  modal.style.display = 'flex';
  modal.dataset.openReportId = report.id;
  openOverlay('reportDetailModal', hideReportDetailModal);

  if (canFlagReport) loadReportFlagSection(report.id);
  if (report.owner_id && currentSession && currentAdminLevel() >= 2 && report.owner_id !== currentSession.user.id) {
    refreshBanButtonState(report.id, report.owner_id);
  }

  if (showPhotoImage) {
    // The modal only ever displays this at up to ~260px tall, so load the
    // small "display" transform here; the click-through still fetches the
    // untransformed original on demand via openFullSizeReportPhoto.
    getReportPhotoSignedUrl(report.photo_path, null, 'display').then(url => {
      const wrap = document.getElementById('detailPhotoWrap');
      if (!wrap) return;
      const path = escapeHtml(report.photo_path);
      wrap.innerHTML = url
        ? `<img src="${url}" alt="${t('photoViewFullSizeBefore')}" class="detail-photo-img" role="button" tabindex="0" onclick="openFullSizeReportPhoto('${path}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openFullSizeReportPhoto('${path}');}">`
        : `<div class="detail-empty">${t('photoLoadFailed')}</div>`;
    });
  }

  if (showAfterPhotoImage) {
    getReportPhotoSignedUrl(report.after_photo_path, null, 'display').then(url => {
      const wrap = document.getElementById('detailAfterPhotoWrap');
      if (!wrap) return;
      const path = escapeHtml(report.after_photo_path);
      wrap.innerHTML = url
        ? `<img src="${url}" alt="${t('photoViewFullSizeAfter')}" class="detail-photo-img" role="button" tabindex="0" onclick="openFullSizeReportPhoto('${path}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openFullSizeReportPhoto('${path}');}">`
        : `<div class="detail-empty">${t('photoLoadFailed')}</div>`;
    });
  }

  renderReportGallery(report.id);
  renderStaleBadgeForDetail(report);
  loadDetailTimelineExtras(report);

  fetchAddressForPoint(report.latitude, report.longitude).then(addr => {
    const streetEl = document.getElementById('detailStreetValue');
    const areaEl   = document.getElementById('detailAreaValue');
    if (streetEl) streetEl.textContent = (addr && addr.street) ? addr.street : t('detailUnknown');
    if (areaEl) areaEl.textContent = (addr && addr.area) ? addr.area : t('detailUnknown');
  });

  const muni = await resolveReportMunicipality(report);
  const muniEl = document.getElementById('detailMunicipalityValue');
  if (muniEl) {
    muniEl.textContent = muni ? municipalityDisplayName(muni) : t('detailUnknown');
  }

  try {
    renderMunicipalityBoundary(muni);
  } catch (err) {
    console.error('Failed to render municipality boundary:', err.message);
  }

  loadReportContactCounts(report.id);

  const contactsEl = document.getElementById('detailContactsContainer');
  if (!muni || muni.id == null) {
    const fallbackContacts = await getReportContactsByProximity(report);
    if (contactsEl) contactsEl.innerHTML = fallbackContacts.length
      ? renderContactCards(fallbackContacts, report.id, isFixed)
      : `<div class="detail-empty">${t('detailNoMunicipality')}</div>`;
    return;
  }
  const contacts = await getReportContacts(report, muni);
  if (contactsEl) contactsEl.innerHTML = renderContactCards(contacts, report.id, isFixed);
}

async function loadReportFlagSection(reportId) {
  const contentEl = document.getElementById('reportFlagContent');
  if (!contentEl || !currentSession) return;
  try {
    const { data, error } = await sb.from('report_flags').select('*')
      .eq('report_id', reportId).eq('flagged_by', currentSession.user.id).maybeSingle();
    if (error) throw error;
    renderReportFlagSection(reportId, data || null);
  } catch (err) {
    console.error('Failed to load flag status:', err.message);
    renderReportFlagSection(reportId, null);
  }
}

function renderReportFlagSection(reportId, existingFlag) {
  const contentEl = document.getElementById('reportFlagContent');
  if (!contentEl) return;
  if (existingFlag && !existingFlag.resolved) {
    contentEl.innerHTML = `<div class="flag-report-note">
      ${t('flagReportAlreadyFlaggedNote').replace('{date}', formatDate(existingFlag.created_at))}<br>
      "${escapeHtml(existingFlag.reason)}"
    </div>`;
    return;
  }
  contentEl.innerHTML = `<button type="button" class="settings-btn" id="flagReportToggleBtn" onclick="showFlagReportForm('${reportId}')">${t('flagReportBtn')}</button>`;
}

function showFlagReportForm(reportId) {
  const contentEl = document.getElementById('reportFlagContent');
  if (!contentEl) return;
  contentEl.innerHTML = `
    <div class="flag-report-form" id="flagReportForm">
      <textarea id="flagReportReason" placeholder="${t('flagReportPH')}"></textarea>
      <div class="flag-report-form-row">
        <button type="button" class="settings-btn" style="flex:1;" onclick="renderReportFlagSection('${reportId}', null)">${t('flagReportCancelBtn')}</button>
        <button type="button" style="background:var(--accent);color:white;flex:1;" onclick="submitReportFlag('${reportId}')" id="flagReportSubmitBtn">${t('flagReportSubmitBtn')}</button>
      </div>
    </div>`;
  const reasonEl = document.getElementById('flagReportReason');
  if (reasonEl) reasonEl.focus();
}

async function submitReportFlag(reportId) {
  if (!currentSession) { toast(t('flagReportLoginRequired'), 'error'); return; }
  const reasonEl = document.getElementById('flagReportReason');
  const reason = reasonEl ? reasonEl.value.trim() : '';
  if (!reason) { toast(t('flagReportValidationError'), 'error'); return; }
  if (blockIfProfane(reason)) return;
  const submitBtn = document.getElementById('flagReportSubmitBtn');
  if (submitBtn) submitBtn.disabled = true;
  try {
    const { error } = await sb.from('report_flags').upsert({
      report_id: reportId,
      flagged_by: currentSession.user.id,
      reason: cyrillicToLatin(reason),
      resolved: false,
      resolved_at: null,
      resolved_by: null,
      created_at: new Date().toISOString()
    }, { onConflict: 'report_id,flagged_by' });
    if (error) throw error;
    toast(t('flagReportSubmitted'), 'success');
    loadReportFlagSection(reportId);
  } catch (err) {
    console.error('Failed to submit report flag:', err.message);
    toast(t('flagReportError'), 'error');
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function getReportContacts(report, muni) {
  if (report.contacts && report.contacts.length) return report.contacts;
  if (!muni || muni.id == null) { report.contacts = []; return report.contacts; }
  try {
    const { data, error } = await sb.from(UTILITY_COMPANIES_TABLE)
      .select('*')
      .eq('municipality_id', muni.id)
      .eq('verified', true)
      .contains('categories', [report.category]);
    if (error) throw error;
    let contacts = data || [];
    if (!contacts.length) {
      const fallback = await sb.from(UTILITY_COMPANIES_TABLE)
        .select('*')
        .eq('municipality_id', muni.id)
        .contains('categories', [report.category]);
      if (!fallback.error && fallback.data && fallback.data.length) contacts = fallback.data;
    }
    report.contacts = contacts;
  } catch (err) {
    console.error('Failed to load utility contacts:', err.message);
    report.contacts = [];
  }
  return report.contacts;
}

const REPORT_CONTACT_FALLBACK_MAX_M = 50000;
const REPORT_CONTACT_FALLBACK_LIMIT = 3;
async function getReportContactsByProximity(report) {
  if (!isValidLatLng(report.latitude, report.longitude)) return [];
  try {
    const { data, error } = await sb.from(UTILITY_COMPANIES_TABLE)
      .select('*')
      .eq('verified', true)
      .not('lat', 'is', null)
      .not('lon', 'is', null)
      .contains('categories', [report.category]);
    if (error) throw error;
    const candidates = (data || [])
      .filter(c => isValidLatLng(c.lat, c.lon))
      .map(c => ({ c, d: distMeters({ lat: report.latitude, lon: report.longitude }, { lat: c.lat, lon: c.lon }) }))
      .filter(x => x.d <= REPORT_CONTACT_FALLBACK_MAX_M)
      .sort((a, b) => a.d - b.d)
      .slice(0, REPORT_CONTACT_FALLBACK_LIMIT);
    return candidates.map(x => x.c);
  } catch (err) {
    console.error('Failed to load fallback utility contacts by proximity:', err.message);
    return [];
  }
}

function renderContactRows(c, reportId, isFixed) {
  if (c && c.id != null) utilityCompanyRegistry.set(String(c.id), c);
  const companyIdAttr = c.id != null ? escapeHtml(String(c.id)) : '';
  const phoneClickAttr = reportId ? ` onclick="recordContactAttempt('${escapeHtml(reportId)}','phone','${companyIdAttr}')"` : '';
  const emailClickAttr = reportId ? ` onclick="recordContactAttempt('${escapeHtml(reportId)}','email','${companyIdAttr}')"` : '';
  const otherFlagBtn = c.id != null
    ? `<button type="button" class="contact-flag-btn contact-flag-other-btn" onclick="toggleContactOtherFlagForm('${companyIdAttr}')">${t('contactFlagOtherBtn')}</button>` : '';
  // Once the report is fixed there's nothing left to call or email the
  // company about for it, so phone/email render as plain text instead of
  // tel:/mailto: links. Website, address, notes, and "wrong info" flagging
  // stay active — those are properties of the company, not this report.
  const phoneRowsHtml = contactEntries(c.phone).map(p => isFixed
    ? `<div class="contact-card-row"><img class="contact-card-icon" src="icons/phone.png" alt="phone"><span>${p.label ? `<span class="contact-card-entry-label">${escapeHtml(p.label)}</span>` : ''}${escapeHtml(p.value)}</span></div>`
    : `<div class="contact-card-row"><img class="contact-card-icon" src="icons/phone.png" alt="phone"><a href="tel:${escapeHtml(p.value)}"${phoneClickAttr}>${p.label ? `<span class="contact-card-entry-label">${escapeHtml(p.label)}</span>` : ''}${escapeHtml(p.value)}</a></div>`).join('');
  const emailRowsHtml = contactEntries(c.email).map(e => isFixed
    ? `<div class="contact-card-row"><img class="contact-card-icon" src="icons/email.png" alt="email"><span>${e.label ? `<span class="contact-card-entry-label">${escapeHtml(e.label)}</span>` : ''}${escapeHtml(e.value)}</span></div>`
    : `<div class="contact-card-row"><img class="contact-card-icon" src="icons/email.png" alt="email"><a href="mailto:${escapeHtml(e.value)}"${emailClickAttr}>${e.label ? `<span class="contact-card-entry-label">${escapeHtml(e.label)}</span>` : ''}${escapeHtml(e.value)}</a></div>`).join('');
  return `
      ${phoneRowsHtml}
      ${emailRowsHtml}
      ${c.website ? `<div class="contact-card-row"><img class="contact-card-icon" src="icons/link.png" alt="link"><a href="${escapeHtml(c.website)}" target="_blank" rel="noopener">${escapeHtml(c.website)}</a></div>` : ''}
      ${c.address && c.id != null ? `<div class="contact-card-row"><img class="contact-card-icon" src="icons/pin.png" alt="pin"><a href="javascript:void(0)" onclick="focusUtilityCompanyAddress('${escapeHtml(String(c.id))}')">${escapeHtml(c.address)}</a></div>` : c.address ? `<div class="contact-card-row"><img class="contact-card-icon" src="icons/pin.png" alt="pin"><span>${escapeHtml(c.address)}</span></div>` : ''}
      ${c.notes ? `<div class="contact-card-row contact-card-notes"><span>${escapeHtml(c.notes)}</span></div>` : ''}
      ${otherFlagBtn ? `<div class="contact-card-row contact-card-other-flag-row">${otherFlagBtn}</div>` : ''}
      ${c.id != null ? `<div class="flag-report-form" id="contact-other-flag-form-${companyIdAttr}" style="display:none">
        <textarea id="contact-other-flag-reason-${companyIdAttr}" placeholder="${t('contactFlagOtherPH')}"></textarea>
        <div class="flag-report-form-row">
          <button type="button" class="settings-btn" style="flex:1;" onclick="toggleContactOtherFlagForm('${companyIdAttr}')">${t('flagReportCancelBtn')}</button>
          <button type="button" style="background:var(--accent);color:white;flex:1;" onclick="submitContactOtherFlag('${companyIdAttr}')" id="contact-other-flag-submit-${companyIdAttr}">${t('flagReportSubmitBtn')}</button>
        </div>
      </div>` : ''}
  `;
}

function renderContactCards(companies, reportId, isFixed) {
  if (!companies.length) return `<div class="detail-empty">${t('detailNoContacts')}</div>`;
  return companies.map(c => `
    <div class="contact-card">
      <div class="contact-card-name">${escapeHtml(c.name)}</div>
      ${buildCompanyCatsHtml(c, 6)}
      ${renderContactRows(c, reportId, isFixed)}
    </div>
  `).join('');
}

function recordContactAttempt(reportId, type, companyId) {
  const company = companyId ? utilityCompanyRegistry.get(String(companyId)) : null;
  try {
    localStorage.setItem('pendingContactAttempt', JSON.stringify({
      reportId,
      type,
      companyId: companyId || null,
      companyName: company ? company.name : '',
      ts: Date.now()
    }));
  } catch (err) {
    console.error('Failed to stage contact attempt:', err.message);
  }
  scheduleFallbackContactCheck();
}

async function flagUtilityContact(companyId, contactType, reason) {
  if (!currentSession) { toast(t('contactFlagLoginRequired'), 'error'); return; }
  const btn = document.getElementById(`contact-flag-${companyId}-${contactType}`);
  if (btn) btn.disabled = true;
  try {
    const { error } = await sb.from('utility_contact_flags').upsert({
      company_id: companyId,
      contact_type: contactType,
      flagged_by: currentSession.user.id,
      reason: reason || null,
      created_at: new Date().toISOString()
    }, { onConflict: 'company_id,contact_type,flagged_by' });
    if (error) throw error;
    toast(t('contactFlagSubmitted'), 'success');
    if (btn) btn.textContent = t('contactFlagAlready');
    notifyAdminsOfContactFlag(companyId, contactType, reason);
  } catch (err) {
    console.error('Failed to flag utility contact:', err.message);
    toast(t('contactFlagError'), 'error');
    if (btn) btn.disabled = false;
    throw err;
  }
}

function toggleContactOtherFlagForm(companyId) {
  const form = document.getElementById(`contact-other-flag-form-${companyId}`);
  if (!form) return;
  const showing = form.style.display !== 'none';
  form.style.display = showing ? 'none' : 'block';
  if (!showing) {
    const reasonEl = document.getElementById(`contact-other-flag-reason-${companyId}`);
    if (reasonEl) reasonEl.focus();
  }
}

async function submitContactOtherFlag(companyId) {
  if (!currentSession) { toast(t('contactFlagLoginRequired'), 'error'); return; }
  const reasonEl = document.getElementById(`contact-other-flag-reason-${companyId}`);
  const reason = reasonEl ? reasonEl.value.trim() : '';
  if (!reason) { toast(t('flagReportValidationError'), 'error'); return; }
  if (blockIfProfane(reason)) return;
  const submitBtn = document.getElementById(`contact-other-flag-submit-${companyId}`);
  if (submitBtn) submitBtn.disabled = true;
  try {
    await flagUtilityContact(companyId, 'other', cyrillicToLatin(reason));
    toggleContactOtherFlagForm(companyId);
  } catch (err) {

  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function notifyAdminsOfContactFlag(companyId, contactType, reason) {
  try {
    const { error } = await sb.rpc('notify_admins_of_contact_flag', {
      p_company_id: companyId,
      p_contact_type: contactType,
      p_reason: reason || null
    });
    if (error) throw error;
  } catch (err) {
    console.error('Failed to notify admins of contact flag:', err.message || err);
  }
}

const CONTACT_FALLBACK_DELAYS_MS = [1200, 3000, 6000];
function scheduleFallbackContactCheck() {
  CONTACT_FALLBACK_DELAYS_MS.forEach(delay => {
    setTimeout(() => {
      if (document.visibilityState === 'visible') checkPendingContactAttempt();
    }, delay);
  });
}

function checkPendingContactAttempt() {
  let pending;
  try {
    const raw = localStorage.getItem('pendingContactAttempt');
    if (!raw) return;
    localStorage.removeItem('pendingContactAttempt');
    pending = JSON.parse(raw);
  } catch (err) {
    return;
  }
  if (!pending || !pending.reportId || !pending.type) return;
  if (Date.now() - pending.ts > 15 * 60 * 1000) return;
  showContactConfirmModal(pending);
}

function showContactConfirmModal(pending) {
  const modal = document.getElementById('contactConfirmModal');
  const inner = document.getElementById('contactConfirmModalInner');
  if (!modal || !inner) return;
  let question;
  if (pending.type === 'email') {
    question = pending.companyName
      ? t('contactConfirmQuestionEmailNamed').replace('{name}', pending.companyName)
      : t('contactConfirmQuestionEmail');
  } else {
    question = pending.companyName
      ? t('contactConfirmQuestionPhoneNamed').replace('{name}', pending.companyName)
      : t('contactConfirmQuestionPhone');
  }
  modal.dataset.reportId = pending.reportId;
  modal.dataset.type = pending.type;
  modal.dataset.companyId = pending.companyId || '';
  inner.innerHTML = `
    <h2>${t('contactConfirmTitle')}</h2>
    <p>${escapeHtml(question)}</p>
    <div style="display:flex;gap:var(--space-8);">
      <button type="button" class="settings-btn" style="flex:1;" onclick="confirmContactAttempt(false)">${t('contactConfirmNoBtn')}</button>
      <button type="button" style="background:var(--accent);color:white;flex:1;border:none;border-radius:14px;padding:12px 20px;font-size:var(--fs-14);font-weight:var(--fw-semibold);cursor:pointer;min-height:44px;" onclick="confirmContactAttempt(true)">${t('contactConfirmYesBtn')}</button>
    </div>
  `;
  bringModalToFront(modal);
  modal.style.display = 'flex';
  openOverlay('contactConfirmModal', hideContactConfirmModal);
}

function hideContactConfirmModal() {
  const modal = document.getElementById('contactConfirmModal');
  if (modal) modal.style.display = 'none';
  closeOverlay('contactConfirmModal');
}

async function confirmContactAttempt(confirmed) {
  const modal = document.getElementById('contactConfirmModal');
  const reportId = modal ? modal.dataset.reportId : null;
  const type = modal ? modal.dataset.type : null;
  const companyId = modal && modal.dataset.companyId ? modal.dataset.companyId : null;
  hideContactConfirmModal();
  if (!confirmed || !reportId || !type) return;
  try {
    const { error } = await sb.from(REPORT_CONTACT_EVENTS_TABLE).insert({
      report_id: reportId,
      contact_type: type,
      company_id: companyId,
      contacted_by: currentSession ? currentSession.user.id : null
    });
    if (error) throw error;
    toast(t('contactConfirmThanks'), 'success');
    refreshReportContactCounts(reportId);
    refreshDetailTimelineExtras(reportId);
    if (type === 'phone') await offerFollowUpEmailAfterCall(reportId, companyId);
  } catch (err) {
    console.error('Failed to log contact attempt:', err.message);
  }
}

async function offerFollowUpEmailAfterCall(reportId, companyId) {
  const company = companyId ? utilityCompanyRegistry.get(String(companyId)) : null;
  const companyEmails = company ? contactEntries(company.email) : [];
  if (!companyEmails.length) return;

  let wantsEmail;
  try {
    wantsEmail = await themedConfirm(
      t('followUpEmailPrompt').replace('{name}', company.name || ''),
      { okLabel: t('followUpEmailYesBtn'), cancelLabel: t('followUpEmailNoBtn') }
    );
  } catch (err) {
    return;
  }
  if (!wantsEmail) return;

  const emailLang = utilityLangFor(getMunicipalityById(company.municipality_id));
  const report = globalActiveData.find(r => r.id === reportId);
  const headerTitle = report
    ? (report.subcategory ? `${translateCategory(report.category, emailLang)} / ${subcategoryLabel(report.category, report.subcategory, emailLang)}` : translateCategory(report.category, emailLang))
    : '';
  const url = reportShareUrl(reportId);
  const subject = encodeURIComponent(t('followUpEmailSubject', emailLang).replace('{category}', headerTitle));
  const body = encodeURIComponent(`${t('followUpEmailBodyIntro', emailLang).replace('{category}', headerTitle)}\n\n${url}`);
  window.location.href = `mailto:${companyEmails.map(e => e.value).join(',')}?subject=${subject}&body=${body}`;

  recordContactAttempt(reportId, 'email', companyId);
}

async function offerContactFollowUp(reportId, report) {
  if (!reportId || !report) return;
  let wantsToContact;
  try {
    wantsToContact = await themedConfirm(t('postReportContactPrompt'), {
      okLabel: t('postReportContactYesBtn'),
      cancelLabel: t('postReportContactNoBtn')
    });
  } catch (err) {
    return;
  }
  if (!wantsToContact) return;
  showPostReportContactModal(reportId, report);
}

function renderPostReportContactLoading() {
  const inner = document.getElementById('postReportContactModalInner');
  if (!inner) return;
  inner.innerHTML = `
    <h2>${t('postReportContactTitle')}</h2>
    <div class="detail-loading">${t('detailLoading')}</div>
  `;
}

async function showPostReportContactModal(reportId, report) {
  const modal = document.getElementById('postReportContactModal');
  if (!modal) return;
  renderPostReportContactLoading();
  bringModalToFront(modal);
  modal.style.display = 'flex';
  openOverlay('postReportContactModal', hidePostReportContactModal);

  let contacts = [];
  try {
    const muni = await resolveReportMunicipality(report);
    contacts = (muni && muni.id != null)
      ? await getReportContacts(report, muni)
      : await getReportContactsByProximity(report);
  } catch (err) {
    console.error('Failed to load contacts for post-report follow-up:', err.message);
  }

  const inner = document.getElementById('postReportContactModalInner');
  if (!inner || modal.style.display === 'none') return;
  inner.innerHTML = `
    <h2>${t('postReportContactTitle')}</h2>
    ${contacts.length ? renderContactCards(contacts, reportId) : `<div class="detail-empty">${t('detailNoContacts')}</div>`}
    <button type="button" class="generic-modal-close" onclick="hidePostReportContactModal()">${t('postReportContactCloseBtn')}</button>
  `;
}

function hidePostReportContactModal() {
  const modal = document.getElementById('postReportContactModal');
  if (modal) modal.style.display = 'none';
  closeOverlay('postReportContactModal');
}

async function getReportContactCounts(reportId) {
  const counts = { email: 0, phone: 0 };
  try {
    const { data, error } = await sb.rpc('get_report_contact_counts', { p_report_id: reportId });
    if (error) throw error;
    (data || []).forEach(row => {
      if (row.contact_type === 'email' || row.contact_type === 'phone') counts[row.contact_type] = Number(row.cnt) || 0;
    });
  } catch (err) {
    console.error('Failed to load contact counts:', err.message);
  }
  return counts;
}

function renderContactCountsHtml(counts) {
  return `
    <span class="contact-count-chip" title="${t('contactCountsEmailLabel')}"><img class="detail-row-icon" src="icons/email.png" alt="${t('contactCountsEmailLabel')}">${counts.email}</span>
    <span class="contact-count-chip" title="${t('contactCountsPhoneLabel')}"><img class="detail-row-icon" src="icons/phone.png" alt="${t('contactCountsPhoneLabel')}">${counts.phone}</span>
  `;
}

async function loadReportContactCounts(reportId) {
  const counts = await getReportContactCounts(reportId);
  const el = document.getElementById('detailContactCountsContainer');
  const modal = document.getElementById('reportDetailModal');
  if (!el || !modal || modal.dataset.openReportId !== reportId) return;
  el.innerHTML = renderContactCountsHtml(counts);
  updateContactNudge(reportId, counts);
}

function updateContactNudge(reportId, counts) {
  const nudgeEl = document.getElementById('detailContactNudge');
  if (!nudgeEl) return;
  const report = globalActiveData.find(r => r.id === reportId);
  const isOwner = !!(currentSession && report && report.owner_id === currentSession.user.id);
  const notContactedYet = counts.email === 0 && counts.phone === 0;
  const showNudge = isOwner && report && report.status !== 'fixed' && notContactedYet;
  nudgeEl.innerHTML = showNudge ? `<div class="contact-nudge">${t('contactNudgeText')}</div>` : '';
}

function refreshReportContactCounts(reportId) {
  const modal = document.getElementById('reportDetailModal');
  if (modal && modal.style.display !== 'none' && modal.dataset.openReportId === reportId) {
    loadReportContactCounts(reportId);
  }
}

const NEARBY_CHECKIN_RADIUS_M = 30;

const NEARBY_CHECKIN_RADIUS_M_DRIVING = 55;

const NEARBY_CHECKIN_DRIVING_HEADING_TOLERANCE_DEG = 70;
const NEARBY_CHECKIN_SCAN_THROTTLE_MS = 15000;

const DRIVING_CHECKIN_CATEGORIES = new Set(['Road']);
const NEARBY_CHECKIN_STORAGE_KEY = 'ttb_nearby_checkin_freq';
const NEARBY_CHECKIN_GLOBAL_KEY = 'ttb_nearby_checkin_last_global';
const NEARBY_CHECKIN_HISTORY_KEY = 'ttb_nearby_checkin_history';
const NEARBY_CHECKIN_HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const NEARBY_CHECKIN_COOLDOWNS = {
  off:    null,
  low:    { global: 4  * 60 * 60 * 1000, perReport: 14 * 24 * 60 * 60 * 1000 },
  normal: { global: 1  * 60 * 60 * 1000, perReport: 3  * 24 * 60 * 60 * 1000 },
  high:   { global: 10 * 60 * 1000,      perReport: 1  * 24 * 60 * 60 * 1000 }
};

function getNearbyCheckinFreqPref() {
  try {
    const v = localStorage.getItem(NEARBY_CHECKIN_STORAGE_KEY);
    return (v === 'off' || v === 'low' || v === 'normal' || v === 'high') ? v : 'normal';
  } catch (err) {
    return 'normal';
  }
}
let nearbyCheckinFreq = getNearbyCheckinFreqPref();
let nearbyCheckinModalOpen = false;
let lastNearbyCheckinScanAt = 0;

function updateNearbyCheckinSegmentUI() {
  ['Off', 'Low', 'Normal', 'High'].forEach(label => {
    const btn = document.getElementById('nearbyCheckinBtn' + label);
    if (btn) btn.classList.toggle('active', nearbyCheckinFreq === label.toLowerCase());
  });
}

function setNearbyCheckinFreq(freq) {
  nearbyCheckinFreq = freq;
  try { localStorage.setItem(NEARBY_CHECKIN_STORAGE_KEY, freq); } catch (err) {}
  updateNearbyCheckinSegmentUI();
}

const CONTACT_REMINDER_FREQ_KEY = 'ttb_contact_reminder_freq';
const CONTACT_REMINDER_LAST_SHOWN_KEY = 'ttb_contact_reminder_last_shown';
const CONTACT_REMINDER_FREQ_DAYS = { off: 0, weekly: 7, biweekly: 14, monthly: 30 };

function getContactReminderFreqPref() {
  try {
    const v = localStorage.getItem(CONTACT_REMINDER_FREQ_KEY);
    return CONTACT_REMINDER_FREQ_DAYS.hasOwnProperty(v) ? v : 'weekly';
  } catch (err) {
    return 'weekly';
  }
}
let contactReminderFreq = getContactReminderFreqPref();

function updateContactReminderSegmentUI() {
  ['Off', 'Weekly', 'Biweekly', 'Monthly'].forEach(label => {
    const btn = document.getElementById('contactReminderBtn' + label);
    if (btn) btn.classList.toggle('active', contactReminderFreq === label.toLowerCase());
  });
}

function setContactReminderFreq(freq) {
  contactReminderFreq = freq;
  try { localStorage.setItem(CONTACT_REMINDER_FREQ_KEY, freq); } catch (err) {}
  updateContactReminderSegmentUI();
}

function contactReminderDueNow() {
  const days = CONTACT_REMINDER_FREQ_DAYS[contactReminderFreq] || 0;
  if (!days) return false;
  let lastShown = 0;
  try { lastShown = Number(localStorage.getItem(CONTACT_REMINDER_LAST_SHOWN_KEY)) || 0; } catch (err) {}
  return (Date.now() - lastShown) >= days * 24 * 60 * 60 * 1000;
}

function markContactReminderShown() {
  try { localStorage.setItem(CONTACT_REMINDER_LAST_SHOWN_KEY, String(Date.now())); } catch (err) {}
}

async function checkContactReminders() {
  if (!currentSession || !currentProfile) return;
  if (!contactReminderDueNow()) return;
  try {
    const { data: myOpenReports, error } = await sb.from(TABLE)
      .select('id, category, subcategory, comment, created_at')
      .eq('owner_id', currentSession.user.id)
      .neq('status', 'fixed')
      .order('created_at', { ascending: true });
    if (error) throw error;
    if (!myOpenReports || !myOpenReports.length) { markContactReminderShown(); return; }

    const ids = myOpenReports.map(r => r.id);
    const { data: contactRows, error: contactErr } = await sb.from(REPORT_CONTACT_EVENTS_TABLE)
      .select('report_id').in('report_id', ids);
    if (contactErr) throw contactErr;
    const contactedIds = new Set((contactRows || []).map(r => r.report_id));

    const uncontacted = myOpenReports.filter(r => !contactedIds.has(r.id));
    markContactReminderShown();
    if (uncontacted.length) showContactReminderModal(uncontacted);
  } catch (err) {
    console.error('Failed to check contact reminders:', err.message || err);
  }
}

function showContactReminderModal(reports) {
  document.getElementById('contactReminderModalTitle').textContent = t('contactReminderModalTitle');
  document.getElementById('contactReminderIntroText').textContent =
    (t('contactReminderIntroText') || '').replace('{n}', reports.length);
  const listEl = document.getElementById('contactReminderList');
  listEl.innerHTML = reports.map(r => {
    const dateStr = new Date(r.created_at).toLocaleDateString(isSerbianLang() ? 'sr-RS' : 'en-GB');
    const label = r.comment ? escapeHtml(r.comment) : translateCategory(r.category);
    return `
    <div class="detail-row" style="cursor:pointer;" onclick="openReportFromContactReminder('${r.id}')">
      <span class="detail-row-label"><span class="cat-filter-dot" style="background:${categoryColor(r.category)};display:inline-block;margin-right:6px;"></span>${label}</span>
      <span class="detail-row-value">${dateStr}</span>
    </div>`;
  }).join('');
  document.getElementById('contactReminderSnoozeBtn').textContent = t('contactReminderSnoozeBtn');
  document.getElementById('contactReminderSettingsBtn').textContent = t('contactReminderSettingsBtn');
  const modal = document.getElementById('contactReminderModal');
  bringModalToFront(modal);
  modal.style.display = 'flex';
  openOverlay('contactReminderModal', closeContactReminderModal);
}
function closeContactReminderModal() {
  document.getElementById('contactReminderModal').style.display = 'none';
  closeOverlay('contactReminderModal');
}
function openReportFromContactReminder(reportId) {
  closeContactReminderModal();
  ensureReportLoadedThenShow(reportId);
}
function snoozeContactReminders() {

  try { localStorage.setItem(CONTACT_REMINDER_LAST_SHOWN_KEY, String(Date.now() - (CONTACT_REMINDER_FREQ_DAYS[contactReminderFreq] - 1) * 24 * 60 * 60 * 1000)); } catch (err) {}
  closeContactReminderModal();
}
function openContactReminderSettings() {
  closeContactReminderModal();
  showSettingsModal();
}

function readNearbyCheckinHistory() {
  let history = {};
  try { history = JSON.parse(localStorage.getItem(NEARBY_CHECKIN_HISTORY_KEY) || '{}'); } catch (err) { history = {}; }
  const cutoff = Date.now() - NEARBY_CHECKIN_HISTORY_MAX_AGE_MS;
  Object.keys(history).forEach(id => { if (history[id] < cutoff) delete history[id]; });
  return history;
}

function maybeShowNearbyCheckin() {
  if (nearbyCheckinModalOpen) return;

  if (overlayStack.some(o => o.key !== 'drivingMode')) return;
  if (!currentSession || !userCoords) return;
  const cooldown = NEARBY_CHECKIN_COOLDOWNS[nearbyCheckinFreq];
  if (!cooldown) return;

  const now = Date.now();
  if (now - lastNearbyCheckinScanAt < NEARBY_CHECKIN_SCAN_THROTTLE_MS) return;
  lastNearbyCheckinScanAt = now;

  let lastGlobal = 0;
  try { lastGlobal = Number(localStorage.getItem(NEARBY_CHECKIN_GLOBAL_KEY)) || 0; } catch (err) {}
  if (now - lastGlobal < cooldown.global) return;

  const history = readNearbyCheckinHistory();
  const activeRadius = drivingMode ? NEARBY_CHECKIN_RADIUS_M_DRIVING : NEARBY_CHECKIN_RADIUS_M;
  const candidate = globalActiveData
    .filter(r => r.status === 'reported' && isValidLatLng(r.latitude, r.longitude) && (!currentSession || r.owner_id !== currentSession.user.id))
    .filter(r => !drivingMode || DRIVING_CHECKIN_CATEGORIES.has(r.category))
    .map(r => ({ r, d: distMeters(userCoords, { lat: r.latitude, lon: r.longitude }) }))
    .filter(x => x.d <= activeRadius && (now - (history[x.r.id] || 0)) >= cooldown.perReport)

    .filter(x => {
      if (!drivingMode || typeof currentHeading !== 'number' || isNaN(currentHeading)) return true;
      const bearingToReport = bearingBetween(userCoords, { lat: x.r.latitude, lon: x.r.longitude });
      return Math.abs(shortestAngleDelta(currentHeading, bearingToReport)) <= NEARBY_CHECKIN_DRIVING_HEADING_TOLERANCE_DEG;
    })
    .sort((a, b) => a.d - b.d)[0];
  if (!candidate) return;

  history[candidate.r.id] = now;
  try {
    localStorage.setItem(NEARBY_CHECKIN_HISTORY_KEY, JSON.stringify(history));
    localStorage.setItem(NEARBY_CHECKIN_GLOBAL_KEY, String(now));
  } catch (err) {}

  showNearbyCheckinModal(candidate.r);
}

function showNearbyCheckinModal(report) {
  const modal = document.getElementById('nearbyCheckinModal');
  if (!modal) return;
  nearbyCheckinModalOpen = true;
  renderNearbyCheckinStepStill(report);
  bringModalToFront(modal);
  modal.style.display = 'flex';
  openOverlay('nearbyCheckinModal', hideNearbyCheckinModal);
}

function hideNearbyCheckinModal() {
  nearbyCheckinModalOpen = false;
  const modal = document.getElementById('nearbyCheckinModal');
  if (modal) modal.style.display = 'none';
  closeOverlay('nearbyCheckinModal');
}

function renderNearbyCheckinStepStill(report) {
  const inner = document.getElementById('nearbyCheckinModalInner');
  if (!inner) return;
  const issueTitle = report.subcategory
    ? `${translateCategory(report.category)} / ${subcategoryLabel(report.category, report.subcategory)}`
    : translateCategory(report.category);
  const question = t('nearbyCheckinQuestion').replace('{issue}', issueTitle);
  inner.innerHTML = `
    <div class="generic-modal-icon"><img class="icon-img icon-img-modal" src="icons/pin.png" alt=""></div>
    <h2>${t('nearbyCheckinTitle')}</h2>
    <p>${escapeHtml(question)}</p>
    <div style="display:flex;flex-direction:column;gap:var(--space-8);">
      <button type="button" style="background:var(--accent);color:white;border:none;border-radius:14px;padding:12px 20px;font-size:var(--fs-14);font-weight:var(--fw-semibold);cursor:pointer;min-height:44px;" onclick="nearbyCheckinStillBroken('${report.id}')">${t('nearbyCheckinStillBrokenBtn')}</button>
      <button type="button" class="settings-btn" onclick="nearbyCheckinLooksFixed('${report.id}')">${t('nearbyCheckinLooksFixedBtn')}</button>
      <button type="button" class="settings-btn" style="background:transparent;box-shadow:none;" onclick="hideNearbyCheckinModal()">${t('nearbyCheckinDismissBtn')}</button>
    </div>
  `;
}

function renderNearbyCheckinStepContact(report) {
  const inner = document.getElementById('nearbyCheckinModalInner');
  if (!inner) return;
  inner.innerHTML = `
    <div class="generic-modal-icon"><img class="icon-img icon-img-modal" src="icons/phone.png" alt=""></div>
    <h2>${t('nearbyCheckinContactTitle')}</h2>
    <p>${t('nearbyCheckinContactQuestion')}</p>
    <div style="display:flex;gap:var(--space-8);">
      <button type="button" class="settings-btn" style="flex:1;" onclick="hideNearbyCheckinModal()">${t('contactConfirmNoBtn')}</button>
      <button type="button" style="background:var(--accent);color:white;flex:1;border:none;border-radius:14px;padding:12px 20px;font-size:var(--fs-14);font-weight:var(--fw-semibold);cursor:pointer;min-height:44px;" onclick="nearbyCheckinOpenContacts('${report.id}')">${t('nearbyCheckinContactYesBtn')}</button>
    </div>
  `;
}

function nearbyCheckinStillBroken(reportId) {
  const report = globalActiveData.find(r => r.id === reportId);
  castStatusVote(reportId, 'reported');

  if (drivingMode) { hideNearbyCheckinModal(); return; }
  if (report) renderNearbyCheckinStepContact(report);
  else hideNearbyCheckinModal();
}

function nearbyCheckinLooksFixed(reportId) {
  hideNearbyCheckinModal();
  castStatusVote(reportId, 'fixed');
}

function nearbyCheckinOpenContacts(reportId) {
  hideNearbyCheckinModal();
  showReportDetailModal(reportId);
}

function hideReportDetailModal() {
  const modal = document.getElementById('reportDetailModal');
  modal.style.display = 'none';
  delete modal.dataset.openReportId;
  closeOverlay('reportDetailModal');
}

function viewLocationOnMap(lat, lon) {
  if (!isValidLatLng(lat, lon)) return;
  hideReportDetailModal();
  map.closePopup();
  map.setView([lat, lon], Math.max(map.getZoom(), 17), { animate: true });
}

function reportShareUrl(reportId) {
  return `${window.location.origin}${window.location.pathname}?report=${encodeURIComponent(reportId)}`;
}

async function shareReport(reportId) {
  const report = globalActiveData.find(r => r.id === reportId);
  if (!report) return;

  const url = reportShareUrl(reportId);
  const headerTitle = report.subcategory
    ? `${translateCategory(report.category)} / ${subcategoryLabel(report.category, report.subcategory)}`
    : translateCategory(report.category);
  const text = t('shareText').replace('{category}', headerTitle);

  if (navigator.share) {
    try {
      await navigator.share({ title: 'TraceTheBreak', text, url });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      console.warn('navigator.share failed, falling back to clipboard:', err.message);
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast(t('shareLinkCopied'), 'success');
  } catch (err) {
    console.error('Clipboard write failed:', err.message);
    await themedPrompt(t('copyLinkPrompt'), url, { cancelLabel: null, okLabel: 'OK' });
  }
}

// Dedicated "just copy the link" button (as opposed to shareReport, which
// opens the native share sheet when available) — same copy→check→copy icon
// swap as copyReportIdToClipboard, no toast.
let reportLinkCopyIconRevertTimer = null;
async function copyReportLinkToClipboard(reportId) {
  const url = reportShareUrl(reportId);
  try {
    await navigator.clipboard.writeText(url);
    const icon = document.getElementById('reportDetailCopyLinkIcon');
    if (icon) {
      icon.src = 'icons/check.png';
      clearTimeout(reportLinkCopyIconRevertTimer);
      reportLinkCopyIconRevertTimer = setTimeout(() => { icon.src = 'icons/copy.png'; }, 5000);
    }
  } catch (err) {
    console.error('Clipboard write failed:', err.message);
    await themedPrompt(t('copyLinkPrompt'), url, { cancelLabel: null, okLabel: 'OK' });
  }
}

// Click/tap (or Enter/Space via keyboard) on the report-ID line in the
// detail header copies the raw report UUID — handy for support requests,
// admin lookups, cross-referencing with the utility-notify PDFs, etc.
// Tracks the pending revert timer so rapid repeat clicks reset the
// 5-second window instead of stacking multiple timers.
let reportIdCopyIconRevertTimer = null;
async function copyReportIdToClipboard(id) {
  try {
    await navigator.clipboard.writeText(id);
    const icon = document.getElementById('reportDetailIdCopyIcon');
    if (icon) {
      icon.src = 'icons/check.png';
      clearTimeout(reportIdCopyIconRevertTimer);
      reportIdCopyIconRevertTimer = setTimeout(() => { icon.src = 'icons/copy.png'; }, 5000);
    }
  } catch (err) {
    console.error('Clipboard write failed:', err.message);
    await themedPrompt(t('copyReportIdPrompt'), id, { cancelLabel: null, okLabel: 'OK' });
  }
}

function lonLatToTile(lat, lon, zoom) {
  const latRad = (lat * Math.PI) / 180;
  const n = Math.pow(2, zoom);
  const x = (lon + 180) / 360 * n;
  const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  return { x, y, z: zoom };
}

function loadImageSafe(src, crossOrigin) {
  return new Promise(resolve => {
    const img = new Image();
    if (crossOrigin) img.crossOrigin = crossOrigin;
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

async function drawReportCardMapThumb(ctx, x, y, w, h, lat, lon) {
  const zoom = 15;
  const tile = lonLatToTile(lat, lon, zoom);
  const tx = Math.floor(tile.x);
  const ty = Math.floor(tile.y);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  try {
    const img = await loadImageSafe(`https://tile.openstreetmap.org/${zoom}/${tx}/${ty}.png`, 'anonymous');
    if (img) {
      const fracX = tile.x - tx;
      const fracY = tile.y - ty;
      const drawSize = Math.max(w, h) * 1.4;
      ctx.drawImage(img, x + w / 2 - fracX * drawSize, y + h / 2 - fracY * drawSize, drawSize, drawSize);
    } else {
      throw new Error('tile-load-failed');
    }
  } catch (err) {
    ctx.fillStyle = '#dde3e8';
    ctx.fillRect(x, y, w, h);
  }
  ctx.restore();

  const cx = x + w / 2, cy = y + h / 2;
  ctx.fillStyle = '#ff4b4b';
  ctx.beginPath();
  ctx.arc(cx, cy - 6, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - 7, cy - 1);
  ctx.lineTo(cx + 7, cy - 1);
  ctx.lineTo(cx, cy + 12);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,.35)';
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
}

function wrapCanvasText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = String(text).split(' ');
  let line = '';
  let curY = y;
  words.forEach(word => {
    const test = line ? line + ' ' + word : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, curY);
      line = word;
      curY += lineHeight;
    } else {
      line = test;
    }
  });
  if (line) ctx.fillText(line, x, curY);
  return curY;
}

async function buildReportCardCanvas(reportId) {
  const report = globalActiveData.find(r => r.id === reportId);
  if (!report) return null;

  const W = 900, PAD = 36;
  const headerTitle = report.subcategory
    ? `${translateCategory(report.category)} / ${subcategoryLabel(report.category, report.subcategory)}`
    : translateCategory(report.category);
  const catCol = categoryColor(report.category);
  const sCol = statusColor(report.status);

  const hasApprovedPhoto = !!report.photo_path && report.photo_status === 'approved';
  let photoImg = null;
  if (hasApprovedPhoto) {
    const url = await getReportPhotoSignedUrl(report.photo_path);
    if (url) photoImg = await loadImageSafe(url, 'anonymous');
  }

  const photoH = photoImg ? Math.round(W * 0.55) : 0;
  const mapH = 220;
  const H = 210 + photoH + mapH + 170;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#111417';
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = catCol;
  ctx.fillRect(0, 0, W, 120);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 34px sans-serif';
  ctx.textBaseline = 'alphabetic';
  wrapCanvasText(ctx, headerTitle, PAD, 60, W - PAD * 2, 40);
  ctx.font = '18px sans-serif';
  ctx.globalAlpha = 0.9;
  ctx.fillText(formatDate(report.created_at), PAD, 100);
  ctx.globalAlpha = 1;

  let cursorY = 120;
  if (photoImg) {
    const scale = Math.max(W / photoImg.width, photoH / photoImg.height);
    const dw = photoImg.width * scale, dh = photoImg.height * scale;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, cursorY, W, photoH);
    ctx.clip();
    ctx.drawImage(photoImg, W / 2 - dw / 2, cursorY + photoH / 2 - dh / 2, dw, dh);
    ctx.restore();
    cursorY += photoH;
  }

  if (isValidLatLng(report.latitude, report.longitude)) {
    await drawReportCardMapThumb(ctx, PAD, cursorY + 24, W - PAD * 2, mapH, report.latitude, report.longitude);
    cursorY += mapH + 24;
  }

  cursorY += 40;
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 22px sans-serif';
  ctx.fillText(t('popupStatus') + ':', PAD, cursorY);
  const statusText = statusLabel(report.status);
  const statusTextW = ctx.measureText(' ' + statusText).width;
  ctx.fillStyle = sCol;
  roundRectPath(ctx, PAD + ctx.measureText(t('popupStatus') + ': ').width, cursorY - 26, statusTextW + 16, 34, 8);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillText(statusText, PAD + ctx.measureText(t('popupStatus') + ': ').width + 8, cursorY);

  cursorY += 46;
  ctx.font = '18px sans-serif';
  ctx.globalAlpha = 0.85;
  ctx.fillText('TraceTheBreak · ' + t('detailCoordsLabel') + ': ' + report.latitude.toFixed(5) + ', ' + report.longitude.toFixed(5), PAD, cursorY);
  ctx.globalAlpha = 1;

  return canvas;
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

async function shareReportImage(reportId) {
  const btn = document.getElementById('reportDetailShareImageBtn');
  if (btn) btn.disabled = true;
  toast(t('shareImageGenerating'), 'success');
  try {
    const canvas = await buildReportCardCanvas(reportId);
    if (!canvas) throw new Error('no-canvas');
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('toBlob-failed');

    const file = new File([blob], `tracethebreak-${reportId}.png`, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'TraceTheBreak' });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        console.warn('navigator.share (image) failed, falling back to download:', err.message);
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tracethebreak-${reportId}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast(t('shareImageSaved'), 'success');
  } catch (err) {
    console.error('Failed to build/share report card image:', err.message || err);
    toast(t('shareImageFailed'), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function openSharedReportFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const reportId = params.get('report');
  if (!reportId) return;
  // Without this, a shared link can open the detail modal (which calls
  // t() all over) before initLang() has finished fetching languages/*.json
  // — t() then has nothing to look up and falls back to returning the raw
  // key, so the whole modal renders as literal strings like "priorityLabel"
  // instead of translated text. Every other entry point into the modal
  // happens later, after user interaction, by which point initLang() has
  // long since resolved — this deep link is the one path that can win the
  // race, so it's the one that needs to explicitly wait.
  await langReady;
  try {
    const { data, error } = await sb.from(TABLE).select('*').eq('id', reportId).single();
    if (error || !data) throw (error || new Error('Report not found'));
    if (!globalActiveData.some(r => r.id === data.id)) { globalActiveData.push(data); markActiveDataChanged(); }
    if (isValidLatLng(data.latitude, data.longitude)) {
      map.setView([data.latitude, data.longitude], Math.max(map.getZoom(), 16), { animate: false });
    }
    await showReportDetailModal(data.id);
  } catch (err) {
    console.error('Shared report lookup failed:', err.message || err);
    toast(t('shareReportNotFound'), 'error');
  }
}

async function emailReport(reportId) {
  const report = globalActiveData.find(r => r.id === reportId);
  if (!report) return;

  const btn = document.getElementById('reportDetailExportBtn');
  const originalLabel = btn ? btn.innerHTML : '';
  if (btn) btn.disabled = true;

  try {
    const street = document.getElementById('detailStreetValue')?.textContent || t('detailUnknown');
    const area = document.getElementById('detailAreaValue')?.textContent || t('detailUnknown');
    const muniText = document.getElementById('detailMunicipalityValue')?.textContent || t('detailUnknown');

    const muni = await resolveReportMunicipality(report);
    const contacts = muni ? await getReportContacts(report, muni) : [];
    const toEmails = contacts.flatMap(c => contactEntries(c.email).map(e => e.value)).filter(Boolean).join(',');

    // The preset text goes in the language of the *recipient's* country
    // (their municipality's country_code), not the reporting user's own UI
    // language — reusing the same languages/<code>.json files the UI
    // already loads, via t()'s langOverride param.
    const emailLang = utilityLangFor(muni);
    const emailHeaderTitle = report.subcategory
      ? `${translateCategory(report.category, emailLang)} / ${subcategoryLabel(report.category, report.subcategory, emailLang)}`
      : translateCategory(report.category, emailLang);

    const shareUrl = reportShareUrl(report.id);
    const subject = encodeURIComponent(emailHeaderTitle);
    const bodyLines = [
      t('emailGreeting', emailLang),
      '',
      t('emailIssueReportedLine', emailLang).replace('{title}', emailHeaderTitle),
      '',
      `${boldText(t('popupStatus', emailLang))}: ${statusLabel(report.status, emailLang)}`,
      `${boldText(t('priorityLabel', emailLang))}: ${priorityLabelText(report.priority, emailLang)}`,
      `${boldText(t('emailReportedOnLabel', emailLang))}: ${formatDate(report.created_at)}`,
      '',
      `${boldText(t('detailStreetLabel', emailLang))}: ${street}`,
      `${boldText(t('detailAreaLabel', emailLang))}: ${area}`,
      `${boldText(t('detailMunicipalityLabel', emailLang))}: ${muniText}`,
      `${boldText(t('detailCoordsLabel', emailLang))}: ${report.latitude.toFixed(6)}, ${report.longitude.toFixed(6)}`,
      ...(report.comment ? ['', `${boldText(t('emailDescriptionLabel', emailLang))}: ${report.comment}`] : []),
      '',
      t('emailFullReportLine', emailLang).replace('{url}', shareUrl),
      '',
      t('emailThankYou', emailLang),
      t('emailSignature', emailLang),
      '',
      t('emailWrongRecipientNote', emailLang),
    ];
    const body = encodeURIComponent(bodyLines.join('\n'));
    if (toEmails) recordContactAttempt(reportId, 'email', null);
    window.location.href = `mailto:${toEmails}?subject=${subject}&body=${body}`;
  } catch (err) {
    console.error('emailReport error:', err.message || err);
    toast(t('detailExportFailed'), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = originalLabel; }
  }
}

function slugifyForFilename(str) {
  return String(str || 'company')
    .replace(/đ/g, 'dj').replace(/Đ/g, 'Dj')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'company';
}

async function imageUrlToDataURL(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('fetch-failed');
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('read-failed'));
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64, mimeType) {
  const byteChars = atob(base64);
  const chunkSize = 0x8000;
  const chunks = [];
  for (let i = 0; i < byteChars.length; i += chunkSize) {
    const slice = byteChars.slice(i, i + chunkSize);
    const bytes = new Uint8Array(slice.length);
    for (let j = 0; j < slice.length; j++) bytes[j] = slice.charCodeAt(j);
    chunks.push(bytes);
  }
  return new Blob(chunks, { type: mimeType });
}

async function exportCompanyReportsPdf(companyId) {
  const c = utilityCompanyRegistry.get(String(companyId));
  if (!c) return;

  const muni = c.municipality_id != null ? getMunicipalityById(c.municipality_id) : null;
  const muniName = muni ? municipalityDisplayName(muni) : t('unknownMunicipalityLower');
  const confirmed = await themedConfirm(
    t('companyPdfExportConfirm').replace('{municipality}', muniName).replace('{name}', c.name || '')
  );
  if (!confirmed) return;

  const btn = document.getElementById('companyPdfBtn-' + companyId);
  if (btn) btn.disabled = true;
  toast(t('companyPdfGenerating'), 'success');

  try {
    const { data, error } = await sb.functions.invoke('weekly-utility-digest', {
      body: { companyId: String(companyId) }
    });
    if (error) throw error;

    const result = (data.results || [])[0];
    if (!result || result.status === 'skipped' || !result.pdfBase64) {
      toast(t('companyPdfNoReports'), 'error');
      return;
    }

    const blob = base64ToBlob(result.pdfBase64, 'application/pdf');
    const fileName = `${slugifyForFilename(c.name)}-reports.pdf`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileName;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast(t('companyPdfDownloaded'), 'success');
  } catch (err) {
    console.error('exportCompanyReportsPdf error:', err.message || err);
    toast(t('companyPdfFailed'), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// "Sent to company" (and, if it happened later, the reminder) as raw
// {time, html} entries for the timeline's extras merge — same dot/date
// layout as the pipeline stages, plain text on the right instead of a
// status pill. Returns [] if it was never sent yet; that's still surfaced
// via the contacts section, just not as a timeline entry until it happens.
function companyNotifyTimelineEvents(report) {
  if (!report.company_notified_at) return [];
  const events = [{ time: report.company_notified_at, html: buildTimelineExtraItem(report.company_notified_at, `<span class="timeline-note">${t('companyNotifyLabel')}</span><img class="detail-row-icon" src="icons/email-sent.png" alt="">`) }];
  const showsReminder = report.company_last_notified_at && report.company_last_notified_at !== report.company_notified_at;
  if (showsReminder) {
    events.push({ time: report.company_last_notified_at, html: buildTimelineExtraItem(report.company_last_notified_at, `<span class="timeline-note">${t('companyLastReminderLabel')}</span><img class="detail-row-icon" src="icons/email-resent.png" alt="">`) });
  }
  return events;
}

function buildDetailStatusReadonlyHtml(report, reporterName) {
  const isAdmin = !!(currentProfile && currentProfile.is_admin);
  const isOwner = !!(currentSession && report.owner_id === currentSession.user.id);

  const hasFullPower = hasFullPowerOverReport(report) || (isAdmin && isOwner);

  // Once a report has actually gone out to the responsible utility company,
  // an owner can no longer pull it — only someone with full power (admin
  // authority over the report's area) can still remove it after that point.
  const wasSentToCompany = !!report.company_notified_at;
  const canDelete = hasFullPower || (isOwner && !wasSentToCompany);
  const canAddPhotoInline = !!currentSession && report.status !== 'fixed' && (
    (isOwner && (!report.photo_path || report.photo_status === 'rejected')) ||
    isAdmin
  );
  const addPhotoBtnHtml = canAddPhotoInline
    ? `<button type="button" class="icon-only-btn" onclick="addPhotoToReport('${report.id}')" aria-label="${t('addPhotoTooltip')}" title="${t('addPhotoTooltip')}"><img class="icon-img" src="icons/camera.png" alt=""></button>`
    : '';
  const noteRowHtml = (report.comment || canAddPhotoInline)
    ? `<div class="popup-note-row" style="margin-top:10px;">${report.comment ? `<div class="popup-note popup-note-full">${escapeHtml(report.comment)}</div>` : '<div style="flex:1 1 auto;"></div>'}${addPhotoBtnHtml}</div>`
    : '';
  const personalResolveHtml = (() => {
    if (hasFullPower || !isOwner || report.status === 'fixed') return '';
    if (reportIsPersonalProblem(report)) {

      const statuses = [
        { key: 'in_progress', label: t('markInProgress'), bg: STATUS_COLORS.in_progress },
        { key: 'fixed',       label: t('markFixed'),      bg: STATUS_COLORS.fixed }
      ].filter(s => s.key !== report.status && !(s.key === 'in_progress' && categorySkipsInProgress(report.category)));
      if (!statuses.length) return '';
      return `<div class="status-action-row">
        ${statuses.map(s => `<button class="status-action-btn" style="background:${s.bg};" onclick="resolvePersonalReportFromDetail('${report.id}','${s.key}')">${s.label}</button>`).join('')}
      </div>
      <div class="popup-personal-note">${t('personalProblemOwnerNote')}</div>`;
    }

    if (report.status === 'reported' && !categorySkipsInProgress(report.category)) {
      return `<div class="status-action-row">
        <button class="status-action-btn" style="background:${STATUS_COLORS.in_progress};" onclick="resolvePersonalReportFromDetail('${report.id}','in_progress')">${t('markInProgress')}</button>
      </div>
      <div class="popup-personal-note">${t('ownerInProgressNote')}</div>`;
    }
    return '';
  })();
  return `
    <div class="detail-section-title-row">
      <div class="detail-section-title">${t('popupStatus')}</div>
      ${hasFullPower ? `<div class="detail-edit-actions">
        <button type="button" class="detail-edit-btn" onclick="enterReportDetailEditMode('${report.id}')"><img class="icon-img" src="icons/edit.png" alt="">${t('editBtn')}</button>
        <button type="button" class="detail-delete-btn" onclick="deleteReport('${report.id}', false)"><img class="icon-img" src="icons/reports/waste.png" alt="">${t('deleteBtn')}</button>
      </div>` : (canDelete ? `<div class="detail-edit-actions">
        <button type="button" class="detail-delete-btn" onclick="deleteReport('${report.id}')"><img class="icon-img" src="icons/reports/waste.png" alt="">${t('deleteBtn')}</button>
      </div>` : '')}
    </div>
    <div class="detail-location-row">
      <div class="detail-location-label">${t('detailLocationTitle')}</div>
      <a href="javascript:void(0)" class="detail-location-link" onclick="viewLocationOnMap(${report.latitude}, ${report.longitude})">
        <span id="detailStreetValue">${t('detailLoading')}</span>, <span id="detailAreaValue">${t('detailLoading')}</span>, <span id="detailMunicipalityValue">${t('detailLoading')}</span>
      </a>
    </div>
    <div class="detail-row"><span class="detail-row-label">${t('priorityLabel')}</span><span class="status-pill" style="background:${priorityColor(report.priority)};">${priorityLabelText(report.priority)}</span></div>
    <div class="detail-row"><span class="detail-row-label">${t('reportedByLabel')}</span><span class="detail-row-value">${escapeHtml(reporterName)}</span>${reporterBanControlHtml(report)}</div>
    ${(() => { const g = duplicateGroupFor(report.id); return g ? `<div class="detail-row"><span class="detail-row-label"><img class="row-check-icon" src="icons/check.png" alt=""></span><span class="detail-row-value">${t('confirmedByLabel').replace('{n}', g.count)}</span></div>` : ''; })()}
    ${personalResolveHtml}
    <div class="popup-timeline" id="detailTimeline-${report.id}" style="margin-top:8px;">
      ${buildTimelineItem(report.created_at, true, STATUS_COLORS.reported, buildPipelineStageLabel('reported', report, true))}
      ${(!categorySkipsInProgress(report.category) && report.in_progress_at) ? buildTimelineItem(report.in_progress_at, true, STATUS_COLORS.in_progress, buildPipelineStageLabel('in_progress', report, true)) : ''}
      ${report.fixed_at ? buildTimelineItem(report.fixed_at, true, STATUS_COLORS.fixed, buildPipelineStageLabel('fixed', report, true)) : ''}
      <span id="detailTimelineAnchor-${report.id}"></span>
      ${(!categorySkipsInProgress(report.category) && !report.in_progress_at) ? buildTimelineItem(report.in_progress_at, false, STATUS_COLORS.in_progress, buildPipelineStageLabel('in_progress', report, false)) : ''}
      ${!report.fixed_at ? buildTimelineItem(report.fixed_at, false, STATUS_COLORS.fixed, buildPipelineStageLabel('fixed', report, false)) : ''}
    </div>
    ${noteRowHtml}
  `;
}

function buildDetailEditFieldsHtml(report) {
  const cats = ['Water','Electricity','Sewage','Gas','Heating','Road','Streetlight','Waste','Walkways','BikeLanes','GreenSpaces','Parking','Suggestion','Forest','FarmersMarket','Other'];
  const catOptions = cats.map(c => `<option value="${c}" ${c === report.category ? 'selected' : ''}>${translateCategory(c)}</option>`).join('');
  const statuses = [
    { key:'reported', label: statusLabel('reported') },
    { key:'in_progress', label: statusLabel('in_progress') },
    { key:'fixed', label: statusLabel('fixed') }
  ].filter(s => s.key !== 'in_progress' || !categorySkipsInProgress(report.category));
  const statusOptions = statuses.map(s => `<option value="${s.key}" ${s.key === report.status ? 'selected' : ''}>${s.label}</option>`).join('');
  const currentPriority = report.priority || 'normal';
  const priorities = [
    { key:'low',    label: priorityLabelText('low') },
    { key:'normal', label: priorityLabelText('normal') },
    { key:'high',   label: priorityLabelText('high') }
  ];
  const priorityOptions = priorities.map(p => `<option value="${p.key}" ${p.key === currentPriority ? 'selected' : ''}>${p.label}</option>`).join('');

  return `
    <div class="detail-section-title">${t('editTitle')}</div>
    <div class="detail-edit-field">
      <span class="detail-edit-field-label">${t('editCategoryLabel')}</span>
      <select id="detailEditCat-${report.id}" onchange="onDetailEditCategoryChange('${report.id}')">${catOptions}</select>
    </div>
    <div class="detail-edit-field">
      <span class="detail-edit-field-label">${t('editSubcategoryLabel')}</span>
      <select id="detailEditSubcat-${report.id}"></select>
    </div>
    <div class="detail-edit-field">
      <span class="detail-edit-field-label">${t('editStatusLabel')}</span>
      <select id="detailEditStatus-${report.id}">${statusOptions}</select>
    </div>
    <div class="detail-edit-field">
      <span class="detail-edit-field-label">${t('editPriorityLabel')}</span>
      <select id="detailEditPriority-${report.id}">${priorityOptions}</select>
    </div>
    <div class="detail-edit-field">
      <span class="detail-edit-field-label">${t('editCommentLabel')}</span>
      <input type="text" id="detailEditComment-${report.id}" value="${escapeHtml(report.comment || '')}" placeholder="${t('commentPH')}">
    </div>
    <div class="detail-edit-actions-row">
      <button type="button" style="background:var(--accent);color:var(--accent-contrast);" onclick="saveReportDetailEdits('${report.id}')">${t('saveBtn')}</button>
      <button type="button" style="background:var(--bg-surface-alt);color:var(--text-primary);border:1px solid var(--border-color-strong);" onclick="cancelReportDetailEdit('${report.id}')">${t('cancelBtn')}</button>
    </div>
  `;
}

function onDetailEditCategoryChange(reportId) {
  const catSelect = document.getElementById(`detailEditCat-${reportId}`);
  const subSelect = document.getElementById(`detailEditSubcat-${reportId}`);
  if (!catSelect || !subSelect) return;
  populateSubcategoryOptions(subSelect, catSelect.value, null);

  const statusSelect = document.getElementById(`detailEditStatus-${reportId}`);
  if (statusSelect) {
    const currentStatus = statusSelect.value;
    const statuses = [
      { key:'reported', label: statusLabel('reported') },
      { key:'in_progress', label: statusLabel('in_progress') },
      { key:'fixed', label: statusLabel('fixed') }
    ].filter(s => s.key !== 'in_progress' || !categorySkipsInProgress(catSelect.value));
    const nextStatus = statuses.some(s => s.key === currentStatus) ? currentStatus : 'reported';
    statusSelect.innerHTML = statuses.map(s => `<option value="${s.key}" ${s.key === nextStatus ? 'selected' : ''}>${s.label}</option>`).join('');
  }
}

function enterReportDetailEditMode(reportId) {
  const report = globalActiveData.find(r => r.id === reportId);
  const section = document.getElementById('reportDetailStatusSection');
  if (!report || !section) return;
  section.innerHTML = buildDetailEditFieldsHtml(report);
  const subSelect = document.getElementById(`detailEditSubcat-${reportId}`);
  if (subSelect) populateSubcategoryOptions(subSelect, report.category, report.subcategory);
}

function cancelReportDetailEdit(reportId) {
  const report = globalActiveData.find(r => r.id === reportId);
  const section = document.getElementById('reportDetailStatusSection');
  if (!report || !section) return;
  const reporterName = reporterDisplayName(report);
  section.innerHTML = buildDetailStatusReadonlyHtml(report, reporterName);
}

async function saveReportDetailEdits(reportId) {
  const category    = document.getElementById(`detailEditCat-${reportId}`).value;
  const subcatEl     = document.getElementById(`detailEditSubcat-${reportId}`);
  const subcategory  = (subcatEl && subcatEl.value) ? subcatEl.value : null;
  const status       = document.getElementById(`detailEditStatus-${reportId}`).value;
  const priorityEl   = document.getElementById(`detailEditPriority-${reportId}`);
  const priority      = (priorityEl && priorityEl.value) ? priorityEl.value : 'normal';
  const comment       = cyrillicToLatin(document.getElementById(`detailEditComment-${reportId}`).value);
  if (blockIfProfane(comment)) return;
  try {
    const { error } = await sb.from(TABLE)
      .update({ category, subcategory, priority, comment, updated_at: new Date().toISOString(), ...buildStatusPatch(status) })
      .eq('id', reportId);
    if (error) throw error;
    await loadPinsByWindow();

    await showReportDetailModal(reportId);
  } catch (err) {
    console.error('Detail edit save error (full):', err);
    toast(describeAuthError(err), 'error');
  }
}

function buildStatusPatch(newStatus) {
  const now = new Date().toISOString();
  if (newStatus === 'reported')    return { status: 'reported',    in_progress_at: null, fixed_at: null };
  if (newStatus === 'in_progress') return { status: 'in_progress', in_progress_at: now,  fixed_at: null };
  if (newStatus === 'fixed')       return { status: 'fixed',       fixed_at: now };
  return { status: newStatus };
}

async function deleteReport(reportId, askReason = true) {
  let reason = null;
  if (askReason) {
    reason = await pickDeleteReason();
    if (!reason) return; // picker was cancelled — treat as "changed my mind", no delete
  } else {
    if (!(await themedConfirm(t('deleteConfirm')))) return;
  }
  try {
    if (reason && currentSession) {
      const { error: logError } = await sb.from('report_deletion_log').insert({
        report_id: reportId,
        deleted_by: currentSession.user.id,
        reason_code: reason.code,
        reason_text: reason.text || null
      });
      if (logError) console.warn('Failed to log deletion reason (non-fatal):', logError);
    }
    const { error } = await sb.from(TABLE).delete().eq('id', reportId);
    if (error) throw error;
    myReportsCache = null;
    await loadPinsByWindow();
    hideReportDetailModal();
  } catch (err) {
    console.error('Delete error (full):', err);
    toast(describeAuthError(err), 'error');
  }
}

async function resolvePersonalReportFromDetail(reportId, newStatus) {
  await updateReportStatus(reportId, newStatus);
  await showReportDetailModal(reportId);
}

async function updateReportStatus(reportIdOrIds, newStatus) {
  if (!currentSession) return;
  const ids = Array.isArray(reportIdOrIds) ? reportIdOrIds : [reportIdOrIds];
  try {
    let anyConflict = false;
    for (const reportId of ids) {

      const knownReport = globalActiveData.find(r => r.id === reportId);
      const expectedStatus = knownReport ? knownReport.status : null;

      let query = sb.from(TABLE)
        .update({ updated_at: new Date().toISOString(), ...buildStatusPatch(newStatus) })
        .eq('id', reportId);
      if (expectedStatus) query = query.eq('status', expectedStatus);
      const { data, error } = await query.select('id');
      if (error) throw error;

      if (expectedStatus && (!data || data.length === 0)) anyConflict = true;
    }

    if (anyConflict) {

      myReportsCache = null;
      await loadPinsByWindow();
      toast(t('updateConflict'), 'error');
      return;
    }

    myReportsCache = null;
    await loadPinsByWindow();
    if (newStatus === 'fixed') maybeOfferAfterPhoto(ids[0]);
  } catch (err) {
    console.error('Status update error (full):', err);
    toast(t('updateFail'), 'error');
  }
}

async function castStatusVote(reportIdOrIds, suggestedStatus) {
  if (!currentSession || !currentProfile) { toast(t('signInFirst'), 'error'); return; }
  if (!userCoords) { toast(t('waitGps'), 'error'); return; }

  const ids = Array.isArray(reportIdOrIds) ? reportIdOrIds : [reportIdOrIds];
  const isAdmin = !!(currentProfile.is_admin);

  const primaryReport = globalActiveData.find(r => r.id === ids[0]);
  if (!isAdmin && primaryReport && isValidLatLng(primaryReport.latitude, primaryReport.longitude)) {
    const dist = distMeters(userCoords, { lat: primaryReport.latitude, lon: primaryReport.longitude });
    if (dist > VOTE_PROXIMITY_MAX_M) { toast(t('tooFarToVote'), 'error'); return; }
  }

  try {
    let anyResolved = false;
    for (const reportId of ids) {
      const { data, error } = await sb.rpc('cast_status_vote', {
        p_report_id: reportId,
        p_suggested_status: suggestedStatus,
        p_lat: userCoords.lat,
        p_lon: userCoords.lon
      });
      if (error) throw error;

      if (data && data.ok === false && data.reason === 'too_far') {
        toast(t('tooFarToVote'), 'error');
        return;
      }
      if (data && data.resolved) anyResolved = true;
    }

    if (anyResolved) {
      toast('✓ ' + t('voteResolved'), 'success');
      if (suggestedStatus === 'fixed') maybeOfferAfterPhoto(ids[0]);
    } else {
      toast(t('voteRecorded'), 'success');
    }
    await loadProfile();
    await loadPinsByWindow();
  } catch (err) {
    console.error('Vote error (full):', err);
    toast(t('voteFail'), 'error');
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Character-based truncation for the map popup's comment preview -- the CSS
// line-clamp on .popup-note handles typical cases, but this guarantees a
// hard cap regardless of line-clamp browser support, and avoids sending a
// huge wall of text into the DOM for every visible pin. Cuts at the last
// word boundary within range rather than mid-word where reasonable.
function truncateForPopup(text, maxChars) {
  if (!text || text.length <= maxChars) return text;
  let cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > maxChars * 0.6) cut = cut.slice(0, lastSpace);
  return cut.trim() + '…';
}

const BOLD_UNICODE_MAP = (() => {
  const map = {};
  for (let i = 0; i < 26; i++) {
    map[String.fromCharCode(65 + i)] = String.fromCodePoint(0x1D400 + i);
    map[String.fromCharCode(97 + i)] = String.fromCodePoint(0x1D41A + i);
  }
  for (let i = 0; i <= 9; i++) map[String(i)] = String.fromCodePoint(0x1D7CE + i);
  return map;
})();
function boldText(str) {
  return String(str).replace(/[A-Za-z0-9]/g, ch => BOLD_UNICODE_MAP[ch] ?? ch);
}

const CYRILLIC_TO_LATIN_MAP = {
  'А':'A','Б':'B','В':'V','Г':'G','Д':'D','Ђ':'Đ','Е':'E','Ж':'Ž','З':'Z','И':'I',
  'Ј':'J','К':'K','Л':'L','Љ':'Lj','М':'M','Н':'N','Њ':'Nj','О':'O','П':'P','Р':'R',
  'С':'S','Т':'T','Ћ':'Ć','У':'U','Ф':'F','Х':'H','Ц':'C','Ч':'Č','Џ':'Dž','Ш':'Š',
  'а':'a','б':'b','в':'v','г':'g','д':'d','ђ':'đ','е':'e','ж':'ž','з':'z','и':'i',
  'ј':'j','к':'k','л':'l','љ':'lj','м':'m','н':'n','њ':'nj','о':'o','п':'p','р':'r',
  'с':'s','т':'t','ћ':'ć','у':'u','ф':'f','х':'h','ц':'c','ч':'č','џ':'dž','ш':'š'
};

function cyrillicToLatin(str) {
  if (!str) return str;
  return String(str).replace(/[А-Яа-яЂђЈјЉљЊњЋћЏџ]/g, ch => CYRILLIC_TO_LATIN_MAP[ch] ?? ch);
}

const BLOCKED_WORDS = [

  'fuck','shit','bitch','asshole','bastard','cunt','dick','pussy','faggot','nigger','whore','slut',

  'jebem','jebo','jebote','picka','pizda','kurac','kurca','govno','djubre','dzukela','peder',
  'kurvo','kurva','seronja','budalo','idiote','glupane','majmune','svinjo'
];
function normalizeForProfanityCheck(str) {
  return cyrillicToLatin(String(str || ''))
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')

    .replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't')
    .replace(/[^a-z]/g, ' ')
    .replace(/(.)\1{2,}/g, '$1$1');

}
function containsProfanity(str) {
  if (!str) return false;
  const normalized = normalizeForProfanityCheck(str);
  return BLOCKED_WORDS.some(w => normalized.includes(w));
}

function blockIfProfane(str) {
  if (!containsProfanity(str)) return false;
  toast(t('profanityBlocked'), 'error');
  return true;
}

const sectionLineRenderer = L.svg({ tolerance: 32 });

function isSectionReport(report) {
  return sanitizePath(report.path).length > 1;
}

function upsertSectionLine(report) {
  const sCol = statusColor(report.status);
  const opacity = report.status === 'fixed' ? 0.4 : 0.85;
  const path = sanitizePath(report.path);

  let group = markerById.get(report.id);
  if (group) {
    group._visibleLine.setStyle({ color: sCol, opacity });
    group._visibleLine.setLatLngs(path);
    group._hitLine.setLatLngs(path);
    group.setPopupContent(buildPopupHtml(report));
    if (report.status === 'fixed') group.bringToBack(); else group.bringToFront();
    return group;
  }

  const hitLine = L.polyline(path, {
    color: '#000', opacity: 0, weight: 26, lineCap: 'round',
    renderer: sectionLineRenderer, interactive: true
  });
  const visibleLine = L.polyline(path, {
    color: sCol, weight: 6, opacity, lineCap: 'round',
    renderer: sectionLineRenderer, interactive: false
  });

  group = L.featureGroup([hitLine, visibleLine]).addTo(map);
  group._hitLine = hitLine;
  group._visibleLine = visibleLine;
  group._reportId = report.id;
  group.bindPopup(buildPopupHtml(report), { autoPan: false, closeButton: false });
  markerById.set(report.id, group);
  if (report.status === 'fixed') group.bringToBack();
  return group;
}

function buildPinIconHtml(category, subcategory, status, priority, confirmCount) {
  const catCol  = categoryColor(category);
  const sCol    = statusColor(status);
  const iconSrc = subcategoryIcon(category, subcategory) || categoryIcon(category);
  const opacity = status === 'fixed' ? 0.55 : 1;
  const pulseDuration = status === 'reported' ? 1.6 : 2.6;
  const pulseSize = priority === 'high' ? 34 : priority === 'low' ? 20 : 26;
  const pulseDelay = -(Math.random() * pulseDuration).toFixed(2);
  let statusMarker = '';
  if (status !== 'fixed') {
    statusMarker = statusPulseEnabled
      ? `<span class="pin-status-halo" style="background:${sCol};width:${pulseSize}px;height:${pulseSize}px;animation-duration:${pulseDuration}s;animation-delay:${pulseDelay}s;"></span>`
      : `<span class="pin-status-ring" style="border-color:${sCol};"></span>`;
  }
  const confirmBadgeHtml = (confirmCount && confirmCount > 1) ? `<span class="pin-confirm-badge">${confirmCount}</span>` : '';
  return `<div class="pin-upright" style="position:relative;width:40px;height:40px;">` +
    statusMarker +
    `<div class="map-pin-badge" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:${catCol};opacity:${opacity};">` +
    `<span class="map-pin-glyph" style="-webkit-mask-image:url('${iconSrc}');mask-image:url('${iconSrc}');"></span>` +
    `</div>` +
    confirmBadgeHtml +
    `</div>`;
}

function upsertMarker(report) {
  if (isSectionReport(report)) return upsertSectionLine(report);

  if (!isValidLatLng(report.latitude, report.longitude)) {
    console.error('Skipped rendering report with invalid coordinates:', report.id, report.latitude, report.longitude);
    return null;
  }

  const dupGroup = duplicateGroupFor(report.id);
  const confirmCount = dupGroup ? dupGroup.count : 0;
  const iconHtml = buildPinIconHtml(report.category, report.subcategory, report.status, report.priority, confirmCount);
  const zOffset = report.status === 'fixed' ? -1000 : 0;

  let marker = markerById.get(report.id);
  if (marker) {
    marker.setIcon(L.divIcon({ className: '', html: iconHtml, iconSize: [40,40], iconAnchor: [20,20] }));
    marker.setLatLng([report.latitude, report.longitude]);
    marker.setPopupContent(buildPopupHtml(report));
    marker.setZIndexOffset(zOffset);

    if (pinCluster.hasLayer(marker)) pinCluster.refreshClusters(marker);
    return marker;
  }

  marker = L.marker([report.latitude, report.longitude], {
    icon: L.divIcon({ className: '', html: iconHtml, iconSize: [40,40], iconAnchor: [20,20] }),
    zIndexOffset: zOffset
  });

  marker._reportId = report.id;
  marker.bindPopup(buildPopupHtml(report), { autoPan: false, closeButton: false });
  pinCluster.addLayer(marker);
  markerById.set(report.id, marker);
  return marker;
}
function reportInBounds(report, bounds) {
  if (isSectionReport(report)) {
    return sanitizePath(report.path).some(([lat, lon]) => bounds.contains(L.latLng(lat, lon)));
  }
  if (!isValidLatLng(report.latitude, report.longitude)) return false;
  return bounds.contains(L.latLng(report.latitude, report.longitude));
}

const MARKER_SYNC_CHUNK_SIZE = 40;
let markerSyncToken = 0;

function syncMarkers(refreshExisting) {
  recomputeDuplicateGroups();
  const bounds = map.getBounds().pad(0.2);
  const desiredIds = new Set();
  const toUpsert = [];

  globalActiveData.forEach(r => {
    if (!reportInBounds(r, bounds)) return;
    if (!isCategoryVisible(r.category)) return;
    if (!isStatusVisible(r.status)) return;
    const dupGroup = duplicateGroupFor(r.id);
    if (dupGroup && r.id !== dupGroup.primaryId) return;

    desiredIds.add(r.id);
    if (refreshExisting || !markerById.has(r.id)) toUpsert.push(r);
  });

  markerById.forEach((marker, id) => {
    if (!desiredIds.has(id)) {
      removeReportLayer(marker);
      markerById.delete(id);
    }
  });

  sectionPinById.forEach((pin, id) => {
    if (!desiredIds.has(id)) {
      removeReportLayer(pin);
      sectionPinById.delete(id);
    }
  });

  const token = ++markerSyncToken;
  if (!toUpsert.length) {
    hidePinsLoadingPill();
    return;
  }

  if (toUpsert.length > MARKER_SYNC_CHUNK_SIZE * 2) showPinsLoadingPill();

  let i = 0;
  function processNextChunk() {
    if (token !== markerSyncToken) return;

    const slice = toUpsert.slice(i, i + MARKER_SYNC_CHUNK_SIZE);
    slice.forEach(r => upsertMarker(r));
    i += MARKER_SYNC_CHUNK_SIZE;
    if (i < toUpsert.length) {
      requestAnimationFrame(processNextChunk);
    } else {
      hidePinsLoadingPill();
    }
  }
  requestAnimationFrame(processNextChunk);
}

function refreshRenderedPopups() {
  markerById.forEach((marker, id) => {
    const report = globalActiveData.find(r => r.id === id);
    if (report) marker.setPopupContent(buildPopupHtml(report));
  });
  sectionPinById.forEach((pin, id) => {
    const report = globalActiveData.find(r => r.id === id);
    if (report) pin.setPopupContent(buildPopupHtml(report));
  });
}

function updateReportCount() {
  const counts = { reported: 0, in_progress: 0, fixed: 0 };
  globalActiveData.forEach(r => { if (counts.hasOwnProperty(r.status)) counts[r.status]++; });

  const setCount = (id, n) => {
    const el = document.getElementById(id);
    if (el) el.textContent = n;
  };
  setCount('legendCountReported',   counts.reported);
  setCount('legendCountInProgress', counts.in_progress);
  setCount('legendCountFixed',      counts.fixed);
}

const VIEWPORT_LOAD_PAD_RATIO = 0.6;

const MAX_ALWAYS_ON_FETCH     = 800;

const MAX_LOADED_REPORTS      = 4000;

let lastLoadedBBox = null;

function currentViewportBBox() {
  const b = map.getBounds();
  const sw = b.getSouthWest(), ne = b.getNorthEast();
  const latPad = (ne.lat - sw.lat) * VIEWPORT_LOAD_PAD_RATIO;
  const lonPad = (ne.lng - sw.lng) * VIEWPORT_LOAD_PAD_RATIO;
  return {
    minLat: Math.max(-90, sw.lat - latPad),
    maxLat: Math.min(90, ne.lat + latPad),
    minLon: sw.lng - lonPad,
    maxLon: ne.lng + lonPad
  };
}

function viewportBBoxContains(outer, inner) {
  return !!outer && !!inner &&
    inner.minLat >= outer.minLat && inner.maxLat <= outer.maxLat &&
    inner.minLon >= outer.minLon && inner.maxLon <= outer.maxLon;
}

function pruneLoadedReportsIfNeeded() {
  if (globalActiveData.length <= MAX_LOADED_REPORTS) return;
  const c = map.getCenter();
  const center = { lat: c.lat, lon: c.lng };
  globalActiveData.sort((a, b) => {
    const da = isValidLatLng(a.latitude, a.longitude) ? distMeters(center, { lat: a.latitude, lon: a.longitude }) : Infinity;
    const db = isValidLatLng(b.latitude, b.longitude) ? distMeters(center, { lat: b.latitude, lon: b.longitude }) : Infinity;
    return da - db;
  });
  globalActiveData = globalActiveData.slice(0, MAX_LOADED_REPORTS);
  markActiveDataChanged();
}

async function loadPinsByWindow() {
  if (!fp || !fp.selectedDates || fp.selectedDates.length < 2) return;

  const start = new Date(fp.selectedDates[0]);
  start.setHours(0,0,0,0);
  const end = new Date(fp.selectedDates[1]);
  end.setHours(23,59,59,999);

  const bbox = currentViewportBBox();
  lastLoadedBBox = bbox;

  try {
    const [dateRangeRes, alwaysOnRes] = await Promise.all([
      sb.from(TABLE).select('*')
        .gte('created_at', start.toISOString())
        .lte('created_at', end.toISOString())
        .gte('latitude', bbox.minLat).lte('latitude', bbox.maxLat)
        .gte('longitude', bbox.minLon).lte('longitude', bbox.maxLon)
        .order('created_at', { ascending: true }),
      // Every status — including fixed — stays visible on the map
      // regardless of the selected date range; the legend checkboxes
      // (statusMarkerFilter / onStatusFilterToggle) are the actual
      // user-facing control for hiding a status, not the date picker.
      // Previously this excluded 'fixed', which meant a report fixed
      // outside the current date window would silently vanish from the
      // map even though it was never explicitly hidden by the user.
      sb.from(TABLE).select('*')
        .gte('latitude', bbox.minLat).lte('latitude', bbox.maxLat)
        .gte('longitude', bbox.minLon).lte('longitude', bbox.maxLon)
        .order('created_at', { ascending: false })
        .limit(MAX_ALWAYS_ON_FETCH)
    ]);

    if (dateRangeRes.error) throw dateRangeRes.error;
    if (alwaysOnRes.error) throw alwaysOnRes.error;

    const freshInWindow = dateRangeRes.data || [];
    dateRangeOnlyData = freshInWindow;

    const newlyMergedIds = new Set();
    freshInWindow.forEach(r => newlyMergedIds.add(r.id));
    (alwaysOnRes.data || []).forEach(r => newlyMergedIds.add(r.id));

    const merged = new Map(globalActiveData.map(r => [r.id, r]));
    freshInWindow.forEach(r => merged.set(r.id, r));
    (alwaysOnRes.data || []).forEach(r => merged.set(r.id, r));
    globalActiveData = Array.from(merged.values());
    if (isTesterMode()) globalActiveData = applyTesterReportOverlay(globalActiveData);
    markActiveDataChanged();
    pruneLoadedReportsIfNeeded();

    // Pins never need vote-progress data to be placed on the map — it's only
    // read inside the popup detail (buildVoteProgressHtml). Previously this
    // was awaited *before* syncMarkers, and re-fetched for every report ever
    // accumulated in globalActiveData (up to 4000 ids) on every single
    // pan/zoom/date change — a huge `report_id=in.(...)` query that made the
    // whole map appear stuck until it finished. Render pins immediately, and
    // fetch vote progress in the background for just the reports that were
    // newly merged this round; refresh any open popups once it lands.
    syncMarkers(true);
    updateReportCount();
    refreshHeatLayer();

    loadVoteProgress(Array.from(newlyMergedIds)).then(() => {
      refreshRenderedPopups();
    });
  } catch (err) {
    console.error('Failed to load reports:', err.message);
    toast(t('loadFailed'), 'error');
  }
}

let reportsRealtimeChannel = null;

function isReportWithinLoadedWindow(report) {

  if (!report) return false;
  if (report.status !== 'fixed') return true;
  if (!fp || !fp.selectedDates || fp.selectedDates.length < 2) return false;
  const created = new Date(report.created_at).getTime();
  const start = new Date(fp.selectedDates[0]); start.setHours(0,0,0,0);
  const end = new Date(fp.selectedDates[1]); end.setHours(23,59,59,999);
  return created >= start.getTime() && created <= end.getTime();
}

function applyRealtimeReportChange(eventType, newRow, oldRow) {
  if (eventType === 'DELETE') {
    const id = oldRow && oldRow.id;
    if (!id) return;
    const existed = globalActiveData.some(r => r.id === id);
    if (!existed) return;
    globalActiveData = globalActiveData.filter(r => r.id !== id);
    markActiveDataChanged();
    const marker = markerById.get(id);
    if (marker) { removeReportLayer(marker); markerById.delete(id); }
    const pin = sectionPinById.get(id);
    if (pin) { removeReportLayer(pin); sectionPinById.delete(id); }
    const modal = document.getElementById('reportDetailModal');
    if (modal && modal.style.display === 'flex' && modal.dataset.openReportId === id) {
      hideReportDetailModal();
      toast(t('reportRemovedElsewhere') || 'This report was removed', 'error');
    }
    updateReportCount();
    refreshHeatLayer();
    return;
  }

  if (!newRow || !newRow.id) return;
  const idx = globalActiveData.findIndex(r => r.id === newRow.id);
  const inWindow = isReportWithinLoadedWindow(newRow);

  if (!inWindow) {

    if (idx !== -1) {
      globalActiveData.splice(idx, 1);
      markActiveDataChanged();
      const marker = markerById.get(newRow.id);
      if (marker) { removeReportLayer(marker); markerById.delete(newRow.id); }
      const pin = sectionPinById.get(newRow.id);
      if (pin) { removeReportLayer(pin); sectionPinById.delete(newRow.id); }
      updateReportCount();
      refreshHeatLayer();
    }
    return;
  }

  if (idx === -1) globalActiveData.push(newRow);
  else globalActiveData[idx] = newRow;
  markActiveDataChanged();

  syncMarkers(true);
  updateReportCount();
  refreshHeatLayer();
  refreshReportViews(newRow.id);
  if (eventType === 'INSERT' && (!currentSession || newRow.owner_id !== currentSession.user.id)) {
    playNearbyReportChime();
  }
}

function setupReportsRealtimeSync() {
  if (reportsRealtimeChannel) return;
  reportsRealtimeChannel = sb.channel('reports-live-sync')
    .on('postgres_changes', { event: '*', schema: 'public', table: TABLE }, payload => {
      try {
        applyRealtimeReportChange(payload.eventType, payload.new, payload.old);
      } catch (err) {
        console.error('Realtime report sync error:', err);
      }
    })
    .subscribe();
}

async function loadVoteProgress(reportIds) {
  if (!currentSession) { voteProgressByReport = new Map(); return; }
  if (!reportIds.length) return;
  try {
    const { data, error } = await sb.from('report_status_vote_progress')
      .select('*')
      .in('report_id', reportIds);
    if (error) throw error;
    // Clear only the ids we just re-fetched, then repopulate from the fresh
    // rows — this keeps vote data for every other already-loaded report
    // intact instead of wiping the whole cache on every partial fetch.
    reportIds.forEach(id => voteProgressByReport.delete(id));
    (data || []).forEach(row => {
      if (!voteProgressByReport.has(row.report_id)) voteProgressByReport.set(row.report_id, {});
      voteProgressByReport.get(row.report_id)[row.suggested_status] = row.points;
    });
  } catch (err) {
    console.error('Failed to load vote progress:', err.message);
  }
}

function downloadCSV() {
  if (currentAdminLevel() < 4) return; // UI is already hidden below level 4 — this just backstops direct calls
  const bounds = map.getBounds();
  const visible = dateRangeOnlyData.filter(r =>
    isValidLatLng(r.latitude, r.longitude) && bounds.contains(L.latLng(r.latitude, r.longitude))
  );

  if (!visible.length) { toast(t('noReports'), 'error'); return; }

  let csv = `Report Generated/Downloaded On: ${new Date().toLocaleString()}\n\n`;
  csv += 'ID,ReportedAt,InProgressAt,FixedAt,Latitude,Longitude,Category,Subcategory,Priority,Status,ReportedBy,Comment\n';
  visible.forEach(r => {
    csv += `${r.id},` +
           `${r.created_at},` +
           `${r.in_progress_at || ''},` +
           `${r.fixed_at || ''},` +
           `${r.latitude},` +
           `${r.longitude},` +
           `${r.category},` +
           `${r.subcategory || ''},` +
           `${r.priority || 'normal'},` +
           `${r.status},` +
           `"${(r.comment || '').replace(/"/g, '""')}"\n`;
  });

  let filename = 'TraceTheBreak.csv';
  if (fp.selectedDates.length === 2) {
    const pad = (n) => String(n).padStart(2, '0');
    const d1 = fp.selectedDates[0];
    const d2 = fp.selectedDates[1];
    const startStr = `${pad(d1.getDate())}${pad(d1.getMonth() + 1)}${d1.getFullYear()}`;
    const endStr = `${pad(d2.getDate())}${pad(d2.getMonth() + 1)}${d2.getFullYear()}`;
    filename = `TraceTheBreak_${startStr}_${endStr}.csv`;
  }

  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

let wakeLock = null;

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (err) {
    console.warn('Wake lock not granted:', err.message);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') requestWakeLock();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkPendingContactAttempt();
});
window.addEventListener('pageshow', checkPendingContactAttempt);
window.addEventListener('focus', checkPendingContactAttempt);

requestWakeLock();

function toggleFullscreen() {
  const el = document.documentElement;
  const isFullscreen = document.fullscreenElement || document.webkitFullscreenElement;

  if (!isFullscreen) {
    (el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen)?.call(el);
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen)?.call(document);
  }
}

function updateFullscreenBtn() {
  const btn = document.getElementById('fullscreenBtn');
  const icon = document.getElementById('fullscreenBtnIcon');
  if (!btn || !icon) return;
  const isFullscreen = document.fullscreenElement || document.webkitFullscreenElement;
  icon.src = isFullscreen ? 'icons/fullscreen-exit.png' : 'icons/fullscreen-enter.png';
  btn.title = isFullscreen ? 'Exit fullscreen / Napusti celi ekran' : 'Fullscreen / Preko celog ekrana';
}

['fullscreenchange', 'webkitfullscreenchange'].forEach(evt =>
  document.addEventListener(evt, () => {
    updateFullscreenBtn();
    if (typeof map !== 'undefined' && map.invalidateSize) {
      setTimeout(() => map.invalidateSize(), 100);
    }
    requestPortraitLock();
  })
);

function requestPortraitLock() {
  const isFullscreen = document.fullscreenElement || document.webkitFullscreenElement;
  if (!isFullscreen) return;
  try {
    screen.orientation?.lock?.('portrait')?.catch(() => {
    });
  } catch (err) {
  }
}
requestPortraitLock();

if (isMobileDevice()) {
  document.addEventListener('pointerdown', function autoLockOnFirstTap() {
    document.removeEventListener('pointerdown', autoLockOnFirstTap);
    if (document.fullscreenElement || document.webkitFullscreenElement) return;
    try {
      const el = document.documentElement;
      (el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen)?.call(el);
    } catch (err) {
    }
  }, { once: true });
}

const THEME_STORAGE_KEY = 'ttb_theme_mode';
let themeMode = (function () {
  try { return localStorage.getItem(THEME_STORAGE_KEY) || 'auto'; } catch (e) { return 'auto'; }
})();
const systemDarkModeMQ = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

let ambientLux = null;
let ambientSensorActive = false;
const AMBIENT_DARK_LUX_THRESHOLD = 12;
const NIGHT_START_HOUR = 20;

const NIGHT_END_HOUR   = 7;

function isNightByLocalClock() {
  const h = new Date().getHours();
  return h >= NIGHT_START_HOUR || h < NIGHT_END_HOUR;
}

function resolveThemeMode(mode) {
  if (mode === 'auto') {

    return (systemDarkModeMQ && systemDarkModeMQ.matches) ? 'dark' : 'light';
  }
  if (mode === 'smart') {

    if (ambientSensorActive && ambientLux != null) {
      return ambientLux < AMBIENT_DARK_LUX_THRESHOLD ? 'dark' : 'light';
    }
    return isNightByLocalClock() ? 'dark' : 'light';
  }
  return mode;
}

function initAmbientLightSensor() {
  if (typeof AmbientLightSensor === 'undefined') return;
  try {
    const sensor = new AmbientLightSensor({ frequency: 0.2 });
    sensor.addEventListener('reading', () => {
      ambientLux = sensor.illuminance;
      ambientSensorActive = true;
      if (themeMode === 'smart') applyTheme('smart');
    });
    sensor.addEventListener('error', () => { ambientSensorActive = false; });
    sensor.start();
  } catch (e) {
 }
}

function updateThemeSegmentUI() {
  ['Light', 'Dark', 'Auto', 'Smart'].forEach(label => {
    const btn = document.getElementById('themeBtn' + label);
    if (btn) btn.classList.toggle('active', themeMode === label.toLowerCase());
  });
}

function applyTheme(mode) {
  themeMode = mode;
  const resolved = resolveThemeMode(mode);
  document.documentElement.dataset.theme = resolved;
  updateThemeSegmentUI();
  if (typeof refreshActiveMapStyle === 'function') refreshActiveMapStyle();
}

function setThemeMode(mode) {
  try { localStorage.setItem(THEME_STORAGE_KEY, mode); } catch (e) {}
  applyTheme(mode);
}

function initTheme() {
  applyTheme(themeMode);
  if (systemDarkModeMQ) {
    const onSystemThemeChange = () => applyTheme(themeMode);
    if (systemDarkModeMQ.addEventListener) systemDarkModeMQ.addEventListener('change', onSystemThemeChange);
    else if (systemDarkModeMQ.addListener) systemDarkModeMQ.addListener(onSystemThemeChange);
  }
  initAmbientLightSensor();

  setInterval(() => { if (themeMode === 'smart') applyTheme('smart'); }, 15 * 60 * 1000);
}

const ICON_PACK_DEFAULT = 'icons';

function iconPackNameFromId(id) {
  if (id === ICON_PACK_DEFAULT) return { en:'Modern', sr:'Moderni' };
  const words = id.replace(/^icons-/, '').split(/[-_]+/).filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1));
  const name = words.join(' ') || id;
  return { en:name, sr:name };
}
let ICON_PACKS = [{ id: ICON_PACK_DEFAULT, ...(() => { const n = iconPackNameFromId(ICON_PACK_DEFAULT); return { nameEn:n.en, nameSr:n.sr }; })() }];
let iconPack = localStorage.getItem('ttb_icon_pack') || ICON_PACK_DEFAULT;

async function discoverIconPacks() {
  try {
    const res = await fetch('icons/packs.json', { cache:'no-store' });
    if (!res.ok) return;
    const folders = await res.json();
    if (!Array.isArray(folders)) return;
    const discovered = folders
      .filter(id => typeof id === 'string' && id && id !== ICON_PACK_DEFAULT)
      .map(id => { const n = iconPackNameFromId(id); return { id, nameEn:n.en, nameSr:n.sr }; });
    ICON_PACKS = [ICON_PACKS[0], ...discovered];
  } catch (e) {

  } finally {
    if (!ICON_PACKS.some(p => p.id === iconPack)) iconPack = ICON_PACK_DEFAULT;
    renderIconPackSegment();
  }
}

const iconExistsCache = new Map();

function probeIconExists(path) {
  if (!iconExistsCache.has(path)) {
    iconExistsCache.set(path, new Promise(resolve => {
      const probe = new Image();
      probe.onload = () => resolve(true);
      probe.onerror = () => resolve(false);
      probe.src = path;
    }));
  }
  return iconExistsCache.get(path);
}

function rewriteIconSrc(img) {
  if (iconPack === ICON_PACK_DEFAULT || !img || img.tagName !== 'IMG') return;
  const raw = img.getAttribute('src');
  if (!raw || !raw.startsWith('icons/')) return;
  const packSrc = iconPack + '/' + raw.slice('icons/'.length);
  img.setAttribute('src', packSrc);
  probeIconExists(packSrc).then(ok => {
    if (ok) return;

    if (img.getAttribute('src') === packSrc) img.setAttribute('src', raw);
  });
}

const ICON_STYLE_URL_RE = /(url\(['"]?)(?:\.\/)?icons\//g;
function rewriteIconStyle(el) {
  if (iconPack === ICON_PACK_DEFAULT || !el || !el.getAttribute) return;
  const style = el.getAttribute('style');
  if (!style || style.indexOf('icons/') === -1) return;
  const rewritten = style.replace(ICON_STYLE_URL_RE, (m, prefix) => prefix + iconPack + '/');
  if (rewritten === style) return;
  el.setAttribute('style', rewritten);

  const packUrlRe = new RegExp("url\\(['\"]?(" + iconPack.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "\\/[^'\")]+)['\"]?\\)", 'g');
  let m;
  while ((m = packUrlRe.exec(rewritten))) {
    const packPath = m[1];
    const defaultPath = ICON_PACK_DEFAULT + '/' + packPath.slice(iconPack.length + 1);
    probeIconExists(packPath).then(ok => {
      if (ok) return;
      const current = el.getAttribute('style');
      if (current && current.indexOf(packPath) !== -1) {
        el.setAttribute('style', current.split(packPath).join(defaultPath));
      }
    });
  }
}

function rewriteIconsIn(node) {
  if (!node || node.nodeType !== 1) return;
  if (node.tagName === 'IMG') rewriteIconSrc(node);
  else rewriteIconStyle(node);
  if (node.querySelectorAll) {
    node.querySelectorAll('img[src^="icons/"]').forEach(rewriteIconSrc);
    node.querySelectorAll('[style*="icons/"]').forEach(rewriteIconStyle);
  }
}

function initIconPackRewrite() {
  if (iconPack === ICON_PACK_DEFAULT) return;
  rewriteIconsIn(document.body);
  new MutationObserver(mutations => {
    for (const m of mutations) {
      if (m.type === 'childList') m.addedNodes.forEach(rewriteIconsIn);
      else if (m.type === 'attributes' && m.attributeName === 'src') rewriteIconSrc(m.target);
      else if (m.type === 'attributes' && m.attributeName === 'style') rewriteIconStyle(m.target);
    }
  }).observe(document.body, { childList:true, subtree:true, attributes:true, attributeFilter:['src','style'] });
}

function renderIconPackSegment() {
  const seg = document.getElementById('iconPackSegment');
  if (!seg) return;
  seg.innerHTML = ICON_PACKS.map(p => `<button type="button" class="theme-segment-btn${p.id === iconPack ? ' active' : ''}" onclick="setIconPack('${p.id}')">${escapeHtml(isSerbianLang() ? p.nameSr : p.nameEn)}</button>`).join('');
}

function setIconPack(packId) {
  if (packId === iconPack || !ICON_PACKS.some(p => p.id === packId)) return;
  localStorage.setItem('ttb_icon_pack', packId);
  location.reload();
}

const MAP_LOADING_OVERLAY_MIN_TOTAL_MS = 2000;

function hideMapLoadingOverlay() {
  const shownAt = window.__ttbSplashShownAt || Date.now();
  const elapsed = Date.now() - shownAt;
  const remaining = Math.max(0, MAP_LOADING_OVERLAY_MIN_TOTAL_MS - elapsed);
  setTimeout(() => {
    const el = document.getElementById('mapLoadingOverlay');
    if (el) el.classList.add('map-loading-hidden');
  }, remaining);
}

// Legal content (copyright line, Terms of Service, Privacy Policy) lives in
// languages/legal/<code>.json — one file per language, terms + policy
// together in the same file since they're usually translated as a set.
// Translators work the same way they do for UI strings: copy
// languages/legal/en.json, translate the three values, save as
// languages/legal/<code>.json. Falls back to the English legal file (then
// to the hardcoded strings below) if a translation doesn't exist yet or the
// fetch fails, so nothing ever renders blank.
let legalContent = {};
let legalContentLoadedForLang = null;
let legalContentModalOpenKey = null;

const LEGAL_CONTENT_FALLBACK = {
  copyright_footer: '© TraceTheBreak · tracethestuff.com',
  terms_of_service: 'Terms of Service content is not available right now.',
  privacy_policy:   'Privacy Policy content is not available right now.'
};

async function fetchLegalContentFile(code) {
  try {
    const res = await fetch(`languages/legal/${code}.json`, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    return (data && typeof data === 'object') ? data : null;
  } catch (e) {
    return null;
  }
}

function legalText(key) {
  if (legalContent[key]) return legalContent[key];
  return LEGAL_CONTENT_FALLBACK[key] || '';
}

async function loadLegalContent() {
  if (legalContentLoadedForLang === lang) { renderLegalCopyrightLine(); return; }
  let data = await fetchLegalContentFile(lang);
  if (!data && lang !== DEFAULT_LANG) data = await fetchLegalContentFile(DEFAULT_LANG);
  legalContent = data || {};
  legalContentLoadedForLang = lang;
  renderLegalCopyrightLine();
  if (document.getElementById('legalContentModal').style.display !== 'none' && legalContentModalOpenKey) {
    renderLegalContentModalBody(legalContentModalOpenKey);
  }
}

function renderLegalCopyrightLine() {
  const el = document.getElementById('legalCopyrightText');
  if (el) el.textContent = legalText('copyright_footer');
}

function renderLegalContentModalBody(key) {
  const body = document.getElementById('legalContentBody');
  if (body) body.innerHTML = `<div class="detail-section"><p class="detail-export-hint" style="white-space:pre-wrap;">${escapeHtml(legalText(key))}</p></div>`;
}

function showLegalContentModal(key) {
  legalContentModalOpenKey = key;
  const modal = document.getElementById('legalContentModal');
  const titleEl = document.getElementById('legalContentTitle');
  titleEl.textContent = key === 'terms_of_service' ? t('termsOfServiceBtn') : t('privacyPolicyBtn');
  renderLegalContentModalBody(key);
  bringModalToFront(modal);
  modal.style.display = 'flex';
  openOverlay('legalContentModal', hideLegalContentModal);
}

function hideLegalContentModal() {
  const modal = document.getElementById('legalContentModal');
  modal.style.display = 'none';
  legalContentModalOpenKey = null;
  closeOverlay('legalContentModal');
}

discoverIconPacks().finally(initIconPackRewrite);
initTheme();
initCalendarFilter();
const langReady = initLang();

const INITIAL_LOCATION_ZOOM = 13;
const INITIAL_LOCATION_FIX_TIMEOUT_MS = 2500;
function getQuickInitialFix(timeoutMs) {
  return new Promise(resolve => {
    if (!navigator.geolocation) { resolve(null); return; }
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, timeoutMs);
    navigator.geolocation.getCurrentPosition(
      pos => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(isValidLatLng(pos.coords.latitude, pos.coords.longitude)
          ? { lat: pos.coords.latitude, lon: pos.coords.longitude } : null);
      },
      () => { if (!settled) { settled = true; clearTimeout(timer); resolve(null); } },
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 60000 }
    );
  });
}
async function runInitialLoadSequence() {
  let initialLat = savedMapView ? savedMapView.lat : null;
  let initialLon = savedMapView ? savedMapView.lng : null;
  if (!savedMapView) {
    const quickFix = await getQuickInitialFix(INITIAL_LOCATION_FIX_TIMEOUT_MS);
    if (quickFix) {
      map.setView([quickFix.lat, quickFix.lon], INITIAL_LOCATION_ZOOM, { animate: false });
      initialLat = quickFix.lat;
      initialLon = quickFix.lon;
    }
  }
  if (initialLat == null) {
    const c = map.getCenter();
    initialLat = c.lat;
    initialLon = c.lng;
  }

  ensureMunicipalitiesNear(initialLat, initialLon);
  await loadPinsByWindow();
}
runInitialLoadSequence().finally(hideMapLoadingOverlay);
updateBottomMunicipalityBar(null);
setupReportsRealtimeSync();
openSharedReportFromUrl();
loadCompanyMarkersByWindow();

const authReady = initAuth();
authReady.then(() => {
  if (currentProfile && currentProfile.is_admin) {
    updateAuthUI();
    renderAdminDashboard();
  }
});
authReady.then(() => {
  if (!currentSession) showHelpModal();
  updateOfflineQueueBadge();
  syncOfflineQueue(false);
  syncPushToggleUi();
});

