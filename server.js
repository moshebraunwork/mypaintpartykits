"use strict";
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const cookieSession = require("cookie-session");
const multer = require("multer");
const zipcodes = require("zipcodes");

/* ---------------- config ---------------- */
const env = process.env;
const PORT = Number(env.PORT || 3000);
const DATA_DIR = env.DATA_DIR || path.join(__dirname, "data");
const UPLOADS = path.join(DATA_DIR, "uploads");
const REQUIRED = ["ADMIN_EMAIL", "ADMIN_PASSWORD", "SESSION_SECRET", "WEB3FORMS_KEY"];
const missing = REQUIRED.filter(k => !env[k]);
if (missing.length) { console.error(`Missing settings in .env: ${missing.join(", ")}`); process.exit(1); }
if (env.SESSION_SECRET.length < 32) { console.error("SESSION_SECRET must be at least 32 characters."); process.exit(1); }
if (env.ADMIN_PASSWORD.length < 10) { console.error("ADMIN_PASSWORD must be at least 10 characters."); process.exit(1); }
const SALES_EMAIL = env.SALES_EMAIL || env.ADMIN_EMAIL;
fs.mkdirSync(UPLOADS, { recursive: true });

/* ---------------- database ---------------- */
const db = new Database(path.join(DATA_DIR, "store.db"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, blurb TEXT NOT NULL DEFAULT '', included TEXT NOT NULL DEFAULT '[]',
  price REAL NOT NULL, bulk_min INTEGER NOT NULL DEFAULT 0, bulk_pct REAL NOT NULL DEFAULT 0,
  visible INTEGER NOT NULL DEFAULT 1, photo TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, visitor TEXT NOT NULL, visit TEXT NOT NULL,
  type TEXT NOT NULL, page TEXT NOT NULL DEFAULT '', product TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '', device TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS events_at ON events(at);
`);
// added later: several photos per item, and "choices" (sub-listings such as sizes or colors)
const cols = db.prepare("PRAGMA table_info(products)").all().map(c => c.name);
if (!cols.includes("photos")) {
  db.exec("ALTER TABLE products ADD COLUMN photos TEXT NOT NULL DEFAULT '[]'");
  db.exec("UPDATE products SET photos = json_array(photo) WHERE photo != ''");
}
if (!cols.includes("variants")) db.exec("ALTER TABLE products ADD COLUMN variants TEXT NOT NULL DEFAULT '[]'");
if (!cols.includes("choose_label")) db.exec("ALTER TABLE products ADD COLUMN choose_label TEXT NOT NULL DEFAULT ''");
// added later: "custom order" listings (customer picks how many letters/units, a color, and types a name). Empty = a regular item.
if (!cols.includes("custom")) db.exec("ALTER TABLE products ADD COLUMN custom TEXT NOT NULL DEFAULT ''");
const getSetting = (k, fallback) => { const r = db.prepare("SELECT value FROM settings WHERE key=?").get(k); return r ? JSON.parse(r.value) : fallback; };
const setSetting = (k, v) => db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, JSON.stringify(v));

if (!getSetting("seeded", false)) {
  db.prepare(`INSERT OR IGNORE INTO products(id,name,blurb,included,price,bulk_min,bulk_pct,visible,photo,photos,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run("chanukah", "Chanukah Paint Party Kit",
      "A paint-your-own plaster donut kit. A fun, creative Chanukah activity for kids, perfect for parties, classrooms and family nights.",
      JSON.stringify(["1 plaster donut", "3 paint colors", "1 paintbrush"]), 7.99, 10, 16, 1, "/img/kit.jpg", JSON.stringify(["/img/kit.jpg"]), new Date().toISOString());
  setSetting("season", { theme: "chanukah", show: true, headline: "Chanukah is almost here!",
    text: "Paint-your-own donut kits that make your party glow. Order for the whole class or family.",
    button: "Shop Chanukah kits", link: "chanukah", photo: "/img/scene.jpg" });
  setSetting("delivery", { homeZip: "", rings: [{ miles: 3, fee: 5 }, { miles: 8, fee: 10 }, { miles: 15, fee: 15 }], freeOver: 0, zones: {} });
  setSetting("nextOrder", 1001);
  setSetting("seeded", true);
}

/* ---------------- helpers ---------------- */
const r2 = n => Math.round(n * 100) / 100;
const money = n => "$" + r2(n).toFixed(2);
const THEMES = ["chanukah", "purim", "spring", "summer", "fall", "everyday"];
const str = (v, max = 500) => (typeof v === "string" ? v : "").trim().slice(0, max);
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const isZip = z => /^\d{5}$/.test(z);
const isEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const isPhone = p => p.replace(/\D/g, "").length >= 7;
const safeUrl = u => (typeof u === "string" && /^\/(img|uploads)\/[\w.-]+$/.test(u)) ? u : "";
function rowToProduct(r) {
  if (!r) return r;
  let photos = JSON.parse(r.photos || "[]");
  if (!photos.length && r.photo) photos = [r.photo];
  return { id: r.id, name: r.name, blurb: r.blurb, included: JSON.parse(r.included), price: r.price,
    bulkMin: r.bulk_min, bulkPct: r.bulk_pct, visible: !!r.visible, photo: photos[0] || "", photos,
    chooseLabel: r.choose_label || "", custom: r.custom ? cleanCustom(JSON.parse(r.custom)) : null, variants: JSON.parse(r.variants || "[]").map(v => {
      const ph = Array.isArray(v.photos) ? v.photos : v.photo ? [v.photo] : [];
      return { id: v.id, name: v.name, price: v.price, photos: ph, photo: ph[0] || "", blurb: v.blurb || v.note || "", included: v.included || [], soldOut: !!v.soldOut };
    }) };
}
/* Sub-items: complete listings inside an item (a size, a color, or both, e.g. "Large – Gold").
   [{ id, name, price, photos, blurb, included, soldOut }]. price null = use the item's price.
   If an item has sub-items, customers must pick one. */
function cleanVariants(list) {
  const out = [], ids = new Set();
  for (const v of Array.isArray(list) ? list.slice(0, 60) : []) {
    if (!v || typeof v !== "object") continue;
    const name = str(v.name, 80), price = r2(num(v.price));
    const photos = [...new Set((Array.isArray(v.photos) ? v.photos : [v.photo]).map(safeUrl).filter(Boolean))].slice(0, 10);
    const included = (Array.isArray(v.included) ? v.included : []).map(x => str(x, 120)).filter(Boolean).slice(0, 30);
    let id = typeof v.id === "string" && /^[a-z0-9]{4,16}$/.test(v.id) && !ids.has(v.id) ? v.id : "";
    while (!id || ids.has(id)) id = crypto.randomBytes(4).toString("hex");
    ids.add(id);
    out.push({ id, name, price: price > 0 && price < 100000 ? price : null, photos, photo: photos[0] || "",
      blurb: str(v.blurb, 1500), included, soldOut: !!v.soldOut });
  }
  return out;
}
const priceOf = (p, v) => (v && v.price > 0 ? v.price : p.price);
/* Custom-order listings: the customer picks how many units (e.g. letters), a color, and can type the text.
   The item's price covers up to `included` units; each unit over that adds `extra`.
   { unit, min, max, included, extra, colors: ["#RRGGBB"], askText, textLabel } */
const clampInt = (v, lo, hi, dflt) => { const n = Math.floor(num(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
function cleanCustom(c) {
  if (!c || typeof c !== "object") return null;
  const min = clampInt(c.min, 1, 60, 1), max = clampInt(c.max, min, 60, Math.max(min, 12));
  const extra = r2(num(c.extra));
  const colors = [...new Set((Array.isArray(c.colors) ? c.colors : []).map(x => String(x || "").trim().toUpperCase()).filter(x => /^#[0-9A-F]{6}$/.test(x)))].slice(0, 40);
  return { unit: str(c.unit, 30) || "letter", min, max, included: clampInt(c.included, 0, 60, 0),
    extra: extra >= 0 && extra < 10000 ? extra : 0, colors, askText: !!c.askText, textLabel: str(c.textLabel, 40) || "Name" };
}
const unitsWord = (c, n) => n === 1 ? c.unit : /(s|x|z|ch|sh)$/i.test(c.unit) ? c.unit + "es" : c.unit + "s";
const customPrice = (p, n) => r2(p.price + Math.max(0, n - p.custom.included) * p.custom.extra);
const cleanText = t => String(t || "").trim().replace(/\s+/g, " ");
const letterCount = t => [...cleanText(t)].length; // spaces and symbols count as letters too
const variantPhotos = p => p.variants.flatMap(v => v.photos);
const allProducts = () => db.prepare("SELECT * FROM products ORDER BY created_at").all().map(rowToProduct);
const findProduct = id => rowToProduct(db.prepare("SELECT * FROM products WHERE id=?").get(id));
const hasBulk = p => p.bulkMin > 1 && p.bulkPct > 0;
// bulkQty: all of this item in the order, across choices; each: price of one before any bulk discount
function priceFor(p, q, bulkQty = q, each = p.price) {
  const bulk = hasBulk(p) && bulkQty >= p.bulkMin;
  const unit = bulk ? r2(each * (1 - p.bulkPct / 100)) : each;
  return { bulk, unit, total: r2(unit * q), full: r2(each * q) };
}
function milesBetween(a, b) {
  const R = 3958.8, rad = x => x * Math.PI / 180;
  const dLat = rad(b.latitude - a.latitude), dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const placeName = zip => { const z = zipcodes.lookup(zip); return z ? `${z.city}, ${z.state}` : ""; };
function deliveryQuote(zip, subtotal) {
  const d = getSetting("delivery", {});
  const zone = d.zones && d.zones[zip];
  if (!zone) return { available: false };
  const free = d.freeOver > 0 && subtotal >= d.freeOver;
  return { available: true, fee: free ? 0 : zone.fee, baseFee: zone.fee, free, place: zone.place || placeName(zip) };
}

/* simple in-memory rate limiter */
const hits = new Map();
function limit(name, max, windowMs) {
  return (req, res, next) => {
    const key = name + ":" + req.ip, now = Date.now();
    const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: "Too many attempts. Please wait a few minutes and try again." });
    arr.push(now); hits.set(key, arr); next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();

/* ---------------- app ---------------- */
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", "loopback, uniquelocal"); // Nginx on the host reaches the container via the Docker network
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self' https://api.web3forms.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  });
  next();
});
app.use(express.json({ limit: "300kb" }));
app.use(cookieSession({
  name: "ppk_admin", keys: [env.SESSION_SECRET], httpOnly: true, sameSite: "strict",
  secure: env.COOKIE_SECURE !== "false", maxAge: 30 * 24 * 3600e3
}));

/* ----- public API ----- */
app.get("/api/store", (req, res) => {
  const d = getSetting("delivery", {});
  res.json({
    products: allProducts().filter(p => p.visible),
    season: getSetting("season", {}),
    delivery: { enabled: Object.keys(d.zones || {}).length > 0, freeOver: d.freeOver || 0 },
    web3formsKey: env.WEB3FORMS_KEY, salesEmail: SALES_EMAIL
  });
});

app.get("/api/delivery/:zip", (req, res) => {
  const zip = req.params.zip;
  if (!isZip(zip)) return res.status(400).json({ error: "Enter a 5-digit ZIP code." });
  const subtotal = Math.max(0, num(req.query.subtotal) || 0);
  res.json(deliveryQuote(zip, subtotal));
});

function buildOrder(body) {
  const errors = {};
  const c = body.customer || {};
  const name = str(c.name, 120), phone = str(c.phone, 40), email = str(c.email, 160);
  if (!name) errors.name = "Enter your name.";
  if (!isPhone(phone)) errors.phone = "Enter a phone number we can call or text.";
  if (!isEmail(email)) errors.email = "Enter an email like name@example.com.";
  const method = body.method === "delivery" ? "delivery" : "pickup";
  const lines = [], perItem = {};
  for (const it of Array.isArray(body.items) ? body.items.slice(0, 50) : []) {
    const p = findProduct(String(it.id || ""));
    const qty = Math.floor(num(it.qty));
    if (!p || !p.visible || !(qty >= 1 && qty <= 999)) continue;
    let v = null, cu = null;
    if (p.custom) {
      const c = p.custom, sel = it.c && typeof it.c === "object" ? it.c : {};
      const n = Math.floor(num(sel.n)), color = String(sel.color || "").toUpperCase(), text = cleanText(str(sel.text, 80));
      if (!(n >= c.min && n <= c.max)) { errors.items = `Choose how many ${unitsWord(c, 2)} for ${p.name}.`; continue; }
      if (c.colors.length && !c.colors.includes(color)) { errors.items = `Choose a color for ${p.name}.`; continue; }
      if (c.askText && !text) { errors.items = `Enter the ${c.textLabel.toLowerCase()} for ${p.name}.`; continue; }
      if (c.askText && letterCount(text) > n) { errors.items = `“${text}” has ${letterCount(text)} ${unitsWord(c, 2)} (spaces count) but ${n} were chosen for ${p.name}.`; continue; }
      cu = { n, unit: unitsWord(c, n), ...(c.colors.length ? { color } : {}), ...(c.askText ? { text, textLabel: c.textLabel } : {}) };
    } else if (p.variants.length) {
      v = p.variants.find(x => x.id === it.v);
      if (!v) { errors.items = `Choose a ${(p.chooseLabel || "option").toLowerCase()} for ${p.name}.`; continue; }
      if (v.soldOut) { errors.items = `${p.name} (${v.name}) is sold out. Please remove it from your cart.`; continue; }
    }
    const ck = JSON.stringify(cu);
    const same = lines.find(l => l.p.id === p.id && l.v === v && l.ck === ck);
    if (same) same.qty = Math.min(999, same.qty + qty); else lines.push({ p, qty, v, cu, ck });
    perItem[p.id] = (perItem[p.id] || 0) + qty;
  }
  const items = lines.map(({ p, qty, v, cu }) => {
    const r = priceFor(p, qty, perItem[p.id], cu ? customPrice(p, cu.n) : priceOf(p, v));
    return { id: p.id, name: p.name, ...(v ? { variant: v.name, variantId: v.id, label: p.chooseLabel } : {}), ...(cu ? { custom: cu } : {}), qty, unit: r.unit, total: r.total, full: r.full, bulk: r.bulk, pct: p.bulkPct };
  });
  if (!items.length && !errors.items) errors.items = "Your cart is empty or an item is no longer available.";
  const subtotal = r2(items.reduce((s, i) => s + i.total, 0)), full = r2(items.reduce((s, i) => s + i.full, 0));
  let address = null, delivery = 0;
  if (method === "delivery") {
    const a = body.address || {};
    address = { street: str(a.street, 160), unit: str(a.unit, 60), city: str(a.city, 80), state: str(a.state, 2).toUpperCase(), zip: str(a.zip, 10) };
    if (!address.street) errors.street = "Enter the street address.";
    if (!address.city) errors.city = "Enter the city.";
    if (!/^[A-Z]{2}$/.test(address.state)) errors.state = "Choose a state.";
    if (!isZip(address.zip)) errors.zip = "Enter a 5-digit ZIP.";
    else {
      const q = deliveryQuote(address.zip, subtotal);
      if (!q.available) errors.zip = "We don’t deliver to this ZIP yet. Please choose pickup.";
      else delivery = q.fee;
    }
  }
  return { errors, order: { items, full, save: r2(full - subtotal), subtotal, delivery, total: r2(subtotal + delivery),
    name, phone, email, method, address, date: str(body.date, 20), notes: str(body.notes, 2000) } };
}
const customText = c => [`${c.n} ${c.unit}`, c.color ? `color ${c.color}` : "", c.text ? `${c.textLabel || "Text"}: “${c.text}”` : ""].filter(Boolean).join(", ");
function orderEmail(o) {
  const addr = o.address ? `${o.address.street}${o.address.unit ? ", " + o.address.unit : ""}, ${o.address.city}, ${o.address.state} ${o.address.zip}` : "";
  return {
    subject: `New order ${o.id}: ${o.items.reduce((s, i) => s + i.qty, 0)} items, ${money(o.total)}`,
    text: `New order request ${o.id}

${o.items.map(i => `• ${i.qty} × ${i.name}${i.variant ? ` (${i.label ? i.label + ": " : ""}${i.variant})` : ""}${i.custom ? ` (${customText(i.custom)})` : ""} @ ${money(i.unit)}${i.bulk ? ` (${i.pct}% bulk)` : ""} = ${money(i.total)}`).join("\n")}
${o.save > 0 ? `Bulk savings: −${money(o.save)}\n` : ""}Subtotal: ${money(o.subtotal)}
${o.method === "delivery" ? `Delivery (estimate): ${o.delivery ? money(o.delivery) : "Free"}\n` : ""}Total: ${money(o.total)}

Name: ${o.name}
Phone: ${o.phone}
Email: ${o.email}
Pickup or delivery: ${o.method === "delivery" ? "Local delivery\nAddress: " + addr : "Pickup"}
Needed by: ${o.date || "Not specified"}
Notes: ${o.notes || "None"}`
  };
}

app.post("/api/orders", limit("order", 10, 15 * 60e3), (req, res) => {
  if (req.body && req.body.botcheck) return res.status(400).json({ error: "Could not send." });
  const { errors, order } = buildOrder(req.body || {});
  if (Object.keys(errors).length) return res.status(400).json({ error: "Please fix the highlighted fields.", errors });
  const save = db.transaction(() => {
    const n = getSetting("nextOrder", 1001);
    setSetting("nextOrder", n + 1);
    order.id = "PP-" + n; order.created_at = new Date().toISOString(); order.status = "New";
    db.prepare("INSERT INTO orders(id,created_at,status,data) VALUES(?,?,?,?)").run(order.id, order.created_at, order.status, JSON.stringify(order));
  });
  save();
  track(req, { ...(req.body.analytics || {}), type: "order" });
  res.json({ order, email: orderEmail(order) });
});

app.post("/api/messages", limit("message", 8, 15 * 60e3), (req, res) => {
  const b = req.body || {};
  if (b.botcheck) return res.status(400).json({ error: "Could not send." });
  const m = { name: str(b.name, 120), phone: str(b.phone, 40), email: str(b.email, 160), topic: str(b.topic, 60) || "General question", message: str(b.message, 4000) };
  const errors = {};
  if (!m.name) errors.name = "Enter your name.";
  if (!isPhone(m.phone)) errors.phone = "Enter a phone number we can call or text.";
  if (!isEmail(m.email)) errors.email = "Enter an email like name@example.com.";
  if (!m.message) errors.message = "Write a short message.";
  if (Object.keys(errors).length) return res.status(400).json({ error: "Please fix the highlighted fields.", errors });
  m.id = "M" + Date.now().toString(36) + crypto.randomBytes(2).toString("hex");
  m.created_at = new Date().toISOString(); m.status = "New";
  db.prepare("INSERT INTO messages(id,created_at,status,data) VALUES(?,?,?,?)").run(m.id, m.created_at, m.status, JSON.stringify(m));
  track(req, { ...(b.analytics || {}), type: "message" });
  res.json({ message: m, email: { subject: `New message: ${m.topic}`,
    text: `New message from the website\n\nTopic: ${m.topic}\nName: ${m.name}\nPhone: ${m.phone}\nEmail: ${m.email}\n\n${m.message}` } });
});

/* ----- visitor analytics (anonymous: a random browser id, no names, emails or IP addresses) ----- */
const EVENT_TYPES = ["pageview", "add_to_cart", "order", "message"];
const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|monitor|curl|wget|python|node-fetch|axios/i;
const deviceOf = ua => /ipad|tablet|kindle|playbook|silk|(android(?!.*mobile))/i.test(ua) ? "Tablet" : /mobi|iphone|ipod|android/i.test(ua) ? "Phone" : "Computer";
const anonId = v => (typeof v === "string" && /^[a-z0-9]{8,40}$/i.test(v)) ? v : "";
function sourceOf(ref, utm, host) {
  const u = str(utm, 60).toLowerCase();
  if (u) return u.replace(/[^a-z0-9 ._-]/g, "").slice(0, 60) || "Direct";
  try {
    const h = new URL(ref).hostname.replace(/^www\./, "").toLowerCase();
    if (!h || h === String(host || "").replace(/^www\./, "").toLowerCase()) return "Direct";
    return h.slice(0, 80);
  } catch (e) { return "Direct"; }
}
const insertEvent = db.prepare("INSERT INTO events(at,visitor,visit,type,page,product,source,device) VALUES(?,?,?,?,?,?,?,?)");
function track(req, e) {
  const ua = String(req.get("user-agent") || "");
  if (!ua || BOT_UA.test(ua)) return;
  if (req.session && req.session.admin) return; // the owner browsing the shop doesn't count
  const visitor = anonId(e.visitor), visit = anonId(e.visit);
  if (!visitor || !visit || !EVENT_TYPES.includes(e.type)) return;
  insertEvent.run(new Date().toISOString(), visitor, visit, e.type, str(e.page, 60), str(e.product, 60),
    e.type === "pageview" ? sourceOf(str(e.ref, 300), e.utm, req.hostname) : "", deviceOf(ua));
}
app.post("/api/track", limit("track", 240, 15 * 60e3), (req, res) => {
  const b = req.body || {};
  if (b.type === "order" || b.type === "message") return res.status(204).end(); // recorded by the server itself
  track(req, b);
  res.status(204).end();
});
setInterval(() => db.prepare("DELETE FROM events WHERE at < ?").run(new Date(Date.now() - 400 * 864e5).toISOString()), 24 * 3600e3).unref();

/* ----- owner API ----- */
const sha = s => crypto.createHash("sha256").update(String(s)).digest();
const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const requireAdmin = (req, res, next) => (req.session && req.session.admin) ? next() : res.status(401).json({ error: "Please sign in again." });

app.post("/api/admin/login", limit("login", 8, 15 * 60e3), (req, res) => {
  const { email = "", password = "" } = req.body || {};
  const ok = same(String(email).trim().toLowerCase(), env.ADMIN_EMAIL.trim().toLowerCase()) & same(password, env.ADMIN_PASSWORD);
  if (!ok) return res.status(401).json({ error: "That email or password isn’t right. Try again." });
  req.session.admin = true; req.session.at = Date.now();
  res.json({ ok: true });
});
app.post("/api/admin/logout", (req, res) => { req.session = null; res.json({ ok: true }); });
app.get("/api/admin/me", (req, res) => res.json({ authed: !!(req.session && req.session.admin) }));

app.get("/api/admin/all", requireAdmin, (req, res) => {
  const rows = t => db.prepare(`SELECT data, status FROM ${t} ORDER BY created_at DESC LIMIT 500`).all().map(r => ({ ...JSON.parse(r.data), status: r.status }));
  res.json({ products: allProducts(), orders: rows("orders"), messages: rows("messages"),
    season: getSetting("season", {}), delivery: getSetting("delivery", {}) });
});

app.get("/api/admin/analytics", requireAdmin, (req, res) => {
  const RANGES = { today: 0, "7": 7, "30": 30, "90": 90, all: null };
  const range = Object.hasOwn(RANGES, req.query.range) ? req.query.range : "30";
  const tz = Math.max(-840, Math.min(840, Math.round(num(req.query.tz) || 0))); // browser's offset from UTC, minutes
  const shift = `${tz >= 0 ? "+" : ""}${tz} minutes`;
  const localDay = d => new Date(d.getTime() + tz * 60e3).toISOString().slice(0, 10);
  const today = localDay(new Date());
  let from = "";
  if (range !== "all") {
    const start = new Date(Date.parse(today + "T00:00:00Z") - RANGES[range] * 864e5 + (RANGES[range] ? 864e5 : 0));
    from = new Date(start.getTime() - tz * 60e3).toISOString(); // local midnight, as UTC
  }
  const q = (sql, ...a) => db.prepare(sql).all(from, ...a);
  const one = (sql, ...a) => db.prepare(sql).get(from, ...a);
  const W = "at >= ?";
  const totals = one(`SELECT COUNT(DISTINCT visitor) visitors, COUNT(DISTINCT visit) visits,
      SUM(type='pageview') pageviews, SUM(type='add_to_cart') adds,
      COUNT(DISTINCT CASE WHEN type='pageview' AND page='checkout' THEN visit END) checkouts FROM events WHERE ${W}`);
  const returning = one(`SELECT COUNT(*) n FROM (SELECT visitor FROM events WHERE ${W} GROUP BY visitor HAVING COUNT(DISTINCT visit) > 1)`).n;
  const funnel = one(`SELECT COUNT(DISTINCT visit) visits,
      COUNT(DISTINCT CASE WHEN type='pageview' AND page='kit' THEN visit END) viewedKit,
      COUNT(DISTINCT CASE WHEN type='add_to_cart' THEN visit END) added,
      COUNT(DISTINCT CASE WHEN type='pageview' AND page='checkout' THEN visit END) checkout,
      COUNT(DISTINCT CASE WHEN type='order' THEN visit END) ordered FROM events WHERE ${W}`);
  const fromOr = from || "0";
  const orders = db.prepare("SELECT data FROM orders WHERE created_at >= ?").all(fromOr).map(r => JSON.parse(r.data));
  const messages = db.prepare("SELECT COUNT(*) n FROM messages WHERE created_at >= ?").get(fromOr).n;
  const daily = q(`SELECT date(at, '${shift}') day, COUNT(DISTINCT visitor) visitors, SUM(type='pageview') views
      FROM events WHERE ${W} GROUP BY day ORDER BY day`);
  const dayOrders = {}, dayMsgs = {};
  for (const o of orders) { const d = localDay(new Date(o.created_at)); dayOrders[d] = (dayOrders[d] || 0) + 1; }
  for (const r of db.prepare("SELECT created_at FROM messages WHERE created_at >= ?").all(fromOr)) { const d = localDay(new Date(r.created_at)); dayMsgs[d] = (dayMsgs[d] || 0) + 1; }
  // fill every day in the range so quiet days show as zero
  const byDay = Object.fromEntries(daily.map(r => [r.day, r]));
  const first = from ? localDay(new Date(from)) : [daily[0] && daily[0].day, ...Object.keys(dayOrders), ...Object.keys(dayMsgs)].filter(Boolean).sort()[0] || today;
  const days = [];
  for (let t = Date.parse(first + "T00:00:00Z"); t <= Date.parse(today + "T00:00:00Z") && days.length < 800; t += 864e5) {
    const d = new Date(t).toISOString().slice(0, 10), r = byDay[d] || {};
    days.push({ day: d, visitors: r.visitors || 0, views: r.views || 0, orders: dayOrders[d] || 0, messages: dayMsgs[d] || 0 });
  }
  const names = Object.fromEntries(allProducts().map(p => [p.id, p.name]));
  const kits = q(`SELECT product id, SUM(type='pageview') views, SUM(type='add_to_cart') adds, COUNT(DISTINCT CASE WHEN type='pageview' THEN visitor END) people
      FROM events WHERE ${W} AND product != '' GROUP BY product ORDER BY views DESC LIMIT 20`)
    .map(k => ({ ...k, name: names[k.id] || k.id + " (deleted)" }));
  const sold = {};
  for (const o of orders) for (const i of o.items) sold[i.id] = (sold[i.id] || 0) + i.qty;
  for (const k of kits) k.sold = sold[k.id] || 0;
  const firstSource = `SELECT visit, source FROM events WHERE ${W} AND type='pageview' AND id IN (SELECT MIN(id) FROM events WHERE ${W} AND type='pageview' GROUP BY visit)`;
  const sources = db.prepare(`SELECT source name, COUNT(*) n FROM (${firstSource}) GROUP BY source ORDER BY n DESC LIMIT 12`).all(from, from);
  const devices = q(`SELECT device name, COUNT(DISTINCT visitor) n FROM events WHERE ${W} GROUP BY device ORDER BY n DESC`);
  const pages = q(`SELECT page name, COUNT(*) n FROM events WHERE ${W} AND type='pageview' GROUP BY page ORDER BY n DESC LIMIT 10`);
  const hours = q(`SELECT CAST(strftime('%H', at, '${shift}') AS INTEGER) h, COUNT(DISTINCT visit) n FROM events WHERE ${W} GROUP BY h`);
  const live = db.prepare("SELECT COUNT(DISTINCT visitor) n FROM events WHERE at >= ?").get(new Date(Date.now() - 5 * 60e3).toISOString()).n;
  const firstEvent = db.prepare("SELECT MIN(at) at FROM events").get().at;
  res.json({
    range, live, since: firstEvent,
    totals: { visitors: totals.visitors || 0, visits: totals.visits || 0, pageviews: totals.pageviews || 0, adds: totals.adds || 0,
      checkouts: totals.checkouts || 0, orders: orders.length, messages, returning,
      revenue: r2(orders.reduce((s, o) => s + (o.total || 0), 0)), kitsOrdered: orders.reduce((s, o) => s + o.items.reduce((a, i) => a + i.qty, 0), 0) },
    funnel, days, kits, sources, devices, pages, hours
  });
});

const slug = s => (s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "item");
app.post("/api/admin/products", requireAdmin, (req, res) => {
  const b = req.body || {};
  const p = {
    name: str(b.name, 120), blurb: str(b.blurb, 1500),
    included: (Array.isArray(b.included) ? b.included : []).map(x => str(x, 120)).filter(Boolean).slice(0, 30),
    price: r2(num(b.price)), bulkMin: Math.max(0, Math.floor(num(b.bulkMin) || 0)),
    bulkPct: Math.min(90, Math.max(0, num(b.bulkPct) || 0)), visible: !!b.visible,
    photos: [...new Set((Array.isArray(b.photos) ? b.photos : [b.photo]).map(safeUrl).filter(Boolean))].slice(0, 10),
    variants: cleanVariants(b.variants), chooseLabel: str(b.chooseLabel, 30), custom: cleanCustom(b.custom)
  };
  if (p.custom) { p.variants = []; p.chooseLabel = ""; } // a custom-order listing has no sub-items
  p.photo = p.photos[0] || "";
  if (!(p.price > 0 && p.price < 100000)) p.price = 0;
  const errors = {};
  if (!p.name) errors.name = "Give the item a name.";
  const names = p.variants.map(v => v.name.toLowerCase());
  if (p.variants.some(v => !v.name)) errors.variants = "Every sub-item needs a name.";
  else if (new Set(names).size < names.length) errors.variants = "Two sub-items have the same name.";
  else if (!p.variants.length && !(p.price > 0)) errors.price = p.custom ? "Enter the base price, like 4.00." : "Enter a price, like 7.99.";
  else if (p.variants.some(v => !(priceOf(p, v) > 0))) errors.variants = "Give each sub-item a price, or set one price for the whole item.";
  if (Object.keys(errors).length) return res.status(400).json({ error: "Please fix the highlighted fields.", errors });
  const customJson = p.custom ? JSON.stringify(p.custom) : "";
  let id = typeof b.id === "string" && findProduct(b.id) ? b.id : null;
  if (id) {
    const old = findProduct(id);
    db.prepare("UPDATE products SET name=?,blurb=?,included=?,price=?,bulk_min=?,bulk_pct=?,visible=?,photo=?,photos=?,variants=?,choose_label=?,custom=? WHERE id=?")
      .run(p.name, p.blurb, JSON.stringify(p.included), p.price, p.bulkMin, p.bulkPct, p.visible ? 1 : 0, p.photo, JSON.stringify(p.photos), JSON.stringify(p.variants), p.chooseLabel, customJson, id);
    const keep = [...p.photos, ...variantPhotos(p)];
    for (const u of [...old.photos, ...variantPhotos(old)]) if (!keep.includes(u)) removeUpload(u);
  } else {
    const base = slug(p.name); id = base; let i = 2;
    while (findProduct(id)) id = `${base}-${i++}`;
    db.prepare("INSERT INTO products(id,name,blurb,included,price,bulk_min,bulk_pct,visible,photo,photos,variants,choose_label,custom,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, p.name, p.blurb, JSON.stringify(p.included), p.price, p.bulkMin, p.bulkPct, p.visible ? 1 : 0, p.photo, JSON.stringify(p.photos), JSON.stringify(p.variants), p.chooseLabel, customJson, new Date().toISOString());
  }
  res.json({ product: findProduct(id) });
});
app.delete("/api/admin/products/:id", requireAdmin, (req, res) => {
  const p = findProduct(req.params.id);
  if (!p) return res.status(404).json({ error: "That item was already deleted." });
  db.prepare("DELETE FROM products WHERE id=?").run(p.id);
  [...p.photos, ...variantPhotos(p)].forEach(removeUpload);
  res.json({ ok: true });
});
function removeUpload(url) {
  if (!url || !url.startsWith("/uploads/")) return;
  const s = getSetting("season", {});
  const inUse = s.photo === url || db.prepare("SELECT 1 FROM products WHERE photo=? OR photos LIKE ? OR variants LIKE ?").get(url, `%${JSON.stringify(url)}%`, `%${JSON.stringify(url)}%`);
  if (!inUse) fs.rm(path.join(UPLOADS, path.basename(url)), { force: true }, () => {});
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
const MAGIC = { jpg: [0xff, 0xd8, 0xff], png: [0x89, 0x50, 0x4e, 0x47], webp: [0x52, 0x49, 0x46, 0x46] };
app.post("/api/admin/upload", requireAdmin, (req, res) => {
  upload.single("photo")(req, res, err => {
    if (err) return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "That photo is too large. Try one under 8 MB." : "That photo couldn’t be uploaded." });
    const f = req.file;
    const ext = f && Object.keys(MAGIC).find(k => MAGIC[k].every((b, i) => f.buffer[i] === b));
    if (!ext) return res.status(400).json({ error: "Use a JPG, PNG or WebP photo." });
    const name = crypto.randomBytes(12).toString("hex") + "." + ext;
    fs.writeFileSync(path.join(UPLOADS, name), f.buffer);
    res.json({ url: "/uploads/" + name });
  });
});

app.put("/api/admin/season", requireAdmin, (req, res) => {
  const b = req.body || {}, old = getSetting("season", {});
  const s = { theme: THEMES.includes(b.theme) ? b.theme : "chanukah", show: !!b.show, headline: str(b.headline, 120),
    text: str(b.text, 300), button: str(b.button, 40), link: str(b.link, 60), photo: safeUrl(b.photo) };
  setSetting("season", s);
  if (old.photo !== s.photo) removeUpload(old.photo);
  res.json({ season: s });
});

function cleanRings(rings) {
  return (Array.isArray(rings) ? rings : []).map(r => ({ miles: r2(num(r.miles)), fee: r2(num(r.fee)) }))
    .filter(r => r.miles > 0 && r.miles <= 100 && r.fee >= 0 && r.fee < 1000).sort((a, b) => a.miles - b.miles).slice(0, 10);
}
app.post("/api/admin/delivery/generate", requireAdmin, (req, res) => {
  const b = req.body || {};
  const homeZip = str(b.homeZip, 5), rings = cleanRings(b.rings);
  const home = isZip(homeZip) && zipcodes.lookup(homeZip);
  if (!home) return res.status(400).json({ error: "Enter your own 5-digit ZIP code first.", errors: { homeZip: "We couldn’t find that ZIP code." } });
  if (!rings.length) return res.status(400).json({ error: "Add at least one distance and price." });
  const max = rings[rings.length - 1].miles;
  const zones = {};
  for (const zip of zipcodes.radius(homeZip, max + 1)) {
    const z = zipcodes.lookup(zip); if (!z) continue;
    const miles = r2(milesBetween(home, z));
    const ring = rings.find(r => miles <= r.miles);
    if (ring) zones[zip] = { fee: ring.fee, miles: Math.round(miles * 10) / 10, place: `${z.city}, ${z.state}`, manual: false };
  }
  const keep = b.keepManual !== false && b.zones && typeof b.zones === "object" ? b.zones : {};
  for (const [zip, z] of Object.entries(keep)) if (isZip(zip) && z && z.manual) zones[zip] = z;
  res.json({ zones });
});
app.put("/api/admin/delivery", requireAdmin, (req, res) => {
  const b = req.body || {};
  const homeZip = str(b.homeZip, 5);
  const home = isZip(homeZip) && zipcodes.lookup(homeZip);
  const zones = {};
  for (const [zip, z] of Object.entries(b.zones && typeof b.zones === "object" ? b.zones : {}).slice(0, 3000)) {
    const fee = r2(num(z && z.fee));
    if (!isZip(zip) || !(fee >= 0 && fee < 1000)) continue;
    let miles = (z.miles === null || z.miles === undefined || z.miles === "") ? null : num(z.miles);
    if (!(miles >= 0)) miles = null;
    const loc = zipcodes.lookup(zip);
    if (miles === null && home && loc) miles = Math.round(milesBetween(home, loc) * 10) / 10;
    zones[zip] = { fee, miles, place: str(z.place, 80) || (loc ? `${loc.city}, ${loc.state}` : ""), manual: !!z.manual };
  }
  const d = { homeZip: isZip(homeZip) ? homeZip : "", rings: cleanRings(b.rings), freeOver: Math.max(0, r2(num(b.freeOver) || 0)), zones };
  setSetting("delivery", d);
  res.json({ delivery: d });
});

const setStatus = kind => (req, res) => {
  const allowed = kind === "orders" ? ["New", "Confirmed", "Done"] : ["New", "Replied"];
  const status = req.body && req.body.status;
  if (!allowed.includes(status)) return res.status(400).json({ error: "Unknown status." });
  const r = db.prepare(`UPDATE ${kind} SET status=? WHERE id=?`).run(status, req.params.id);
  if (!r.changes) return res.status(404).json({ error: "Not found." });
  res.json({ ok: true });
};
app.patch("/api/admin/orders/:id", requireAdmin, setStatus("orders"));
app.patch("/api/admin/messages/:id", requireAdmin, setStatus("messages"));

/* ----- static + pages ----- */
app.use("/uploads", express.static(UPLOADS, { maxAge: "30d", immutable: true, index: false }));
// The page's script and styles must update as soon as a new version is installed, so browsers
// always check for a newer copy (a quick "not changed" answer when nothing changed). Images may be kept for an hour.
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h", index: false,
  setHeaders: (res, file) => { if (/\.(js|css)$/.test(file)) res.setHeader("Cache-Control", "no-cache"); } }));
const page = (req, res) => res.sendFile(path.join(__dirname, "public", "index.html"), { headers: { "Cache-Control": "no-cache" } });
app.get("/", page);
app.get("/admin", page);
app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));
app.use((req, res) => res.redirect("/"));
app.use((err, req, res, next) => {
  console.error(err);
  if (err.type === "entity.too.large") return res.status(413).json({ error: "That was too much data to send." });
  res.status(500).json({ error: "Something went wrong on our side. Please try again." });
});

app.listen(PORT, () => console.log(`Paint Party Kits running on port ${PORT}`));
