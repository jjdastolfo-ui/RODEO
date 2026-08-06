// ─────────────────────────────────────────────────────────────────────────────
// PLATAFORMA — Núcleo de identidad y gateway
// Un solo login, N organizaciones, cada una con sistema GANADERO + FINANCIERO
// v1.0.0
// ─────────────────────────────────────────────────────────────────────────────
const express = require("express");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Org");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ── DB ────────────────────────────────────────────────────────────────────────
const DB_DIR = process.env.DB_DIR || "/data";
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(path.join(DB_DIR, "plataforma.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS organizaciones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    nombre TEXT NOT NULL,              -- nombre comercial de la cabaña / establecimiento
    razon_social TEXT,                 -- empresa del lado financiero
    esquema TEXT NOT NULL DEFAULT 'UY',-- AR | UY
    pais TEXT,
    codigo_tipo TEXT,                  -- DICOSE | RENSPA
    codigo TEXT,
    gan_url TEXT,                      -- backend ganadero
    gan_campo TEXT,                    -- clave de campo dentro del backend ganadero
    gan_frontend TEXT,
    fin_url TEXT,                      -- backend financiero
    fin_empresa TEXT,                  -- clave de empresa dentro del backend financiero
    fin_frontend TEXT,
    whatsapp TEXT,                     -- número propio del tenant (whatsapp:+598...)
    moneda_base TEXT DEFAULT 'USD',
    plan TEXT DEFAULT 'PROPIO',        -- PROPIO | DEMO | PAGO
    estado TEXT DEFAULT 'ACTIVA',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    nombre TEXT,
    telefono TEXT,                     -- para reconocerlo en WhatsApp (+598...)
    pass_hash TEXT NOT NULL,
    pass_salt TEXT NOT NULL,
    es_superadmin INTEGER DEFAULT 0,
    debe_cambiar_pass INTEGER DEFAULT 0,
    estado TEXT DEFAULT 'ACTIVO',
    ultimo_login TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS usuario_org (
    usuario_id INTEGER NOT NULL,
    org_id INTEGER NOT NULL,
    rol TEXT NOT NULL DEFAULT 'OPERADOR',  -- ADMIN | OPERADOR | LECTURA
    PRIMARY KEY (usuario_id, org_id),
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE,
    FOREIGN KEY (org_id) REFERENCES organizaciones(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS sesiones_web (
    token TEXT PRIMARY KEY,
    usuario_id INTEGER NOT NULL,
    creada TEXT DEFAULT (datetime('now')),
    expira TEXT NOT NULL,
    ip TEXT,
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS cotizaciones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT NOT NULL,
    esquema TEXT NOT NULL,             -- AR | UY
    usd_kg_novillo REAL NOT NULL,      -- US$ por kg de novillo gordo
    tc_local REAL,                     -- UYU/USD o ARS/USD
    fuente TEXT,
    UNIQUE(fecha, esquema)
  );

  CREATE TABLE IF NOT EXISTS auditoria (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT DEFAULT (datetime('now')),
    usuario_id INTEGER,
    org_id INTEGER,
    accion TEXT,
    detalle TEXT
  );
`);

// ── HASH / TOKENS ─────────────────────────────────────────────────────────────
function hashPass(pass, salt) {
  const s = salt || crypto.randomBytes(16).toString("hex");
  const h = crypto.scryptSync(String(pass), s, 64).toString("hex");
  return { hash: h, salt: s };
}
function verificarPass(pass, hash, salt) {
  try {
    const h = crypto.scryptSync(String(pass), salt, 64).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(h, "hex"), Buffer.from(hash, "hex"));
  } catch (e) { return false; }
}
function nuevoToken() { return crypto.randomBytes(32).toString("hex"); }

function auditar(usuario_id, org_id, accion, detalle) {
  try {
    db.prepare("INSERT INTO auditoria (usuario_id, org_id, accion, detalle) VALUES (?,?,?,?)")
      .run(usuario_id || null, org_id || null, accion, detalle || "");
  } catch (e) {}
}

// ── SEED INICIAL ──────────────────────────────────────────────────────────────
const ORGS_INICIALES = [
  {
    slug: "cabana-amakaik",
    nombre: "Cabaña Amakaik",
    razon_social: "Videla",
    esquema: "AR", pais: "AR", codigo_tipo: "RENSPA", codigo: "",
    gan_url: process.env.GAN_URL || "https://angus-del-este-production.up.railway.app",
    gan_campo: "angus_la_posta",
    gan_frontend: "https://jjdastolfo-ui.github.io/angus-del-este/ADE_v4.html",
    fin_url: process.env.FIN_URL_VIDELA || "https://videla-production.up.railway.app",
    fin_empresa: "LA POSTA",
    fin_frontend: "https://videla-production.up.railway.app/videla",
    whatsapp: process.env.WHATSAPP_POSTA || ""
  },
  {
    slug: "angus-del-este",
    nombre: "Angus del Este",
    razon_social: "IMPROLUX",
    esquema: "UY", pais: "UY", codigo_tipo: "DICOSE", codigo: "39100",
    gan_url: process.env.GAN_URL || "https://angus-del-este-production.up.railway.app",
    gan_campo: "angus_del_este",
    gan_frontend: "https://jjdastolfo-ui.github.io/angus-del-este/ADE_v4.html",
    fin_url: process.env.FIN_URL_IMPROLUX || "https://improlux-bot-production.up.railway.app",
    fin_empresa: "LA AMISTAD",
    fin_frontend: "https://jjdastolfo-ui.github.io/improlux-bot/improlux_v4.html",
    whatsapp: process.env.WHATSAPP_ANGUS || ""
  },
  {
    slug: "las-tranqueras",
    nombre: "Las Tranqueras",
    razon_social: "Amakaik SRL",
    esquema: "UY", pais: "UY", codigo_tipo: "DICOSE", codigo: "",
    gan_url: process.env.GAN_URL || "https://angus-del-este-production.up.railway.app",
    gan_campo: "las_tranqueras",
    gan_frontend: "https://jjdastolfo-ui.github.io/angus-del-este/ADE_v4.html",
    fin_url: process.env.FIN_URL_AMAKAIK || "https://bot-amakaik-production.up.railway.app",
    fin_empresa: "LAS TRANQUERAS",
    fin_frontend: "https://jjdastolfo-ui.github.io/Bot-Amakaik/amakaik_v4.html",
    whatsapp: process.env.WHATSAPP_TRANQUERAS || ""
  }
];

function seed() {
  const insOrg = db.prepare(`
    INSERT OR IGNORE INTO organizaciones
      (slug,nombre,razon_social,esquema,pais,codigo_tipo,codigo,gan_url,gan_campo,gan_frontend,fin_url,fin_empresa,fin_frontend,whatsapp)
    VALUES (@slug,@nombre,@razon_social,@esquema,@pais,@codigo_tipo,@codigo,@gan_url,@gan_campo,@gan_frontend,@fin_url,@fin_empresa,@fin_frontend,@whatsapp)
  `);
  ORGS_INICIALES.forEach(o => insOrg.run(o));

  // Las rutas de los modulos se resincronizan en cada arranque: INSERT OR IGNORE
  // no toca filas ya existentes, y estas URLs cambian mas seguido que el resto.
  const syncRutas = db.prepare(`UPDATE organizaciones SET
      gan_url=@gan_url, gan_campo=@gan_campo, gan_frontend=@gan_frontend,
      fin_url=@fin_url, fin_empresa=@fin_empresa, fin_frontend=@fin_frontend
    WHERE slug=@slug`);
  ORGS_INICIALES.forEach(o => syncRutas.run(o));

  const email = (process.env.ADMIN_EMAIL || "jjdastolfo@gmail.com").toLowerCase();
  const existe = db.prepare("SELECT id FROM usuarios WHERE email = ?").get(email);
  if (!existe) {
    const pass = process.env.ADMIN_PASS || "amakaik2026";
    const { hash, salt } = hashPass(pass);
    const r = db.prepare(`INSERT INTO usuarios (email,nombre,pass_hash,pass_salt,es_superadmin,debe_cambiar_pass)
      VALUES (?,?,?,?,1,?)`).run(email, "Jonatan D'Astolfo", hash, salt, process.env.ADMIN_PASS ? 0 : 1);
    const orgs = db.prepare("SELECT id FROM organizaciones").all();
    const link = db.prepare("INSERT OR IGNORE INTO usuario_org (usuario_id,org_id,rol) VALUES (?,?,'ADMIN')");
    orgs.forEach(o => link.run(r.lastInsertRowid, o.id));
    console.log(`Superadmin creado: ${email}${process.env.ADMIN_PASS ? "" : " (pass inicial: amakaik2026 — cambiala al entrar)"}`);
  }
}
seed();

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────
function leerToken(req) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) return h.slice(7);
  return req.query.token || null;
}

function auth(req, res, next) {
  const token = leerToken(req);
  if (!token) return res.status(401).json({ error: "No autenticado" });
  const s = db.prepare("SELECT * FROM sesiones_web WHERE token = ? AND expira > datetime('now')").get(token);
  if (!s) return res.status(401).json({ error: "Sesión vencida" });
  const u = db.prepare("SELECT * FROM usuarios WHERE id = ? AND estado='ACTIVO'").get(s.usuario_id);
  if (!u) return res.status(401).json({ error: "Usuario inactivo" });
  req.usuario = u;
  req.token = token;
  next();
}

function superadmin(req, res, next) {
  if (!req.usuario.es_superadmin) return res.status(403).json({ error: "Requiere superadmin" });
  next();
}

// Resuelve la organización del request y el rol del usuario en ella
function conOrg(req, res, next) {
  const slug = req.headers["x-org"] || req.query.org;
  if (!slug) return res.status(400).json({ error: "Falta organización" });
  const org = db.prepare("SELECT * FROM organizaciones WHERE slug = ? AND estado='ACTIVA'").get(slug);
  if (!org) return res.status(404).json({ error: "Organización no encontrada" });
  let rol = "ADMIN";
  if (!req.usuario.es_superadmin) {
    const rel = db.prepare("SELECT rol FROM usuario_org WHERE usuario_id=? AND org_id=?").get(req.usuario.id, org.id);
    if (!rel) return res.status(403).json({ error: "Sin acceso a esta organización" });
    rol = rel.rol;
  }
  req.org = org;
  req.rol = rol;
  next();
}

function orgsDe(usuario) {
  if (usuario.es_superadmin) {
    return db.prepare("SELECT *, 'ADMIN' as rol FROM organizaciones WHERE estado='ACTIVA' ORDER BY nombre").all();
  }
  return db.prepare(`
    SELECT o.*, uo.rol FROM organizaciones o
    JOIN usuario_org uo ON uo.org_id = o.id
    WHERE uo.usuario_id = ? AND o.estado='ACTIVA' ORDER BY o.nombre
  `).all(usuario.id);
}

function orgPublica(o) {
  return {
    id: o.id, slug: o.slug, nombre: o.nombre, razon_social: o.razon_social,
    esquema: o.esquema, pais: o.pais, codigo_tipo: o.codigo_tipo, codigo: o.codigo,
    gan_campo: o.gan_campo, gan_frontend: o.gan_frontend,
    fin_empresa: o.fin_empresa, fin_frontend: o.fin_frontend,
    whatsapp: o.whatsapp, moneda_base: o.moneda_base, plan: o.plan, rol: o.rol
  };
}

// ── AUTH API ──────────────────────────────────────────────────────────────────
app.post("/api/auth/login", (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const pass = String(req.body.password || "");
  if (!email || !pass) return res.status(400).json({ error: "Faltan datos" });

  const u = db.prepare("SELECT * FROM usuarios WHERE email = ?").get(email);
  if (!u || u.estado !== "ACTIVO" || !verificarPass(pass, u.pass_hash, u.pass_salt)) {
    auditar(u ? u.id : null, null, "LOGIN_FALLIDO", email);
    return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
  }

  const token = nuevoToken();
  db.prepare("INSERT INTO sesiones_web (token,usuario_id,expira,ip) VALUES (?,?,datetime('now','+30 days'),?)")
    .run(token, u.id, req.ip || "");
  db.prepare("UPDATE usuarios SET ultimo_login = datetime('now') WHERE id = ?").run(u.id);
  auditar(u.id, null, "LOGIN", "");

  const orgs = orgsDe(u).map(orgPublica);
  res.json({
    token,
    usuario: { id: u.id, email: u.email, nombre: u.nombre, es_superadmin: !!u.es_superadmin, debe_cambiar_pass: !!u.debe_cambiar_pass },
    organizaciones: orgs
  });
});

app.get("/api/auth/me", auth, (req, res) => {
  const u = req.usuario;
  res.json({
    usuario: { id: u.id, email: u.email, nombre: u.nombre, telefono: u.telefono, es_superadmin: !!u.es_superadmin, debe_cambiar_pass: !!u.debe_cambiar_pass },
    organizaciones: orgsDe(u).map(orgPublica)
  });
});

app.post("/api/auth/logout", auth, (req, res) => {
  db.prepare("DELETE FROM sesiones_web WHERE token = ?").run(req.token);
  res.json({ ok: true });
});

app.post("/api/auth/password", auth, (req, res) => {
  const actual = String(req.body.actual || "");
  const nueva = String(req.body.nueva || "");
  if (nueva.length < 6) return res.status(400).json({ error: "La contraseña nueva tiene que tener al menos 6 caracteres" });
  if (!verificarPass(actual, req.usuario.pass_hash, req.usuario.pass_salt)) {
    return res.status(401).json({ error: "La contraseña actual no coincide" });
  }
  const { hash, salt } = hashPass(nueva);
  db.prepare("UPDATE usuarios SET pass_hash=?, pass_salt=?, debe_cambiar_pass=0 WHERE id=?").run(hash, salt, req.usuario.id);
  db.prepare("DELETE FROM sesiones_web WHERE usuario_id = ? AND token != ?").run(req.usuario.id, req.token);
  auditar(req.usuario.id, null, "CAMBIO_PASS", "");
  res.json({ ok: true });
});

// ── ORGANIZACIONES ────────────────────────────────────────────────────────────
app.get("/api/orgs", auth, (req, res) => {
  res.json(orgsDe(req.usuario).map(orgPublica));
});

app.get("/api/orgs/:slug", auth, conOrg, (req, res) => {
  res.json(orgPublica({ ...req.org, rol: req.rol }));
});

// ── ADMIN: ORGANIZACIONES ─────────────────────────────────────────────────────
const CAMPOS_ORG = ["slug","nombre","razon_social","esquema","pais","codigo_tipo","codigo",
  "gan_url","gan_campo","gan_frontend","fin_url","fin_empresa","fin_frontend","whatsapp","moneda_base","plan","estado"];

app.get("/api/admin/orgs", auth, superadmin, (req, res) => {
  res.json(db.prepare("SELECT * FROM organizaciones ORDER BY nombre").all());
});

app.post("/api/admin/orgs", auth, superadmin, (req, res) => {
  const b = req.body || {};
  const slug = String(b.slug || b.nombre || "").toLowerCase().trim()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!slug || !b.nombre) return res.status(400).json({ error: "Falta nombre" });
  if (db.prepare("SELECT id FROM organizaciones WHERE slug=?").get(slug)) {
    return res.status(409).json({ error: "Ya existe una organización con ese identificador" });
  }
  const datos = {};
  CAMPOS_ORG.forEach(c => datos[c] = b[c] != null ? b[c] : null);
  datos.slug = slug;
  datos.esquema = b.esquema === "AR" ? "AR" : "UY";
  datos.moneda_base = b.moneda_base || "USD";
  datos.plan = b.plan || "PAGO";
  datos.estado = "ACTIVA";
  const cols = CAMPOS_ORG.join(",");
  const vals = CAMPOS_ORG.map(c => "@" + c).join(",");
  const r = db.prepare(`INSERT INTO organizaciones (${cols}) VALUES (${vals})`).run(datos);
  auditar(req.usuario.id, r.lastInsertRowid, "ORG_CREADA", datos.nombre);
  res.json({ ok: true, id: r.lastInsertRowid, slug });
});

app.put("/api/admin/orgs/:id", auth, superadmin, (req, res) => {
  const org = db.prepare("SELECT * FROM organizaciones WHERE id=?").get(req.params.id);
  if (!org) return res.status(404).json({ error: "No existe" });
  const sets = [], vals = [];
  CAMPOS_ORG.forEach(c => {
    if (c !== "slug" && req.body[c] !== undefined) { sets.push(`${c}=?`); vals.push(req.body[c]); }
  });
  if (!sets.length) return res.json({ ok: true });
  vals.push(org.id);
  db.prepare(`UPDATE organizaciones SET ${sets.join(",")} WHERE id=?`).run(...vals);
  auditar(req.usuario.id, org.id, "ORG_EDITADA", sets.join(","));
  res.json({ ok: true });
});

// ── ADMIN: USUARIOS ───────────────────────────────────────────────────────────
app.get("/api/admin/usuarios", auth, superadmin, (req, res) => {
  const us = db.prepare("SELECT id,email,nombre,telefono,es_superadmin,estado,ultimo_login,created_at FROM usuarios ORDER BY nombre").all();
  const rels = db.prepare(`SELECT uo.usuario_id, o.slug, o.nombre, uo.rol FROM usuario_org uo JOIN organizaciones o ON o.id=uo.org_id`).all();
  us.forEach(u => u.organizaciones = rels.filter(r => r.usuario_id === u.id).map(r => ({ slug: r.slug, nombre: r.nombre, rol: r.rol })));
  res.json(us);
});

app.post("/api/admin/usuarios", auth, superadmin, (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const pass = String(req.body.password || "");
  if (!email || pass.length < 6) return res.status(400).json({ error: "Email y contraseña (mín. 6) obligatorios" });
  if (db.prepare("SELECT id FROM usuarios WHERE email=?").get(email)) return res.status(409).json({ error: "Ese email ya existe" });
  const { hash, salt } = hashPass(pass);
  const r = db.prepare(`INSERT INTO usuarios (email,nombre,telefono,pass_hash,pass_salt,es_superadmin,debe_cambiar_pass)
    VALUES (?,?,?,?,?,?,1)`).run(email, req.body.nombre || email, req.body.telefono || null, hash, salt, req.body.es_superadmin ? 1 : 0);
  (req.body.organizaciones || []).forEach(o => {
    const org = db.prepare("SELECT id FROM organizaciones WHERE slug=?").get(o.slug);
    if (org) db.prepare("INSERT OR REPLACE INTO usuario_org (usuario_id,org_id,rol) VALUES (?,?,?)")
      .run(r.lastInsertRowid, org.id, o.rol || "OPERADOR");
  });
  auditar(req.usuario.id, null, "USUARIO_CREADO", email);
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.put("/api/admin/usuarios/:id", auth, superadmin, (req, res) => {
  const u = db.prepare("SELECT * FROM usuarios WHERE id=?").get(req.params.id);
  if (!u) return res.status(404).json({ error: "No existe" });
  const sets = [], vals = [];
  ["nombre","telefono","estado"].forEach(c => { if (req.body[c] !== undefined) { sets.push(`${c}=?`); vals.push(req.body[c]); } });
  if (req.body.es_superadmin !== undefined) { sets.push("es_superadmin=?"); vals.push(req.body.es_superadmin ? 1 : 0); }
  if (req.body.password) {
    if (String(req.body.password).length < 6) return res.status(400).json({ error: "Contraseña muy corta" });
    const { hash, salt } = hashPass(req.body.password);
    sets.push("pass_hash=?", "pass_salt=?", "debe_cambiar_pass=?"); vals.push(hash, salt, 1);
    db.prepare("DELETE FROM sesiones_web WHERE usuario_id=?").run(u.id);
  }
  if (sets.length) { vals.push(u.id); db.prepare(`UPDATE usuarios SET ${sets.join(",")} WHERE id=?`).run(...vals); }

  if (Array.isArray(req.body.organizaciones)) {
    db.prepare("DELETE FROM usuario_org WHERE usuario_id=?").run(u.id);
    req.body.organizaciones.forEach(o => {
      const org = db.prepare("SELECT id FROM organizaciones WHERE slug=?").get(o.slug);
      if (org) db.prepare("INSERT OR REPLACE INTO usuario_org (usuario_id,org_id,rol) VALUES (?,?,?)").run(u.id, org.id, o.rol || "OPERADOR");
    });
  }
  auditar(req.usuario.id, null, "USUARIO_EDITADO", u.email);
  res.json({ ok: true });
});

app.delete("/api/admin/usuarios/:id", auth, superadmin, (req, res) => {
  const u = db.prepare("SELECT * FROM usuarios WHERE id=?").get(req.params.id);
  if (!u) return res.status(404).json({ error: "No existe" });
  if (u.id === req.usuario.id) return res.status(400).json({ error: "No podés borrarte a vos mismo" });
  db.prepare("UPDATE usuarios SET estado='INACTIVO' WHERE id=?").run(u.id);
  db.prepare("DELETE FROM sesiones_web WHERE usuario_id=?").run(u.id);
  auditar(req.usuario.id, null, "USUARIO_BAJA", u.email);
  res.json({ ok: true });
});

// ── COTIZACIONES (US$ / kg de carne) ──────────────────────────────────────────
app.get("/api/cotizaciones", auth, (req, res) => {
  const esquema = req.query.esquema;
  const rows = esquema
    ? db.prepare("SELECT * FROM cotizaciones WHERE esquema=? ORDER BY fecha DESC LIMIT 200").all(esquema)
    : db.prepare("SELECT * FROM cotizaciones ORDER BY fecha DESC LIMIT 200").all();
  res.json(rows);
});

app.get("/api/cotizaciones/vigente", auth, (req, res) => {
  const esquema = req.query.esquema === "AR" ? "AR" : "UY";
  const row = db.prepare("SELECT * FROM cotizaciones WHERE esquema=? ORDER BY fecha DESC LIMIT 1").get(esquema);
  res.json(row || { esquema, usd_kg_novillo: null, aviso: "Sin cotización cargada" });
});

app.post("/api/cotizaciones", auth, (req, res) => {
  const fecha = req.body.fecha || new Date().toISOString().slice(0, 10);
  const esquema = req.body.esquema === "AR" ? "AR" : "UY";
  const kg = parseFloat(req.body.usd_kg_novillo);
  if (!(kg > 0)) return res.status(400).json({ error: "Falta el valor US$/kg" });
  db.prepare(`INSERT INTO cotizaciones (fecha,esquema,usd_kg_novillo,tc_local,fuente)
    VALUES (?,?,?,?,?) ON CONFLICT(fecha,esquema) DO UPDATE SET
    usd_kg_novillo=excluded.usd_kg_novillo, tc_local=excluded.tc_local, fuente=excluded.fuente`)
    .run(fecha, esquema, kg, req.body.tc_local || null, req.body.fuente || "manual");
  auditar(req.usuario.id, null, "COTIZACION", `${esquema} ${fecha} ${kg}`);
  res.json({ ok: true });
});

// ── GATEWAY ───────────────────────────────────────────────────────────────────
// /api/gan/*  → backend ganadero de la org, inyectando ?campo=
// /api/fin/*  → backend financiero de la org, inyectando ?empresa=
const SOLO_LECTURA = ["GET", "HEAD", "OPTIONS"];

async function proxy(req, res, base, extraQuery) {
  if (!base) return res.status(503).json({ error: "Esta organización todavía no tiene ese módulo configurado" });
  if (req.rol === "LECTURA" && !SOLO_LECTURA.includes(req.method)) {
    return res.status(403).json({ error: "Tu usuario es de solo lectura" });
  }

  const resto = req.params[0] || "";
  const url = new URL(`${base.replace(/\/$/, "")}/api/${resto}`);
  Object.entries(req.query).forEach(([k, v]) => {
    if (["token", "org"].includes(k)) return;
    url.searchParams.set(k, v);
  });
  Object.entries(extraQuery || {}).forEach(([k, v]) => { if (v) url.searchParams.set(k, v); });

  const opciones = { method: req.method, headers: { "Content-Type": "application/json" } };
  if (!SOLO_LECTURA.includes(req.method) && req.body && Object.keys(req.body).length) {
    opciones.body = JSON.stringify(req.body);
  }

  try {
    const r = await fetch(url.toString(), opciones);
    const ct = r.headers.get("content-type") || "";
    res.status(r.status);
    if (ct.includes("application/json")) {
      const j = await r.json().catch(() => ({}));
      return res.json(j);
    }
    res.set("content-type", ct);
    const cd = r.headers.get("content-disposition");
    if (cd) res.set("content-disposition", cd);
    const buf = Buffer.from(await r.arrayBuffer());
    return res.send(buf);
  } catch (e) {
    console.error("proxy:", url.toString(), e.message);
    res.status(502).json({ error: "No pude conectar con el módulo: " + e.message });
  }
}

app.all(/^\/api\/gan\/(.*)/, auth, conOrg, (req, res) =>
  proxy(req, res, req.org.gan_url, { campo: req.org.gan_campo }));

app.all(/^\/api\/fin\/(.*)/, auth, conOrg, (req, res) =>
  proxy(req, res, req.org.fin_url, { empresa: req.org.fin_empresa, campo: req.org.fin_empresa }));

// ── CHAT ÚNICO (router de intención — Fase 4, base) ───────────────────────────
// Manda el mensaje al módulo que corresponda. Por ahora: heurística simple,
// después se reemplaza por un router con tool-use.
const PALABRAS_FIN = /(gast|pag[oué]|cobr|factur|cheque|proveedor|plata|precio|costo|ingres|egres|banco|transferenc|sueldo|alquiler|combustible|gasoil|nafta|inversor|dividendo|presupuesto|caja|deuda|saldo)/i;
const PALABRAS_GAN = /(vaca|toro|vaquillon|tern|novill|rp\b|caravana|chip|preñ|tacto|servicio|iatf|destete|pesad|peso|kilo|lote|potrero|sanidad|vacun|parici|rodeo|semen|embri|celo|gdp)/i;

app.post("/api/chat", auth, conOrg, async (req, res) => {
  const mensaje = String(req.body.mensaje || "").trim();
  if (!mensaje) return res.json({ respuesta: "Escribí algo." });

  let destino = req.body.modulo;
  if (!destino) {
    const fin = (mensaje.match(PALABRAS_FIN) || []).length;
    const gan = (mensaje.match(PALABRAS_GAN) || []).length;
    destino = fin > gan ? "fin" : "gan";
  }

  const base = destino === "fin" ? req.org.fin_url : req.org.gan_url;
  if (!base) return res.json({ respuesta: "Ese módulo no está configurado para esta organización." });

  const url = new URL(`${base.replace(/\/$/, "")}/webhook-interno`);
  if (destino === "gan") url.searchParams.set("campo", req.org.gan_campo);
  else url.searchParams.set("empresa", req.org.fin_empresa);

  try {
    const r = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Body: mensaje, campo: req.org.gan_campo, usuario: `u${req.usuario.id}-${req.org.slug}` })
    });
    const d = await r.json().catch(() => ({}));
    auditar(req.usuario.id, req.org.id, "CHAT", destino);
    res.json({ modulo: destino, respuesta: d.respuesta || d.mensaje || "Sin respuesta del módulo." });
  } catch (e) {
    res.json({ modulo: destino, respuesta: "No pude conectar con el módulo: " + e.message });
  }
});

// ── ESTÁTICOS ─────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/app", (req, res) => res.sendFile(path.join(__dirname, "public", "app.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/salud", (req, res) => res.json({
  ok: true, sistema: "RODEO", version: "1.0.0",
  organizaciones: db.prepare("SELECT COUNT(*) n FROM organizaciones").get().n,
  usuarios: db.prepare("SELECT COUNT(*) n FROM usuarios WHERE estado='ACTIVO'").get().n
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RODEO v1.0.0 en puerto ${PORT}`);
  db.prepare("SELECT slug,nombre,esquema FROM organizaciones").all()
    .forEach(o => console.log(`  · ${o.nombre} (${o.slug}) [${o.esquema}]`));
});
