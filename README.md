# Songa

Songa is a mobile-first field transport reimbursement web app for Tupande. It helps an individual field agent log a trip, track movement with GPS, calculate a reimbursement amount, and submit an M-Pesa claim with proof of payment.

This is an MVP prototype. It uses browser state only and does not yet connect to a backend, external authentication provider, payment service, or claims approval API.

## Product Scope

Songa is designed for one field agent logging their own trips.

It is not a multi-role transport allocation system. There are no Supervisor, Admin, or Super Admin approval workflows in the current product.

## Main Features

- Tupande-branded Songa dashboard
- Overview dashboard with trip, claim, reimbursement, and distance summaries
- My Trips history
- My Claims view
- Field trip purpose selection with multiple choices
- Optional Other trip reason field
- Additional trip comments
- Transport mode selection:
  - Piki
  - Matatu
  - Personal means: Car or Piki
- Internal transport-rate calculation without exposing rates to field agents
- MVP username/password login before accessing the Overview dashboard
- Automatic claimant email from the signed-in profile
- Live GPS tracking with OpenStreetMap and Leaflet
- Moving GPS location marker
- Green route overlay showing tracked movement
- Live distance counter
- Automatic start time and start coordinate capture
- Collapsible map preview
- Start Tracking Journey and Stop & Submit journey controls
- M-Pesa transaction code converted to uppercase
- Kenya phone input with a fixed `+254` prefix
- Required claim amount in KES
- Proof-of-payment upload
- JPEG, PNG, and WebP validation
- Client-side conversion and compression to WebP at 500 KB or less
- Required-field validation before reimbursement submission
- Responsive desktop sidebar and mobile layout

## Trip Flow

### 1. Start a Field Trip

The agent selects one or more trip reasons and chooses a transport mode. Songa uses the selected mode internally to calculate reimbursement without displaying the rate.

The agent then chooses **Start Tracking Journey**.

When tracking starts, Songa automatically records:

- Start time
- Start coordinates
- Current coordinates
- GPS route points
- Total distance travelled

### 2. Track the Journey

The browser's geolocation API continuously watches the agent's location. The map displays the current marker and draws the route in green as new GPS points are received.

The map can be collapsed on smaller screens using the map preview toggle.

### 3. Stop and Submit

The primary action changes to **Stop & Submit**. Pressing it stops GPS tracking, captures the final location, and opens the M-Pesa submission step.

### 4. Submit the M-Pesa Claim

The agent must provide:

- M-Pesa transaction code
- Profile email captured from the signed-in account
- Name on the M-Pesa account
- Amount in KES
- Proof-of-payment image

The claim cannot be submitted until all required fields are completed and the image passes validation.

## Image Upload Rules

Proof-of-payment uploads must be:

- JPEG
- PNG
- WebP

Images are compressed in the browser and converted to WebP. The final image must be 500 KB or less before it is accepted.

No image is currently uploaded to a server. The compressed file metadata is held in local browser state for this prototype.

## Signing in

Staff sign in with their work email and a password. The form is built so the browser offers to save the password and fills it in next time, and a session lasts 30 days, so on their own phone people rarely type anything.

A first password, and a forgotten one, start from a one-time **setup code**: an admin issues it in Admin > User roles (one person from their drawer, or a whole selection at once as a CSV), and the person chooses "Use a setup code" on the sign-in page. Codes work once and expire after 7 days. The very first admin gets theirs from `npm run admin:unlock <email>`. See [server/README.md](server/README.md#signing-in).

## Technology Stack

- React
- Vite
- JavaScript
- CSS
- Leaflet
- React Leaflet
- OpenStreetMap tiles
- Tailwind CSS tooling is installed, while the current UI primarily uses the project's custom CSS system

## Project Structure

```text
Transport/
├── index.html                 Vite HTML entry point
├── package.json               Project scripts and dependencies
├── vite.config.js             Vite configuration and /songa/ base path
├── postcss.config.js          PostCSS configuration
├── tailwind.config.js         Tailwind configuration
└── src/
    ├── App.jsx                Main application state and screens
    ├── main.jsx               React entry point
    ├── styles.css             Application styling and responsive layout
    ├── Step1PreTrip.jsx       Earlier standalone trip form prototype
    └── assets/
        └── .../tupande-logo.png
```

## Requirements

- Node.js
- npm
- A modern browser with geolocation support
- Location permission enabled for the local development URL
- Internet access for OpenStreetMap map tiles

## Installation

From the project directory:

```bash
npm install
```

## Development

Start the Vite development server:

```bash
npm run dev
```

The configured local path is:

```text
http://127.0.0.1:5174/songa/
```

The port may change if port `5174` is already in use. Always use the URL printed by Vite in the terminal.

## Production Build

Create a production build:

```bash
npm run build
```

Preview the production build locally:

```bash
npm run preview
```

## GPS Notes

GPS tracking depends on `navigator.geolocation.watchPosition`.

When testing locally:

1. Open the Songa URL in a supported browser.
2. Allow location access when prompted.
3. Select a trip reason and transport mode.
4. Click **Start Tracking Journey**.
5. Move with the browser/device so new GPS points can be recorded.
6. Click **Stop & Submit** when the trip is complete.

Desktop browsers may provide limited or simulated movement. Mobile devices generally provide more useful GPS readings.

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

## Current MVP Limitations

- Data is stored in React state and is lost when the page is refreshed.
- There is no backend persistence.
- There is no real M-Pesa API integration.
- There is no claims approval workflow.
- Uploaded proof files are not sent to a server yet.
- GPS distance depends on browser/device location accuracy.
- OpenStreetMap tiles require an internet connection.

## Future Work

- Add a backend database for trips and claims
- Upload proof images to secure storage
- Connect M-Pesa payment verification
- Add a claims status API
- Add offline trip capture and later synchronization
- Add stronger GPS sampling and distance smoothing
- Add automated tests for trip validation, image compression, and claim submission

## Validation

The current project has been validated with:

```bash
npm run build
```

The production build completes successfully.
