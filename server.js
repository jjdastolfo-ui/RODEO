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

  CREATE TABLE IF NOT EXISTS solicitudes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    empresa TEXT NOT NULL,
    email TEXT NOT NULL,
    telefono TEXT NOT NULL,
    pais TEXT,
    plan TEXT NOT NULL,
    animales TEXT,
    mensaje TEXT,
    estado TEXT DEFAULT 'PENDIENTE',
    notas TEXT,
    ip TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sesiones_chat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL,
    org_id INTEGER NOT NULL,
    historial TEXT DEFAULT '[]',
    ultimo_modulo TEXT,
    pendiente TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(usuario_id, org_id)
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
    gan_campo: "angus_la_posta,el_triunfo,la_guagua",
    gan_frontend: "https://jjdastolfo-ui.github.io/angus-del-este/ADE_v4.html",
    fin_url: process.env.FIN_URL_VIDELA || "https://videla-production.up.railway.app",
    fin_empresa: "LA POSTA",
    fin_frontend: "https://videla-production.up.railway.app/videla",
    whatsapp: process.env.WHATSAPP_POSTA || "whatsapp:+15074739642"
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
    whatsapp: process.env.WHATSAPP_ANGUS || "whatsapp:+59898610238"
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
    whatsapp: process.env.WHATSAPP_TRANQUERAS || "whatsapp:+13185598282"
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
  // Credenciales propias por organización (cuentas de Twilio separadas).
  // Se resincronizan en cada arranque para que cambiar la variable alcance.
  const credsPorOrg = {
    "cabana-amakaik": [process.env.TWILIO_SID_VIDELA, process.env.TWILIO_TOKEN_VIDELA]
  };
  const setCreds = db.prepare("UPDATE organizaciones SET twilio_sid=?, twilio_token=? WHERE slug=?");
  for (const [slug, [sid, token]] of Object.entries(credsPorOrg)) {
    if (sid && token) {
      setCreds.run(sid, token, slug);
      console.log(`  ${slug}: cuenta Twilio propia`);
    }
  }

  const syncRutas = db.prepare(`UPDATE organizaciones SET
      gan_url=@gan_url, gan_campo=@gan_campo, gan_frontend=@gan_frontend,
      fin_url=@fin_url, fin_empresa=@fin_empresa, fin_frontend=@fin_frontend,
      whatsapp=@whatsapp
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
// Migraciones de columnas: CREATE TABLE IF NOT EXISTS no agrega columnas nuevas.
[["sesiones_chat","ultimo_modulo","TEXT"],["sesiones_chat","pendiente","TEXT"],
 ["organizaciones","twilio_sid","TEXT"],["organizaciones","twilio_token","TEXT"]].forEach(([t,c,tipo]) => {
  try { db.prepare(`ALTER TABLE ${t} ADD COLUMN ${c} ${tipo}`).run(); } catch(e) {}
});

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

// ── USUARIOS POR ORGANIZACIÓN ─────────────────────────────────────────────────
// Un ADMIN de una organización gestiona SÓLO los usuarios de esa organización.
// Nunca puede crear superadmins ni tocar usuarios de otras organizaciones.
function adminOrg(req, res, next) {
  if (req.usuario.es_superadmin || req.rol === "ADMIN") return next();
  res.status(403).json({ error: "Requiere rol ADMIN en esta organización" });
}

app.get("/api/org/usuarios", auth, conOrg, adminOrg, (req, res) => {
  const us = db.prepare(`
    SELECT u.id, u.email, u.nombre, u.telefono, u.estado, u.ultimo_login, uo.rol
    FROM usuarios u JOIN usuario_org uo ON uo.usuario_id = u.id
    WHERE uo.org_id = ? AND u.es_superadmin = 0
    ORDER BY u.nombre
  `).all(req.org.id);
  res.json(us);
});

app.post("/api/org/usuarios", auth, conOrg, adminOrg, (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const pass = String(req.body.password || "");
  const rol = ["ADMIN", "OPERADOR", "LECTURA"].includes(req.body.rol) ? req.body.rol : "OPERADOR";
  if (!email || pass.length < 6) return res.status(400).json({ error: "Email y contraseña (mín. 6) obligatorios" });

  let u = db.prepare("SELECT * FROM usuarios WHERE email=?").get(email);
  if (u) {
    // Ya existe en la plataforma: sólo se le suma acceso a ESTA organización.
    if (u.es_superadmin) return res.status(403).json({ error: "Ese usuario se gestiona desde el panel general" });
    db.prepare("INSERT OR REPLACE INTO usuario_org (usuario_id,org_id,rol) VALUES (?,?,?)").run(u.id, req.org.id, rol);
    auditar(req.usuario.id, req.org.id, "USUARIO_VINCULADO", email);
    return res.json({ ok: true, id: u.id, ya_existia: true });
  }

  const { hash, salt } = hashPass(pass);
  const r = db.prepare(`INSERT INTO usuarios (email,nombre,telefono,pass_hash,pass_salt,es_superadmin,debe_cambiar_pass)
    VALUES (?,?,?,?,?,0,1)`).run(email, req.body.nombre || email, req.body.telefono || null, hash, salt);
  db.prepare("INSERT INTO usuario_org (usuario_id,org_id,rol) VALUES (?,?,?)").run(r.lastInsertRowid, req.org.id, rol);
  auditar(req.usuario.id, req.org.id, "USUARIO_CREADO", email);
  res.json({ ok: true, id: r.lastInsertRowid });
});

app.put("/api/org/usuarios/:id", auth, conOrg, adminOrg, (req, res) => {
  const rel = db.prepare("SELECT * FROM usuario_org WHERE usuario_id=? AND org_id=?").get(req.params.id, req.org.id);
  if (!rel) return res.status(404).json({ error: "Ese usuario no pertenece a esta organización" });
  const u = db.prepare("SELECT * FROM usuarios WHERE id=? AND es_superadmin=0").get(req.params.id);
  if (!u) return res.status(404).json({ error: "No existe" });

  const sets = [], vals = [];
  ["nombre", "telefono", "estado"].forEach(c => {
    if (req.body[c] !== undefined) { sets.push(`${c}=?`); vals.push(req.body[c]); }
  });
  if (req.body.password) {
    if (String(req.body.password).length < 6) return res.status(400).json({ error: "Contraseña muy corta" });
    const { hash, salt } = hashPass(req.body.password);
    sets.push("pass_hash=?", "pass_salt=?", "debe_cambiar_pass=?"); vals.push(hash, salt, 1);
    db.prepare("DELETE FROM sesiones_web WHERE usuario_id=?").run(u.id);
  }
  if (sets.length) { vals.push(u.id); db.prepare(`UPDATE usuarios SET ${sets.join(",")} WHERE id=?`).run(...vals); }
  if (req.body.rol && ["ADMIN", "OPERADOR", "LECTURA"].includes(req.body.rol)) {
    db.prepare("UPDATE usuario_org SET rol=? WHERE usuario_id=? AND org_id=?").run(req.body.rol, u.id, req.org.id);
  }
  auditar(req.usuario.id, req.org.id, "USUARIO_EDITADO", u.email);
  res.json({ ok: true });
});

// Quita el acceso a ESTA organización. Si no le queda ninguna, se desactiva.
app.delete("/api/org/usuarios/:id", auth, conOrg, adminOrg, (req, res) => {
  const u = db.prepare("SELECT * FROM usuarios WHERE id=? AND es_superadmin=0").get(req.params.id);
  if (!u) return res.status(404).json({ error: "No existe" });
  if (u.id === req.usuario.id) return res.status(400).json({ error: "No podés quitarte a vos mismo" });
  db.prepare("DELETE FROM usuario_org WHERE usuario_id=? AND org_id=?").run(u.id, req.org.id);
  const quedan = db.prepare("SELECT COUNT(*) n FROM usuario_org WHERE usuario_id=?").get(u.id).n;
  if (!quedan) {
    db.prepare("UPDATE usuarios SET estado='INACTIVO' WHERE id=?").run(u.id);
    db.prepare("DELETE FROM sesiones_web WHERE usuario_id=?").run(u.id);
  }
  auditar(req.usuario.id, req.org.id, "USUARIO_DESVINCULADO", u.email);
  res.json({ ok: true, desactivado: !quedan });
});

// Datos públicos de una organización, para la pantalla de entrada directa.
// Sólo nombre y esquema: nada sensible.
app.get("/api/org-publica/:slug", (req, res) => {
  const o = db.prepare("SELECT slug,nombre,razon_social,esquema FROM organizaciones WHERE slug=? AND estado='ACTIVA'").get(req.params.slug);
  if (!o) return res.status(404).json({ error: "No existe" });
  res.json(o);
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
  if (destino === "gan") url.searchParams.set("campo", String(req.org.gan_campo || "").split(",")[0].trim());
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


// ══ WHATSAPP: WEBHOOK ÚNICO ═══════════════════════════════════════════════════
// Un solo endpoint para todos los números. Resuelve la organización por el
// número destino (To), el usuario por el número de origen (From), y decide si
// el mensaje va al módulo ganadero o al financiero.
//
// Modo CERRADO: si el número que escribe no está cargado en RODEO, no se
// responde nada. El bot no existe para desconocidos.

let twilio = null;
try { twilio = require("twilio"); } catch (e) { console.log("twilio no instalado — WhatsApp deshabilitado"); }

const TWILIO_SID = process.env.TWILIO_SID || process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_TOKEN = process.env.TWILIO_TOKEN || process.env.TWILIO_AUTH_TOKEN || "";
if (TWILIO_SID && TWILIO_TOKEN) console.log("Twilio configurado (cuenta general)");

// Una organización puede vivir en otra cuenta de Twilio: si tiene credenciales
// propias las usa, si no cae en las generales. Los clientes se cachean por SID.
const _clientes = {};
function credsDeOrg(org) {
  const sid = (org && org.twilio_sid) || TWILIO_SID;
  const token = (org && org.twilio_token) || TWILIO_TOKEN;
  return { sid, token };
}
function clientePara(org) {
  if (!twilio) return null;
  const { sid, token } = credsDeOrg(org);
  if (!sid || !token) return null;
  if (!_clientes[sid]) _clientes[sid] = twilio(sid, token);
  return _clientes[sid];
}

// Deja sólo los dígitos y compara por los últimos 8: así da igual si el número
// viene con prefijo whatsapp:, con +, con 0 adelante o con espacios.
function telClave(n) {
  const d = String(n || "").replace(/\D/g, "");
  return d.length >= 8 ? d.slice(-8) : d;
}

function orgPorWhatsapp(to) {
  const clave = telClave(to);
  if (!clave) return null;
  const orgs = db.prepare("SELECT * FROM organizaciones WHERE estado='ACTIVA' AND whatsapp IS NOT NULL AND whatsapp != ''").all();
  return orgs.find(o => telClave(o.whatsapp) === clave) || null;
}

// El usuario tiene que existir Y pertenecer a esa organización.
function usuarioPorTelefono(from, orgId) {
  const clave = telClave(from);
  if (!clave) return null;
  const us = db.prepare(`
    SELECT u.*, uo.rol FROM usuarios u
    JOIN usuario_org uo ON uo.usuario_id = u.id
    WHERE u.estado='ACTIVO' AND uo.org_id = ? AND u.telefono IS NOT NULL AND u.telefono != ''
  `).all(orgId);
  return us.find(u => telClave(u.telefono) === clave) || null;
}

// ── ROUTER DE INTENCIÓN ──────────────────────────────────────────────────────
const PAL_FIN = /(gast|pag[oué]|pagu|cobr|factur|cheque|proveedor|plata|precio|costo|ingres|egres|banco|transferenc|giro|sueldo|jornal|alquiler|combustible|gasoil|nafta|inversor|dividendo|presupuesto|caja|deuda|saldo|cuenta|d[oó]lar|recibo|efectivo|debito|credito|honorario|impuesto|bps|dgi|contador|flete|comisi[oó]n)/i;
const PAL_GAN = /(vaca|vaquillona|toro|tern|novill|rp\s|caravana|chip|pre[ñn]|tacto|destete|pesad|gdp|potrero|sanidad|vacun|parici|rodeo|semen|embri|celo|ecograf|entor|repaso|madre|padre|iatf|dosis|garrapat|aftosa|brucel|desteta|marcaci[oó]n|se[ñn]alada|animal|hacienda|cabeza|majada|oveja|caballo|angus|hereford|braford|cria|invernada|recria|kilos vivo|peso vivo|dicose|renspa|guia|tropa|campo|pastoreo|pradera|aguada|alambrado|manga|corral|bret[eé]|caravaneo|reg?istro gen[eé]tico|cab[aa]ña|lluvia|llovi|pluvi|precipitac|mil[ií]metro|mm\\b)/i;

// Con matches de los dos lados y diferencia chica, el mensaje es genuinamente
// ambiguo (ej: "compré 20 vaquillonas a 800 dólares"). Antes que escribir en el
// sistema equivocado, preguntamos.
function elegirModulo(texto, ultimo) {
  const fin = (texto.match(new RegExp(PAL_FIN.source, "gi")) || []).length;
  const gan = (texto.match(new RegExp(PAL_GAN.source, "gi")) || []).length;
  if (fin > 0 && gan > 0 && Math.abs(fin - gan) <= 1) return "ambiguo";
  if (fin > gan) return "fin";
  if (gan > fin) return "gan";
  return ultimo || "gan";   // empate en cero: seguimos donde veníamos
}

// Respuesta a la repregunta: "1" / "gana" / "campo" vs "2" / "finanzas" / "plata"
function leerAclaracion(texto) {
  const t = texto.trim().toLowerCase();
  if (/^(1|g|gan|gana|ganader|campo|hacienda|rodeo)/.test(t)) return "gan";
  if (/^(2|f|fin|finan|plata|caja|numeros|n[uú]meros)/.test(t)) return "fin";
  return null;
}

function leerSesion(usuarioId, orgId) {
  return db.prepare("SELECT * FROM sesiones_chat WHERE usuario_id=? AND org_id=?").get(usuarioId, orgId) || null;
}

function guardarModulo(usuarioId, orgId, modulo) {
  db.prepare(`INSERT INTO sesiones_chat (usuario_id,org_id,ultimo_modulo,pendiente,updated_at)
    VALUES (?,?,?,NULL,datetime('now'))
    ON CONFLICT(usuario_id,org_id) DO UPDATE SET
      ultimo_modulo=excluded.ultimo_modulo, pendiente=NULL, updated_at=excluded.updated_at`)
    .run(usuarioId, orgId, modulo);
}

function guardarPendiente(usuarioId, orgId, texto) {
  db.prepare(`INSERT INTO sesiones_chat (usuario_id,org_id,pendiente,updated_at)
    VALUES (?,?,?,datetime('now'))
    ON CONFLICT(usuario_id,org_id) DO UPDATE SET pendiente=excluded.pendiente, updated_at=excluded.updated_at`)
    .run(usuarioId, orgId, texto);
}


// ── ADJUNTOS ─────────────────────────────────────────────────────────────────
// Twilio guarda el archivo en una URL que exige las credenciales de la cuenta.
// RODEO lo baja acá y se lo pasa al backend en base64: así las credenciales
// viven en un solo lugar y el backend no necesita saber que Twilio existe.
const LIMITE_ADJUNTO = 12 * 1024 * 1024;  // 12 MB

const TIPOS = {
  "image/jpeg": "imagen", "image/png": "imagen", "image/webp": "imagen", "image/heic": "imagen",
  "application/pdf": "pdf",
  "text/csv": "csv", "text/plain": "texto",
  "application/vnd.ms-excel": "excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "excel",
  "application/vnd.oasis.opendocument.spreadsheet": "excel",
  "audio/ogg": "audio", "audio/mpeg": "audio", "audio/mp4": "audio", "audio/amr": "audio"
};

function claseDeTipo(ct) {
  const limpio = String(ct || "").split(";")[0].trim().toLowerCase();
  return TIPOS[limpio] || null;
}


const EXT = {
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "text/csv": "csv",
  "text/plain": "txt",
  "application/pdf": "pdf",
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic",
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/amr": "amr"
};
function nombreDeArchivo(a, i) {
  const e = EXT[a.tipo] || "bin";
  return `adjunto${i + 1}.${e}`;
}

async function bajarAdjuntos(req, org) {
  const cuantos = parseInt(req.body.NumMedia || "0", 10);
  if (!cuantos) return [];
  const { sid, token } = credsDeOrg(org);
  if (!sid || !token) return [];

  const auth = "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");
  const salida = [];

  for (let i = 0; i < cuantos && i < 10; i++) {
    const url = req.body[`MediaUrl${i}`];
    const tipo = req.body[`MediaContentType${i}`];
    if (!url) continue;
    const clase = claseDeTipo(tipo);
    if (!clase) { salida.push({ error: "tipo", tipo }); continue; }

    try {
      const r = await fetch(url, { headers: { Authorization: auth }, redirect: "follow" });
      if (!r.ok) { salida.push({ error: "descarga", tipo }); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > LIMITE_ADJUNTO) { salida.push({ error: "tamano", tipo }); continue; }
      salida.push({
        clase, tipo: String(tipo).split(";")[0],
        bytes: buf.length,
        base64: buf.toString("base64")
      });
      console.log(`Adjunto ${clase} ${(buf.length / 1024).toFixed(0)}kB de ${org.slug}`);
    } catch (e) {
      console.error("bajando adjunto:", e.message);
      salida.push({ error: "descarga", tipo });
    }
  }
  return salida;
}

// ── ENVÍO ────────────────────────────────────────────────────────────────────
// WhatsApp corta cerca de los 1600 caracteres: partimos por párrafo.
function partir(texto, max = 1500) {
  if (texto.length <= max) return [texto];
  const partes = [], lineas = texto.split("\n");
  let actual = "";
  for (const l of lineas) {
    if ((actual + "\n" + l).length > max) { if (actual) partes.push(actual); actual = l; }
    else actual = actual ? actual + "\n" + l : l;
  }
  if (actual) partes.push(actual);
  return partes;
}

async function responder(org, desde, hacia, texto) {
  const cliente = clientePara(org);
  if (!cliente) { console.log(`Sin credenciales Twilio para ${org ? org.slug : "?"}`); return; }
  for (const parte of partir(texto)) {
    try {
      await cliente.messages.create({ from: desde, to: hacia, body: parte });
    } catch (e) {
      console.error("Error enviando:", e.message);
      break;
    }
  }
}

// ── PROCESAMIENTO (asincrónico: Twilio ya recibió su acuse) ──────────────────
async function procesarMensaje({ org, usuario, texto, from, to, adjuntos = [] }) {
  const sesion = leerSesion(usuario.id, org.id);
  let mensaje = texto;
  let modulo;

  // ¿Está contestando una repregunta nuestra?
  if (sesion && sesion.pendiente) {
    const elegido = leerAclaracion(texto);
    if (elegido) { modulo = elegido; mensaje = sesion.pendiente; }
    else { modulo = elegirModulo(texto, sesion.ultimo_modulo); }
  } else {
    modulo = elegirModulo(texto, sesion ? sesion.ultimo_modulo : null);
  }

  // Un adjunto sin texto no tiene palabras para rutear: sigue donde veníamos.
  if (modulo === "ambiguo" && adjuntos.length && !texto) {
    modulo = (sesion && sesion.ultimo_modulo) || "gan";
  }

  if (modulo === "ambiguo") {
    guardarPendiente(usuario.id, org.id, texto);
    return responder(org, to, from, "¿Esto va al campo o a la plata?\n\n1️⃣ Ganadería\n2️⃣ Finanzas");
  }

  guardarModulo(usuario.id, org.id, modulo);

  const base = modulo === "fin" ? org.fin_url : org.gan_url;
  const icono = modulo === "fin" ? "💵" : "🐄";
  if (!base) return responder(org, to, from, "Ese módulo todavía no está configurado para esta empresa.");

  const buenos = adjuntos.filter(a => !a.error).map((a, i) => ({ ...a, nombre: nombreDeArchivo(a, i) }));
  // El backend lee un documento por mensaje y elige el parser por la extensión
  // del nombre, así que le pasamos el primero que sepa leer como FileData.
  const doc = buenos.find(a => ["excel", "csv", "pdf", "texto"].includes(a.clase));
  if (doc && !mensaje) mensaje = `Procesá el archivo adjunto ${doc.nombre}`;

  const url = new URL(`${base.replace(/\/$/, "")}/webhook-interno`);
  if (modulo === "gan") url.searchParams.set("campo", String(org.gan_campo || "").split(",")[0].trim());
  else url.searchParams.set("empresa", org.fin_empresa || "");

  try {
    const r = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        Body: mensaje,
        campo: org.gan_campo,
        empresa: org.fin_empresa,
        usuario: `wa-${usuario.id}-${org.slug}`,
        adjuntos: buenos,
        ...(doc ? { FileData: doc.base64, FileName: doc.nombre } : {})
      })
    });
    const d = await r.json().catch(() => ({}));
    const respuesta = d.respuesta || d.mensaje || "No entendí. Probá de nuevo.";
    auditar(usuario.id, org.id, "WHATSAPP", modulo);
    await responder(org, to, from, `${icono} ${respuesta}`);
  } catch (e) {
    console.error("webhook->modulo:", e.message);
    await responder(org, to, from, "No pude conectar con el sistema. Probá en un minuto.");
  }
}

// ── ENDPOINT ─────────────────────────────────────────────────────────────────
const VACIO = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

app.post("/webhook", (req, res) => {
  // 1. Acuse inmediato: Twilio corta a los ~15s y con el salto extra no llegamos.
  res.type("text/xml").send(VACIO);

  const from = req.body.From || "";
  const to = req.body.To || "";
  const texto = String(req.body.Body || "").trim();
  const conAdjunto = parseInt(req.body.NumMedia || "0", 10) > 0;
  if (!texto && !conAdjunto) return;   // un archivo solo, sin texto, es válido

  // 2. Organización primero: el número destino dice de qué empresa se trata.
  const org = orgPorWhatsapp(to);
  if (!org) { console.warn(`Número sin organización: ${to}`); return; }

  // 3. Firma: se valida con el token de la cuenta que mandó el mensaje. Cada
  // organización puede estar en una cuenta distinta, así que un token único
  // rechazaría mensajes legítimos de las demás.
  const { token: tokenOrg } = credsDeOrg(org);
  if (twilio && tokenOrg && process.env.VALIDAR_FIRMA !== "0") {
    const firma = req.headers["x-twilio-signature"];
    const proto = req.headers["x-forwarded-proto"] || "https";
    const urlPublica = `${proto}://${req.headers.host}${req.originalUrl}`;
    const ok = twilio.validateRequest(tokenOrg, firma, urlPublica, req.body || {});
    if (!ok) { console.warn(`Firma inválida para ${org.slug} — descartado`); return; }
  }

  const usuario = usuarioPorTelefono(from, org.id);
  if (!usuario) { console.warn(`Número no autorizado en ${org.slug}: ${from}`); return; }  // silencio

  (async () => {
    const adjuntos = await bajarAdjuntos(req, org);
    const fallados = adjuntos.filter(a => a.error);
    if (fallados.length) {
      const razon = {
        tipo: "Ese tipo de archivo todavía no lo puedo leer.",
        tamano: "El archivo es muy grande. Probá con uno de menos de 12 MB.",
        descarga: "No pude bajar el archivo. Reenvialo, por favor."
      }[fallados[0].error];
      await responder(org, to, from, razon);
      if (fallados.length === adjuntos.length) return;
    }
    await procesarMensaje({ org, usuario, texto, from, to, adjuntos });
  })()
    .catch(e => console.error("procesarMensaje:", e.message));
});

// Diagnóstico: qué número está atado a qué organización y quién puede escribir.
app.get("/api/whatsapp/estado", auth, (req, res) => {
  if (!req.usuario.es_superadmin) return res.status(403).json({ error: "Requiere superadmin" });
  const orgs = db.prepare("SELECT id,slug,nombre,whatsapp FROM organizaciones WHERE estado='ACTIVA'").all();
  res.json({
    twilio_general: !!(TWILIO_SID && TWILIO_TOKEN),
    validando_firma: process.env.VALIDAR_FIRMA !== "0",
    organizaciones: orgs.map(o => ({
      slug: o.slug, nombre: o.nombre, whatsapp: o.whatsapp || null,
      cuenta_twilio: (db.prepare("SELECT twilio_sid FROM organizaciones WHERE id=?").get(o.id).twilio_sid || TWILIO_SID || "").slice(0, 10) + "…",
      puede_responder: !!clientePara(db.prepare("SELECT * FROM organizaciones WHERE id=?").get(o.id)),
      autorizados: db.prepare(`SELECT u.nombre,u.telefono FROM usuarios u
        JOIN usuario_org uo ON uo.usuario_id=u.id
        WHERE uo.org_id=? AND u.estado='ACTIVO' AND u.telefono IS NOT NULL AND u.telefono!=''`).all(o.id)
    }))
  });
});

// ── ESTÁTICOS ─────────────────────────────────────────────────────────────────

// ── SOLICITUDES DE ALTA (público) ────────────────────────────────────────────
// El alta NO crea la organización todavía: crea una solicitud pendiente. Hasta
// que exista el provisioning de bases propias, dar de alta automáticamente
// significaría apuntar al cliente nuevo a datos de otra empresa.
const PLANES = {
  usd: { nombre: "Dólares + ganadero", moneda: "USD" },
  kg:  { nombre: "Kilos de carne + ganadero", moneda: "KG" }
};

app.post("/api/registro", (req, res) => {
  const b = req.body || {};
  const nombre = String(b.nombre || "").trim();
  const empresa = String(b.empresa || "").trim();
  const email = String(b.email || "").trim().toLowerCase();
  const telefono = String(b.telefono || "").replace(/[^\d+]/g, "");
  const plan = PLANES[b.plan] ? b.plan : null;

  if (!nombre || !empresa) return res.status(400).json({ error: "Falta tu nombre o el del establecimiento" });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Revisá el email" });
  if (telefono.replace(/\D/g, "").length < 8) return res.status(400).json({ error: "El celular tiene que ir con código de país" });
  if (!plan) return res.status(400).json({ error: "Elegí en qué moneda vas a trabajar" });

  // Una solicitud pendiente por email alcanza.
  const previa = db.prepare("SELECT id, estado FROM solicitudes WHERE lower(email)=? AND estado='PENDIENTE'").get(email);
  if (previa) return res.json({ ok: true, ya_existia: true });
  if (db.prepare("SELECT id FROM usuarios WHERE lower(email)=?").get(email)) {
    return res.status(409).json({ error: "Ese email ya tiene cuenta. Entrá con tu clave." });
  }

  db.prepare(`INSERT INTO solicitudes (nombre,empresa,email,telefono,pais,plan,animales,mensaje,ip)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(nombre, empresa, email, telefono, String(b.pais || "").slice(0, 40), plan,
         String(b.animales || "").slice(0, 40), String(b.mensaje || "").slice(0, 500), req.ip || "");
  console.log(`Solicitud nueva: ${empresa} (${email}) plan ${plan}`);
  res.json({ ok: true });
});

app.get("/api/admin/solicitudes", auth, superadmin, (req, res) => {
  res.json(db.prepare("SELECT * FROM solicitudes ORDER BY created_at DESC").all());
});

app.patch("/api/admin/solicitudes/:id", auth, superadmin, (req, res) => {
  const estados = ["PENDIENTE", "CONTACTADA", "ACTIVADA", "DESCARTADA"];
  if (!estados.includes(req.body.estado)) return res.status(400).json({ error: "Estado inválido" });
  db.prepare("UPDATE solicitudes SET estado=?, notas=? WHERE id=?")
    .run(req.body.estado, String(req.body.notas || ""), req.params.id);
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "landing.html")));
app.get("/entrar", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/app", (req, res) => res.sendFile(path.join(__dirname, "public", "app.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
// Entrada directa a una organización: /o/<slug>
app.get("/o/:slug", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
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
