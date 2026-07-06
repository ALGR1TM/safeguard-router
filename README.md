# Safeguard Router

A tiny, install-to-home-screen **PWA** that turns a daily property-inspection stop-sheet
(PDF or pasted text) into a gas-efficient, **toll-avoiding** driving route with ready-to-tap
Google Maps links.

Everything runs in the browser — no server, no account, no data leaves your phone.
Your home address and preferences are stored in the device's local storage only.

## What it does
1. Reads the stop list from a PDF (via pdf.js) or pasted text.
2. Geocodes each address with OpenStreetMap / Nominatim (cached locally).
3. Optimizes the visiting order as a round trip from home (nearest-neighbor + 2-opt).
4. Shows a table, total miles, and a fuel estimate, plus split "Open in Google Maps" links.
5. Reminds you to toggle **Avoid tolls** (links can't force it).

## Use
- Open the site, tap ⚙️ and set your **home address** once.
- Tap **Upload PDF** (or paste the list) → get the route.
- Add to Home Screen to use it like an app / offline shell.

Notes: geocoding needs a network connection. iOS doesn't support receiving a share
directly, so on iPhone use the **Upload PDF** button; on Android you can share the PDF
straight into the app.

No personal data is stored in this repository.
