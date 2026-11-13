"use strict";
/* Paint Party Kits – storefront and owner admin */

const IS_ADMIN = location.pathname.replace(/\/+$/, "") === "/admin";
const CART_KEY = "ppk-cart";
const THEMES = {
  chanukah: { name: "Chanukah", brand: "#2347C6", wash: "#EAF0FF", accent: "#F2B233", deep: "#13246B", banner: "#E8F0FF" },
  purim:    { name: "Purim", brand: "#7A3FD1", wash: "#F2EAFF", accent: "#FF5A9E", deep: "#3A1870", banner: "#F3ECFF" },
  spring:   { name: "Pesach & spring", brand: "#1C8A5A", wash: "#E2F5EB", accent: "#F2B233", deep: "#0E4A30", banner: "#E9F7EF" },
  summer:   { name: "Summer", brand: "#E0485A", wash: "#FFE8EB", accent: "#14B8A6", deep: "#6E1824", banner: "#FFF0EC" },
  fall:     { name: "Fall & Sukkot", brand: "#C2541D", wash: "#FDEBDF", accent: "#7E9A2E", deep: "#5A240B", banner: "#FFF2E7" },
  everyday: { name: "Everyday", brand: "#5B3DF5", wash: "#EEEAFF", accent: "#FF4F86", deep: "#251A6E", banner: "#F1EEFF" }
};
const STATES = ["AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"];

let store = null;                       // public store data from the server
let cart = loadCart();
const ui = { query: "", searchOpen: false, wantSearchFocus: false, qty: {}, method: "pickup", lastOrder: null,
  contactSent: null, zipQuote: null, zipFor: "", busy: false };
const admin = { authed: false, data: null, tab: "products", draft: null, sdraft: null, ddraft: null, deleteArmed: false, busy: false, loginError: "",
  an: null, anRange: "30", anLoading: false };
ui.sel = {}; ui.photo = {}; ui.cust = {};

/* ---------------- helpers ---------------- */
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const r2 = n => Math.round(n * 100) / 100;
const money = n => "$" + r2(n).toFixed(2);
const hasBulk = p => p.bulkMin > 1 && p.bulkPct > 0;
const bulkUnit = p => r2(p.price * (1 - p.bulkPct / 100));
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
// bulkQty: all of this item in the cart (any choice); each: price of one before any bulk discount
function priceFor(p, q, bulkQty = q, each = p.price) {
  const bulk = hasBulk(p) && bulkQty >= p.bulkMin, unit = bulk ? r2(each * (1 - p.bulkPct / 100)) : each;
  return { bulk, unit, total: r2(unit * q), full: r2(each * q) };
}
const findP = id => store && store.products.find(p => p.id === id);
const photosOf = p => (p.photos && p.photos.length ? p.photos : p.photo ? [p.photo] : []);
/* Choices ("sub-listings"): p.variants = [{ id, name, price, photo, note, soldOut }].
   A choice without its own price uses the item's price. Items with choices need one picked. */
const hasChoices = p => (p.variants || []).length > 0;
const choiceOf = (p, vid) => (p.variants || []).find(v => v.id === vid) || null;
const priceOf = (p, v) => (v && v.price > 0 ? v.price : p.price);
const chooseWord = p => (p.chooseLabel || "option").trim().toLowerCase();
/* Custom-order listings (e.g. name clickers): p.custom = { unit, min, max, included, extra, colors, askText, textLabel }.
   The customer picks how many units (letters), a color (shown only as a swatch), and may type the text.
   The item's price covers up to `included` units; each one over that adds `extra`. A cart line keeps c = { n, color, text }. */
const isCustom = p => !!(p && p.custom);
const unitsWord = (c, n) => n === 1 ? c.unit : /(s|x|z|ch|sh)$/i.test(c.unit) ? c.unit + "es" : c.unit + "s";
const customPrice = (p, n) => r2(p.price + Math.max(0, n - p.custom.included) * p.custom.extra);
const letterCount = t => [...String(t || "").replace(/\s/g, "")].length;
const custSel = id => (ui.cust[id] ||= { n: 0, color: "", text: "" });
function customOk(p, c) {
  const cu = p.custom;
  return !!c && Number.isInteger(c.n) && c.n >= cu.min && c.n <= cu.max && (!cu.colors.length || cu.colors.includes(c.color))
    && (!cu.askText || (!!c.text && letterCount(c.text) <= c.n));
}
const cdot = hex => `<i class="cdot" style="background:${esc(hex)}"></i>`;
// c = { n, unit, color, text }; showHex: print the color code too (owner views)
const customHTML = (c, showHex) => [`${c.n} ${esc(c.unit)}`, c.color ? cdot(c.color) + (showHex ? " " + esc(c.color) : `<span class="sr">color ${esc(c.color)}</span>`) : "", c.text ? `“${esc(c.text)}”` : ""].filter(Boolean).join(" · ");
const CUSTOM_DEFAULT = { unit: "letter", min: 1, max: 12, included: 4, extra: 1, colors: [], askText: true, textLabel: "Name" };
function priceRange(p) {
  if (isCustom(p)) return { lo: customPrice(p, p.custom.min), hi: customPrice(p, p.custom.max) };
  if (!hasChoices(p)) return { lo: p.price, hi: p.price };
  const open = p.variants.filter(v => !v.soldOut), list = (open.length ? open : p.variants).map(v => priceOf(p, v));
  return { lo: Math.min(...list), hi: Math.max(...list) };
}
const choiceText = (label, name) => name ? (label ? `${label}: ${name}` : name) : "";
const lineKey = l => l.id + "|" + (l.v || "") + (l.c ? "|" + JSON.stringify([l.c.n, l.c.color || "", l.c.text || ""]) : "");
const itemRoute = r => r.startsWith("item-") ? r.slice(5) : r.startsWith("kit-") ? r.slice(4) : null; // old "kit-" links keep working
const REQ = `<span class="req" aria-hidden="true">*</span>`;
const REQ_NOTE = `<p class="fine" style="margin-top:-6px">Fields marked <span class="req" style="margin:0">*</span> are required.</p>`;

async function api(method, url, body) {
  const opts = { method, headers: { Accept: "application/json" }, credentials: "same-origin" };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  let res, json = {};
  try { res = await fetch(url, opts); json = await res.json().catch(() => ({})); }
  catch (e) { const err = new Error("We couldn’t reach the website. Check your connection and try again."); err.status = 0; throw err; }
  if (!res.ok) { const err = new Error(json.error || "Something went wrong. Please try again."); err.status = res.status; err.errors = json.errors || {}; throw err; }
  return json;
}
/* ---------------- anonymous visit counting (shown only in the owner's Analytics tab) ---------------- */
const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(36).padStart(2, "0")).join("").slice(0, 20);
function analyticsIds() {
  let visitor = "", visit = "", now = Date.now();
  try {
    visitor = localStorage.getItem("ppk-vid") || "";
    if (!/^[a-z0-9]{8,40}$/.test(visitor)) { visitor = rid(); localStorage.setItem("ppk-vid", visitor); }
  } catch (e) { visitor = visitor || (window.__ppkVid ||= rid()); }
  try {
    const v = JSON.parse(sessionStorage.getItem("ppk-visit") || "null");
    visit = v && now - v.last < 30 * 60e3 ? v.id : "";              // a visit ends after 30 quiet minutes
    if (!visit) visit = rid();
    sessionStorage.setItem("ppk-visit", JSON.stringify({ id: visit, last: now }));
  } catch (e) { visit = window.__ppkVisit ||= rid(); }
  return { visitor, visit };
}
let firstView = true;
function track(type, extra) {
  if (IS_ADMIN) return;
  const body = { ...analyticsIds(), type, ...extra };
  if (type === "pageview" && firstView) {
    firstView = false;
    body.ref = document.referrer;
    try { body.utm = new URLSearchParams(location.search).get("utm_source") || ""; } catch (e) {}
  }
  fetch("/api/track", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive: true, credentials: "same-origin" }).catch(() => {});
}
function pageName(r) {
  if (itemRoute(r)) return { page: "kit", product: itemRoute(r) };
  return { page: ["cart", "checkout", "order-sent", "contact"].includes(r) ? r : "home" };
}
function loadCart() { try { const c = JSON.parse(localStorage.getItem(CART_KEY) || "[]"); return Array.isArray(c) ? c : []; } catch (e) { return []; } }
function saveCart() { try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch (e) {} }
function applyTheme(key) {
  const th = THEMES[key] || THEMES.chanukah, s = document.documentElement.style;
  s.setProperty("--brand", th.brand); s.setProperty("--brand-wash", th.wash); s.setProperty("--accent", th.accent);
  s.setProperty("--deep", th.deep); s.setProperty("--banner", th.banner);
}
function toast(msg, action) {
  const t = document.getElementById("toast");
  t.innerHTML = `<span>${esc(msg)}</span>` + (action ? `<button data-go="${action.go}">${esc(action.label)}</button>` : "");
  t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 3200);
}
function showErrs(form, errs) {
  form.querySelectorAll("[data-err]").forEach(e => e.textContent = errs[e.dataset.err] || "");
  form.querySelectorAll(".input").forEach(i => i.classList.toggle("bad", !!errs[i.name]));
  if (Object.keys(errs).length) { form.querySelector(".bad")?.focus(); return true; }
  return false;
}
function setBusy(btn, on, label) { if (!btn) return; if (on) { btn.dataset.label = btn.textContent; btn.textContent = label; btn.disabled = true; } else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; } }
async function sendEmail(email, replyTo, name) {
  if (!store || !store.web3formsKey) return;
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    await fetch("https://api.web3forms.com/submit", {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, signal: ctrl.signal,
      body: JSON.stringify({ access_key: store.web3formsKey, subject: email.subject, from_name: "Paint Party Kits website",
        name, email: replyTo, replyto: replyTo, message: email.text })
    });
  } catch (e) { console.warn("Email notification could not be sent; it is saved in the admin.", e); }
  finally { clearTimeout(timer); }
}
function resizeToBlob(file, max) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), im = new Image();
    im.onload = () => {
      const s = Math.min(1, max / Math.max(im.width, im.height)), c = document.createElement("canvas");
      c.width = Math.round(im.width * s); c.height = Math.round(im.height * s);
      const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(im, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob(b => b ? resolve(b) : reject(new Error("resize")), "image/jpeg", 0.85);
    };
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error("load")); };
    im.src = url;
  });
}
async function uploadPhoto(file, max) {
  const blob = await resizeToBlob(file, max);
  const fd = new FormData(); fd.append("photo", blob, "photo.jpg");
  return (await api("POST", "/api/admin/upload", fd)).url;
}

/* ---------------- icons ---------------- */
const MARK = `<img class="mark" src="/img/logo.webp" alt="Paint Party logo" width="48" height="46">`;
const CART_ICON = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.5L21 8H6.2"/><circle cx="10" cy="20.5" r="1.3"/><circle cx="17" cy="20.5" r="1.3"/></svg>`;
const SEARCH_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`;
const CLOSE_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
const CHECK = `<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;

/* ---------------- cart ---------------- */
function cartLines() {
  const lines = cart.map(l => ({ ...l, key: lineKey(l), p: findP(l.id) })).filter(l => l.p), per = {};
  lines.forEach(l => per[l.id] = (per[l.id] || 0) + l.qty);
  lines.forEach(l => { l.bulkQty = per[l.id]; l.choice = choiceOf(l.p, l.v); l.each = priceOf(l.p, l.choice); }); // bulk counts every choice of an item together
  lines.forEach(l => { if (isCustom(l.p) && l.c) { l.each = customPrice(l.p, l.c.n); l.cu = { ...l.c, unit: unitsWord(l.p.custom, l.c.n) }; } });
  return lines;
}
function cartCount() { return cartLines().reduce((s, l) => s + l.qty, 0); }
function cartTotals() {
  let full = 0, total = 0;
  cartLines().forEach(l => { const r = priceFor(l.p, l.qty, l.bulkQty, l.each); full += r.full; total += r.total; });
  return { full: r2(full), total: r2(total), save: r2(full - total) };
}
function nudgeText(p, q) {
  if (!hasBulk(p)) return null;
  const any = hasChoices(p) || isCustom(p) ? " (any mix)" : "";
  if (q >= p.bulkMin) return { won: true, text: `Bulk price unlocked: ${p.bulkPct}% off each one` };
  const left = p.bulkMin - q; return { won: false, text: `Add ${left} more${any} to get ${p.bulkPct}% off each one` };
}
function addToCart(id, qty, v, c) {
  const key = lineKey({ id, v, c }), l = cart.find(x => lineKey(x) === key);
  if (l) l.qty = Math.min(999, l.qty + qty); else cart.push({ id, qty, ...(v ? { v } : {}), ...(c ? { c } : {}) });
  saveCart(); track("add_to_cart", { product: id });
  const btn = document.getElementById("cartBtn");
  if (btn) { btn.querySelector(".cart-count").textContent = cartCount(); btn.classList.remove("bump"); void btn.offsetWidth; btn.classList.add("bump"); }
  toast(qty === 1 ? "Added to cart" : `${qty} added to cart`, { go: "cart", label: "View cart" });
}
function setQty(ctx, id, q) {
  q = Math.max(1, Math.min(999, q));
  if (ctx === "pq") { ui.qty[id] = q; updateProduct(id); return q; }
  const l = cart.find(x => lineKey(x) === id); if (l) { l.qty = q; saveCart(); render(true); }
  return q;
}

/* ---------------- store chrome ---------------- */
function topbar() {
  const n = cartCount(), open = ui.searchOpen || !!ui.query;
  return `<header class="top">
    <div class="wrap">
      <button class="logo" data-go="">${MARK}<span class="logo-name">Paint Party Kits</span></button>
      <div class="top-actions">
        <a class="nav-link" href="#contact">Contact</a>
        <button class="icon-btn" data-search-toggle aria-label="Search" aria-expanded="${open}">${SEARCH_ICON}</button>
        <button class="cart-btn" id="cartBtn" data-go="cart" aria-label="Cart, ${plural(n, "item")}">${CART_ICON}<span class="txt">Cart</span><span class="cart-count">${n}</span></button>
      </div>
    </div>
    ${open ? `<div class="search-panel"><div class="wrap">
      <label class="search">${SEARCH_ICON}<input type="search" data-search placeholder="Search" value="${esc(ui.query)}" aria-label="Search" enterkeyhint="search"></label>
      <button class="icon-btn" data-search-close aria-label="Close search">${CLOSE_ICON}</button>
    </div></div>` : ""}
  </header>`;
}
function footer() {
  return `<footer><div class="wrap">
    <span>© ${new Date().getFullYear()} Paint Party Kits · <a href="#contact">Contact us</a> · <a href="mailto:${esc(store.salesEmail)}">${esc(store.salesEmail)}</a></span>
    <a href="/admin" class="textbtn" style="color:var(--muted)">Shop owner sign in</a>
  </div></footer>`;
}
const shell = inner => topbar() + `<main>${inner}</main>` + footer();

/* ---------------- home ---------------- */
function bannerHTML(s, preview) {
  const p = s.link && findP(s.link);
  const target = preview ? `tabindex="-1"` : (p ? `data-go="item-${esc(p.id)}"` : `data-scroll="lh"`);
  return `<div class="banner">
    <div class="banner-text">
      <h1>${esc(s.headline || "Your headline")}</h1>
      ${s.text ? `<p>${esc(s.text)}</p>` : ""}
      ${s.button ? `<button class="btn big" ${target}>${esc(s.button)}</button>` : ""}
    </div>
    ${s.photo ? `<div class="banner-img"><img src="${esc(s.photo)}" alt=""></div>` : ""}
  </div>`;
}
function viewHome() {
  const q = ui.query.trim().toLowerCase();
  const list = store.products.filter(p => !q || (p.name + " " + p.blurb).toLowerCase().includes(q));
  const s = store.season;
  return shell(`
  ${q || !s.show ? "" : `<section class="banner-sec"><div class="wrap">${bannerHTML(s)}</div></section>`}
  <section class="wrap" aria-labelledby="lh">
    <div class="list-head"><h2 id="lh">${q ? `Results for “${esc(ui.query.trim())}”` : "All items"}</h2><span>${plural(list.length, "item")}</span></div>
    ${list.length ? `<div class="grid">${list.map(p => card(p)).join("")}</div>`
      : q ? `<div class="empty-state"><h2>Nothing matches that search</h2><p>Try another word, or see everything we have.</p><button class="btn" data-clear-search>Show all items</button></div>`
          : `<div class="empty-state"><h2>New items are on the way</h2><p>Check back soon, or contact us with a question.</p><a class="btn" href="#contact">Contact us</a></div>`}
  </section>`);
}
function card(p, preview) {
  const go = preview ? `tabindex="-1"` : `data-go="item-${esc(p.id)}"`, choose = hasChoices(p) || isCustom(p);
  const ph = photosOf(p)[0] || (p.variants || []).map(v => v.photo).find(Boolean);
  const n = (p.variants || []).length, word = p.chooseLabel ? chooseWord(p) + (n === 1 ? "" : /s$/.test(chooseWord(p)) ? "" : "s") : (n === 1 ? "choice" : "choices");
  const optHint = isCustom(p) ? (p.custom.colors.length > 1 ? `${p.custom.colors.length} colors` : "Personalized") : choose ? `${n} ${esc(word)}` : "";
  return `<article class="card">
    <button class="ph" ${go} aria-label="View ${esc(p.name)}">${ph ? `<img src="${esc(ph)}" alt="" loading="lazy">` : ""}</button>
    <div class="body">
      <h3><button ${go}>${esc(p.name)}</button></h3>
      <div class="price">${(pr => pr.lo < pr.hi ? `<small>From</small> ${money(pr.lo)}` : `${money(pr.lo)} <small>each</small>`)(priceRange(p))}</div>
      ${hasBulk(p) ? `<span class="deal">${p.bulkPct}% off ${p.bulkMin}+</span>` : ""}
      ${optHint ? `<span class="opt-hint">${optHint}</span>` : ""}
      <div style="height:6px"></div>
      ${isCustom(p) ? `<button class="btn soft block add" ${go}>Customize</button>`
        : choose ? `<button class="btn soft block add" ${go}>Choose${p.chooseLabel ? " " + esc(chooseWord(p)) : ""}</button>`
        : `<button class="btn soft block add" ${preview ? `tabindex="-1"` : `data-add="${esc(p.id)}"`}>Add to cart</button>`}
    </div></article>`;
}

/* ---------------- product ---------------- */
function stepper(ctx, q, id, sm) {
  return `<div class="stepper ${sm ? "sm" : ""}">
    <button type="button" data-step="-1" data-id="${esc(id)}" data-ctx="${ctx}" aria-label="One less">−</button>
    <input type="number" min="1" max="999" inputmode="numeric" value="${q}" data-qty data-id="${esc(id)}" data-ctx="${ctx}" aria-label="Quantity">
    <button type="button" data-step="1" data-id="${esc(id)}" data-ctx="${ctx}" aria-label="One more">+</button></div>`;
}
function viewProduct(id) {
  const p = findP(id);
  if (!p) return shell(`<div class="wrap"><div class="empty-state" style="margin-top:30px"><h2>This item isn’t available</h2><p>It may have sold out or been removed.</p><button class="btn" data-go="">See all items</button></div></div>`);
  const q = ui.qty[id] || 1, v = choiceOf(p, ui.sel[id]);
  // a picked sub-item shows its own photos first; with nothing picked and no item photos, show the first sub-item photo
  const photos = [...new Set([...(v ? v.photos || [] : []), ...photosOf(p), ...(photosOf(p).length || v ? [] : (p.variants || []).map(x => x.photo).filter(Boolean).slice(0, 1))])];
  const included = v && v.included && v.included.length ? v.included : p.included;
  const pi = Math.min(ui.photo[id] || 0, Math.max(0, photos.length - 1)), pr = priceRange(p), showPrices = pr.lo < pr.hi;
  const label = p.chooseLabel ? esc(p.chooseLabel) : "Choose one";
  const chooser = hasChoices(p) ? `<fieldset class="choose">
      <legend class="label">${label}${REQ}${v ? `<span class="opt-chosen">${esc(v.name)}</span>` : ""}</legend>
      <div class="ch-grid">${p.variants.map(x => `<label class="ch ${x.soldOut ? "out" : ""} ${x.photo ? "has-ph" : ""}">
        <input type="radio" name="choice" value="${esc(x.id)}" data-choice data-pid="${esc(p.id)}" ${v && v.id === x.id ? "checked" : ""} ${x.soldOut ? "disabled" : ""}>
        <span class="ch-box">${x.photo ? `<img src="${esc(x.photo)}" alt="" loading="lazy">` : ""}<span class="ch-txt"><b>${esc(x.name)}</b>${x.soldOut ? `<small>Sold out</small>` : showPrices ? `<small>${money(priceOf(p, x))}</small>` : ""}</span></span>
      </label>`).join("")}</div>
      <span class="err" id="chErr"></span>
    </fieldset>` : "";
  const customizer = isCustom(p) ? customChooser(p) : "";
  return shell(`<div class="wrap">
    <button class="back" data-go="">‹ All items</button>
    <div class="product">
      <div class="gallery">
        <div class="ph">${photos.length ? `<img id="mainPhoto" src="${esc(photos[pi])}" alt="${esc(p.name + (v ? ", " + v.name : ""))}">` : ""}</div>
        ${photos.length > 1 ? `<div class="thumbs">${photos.map((u, i) => `<button class="thumb" data-photo="${i}" data-pid="${esc(p.id)}" aria-label="Photo ${i + 1} of ${photos.length}" aria-pressed="${i === pi}"><img src="${esc(u)}" alt="" loading="lazy"></button>`).join("")}</div>` : ""}
      </div>
      <div>
        <h1>${esc(p.name)}</h1>
        ${p.blurb ? `<p class="lede">${esc(p.blurb)}</p>` : ""}
        ${v && v.blurb ? `<div class="ch-about"><b>${esc(v.name)}</b><p>${esc(v.blurb)}</p></div>` : ""}
        <div class="big-price" id="bigPrice"></div>
        ${hasBulk(p) ? `<p class="bulk-line">${showPrices ? `Buy ${p.bulkMin} or more${hasChoices(p) || isCustom(p) ? " (any mix)" : ""} and save ${p.bulkPct}% on each one.` : `Buy ${p.bulkMin} or more${hasChoices(p) ? " (any mix)" : ""} and pay ${money(r2(pr.lo * (1 - p.bulkPct / 100)))} each (${p.bulkPct}% off).`}</p>` : `<div style="height:20px"></div>`}
        ${included.length ? `<span class="label">What’s included</span><ul class="incl">${included.map(i => `<li>${esc(i)}</li>`).join("")}</ul>` : ""}
        <div class="buy">
          ${chooser}${customizer}
          <div class="buy-row">
            <div><span class="label">Quantity</span>${stepper("pq", q, id)}</div>
            <div class="line-total" id="plt"></div>
          </div>
          <div class="nudge" id="pn"></div>
          <button class="btn big block" data-add="${esc(id)}" data-from-page>Add to cart</button>
        </div>
      </div>
    </div></div>`);
}
function customChooser(p) {
  const cu = p.custom, s = custSel(p.id), counts = [];
  for (let n = cu.min; n <= cu.max; n++) counts.push(n);
  const pid = esc(p.id), many = unitsWord(cu, 2), k = letterCount(s.text);
  return `<div class="choose cust">
    <fieldset class="choose"><legend class="label">How many ${esc(many)}?${REQ}<span class="opt-chosen" id="cntChosen">${s.n ? esc(`${s.n} ${unitsWord(cu, s.n)}`) : ""}</span></legend>
      <div class="cnt-grid">${counts.map(n => `<label class="ch"><input type="radio" name="cnt" value="${n}" data-cnt data-pid="${pid}" ${s.n === n ? "checked" : ""}>
        <span class="ch-box"><span class="ch-txt"><b>${n}</b><small>${money(customPrice(p, n))}</small></span></span></label>`).join("")}</div>
      ${cu.extra > 0 && cu.included < cu.max ? `<p class="fine cust-note">${money(p.price)} includes up to ${cu.included} ${esc(unitsWord(cu, cu.included))}. Each extra ${esc(cu.unit)} is ${money(cu.extra)}.</p>` : ""}
    </fieldset>
    ${cu.colors.length ? `<fieldset class="choose"><legend class="label">Color${REQ}<span class="opt-chosen" id="colorChosen">${s.color ? cdot(s.color) : ""}</span></legend>
      <div class="sw-grid">${cu.colors.map((h, i) => `<label class="csw"><input type="radio" name="ccolor" value="${esc(h)}" data-color data-pid="${pid}" aria-label="Color ${i + 1} of ${cu.colors.length}" ${s.color === h ? "checked" : ""}><span style="background:${esc(h)}"></span></label>`).join("")}</div>
    </fieldset>` : ""}
    ${cu.askText ? `<div class="field"><label class="label" for="ctext" style="margin:0">${esc(cu.textLabel)}${REQ}</label>
      <input class="input" id="ctext" data-ctext data-pid="${pid}" value="${esc(s.text)}" maxlength="80" autocomplete="off" placeholder="Type the ${esc(cu.textLabel.toLowerCase())}">
      <span class="ctext-count" id="ctCount">${k ? esc(`${k} ${unitsWord(cu, k)}`) + (k > cu.max ? ` (the most is ${cu.max})` : "") : ""}</span></div>` : ""}
    <span class="err" id="chErr"></span>
  </div>`;
}
function updateCustom(id) { // refresh the chosen labels without redrawing (keeps typing focus)
  const p = findP(id), s = custSel(id), cu = p.custom;
  document.querySelectorAll("[data-cnt]").forEach(r => r.checked = Number(r.value) === s.n);
  const cc = document.getElementById("cntChosen"); if (cc) cc.textContent = s.n ? `${s.n} ${unitsWord(cu, s.n)}` : "";
  const co = document.getElementById("colorChosen"); if (co) co.innerHTML = s.color ? cdot(s.color) : "";
  const k = letterCount(s.text), ct = document.getElementById("ctCount");
  if (ct) ct.textContent = k ? `${k} ${unitsWord(cu, k)}${k > cu.max ? ` (the most is ${cu.max})` : ""}` : "";
  const err = document.getElementById("chErr"); if (err) err.textContent = "";
  updateProduct(id);
}
function updateProduct(id) {
  const p = findP(id); if (!p) return;
  const q = ui.qty[id] || 1, inCart = cart.filter(l => l.id === id).reduce((s, l) => s + l.qty, 0);
  const v = choiceOf(p, ui.sel[id]), pr = priceRange(p), cn = isCustom(p) ? custSel(id).n : 0;
  const each = cn ? customPrice(p, cn) : v ? priceOf(p, v) : pr.lo;
  const r = priceFor(p, q, q + inCart, each), n = nudgeText(p, q + inCart);
  document.getElementById("bigPrice").innerHTML = (!v && !cn && pr.lo < pr.hi ? `<small>From</small> ` : "") + `${money(each)} <small>each</small>`;
  document.getElementById("plt").innerHTML = (r.bulk ? `<s>${money(r.full)}</s>` : "") + `<b>${money(r.total)}</b>`;
  const el = document.getElementById("pn");
  if (n) { el.hidden = false; el.className = "nudge" + (n.won ? " won" : ""); el.textContent = n.text; } else el.hidden = true;
}

/* ---------------- cart ---------------- */
function viewCart() {
  const lines = cartLines();
  const back = `<button class="back" data-go="">‹ Continue shopping</button><h1 class="page-title" style="margin-top:4px">Your cart</h1>`;
  if (!lines.length) return shell(`<div class="wrap">${back}
    <div class="empty-state"><div style="color:var(--brand);display:flex;justify-content:center">${CART_ICON.replace('width="20" height="20"', 'width="44" height="44"')}</div>
    <h2>Your cart is empty</h2><p>Add an item or two and they’ll show up here.</p><button class="btn" data-go="">Browse items</button></div></div>`);
  return shell(`<div class="wrap">${back}
    <div class="cart">
      <div class="items">${lines.map((l, i) => cartItem(l, lines.slice(i + 1).some(x => x.id === l.id))).join("")}</div>
      <aside class="summary" id="sum">${summaryInner("cart")}</aside>
    </div></div>`);
}
function cartItem(l, moreBelow) { // the bulk note shows once, under the last line of that item
  const r = priceFor(l.p, l.qty, l.bulkQty, l.each), n = moreBelow ? null : nudgeText(l.p, l.bulkQty), ph = photosOf(l.p)[0];
  return `<div class="item">
    ${(l.choice && l.choice.photo) || ph ? `<img src="${esc((l.choice && l.choice.photo) || ph)}" alt="">` : `<span></span>`}
    <div>
      <h3><button data-go="item-${esc(l.p.id)}">${esc(l.p.name)}</button></h3>
      ${l.choice ? `<div class="opts">${esc(choiceText(l.p.chooseLabel, l.choice.name))}</div>` : ""}${l.cu ? `<div class="opts">${customHTML(l.cu)}</div>` : ""}
      <div class="meta">${money(r.unit)} each${r.bulk ? ` · ${l.p.bulkPct}% bulk discount` : ""}</div>
      <div class="controls">${stepper("cq", l.qty, l.key, true)}<button class="textbtn" data-remove="${esc(l.key)}">Remove</button></div>
      ${n ? `<div class="nudge ${n.won ? "won" : ""}">${esc(n.text)}</div>` : ""}
    </div>
    <div class="line-total">${r.bulk ? `<s>${money(r.full)}</s>` : ""}<b>${money(r.total)}</b></div>
  </div>`;
}
function deliveryInfo(subtotal) {
  if (ui.method !== "delivery") return null;
  const q = ui.zipQuote, freeOver = store.delivery.freeOver || 0;
  if (!q) return { label: "Enter your ZIP code", fee: 0, ok: false };
  if (!q.available) return { label: "Not available", fee: 0, ok: false, no: true };
  const free = freeOver > 0 && subtotal >= freeOver;
  return { label: free || q.baseFee === 0 ? "Free" : money(q.baseFee), fee: free ? 0 : q.baseFee, ok: true };
}
function summaryInner(mode) {
  const t = cartTotals(), n = cartCount();
  const d = mode === "checkout" ? deliveryInfo(t.total) : null;
  const freeOver = store.delivery.freeOver || 0;
  return `<h2>Order summary</h2>
    <div class="sum-row"><span>${plural(n, "item")}</span><span>${money(t.full)}</span></div>
    ${t.save > 0 ? `<div class="sum-row save"><span>Bulk savings</span><span>−${money(t.save)}</span></div>` : ""}
    ${d ? `<div class="sum-row ${d.ok ? "" : "muted"}"><span>Delivery (estimate)</span><span>${d.label}</span></div>` : ""}
    ${d && freeOver > 0 && t.total < freeOver ? `<p class="fine">Free delivery on orders over ${money(freeOver)}.</p>` : ""}
    <div class="sum-row total"><span>Total</span><b>${money(t.total + (d && d.ok ? d.fee : 0))}</b></div>
    <p class="fine">No payment today. We’ll contact you to confirm and arrange ${store.delivery.enabled ? "pickup or delivery" : "pickup"}.</p>
    ${mode === "cart" ? `<button class="btn big block" data-go="checkout">Continue to checkout</button>`
      : `<div style="display:grid;gap:10px;border-top:1px solid var(--line);padding-top:12px">${cartLines().map(l => { const r = priceFor(l.p, l.qty, l.bulkQty, l.each), ph = photosOf(l.p)[0]; return `<div class="mini">${ph ? `<img src="${esc(ph)}" alt="">` : ""}<div>${esc(l.p.name)}${l.choice ? `<br><span>${esc(choiceText(l.p.chooseLabel, l.choice.name))}</span>` : ""}${l.cu ? `<br><span>${customHTML(l.cu)}</span>` : ""}<br><span>${l.qty} × ${money(r.unit)}</span></div><b>${money(r.total)}</b></div>`; }).join("")}</div>`}`;
}
function refreshSummary(mode) { const el = document.getElementById("sum"); if (el) el.innerHTML = summaryInner(mode); }

/* ---------------- checkout ---------------- */
function viewCheckout() {
  if (!cartLines().length) { location.hash = "cart"; return ""; }
  if (!store.delivery.enabled) ui.method = "pickup";
  return shell(`<div class="wrap">
    <button class="back" data-go="cart">‹ Back to cart</button>
    <h1 class="page-title" style="margin-top:4px">Checkout</h1>
    <div class="cart">
      <form class="form-card" id="checkout" novalidate>
        <h2>Your details</h2>
        ${REQ_NOTE}
        <div class="field"><label for="c-name">Full name${REQ}</label><input class="input" id="c-name" name="name" autocomplete="name" aria-required="true"><span class="err" data-err="name"></span></div>
        <div class="two">
          <div class="field"><label for="c-phone">Phone${REQ}</label><input class="input" id="c-phone" name="phone" type="tel" autocomplete="tel" aria-required="true"><span class="err" data-err="phone"></span></div>
          <div class="field"><label for="c-email">Email${REQ}</label><input class="input" id="c-email" name="email" type="email" autocomplete="email" aria-required="true"><span class="err" data-err="email"></span></div>
        </div>
        ${store.delivery.enabled ? `<fieldset class="field"><legend>How would you like to get your order?</legend>
          <div class="choice">
            <label><input type="radio" name="method" value="pickup" ${ui.method === "pickup" ? "checked" : ""}><span>Pickup<small>We’ll send the address</small></span></label>
            <label><input type="radio" name="method" value="delivery" ${ui.method === "delivery" ? "checked" : ""}><span>Local delivery<small>To your door</small></span></label>
          </div></fieldset>
        <fieldset class="field addr" id="addr" ${ui.method === "delivery" ? "" : "hidden"}><legend>Delivery address</legend>
          <div class="field"><label for="c-street">Street address${REQ}</label><input class="input" id="c-street" name="street" autocomplete="address-line1" placeholder="123 Main St"><span class="err" data-err="street"></span></div>
          <div class="field"><label for="c-unit">Apt, suite or unit <span class="opt">Optional</span></label><input class="input" id="c-unit" name="unit" autocomplete="address-line2"></div>
          <div class="addr-row">
            <div class="field city"><label for="c-city">City${REQ}</label><input class="input" id="c-city" name="city" autocomplete="address-level2"><span class="err" data-err="city"></span></div>
            <div class="field"><label for="c-state">State${REQ}</label><select class="input" id="c-state" name="state" autocomplete="address-level1"><option value="">Select</option>${STATES.map(s => `<option>${s}</option>`).join("")}</select><span class="err" data-err="state"></span></div>
            <div class="field"><label for="c-zip">ZIP code${REQ}</label><input class="input" id="c-zip" name="zip" inputmode="numeric" autocomplete="postal-code" maxlength="10" value="${esc(ui.zipFor)}"><span class="err" data-err="zip"></span></div>
          </div>
          <div class="zone-note" id="zipNote" aria-live="polite"></div>
        </fieldset>` : `<p class="fine"><b>Pickup only.</b> We’ll send you the pickup address when we confirm your order.</p>`}
        <div class="field"><label for="c-date">When do you need it? <span class="opt">Optional</span></label><input class="input" id="c-date" name="date" type="date"></div>
        <div class="field"><label for="c-notes">Notes <span class="opt">Optional</span></label><textarea class="input" id="c-notes" name="notes" placeholder="Party date, number of kids, questions…"></textarea></div>
        <input type="checkbox" name="botcheck" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">
        <div class="alert" id="formAlert" role="alert"></div>
        <p class="policy-note">All sales are final (no returns or cancellations).</p>
        <button class="btn big block" type="submit">Place order request</button>
      </form>
      <aside class="summary" id="sum">${summaryInner("checkout")}</aside>
    </div></div>`);
}
function updateZipNote() {
  const el = document.getElementById("zipNote"); if (!el) return;
  const q = ui.zipQuote;
  if (!q) { el.className = "zone-note"; el.textContent = ""; return; }
  if (q.available) { el.className = "zone-note ok"; el.textContent = `We deliver to ${q.place || ui.zipFor}.`; }
  else { el.className = "zone-note no"; el.textContent = "We don’t deliver to this ZIP yet. Please choose pickup."; }
}
async function checkZip(zip) {
  if (!/^\d{5}$/.test(zip)) { ui.zipQuote = null; ui.zipFor = zip; updateZipNote(); refreshSummary("checkout"); return; }
  if (zip === ui.zipFor && ui.zipQuote) return;
  ui.zipFor = zip;
  try { const q = await api("GET", `/api/delivery/${zip}`); if (ui.zipFor === zip) ui.zipQuote = q; }
  catch (e) { ui.zipQuote = null; }
  updateZipNote(); refreshSummary("checkout");
}
async function placeOrder(form) {
  if (ui.busy) return;
  const f = Object.fromEntries(new FormData(form)), errs = {};
  if (!(f.name || "").trim()) errs.name = "Enter your name.";
  if ((f.phone || "").replace(/\D/g, "").length < 7) errs.phone = "Enter a phone number we can call or text.";
  if (!/^\S+@\S+\.\S+$/.test((f.email || "").trim())) errs.email = "Enter an email like name@example.com.";
  const method = f.method === "delivery" ? "delivery" : "pickup";
  if (method === "delivery") {
    if (!(f.street || "").trim()) errs.street = "Enter the street address.";
    if (!(f.city || "").trim()) errs.city = "Enter the city.";
    if (!f.state) errs.state = "Choose a state.";
    if (!/^\d{5}$/.test((f.zip || "").trim())) errs.zip = "Enter a 5-digit ZIP.";
    else if (ui.zipQuote && !ui.zipQuote.available) errs.zip = "We don’t deliver to this ZIP yet. Please choose pickup.";
  }
  const alertEl = document.getElementById("formAlert"); alertEl.textContent = "";
  if (showErrs(form, errs)) return;
  const btn = form.querySelector('button[type="submit"]');
  ui.busy = true; setBusy(btn, true, "Sending…");
  try {
    const res = await api("POST", "/api/orders", {
      items: cart.map(l => ({ id: l.id, qty: l.qty, v: l.v || "", ...(l.c ? { c: l.c } : {}) })), method, analytics: analyticsIds(), date: f.date, notes: f.notes, botcheck: f.botcheck ? "on" : "",
      customer: { name: f.name, phone: f.phone, email: f.email },
      address: method === "delivery" ? { street: f.street, unit: f.unit, city: f.city, state: f.state, zip: (f.zip || "").trim() } : null
    });
    await sendEmail(res.email, res.order.email, res.order.name);
    cart = []; saveCart(); ui.lastOrder = res.order; ui.zipQuote = null; ui.zipFor = "";
    location.hash = "order-sent";
  } catch (e) {
    if (e.errors && Object.keys(e.errors).length) showErrs(form, e.errors);
    alertEl.textContent = e.errors && e.errors.items ? e.errors.items : e.message;
  } finally { ui.busy = false; setBusy(btn, false); }
}
function viewDone() {
  const o = ui.lastOrder;
  if (!o) { location.hash = ""; return ""; }
  return shell(`<div class="wrap"><div class="done">
    <div class="check">${CHECK}</div>
    <h1>Thanks, ${esc(o.name.split(" ")[0])}!</h1>
    <p>Your order request ${esc(o.id)} is in. We’ll reach out soon by phone or email to confirm the details.</p>
    <div class="receipt">${o.items.map(i => `<div class="sum-row"><span>${i.qty} × ${esc(i.name)}${i.variant ? `<br><small>${esc(choiceText(i.label, i.variant))}</small>` : ""}${i.custom ? `<br><small>${customHTML(i.custom)}</small>` : ""}</span><span>${money(i.total)}</span></div>`).join("")}
      ${o.method === "delivery" ? `<div class="sum-row"><span>Delivery (estimate)</span><span>${o.delivery ? money(o.delivery) : "Free"}</span></div>` : ""}
      <div class="sum-row total"><span>Total</span><b>${money(o.total)}</b></div></div>
    <button class="btn" data-go="">Back to the shop</button>
  </div></div>`);
}

/* ---------------- contact ---------------- */
function viewContact() {
  if (ui.contactSent) return shell(`<div class="wrap"><div class="done">
    <div class="check">${CHECK}</div><h1>Message sent</h1>
    <p>Thanks, ${esc(ui.contactSent)}! We’ll get back to you soon, usually within a day.</p>
    <button class="btn" data-go="">Back to the shop</button></div></div>`);
  return shell(`<div class="wrap">
    <button class="back" data-go="">‹ Continue shopping</button>
    <h1 class="page-title" style="margin-top:4px">Contact us</h1>
    <div class="cart">
      <form class="form-card" id="contact" novalidate>
        <h2>Send us a message</h2>
        ${REQ_NOTE}
        <div class="field"><label for="m-name">Full name${REQ}</label><input class="input" id="m-name" name="name" autocomplete="name" aria-required="true"><span class="err" data-err="name"></span></div>
        <div class="two">
          <div class="field"><label for="m-phone">Phone${REQ}</label><input class="input" id="m-phone" name="phone" type="tel" autocomplete="tel" aria-required="true"><span class="err" data-err="phone"></span></div>
          <div class="field"><label for="m-email">Email${REQ}</label><input class="input" id="m-email" name="email" type="email" autocomplete="email" aria-required="true"><span class="err" data-err="email"></span></div>
        </div>
        <div class="field"><label for="m-topic">What’s it about?</label><select class="input" id="m-topic" name="topic">
          <option>General question</option><option>Party or bulk order</option><option>An order I placed</option><option>Something else</option></select></div>
        <div class="field"><label for="m-msg">Message${REQ}</label><textarea class="input" id="m-msg" name="message" rows="5" aria-required="true" placeholder="How can we help?"></textarea><span class="err" data-err="message"></span></div>
        <input type="checkbox" name="botcheck" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">
        <div class="alert" id="formAlert" role="alert"></div>
        <button class="btn big block" type="submit">Send message</button>
      </form>
      <aside class="summary contact-side">
        <h2>Other ways to reach us</h2>
        <p class="fine">Email us any time and we’ll reply as soon as we can.</p>
        <a href="mailto:${esc(store.salesEmail)}">${esc(store.salesEmail)}</a>
      </aside>
    </div></div>`);
}
async function sendMessage(form) {
  if (ui.busy) return;
  const f = Object.fromEntries(new FormData(form)), errs = {};
  if (!(f.name || "").trim()) errs.name = "Enter your name.";
  if ((f.phone || "").replace(/\D/g, "").length < 7) errs.phone = "Enter a phone number we can call or text.";
  if (!/^\S+@\S+\.\S+$/.test((f.email || "").trim())) errs.email = "Enter an email like name@example.com.";
  if (!(f.message || "").trim()) errs.message = "Write a short message.";
  const alertEl = document.getElementById("formAlert"); alertEl.textContent = "";
  if (showErrs(form, errs)) return;
  const btn = form.querySelector('button[type="submit"]');
  ui.busy = true; setBusy(btn, true, "Sending…");
  try {
    const res = await api("POST", "/api/messages", { ...f, botcheck: f.botcheck ? "on" : "", analytics: analyticsIds() });
    await sendEmail(res.email, res.message.email, res.message.name);
    ui.contactSent = res.message.name.split(" ")[0]; render();
  } catch (e) { if (e.errors) showErrs(form, e.errors); alertEl.textContent = e.message; }
  finally { ui.busy = false; setBusy(btn, false); }
}

/* ================= OWNER ADMIN ================= */
function viewLogin() {
  return `<div class="login-wrap"><div class="login">
    <a class="logo" href="/">${MARK}<span class="logo-name">Paint Party Kits</span></a>
    <form class="form-card" id="login" novalidate>
      <h2>Shop owner sign in</h2>
      <div class="field"><label for="l-email">Email</label><input class="input" id="l-email" name="email" type="email" autocomplete="username"></div>
      <div class="field"><label for="l-pw">Password</label><input class="input" id="l-pw" name="password" type="password" autocomplete="current-password"><span class="err" id="l-err">${esc(admin.loginError)}</span></div>
      <button class="btn big block" type="submit">Sign in</button>
    </form>
    <p style="text-align:center;margin-top:16px"><a class="textbtn" href="/">Back to the store</a></p>
  </div></div>`;
}
function adminTop() {
  return `<header class="admin-top"><div class="wrap">
    <a class="logo" href="/admin" style="text-decoration:none">${MARK}<span class="logo-name">Paint Party Kits</span><em>Admin</em></a>
    <nav><a href="/" target="_blank" rel="noopener">View store</a><button data-signout>Sign out</button></nav>
  </div></header>`;
}
function viewAdmin() {
  if (!admin.authed) return viewLogin();
  if (!admin.data) return adminTop() + `<div class="loading">Loading your shop…</div>`;
  if (admin.draft) return adminTop() + (admin.sub ? viewSubEdit() : viewEdit());
  const d = admin.data;
  const newOrders = d.orders.filter(o => o.status === "New").length, newMsgs = d.messages.filter(m => m.status === "New").length;
  const tab = (k, label, badge) => `<button role="tab" aria-selected="${admin.tab === k}" data-tab="${k}">${label}${badge ? `<span class="badge">${badge}</span>` : ""}</button>`;
  const body = { products: adminProducts, season: adminSeason, delivery: adminDelivery, orders: adminOrders, messages: adminMessages, analytics: adminAnalytics }[admin.tab] || adminProducts;
  return adminTop() + `<main class="wrap">
    <div class="tabs" role="tablist">${tab("products", "Items")}${tab("season", "Seasonal look")}${tab("delivery", "Delivery")}${tab("orders", "Orders", newOrders)}${tab("messages", "Messages", newMsgs)}${tab("analytics", "Analytics")}</div>
    ${body()}
    <div style="height:40px"></div>
  </main>`;
}
async function loadAdmin() {
  try { admin.data = await api("GET", "/api/admin/all"); applyTheme(admin.data.season.theme); }
  catch (e) { if (e.status === 401) { admin.authed = false; admin.loginError = "Please sign in again."; } else toast(e.message); }
  render(true);
}
function adminFail(e) {
  if (e.status === 401) { admin.authed = false; admin.loginError = "You were signed out. Please sign in again."; render(); return; }
  toast(e.message);
}

/* products */
function adminProducts() {
  const ps = admin.data.products;
  return `<div class="rows">
    <button class="btn" data-new style="justify-self:start">+ Add an item</button>
    ${ps.length ? ps.map(p => `<div class="prow">
      ${(p => p ? `<img src="${esc(p)}" alt="">` : `<div class="noimg"></div>`)(photosOf(p)[0] || (p.variants || []).map(v => v.photo).find(Boolean))}
      <div><h3>${esc(p.name)}<span class="status ${p.visible ? "on" : "off"}">${p.visible ? "Showing" : "Hidden"}</span></h3>
      <div class="meta">${isCustom(p) ? `Custom order · ${money(p.price)} for up to ${p.custom.included} ${esc(unitsWord(p.custom, p.custom.included))}${p.custom.extra > 0 ? `, +${money(p.custom.extra)} each extra` : ""}${p.custom.colors.length ? ` · ${plural(p.custom.colors.length, "color")}` : ""}` : (pr => pr.lo < pr.hi ? `${money(pr.lo)}–${money(pr.hi)}` : `${money(pr.lo)} each`)(priceRange(p))}${hasChoices(p) ? ` · ${plural(p.variants.length, "sub-item")}${p.variants.some(v => v.soldOut) ? ` (${p.variants.filter(v => v.soldOut).length} sold out)` : ""}` : ""}${hasBulk(p) ? ` · ${p.bulkPct}% off ${p.bulkMin}+` : ""}</div></div>
      <button class="btn line sm" data-edit="${esc(p.id)}">Edit</button>
    </div>`).join("") : `<div class="empty-state"><h2>No items yet</h2><p>Tap “Add an item” to list your first one.</p></div>`}
  </div>`;
}
/* item editor. Sub-items open in their own screen (admin.sub = { i, d }). */
const sec = (title, sub, body) => `<section class="ed-sec"><div class="ed-h"><h2>${title}</h2>${sub ? `<p class="fine">${sub}</p>` : ""}</div>${body}</section>`;
function photoTiles(list, k, fileId) { // k: "ph" for the item, "sph" for a sub-item
  return `<div class="photo-list">${list.map((u, i) => `<div class="photo-tile">
      <img src="${esc(u)}" alt="Photo ${i + 1}">${i === 0 ? `<span class="main-tag">Main</span>` : `<button type="button" class="mk-main" data-${k}-main="${i}">Make main</button>`}
      <button type="button" class="x" data-${k}-del="${i}" aria-label="Remove photo ${i + 1}">×</button></div>`).join("")}
      ${list.length < 10 ? `<label class="photo-add"><span>+</span>${list.length ? "Add more" : "Add photos"}<input type="file" accept="image/*" id="${fileId}" multiple hidden></label>` : ""}
    </div>`;
}
function actionsBar(main, extra) {
  return `<div class="actions ed-actions ${admin.dirty ? "dirty" : ""}">${main}${extra}<span class="unsaved">Not saved yet</span></div>`;
}
function viewEdit() {
  const d = admin.draft, isNew = !d.id, cu = d.custom, many = !cu && d.variants.length > 0;
  const subRow = (v, i) => {
    const price = v.price > 0 ? money(v.price) : d.price > 0 ? `${money(d.price)} <span>(item price)</span>` : `<em class="need">Needs a price</em>`;
    return `<div class="sub-row">
      <button type="button" class="sub-open" data-sub-edit="${i}">
        ${v.photos[0] ? `<img src="${esc(v.photos[0])}" alt="">` : `<span class="noimg"></span>`}
        <span class="sub-txt"><b>${esc(v.name)}</b><small>${price}${v.photos.length > 1 ? ` · ${v.photos.length} photos` : ""}${v.soldOut ? ` · <em class="out">Sold out</em>` : ""}</small></span>
        <span class="chev" aria-hidden="true">›</span>
      </button>
      <div class="sub-acts">
        <button type="button" data-sub-dup="${i}" title="Make a copy">Copy</button>
        ${i > 0 ? `<button type="button" data-sub-up="${i}" aria-label="Move ${esc(v.name)} up" title="Move up">↑</button>` : ""}
      </div>
    </div>`;
  };
  return `<main class="wrap">
    <button class="back" data-cancel>‹ All items</button>
    <h1 class="page-title" style="margin-top:4px">${isNew ? "Add an item" : "Edit item"}</h1>
    <div class="edit">
      <form class="form-card ed" id="edit" novalidate>
        ${sec("Type of listing", "", `<div class="choice kind">
          <label><input type="radio" name="kind" value="regular" ${cu ? "" : "checked"}><span>Regular item<small>One price, or sub-items like sizes</small></span></label>
          <label><input type="radio" name="kind" value="custom" ${cu ? "checked" : ""}><span>Custom order<small>Customer picks how many letters, a color, and types the name</small></span></label>
        </div>`)}
        ${sec("Photos", "The first photo is the one customers see first.", photoTiles(d.photos, "ph", "e-file"))}
        ${sec("About it", "", `
          <div class="field"><label for="e-name">Name${REQ}</label><input class="input" id="e-name" name="name" value="${esc(d.name)}" placeholder="e.g. Purim Mask Paint Kit"><span class="err" data-err="name"></span></div>
          <div class="field"><label for="e-blurb">Description <span class="opt">Optional</span></label><textarea class="input" id="e-blurb" name="blurb" rows="3" placeholder="What is it, and who is it for?">${esc(d.blurb)}</textarea></div>
          <div class="field"><label for="e-incl">What’s included <span class="opt">Optional, one per line</span></label><textarea class="input" id="e-incl" name="included" rows="3" placeholder="1 plaster donut&#10;3 paint colors">${esc(d.included.join("\n"))}</textarea></div>`)}
        ${cu ? customEditor(d) : sec("Sub-items", "Sell this item in different versions: sizes, colors, or both (like “Large – Gold”). Each sub-item is a full listing with its own name, photos, description and price. Customers pick one.", `
          ${many ? `<div class="field"><label for="e-label">What are customers choosing? <span class="opt">Shows as “Choose a …”</span></label><input class="input" id="e-label" name="chooseLabel" value="${esc(d.chooseLabel || "")}" placeholder="Size, Color, Style, Option…" list="labels" style="max-width:320px"><datalist id="labels"><option>Size</option><option>Color</option><option>Style</option><option>Design</option><option>Option</option></datalist></div>` : ""}
          ${many ? `<div class="sub-list">${d.variants.map(subRow).join("")}</div>` : ""}
          <span class="err" data-err="variants"></span>
          <button type="button" class="ch-add" data-sub-add><span>+</span> Add a sub-item</button>`)}
        ${sec("Price", "", `
          <div class="field"><label for="e-price">${cu ? `Base price${REQ} <span class="opt">Includes up to ${cu.included} ${esc(unitsWord(cu, cu.included))}</span>` : many ? "Price" : `Price${REQ}`} ${many ? `<span class="opt">Optional: used by any sub-item without its own price</span>` : ""}</label>
            <div class="adorn pre" style="max-width:220px"><span>$</span><input class="input" id="e-price" name="price" inputmode="decimal" value="${d.price || ""}" placeholder="${many ? "—" : "7.99"}"></div><span class="err" data-err="price"></span></div>
          <details class="ed-more" ${hasBulk(d) ? "open" : ""}><summary>Bulk discount <span class="opt">${hasBulk(d) ? `${d.bulkPct}% off ${d.bulkMin}+` : "Optional"}</span></summary>
            <div class="two">
              <div class="field"><label for="e-min">Starts at</label><div class="adorn post"><input class="input" id="e-min" name="bulkMin" inputmode="numeric" value="${d.bulkMin || ""}" placeholder="10"><span>items</span></div></div>
              <div class="field"><label for="e-pct">Discount</label><div class="adorn post"><input class="input" id="e-pct" name="bulkPct" inputmode="decimal" value="${d.bulkPct || ""}" placeholder="10"><span>%</span></div></div>
            </div>
            <div class="example" id="example"></div>
          </details>`)}
        <section class="ed-sec"><label class="toggle"><input type="checkbox" name="visible" ${d.visible ? "checked" : ""}>Show on the website</label></section>
        ${actionsBar(`<button class="btn" type="submit">${isNew ? "Add item" : "Save changes"}</button>
          <button class="btn line" type="button" data-cancel>${admin.cancelArmed ? "Tap again to discard" : "Cancel"}</button>`,
          isNew ? "" : `<button class="btn danger ${admin.deleteArmed ? "armed" : ""}" type="button" data-delete>${admin.deleteArmed ? "Tap again to delete" : "Delete"}</button>`)}
      </form>
      <div class="side"><span class="label">How customers will see it</span><div id="preview" style="max-width:300px"></div></div>
    </div></main>`;
}
function customEditor(d) {
  const cu = d.custom, many = esc(unitsWord(cu, 2));
  return sec("Custom options", "Customers choose these on the item’s page before they can add it to the cart.", `
    ${d.variants.length ? `<p class="alert" style="margin:0">This item’s ${plural(d.variants.length, "sub-item")} will be removed when you save, because custom orders don’t use sub-items.</p>` : ""}
    <div class="two">
      <div class="field"><label for="c-unit">What do customers count? <span class="opt">One, like “letter”</span></label><input class="input" id="c-unit" name="cUnit" value="${esc(cu.unit)}" placeholder="letter"></div>
      <div class="field"><label for="c-incl">Included in the base price</label><div class="adorn post"><input class="input" id="c-incl" name="cIncluded" inputmode="numeric" value="${cu.included}" placeholder="4"><span>${many}</span></div></div>
    </div>
    <div class="two">
      <div class="field"><label for="c-extra">Each extra ${esc(cu.unit)} costs</label><div class="adorn pre"><span>$</span><input class="input" id="c-extra" name="cExtra" inputmode="decimal" value="${cu.extra}" placeholder="1.00"></div></div>
      <div class="two" style="gap:10px">
        <div class="field"><label for="c-min">Fewest</label><input class="input" id="c-min" name="cMin" inputmode="numeric" value="${cu.min}" placeholder="1"></div>
        <div class="field"><label for="c-max">Most</label><input class="input" id="c-max" name="cMax" inputmode="numeric" value="${cu.max}" placeholder="12"></div>
      </div>
    </div>
    <div class="example" id="cExample"></div>
    <div class="field"><span class="label" style="margin:0">Colors <span class="opt">Customers see only the color, no name. Leave empty to skip this step.</span></span>
      ${cu.colors.length ? `<div class="csw-list">${cu.colors.map((h, i) => `<span class="csw-edit"><i style="background:${esc(h)}"></i><code>${esc(h)}</code><button type="button" class="x" data-color-del="${i}" aria-label="Remove ${esc(h)}">×</button></span>`).join("")}</div>` : ""}
      <div class="add-color">
        <input type="color" id="c-pick" value="#000000" aria-label="Pick a color">
        <input class="input" id="c-hex" placeholder="#000000" maxlength="200" aria-label="Color code, like #FF0000" autocomplete="off">
        <button type="button" class="btn line" data-color-add>Add color</button>
      </div>
      <span class="fine">Type a code like #FF0000 (you can paste several, separated by spaces or commas), or use the color picker.</span>
      <span class="err" data-err="colors"></span>
    </div>
    <label class="toggle"><input type="checkbox" name="cAskText" ${cu.askText ? "checked" : ""}><span>Customer types the ${esc(cu.textLabel.toLowerCase())}<small class="toggle-hint">The number of ${many} is set from what they type</small></span></label>
    ${cu.askText ? `<div class="field" style="max-width:320px"><label for="c-tlabel">What do they type?</label><input class="input" id="c-tlabel" name="cTextLabel" value="${esc(cu.textLabel)}" placeholder="Name"></div>` : ""}`);
}
const hexList = t => [...new Set(String(t).split(/[\s,;]+/).map(x => x.trim().toUpperCase()).filter(Boolean).map(x => x.startsWith("#") ? x : "#" + x))];
function viewSubEdit() {
  const d = admin.draft, s = admin.sub.d, isNew = admin.sub.i < 0;
  return `<main class="wrap">
    <button class="back" data-sub-cancel>‹ Back to ${esc(d.name || "the item")}</button>
    <h1 class="page-title" style="margin-top:4px">${isNew ? "New sub-item" : esc(s.name || "Sub-item")}</h1>
    <p class="fine" style="margin:-6px 0 16px">Part of <b>${esc(d.name || "this item")}</b>. Customers see these details when they pick this one.</p>
    <div class="edit">
      <form class="form-card ed" id="subedit" novalidate>
        ${sec("Photos", "Shown first when a customer picks this sub-item. Leave empty to show the item’s photos.", photoTiles(s.photos, "sph", "sub-file"))}
        ${sec("About it", "", `
          <div class="field"><label for="s-name">Name${REQ}</label><input class="input" id="s-name" name="name" value="${esc(s.name)}" placeholder="e.g. Large, Gold, or Large – Gold"><span class="err" data-err="name"></span></div>
          <div class="field"><label for="s-blurb">Description <span class="opt">Optional</span></label><textarea class="input" id="s-blurb" name="blurb" rows="3" placeholder="Anything special about this one">${esc(s.blurb)}</textarea></div>
          <div class="field"><label for="s-incl">What’s included <span class="opt">Optional. Leave empty to use the item’s list</span></label><textarea class="input" id="s-incl" name="included" rows="3" placeholder="${esc(d.included.join("\n"))}">${esc(s.included.join("\n"))}</textarea></div>`)}
        ${sec("Price", "", `
          <div class="field"><label for="s-price">Price ${d.price > 0 ? `<span class="opt">Leave empty to use the item price (${money(d.price)})</span>` : REQ}</label>
            <div class="adorn pre" style="max-width:220px"><span>$</span><input class="input" id="s-price" name="price" inputmode="decimal" value="${s.price > 0 ? s.price : ""}" placeholder="${d.price > 0 ? d.price.toFixed(2) : "9.99"}"></div><span class="err" data-err="price"></span></div>
          <label class="toggle"><input type="checkbox" name="soldOut" ${s.soldOut ? "checked" : ""}><span>Sold out<small class="toggle-hint">Customers still see it, but can’t pick it</small></span></label>`)}
        ${actionsBar(`<button class="btn" type="submit">Done</button><button class="btn line" type="button" data-sub-cancel>Cancel</button>`,
          isNew ? "" : `<button class="btn danger ${admin.subDelArmed ? "armed" : ""}" type="button" data-sub-delete>${admin.subDelArmed ? "Tap again to remove" : "Remove"}</button>`)}
      </form>
    </div></main>`;
}
const numIn = s => parseFloat(String(s).replace(/[^\d.]/g, ""));
const lines = t => t.split("\n").map(s => s.trim()).filter(Boolean);
function readDraft() {
  const f = document.getElementById("edit"); if (!f) return;
  const d = admin.draft, v = n => f.elements[n] ? f.elements[n].value : "";
  d.name = v("name"); d.blurb = v("blurb"); d.included = lines(v("included"));
  d.price = r2(numIn(v("price")) || 0);
  d.bulkMin = parseInt(v("bulkMin")) || 0;
  d.bulkPct = Math.min(90, Math.max(0, parseFloat(v("bulkPct")) || 0));
  d.visible = f.elements.visible.checked;
  if (f.elements.chooseLabel) d.chooseLabel = v("chooseLabel").trim();
  if (d.custom && f.elements.cUnit) {
    const c = d.custom, int = (n, dflt) => { const x = parseInt(v(n)); return Number.isFinite(x) ? x : dflt; };
    c.unit = v("cUnit").trim() || "letter";
    c.included = Math.max(0, int("cIncluded", 0));
    c.extra = Math.max(0, r2(numIn(v("cExtra")) || 0));
    c.min = Math.min(60, Math.max(1, int("cMin", 1)));
    c.max = Math.min(60, Math.max(c.min, int("cMax", 12)));
    c.askText = f.elements.cAskText.checked;
    if (f.elements.cTextLabel) c.textLabel = v("cTextLabel").trim() || "Name";
  }
  d.photo = d.photos[0] || "";
}
function readSub() {
  const f = document.getElementById("subedit"); if (!f || !admin.sub) return;
  const s = admin.sub.d;
  s.name = f.elements.name.value.trim(); s.blurb = f.elements.blurb.value.trim(); s.included = lines(f.elements.included.value);
  s.price = r2(numIn(f.elements.price.value)) || null; s.soldOut = f.elements.soldOut.checked; s.photo = s.photos[0] || "";
}
function updatePreview() {
  if (!document.getElementById("edit")) return;
  readDraft(); const d = admin.draft;
  document.getElementById("preview").innerHTML = card({ ...d, name: d.name || "Item name" }, true);
  const ex = document.getElementById("example"), pr = priceRange(d);
  if (!(pr.lo > 0)) ex.textContent = "Set a price to see what customers will pay.";
  else if (hasBulk(d)) ex.textContent = `Order ${d.bulkMin} or more${hasChoices(d) ? " (any mix of sub-items)" : ""} and each one is ${d.bulkPct}% off${pr.lo < pr.hi ? "" : `: ${money(r2(pr.lo * (1 - d.bulkPct / 100)))} instead of ${money(pr.lo)}`}.`;
  else ex.textContent = "Fill in both boxes to give a discount on bigger orders.";
  const cx = document.getElementById("cExample"), c = d.custom;
  if (cx && c) {
    if (!(d.price > 0)) cx.textContent = "Set the base price (below) to see what customers will pay.";
    else {
      const picks = [...new Set([c.min, Math.max(c.min, Math.min(c.max, c.included)), Math.min(c.max, Math.max(c.min, c.included + 4)), c.max])];
      cx.textContent = "Customers pay: " + picks.map(n => `${n} ${unitsWord(c, n)} = ${money(customPrice(d, n))}`).join(" · ");
    }
  }
}
function markDirty() { admin.dirty = true; admin.cancelArmed = false; document.querySelector(".ed-actions")?.classList.add("dirty"); }
function openSub(i, d) { readDraft(); admin.sub = { i, d }; admin.subDelArmed = false; render(); }
function saveSub(form) {
  readSub(); const s = admin.sub.d, d = admin.draft, errs = {};
  if (!s.name) errs.name = "Give it a name, like Large or Gold.";
  else if (d.variants.some((v, j) => j !== admin.sub.i && v.name.toLowerCase() === s.name.toLowerCase())) errs.name = "Another sub-item already has this name.";
  if (!(s.price > 0) && !(d.price > 0)) errs.price = "Enter a price. (The item has no price of its own.)";
  if (showErrs(form, errs)) return;
  if (admin.sub.i < 0) d.variants.push(s); else d.variants[admin.sub.i] = s;
  const isNewItem = !d.id; admin.sub = null; admin.dirty = true; render();
  toast(`${s.name} is ready. Tap “${isNewItem ? "Add item" : "Save changes"}” to publish.`);
}
async function saveProduct(form) {
  readDraft(); const d = admin.draft, errs = {};
  if (!d.name.trim()) errs.name = "Give the item a name.";
  if (d.custom) { if (!(d.price > 0)) errs.price = "Enter the base price, like 4.00."; }
  else if (!d.variants.length && !(d.price > 0)) errs.price = "Enter a price, like 7.99.";
  else if (d.variants.some(c => !(priceOf(d, c) > 0))) errs.variants = `${d.variants.find(c => !(priceOf(d, c) > 0)).name} needs a price. Open it and add one, or set a price for the whole item.`;
  if (showErrs(form, errs)) { form.querySelector(".err:not(:empty)")?.scrollIntoView({ behavior: "smooth", block: "center" }); return; }
  if (admin.busy) return;
  const btn = form.querySelector('button[type="submit"]'); admin.busy = true; setBusy(btn, true, "Saving…");
  try {
    await api("POST", "/api/admin/products", d.custom ? { ...d, variants: [], chooseLabel: "" } : d);
    const wasNew = !d.id; admin.draft = null; admin.dirty = false; await loadAdmin(); window.scrollTo(0, 0);
    toast(wasNew ? "Item added" : "Changes saved");
  } catch (e) { if (e.errors) showErrs(form, e.errors); adminFail(e); }
  finally { admin.busy = false; setBusy(btn, false); }
}

/* seasonal look */
function adminSeason() {
  if (!admin.sdraft) admin.sdraft = structuredClone(admin.data.season);
  const s = admin.sdraft;
  return `<div class="edit">
    <form class="form-card" id="season" novalidate>
      <h2>Seasonal look</h2>
      <p class="fine" style="margin-top:-8px">Change the colors and the big banner on your home page for each holiday or season.</p>
      <fieldset class="field"><legend style="margin-bottom:8px">Color theme</legend>
        <div class="swatches">${Object.entries(THEMES).map(([k, th]) => `<label class="swatch"><input type="radio" name="theme" value="${k}" ${s.theme === k ? "checked" : ""}>
          <span class="chips"><i style="background:${th.brand}"></i><i style="background:${th.accent}"></i><i style="background:${th.banner}"></i></span>${th.name}</label>`).join("")}</div>
      </fieldset>
      <div class="field"><span class="label" style="margin:0">Banner picture</span>
        <div class="photo-pick">${s.photo ? `<img src="${esc(s.photo)}" alt="">` : `<div class="noimg"></div>`}
        <label class="btn line sm">${s.photo ? "Change picture" : "Choose picture"}<input type="file" accept="image/*" id="s-file" hidden></label>
        ${s.photo ? `<button type="button" class="textbtn" data-sremove>Remove</button>` : ""}</div></div>
      <div class="field"><label for="s-head">Headline</label><input class="input" id="s-head" name="headline" value="${esc(s.headline)}" placeholder="e.g. Purim fun is here!"></div>
      <div class="field"><label for="s-text">Message <span class="opt">Optional</span></label><textarea class="input" id="s-text" name="text" rows="2" placeholder="A short line about this season’s items">${esc(s.text)}</textarea></div>
      <div class="field"><label for="s-btn">Button text <span class="opt">Optional</span></label><input class="input" id="s-btn" name="button" value="${esc(s.button)}" placeholder="Shop now"></div>
      <div class="field"><label for="s-link">Button opens</label><select class="input" id="s-link" name="link">
        <option value="">All items on the home page</option>
        ${admin.data.products.map(p => `<option value="${esc(p.id)}" ${s.link === p.id ? "selected" : ""}>${esc(p.name)}${p.visible ? "" : " (hidden)"}</option>`).join("")}
      </select></div>
      <label class="toggle"><input type="checkbox" name="show" ${s.show ? "checked" : ""}>Show the banner on the home page</label>
      <div class="actions"><button class="btn" type="submit">Save seasonal look</button><button class="btn line" type="button" data-sreset>Undo changes</button></div>
    </form>
    <div class="side"><span class="label">Preview</span><div class="season-preview" id="spreview"></div></div>
  </div>`;
}
function readSeason() {
  const f = document.getElementById("season"); if (!f) return;
  const s = admin.sdraft;
  s.theme = f.elements.theme.value || s.theme; s.headline = f.elements.headline.value; s.text = f.elements.text.value;
  s.button = f.elements.button.value; s.link = f.elements.link.value; s.show = f.elements.show.checked;
}
function updateSeasonPreview() {
  readSeason(); applyTheme(admin.sdraft.theme);
  document.getElementById("spreview").innerHTML = admin.sdraft.show ? bannerHTML(admin.sdraft, true)
    : `<div class="empty-state" style="margin:0;box-shadow:none"><p style="margin:0">The banner is hidden. Customers will see your items right away.</p></div>`;
}

/* delivery */
function adminDelivery() {
  if (!admin.ddraft) admin.ddraft = structuredClone(admin.data.delivery);
  const d = admin.ddraft;
  const zones = Object.entries(d.zones || {}).sort((a, b) => (a[1].miles ?? 999) - (b[1].miles ?? 999) || a[0].localeCompare(b[0]));
  return `<form class="form-card stack" id="delivery" novalidate style="margin-bottom:20px">
    <div><h2>Delivery prices</h2>
    <p class="fine" style="margin-top:6px">Set prices by distance, tap “Generate ZIP list,” then check the list and save. Customers only see delivery if at least one ZIP is on your list.</p></div>
    <div class="field" style="max-width:260px"><label for="d-home">Your ZIP code <span class="opt">Private, never shown</span></label><input class="input" id="d-home" name="homeZip" inputmode="numeric" maxlength="5" value="${esc(d.homeZip)}" placeholder="11572"><span class="err" data-err="homeZip"></span></div>
    <div class="field"><span class="label" style="margin:0">Delivery price by distance from you</span>
      <div class="stack" style="gap:10px">${(d.rings || []).map((r, i) => `<div class="ring">
        <div class="field"><label for="r-m${i}">Up to</label><div class="adorn post"><input class="input" id="r-m${i}" data-ring="${i}" data-k="miles" inputmode="decimal" value="${r.miles}"><span>miles</span></div></div>
        <div class="field"><label for="r-f${i}">Price</label><div class="adorn pre"><span>$</span><input class="input" id="r-f${i}" data-ring="${i}" data-k="fee" inputmode="decimal" value="${r.fee}"></div></div>
        <button type="button" class="x" data-ring-del="${i}" aria-label="Remove this distance">×</button>
      </div>`).join("")}</div>
      <button type="button" class="btn line sm" data-ring-add style="justify-self:start;margin-top:4px">+ Add a distance</button>
    </div>
    <div class="field" style="max-width:260px"><label for="d-free">Free delivery on orders over <span class="opt">Optional</span></label><div class="adorn pre"><span>$</span><input class="input" id="d-free" name="freeOver" inputmode="decimal" value="${d.freeOver || ""}" placeholder="Leave empty for never"></div></div>
    <div><button type="button" class="btn soft" data-generate>Generate ZIP list</button>
      <p class="fine" style="margin-top:8px">Distances are measured in a straight line from the center of your ZIP. Prices you change by hand below are kept when you generate again.</p></div>
    <div class="field"><span class="label" style="margin:0">Your delivery ZIP codes (${zones.length})</span>
      <div class="add-zip">
        <div class="field"><label for="nz">Add a ZIP</label><input class="input" id="nz" inputmode="numeric" maxlength="5" placeholder="11561"></div>
        <div class="field"><label for="nzf">Price</label><div class="adorn pre"><span>$</span><input class="input" id="nzf" inputmode="decimal" placeholder="10"></div></div>
        <button type="button" class="btn line" data-zip-add>Add</button>
      </div>
      ${zones.length ? `<div class="ztable-wrap"><table class="ztable"><thead><tr><th>ZIP</th><th class="place">Area</th><th>Miles</th><th>Price</th><th></th></tr></thead><tbody>
        ${zones.map(([zip, z]) => `<tr><td><b>${zip}</b>${z.manual ? `<span class="tag">Yours</span>` : ""}</td><td class="place">${esc(z.place || "")}</td><td>${z.miles ?? "–"}</td>
          <td><div class="adorn pre"><span style="left:10px">$</span><input data-zone="${zip}" inputmode="decimal" value="${z.fee}" aria-label="Price for ${zip}" style="padding-left:22px"></div></td>
          <td><button type="button" class="x" data-zone-del="${zip}" aria-label="Remove ${zip}">×</button></td></tr>`).join("")}
      </tbody></table></div>` : `<div class="empty-state" style="box-shadow:none;border:1.5px dashed var(--line);margin:0;padding:24px"><p style="margin:0">No delivery ZIP codes yet, so customers can only choose pickup.</p></div>`}
    </div>
    <div class="actions"><button class="btn" type="submit">Save delivery settings</button><button type="button" class="btn line" data-dreset>Undo changes</button></div>
  </form>`;
}
function readDeliveryFields(form) {
  const d = admin.ddraft;
  d.homeZip = form.elements.homeZip.value.trim();
  d.freeOver = parseFloat(form.elements.freeOver.value) || 0;
}

/* orders + messages */
function addrText(a) { return a ? `${a.street}${a.unit ? ", " + a.unit : ""}, ${a.city}, ${a.state} ${a.zip}` : ""; }
function adminOrders() {
  const os = admin.data.orders;
  if (!os.length) return `<div class="empty-state"><h2>No orders yet</h2><p>When customers place an order, it shows up here and in your email.</p><a class="btn" href="/" target="_blank" rel="noopener">Open the store</a></div>`;
  return `<div class="rows">${os.map(o => `<div class="order">
    <div class="order-top">
      <div><h3>${esc(o.name)}<span class="status ${esc(o.status)}">${esc(o.status)}</span></h3>
      <div class="meta">${esc(o.id)} · ${new Date(o.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</div></div>
      <select data-status="${esc(o.id)}" data-kind="orders" aria-label="Order status">${["New", "Confirmed", "Done"].map(s => `<option ${o.status === s ? "selected" : ""}>${s}</option>`).join("")}</select>
    </div>
    <ul>${o.items.map(i => `<li><span>${i.qty} × ${esc(i.name)}${i.variant ? ` <b class="opt-tag">${esc(choiceText(i.label, i.variant))}</b>` : ""}${i.custom ? ` <b class="opt-tag">${customHTML(i.custom, true)}</b>` : ""}${i.bulk ? ` <span class="meta">(${i.pct}% bulk)</span>` : ""}</span><span>${money(i.total)}</span></li>`).join("")}
      ${o.method === "delivery" ? `<li><span>Delivery (estimate)</span><span>${o.delivery ? money(o.delivery) : "Free"}</span></li>` : ""}
      <li style="font-weight:700;border-top:1px solid var(--line);padding-top:6px"><span>Total</span><span>${money(o.total)}</span></li></ul>
    <div class="meta">${o.method === "delivery" ? "Local delivery: " + esc(addrText(o.address)) : "Pickup"}${o.date ? " · needed by " + esc(o.date) : ""}</div>
    <div class="meta"><a href="tel:${esc(o.phone)}">${esc(o.phone)}</a> · <a href="mailto:${esc(o.email)}">${esc(o.email)}</a></div>
    ${o.notes ? `<div class="meta">Note: ${esc(o.notes)}</div>` : ""}
  </div>`).join("")}</div>`;
}
function adminMessages() {
  const ms = admin.data.messages;
  if (!ms.length) return `<div class="empty-state"><h2>No messages yet</h2><p>Messages from the Contact page show up here and in your email.</p></div>`;
  return `<div class="rows">${ms.map(m => `<div class="order">
    <div class="order-top">
      <div><h3>${esc(m.name)}<span class="status ${m.status === "New" ? "New" : "Done"}">${esc(m.status)}</span></h3>
      <div class="meta">${esc(m.topic)} · ${new Date(m.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</div></div>
      <select data-status="${esc(m.id)}" data-kind="messages" aria-label="Message status">${["New", "Replied"].map(s => `<option ${m.status === s ? "selected" : ""}>${s}</option>`).join("")}</select>
    </div>
    <div style="white-space:pre-wrap">${esc(m.message)}</div>
    <div class="meta"><a href="tel:${esc(m.phone)}">${esc(m.phone)}</a> · <a href="mailto:${esc(m.email)}">${esc(m.email)}</a></div>
  </div>`).join("")}</div>`;
}

/* analytics */
async function loadAnalytics() {
  admin.anLoading = true; if (admin.tab === "analytics") render(true);
  try { admin.an = await api("GET", `/api/admin/analytics?range=${encodeURIComponent(admin.anRange)}&tz=${-new Date().getTimezoneOffset()}`); }
  catch (e) { adminFail(e); }
  finally { admin.anLoading = false; if (admin.tab === "analytics" && admin.authed) render(true); }
}
const n0 = n => Number(n || 0).toLocaleString();
const pct = (a, b) => b ? Math.round(a / b * 1000) / 10 + "%" : "–";
const dayLabel = (d, opts) => new Date(d + "T12:00:00Z").toLocaleDateString([], { timeZone: "UTC", ...(opts || { month: "short", day: "numeric" }) });
const PAGE_NAMES = { home: "Home page", kit: "An item’s page", cart: "Cart", checkout: "Checkout", "order-sent": "Order sent", contact: "Contact page" };
function barList(rows, labelFn, emptyText) {
  if (!rows.length) return `<p class="fine">${emptyText}</p>`;
  const max = Math.max(...rows.map(r => r.n), 1), total = rows.reduce((s, r) => s + r.n, 0);
  return `<ul class="an-bars">${rows.map(r => `<li><div class="an-bar-label"><span>${esc(labelFn(r))}</span><b>${n0(r.n)} <small>${pct(r.n, total)}</small></b></div>
    <div class="an-track"><i style="width:${Math.max(2, r.n / max * 100)}%"></i></div></li>`).join("")}</ul>`;
}
function adminAnalytics() {
  const ranges = [["today", "Today"], ["7", "7 days"], ["30", "30 days"], ["90", "90 days"], ["all", "All time"]];
  const head = `<div class="an-head">
    <div class="an-ranges" role="group" aria-label="Time range">${ranges.map(([k, l]) => `<button data-range="${k}" aria-pressed="${admin.anRange === k}">${l}</button>`).join("")}</div>
    <button class="btn line sm" data-an-refresh ${admin.anLoading ? "disabled" : ""}>${admin.anLoading ? "Loading…" : "Refresh"}</button>
  </div>`;
  const a = admin.an;
  if (!a) return head + `<div class="loading">Loading analytics…</div>`;
  const t = a.totals;
  const rangeText = { today: "today", "7": "in the last 7 days", "30": "in the last 30 days", "90": "in the last 90 days", all: "since you started counting" }[a.range];
  const tile = (label, value, sub) => `<div class="an-tile"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
  const tiles = `<div class="an-tiles">
    ${tile("Visitors", n0(t.visitors), `different people ${rangeText}`)}
    ${tile("Visits", n0(t.visits), `${t.visits ? (t.pageviews / t.visits).toFixed(1) : 0} pages per visit`)}
    ${tile("Page views", n0(t.pageviews), "every page anyone opened")}
    ${tile("Returning visitors", n0(t.returning), `${pct(t.returning, t.visitors)} came back more than once`)}
    ${tile("Added to cart", n0(t.adds), `${n0(a.funnel.added)} visits added an item`)}
    ${tile("Order requests", n0(t.orders), `${n0(t.kitsOrdered)} items · ${money(t.revenue)} total`)}
    ${tile("Contact messages", n0(t.messages), "sent from the Contact page")}
    ${tile("Order rate", pct(a.funnel.ordered, a.funnel.visits), "of visits sent an order request")}
  </div>`;

  // visitors per day
  const days = a.days, max = Math.max(1, ...days.map(d => d.visitors));
  const step = Math.max(1, Math.ceil(days.length / 6));
  const chart = days.length ? `<div class="an-card an-wide">
    <div class="an-card-head"><h2>Visitors per day</h2><span class="fine">Hover or tap a bar for details</span></div>
    <div class="an-chart" style="--n:${days.length}">
      <div class="an-ymax">${n0(max)}</div>
      <div class="an-cols">${days.map(d => `<div class="an-col" tabindex="0" aria-label="${esc(dayLabel(d.day))}: ${d.visitors} visitors">
        <i style="height:${d.visitors ? Math.max(2, d.visitors / max * 100) : 0}%"></i>${d.orders ? `<em title="Order request"></em>` : ""}
        <span class="an-tip"><b>${esc(dayLabel(d.day, { weekday: "short", month: "short", day: "numeric" }))}</b>
          ${n0(d.visitors)} visitors<br>${n0(d.views)} page views<br>${n0(d.orders)} order requests<br>${n0(d.messages)} messages</span></div>`).join("")}</div>
      <div class="an-xaxis">${days.map((d, i) => `<span>${(i % step === 0 && days.length - 1 - i >= step / 2) || i === days.length - 1 ? esc(dayLabel(d.day)) : ""}</span>`).join("")}</div>
    </div>
    <p class="fine an-legend"><i></i> Visitors <em></em> Day with an order request</p>
    <details class="an-table"><summary>See the numbers day by day</summary>
      <div class="an-scroll"><table><thead><tr><th>Day</th><th>Visitors</th><th>Page views</th><th>Orders</th><th>Messages</th></tr></thead>
      <tbody>${days.slice().reverse().map(d => `<tr><td>${esc(dayLabel(d.day, { weekday: "short", month: "short", day: "numeric", year: "numeric" }))}</td><td>${n0(d.visitors)}</td><td>${n0(d.views)}</td><td>${n0(d.orders)}</td><td>${n0(d.messages)}</td></tr>`).join("")}</tbody></table></div>
    </details>
  </div>` : "";

  // funnel
  const f = a.funnel;
  const steps = [["Visited the shop", f.visits], ["Looked at an item", f.viewedKit], ["Added to cart", f.added], ["Opened checkout", f.checkout], ["Sent an order request", f.ordered]];
  const funnel = `<div class="an-card">
    <h2>From visit to order</h2><p class="fine">How many visits reached each step</p>
    <ul class="an-bars">${steps.map(([l, v]) => `<li><div class="an-bar-label"><span>${l}</span><b>${n0(v)} <small>${pct(v, f.visits)}</small></b></div>
      <div class="an-track"><i style="width:${f.visits ? Math.max(v ? 2 : 0, v / f.visits * 100) : 0}%"></i></div></li>`).join("")}</ul>
  </div>`;

  const kits = `<div class="an-card">
    <h2>Items</h2><p class="fine">Which items people look at and order</p>
    ${a.kits.length ? `<div class="an-scroll"><table class="an-kits"><thead><tr><th>Item</th><th>Views</th><th>People</th><th>Added to cart</th><th>Ordered</th></tr></thead>
      <tbody>${a.kits.map(k => `<tr><td>${esc(k.name)}</td><td>${n0(k.views)}</td><td>${n0(k.people)}</td><td>${n0(k.adds)}</td><td>${n0(k.sold)}</td></tr>`).join("")}</tbody></table></div>`
      : `<p class="fine">No item views yet.</p>`}
  </div>`;
  const sources = `<div class="an-card"><h2>Where visitors come from</h2><p class="fine">The website or link that sent each visit</p>
    ${barList(a.sources, r => r.name === "Direct" ? "Direct (typed the address, a saved link, or a text/WhatsApp message)" : r.name, "No visits yet.")}</div>`;
  const devices = `<div class="an-card"><h2>Devices</h2><p class="fine">What people used to open the shop</p>${barList(a.devices, r => r.name, "No visits yet.")}</div>`;
  const pages = `<div class="an-card"><h2>Most opened pages</h2><p class="fine">Page views by page</p>${barList(a.pages, r => PAGE_NAMES[r.name] || r.name, "No page views yet.")}</div>`;
  const hmap = Object.fromEntries(a.hours.map(h => [h.h, h.n])), hmax = Math.max(1, ...Object.values(hmap));
  const hourName = h => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: "numeric" });
  const hours = `<div class="an-card"><h2>Busiest times of day</h2><p class="fine">Visits by hour, in your time zone</p>
    <div class="an-hours">${Array.from({ length: 24 }, (_, h) => `<div class="an-col" tabindex="0" aria-label="${hourName(h)}: ${hmap[h] || 0} visits">
      <i style="height:${hmap[h] ? Math.max(3, hmap[h] / hmax * 100) : 0}%"></i><span class="an-tip"><b>${hourName(h)}</b>${n0(hmap[h])} visits</span></div>`).join("")}</div>
    <div class="an-xaxis an-hx"><span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>11pm</span></div></div>`;

  const live = `<div class="an-live"><span class="dot ${a.live ? "on" : ""}"></span>${a.live ? `${a.live === 1 ? "1 person is" : n0(a.live) + " people are"} on the shop right now` : "Nobody on the shop right now"}</div>`;
  const note = `<p class="fine an-note">Counting started ${a.since ? new Date(a.since).toLocaleDateString([], { dateStyle: "medium" }) : "now, so numbers will appear once people visit"}. Visitors are counted anonymously (no names or addresses). Search engine robots, and your own visits while you’re signed in to the admin, aren’t counted. Order and message totals come from your Orders and Messages tabs.</p>`;
  return head + live + tiles + chart + `<div class="an-grid">${funnel}${sources}${kits}${devices}${hours}${pages}</div>` + note;
}

/* ================= routing & events ================= */
const route = () => decodeURIComponent(location.hash.replace(/^#/, ""));
function render(keepScroll) {
  const app = document.getElementById("app");
  let html;
  if (IS_ADMIN) { document.title = "Admin · Paint Party Kits"; html = viewAdmin(); }
  else {
    if (!store) return;
    const r = route();
    document.title = "Paint Party Kits";
    if (r === "cart") html = viewCart();
    else if (r === "checkout") html = viewCheckout();
    else if (r === "order-sent") html = viewDone();
    else if (r === "contact") html = viewContact();
    else if (itemRoute(r)) html = viewProduct(itemRoute(r));
    else html = viewHome();
    if (html === "") return;
  }
  app.innerHTML = html;
  if (!IS_ADMIN) {
    const r = route();
    applyTheme(store.season.theme);
    if (itemRoute(r) && findP(itemRoute(r))) updateProduct(itemRoute(r));
    if (r === "checkout") updateZipNote();
    if (ui.tracked !== r) { ui.tracked = r; track("pageview", pageName(r)); }
  } else if (admin.data) {
    applyTheme(admin.sdraft && admin.tab === "season" ? admin.sdraft.theme : admin.data.season.theme);
    if (admin.draft) updatePreview();
    else if (admin.tab === "season") updateSeasonPreview();
  }
  if (!keepScroll) window.scrollTo(0, 0);
  if (ui.wantSearchFocus) { ui.wantSearchFocus = false; focusSearch(); }
}
function go(h) { if (route() === h) render(); else location.hash = h; }
function focusSearch(pos) { const i = document.querySelector("[data-search]"); if (!i) return; i.focus(); const p = pos ?? i.value.length; try { i.setSelectionRange(p, p); } catch (e) {} }
window.addEventListener("hashchange", () => { ui.tracked = null; ui.contactSent = null; document.getElementById("toast").classList.remove("show"); if (!IS_ADMIN) render(); });

document.addEventListener("click", async e => {
  const t = e.target.closest("button, a"); if (!t) return;
  const ds = t.dataset;
  if ("go" in ds) { e.preventDefault(); document.getElementById("toast").classList.remove("show"); go(ds.go); return; }
  if (ds.scroll) { document.getElementById(ds.scroll)?.scrollIntoView({ behavior: "smooth" }); return; }
  if (ds.add) {
    const p = findP(ds.add); if (!p) return;
    const fromPage = "fromPage" in ds, v = choiceOf(p, ui.sel[p.id]);
    if (isCustom(p)) {
      if (!fromPage) { go("item-" + p.id); return; }
      const s = custSel(p.id), cu = p.custom, k = letterCount(s.text);
      const msg = !s.n ? `Choose how many ${unitsWord(cu, 2)} first.`
        : cu.colors.length && !s.color ? "Choose a color first."
        : cu.askText && !k ? `Type the ${cu.textLabel.toLowerCase()} first.`
        : cu.askText && k > s.n ? `“${s.text.trim()}” has ${k} ${unitsWord(cu, k)}. Choose ${k}${k < cu.max ? " or more" : ""}.` : "";
      if (msg) {
        const err = document.getElementById("chErr"); err.textContent = msg;
        const fs = err.closest(".choose"); fs.classList.remove("shake"); void fs.offsetWidth; fs.classList.add("shake");
        fs.scrollIntoView({ behavior: "smooth", block: "center" }); return;
      }
      addToCart(p.id, ui.qty[p.id] || 1, undefined, { n: s.n, ...(cu.colors.length ? { color: s.color } : {}), ...(cu.askText ? { text: s.text.trim() } : {}) });
      if (cu.askText) { s.text = ""; s.n = 0; ui.qty[p.id] = 1; render(true); } else updateProduct(p.id); // ready for the next name
      return;
    }
    if (hasChoices(p) && !v) {
      if (!fromPage) { go("item-" + p.id); return; }
      const err = document.getElementById("chErr"); err.textContent = `Choose a ${chooseWord(p)} first.`;
      const fs = err.closest(".choose"); fs.classList.remove("shake"); void fs.offsetWidth; fs.classList.add("shake");
      fs.scrollIntoView({ behavior: "smooth", block: "center" }); return;
    }
    addToCart(p.id, fromPage ? (ui.qty[p.id] || 1) : 1, v ? v.id : undefined);
    if (fromPage) updateProduct(p.id);
    return;
  }
  if (ds.photo !== undefined && ds.pid) {
    const p = findP(ds.pid), i = Number(ds.photo), u = p && photosOf(p)[i]; if (!u) return;
    ui.photo[p.id] = i; document.getElementById("mainPhoto").src = u;
    document.querySelectorAll("[data-photo]").forEach(b => b.setAttribute("aria-pressed", b === t)); return;
  }
  if (ds.step) { const input = t.parentElement.querySelector("input"); input.value = setQty(ds.ctx, ds.id, (parseInt(input.value) || 1) + Number(ds.step)); return; }
  if (ds.remove) { cart = cart.filter(l => lineKey(l) !== ds.remove); saveCart(); render(true); toast("Removed from cart"); return; }
  if ("clearSearch" in ds) { ui.query = ""; render(); return; }
  if ("searchToggle" in ds) {
    if (ui.searchOpen || ui.query) { ui.searchOpen = false; ui.query = ""; render(true); }
    else { ui.searchOpen = true; render(true); focusSearch(); }
    return;
  }
  if ("searchClose" in ds) { ui.searchOpen = false; ui.query = ""; render(true); return; }

  /* admin */
  if ("signout" in ds) { try { await api("POST", "/api/admin/logout"); } catch (err) {} admin.authed = false; admin.data = null; admin.loginError = ""; render(); return; }
  if (ds.tab) { admin.tab = ds.tab; admin.sdraft = null; admin.ddraft = null; render(true); if (ds.tab === "analytics") loadAnalytics(); return; }
  if (ds.range) { admin.anRange = ds.range; loadAnalytics(); return; }
  if ("anRefresh" in ds) { loadAnalytics(); return; }
  if ("new" in ds) { admin.draft = { id: null, name: "", blurb: "", included: [], price: 0, bulkMin: 0, bulkPct: 0, visible: true, photo: "", photos: [], variants: [], chooseLabel: "", custom: null }; admin.sub = null; admin.dirty = false; admin.cancelArmed = false; admin.deleteArmed = false; render(); return; }
  if (ds.phDel !== undefined) { readDraft(); admin.draft.photos.splice(Number(ds.phDel), 1); admin.dirty = true; render(true); return; }
  if (ds.phMain !== undefined) { readDraft(); const ph = admin.draft.photos; ph.unshift(...ph.splice(Number(ds.phMain), 1)); admin.dirty = true; render(true); return; }
  if (ds.sphDel !== undefined) { readSub(); admin.sub.d.photos.splice(Number(ds.sphDel), 1); render(true); return; }
  if (ds.sphMain !== undefined) { readSub(); const ph = admin.sub.d.photos; ph.unshift(...ph.splice(Number(ds.sphMain), 1)); render(true); return; }
  if ("colorAdd" in ds) {
    readDraft(); const c = admin.draft.custom, box = document.getElementById("c-hex");
    const list = hexList(box.value || document.getElementById("c-pick").value), bad = list.filter(h => !/^#[0-9A-F]{6}$/.test(h));
    if (!list.length) { toast("Type a color code like #FF0000, or pick a color"); return; }
    if (bad.length) { toast(`“${bad[0]}” isn’t a color code. Use 6 characters, like #FF0000.`); return; }
    const added = list.filter(h => !c.colors.includes(h)); c.colors.push(...added); c.colors = c.colors.slice(0, 40);
    admin.dirty = true; render(true); document.getElementById("c-hex")?.focus();
    toast(added.length ? `${plural(added.length, "color")} added. Remember to save.` : "That color is already on the list."); return;
  }
  if (ds.colorDel !== undefined) { readDraft(); admin.draft.custom.colors.splice(Number(ds.colorDel), 1); admin.dirty = true; render(true); return; }
  if ("subAdd" in ds) { openSub(-1, { id: "", name: "", price: null, photos: [], photo: "", blurb: "", included: [], soldOut: false }); return; }
  if (ds.subEdit !== undefined) { const i = Number(ds.subEdit); openSub(i, structuredClone(admin.draft.variants[i])); return; }
  if (ds.subDup !== undefined) { const v = structuredClone(admin.draft.variants[Number(ds.subDup)]); openSub(-1, { ...v, id: "", name: v.name + " (copy)" }); setTimeout(() => document.getElementById("s-name")?.select(), 0); return; }
  if (ds.subUp !== undefined) { readDraft(); const vs = admin.draft.variants, i = Number(ds.subUp); [vs[i - 1], vs[i]] = [vs[i], vs[i - 1]]; admin.dirty = true; render(true); return; }
  if ("subCancel" in ds) { admin.sub = null; render(); return; }
  if ("subDelete" in ds) {
    if (!admin.subDelArmed) { readSub(); admin.subDelArmed = true; render(true); return; }
    const name = admin.draft.variants[admin.sub.i].name; admin.draft.variants.splice(admin.sub.i, 1); admin.sub = null; admin.dirty = true; render();
    toast(`${name} removed. Tap “Save changes” to publish.`); return;
  }
  if (ds.edit) { const src = admin.data.products.find(p => p.id === ds.edit); admin.draft = { variants: [], chooseLabel: "", custom: null, ...structuredClone(src), photos: photosOf(src) }; admin.sub = null; admin.dirty = false; admin.cancelArmed = false; admin.deleteArmed = false; render(); return; }
  if ("cancel" in ds) {
    if (admin.dirty && !admin.cancelArmed) { readDraft(); admin.cancelArmed = true; render(true); return; }
    admin.draft = null; admin.dirty = false; admin.cancelArmed = false; render(); return;
  }
  if ("delete" in ds) {
    if (!admin.deleteArmed) { readDraft(); admin.deleteArmed = true; render(true); return; }
    try { await api("DELETE", `/api/admin/products/${encodeURIComponent(admin.draft.id)}`); admin.draft = null; admin.deleteArmed = false; await loadAdmin(); toast("Product deleted"); }
    catch (err) { adminFail(err); }
    return;
  }
  if ("sreset" in ds) { admin.sdraft = null; render(true); toast("Changes undone"); return; }
  if ("sremove" in ds) { readSeason(); admin.sdraft.photo = ""; render(true); return; }
  if ("dreset" in ds) { admin.ddraft = null; render(true); toast("Changes undone"); return; }
  if ("ringAdd" in ds) {
    readDeliveryFields(document.getElementById("delivery"));
    const rs = admin.ddraft.rings, last = rs[rs.length - 1];
    rs.push({ miles: last ? last.miles + 5 : 5, fee: last ? last.fee + 5 : 5 }); render(true); return;
  }
  if (ds.ringDel !== undefined) { readDeliveryFields(document.getElementById("delivery")); admin.ddraft.rings.splice(Number(ds.ringDel), 1); render(true); return; }
  if (ds.zoneDel) { readDeliveryFields(document.getElementById("delivery")); delete admin.ddraft.zones[ds.zoneDel]; render(true); return; }
  if ("zipAdd" in ds) {
    const zip = document.getElementById("nz").value.trim(), fee = parseFloat(document.getElementById("nzf").value);
    if (!/^\d{5}$/.test(zip)) { toast("Enter a 5-digit ZIP code"); return; }
    if (!(fee >= 0)) { toast("Enter a price for that ZIP"); return; }
    readDeliveryFields(document.getElementById("delivery"));
    admin.ddraft.zones[zip] = { fee: r2(fee), miles: null, place: "", manual: true }; render(true); toast(`${zip} added. Remember to save.`); return;
  }
  if ("generate" in ds) {
    const form = document.getElementById("delivery"); readDeliveryFields(form);
    setBusy(t, true, "Finding ZIP codes…");
    try {
      const res = await api("POST", "/api/admin/delivery/generate", { homeZip: admin.ddraft.homeZip, rings: admin.ddraft.rings, zones: admin.ddraft.zones, keepManual: true });
      admin.ddraft.zones = res.zones; render(true);
      toast(`Found ${Object.keys(res.zones).length} ZIP codes. Check them, then save.`);
    } catch (err) { if (err.errors) showErrs(form, err.errors); adminFail(err); setBusy(t, false); }
    return;
  }
});
document.addEventListener("input", e => {
  const t = e.target;
  if ("search" in t.dataset) {
    ui.query = t.value;
    if (route() !== "") { ui.wantSearchFocus = true; location.hash = ""; return; }
    const pos = t.selectionStart; render(true); focusSearch(pos); return;
  }
  if ("qty" in t.dataset && t.dataset.ctx === "pq") { const n = parseInt(t.value); if (n >= 1) setQty("pq", t.dataset.id, n); }
  if (t.id === "c-zip") checkZip(t.value.trim());
  if ("ctext" in t.dataset) {
    const p = findP(t.dataset.pid), s = custSel(t.dataset.pid), k = letterCount(t.value); s.text = t.value;
    if (k >= 1 && k <= p.custom.max) s.n = Math.max(p.custom.min, k); // the count follows the name they type
    updateCustom(p.id);
  }
  if (t.id === "c-pick") { const h = document.getElementById("c-hex"); if (h) h.value = t.value.toUpperCase(); }
  if (t.closest("#edit") && t.type !== "file") { updatePreview(); markDirty(); }
  if (t.closest("#season") && t.type !== "file") updateSeasonPreview();
  if (t.dataset.ring !== undefined) { const v = parseFloat(t.value); admin.ddraft.rings[Number(t.dataset.ring)][t.dataset.k] = Number.isFinite(v) ? v : 0; }
  if (t.dataset.zone) { const z = admin.ddraft.zones[t.dataset.zone]; const v = parseFloat(t.value); if (z && v >= 0) { z.fee = r2(v); z.manual = true; } }
});
document.addEventListener("change", async e => {
  const t = e.target;
  if ("qty" in t.dataset) { const n = parseInt(t.value); t.value = setQty(t.dataset.ctx, t.dataset.id, n >= 1 ? n : 1); }
  if ("cnt" in t.dataset && t.dataset.pid) { custSel(t.dataset.pid).n = Number(t.value); updateCustom(t.dataset.pid); }
  if ("color" in t.dataset && t.dataset.pid) { custSel(t.dataset.pid).color = t.value; updateCustom(t.dataset.pid); }
  if (t.name === "kind" && t.closest("#edit")) {
    readDraft(); const d = admin.draft;
    if (t.value === "custom") d.custom = d.custom || admin.lastCustom || structuredClone(CUSTOM_DEFAULT);
    else { admin.lastCustom = d.custom; d.custom = null; }
    markDirty(); render(true); return;
  }
  if (t.name === "cAskText" || t.name === "cUnit") { readDraft(); render(true); }
  if ("choice" in t.dataset && t.dataset.pid) { ui.sel[t.dataset.pid] = t.value; ui.photo[t.dataset.pid] = 0; render(true); document.querySelector(`[data-choice][value="${CSS.escape(t.value)}"]`)?.focus({ preventScroll: true }); }

  if (t.name === "method") {
    ui.method = t.value; document.getElementById("addr").hidden = t.value !== "delivery";
    refreshSummary("checkout");
    if (t.value === "delivery") { const z = document.getElementById("c-zip"); if (z && z.value) checkZip(z.value.trim()); }
  }
  if (t.dataset.status) {
    const kind = t.dataset.kind, list = admin.data[kind], item = list.find(x => x.id === t.dataset.status), prev = item.status;
    item.status = t.value;
    try { await api("PATCH", `/api/admin/${kind}/${encodeURIComponent(item.id)}`, { status: t.value }); render(true); toast(`Marked ${t.value.toLowerCase()}`); }
    catch (err) { item.status = prev; render(true); adminFail(err); }
  }
  if (t.closest("#edit") && t.type === "checkbox") { updatePreview(); markDirty(); }
  if (t.closest("#season") && (t.type === "checkbox" || t.type === "radio" || t.tagName === "SELECT")) updateSeasonPreview();
  if ((t.id === "e-file" || t.id === "sub-file") && t.files.length) {
    const isSub = t.id === "sub-file"; if (isSub) readSub(); else readDraft();
    const d = isSub ? admin.sub.d : admin.draft, files = [...t.files].slice(0, 10 - d.photos.length);
    toast(files.length > 1 ? `Uploading ${files.length} photos…` : "Uploading photo…");
    let added = 0;
    for (const file of files) {
      try { d.photos.push(await uploadPhoto(file, 1400)); added++; }
      catch (err) { if (err.status) adminFail(err); else toast("A photo couldn’t be opened. Try a JPG or PNG."); break; }
    }
    d.photo = d.photos[0] || ""; if (!isSub) admin.dirty = true;
    if (isSub ? admin.sub && admin.sub.d === d : admin.draft === d) render(true);
    if (added) toast(`${added > 1 ? added + " photos" : "Photo"} uploaded. ${isSub ? "Tap Done when you’re finished." : "Remember to save."}`);
    if (t.files.length > files.length) toast("You can add up to 10 photos per item.");
  }
  if (t.id === "s-file" && t.files[0]) {
    readSeason();
    toast("Uploading photo…");
    try {
      admin.sdraft.photo = await uploadPhoto(t.files[0], 1800);
      render(true); toast("Photo uploaded. Remember to save.");
    } catch (err) { if (err.status) adminFail(err); else toast("That photo couldn’t be opened. Try a JPG or PNG."); }
  }
});
document.addEventListener("keydown", e => {
  if (e.key === "Enter" && e.target.id === "c-hex") { e.preventDefault(); document.querySelector("[data-color-add]")?.click(); return; }
  if (e.key === "Escape" && (ui.searchOpen || ui.query)) { ui.searchOpen = false; ui.query = ""; render(true); }
});
document.addEventListener("submit", async e => {
  e.preventDefault(); const f = e.target;
  if (f.id === "checkout") return placeOrder(f);
  if (f.id === "contact") return sendMessage(f);
  if (f.id === "login") {
    const btn = f.querySelector('button[type="submit"]'); setBusy(btn, true, "Signing in…");
    try {
      await api("POST", "/api/admin/login", { email: f.elements.email.value, password: f.elements.password.value });
      admin.authed = true; admin.loginError = ""; render(); await loadAdmin();
    } catch (err) {
      document.getElementById("l-err").textContent = err.message; f.elements.password.value = ""; f.elements.password.focus(); setBusy(btn, false);
    }
    return;
  }
  if (f.id === "edit") return saveProduct(f);
  if (f.id === "subedit") return saveSub(f);
  if (f.id === "season") {
    readSeason();
    try { const res = await api("PUT", "/api/admin/season", admin.sdraft); admin.data.season = res.season; admin.sdraft = null; render(true); toast("Seasonal look saved"); }
    catch (err) { adminFail(err); }
    return;
  }
  if (f.id === "delivery") {
    readDeliveryFields(f);
    const btn = f.querySelector('button[type="submit"]'); setBusy(btn, true, "Saving…");
    try { const res = await api("PUT", "/api/admin/delivery", admin.ddraft); admin.data.delivery = res.delivery; admin.ddraft = null; render(true); toast("Delivery settings saved"); }
    catch (err) { adminFail(err); setBusy(btn, false); }
  }
});

/* ---------------- start ---------------- */
(async function start() {
  if (IS_ADMIN) {
    try { admin.authed = (await api("GET", "/api/admin/me")).authed; } catch (e) { admin.authed = false; }
    render();
    if (admin.authed) loadAdmin();
    return;
  }
  try {
    store = await api("GET", "/api/store");
    // drop anything no longer sold, and lines whose color/size choice no longer exists
    cart = cart.filter(l => { const p = findP(l.id); if (!p || !Number.isInteger(l.qty) || l.qty < 1) return false;
      delete l.opts; if (isCustom(p)) { delete l.v; return customOk(p, l.c); } delete l.c;
      if (!hasChoices(p)) { delete l.v; return true; } const v = choiceOf(p, l.v); return !!(v && !v.soldOut); });
    const merged = []; for (const l of cart) { const m = merged.find(x => lineKey(x) === lineKey(l)); if (m) m.qty = Math.min(999, m.qty + l.qty); else merged.push(l); }
    cart = merged; saveCart();
    render();
  } catch (e) {
    document.getElementById("app").innerHTML = `<div class="loading"><div style="text-align:center"><p>The shop couldn’t load right now.</p><a class="btn" href="/">Try again</a></div></div>`;
  }
})();
