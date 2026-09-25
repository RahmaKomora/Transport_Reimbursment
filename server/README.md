# Songa backend

An Express API that holds the staff directory and transport budgets, routes reimbursement
claims through approval, and reports unspent budget per region and per cycle.

## Running it

```bash
npm install
cp .env.example .env    # optional: Songa runs without it
npm run dev:all         # web on :5174, api on :5175
```

`npm run dev:all` runs both servers. To run them separately use `npm run dev` (Vite) and
`npm run server` (Express). Vite proxies `/api` to port 5175, so the browser only ever
talks to one origin and there is no CORS configuration.

```bash
npm test                # the whole suite, against throwaway database files
```

## Songa is the system of record

Staff, roles, approvers, allowances, transport rates and claims all live in Songa's own
database. **Nothing outside the app decides any of them.** Admins manage people in
*Admin → User roles* and per-region rates in *Admin → Transport rates*.

Songa was built against a Google Sheet and migrated off it. The spreadsheet still exists
as a historical copy, but its contents carry no authority and nothing in the running
server reads it. A difference between the two is the expected state, not a defect — see
[The spreadsheet is gone](#the-spreadsheet-is-gone) before you reach for a re-sync.

Sessions carry only an email. Role, region, approvers and budgets are resolved on **every
request** against a short cache (`SONGA_DIRECTORY_TTL_MS`, default 60s), so:

- a role granted by an admin opens the matching view without the person signing out;
- a role revoked closes it just as quickly;
- a budget edited mid-cycle applies to the next claim submitted.

`directory.js` owns that cache and exposes `reloadDirectory()`, which forces a rebuild and
reports what came back — staff count, a breakdown by role and region, and warnings for
records that will behave oddly (no allowance, no ceiling, no approver). It is wired to
`POST /api/admin/refresh` and the **Reload directory** button, and runs at startup so the
log shows what was loaded.

## Data layer

```
db.js        SQLite, and the only module that knows it.  all / get / run / tx
  store.js   people and claims
  rates.js   per-region rates and their change history
directory.js the sign-in directory, built from people + derived approvers, cached
```

Every query goes through `all` / `get` / `run` / `tx` in `db.js`. No other module imports
the driver, and all four are async even though SQLite answers immediately — see
[docs/postgres-migration.md](../docs/postgres-migration.md) for why, and for what a move
to Postgres still needs.

`node:sqlite` is in Node's standard library, so there is no dependency to install and no
server to run: one file at `server/data/songa.db`, with real transactions. Point
`SONGA_DB_PATH` elsewhere to use a different file; the tests each use their own.

Tests drive the API through an injected in-memory store (`setStoreForTests`). That is a
test double for the storage layer, not a stored permission set — an empty directory lets
nobody in rather than granting anyone a default role.

## Roles

Four roles, shown in the UI by their Keycloak-style identifiers:

| Role | Identifier | Can |
| --- | --- | --- |
| `field_agent` | `ke_asili_requester` | Submit claims, see their own history |
| `manager` | `ke_asili_approver` | Approve and reject claims, see team budgets |
| `hr` | `ke_asili_hr` | See every claim, complete payouts. **Not** approve |
| `admin` | `ke_asili_admin` | Everything, including the admin screens |

A person's role is normally read from their free-text job title: "Zone Supervisor" becomes
an approver, "HR Officer" becomes HR, anything unrecognised becomes a requester. That is
what keeps 1,400 people working without anyone assigning roles by hand.

Because the title is free text, an admin can also **set the role outright** in the person's
drawer, and that answer wins. This exists for titles Songa has never seen, which would
otherwise fall through to requester and silently lose someone the ability to approve. The
admin screen shows which of the two applied — a role that was set is marked "set manually",
because the next person to look needs to know the title is no longer the thing to fix.

Approvers who never claim usually have no record of their own: they exist because other
people name them as Manager 1 or Manager 2. `directory.js` synthesises a sign-in account
for each, so the same records define both populations. Those accounts carry no allowance
and cannot submit; their access follows the people they approve for.

## Routing rules

Applied against the claimant's **cycle ledger**, not against the single claim — `budget.js`
works out what is left of the allowance before `routing.js` decides:

1. `amount > what is left of the cycle maximum` → sent for review, flagged over budget.
2. `amount <= what is left of the base allowance` → **auto-approved**, straight to HR.
3. Otherwise (into the top-up) → **Pending Manager Review**, assigned to Manager 1.

The maximum is checked first on purpose. Asking "does it fit the allowance?" first would
let a misconfigured record whose maximum sits below its allowance auto-approve past its
own ceiling.

Two things divert a claim away from Manager 1 in step 3: the claimant *is* Manager 1, or
Manager 1 is flagged out of office. Both fall through to Manager 2. Nobody reviews their
own claim, including admins, and HR does not approve — approval is a manager's job.

An over-budget claim is **not blocked**. It is submitted, flagged, and sent to a manager,
because the money has already been spent in the field.

## Cycles and HR batching

Cycles are half-months in Nairobi time (`cycles.js`), pinned to EAT so the boundary never
moves with the server's timezone:

| Cycle | Window | Sealed and sent to HR |
| --- | --- | --- |
| Cycle 1 | 1st – 15th | 16th, 08:00 EAT |
| Cycle 2 | 16th – last day | 1st of the next month, 08:00 EAT |

Approval is immediate: a claim becomes `Approved` the moment it auto-approves or a manager
signs it off, and carries the cycle it was submitted in. HR sees it straight away in the
**Live Active Queue**, read-only.

At the cycle boundary `cycleScheduler.js` seals the cycle: every `Approved` claim in it
becomes `Batched for HR`, and one summary grouped by region goes to HR. Only then does the
claim become payable. Paying from the open cycle is refused with an explanation.

The batch runner is **idempotent** — a restart, a retry or an overlapping catch-up seals
nothing twice and sends no second notification. On startup the server sweeps for cycles
whose 08:00 moment passed while it was asleep, which a locally hosted app routinely is.

```
POST /api/batches/run  { "cycleKey": "2026-09-C1" }                 # a closed cycle
POST /api/batches/run  { "cycleKey": "2026-09-C2", "force": true }  # testing only
```

Set `SONGA_DISABLE_SCHEDULER=true` to run the API without the cron jobs.

### Notifications

`notifications.js` splits *what HR is told* (`buildBatchReport`, pure and tested) from
*how it is delivered* (`notifyHr`). **No mail transport is configured in this build**:
reports are written to `server/reports/batch-<cycle>.txt` and logged, so a batch is never
lost to a missing mailer. Wiring real email means replacing the body of `notifyHr`. Set
`SONGA_HR_EMAILS` to the recipient list now so it is ready.

## Budgets and savings

`Saved = base allowance − (approved + pending claims)`, floored at zero, per half-month
cycle. Nothing rolls over. Pending counts against the budget because the money has already
left someone's pocket; rejected does not.

*Admin → Regional budgets* shows allocation per region, then opens one region to show
where it went and who spent it. The same figures appear as a single wide table on the HR
overview, which suits scanning every region for claims about to miss the payment run.

Both exclude people who are deactivated or have no allowance, and say how many that is —
a roster of 1,400 showing a five-figure budget otherwise reads as a broken sum.

## The spreadsheet is gone

Songa was built against a Google Sheet, migrated off it, and the sheet tooling has since
been **deleted** — the Sheets client, the OAuth and Apps Script transports, the
diagnostics, and the one-off importer. Nothing in this repository reads or writes a
spreadsheet, and there is no Sheets dependency left to install.

The spreadsheet still exists in Drive as a historical copy. It has no authority over
anything here. If a record looks wrong, fix it in *Admin → User roles*; there is nothing
to re-sync from and no sync to run.

Should a fresh deployment ever need seeding from that old sheet, the importer is in git
history rather than in the working tree. Recovering it is deliberate work, which is the
point — re-importing over a live directory silently overwrote an admin's edits once.

`google-auth-library` remains a dependency, but only to verify Google Sign-In tokens in
`auth.js`. That is authenticating a person to Songa, not Songa to Google.

## Known gaps

- **Authentication is a local stand-in.** A login succeeds if the email is in the
  directory — no password, no identity provider. Google sign-in is built
  (`GoogleSignIn.jsx`, verified server-side) but switched off for the build phase by
  leaving `SONGA_GOOGLE_CLIENT_ID` unset. Turn it on before this handles real money.
- **Proof images are local.** `server/uploads/` on whichever machine served the request.
  Fine for a pilot, wrong for anything hosted.
- **No offline support.** A field officer out of signal cannot submit, and a tracked
  journey is lost if the tab closes. Persisting the GPS track and queueing submissions is
  the smaller half of fixing it.
- **The frontend has no tests.** The server suite is thorough; nothing exercises the React
  components.
