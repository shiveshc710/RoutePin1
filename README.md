# RoutePin — Delivery Stop Tracker

A mobile-friendly Next.js app for scanning package barcodes, geocoding delivery addresses, showing active stops on a map, opening Google Maps directions, and marking stops complete.

## Important barcode limitation
Most package barcodes encode a tracking number or routing identifier, not a plain-text recipient address. This starter scans the barcode and then asks the driver to enter the delivery address from the label. It does **not** connect to FedEx internal systems or look up addresses from tracking numbers. Automated label OCR can be added separately, with careful testing and privacy controls.

## Features
- Camera barcode scanning with `@zxing/browser` (works on HTTPS; grant camera permission)
- Manual barcode and address entry
- Address geocoding using OpenStreetMap Nominatim
- OpenStreetMap map pins for active stops
- Google Maps driving directions for each stop
- Active and completed stop counts, progress, undo completion
- Local browser persistence via `localStorage`; no account/backend needed for this prototype
- Responsive layout for phones and desktop

## Run locally
Requires Node.js 20.9+ for Next.js 15.

```bash
npm install
npm run dev
```
Open http://localhost:3000.

## Deploy to Vercel
1. Create a GitHub repository and push this folder's contents.
2. Import that repository at https://vercel.com/new.
3. Keep the framework preset as Next.js and deploy. No environment variables are required for this MVP.

Alternatively install Vercel CLI and run `vercel` from the project folder.

## Notes before using on a real route
- Test camera scanning on your actual phone and package labels.
- Address geocoding requires internet access; Nominatim is a community service with usage policies and rate limits. For frequent production usage, choose a provider and comply with its terms.
- Stop data is stored in this browser only. It does not sync between devices and may be lost if site data is cleared.
- Recipient addresses and tracking numbers are sensitive. Use only information you are authorized to process and avoid sharing the app or device with others.
- The map is based on OpenStreetMap. Google Maps opens externally for turn-by-turn navigation.
