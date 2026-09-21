import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleMarker, MapContainer, Polyline, TileLayer, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import tupandeLogo from './assets/src/assets/tupande-logo.png';
import AccountClaim from './AccountClaim';
import LeafMark from './LeafMark';
import HrDashboard from './HrDashboard';
import { ManagerHome, TeamClaims } from './ManagerDashboard';
import { api, getToken } from './api';

const PURPOSES = ['Client Repayment', 'Duka Training/Group Events', 'Farmer Visit', 'Field Boundary Mapping', 'Group formation', 'Enrollment Campaign', 'Farmer Training', 'Cash Crop Scouting', 'Other'];
const TRANSPORTS = ['Piki', 'Matatu', 'Personal means'];
const PERSONAL_TYPES = ['Car', 'Piki'];
const RATES = { Piki: 25, Matatu: 35, Car: 45 };
const DEMO_USER = { password: '100', name: 'Rahie', email: 'rahie@oneacrefund.org' };
const starterTrips = [
  { id: 'SNG-101', date: '15 Aug', route: 'Mwea Hub -> Kibwezi', purpose: 'Farmer Visit', status: 'Pending review', amount: 8600, km: 28, vehicle: 'Piki' },
  { id: 'SNG-102', date: '12 Aug', route: 'Kagio -> Gichugu', purpose: 'Farmer Training', status: 'Approved', amount: 7400, km: 24, vehicle: 'Piki' },
  { id: 'SNG-103', date: '09 Aug', route: 'Embu Depot -> Mateka', purpose: 'Field Boundary Mapping', status: 'M-Pesa sent', amount: 9200, km: 31, vehicle: 'Matatu' },
];
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
  const [currentUser, setCurrentUser] = useState(DEMO_USER);
  const [budget, setBudget] = useState(null);
  const [submitError, setSubmitError] = useState('');
  const [teamStatus, setTeamStatus] = useState('All');
  const [view, setView] = useState('overview');
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [profileMessage, setProfileMessage] = useState('');
  const [trip, setTrip] = useState(emptyTrip);
  const [trips, setTrips] = useState([]);
  const [claim, setClaim] = useState({ code: '', email: DEMO_USER.email, name: '', proof: '', proofSize: 0, proofError: '', amount: '' });
  const [gpsMessage, setGpsMessage] = useState('');
  const [tracking, setTracking] = useState({ active: false, route: [], current: null, startTime: '', startCoordinates: null });
  const [permission, setPermission] = useLocationPermission();
  const watchId = useRef(null);
  const selectedVehicle = trip.transport === 'Personal means' ? trip.personalType : trip.transport;
  const rate = RATES[selectedVehicle] || 0;
  const distance = useMemo(() => tracking.route.length > 1 ? tracking.route.slice(1).reduce((totalDistance, point, index) => totalDistance + haversine(tracking.route[index][0], tracking.route[index][1], point[0], point[1]), 0) : 0, [tracking.route]);
  const total = Math.round(distance * rate);

  useEffect(() => () => { if (watchId.current !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId.current); }, []);

  // Restore an existing session on load so a refresh does not bounce the user to login.
  useEffect(() => {
    if (!getToken()) return;
    api.me()
      .then(({ user, budget: cycleBudget }) => { adoptUser(user); setBudget(cycleBudget); setIsAuthenticated(true); })
      .catch(() => api.logout());
  }, []);

  const adoptUser = (user) => {
    setCurrentUser(user);
    setClaim((current) => ({ ...current, email: user.email }));
    // Someone who only approves lands on their dashboard; claimants land on their own
    // overview. Otherwise an approver opens on a staff page that will always be empty.
    setView(user.isStaff ? 'overview' : (user.role === 'hr' || user.role === 'admin') ? 'hr' : 'review');
  };
  const refreshClaims = () => {
    api.myClaims().then((mine) => setTrips(mine.map(toTripRow))).catch(() => {});
    api.me().then(({ budget: cycleBudget }) => setBudget(cycleBudget)).catch(() => {});
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
  const startNewTrip = () => { setTrip({ ...emptyTrip }); setClaim({ code: '', email: currentUser.email, name: '', proof: '', proofSize: 0, proofError: '', amount: '' }); setGpsMessage(''); setTracking({ active: false, route: [], current: null, startTime: '', startCoordinates: null }); setView('trip'); };
  const submitClaim = async (event) => {
    event.preventDefault();
    setSubmitError('');
    if (!trip.date || !trip.start || !trip.end || !trip.purposes.length || !selectedVehicle || (trip.purposes.includes('Other') && !trip.otherPurpose.trim()) || !claim.code || !claim.email || !claim.name || !claim.proof || Number(claim.amount) <= 0) return;
    try {
      const { outcome } = await api.submitClaim({
        amount: Number(claim.amount), estimate: total, km: distance, rate, vehicle: selectedVehicle,
        tripDate: trip.date, purposes: trip.purposes, mpesaCode: claim.code, mpesaName: claim.name,
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
  const signOut = () => { if (watchId.current !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId.current); api.logout(); setBudget(null); setTrips([]); setIsAuthenticated(false); setProfileMenuOpen(false); setView('overview'); };
  if (!isAuthenticated) return <Login onLogin={async (email) => {
    const user = await api.login(email);
    adoptUser(user);
    setIsAuthenticated(true);
    api.me().then(({ budget: cycleBudget }) => setBudget(cycleBudget)).catch(() => {});
    api.myClaims().then((mine) => setTrips(mine.map(toTripRow))).catch(() => {});
  }} />;
    return <div className="app-shell"><SidePanel view={view} setView={setView} logo={tupandeLogo} profileMenuOpen={profileMenuOpen} setProfileMenuOpen={setProfileMenuOpen} onAction={handleProfileAction} onSignOut={signOut} user={currentUser} /><main className="main"><header className="mobile-header"><span className="logo-wrap small"><LeafMark size={22} /></span><strong>Songa</strong><button className="avatar">R</button></header><div className="content">
    {view === 'overview' && <Overview trips={trips} onNewTrip={startNewTrip} onTrips={() => setView('trips')} user={currentUser} />}
    {view === 'trips' && <Trips trips={trips} onNewTrip={startNewTrip} />}
    {view === 'claims' && <Trips trips={trips.filter((item) => item.status !== 'Completed')} onNewTrip={startNewTrip} claimsOnly />}
    {view === 'trip' && <><TripDatePicker date={trip.date} onChange={(value) => updateTrip('date', value)} disabled={tracking.active} /><JourneyForm trip={trip} updateTrip={updateTrip} togglePurpose={togglePurpose} tracking={tracking} onStart={startTracking} onEnd={endTracking} gpsMessage={gpsMessage} rate={rate} selectedVehicle={selectedVehicle} distance={distance} total={total} permission={permission} onRequestPermission={requestLocationAccess} /></>}
    {view === 'claim' && <AccountClaim trip={trip} claim={claim} setClaim={setClaim} distance={distance} total={total} rate={rate} vehicle={selectedVehicle} onSubmit={submitClaim} money={money} compressImage={compressImage} formatFileSize={formatFileSize} budget={budget} submitError={submitError} />}
    {view === 'review' && <ManagerHome money={money} user={currentUser} onOpenClaims={(status) => { setTeamStatus(status); setView('team'); }} />}
    {view === 'team' && <TeamClaims money={money} user={currentUser} initialStatus={teamStatus} />}
    {view === 'hr' && <HrDashboard money={money} />}
  </div>{profileMessage && <div className="profile-toast">{profileMessage}</div>}</main></div>;
}

// Navigation follows the role the sheet gives you. A claimant sees their workspace; an
// approver who does not claim sees only the approvals section, rather than staff pages
// that would always be empty for them.
function SidePanel({ view, setView, logo, profileMenuOpen, setProfileMenuOpen, onAction, onSignOut, user }) {
  const [logoBroken, setLogoBroken] = useState(false);
  const claims = user.isStaff !== false;
  const approves = user.role === 'manager' || user.role === 'admin';
  const isHr = user.role === 'hr' || user.role === 'admin';
  const home = claims ? 'overview' : isHr ? 'hr' : 'review';
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
      {link('team', '✓', 'My Team’s Claims')}</>}
    {isHr && <><p className="side-label">HR</p>
      {link('hr', '❑', 'Reimbursements')}</>}
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
// Sign-in is by work email alone: the sheet is the list of who exists, and there is no
// password store. A password box that accepts anything would imply a check that is not
// happening, so there is none. Workspace SSO is the intended replacement.
function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    const address = email.trim().toLowerCase();
    if (!address.includes('@')) { setMessage('Enter your work email address.'); return; }
    setBusy(true);
    setMessage('Checking the staff sheet...');
    try {
      await onLogin(address);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };
  return <div className="login-page"><form className="login-card" onSubmit={submit}>
    <div className="login-brand"><span className="login-lettermark" aria-hidden="true">S</span><div><small>Tupande</small><strong>Songa</strong></div></div>
    <h1>Welcome back</h1>
    <p>Sign in with your work email to log trips and submit reimbursements.</p>
    <label>Work email<input required autoFocus type="email" value={email} onChange={(event) => { setEmail(event.target.value); setMessage(''); }} placeholder="name@oneacrefund.org" autoComplete="email" /></label>
    {message && <p className={message.startsWith('Checking') ? 'login-note' : 'login-error'}>{message}</p>}
    <button className="button primary full" type="submit" disabled={busy}>{busy ? 'Signing in...' : 'Sign in'}</button>
    <small className="demo-note">Songa recognises you from the staff sheet, so there is no password yet.</small>
  </form></div>;
}
// Every figure here comes from the claims the server returned. The earlier version
// padded them with invented constants, which meant a brand new account opened on a
// dashboard reporting trips and payments that had never happened.
function Overview({ trips, onNewTrip, onTrips, user }) {
  const paid = trips.filter((item) => item.status === 'Payment Sent');
  const pending = trips.filter((item) => item.status === 'Pending Manager Review');
  const approved = trips.filter((item) => ['Approved', 'Batched for HR', 'Payment Sent'].includes(item.status));
  const sum = (rows) => rows.reduce((total, item) => total + (Number(item.amount) || 0), 0);
  const distance = trips.reduce((total, item) => total + (Number(item.km) || 0), 0);
  const firstName = (user?.name || '').trim().split(' ')[0] || 'there';
  return <>
    <section className="page-heading"><div>
      <span className="kicker">Overview</span>
      <h1>Hello {firstName}</h1>
      <p>Your field movement and reimbursement activity at a glance.</p>
    </div><button className="button primary" onClick={onNewTrip}>Log new field trip</button></section>
    <section className="stats dashboard-stats">
      <Stat label="Trips logged" value={trips.length} detail="All time" />
      <Stat label="Pending claims" value={money(sum(pending))} detail={`${pending.length} awaiting review`} />
      <Stat label="Distance covered" value={`${distance.toFixed(1)} km`} detail={`${trips.length} field visit${trips.length === 1 ? '' : 's'}`} />
      <Stat label="Reimbursement paid" value={money(sum(paid))} detail={`${paid.length} sent by M-Pesa`} />
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
function DashboardTripRow({ item }) { const approved = item.status === 'Approved' || item.status === 'M-Pesa sent'; const submittedLabel = item.submittedAt ? 'Just now' : item.date; return <div className="dashboard-trip-row"><div><strong>{item.id}</strong><span>{item.route}</span><small>{item.purpose} · {item.vehicle} · {submittedLabel}</small></div><span>{Number(item.km).toFixed(1)} km</span><span>{money(item.amount)}</span><div className="status-columns"><small>Approval <b className={approved ? 'pill green' : 'pill yellow'}>{item.status === 'M-Pesa sent' ? 'Approved' : item.status}</b></small><small>Payment <b className={`pill ${item.status === 'M-Pesa sent' ? 'blue' : 'gray'}`}>{item.status === 'M-Pesa sent' ? 'Payment sent' : 'Not paid'}</b></small></div><b className="row-arrow">›</b></div>; }

function TripForm({ trip, updateTrip, togglePurpose, tracking, onStart, onEnd, gpsMessage, rate, selectedVehicle, distance, total, onContinue }) {
  const valid = trip.purposes.length && trip.start && trip.end && selectedVehicle && (!trip.purposes.includes('Other') || trip.otherPurpose.trim());
  const continueToClaim = () => {
    if (!trip.end) return;
    if (!trip.purposes.length) { onContinue('Select at least one trip reason.'); return; }
    if (!selectedVehicle) { onContinue('Select a mode of transport to apply the rate.'); return; }
    if (trip.purposes.includes('Other') && !trip.otherPurpose.trim()) { onContinue('Enter the other trip reason.'); return; }
    onContinue();
  };
  return <><section className="page-heading compact"><div><span className="kicker">Part 1 of 2</span><h1>Log a field trip</h1><p>Choose your trip details, then track the journey like a ride-hailing app.</p></div></section><section className="form-card"><h2>Main Reason for this Trip</h2><p className="form-help">You can select more than one.</p><div className="choice-grid">{PURPOSES.map((purpose) => <label className={`choice ${trip.purposes.includes(purpose) ? 'chosen' : ''}`} key={purpose}><input type="checkbox" checked={trip.purposes.includes(purpose)} onChange={() => togglePurpose(purpose)} /><span>{purpose}</span></label>)}</div>{trip.purposes.includes('Other') && <Field label="Other reason" value={trip.otherPurpose} onChange={(value) => updateTrip('otherPurpose', value)} placeholder="Enter the reason" />}<label className="comment-field">Additional comment<textarea value={trip.comment} onChange={(event) => updateTrip('comment', event.target.value)} rows="3" placeholder="Add useful context" /></label><h2 className="section-title">Mode of transport</h2><div className="transport-options">{TRANSPORTS.map((mode) => <label className={`transport-option ${trip.transport === mode ? 'chosen' : ''}`} key={mode}><input type="radio" name="transport" checked={trip.transport === mode} onChange={() => updateTrip('transport', mode)} /><span>{mode}</span></label>)}</div>{trip.transport === 'Personal means' && <div className="personal-options">{PERSONAL_TYPES.map((mode) => <label className={`transport-option ${trip.personalType === mode ? 'chosen' : ''}`} key={mode}><input type="radio" name="personalType" checked={trip.personalType === mode} onChange={() => updateTrip('personalType', mode)} /><span>Personal {mode}</span></label>)}</div>}{selectedVehicle && <div className="rate-notice">Rate: <strong>{money(rate)} per kilometre</strong></div>}<h2 className="section-title">Live journey</h2><div className="map-shell"><LiveMap tracking={tracking} /></div><div className="gps-actions"><button className="start-point-button" type="button" onClick={onStart} disabled={tracking.active}>{tracking.active ? 'TRACKING LIVE' : 'START POINT'}</button><button className="end-point-button" type="button" onDoubleClick={onEnd} disabled={!tracking.active}>{trip.end ? 'TRIP ENDED' : 'DOUBLE-CLICK END POINT'}</button></div>{gpsMessage && <p className="gps-message">{gpsMessage}</p>}{trip.start && trip.end && <div className="trip-total"><span>Total kilometres <strong>{distance.toFixed(1)} km</strong></span><span>Total amount <strong>{money(total)}</strong></span></div>}<button className="button primary align-right" onClick={continueToClaim} disabled={!trip.end}>Continue to M-Pesa submission</button></section></>; }
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
  const locationBlocked = BLOCKED_STATES.includes(permission);
  const readyToStart = trip.purposes.length > 0 && selectedVehicle && !locationBlocked;
  const journeyAction = tracking.active ? onEnd : onStart;
  const actionLabel = tracking.active ? 'Stop & Submit' : 'Start Tracking Journey';
  const datePicker = <label className="trip-date-field">Trip date<input required type="date" value={trip.date} onChange={(event) => updateTrip('date', event.target.value)} disabled={tracking.active} /></label>;
  return <><section className="page-heading compact"><div><span className="kicker">Part 1 of 2</span><h1>Log a field trip</h1><p>Choose your reason and transport before starting your journey.</p></div></section><section className="form-card journey-card"><h2>Reason for trip</h2><p className="form-help">Select one or more reasons.</p><div className="choice-grid">{PURPOSES.map((purpose) => <label className={`choice ${trip.purposes.includes(purpose) ? 'chosen' : ''}`} key={purpose}><input type="checkbox" checked={trip.purposes.includes(purpose)} onChange={() => togglePurpose(purpose)} disabled={tracking.active} /><span>{purpose}</span></label>)}</div>{trip.purposes.includes('Other') && <Field label="Other reason" value={trip.otherPurpose} onChange={(value) => updateTrip('otherPurpose', value)} placeholder="Enter the reason" />}<label className="comment-field">Additional comment<textarea value={trip.comment} onChange={(event) => updateTrip('comment', event.target.value)} rows="3" placeholder="Add useful context" disabled={tracking.active} /></label><h2 className="section-title">Mode of transport</h2><div className="transport-options">{TRANSPORTS.map((mode) => <label className={`transport-option ${trip.transport === mode ? 'chosen' : ''}`} key={mode}><input type="radio" name="journey-transport" checked={trip.transport === mode} onChange={() => updateTrip('transport', mode)} disabled={tracking.active} /><span>{mode}</span></label>)}</div>{trip.transport === 'Personal means' && <div className="personal-options">{PERSONAL_TYPES.map((mode) => <label className={`transport-option ${trip.personalType === mode ? 'chosen' : ''}`} key={mode}><input type="radio" name="journey-personal-type" checked={trip.personalType === mode} onChange={() => updateTrip('personalType', mode)} disabled={tracking.active} /><span>Personal {mode}</span></label>)}</div>}{selectedVehicle && <div className="rate-notice">Rate: <strong>{money(rate)} per kilometre</strong></div>}<LocationPermissionNotice permission={permission} onRequest={onRequestPermission} /><div className="journey-live-panel"><div className="live-counter"><div><span>Distance</span><strong>{distance.toFixed(1)} km</strong></div><div><span>Status</span><strong>{tracking.active ? 'GPS Active • Tracking...' : locationBlocked ? 'Location unavailable' : 'Ready to track'}</strong></div></div><div className="journey-meta"><span>Start time <strong>{tracking.startTime ? new Date(tracking.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--'}</strong></span><span>Start coordinates <strong>{tracking.startCoordinates ? `${tracking.startCoordinates.latitude.toFixed(4)}, ${tracking.startCoordinates.longitude.toFixed(4)}` : '--'}</strong></span></div><button type="button" className="map-toggle" onClick={() => setMapOpen((open) => !open)}>{mapOpen ? 'Hide map preview' : 'Show map preview'} <span>{mapOpen ? '⌃' : '⌄'}</span></button>{mapOpen && <div className="map-shell"><LiveMap tracking={tracking} /></div>}</div>{gpsMessage && <p className="gps-message">{gpsMessage}</p>}<button type="button" className={`journey-primary ${tracking.active ? 'stop' : ''}`} onClick={journeyAction} disabled={!tracking.active && !readyToStart}>{actionLabel}</button>{!tracking.active && !readyToStart && <p className="journey-hint">{locationBlocked ? 'Allow location access above before you can track a journey.' : 'Select a trip reason and mode of transport to begin.'}</p>}{!tracking.active && trip.end && <div className="trip-total"><span>Total kilometres <strong>{distance.toFixed(1)} km</strong></span><span>Total amount <strong>{money(total)}</strong></span></div>}</section></>;
}
function MapRecenter({ center }) { const map = useMap(); useEffect(() => { map.setView(center, Math.max(map.getZoom(), 15), { animate: true }); }, [center, map]); return null; }
function MapTrack({ tracking }) { return <>{tracking.route.length > 1 && <Polyline positions={tracking.route} pathOptions={{ color: '#168052', weight: 5 }} />}{tracking.current && <CircleMarker center={[tracking.current.latitude, tracking.current.longitude]} radius={9} pathOptions={{ color: '#fff', weight: 4, fillColor: '#168052', fillOpacity: 1 }} />}</>; }
function Field({ label, value, onChange, placeholder }) { return <label>{label}<input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label>; }
function Claim({ trip, claim, setClaim, distance, total, onSubmit }) { const ready = trip.start && trip.end && trip.purposes.length && trip.transport && claim.code.trim() && claim.phone.trim() && claim.name.trim() && claim.proof.trim() && !claim.proofError && Number(claim.amount) > 0; const updateClaim = (field, value) => setClaim((current) => ({ ...current, [field]: value })); const handleProof = async (event) => { const file = event.target.files?.[0]; if (!file) return; updateClaim('proofError', ''); updateClaim('proof', ''); try { const compressed = await compressImage(file); setClaim((current) => ({ ...current, proof: compressed.name, proofSize: compressed.size, proofError: '' })); } catch (error) { setClaim((current) => ({ ...current, proof: '', proofSize: 0, proofError: error.message })); event.target.value = ''; } }; return <><section className="page-heading compact"><div><span className="kicker">Part 2 of 2</span><h1>M-Pesa submission</h1><p>Fill every field and attach proof of payment before submitting.</p></div></section><form className="claim-layout" onSubmit={onSubmit}><div className="form-card"><h2>Proof of payment</h2><label>M-Pesa transaction code<input required value={claim.code} onChange={(event) => updateClaim('code', event.target.value.toUpperCase())} placeholder="e.g. QWE123ABC" style={{ textTransform: 'uppercase' }} /></label><label>Phone number<div className="phone-input"><span>+254</span><input required type="tel" inputMode="numeric" value={claim.phone.replace(/^\+?254/, '')} onChange={(event) => updateClaim('phone', event.target.value.replace(/\D/g, '').slice(0, 9))} placeholder="712345678" /></div></label><label>Name on M-Pesa account<input required value={claim.name} onChange={(event) => updateClaim('name', event.target.value)} placeholder="Full name" /></label><label>Amount (KES)<input required type="number" min="1" step="1" value={claim.amount} onChange={(event) => updateClaim('amount', event.target.value)} placeholder="Enter amount" /></label><label>Proof of payment<input required type="file" accept="image/jpeg,image/png,image/webp" onChange={handleProof} /><small className="file-help">JPEG, PNG or WebP. Images are compressed to 500 KB or less.</small></label>{claim.proof && <p className="file-success">{claim.proof} ready ({formatFileSize(claim.proofSize)})</p>}{claim.proofError && <p className="file-error">{claim.proofError}</p>}<div className="claim-summary"><span>{trip.purposes.join(', ')}</span><span>{distance.toFixed(1)} km at {selectedRate(trip)} / km</span></div><button className="button primary align-right" type="submit" disabled={!ready}>Submit reimbursement</button></div><aside className="total-card"><span>GPS calculated total</span><strong>{money(total)}</strong><small>Enter the amount to claim above. This reference is based on the captured GPS distance and selected transport rate.</small></aside></form></>; }
async function compressImage(file) { const allowed = ['image/jpeg', 'image/png', 'image/webp']; if (!allowed.includes(file.type)) throw new Error('Please choose a JPEG, PNG, or WebP image.'); const imageUrl = URL.createObjectURL(file); try { const image = await loadImage(imageUrl); let width = image.naturalWidth; let height = image.naturalHeight; let quality = 0.82; for (let attempt = 0; attempt < 8; attempt += 1) { const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; canvas.getContext('2d').drawImage(image, 0, 0, width, height); const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality)); if (blob && blob.size <= 500 * 1024) return { name: `${file.name.replace(/\.[^.]+$/, '')}.webp`, size: blob.size }; width = Math.round(width * 0.8); height = Math.round(height * 0.8); quality = Math.max(0.35, quality - 0.08); } throw new Error('This image could not be compressed below 500 KB.'); } finally { URL.revokeObjectURL(imageUrl); } }
function loadImage(url) { return new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('The image could not be read.')); image.src = url; }); }
function formatFileSize(bytes) { return `${Math.max(1, Math.round(bytes / 1024))} KB`; }
function selectedRate(trip) { const vehicle = trip.transport === 'Personal means' ? trip.personalType : trip.transport; return money(RATES[vehicle] || 0); }
function formatPoint(point) { return `${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}`; }
// Server claim -> the row shape the Overview and My Trips tables already render.
function toTripRow(claim) { return { id: claim.id, date: claim.tripDate || String(claim.submittedAt).slice(0, 10), route: claim.route || claim.zone || claim.region, purpose: claim.purpose, status: claim.status, amount: claim.amount, estimate: claim.estimate, km: claim.km, vehicle: claim.vehicle, submittedAt: claim.submittedAt }; }
function haversine(lat1, lon1, lat2, lon2) { const radians = (value) => value * Math.PI / 180; const dLat = radians(lat2 - lat1); const dLon = radians(lon2 - lon1); const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2; return Number((6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))).toFixed(1)); }
