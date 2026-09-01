# KenDoEats Uber Flow Discovery

This is the first reverse-engineering stage for the Uber Eats browser flow.

It records the browser requests generated while **you manually** go through:

**restaurant -> item -> modifiers -> add to cart -> cart -> checkout review**

It intentionally does **not** click Place Order, submit payment, bypass CAPTCHA/verification, or defeat authentication.

## Run locally

```bash
npm install
npx playwright install chromium
npm run discover:uber -- "https://www.ubereats.com/"
```

A Chromium window opens. Use Uber Eats normally. When you reach the checkout review page, return to the terminal and press Enter.

The recorder writes a timestamped folder under `uber-discovery/` containing:

- `report.json` — sanitized full discovery report
- `endpoint-map.json` — deduplicated endpoint map
- `endpoint-map.txt` — quick human-readable endpoint list
- `events.ndjson` — chronological request/response events

## Existing login

The script uses `.uber-browser-profile/` as a persistent Playwright profile. If Uber asks you to sign in, sign in in the opened browser. Future runs reuse that browser profile.

## Railway/headless capture

For passive page-load discovery on Railway:

```env
HEADLESS=true
RECORD_SECONDS=60
START_URL=https://www.ubereats.com/...
```

Interactive discovery is much more useful locally because the endpoint we need is triggered when an item/modifier/cart action happens.

## What I need next

After one complete run, send `report.json` back to ChatGPT. The report should show which network calls correspond to menu lookup, item customization, cart mutation, cart refresh, and checkout calculation. From that, the next stage is building a stable adapter around the discovered request shapes while keeping authentication/payment protections intact.
