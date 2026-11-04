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
`);
const getSetting = (k, fallback) => { const r = db.prepare("SELECT value FROM settings WHERE key=?").get(k); return r ? JSON.parse(r.value) : fallback; };
const setSetting = (k, v) => db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, JSON.stringify(v));

if (!getSetting("seeded", false)) {
  db.prepare(`INSERT OR IGNORE INTO products(id,name,blurb,included,price,bulk_min,bulk_pct,visible,photo,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run("chanukah", "Chanukah Paint Party Kit",
      "A paint-your-own plaster donut kit. A fun, creative Chanukah activity for kids, perfect for parties, classrooms and family nights.",
      JSON.stringify(["1 plaster donut", "3 paint colors", "1 paintbrush"]), 7.99, 10, 16, 1, "/img/kit.jpg", new Date().toISOString());
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
const rowToProduct = r => r && ({ id: r.id, name: r.name, blurb: r.blurb, included: JSON.parse(r.included), price: r.price,
  bulkMin: r.bulk_min, bulkPct: r.bulk_pct, visible: !!r.visible, photo: r.photo });
const allProducts = () => db.prepare("SELECT * FROM products ORDER BY created_at").all().map(rowToProduct);
const findProduct = id => rowToProduct(db.prepare("SELECT * FROM products WHERE id=?").get(id));
const hasBulk = p => p.bulkMin > 1 && p.bulkPct > 0;
function priceFor(p, q) {
  const bulk = hasBulk(p) && q >= p.bulkMin;
  const unit = bulk ? r2(p.price * (1 - p.bulkPct / 100)) : p.price;
  return { bulk, unit, total: r2(unit * q), full: r2(p.price * q) };
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
  const items = [];
  for (const it of Array.isArray(body.items) ? body.items.slice(0, 50) : []) {
    const p = findProduct(String(it.id || ""));
    const qty = Math.floor(num(it.qty));
    if (!p || !p.visible || !(qty >= 1 && qty <= 999)) continue;
    const r = priceFor(p, qty);
    items.push({ id: p.id, name: p.name, qty, unit: r.unit, total: r.total, full: r.full, bulk: r.bulk, pct: p.bulkPct });
  }
  if (!items.length) errors.items = "Your cart is empty or a kit is no longer available.";
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
function orderEmail(o) {
  const addr = o.address ? `${o.address.street}${o.address.unit ? ", " + o.address.unit : ""}, ${o.address.city}, ${o.address.state} ${o.address.zip}` : "";
  return {
    subject: `New order ${o.id}: ${o.items.reduce((s, i) => s + i.qty, 0)} kits, ${money(o.total)}`,
    text: `New order request ${o.id}

${o.items.map(i => `• ${i.qty} × ${i.name} @ ${money(i.unit)}${i.bulk ? ` (${i.pct}% bulk)` : ""} = ${money(i.total)}`).join("\n")}
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
  res.json({ message: m, email: { subject: `New message: ${m.topic}`,
    text: `New message from the website\n\nTopic: ${m.topic}\nName: ${m.name}\nPhone: ${m.phone}\nEmail: ${m.email}\n\n${m.message}` } });
});

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

const slug = s => (s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "kit");
app.post("/api/admin/products", requireAdmin, (req, res) => {
  const b = req.body || {};
  const p = {
    name: str(b.name, 120), blurb: str(b.blurb, 1500),
    included: (Array.isArray(b.included) ? b.included : []).map(x => str(x, 120)).filter(Boolean).slice(0, 30),
    price: r2(num(b.price)), bulkMin: Math.max(0, Math.floor(num(b.bulkMin) || 0)),
    bulkPct: Math.min(90, Math.max(0, num(b.bulkPct) || 0)), visible: !!b.visible, photo: safeUrl(b.photo)
  };
  const errors = {};
  if (!p.name) errors.name = "Give the product a name.";
  if (!(p.price > 0 && p.price < 100000)) errors.price = "Enter a price, like 7.99.";
  if (Object.keys(errors).length) return res.status(400).json({ error: "Please fix the highlighted fields.", errors });
  let id = typeof b.id === "string" && findProduct(b.id) ? b.id : null;
  if (id) {
    const old = findProduct(id);
    db.prepare("UPDATE products SET name=?,blurb=?,included=?,price=?,bulk_min=?,bulk_pct=?,visible=?,photo=? WHERE id=?")
      .run(p.name, p.blurb, JSON.stringify(p.included), p.price, p.bulkMin, p.bulkPct, p.visible ? 1 : 0, p.photo, id);
    if (old.photo !== p.photo) removeUpload(old.photo);
  } else {
    const base = slug(p.name); id = base; let i = 2;
    while (findProduct(id)) id = `${base}-${i++}`;
    db.prepare("INSERT INTO products(id,name,blurb,included,price,bulk_min,bulk_pct,visible,photo,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(id, p.name, p.blurb, JSON.stringify(p.included), p.price, p.bulkMin, p.bulkPct, p.visible ? 1 : 0, p.photo, new Date().toISOString());
  }
  res.json({ product: findProduct(id) });
});
app.delete("/api/admin/products/:id", requireAdmin, (req, res) => {
  const p = findProduct(req.params.id);
  if (!p) return res.status(404).json({ error: "That product was already deleted." });
  db.prepare("DELETE FROM products WHERE id=?").run(p.id);
  removeUpload(p.photo);
  res.json({ ok: true });
});
function removeUpload(url) {
  if (!url || !url.startsWith("/uploads/")) return;
  const s = getSetting("season", {});
  const inUse = s.photo === url || db.prepare("SELECT 1 FROM products WHERE photo=?").get(url);
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
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h", index: false }));
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
