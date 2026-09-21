import express from 'express';
import { randomUUID } from 'node:crypto';
import { PORT } from './config.js';
import { allUsers, findUserByEmail, requireRole, requireUser, signIn } from './auth.js';
import { appendClaim, isLive, readClaims, updateClaim } from './googleSheetsService.js';
import { PAID_STATUSES, STATUS, applyDecision, canAct, routeClaim, statusCounts, visibleToManager } from './routing.js';
import { cycleOf, groupByRegion, savingsByRegion, savingsForUser, savingsTotals } from './savings.js';
import { getCycleDetails } from './cycles.js';
import { catchUpMissedBatches, runBatch, startScheduler } from './cycleScheduler.js';
import { fetchLatestSheetConfig, syncStatus } from './sheetConfig.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

app.get('/api/health', wrap(async (_req, res) => {
  const cycle = getCycleDetails();
  const configured = await isLive();
  res.json({
    ok: configured,
    sheets: configured ? 'connected' : 'not configured',
    sync: syncStatus(),
    cycle: { key: cycle.key, label: cycle.label, range: cycle.range, closesAt: cycle.batchAt.toISOString() },
  });
}));

// Forces a re-read of the staff sheet. Behind the "Refresh Sheet Data" button, and worth
// calling after a bulk edit rather than waiting for the cache to age out.
app.post('/api/admin/refresh', requireUser, requireRole('hr', 'admin'), wrap(async (_req, res) => {
  const result = await fetchLatestSheetConfig();
  res.status(result.ok ? 200 : 503).json(result);
}));

app.get('/api/admin/config', requireUser, requireRole('hr', 'admin'), wrap(async (_req, res) => {
  res.json({ sync: syncStatus(), sheets: (await isLive()) ? 'connected' : 'not configured' });
}));

app.post('/api/auth/login', wrap(async (req, res) => {
  const result = await signIn(req.body?.email);
  if (!result.ok) return res.status(401).json({ error: result.error });
  return res.json({ token: result.token, user: publicUser(result.user) });
}));

app.get('/api/me', requireUser, wrap(async (req, res) => {
  const claims = await readClaims();
  const cycle = cycleOf();
  res.json({ user: publicUser(req.user), budget: savingsForUser(req.user, claims, cycle), cycle });
}));

// What a claim would do before it is committed, so the form can warn about the cycle
// ceiling while the user is still typing rather than after they hit submit.
app.post('/api/claims/preview', requireUser, wrap(async (req, res) => {
  res.json(routeClaim({ amount: Number(req.body?.amount), user: req.user }));
}));

app.post('/api/claims', requireUser, wrap(async (req, res) => {
  const body = req.body || {};
  // Approvers exist in the directory because the manager columns name them, not because
  // they are claimants. They carry no allowance, so a claim from them would be uncapped.
  if (!req.user.isStaff) {
    return res.status(403).json({ error: 'Your account approves claims but does not submit them. To claim transport, ask HR to add you to the staff sheet with a transport allowance.' });
  }
  const outcome = routeClaim({ amount: Number(body.amount), user: req.user });
  if (outcome.blocked) return res.status(422).json({ error: outcome.reason, outcome });

  const claim = {
    id: `SNG-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 4)}`,
    submittedAt: new Date().toISOString(),
    submittedBy: req.user.email,
    staffName: req.user.name,
    region: req.user.region,
    zone: req.user.zone,
    tripDate: body.tripDate || '',
    purpose: Array.isArray(body.purposes) ? body.purposes.join(', ') : (body.purpose || ''),
    vehicle: body.vehicle || '',
    km: Number(body.km) || 0,
    rate: Number(body.rate) || 0,
    estimate: Number(body.estimate) || 0,
    amount: Number(body.amount),
    route: body.route || '',
    cycleKey: getCycleDetails().key,
    approvalSource: outcome.approvalSource || '',
    status: outcome.status,
    assignedTo: outcome.assignedTo,
    decisionLog: [{ actor: 'system', action: 'submitted', note: outcome.reason, at: new Date().toISOString() }],
  };

  await appendClaim(claim);
  res.status(201).json({ claim, outcome });
}));

app.get('/api/claims/mine', requireUser, wrap(async (req, res) => {
  const claims = await readClaims();
  res.json(claims.filter((claim) => claim.submittedBy === req.user.email).sort(newestFirst));
}));

/**
 * The manager dashboard feed: every claim in this approver's patch, whatever its status,
 * so the summary cards can show pending, approved and rejected side by side.
 *
 * Scoping happens here rather than in the browser. A regional manager is never sent
 * another region's claims, so no filter choice in the UI can widen what they see.
 */
app.get('/api/claims/manager', requireUser, requireRole('manager', 'hr', 'admin'), wrap(async (req, res) => {
  const claims = await readClaims();
  const scoped = visibleToManager(claims, req.user).sort(newestFirst);
  const global = req.user.role === 'hr' || req.user.role === 'admin';
  res.json({
    scope: {
      global,
      // The regions this person is answerable for, which drives the default filter.
      regions: global ? [...new Set(claims.map((claim) => claim.region).filter(Boolean))].sort() : (req.user.regions || []).slice().sort(),
      name: req.user.name,
      currentCycle: getCycleDetails().key,
    },
    // Regions actually present in their claims, so the dropdown never offers an empty one.
    regionsInView: [...new Set(scoped.map((claim) => claim.region).filter(Boolean))].sort(),
    counts: statusCounts(scoped),
    claims: scoped,
  });
}));

// Kept for the older accordion view: only what is waiting on this person right now.
app.get('/api/claims/review', requireUser, requireRole('manager', 'hr', 'admin'), wrap(async (req, res) => {
  const claims = await readClaims();
  const pending = claims.filter((claim) => claim.status === STATUS.PENDING_MANAGER && isForReviewer(claim, req.user));
  res.json({ regions: groupByRegion(pending.sort(newestFirst)), count: pending.length });
}));

// Live Active Queue: approved in the cycle that is still open. Read-only — these are not
// payable until the cycle closes and the scheduler seals them into a batch.
app.get('/api/claims/live', requireUser, requireRole('hr', 'admin'), wrap(async (req, res) => {
  const cycle = getCycleDetails();
  const claims = await readClaims();
  const live = claims.filter((claim) => claim.status === STATUS.APPROVED && (claim.cycleKey || cycleOf(claim.submittedAt)) === cycle.key);
  res.json({
    cycle: { key: cycle.key, label: cycle.label, range: cycle.range, closesAt: cycle.batchAt.toISOString() },
    regions: groupByRegion(live.sort(newestFirst)),
    count: live.length,
    total: live.reduce((sum, claim) => sum + claim.amount, 0),
  });
}));

// Ready for Payment: sealed batches from cycles that have closed, grouped by cycle so a
// batch reads as one payment run rather than a flat list.
app.get('/api/claims/approved', requireUser, requireRole('hr', 'admin'), wrap(async (req, res) => {
  const claims = await readClaims();
  const batched = claims.filter((claim) => claim.status === STATUS.BATCHED_FOR_HR);
  const byCycle = new Map();
  for (const claim of batched) {
    const key = claim.cycleKey || cycleOf(claim.submittedAt);
    if (!byCycle.has(key)) byCycle.set(key, []);
    byCycle.get(key).push(claim);
  }
  const batches = [...byCycle.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([key, items]) => {
      const cycle = getCycleDetails(items[0].submittedAt);
      return { cycleKey: key, label: cycle.label, range: cycle.range, count: items.length, total: items.reduce((sum, claim) => sum + claim.amount, 0), regions: groupByRegion(items.sort(newestFirst)) };
    });
  res.json({ batches, count: batched.length });
}));

app.get('/api/claims/paid', requireUser, requireRole('hr', 'admin'), wrap(async (req, res) => {
  const claims = await readClaims();
  const paid = claims.filter((claim) => PAID_STATUSES.includes(claim.status));
  res.json({ regions: groupByRegion(paid.sort(newestFirst)), count: paid.length });
}));

app.get('/api/analytics/savings', requireUser, requireRole('hr', 'admin'), wrap(async (req, res) => {
  const cycle = req.query.cycle || cycleOf();
  const [users, claims] = await Promise.all([allUsers(), readClaims()]);
  // Only claimants hold an allowance, so approvers would otherwise show as zero-budget staff.
  const regions = savingsByRegion(users.filter((user) => user.isStaff), claims, cycle);
  res.json({ cycle, regions, totals: savingsTotals(regions) });
}));

// Manual batch trigger. The scheduler seals cycles on its own; this exists so a batch can
// be re-run after a failure, and so the flow can be demonstrated without waiting for the
// 16th. `force` seals a cycle that has not closed yet and is for testing only.
app.post('/api/batches/run', requireUser, requireRole('hr', 'admin'), wrap(async (req, res) => {
  const { cycleKey, force } = req.body || {};
  const result = await runBatch(cycleKey || getCycleDetails().key, { force: Boolean(force) });
  res.status(result.ok ? 200 : 422).json(result);
}));

app.post('/api/claims/:id/decision', requireUser, wrap(async (req, res) => {
  const { action, note } = req.body || {};
  const claims = await readClaims();
  const claim = claims.find((item) => item.id === req.params.id);
  if (!claim) return res.status(404).json({ error: 'Claim not found.' });

  const permission = canAct(req.user, claim, action);
  if (!permission.allowed) return res.status(403).json({ error: permission.reason });

  const updated = await updateClaim(claim.id, (current) => applyDecision(current, { actor: req.user.email, action, note }));
  return res.json({ claim: updated });
}));

app.use((error, _req, res, _next) => {
  // A missing or unreachable sheet is a configuration problem the operator can fix, so say
  // so plainly instead of returning a generic 500.
  if (error.status === 503) return res.status(503).json({ error: error.message });
  console.error('[api]', error);
  return res.status(500).json({ error: 'Something went wrong on the server.' });
});

function isForReviewer(claim, user) {
  if (user.role === 'admin') return true;
  if (claim.assignedTo === user.email) return true;
  return claim.assignedTo === 'hr' && user.role === 'hr';
}

function newestFirst(a, b) {
  return String(b.submittedAt).localeCompare(String(a.submittedAt));
}

function publicUser(user) {
  const { manager1Email, manager2Email, ...rest } = user;
  return { ...rest, manager1Email, manager2Email, isOwnFirstApprover: user.email === manager1Email };
}

export async function start(port = PORT) {
  const cycle = getCycleDetails();
  const connected = await isLive();
  const server = app.listen(port, () => {
    console.log(`Songa API on http://localhost:${port}`);
    console.log(`[cycle] ${cycle.label}, ${cycle.range} — closes ${cycle.batchAt.toISOString()}`);
  });

  if (!connected) {
    console.warn('\n[sheet] NOT CONNECTED. Songa reads every role, budget and manager assignment from the');
    console.warn('[sheet] Google Sheet, and there is no local fallback by design. Set');
    console.warn('[sheet] GOOGLE_APPLICATION_CREDENTIALS and share the sheet with the service account.');
    console.warn('[sheet] Until then the API answers /api/health and refuses everything else with a 503.\n');
    return server;
  }

  const config = await fetchLatestSheetConfig();
  if (config.ok) {
    console.log(`[sheet] ${config.userCount} staff loaded — roles: ${JSON.stringify(config.roles)}`);
    for (const warning of config.warnings) console.warn(`[sheet] ${warning.issue}: ${warning.emails.join(', ')}`);
  } else {
    console.error(`[sheet] could not be read: ${config.error}`);
  }

  if (process.env.SONGA_DISABLE_SCHEDULER === 'true') {
    console.log('[batch] scheduler disabled by SONGA_DISABLE_SCHEDULER');
    return server;
  }
  startScheduler();
  // A locally hosted server is often asleep at 08:00, so recover anything the cron missed.
  catchUpMissedBatches().catch((error) => console.error('[batch] catch-up failed:', error));
  return server;
}

// Only listen when run directly, so tests can import the app and drive it themselves.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  start();
}

export { app };
