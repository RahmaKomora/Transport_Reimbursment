# Songa backend

An Express API that reads staff profiles and budgets from a Google Sheet, routes
reimbursement claims through approval, and reports unspent budget per cycle.

## Running it

```bash
npm install
cp .env.example .env    # required — the app cannot run without sheet credentials
npm run dev:all         # web on :5174, api on :5175
```

`npm run dev:all` runs both servers. To run them separately use `npm run dev` (Vite) and
`npm run server` (Express). Vite proxies `/api` to port 5175, so the browser only ever
talks to one origin and there is no CORS configuration.

```bash
npm test                # routing, savings and session tests
```

## The sheet is the only source of truth

Roles, regions, manager assignments and budget ceilings are read from the Google Sheet and
are **never** stored in this repository. There is no fallback list and no local override:
if the sheet cannot be reached, the API answers `/api/health` and refuses everything else
with a `503` explaining what to configure.

This is deliberate. A checked-in list of users and roles is a list that can grant someone
an HR view because a credential was missing, and it drifts out of step with the sheet the
moment anyone edits it. Refusing to serve is the safe failure.

Sessions carry only an email. Role, region, managers and budgets are resolved from the
sheet on **every request**, against a short cache (`SONGA_SHEET_TTL_MS`, default 60s), so:

- a role granted in the sheet opens the matching view without the person signing out;
- a role revoked in the sheet closes it just as quickly;
- a budget edited mid-cycle applies to the next claim submitted.

`sheetConfig.js` owns that cache and exposes `fetchLatestSheetConfig()`, which forces a
re-read and reports what came back — staff count, a breakdown by role and region, and
warnings for rows that will behave oddly (no allowance, no ceiling, no manager). It is
wired to `POST /api/admin/refresh` and to the **Refresh Sheet Data** button on the HR
dashboard, and runs once at startup so the log shows what was loaded.

Tests drive the API through an injected in-memory transport (`setStoreForTests`), which is
a stand-in for the spreadsheet rather than a stored permission set — the running app has
no such list.

## Connecting the sheet: authorise as yourself (the route that works here)

One Acre Fund's Workspace policy closes both of the usual doors:

- **Service accounts** cannot be given access — sharing with `…iam.gserviceaccount.com`
  is refused by the domain allowlist.
- **Apps Script web apps** cannot be deployed for anonymous access — the dropdown offers
  only "Only myself" and "Anyone within One Acre Fund", and a server has no Google session.

So Songa authorises as a person instead. Whoever runs `npm run sheet:auth` already has
access to the sheet, so nothing is shared with a new identity and no admin is involved.

```bash
# once, in Google Cloud: Credentials > Create Credentials > OAuth client ID > Desktop app
# put the client id and secret in .env, then:
npm run sheet:auth      # opens a consent screen, stores a refresh token
npm run sheet:check     # confirms the whole chain
```

The refresh token lands in `.songa-token.json` (gitignored — it is a credential) and the
Google library keeps the access token fresh on its own. Re-run `sheet:auth` to switch
accounts or after revoking the grant.

**The trade-off, stated plainly:** every read and write is attributed to that person in
the sheet's revision history, and the server stops working if their account is disabled
or they revoke the authorisation at myaccount.google.com/permissions. That is acceptable
for a pilot. A service account is still the better long-term answer, so it is worth asking
IT to allowlist one before this carries real payment volume.

## Connecting the sheet: Apps Script bridge (blocked here)

One Acre Fund's Workspace policy forbids sharing files with addresses outside allowlisted
domains, and a service account lives on `…iam.gserviceaccount.com`, so the service account
route below is **blocked for this organisation** unless IT grants an exception.

The Apps Script bridge avoids the problem: the script lives inside the spreadsheet and
runs as its owner, so no outside identity is ever granted access. Setup is in the header
comment of [`appsScript/Code.gs`](appsScript/Code.gs) — paste the file into
Extensions > Apps Script, set a `SONGA_SECRET` script property, deploy as a Web app
("Execute as: Me", "Who has access: Anyone with the link"), then put the `/exec` URL and
the same secret in `.env` as `SONGA_APPS_SCRIPT_URL` and `SONGA_APPS_SCRIPT_SECRET`.

The script is deliberately dumb: it moves raw rows and knows nothing about roles, budgets
or approval rules, so the column mapping and business logic keep a single definition in
Node. `appsScriptTransport.js` speaks to it; `googleSheetsService.js` picks the transport
and does all the parsing, so nothing else in the codebase knows which one is in use.

Two things to treat as credentials: the `/exec` URL and the secret. "Anyone with the link"
means exactly that, so the shared secret is what actually protects the sheet — every
request carries it and the script rejects anything without it.

## Connecting the sheet: service account

1. In Google Cloud, create a service account and download its JSON key.
2. Share the spreadsheet with the service account's email address (the
   `client_email` in the key file) as an **Editor** — the app creates and writes a
   `Claims` tab.
3. Point `GOOGLE_APPLICATION_CREDENTIALS` at the key file, somewhere outside this repo.

The key file is a credential: anyone holding it can read and write the sheet. `.gitignore`
covers the usual filenames, but keep it out of the working tree entirely if you can.

An Apps Script web app is a workable alternative to a service account — everything the
rest of the app uses is behind the `googleSheetsService.js` interface, so swapping the
transport means reimplementing that one module.

## Sheet schema

Read from the `Users` tab, by column letter:

| Column | Field | Used for |
| --- | --- | --- |
| B | Names | Display |
| C | Email address | Identity, routing |
| D | Zone names | Display, grouping |
| E | Role | RBAC — free text, normalised to `field_agent` / `manager` / `hr` / `admin` |
| G | Region name | Regional grouping and savings rollup |
| H | Manager 1 email | First approver |
| J | Manager 2 email | Fallback approver |
| K | Transport - month | Monthly figure, held for reference |
| L | Transport per cycle | Auto-approval threshold and savings allocation |
| M | Extra allowable expenditure per cycle | Held for reference |
| N | Max possible exp per cycle | Hard ceiling; claims above it are blocked |
| P | Manager 1 OOO *(optional, added by this app)* | `TRUE`/`OOO` diverts to Manager 2 |

Claims are appended to a `Claims` tab, created on first write.

## Routing rules

Applied in order, in `routing.js`:

1. `amount > Max possible exp per cycle` → **blocked**, nothing is written.
2. `amount <= Transport per cycle` → **System Approved**, straight to HR for payment.
3. Otherwise → **Pending Manager Review**, assigned to Manager 1.

Two things divert a claim away from Manager 1 in step 3: the claimant *is* Manager 1, or
Manager 1 is flagged out of office. Both fall through to Manager 2, and to HR when there
is no Manager 2. Nobody can ever review their own claim, including admins.

## Cycles and HR batching

Cycles are half-months in Nairobi time (`cycles.js`), pinned to EAT so the boundary never
moves with the server's timezone:

| Cycle | Window | Sealed and sent to HR |
| --- | --- | --- |
| Cycle 1 | 1st – 15th | 16th, 08:00 EAT |
| Cycle 2 | 16th – last day | 1st of the next month, 08:00 EAT |

Approval is immediate: a claim becomes `Approved` the moment the system auto-approves it
or a manager signs it off, and carries the cycle it was submitted in. HR sees it straight
away in the **Live Active Queue**, read-only.

At the cycle boundary `cycleScheduler.js` seals the cycle: every `Approved` claim in it
becomes `Batched for HR`, and one summary grouped by region goes to HR. Only then does the
claim become payable. Paying from the open cycle is refused with an explanation rather
than silently ignored.

The batch runner is **idempotent** — a restart, a retry or an overlapping catch-up seals
nothing twice and sends no second notification. On startup the server also sweeps for
cycles whose 08:00 moment passed while it was asleep, which a locally hosted app routinely
is; without that a missed cron would strand a batch indefinitely.

To seal a cycle by hand — after a failure, or to demonstrate the flow without waiting for
the 16th:

```
POST /api/batches/run  { "cycleKey": "2026-09-C1" }          # a closed cycle
POST /api/batches/run  { "cycleKey": "2026-09-C2", "force": true }   # testing only
```

Set `SONGA_DISABLE_SCHEDULER=true` to run the API without the cron jobs.

### Notifications

`notifications.js` splits *what HR is told* (`buildBatchReport`, pure and tested) from
*how it is delivered* (`notifyHr`). **No mail transport is configured in this build**:
reports are written to `server/reports/batch-<cycle>.txt` and logged, so a batch is never
lost to a missing mailer. Wiring real email means replacing the body of `notifyHr` —
nothing else changes. Set `SONGA_HR_EMAILS` to the recipient list now so it is ready.

## Savings

`Saved = Transport per cycle - approved and paid claims`, floored at zero, per half-month
cycle. Nothing rolls over. Claims still awaiting a manager are excluded, since they may
yet be rejected.

## Known gaps

- **Budgets are checked per claim, not cumulatively.** Someone with a 6,000 cycle
  allowance can have a 5,000 claim auto-approved and then a 7,000 claim approved, ending
  the cycle at 12,000. This follows the rules as specified; the savings view exposes it as
  `overspend`. Deciding whether the ceiling applies to a single claim or to the cycle total
  is a policy question, and the check lives in one place (`routeClaim`) when you answer it.
- **Authentication is a local stand-in.** A login succeeds if the email exists in the
  sheet — there is no password and no identity provider. It is confined to `auth.js` and
  must be replaced with Google Workspace SSO before this handles real money.
- **Google Sheets is not a database.** Concurrent approvals can overwrite each other,
  because updating a claim means read-row-then-write-row with no locking. Fine for pilot
  volumes; not fine once several reviewers work the queue at once.
