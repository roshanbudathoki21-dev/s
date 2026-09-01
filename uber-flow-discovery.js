const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');

/**
 * KenDoEats Uber Eats flow discovery recorder
 *
 * Goal: map the browser-visible request flow for menu -> item -> modifiers -> cart -> checkout.
 * It does NOT place an order, bypass verification, or submit payment.
 *
 * Usage:
 *   node uber-flow-discovery.js "https://www.ubereats.com/..."
 *
 * Useful env vars:
 *   HEADLESS=false
 *   RECORD_SECONDS=180
 *   CAPTURE_JSON_BODIES=true
 *   USER_DATA_DIR=.uber-browser-profile
 *   DISCOVERY_OUT=./uber-discovery
 */

const START_URL = process.argv[2] || process.env.START_URL || 'https://www.ubereats.com/';
const HEADLESS = String(process.env.HEADLESS || 'false').toLowerCase() === 'true';
const RECORD_SECONDS = Math.max(0, Number(process.env.RECORD_SECONDS || 0));
const CAPTURE_JSON_BODIES = String(process.env.CAPTURE_JSON_BODIES || 'true').toLowerCase() === 'true';
const USER_DATA_DIR = path.resolve(process.env.USER_DATA_DIR || '.uber-browser-profile');
const OUT_ROOT = path.resolve(process.env.DISCOVERY_OUT || 'uber-discovery');
const MAX_BODY_CHARS = Math.max(1000, Number(process.env.MAX_BODY_CHARS || 120000));
const MAX_EVENTS = Math.max(100, Number(process.env.MAX_EVENTS || 5000));

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(OUT_ROOT, stamp);
fs.mkdirSync(outDir, { recursive: true });

const SENSITIVE_KEY = /(authorization|cookie|token|secret|password|passwd|session|csrf|xsrf|card|cvv|cvc|payment.?method|billing|phone|email|address|latitude|longitude|first.?name|last.?name|device.?id|fingerprint)/i;
const IDISH_SAFE_KEY = /(item|menu|store|merchant|cart|group|modifier|option|product|category|order).*id$/i;

function clip(value, max = 500) {
  const s = String(value == null ? '' : value);
  return s.length <= max ? s : s.slice(0, max) + '…';
}

function sanitizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const safe = new URL(`${u.protocol}//${u.host}${u.pathname}`);
    for (const [k, v] of u.searchParams.entries()) {
      if (SENSITIVE_KEY.test(k)) safe.searchParams.set(k, '[REDACTED]');
      else safe.searchParams.set(k, clip(v, 120));
    }
    return safe.toString();
  } catch {
    return clip(rawUrl, 1000);
  }
}

function sanitizeHeaders(headers = {}) {
  const out = {};
  const allow = new Set([
    'content-type', 'accept', 'x-requested-with', 'origin', 'referer',
    'x-csrf-token', 'x-xsrf-token', 'user-agent'
  ]);

  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (!allow.has(lower)) continue;
    if (SENSITIVE_KEY.test(lower)) out[lower] = '[REDACTED]';
    else out[lower] = clip(value, 500);
  }
  return out;
}

function sanitizeValue(value, keyHint = '') {
  if (SENSITIVE_KEY.test(keyHint) && !IDISH_SAFE_KEY.test(keyHint)) return '[REDACTED]';

  if (Array.isArray(value)) {
    return value.slice(0, 100).map(v => sanitizeValue(v, keyHint));
  }

  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 250)) {
      out[k] = sanitizeValue(v, k);
    }
    return out;
  }

  if (typeof value === 'string') {
    if (/^(Bearer\s+)?[A-Za-z0-9._-]{80,}$/.test(value)) return '[REDACTED_LONG_TOKEN]';
    return clip(value, 1000);
  }

  return value;
}

function parseAndSanitizeBody(text, contentType = '') {
  if (!text) return null;
  const clipped = text.slice(0, MAX_BODY_CHARS);

  if (/json/i.test(contentType) || /^[\s\[{]/.test(clipped)) {
    try {
      return sanitizeValue(JSON.parse(clipped));
    } catch {}
  }

  if (/application\/x-www-form-urlencoded/i.test(contentType)) {
    try {
      const params = new URLSearchParams(clipped);
      const obj = {};
      for (const [k, v] of params.entries()) obj[k] = sanitizeValue(v, k);
      return obj;
    } catch {}
  }

  return clip(clipped, 4000);
}

function classify(url, method, postData) {
  const target = `${url} ${method} ${postData || ''}`.toLowerCase();
  if (/group.?order|group-orders/.test(target)) return 'group_order';
  if (/checkout|finalize|place.?order|submit.?order/.test(target)) return 'checkout';
  if (/cart|basket|shopping/.test(target)) return 'cart';
  if (/modifier|option|customi[sz]|addon|add-on/.test(target)) return 'modifier';
  if (/menu|item|product|catalog/.test(target)) return 'menu_item';
  if (/restaurant|merchant|store/.test(target)) return 'merchant';
  return 'other';
}

function relevant(url, resourceType, postData = '') {
  if (!/uber/i.test(url)) return false;
  if (['xhr', 'fetch', 'document'].includes(resourceType)) return true;
  return /(cart|checkout|group.?order|menu|item|modifier|store|restaurant|merchant)/i.test(`${url} ${postData}`);
}

function endpointKey(method, rawUrl) {
  try {
    const u = new URL(rawUrl);
    return `${method.toUpperCase()} ${u.origin}${u.pathname}`;
  } catch {
    return `${method.toUpperCase()} ${rawUrl}`;
  }
}

async function bodyTextSafe(response) {
  try {
    const headers = await response.allHeaders();
    const contentType = String(headers['content-type'] || '');
    if (!CAPTURE_JSON_BODIES || !/json|text/i.test(contentType)) return { contentType, body: null };
    const text = await response.text();
    if (!text || text.length > 2_000_000) return { contentType, body: null };
    return { contentType, body: parseAndSanitizeBody(text, contentType) };
  } catch {
    return { contentType: '', body: null };
  }
}

async function collectDomSnapshot(page) {
  return page.evaluate(() => {
    const visible = el => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };

    const text = el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 220);

    const buttons = [...document.querySelectorAll('button,[role="button"]')]
      .filter(visible)
      .map(el => ({ text: text(el), aria: el.getAttribute('aria-label'), testid: el.getAttribute('data-testid') }))
      .filter(x => x.text || x.aria || x.testid)
      .slice(0, 250);

    const links = [...document.querySelectorAll('a[href]')]
      .filter(visible)
      .map(el => ({ text: text(el), href: el.getAttribute('href') }))
      .filter(x => x.text || x.href)
      .slice(0, 250);

    const forms = [...document.querySelectorAll('form')].slice(0, 50).map(form => ({
      action: form.getAttribute('action'),
      method: form.getAttribute('method'),
      controls: [...form.querySelectorAll('input,select,textarea,button')].slice(0, 80).map(el => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type'),
        name: el.getAttribute('name'),
        aria: el.getAttribute('aria-label'),
        testid: el.getAttribute('data-testid')
      }))
    }));

    return {
      title: document.title,
      url: location.href,
      buttons,
      links,
      forms
    };
  }).catch(() => ({ title: '', url: page.url(), buttons: [], links: [], forms: [] }));
}

async function main() {
  const events = [];
  const endpoints = new Map();
  const requestIds = new WeakMap();
  let nextId = 1;

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: HEADLESS,
    locale: 'en-US',
    viewport: { width: 1440, height: 1000 },
    args: ['--disable-dev-shm-usage']
  });

  const pages = context.pages();
  const page = pages[0] || await context.newPage();

  const addEvent = evt => {
    if (events.length < MAX_EVENTS) events.push({ t: new Date().toISOString(), ...evt });
  };

  page.on('request', request => {
    const postData = request.postData() || '';
    if (!relevant(request.url(), request.resourceType(), postData)) return;

    const id = nextId++;
    requestIds.set(request, id);
    const method = request.method();
    const safeUrl = sanitizeUrl(request.url());
    const headers = sanitizeHeaders(request.headers());
    const contentType = headers['content-type'] || '';
    const safeBody = parseAndSanitizeBody(postData, contentType);
    const kind = classify(request.url(), method, postData);
    const key = endpointKey(method, request.url());

    const summary = endpoints.get(key) || {
      key,
      method,
      url: safeUrl,
      category: kind,
      count: 0,
      statuses: {},
      example_request_body: null,
      example_response_body: null
    };
    summary.count += 1;
    if (summary.example_request_body == null && safeBody != null) summary.example_request_body = safeBody;
    endpoints.set(key, summary);

    addEvent({ type: 'request', id, method, url: safeUrl, category: kind, resourceType: request.resourceType(), headers, body: safeBody });
  });

  page.on('response', async response => {
    const request = response.request();
    const id = requestIds.get(request);
    if (!id) return;

    const key = endpointKey(request.method(), request.url());
    const summary = endpoints.get(key);
    const status = response.status();
    const { contentType, body } = await bodyTextSafe(response);

    if (summary) {
      summary.statuses[status] = (summary.statuses[status] || 0) + 1;
      if (summary.example_response_body == null && body != null) summary.example_response_body = body;
    }

    addEvent({
      type: 'response',
      id,
      status,
      url: sanitizeUrl(response.url()),
      contentType,
      body
    });
  });

  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) addEvent({ type: 'navigation', url: sanitizeUrl(frame.url()) });
  });

  console.log(`\n[KenDoEats discovery] Output: ${outDir}`);
  console.log(`[KenDoEats discovery] Profile: ${USER_DATA_DIR}`);
  console.log(`[KenDoEats discovery] Opening: ${START_URL}`);
  console.log('\nUse the browser normally: open a restaurant, open an item, choose modifiers, add it to cart, and open the cart/checkout review page.');
  console.log('Do NOT place the order or submit payment.\n');

  await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(err => {
    console.error('Initial navigation warning:', err.message);
  });

  if (RECORD_SECONDS > 0) {
    console.log(`Recording for ${RECORD_SECONDS} seconds...`);
    await new Promise(resolve => setTimeout(resolve, RECORD_SECONDS * 1000));
  } else if (HEADLESS) {
    console.log('HEADLESS=true and RECORD_SECONDS not set; recording 60 seconds.');
    await new Promise(resolve => setTimeout(resolve, 60_000));
  } else {
    console.log('Press ENTER here when you have reached the checkout review page.');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await new Promise(resolve => rl.question('', () => { rl.close(); resolve(); }));
  }

  const dom = await collectDomSnapshot(page);
  const endpointList = [...endpoints.values()].sort((a, b) => {
    const priority = { checkout: 0, cart: 1, modifier: 2, menu_item: 3, group_order: 4, merchant: 5, other: 6 };
    return (priority[a.category] ?? 9) - (priority[b.category] ?? 9) || b.count - a.count;
  });

  const flow = endpointList.filter(x => x.category !== 'other').map(x => ({
    category: x.category,
    method: x.method,
    url: x.url,
    count: x.count,
    statuses: x.statuses
  }));

  const report = {
    generated_at: new Date().toISOString(),
    start_url: sanitizeUrl(START_URL),
    final_url: sanitizeUrl(page.url()),
    instructions: 'Sanitized discovery report. No order/payment submission was performed by this recorder.',
    likely_flow_endpoints: flow,
    endpoints: endpointList,
    dom_snapshot: dom,
    events
  };

  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, 'endpoint-map.json'), JSON.stringify(endpointList, null, 2));
  fs.writeFileSync(path.join(outDir, 'events.ndjson'), events.map(e => JSON.stringify(e)).join('\n'));

  const readable = endpointList.map(e => {
    const statuses = Object.entries(e.statuses).map(([s, n]) => `${s}x${n}`).join(', ') || '-';
    return `${e.category.padEnd(12)} ${e.method.padEnd(6)} ${statuses.padEnd(14)} ${e.url}`;
  }).join('\n');
  fs.writeFileSync(path.join(outDir, 'endpoint-map.txt'), readable + '\n');

  await context.close();
  console.log(`\nDone. Send me ${path.join(outDir, 'report.json')} and I can turn the discovered flow into the next adapter layer.`);
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
