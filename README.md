# Songa

Songa is Tupande's field transport reimbursement app. A field officer logs a trip with live
GPS, attaches the M-Pesa receipt for what they paid, and submits a claim. Songa checks the
claim against the officer's allowance and the evidence, approves it on the spot or sends it
to their manager, and hands approved claims to HR for payment at the end of each cycle.

It is a React app (`src/`) in front of an Express API (`server/`) on Postgres, with SQLite
for local development and the test suite.

## Who uses it

| Role | Shown as | Does |
| --- | --- | --- |
| Requester | `ke_asili_requester` | Logs trips and submits claims; sees their own history |
| Approver | `ke_asili_approver` | Approves and rejects claims for their team and region; sees team budgets |
| HR | `ke_asili_hr` | Sees every claim, marks approved claims paid, exports for Finance. Does not approve |
| Admin | `ke_asili_admin` | Everything, plus the admin screens: user roles, transport rates, regional budgets |

A role is read from the person's job title ("Field Manager" is an approver), and an admin
can set it outright in User Roles when a title reads wrong. About 1,400 staff are in the
directory; each has an allowance per cycle, an optional top-up, a cycle maximum and up to
two approvers.

## How a claim works

1. **Log the trip.** Choose one or more reasons (with an explanation if one is "Other"), a
   mode of transport and an optional comment, then **Start Tracking Journey**. The phone's
   GPS draws the route and counts the distance.
2. **Stop.** Two taps on **Stop & Submit**, so a bump in a pocket does not end the trip.
3. **M-Pesa details.** The ten-character transaction code, the amount paid, the date paid
   and a screenshot of the confirmation. The Claim Overview shows the **expected cost** —
   the tracked distance at the region's rate — next to what was paid.
4. **Submit.** Songa decides at once:

| What Songa finds | What happens |
| --- | --- |
| No distance tracked | Refused: there is no trip to claim |
| Payment date in the future | Refused |
| Fits the remaining cycle allowance, and nothing below applies | **Approved automatically** |
| Paid more than the expected cost | Sent to the manager, with the reason |
| Paid more than a day away from the trip date | Sent to the manager, with the reason |
| Needs the top-up, or goes past the cycle maximum | Sent to the manager (flagged if over the maximum) |
| Same M-Pesa code or screenshot as another claim, including a rejected one | Flagged as a possible duplicate for the manager |

Songa reimburses **what was paid**, not the expected cost: a rider who charged 120 for a
trip worth 150 is repaid 120. Pending claims count against the allowance until they are
decided, so nobody can overshoot it while a claim waits; a rejection releases the money.

5. **The manager decides.** Approve, or reject with a reason. A rejection is final for the
   claimant — the trip cannot be tracked again — so they see who rejected it and why in My
   Claims, and take it up with their manager. Only a manager can reopen a rejected claim.
6. **HR pays.** Cycles are half-months in Nairobi time: the 1st to the 15th, and the 16th
   to the end of the month. At 08:00 on the 16th and the 1st, approved claims are sealed
   into a batch for HR, who mark them paid once Finance has paid out.

The bell keeps everyone current inside the app: approvers see claims waiting on them and a
nudge once one has waited more than three days; claimants see this cycle's rejections, what
is with their manager and what is awaiting payment. There is no email yet.

## Signing in

Staff sign in with their work email and a password. The form is built so the browser offers
to save the password and fills it in next time, and a session lasts 30 days, so on their own
phone people rarely type anything.

A first password, and a forgotten one, start from a one-time **setup code**: an admin issues
it in Admin > User roles (one person from their drawer, or a whole selection at once as a
CSV), and the person chooses "Use a setup code" on the sign-in page. Codes work once and
expire after 7 days. The very first admin gets theirs from `npm run admin:unlock <email>`.
See [server/README.md](server/README.md#signing-in).

## Running it locally

Needs Node.js 22.13 or later.

```bash
npm install
cp .env.example .env     # every setting is explained in the file
npm run dev:all          # the app on :5174 and the API on :5175
```

Open **https://localhost:5174/songa/**. It is `https` when `certs/` holds a local
certificate, which phone testing needs (see [vite.config.js](vite.config.js)), and plain
`http` otherwise — use whichever Vite prints.

With no database settings in `.env`, Songa uses a SQLite file at `server/data/songa.db`.
Set the `PG*` variables, or `SONGA_DATABASE_URL`, to use Postgres instead; the tables are
created on first start.

To get in the first time, give yourself an admin setup code:

```bash
npm run admin:unlock your.name@oneacrefund.org
```

Two settings are useful while building:

- `SONGA_ALLOW_ZERO_DISTANCE=true` lets a claim be submitted without moving, so the claim
  form can be tested at a desk. It is ignored in production.
- `SONGA_DISABLE_SCHEDULER=true` stops the cycle jobs, so a batch does not seal mid-demo.

To test on a phone on the same Wi-Fi, run `npx vite --host` instead of `npm run dev` and
open `https://<this machine's LAN IP>:5174/songa/`.

## Checks before you push

```bash
npm test           # the server suite, against throwaway SQLite files
npm run lint       # ESLint
npm run test:e2e   # every screen on four devices (see below)
```

Once the repository is on the golden-path template, its Lint & Test job runs these on every
pull request; until then, run them yourself. `npm test` skips the Postgres
suite unless `SONGA_TEST_DATABASE_URL` points at a database of its own — never the shared
one, because it creates and drops a schema.

## Testing on phones and tablets

### Automated, on every change

```bash
npm run test:e2e
```

Runs every screen on four devices — a 360px Android phone, an iPhone (Safari's engine), a
portrait iPad and a laptop — against the production build and a throwaway database, so it
never touches your data or your running dev server. On each screen it checks that:

- the page never scrolls sideways (tables scroll inside their own box instead);
- every control is at least 44px tall on a touch screen;
- no table is squeezed until its words break a letter per line;
- the thing the screen is for is visible.

It also makes a whole claim on every device — tracking a trip along a simulated GPS route,
attaching the proof and submitting — checks that a trip with no distance cannot be
submitted, and follows a rejection from the manager's decision to the claimant's bell and
My Claims.

Screenshots of every screen on every device land in `test-results/screens/`. Passing is
not the same as looking right, so look them over before a release. The first run needs the
browsers: `npx playwright install chromium webkit`.

### By hand, on real phones, before each release

Emulation cannot show the browser's own prompts, real GPS or a real network. On one cheap
Android phone (Chrome) and one iPhone (Safari), ideally on mobile data:

- [ ] Set a password from a setup code. The browser offers to save it.
- [ ] Sign out and in again. Email and password fill themselves in.
- [ ] Open the menu, reach every section, and close it again.
- [ ] Log a trip: allow location, start tracking, move, and the distance goes up.
- [ ] Attach a proof: the picker opens the gallery, and the image uploads.
- [ ] Submit the claim and see it in My Claims.
- [ ] Turn the phone sideways on the trip form and on a table.
- [ ] As an approver, approve a claim from the phone.

Locally the phone reaches the dev server at `https://<this machine's LAN IP>:5174/songa/`
(see vite.config.js for the certificate). After a deploy, use the dev hostname.

## Project layout

```text
Transport/
├── src/                     The React app
│   ├── App.jsx              Sign-in, navigation, the trip and claim flow
│   ├── AccountClaim.jsx     The M-Pesa step and its Claim Overview
│   ├── ManagerDashboard.jsx Approvals: the queue, team claims, the claim drawer
│   ├── HrClaims.jsx         HR's claims, payouts and export
│   ├── AdminUsers.jsx       User roles and setup codes
│   └── …                    Rates, regional budgets, the bell, shared pieces
├── server/                  The Express API; see server/README.md
│   ├── index.js             Every route
│   ├── routing.js           Who a claim goes to, and the evidence checks
│   ├── budget.js            Each person's allowance for the cycle
│   ├── auth.js, passwords.js Sign-in, setup codes, throttling
│   └── db*.js, store.js     Postgres or SQLite, and the queries
├── e2e/                     Browser tests (Playwright) and their seed data
├── deploy/                  The nginx configuration for the web image
├── Dockerfile               Two images: --target api and --target web
├── docs/                    The SQLite-to-Postgres migration notes
└── .env.example             Every setting, explained
```

## Deploying

Songa deploys to One Acre Fund's EKS platform through the golden path: a merge to `main`
builds the images, and Argo CD rolls them out. The `web` image serves the app and proxies
`/api` to the `api` image inside the cluster, so only the web image needs a hostname. What
the chart has to provide — settings, secrets, probes — is in
[server/README.md](server/README.md#deploying).

## Known limitations

- **No email.** Setup codes are handed over in person or on Slack, and notifications are in
  the app only.
- **No offline mode.** A trip needs signal to submit, and is lost if the tab closes
  mid-journey.
- **The screenshot is not read.** The M-Pesa code and amount are typed in; Songa checks the
  code's format and duplicates but not the image's contents.
- **One approval per claim.** Approver 2 stands in when approver 1 is away, rather than
  signing off as well.
- **Real phones.** The checklist above has to be run by hand before a release.

## More detail

- [server/README.md](server/README.md) — the API: roles, routing, cycles, budgets, sign-in,
  deploying.
- [docs/postgres-migration.md](docs/postgres-migration.md) — how the data moved from SQLite
  to Postgres.
- [.env.example](.env.example) — every setting.
