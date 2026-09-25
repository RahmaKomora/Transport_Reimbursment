import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleMarker, MapContainer, Polyline, TileLayer, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import tupandeLogo from './assets/src/assets/tupande-logo.png';
import AccountClaim from './AccountClaim';
import LeafMark from './LeafMark';
import NotificationBell from './NotificationBell';
import GoogleSignIn from './GoogleSignIn';
import HrDashboard from './HrDashboard';
import { ManagerHome, TeamClaims } from './ManagerDashboard';
import TeamBudgets from './TeamBudgets';
import HrOverview from './HrOverview';
import AdminUsers from './AdminUsers';
import AdminRates from './AdminRates';
import AdminRegions from './AdminRegions';
import { api, getToken } from './api';

const PURPOSES = ['Client Repayment', 'Duka Training/Group Events', 'Farmer Visit', 'Field Boundary Mapping', 'Group formation', 'Enrollment Campaign', 'Farmer Training', 'Cash Crop Scouting', 'Other'];
const TRANSPORTS = ['Piki', 'Matatu', 'Personal means'];
const PERSONAL_TYPES = ['Piki', 'Car'];
// Fallback only. The live rates come from the server with /me, so a regional rate
// applies without the browser holding its own copy.
const FALLBACK_RATES = { Piki: 25, Matatu: 30, 'Personal Piki': 20, 'Personal Car': 35 };
const emptyTrip = { date: new Date().toISOString().slice(0, 10), purposes: [], otherPurpose: '', comment: '', transport: '', personalType: '', start: null, end: null };
const money = (value) => new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(value);
const PERMISSION_COPY = {
  unsupported: 'This browser cannot read GPS, so journeys cannot be tracked here. Try Chrome or Safari on your phone.',
  insecure: 'Location needs a secure connection. Open Songa over https, or on localhost while testing.',
  denied: 'Location is blocked for Songa. Open the icon at the left of the address bar, set Location to Allow, then check again.',
  embedded: 'Songa is running inside an embedded preview, which browsers never allow to read GPS. Open Songa in its own browser tab to track a journey.',
  prompt: 'Songa uses your location only while a journey is running, to measure the distance you claim for.',
  unknown: 'Songa uses your location only while a journey is running, to measure the distance you claim for.',
  granted: 'Location access granted.',
};
const BLOCKED_STATES = ['unsupported', 'insecure', 'denied', 'embedded'];
const UNFIXABLE_STATES = ['unsupported', 'insecure', 'embedded'];

// Reports why location cannot be requested at all, or null when a request is worth making.
function locationBlocker() {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  if (embeddedWithoutLocation()) return 'embedded';
  return null;
}

// A cross-origin frame only gets GPS if the hosting page delegates it with allow="geolocation".
// Without that the browser denies Songa no matter what the site setting says, so this is worth
// telling apart from a denial the user can actually undo.
function embeddedWithoutLocation() {
  if (window.self === window.top) return false;
  const policy = document.permissionsPolicy || document.featurePolicy;
  return policy?.allowsFeature ? !policy.allowsFeature('geolocation') : false;
}

// Tracks the browser's geolocation permission so the UI can reflect a grant or block made
// outside the app, e.g. in Chrome's site settings. Falls back to 'unknown' where the
// Permissions API is missing (Safari), which still allows a request to be attempted.
function useLocationPermission() {
  const [permission, setPermission] = useState(() => locationBlocker() || 'unknown');
  useEffect(() => {
    if (locationBlocker() || !navigator.permissions?.query) return undefined;
    let status = null;
    let cancelled = false;
    const sync = () => { if (!cancelled && status) setPermission(status.state); };
    navigator.permissions.query({ name: 'geolocation' }).then((result) => {
      if (cancelled) return;
      status = result;
      setPermission(result.state);
      result.addEventListener('change', sync);
    }).catch(() => { if (!cancelled) setPermission('unknown'); });
    return () => { cancelled = true; if (status) status.removeEventListener('change', sync); };
  }, []);
  return [permission, setPermission];
}

function geolocationMessage(error) {
  if (error.code === error.PERMISSION_DENIED) return PERMISSION_COPY[locationBlocker() || 'denied'];
  if (error.code === error.POSITION_UNAVAILABLE) return 'Your position is unavailable. Check that device location is switched on.';
  if (error.code === error.TIMEOUT) return 'Timed out waiting for a GPS fix. Move into open sky and try again.';
  return 'Location could not be read. Try again.';
}

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [currentUser, setCurrentUser] = useState({ name: '', email: '' });
  const [budget, setBudget] = useState(null);
  const [ledger, setLedger] = useState(null);
  const [cycle, setCycle] = useState(null);
  const [rates, setRates] = useState(FALLBACK_RATES);
  const [submitError, setSubmitError] = useState('');
  const [teamStatus, setTeamStatus] = useState('All');
  const [view, setView] = useState('overview');
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [profileMessage, setProfileMessage] = useState('');
  const [trip, setTrip] = useState(emptyTrip);
  const [trips, setTrips] = useState([]);
  const [claim, setClaim] = useState({ code: '', email: '', proof: '', proofData: '', proofSize: 0, proofError: '', amount: '' });
  const [gpsMessage, setGpsMessage] = useState('');
  const [tracking, setTracking] = useState({ active: false, route: [], current: null, startTime: '', startCoordinates: null });
  const [permission, setPermission] = useLocationPermission();
  const watchId = useRef(null);
  const selectedVehicle = trip.transport === 'Personal means'
    ? (trip.personalType ? `Personal ${trip.personalType}` : '')
    : trip.transport;
  const rate = rates[selectedVehicle] || 0;
  const distance = useMemo(() => tracking.route.length > 1 ? tracking.route.slice(1).reduce((totalDistance, point, index) => totalDistance + haversine(tracking.route[index][0], tracking.route[index][1], point[0], point[1]), 0) : 0, [tracking.route]);
  const total = Math.round(distance * rate);

  useEffect(() => () => { if (watchId.current !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId.current); }, []);

  // Restore an existing session on load so a refresh does not bounce the user to login.
  useEffect(() => {
    if (!getToken()) return;
    api.me()
      .then(({ user, budget: cycleBudget, ledger: wallet, rates: live, cycle: period }) => { adoptUser(user); setBudget(cycleBudget); setLedger(wallet); setCycle(period); if (live) setRates(live); setIsAuthenticated(true); })
      .catch(() => api.logout());
  }, []);

  const adoptUser = (user) => {
    setCurrentUser(user);
    setClaim((current) => ({ ...current, email: user.email }));
    // Someone who only approves lands on their dashboard; claimants land on their own
    // overview. Otherwise an approver opens on a staff page that will always be empty.
    // HR and admins land on the regional overview. A claimant workspace is only a
    // landing page for someone who actually has an allowance to spend.
    const claims = user.isStaff && user.transportPerCycle > 0;
    setView((user.role === 'hr' || user.role === 'admin') ? 'hr-overview' : claims ? 'overview' : 'review');
  };
  const refreshClaims = () => {
    api.myClaims().then((mine) => setTrips(mine.map(toTripRow))).catch(() => {});
    api.me().then(({ budget: cycleBudget, ledger: wallet, rates: live, cycle: period }) => { setBudget(cycleBudget); setLedger(wallet); setCycle(period); if (live) setRates(live); }).catch(() => {});
  };

  const updateTrip = (field, value) => setTrip((current) => ({ ...current, [field]: value }));
  const togglePurpose = (purpose) => setTrip((current) => ({ ...current, purposes: current.purposes.includes(purpose) ? current.purposes.filter((item) => item !== purpose) : [...current.purposes, purpose] }));
  const requestLocationAccess = () => {
    const blocker = locationBlocker();
    if (blocker) { setPermission(blocker); setGpsMessage(PERMISSION_COPY[blocker]); return; }
    setGpsMessage('Waiting for you to allow location in the browser...');
    navigator.geolocation.getCurrentPosition(() => {
      setPermission('granted');
      setGpsMessage('Location access granted. You can start your journey.');
    }, (error) => {
      if (error.code === error.PERMISSION_DENIED) setPermission(locationBlocker() || 'denied');
      setGpsMessage(geolocationMessage(error));
    }, { enableHighAccuracy: false, maximumAge: 60000, timeout: 20000 });
  };
  const startTracking = () => {
    const blocker = locationBlocker();
    if (blocker) { setPermission(blocker); setGpsMessage(PERMISSION_COPY[blocker]); return; }
    setGpsMessage('Waiting for your live location...');
    setTracking((current) => ({ ...current, active: true, route: [], current: null, startTime: new Date().toISOString(), startCoordinates: null }));
    watchId.current = navigator.geolocation.watchPosition(({ coords }) => {
      const point = { latitude: coords.latitude, longitude: coords.longitude };
      setTrip((current) => ({ ...current, start: current.start || point }));
      setTracking((current) => ({ ...current, active: true, current: point, route: [...current.route, [point.latitude, point.longitude]], startCoordinates: current.startCoordinates || point }));
      setPermission('granted');
      setGpsMessage('Live tracking is active. Travel with Songa open.');
    }, (error) => {
      if (watchId.current !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
      setTracking({ active: false, route: [], current: null, startTime: '', startCoordinates: null });
      if (error.code === error.PERMISSION_DENIED) setPermission(locationBlocker() || 'denied');
      setGpsMessage(geolocationMessage(error));
    }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 });
  };
  const endTracking = () => {
    if (!tracking.active || !tracking.current) return;
    if (watchId.current !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId.current);
    const end = tracking.current;
    setTrip((current) => ({ ...current, end }));
    setTracking((current) => ({ ...current, active: false }));
    setGpsMessage('Trip ended. End point captured.');
    setView('claim');
  };
  const startNewTrip = () => { setTrip({ ...emptyTrip }); setClaim({ code: '', email: currentUser.email, proof: '', proofData: '', proofSize: 0, proofError: '', amount: '' }); setGpsMessage(''); setTracking({ active: false, route: [], current: null, startTime: '', startCoordinates: null }); setView('trip'); };
  const submitClaim = async (event) => {
    event.preventDefault();
    setSubmitError('');
    if (!trip.date || !trip.start || !trip.end || !trip.purposes.length || !selectedVehicle || (trip.purposes.includes('Other') && !trip.otherPurpose.trim()) || !claim.code || !claim.email || !claim.name || !claim.proof || Number(claim.amount) <= 0) return;
    try {
      const { outcome } = await api.submitClaim({
        amount: Number(claim.amount), estimate: total, km: distance, rate, vehicle: selectedVehicle,
        tripDate: trip.date, purposes: trip.purposes, mpesaCode: claim.code, mpesaName: claim.name,
        proof: claim.proofData ? { name: claim.proof, dataUrl: claim.proofData } : undefined,
      });
      setProfileMessage(outcome.reason);
      window.setTimeout(() => setProfileMessage(''), 6000);
      refreshClaims();
      setView('overview');
    } catch (error) {
      // 422 is the over-budget block: the claim was never written, so keep the user on the
      // form with their entries intact rather than pretending it was submitted.
      setSubmitError(error.message);
    }
  };

  const handleProfileAction = (message) => { setProfileMessage(message); setProfileMenuOpen(false); window.setTimeout(() => setProfileMessage(''), 2600); };
  const signOut = () => { if (watchId.current !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId.current); api.logout(); setBudget(null); setLedger(null); setCycle(null); setTrips([]); setIsAuthenticated(false); setProfileMenuOpen(false); setView('overview'); };
  const startSession = async (user) => {
    adoptUser(user);
    setIsAuthenticated(true);
    api.me().then(({ budget: b, ledger: w, rates: live }) => { setBudget(b); setLedger(w); if (live) setRates(live); }).catch(() => {});
    api.myClaims().then((mine) => setTrips(mine.map(toTripRow))).catch(() => {});
  };

  if (!isAuthenticated) return <Login
    onGoogle={async (credential) => startSession(await api.loginWithGoogle(credential))}
    onEmail={async (email) => startSession(await api.login(email))}
  />;
  return <div className="app-shell"><SidePanel view={view} setView={setView} logo={tupandeLogo} profileMenuOpen={profileMenuOpen} setProfileMenuOpen={setProfileMenuOpen} onAction={handleProfileAction} onSignOut={signOut} user={currentUser} onNavigate={(next, status) => { if (status) setTeamStatus(status); setView(next); }} /><main className="main"><header className="mobile-header"><span className="logo-wrap small"><LeafMark size={22} /></span><strong>Songa</strong><button className="avatar">R</button></header><div className="content">
    {view === 'overview' && <Overview trips={trips} onNewTrip={startNewTrip} onTrips={() => setView('trips')} user={currentUser} ledger={ledger} cycle={cycle} />}
    {view === 'trips' && <Trips trips={trips} onNewTrip={startNewTrip} />}
    {view === 'claims' && <Trips trips={trips.filter((item) => item.status !== 'Completed')} onNewTrip={startNewTrip} claimsOnly />}
    {view === 'trip' && <><TripDatePicker date={trip.date} onChange={(value) => updateTrip('date', value)} disabled={tracking.active} /><JourneyForm trip={trip} updateTrip={updateTrip} togglePurpose={togglePurpose} tracking={tracking} onStart={startTracking} onEnd={endTracking} gpsMessage={gpsMessage} rate={rate} selectedVehicle={selectedVehicle} distance={distance} total={total} permission={permission} onRequestPermission={requestLocationAccess} /></>}
    {view === 'claim' && <AccountClaim trip={trip} claim={claim} setClaim={setClaim} distance={distance} total={total} rate={rate} vehicle={selectedVehicle} onSubmit={submitClaim} money={money} compressImage={compressImage} formatFileSize={formatFileSize} ledger={ledger} submitError={submitError} />}
    {view === 'review' && <ManagerHome money={money} user={currentUser} onOpenClaims={(status) => { setTeamStatus(status); setView('team'); }} />}
    {view === 'team' && <TeamClaims money={money} user={currentUser} initialStatus={teamStatus} />}
    {view === 'budgets' && <TeamBudgets money={money} />}
    {view === 'hr-overview' && <HrOverview money={money} user={currentUser} onOpen={setView} />}
    {view === 'admin-users' && <AdminUsers money={money} />}
    {view === 'admin-rates' && <AdminRates money={money} />}
    {view === 'admin-regions' && <AdminRegions money={money} />}
    {view === 'hr' && <HrDashboard money={money} />}
  </div>{profileMessage && <div className="profile-toast">{profileMessage}</div>}</main></div>;
}

// Navigation follows your role. A claimant sees their workspace; an
// approver who does not claim sees only the approvals section, rather than staff pages
// that would always be empty for them.
function SidePanel({ view, setView, logo, profileMenuOpen, setProfileMenuOpen, onAction, onSignOut, user, onNavigate }) {
  const [logoBroken, setLogoBroken] = useState(false);
  const [adminOpen, setAdminOpen] = useState(view.startsWith('admin-'));
  const isAdmin = user.role === 'admin';
  // An admin sees every section, allowance or not. For everybody else the workspace only
  // appears when they actually have something to spend, so an approver who never claims
  // is not given staff pages that would always be empty for them. An admin with no
  // allowance still needs the claimant view to see what their staff are looking at.
  const claims = isAdmin || (user.isStaff !== false && (user.transportPerCycle ?? 1) > 0);
  const approves = user.role === 'manager' || isAdmin;
  const isHr = user.role === 'hr' || isAdmin;
  const home = isHr ? 'hr-overview' : claims ? 'overview' : 'review';
  const initial = (user.name || user.email || '?').trim().charAt(0).toUpperCase();
  const link = (key, icon, label) => <button className={`side-link ${view === key ? 'active' : ''}`} onClick={() => setView(key)}>{icon} <span>{label}</span></button>;
  return <aside className="side-panel">
    <div className="side-motifs" aria-hidden="true"><span className="motif-bike" /><span className="motif-car" /></div>
    <button className="side-brand" onClick={() => setView(home)}>
      <span className="logo-wrap">{logoBroken ? <LeafMark size={26} /> : <img src={logo} alt="Tupande" onError={() => setLogoBroken(true)} />}</span>
      <span><small>TUPANDE</small><strong>Songa</strong></span>
    </button>
    {claims && <><p className="side-label">MY WORKSPACE</p>
      {link('overview', '⌂', 'Overview')}
      {link('trips', '♧', 'My Trips')}
      {link('claims', '▣', 'My Claims')}</>}
    {approves && <><p className="side-label">APPROVALS</p>
      {link('review', '▦', 'Dashboard')}
      {link('team', '✓', 'My Team’s Claims')}
      {link('budgets', '◑', 'Team Budgets')}</>}
    {isHr && <><p className="side-label">HR</p>
      {link('hr-overview', '◴', 'Overview')}
      {link('hr', '❑', 'Reimbursements')}</>}
    {/* Notifications and Admin sit below the working sections, separated from them: one
        is where the day's work is, the other is where the app is configured. Admin comes
        last because it is the one you go to deliberately rather than repeatedly. */}
    <div className="side-notify"><NotificationBell onNavigate={onNavigate} /></div>
    {isHr && <>
      <button className={`side-link admin-toggle ${adminOpen ? 'open' : ''}`} onClick={() => setAdminOpen((value) => !value)} aria-expanded={adminOpen}>
        ⚙ <span>Admin</span><b>{adminOpen ? '⌄' : '›'}</b>
      </button>
      {/* Widest scope first: the money across all regions, then what sets the rates,
          then the individual people. */}
      {adminOpen && <div className="side-sub">
        {link('admin-regions', '▥', 'Regional Budgets')}
        {link('admin-rates', '◎', 'Transport Rates')}
        {link('admin-users', '⚿', 'User Roles')}
      </div>}
    </>}
    {profileMenuOpen && <div className="side-utilities">
      <button type="button" onClick={() => onAction('Help center opened')}><span>?</span><strong>Help</strong></button>
      <button type="button" onClick={() => onAction(`Signed in as ${user.email}`)}><span>♙</span><strong>Profile</strong></button>
      <button type="button" onClick={() => onAction('Settings opened')}><span>⚙</span><strong>Settings</strong></button>
      <button type="button" onClick={onSignOut}><span>↪</span><strong>Sign Out</strong></button></div>}
    <button className="side-user" type="button" onClick={() => setProfileMenuOpen((open) => !open)} aria-expanded={profileMenuOpen}>
      <span className="avatar">{initial}</span>
      <div><strong>{user.name}</strong><small>{user.email}</small></div>
      <b>{profileMenuOpen ? '⌄' : '›'}</b></button>
  </aside>;
}
// Sign-in is by work email alone: the directory is the list of who exists, and there is no
// password store. A password box that accepts anything would imply a check that is not
// happening, so there is none. Workspace SSO is the intended replacement.
// Sign-in is Google when the server has a client ID configured, and the old email box
// only while it does not — so nothing is locked out mid-setup, but the weak path closes
// by itself the moment the real one is available.
function Login({ onGoogle, onEmail }) {
  const [config, setConfig] = useState(null);
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.authConfig()
      .then(setConfig)
      .catch((error) => { setConfig({ googleOnly: false }); setMessage(error.message); });
  }, []);

  const withGoogle = async (credential) => {
    setBusy(true);
    setMessage('Signing you in...');
    try {
      await onGoogle(credential);
    } catch (error) {
      setMessage(error.message);
      setBusy(false);
    }
  };

  const withEmail = async (event) => {
    event.preventDefault();
    if (!email.includes('@')) { setMessage('Enter your work email.'); return; }
    setBusy(true);
    setMessage('Checking...');
    try {
      await onEmail(email.trim().toLowerCase());
    } catch (error) {
      setMessage(error.message);
      setBusy(false);
    }
  };

  return <div className="login-page">
    <LoginArt />
    <div className="login-card">
    <div className="login-brand"><span className="login-lettermark" aria-hidden="true">S</span><div><small>Tupande</small><strong>Songa</strong></div></div>
    <h1>Welcome back</h1>

    {!config && <p>Loading...</p>}

    {config?.googleOnly && <>
      <p>Sign in with your One Acre Fund account to log trips and submit reimbursements.</p>
      <GoogleSignIn clientId={config.googleClientId} domain={config.domain} onCredential={withGoogle} disabled={busy} />
    </>}

    {config && !config.googleOnly && <form onSubmit={withEmail}>
      <p>Sign in with your work email to log trips and submit reimbursements.</p>
      <label>Work email<input required autoFocus type="email" value={email} onChange={(event) => { setEmail(event.target.value); setMessage(''); }} placeholder="name@oneacrefund.org" autoComplete="email" /></label>
      <button className="button primary full" type="submit" disabled={busy}>{busy ? 'Signing in...' : 'Sign in'}</button>
      <p className="login-warning">Google sign-in is not configured on this server, so anyone who knows an address can sign in as that person. Set it up before this is used for real claims.</p>
    </form>}

    {message && <p className={message.endsWith('...') ? 'login-note' : 'login-error'}>{message}</p>}
  </div></div>;
}

/**
 * Scenery behind the sign-in card: a car and a piki in outline.
 *
 * The piki carries two, because that is how a piki carries people — a field officer on
 * the back of somebody else's bike is the journey this app exists to reimburse.
 *
 * Decorative, so it is hidden from screen readers and takes no pointer events. Drawn as
 * strokes in currentColor rather than images, which keeps it sharp on a cheap phone
 * screen, costs no request, and lets one CSS colour tune how far it recedes.
 */
function LoginArt() {
  return <div className="login-art" aria-hidden="true">
    <svg className="art-car" viewBox="0 0 230 96" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 70V56c0-6 4-10 10-11l26-4 24-22c4-4 9-6 14-6h56c6 0 11 2 15 7l19 21 26 5c8 2 13 8 13 16v8" />
      <path d="M10 70h22m38 0h90m38 0h12" />
      <path d="M96 13v28M46 41h138" />
      <circle cx="51" cy="70" r="14" />
      <circle cx="179" cy="70" r="14" />
    </svg>
    {/* A heavier stroke than the car's: it is drawn smaller, so this keeps the two
        weights matching once the CSS has scaled them. */}
    <svg className="art-piki" viewBox="0 0 222 194" fill="none" stroke="currentColor" strokeWidth="3.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="54" cy="160" r="26" />
      <circle cx="188" cy="160" r="26" />
      {/* Rear hub up to the bench, along it, over the tank and down the fork. */}
      <path d="M54 160 68 120h74l16-16 30 56M158 104l18-8" />
      {/* Passenger on the back, holding the rider. Neck, spine, arm, then leg. */}
      <circle cx="80" cy="46" r="10" />
      <path d="M81 56 83 63M83 63 88 118M83 63l43 25M88 118l12 24-14 14" />
      {/* Rider in front, hands on the bars. */}
      <circle cx="128" cy="42" r="10" />
      <path d="M127 52 126 59M126 59 124 118M126 59l32 41M124 118l12 24-14 12" />
    </svg>
  </div>;
}
// Every figure here comes from the claims the server returned. The earlier version
// padded them with invented constants, which meant a brand new account opened on a
// dashboard reporting trips and payments that had never happened.
function Overview({ trips, onNewTrip, onTrips, user, ledger, cycle }) {
  const paid = trips.filter((item) => item.status === 'Completed');
  const pending = trips.filter((item) => item.status === 'Pending Manager Review');
  const approved = trips.filter((item) => ['Approved', 'Batched for HR', 'Completed'].includes(item.status));
  const sum = (rows) => rows.reduce((total, item) => total + (Number(item.amount) || 0), 0);
  const distance = trips.reduce((total, item) => total + (Number(item.km) || 0), 0);
  const firstName = (user?.name || '').trim().split(' ')[0] || 'there';
  return <>
    <section className="page-heading"><div>
      <span className="kicker">Overview</span>
      <h1>Hello {firstName}</h1>
      <p>Your field movement and reimbursement activity at a glance.</p>
    </div><button className="button primary" onClick={onNewTrip}>Log new field trip</button></section>
    {ledger && <section className="allowance">
      <div className="allowance-main">
        <span className="kicker">Your allowance</span>
        {/* Nobody has set one. "Ksh 0 left of Ksh 0" beside a figure already claimed
            reads as a broken sum rather than as an account with no budget on it, which
            is what an approver, HR or an admin who does not claim actually has. */}
        {ledger.base > 0 ? <>
          <strong>{money(ledger.baseRemaining)}<em>left of {money(ledger.base)}</em></strong>
          <div className="allowance-bar" aria-label={`${Math.round((ledger.used / ledger.base) * 100)}% used`}>
            <i style={{ width: `${Math.min(100, (ledger.used / ledger.base) * 100)}%` }} className={ledger.usingTopUp ? 'over' : ''} />
          </div>
        </> : <strong className="allowance-none">No allowance set<em>nothing budgeted for you this cycle</em></strong>}
        <small>
          {money(ledger.used)} claimed this cycle
          {ledger.awaiting > 0 && `, including ${money(ledger.awaiting)} still awaiting approval`}.
          {ledger.base === 0 && ' Anything you submit goes to a manager to approve.'}
        </small>
      </div>
      <div className="allowance-side">
        {ledger.base > 0 && <div><span>Top-up left</span><b>{money(ledger.topUpRemaining)}</b><small>needs your manager</small></div>}
        {ledger.max > 0 && <div><span>Cycle maximum</span><b>{money(ledger.max)}</b></div>}
        {cycle && <div className="allowance-cycle"><span>{cycle.label}</span><b>{cycle.range}</b><small>closes {new Date(cycle.closesAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}</small></div>}
      </div>
    </section>}

    <section className="stats dashboard-stats">
      <Stat label="Trips logged" value={trips.length} detail="All time" />
      <Stat label="Pending claims" value={money(sum(pending))} detail={`${pending.length} awaiting review`} />
      <Stat label="Distance covered" value={`${distance.toFixed(1)} km`} detail={`${trips.length} field visit${trips.length === 1 ? '' : 's'}`} />
      <Stat label="Reimbursed" value={money(sum(paid))} detail={`${paid.length} claim${paid.length === 1 ? '' : 's'} completed`} />
      <Stat label="Approved claims" value={approved.length} detail="Signed off" />
    </section>
    <section className="panel activity-table">
      <div className="panel-heading"><div><span className="kicker">Recent activity</span><h2>My latest trips</h2></div>
        {trips.length > 0 && <button className="text-button" onClick={onTrips}>View all →</button>}</div>
      {trips.length === 0 ? <p className="queue-empty">No trips logged yet. Use “Log new field trip” to record your first one.</p> : <>
        <div className="activity-head"><span>Trip details</span><span>Distance</span><span>Amount</span><span>Status</span></div>
        {trips.slice(0, 3).map((item) => <DashboardTripRow item={item} key={item.id} />)}</>}
    </section>
  </>;
}
function Trips({ trips, onNewTrip, claimsOnly = false }) { return <><section className="page-heading"><div><span className="kicker">{claimsOnly ? 'My Claims' : 'My Trips'}</span><h1>{claimsOnly ? 'Reimbursement claims' : 'Trip history'}</h1><p>{claimsOnly ? 'Track submitted amounts and payment status.' : 'Every trip you log stays here for easy reimbursement tracking.'}</p></div><button className="button primary" onClick={onNewTrip}>Log new field trip</button></section><section className="panel trip-table">{trips.map((item) => <TripRow item={item} key={item.id} />)}</section></>; }
function TripRow({ item }) { return <div className="trip-row"><div><strong>{item.id}</strong><span>{item.route}</span><small>{item.purpose} · {item.vehicle}</small></div><div><strong>{money(item.amount)}</strong><span>{Number(item.km).toFixed(1)} km</span><small className="status">{item.status}</small></div></div>; }
function Stat({ label, value, detail, trend }) { return <div className="stat"><span>{label}</span><strong>{value}</strong><small>{detail}{trend && <b className="stat-trend">{trend}</b>}</small></div>; }
function TripDatePicker({ date, onChange, disabled }) { return <div className="trip-date-picker"><label>Trip date<input required type="date" value={date} onChange={(event) => onChange(event.target.value)} disabled={disabled} /></label></div>; }
function DashboardTripRow({ item }) {
  const completed = item.status === 'Completed';
  const settled = ['Approved', 'Batched for HR'].includes(item.status);
  const rejected = item.status === 'Rejected';
  const label = completed ? 'Completed' : settled ? 'Approved' : rejected ? 'Rejected' : 'Pending';
  const tone = completed ? 'orange' : settled ? 'green' : rejected ? 'red' : 'yellow';
  return <div className="dashboard-trip-row">
    <div>
      <strong>{item.purpose || 'Field trip'}</strong>
      <span>{item.route}</span>
      <small>{item.vehicle} {'·'} {item.date}</small>
    </div>
    <span>{Number(item.km).toFixed(1)} km</span>
    <span>{money(item.amount)}</span>
    <div className="status-columns"><small><b className={`pill ${tone}`}>{label}</b></small></div>
    <b className="row-arrow">{'›'}</b>
  </div>;
}

function LiveMap({ tracking }) { const fallback = [-1.2864, 36.8172]; const center = tracking.current ? [tracking.current.latitude, tracking.current.longitude] : fallback; return <MapContainer center={center} zoom={15} scrollWheelZoom className="live-map"><TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" /><MapRecenter center={center} /><MapTrack tracking={tracking} /></MapContainer>; }
function LocationPermissionNotice({ permission, onRequest }) {
  const blocked = BLOCKED_STATES.includes(permission);
  const canRequest = !UNFIXABLE_STATES.includes(permission);
  return <div className={`permission-note ${permission}`}>
    <span className="permission-icon" aria-hidden="true">{permission === 'granted' ? '◉' : blocked ? '⚠' : '◎'}</span>
    <p>{PERMISSION_COPY[permission] || PERMISSION_COPY.unknown}</p>
    {permission !== 'granted' && canRequest && <button type="button" onClick={onRequest}>{permission === 'denied' ? 'Check again' : 'Enable location'}</button>}
  </div>;
}
function JourneyForm({ trip, updateTrip, togglePurpose, tracking, onStart, onEnd, gpsMessage, rate, selectedVehicle, distance, total, permission, onRequestPermission }) {
  const [mapOpen, setMapOpen] = useState(true);
  const [armed, setArmed] = useState(false);
  const locationBlocked = BLOCKED_STATES.includes(permission);
  const readyToStart = trip.purposes.length > 0 && selectedVehicle && !locationBlocked;

  /**
   * Stopping takes two taps; starting takes one.
   *
   * A phone in a pocket on the back of a piki collects stray taps, and one of them
   * landing on Stop ends the journey with the distance measured so far and no way to
   * resume — the officer would have to claim a trip the app under-recorded. Arming first
   * means a stray tap only changes the label, and it disarms itself after a few seconds.
   *
   * Not ondblclick: mobile browsers fire it inconsistently, and it tells the person
   * nothing. This says what it wants.
   */
  useEffect(() => {
    if (!armed) return undefined;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  useEffect(() => { if (!tracking.active) setArmed(false); }, [tracking.active]);

  const journeyAction = () => {
    if (!tracking.active) { onStart(); return; }
    if (!armed) { setArmed(true); return; }
    setArmed(false);
    onEnd();
  };
  const actionLabel = tracking.active
    ? (armed ? 'Tap again to stop' : 'Stop & Submit')
    : 'Start Tracking Journey';
  const datePicker = <label className="trip-date-field">Trip date<input required type="date" value={trip.date} onChange={(event) => updateTrip('date', event.target.value)} disabled={tracking.active} /></label>;
  return <><section className="page-heading compact"><div><span className="kicker">Part 1 of 2</span><h1>Log a field trip</h1><p>Choose your reason and transport before starting your journey.</p></div></section><section className="form-card journey-card"><h2>Reason for trip</h2><p className="form-help">Select one or more reasons.</p><div className="choice-grid">{PURPOSES.map((purpose) => <label className={`choice ${trip.purposes.includes(purpose) ? 'chosen' : ''}`} key={purpose}><input type="checkbox" checked={trip.purposes.includes(purpose)} onChange={() => togglePurpose(purpose)} disabled={tracking.active} /><span>{purpose}</span></label>)}</div>{trip.purposes.includes('Other') && <Field label="Other reason" value={trip.otherPurpose} onChange={(value) => updateTrip('otherPurpose', value)} placeholder="Enter the reason" />}<label className="comment-field">Additional comment<textarea value={trip.comment} onChange={(event) => updateTrip('comment', event.target.value)} rows="3" placeholder="Add useful context" disabled={tracking.active} /></label><h2 className="section-title">Mode of transport</h2><div className="transport-options">{TRANSPORTS.map((mode) => <label className={`transport-option ${trip.transport === mode ? 'chosen' : ''}`} key={mode}><input type="radio" name="journey-transport" checked={trip.transport === mode} onChange={() => updateTrip('transport', mode)} disabled={tracking.active} /><span>{mode}</span></label>)}</div>{trip.transport === 'Personal means' && <div className="personal-options">{PERSONAL_TYPES.map((mode) => <label className={`transport-option ${trip.personalType === mode ? 'chosen' : ''}`} key={mode}><input type="radio" name="journey-personal-type" checked={trip.personalType === mode} onChange={() => updateTrip('personalType', mode)} disabled={tracking.active} /><span>Personal {mode}</span></label>)}</div>}{selectedVehicle && <div className="rate-notice">Rate: <strong>{money(rate)} per kilometre</strong></div>}<LocationPermissionNotice permission={permission} onRequest={onRequestPermission} /><div className="journey-live-panel"><div className="live-counter"><div><span>Distance</span><strong>{distance.toFixed(1)} km</strong></div><div><span>Status</span><strong>{tracking.active ? 'GPS Active • Tracking...' : locationBlocked ? 'Location unavailable' : 'Ready to track'}</strong></div></div><div className="journey-meta"><span>Start time <strong>{tracking.startTime ? new Date(tracking.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--'}</strong></span><span>Start coordinates <strong>{tracking.startCoordinates ? `${tracking.startCoordinates.latitude.toFixed(4)}, ${tracking.startCoordinates.longitude.toFixed(4)}` : '--'}</strong></span></div><button type="button" className="map-toggle" onClick={() => setMapOpen((open) => !open)}>{mapOpen ? 'Hide map preview' : 'Show map preview'} <span>{mapOpen ? '⌃' : '⌄'}</span></button>{mapOpen && <div className="map-shell"><LiveMap tracking={tracking} /></div>}</div>{gpsMessage && <p className="gps-message">{gpsMessage}</p>}<button type="button" className={`journey-primary ${tracking.active ? 'stop' : ''} ${armed ? 'armed' : ''}`} onClick={journeyAction} disabled={!tracking.active && !readyToStart}>{actionLabel}</button>{armed && <p className="journey-hint armed-hint">One more tap ends the journey and locks in {distance.toFixed(1)} km. Wait a moment and this cancels itself.</p>}{!tracking.active && !readyToStart && <p className="journey-hint">{locationBlocked ? 'Allow location access above before you can track a journey.' : 'Select a trip reason and mode of transport to begin.'}</p>}{!tracking.active && trip.end && <div className="trip-total"><span>Total kilometres <strong>{distance.toFixed(1)} km</strong></span><span>Total amount <strong>{money(total)}</strong></span></div>}</section></>;
}
function MapRecenter({ center }) { const map = useMap(); useEffect(() => { map.setView(center, Math.max(map.getZoom(), 15), { animate: true }); }, [center, map]); return null; }
function MapTrack({ tracking }) { return <>{tracking.route.length > 1 && <Polyline positions={tracking.route} pathOptions={{ color: '#168052', weight: 5 }} />}{tracking.current && <CircleMarker center={[tracking.current.latitude, tracking.current.longitude]} radius={9} pathOptions={{ color: '#fff', weight: 4, fillColor: '#168052', fillOpacity: 1 }} />}</>; }
function Field({ label, value, onChange, placeholder }) { return <label>{label}<input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label>; }
async function compressImage(file) { const allowed = ['image/jpeg', 'image/png', 'image/webp']; if (!allowed.includes(file.type)) throw new Error('Please choose a JPEG, PNG, or WebP image.'); const imageUrl = URL.createObjectURL(file); try { const image = await loadImage(imageUrl); let width = image.naturalWidth; let height = image.naturalHeight; let quality = 0.82; for (let attempt = 0; attempt < 8; attempt += 1) { const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; canvas.getContext('2d').drawImage(image, 0, 0, width, height); const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality)); if (blob && blob.size <= 500 * 1024) return { name: `${file.name.replace(/\.[^.]+$/, '')}.webp`, size: blob.size, dataUrl: await blobToDataUrl(blob) }; width = Math.round(width * 0.8); height = Math.round(height * 0.8); quality = Math.max(0.35, quality - 0.08); } throw new Error('This image could not be compressed below 500 KB.'); } finally { URL.revokeObjectURL(imageUrl); } }
function blobToDataUrl(blob) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('The compressed image could not be read.')); reader.readAsDataURL(blob); }); }
function loadImage(url) { return new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('The image could not be read.')); image.src = url; }); }
function formatFileSize(bytes) { return `${Math.max(1, Math.round(bytes / 1024))} KB`; }
function selectedRate(trip, rates = FALLBACK_RATES) { const vehicle = trip.transport === 'Personal means' ? `Personal ${trip.personalType}` : trip.transport; return money(rates[vehicle] || 0); }
function formatPoint(point) { return `${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}`; }
// Server claim -> the row shape the Overview and My Trips tables already render.
function toTripRow(claim) { return { id: claim.id, date: claim.tripDate || String(claim.submittedAt).slice(0, 10), route: claim.route || claim.zone || claim.region, purpose: claim.purpose, status: claim.status, amount: claim.amount, estimate: claim.estimate, km: claim.km, vehicle: claim.vehicle, submittedAt: claim.submittedAt }; }
function haversine(lat1, lon1, lat2, lon2) { const radians = (value) => value * Math.PI / 180; const dLat = radians(lat2 - lat1); const dLon = radians(lon2 - lon1); const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2; return Number((6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))).toFixed(1)); }
