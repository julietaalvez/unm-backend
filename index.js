const express = require('express');
const mysql = require('mysql2');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
// Railway pasa las conexiones por un proxy: sin esto el límite de intentos no distingue usuarios
app.set('trust proxy', 1);
app.use(require('cors')());
app.use(express.json({ limit: '2mb' }));

// Base 1: la de siempre (usuarios, login, registro)
const db = mysql.createPool(process.env.MYSQL_PUBLIC_URL);

// Base 2: la de las compañeras (materias, horarios, comisiones, profesores...).
// Si todavía no cargaste MYSQL_URL_ACADEMICO en Railway, usa la base 1 para no romper nada.
const dbAcad = process.env.MYSQL_URL_ACADEMICO
  ? mysql.createPool(process.env.MYSQL_URL_ACADEMICO)
  : db;

db.query('SELECT 1', (err) => {
  if (err) console.error('Error al conectar a la base 1:', err);
  else console.log('Conectado a MySQL (usuarios) ✅');
});
if (dbAcad !== db) {
  dbAcad.query('SELECT 1', (err) => {
    if (err) console.error('Error al conectar a la base académica:', err);
    else console.log('Conectado a MySQL (académica) ✅');
  });
}

app.get('/espacios', (req, res) => {
  db.query('SELECT * FROM espacios', (err, results) => {
    if (err) return res.status(500).json(err);
    res.json(results);
  });
});

app.get('/novedades', (req, res) => {
  db.query('SELECT * FROM novedades ORDER BY fecha DESC', (err, results) => {
    if (err) {
      console.log('Error en /novedades:', err);
      return res.status(500).json({ error: 'Error del servidor.' });
    }
    res.json(results);
  });
});

/* ============================================================
   Carreras (la función se usa también al registrarse)
   ============================================================ */

// Guarda las carreras de un usuario (reemplaza las anteriores)
function guardarCarreras(usuarioId, ids, cb) {
  const limpias = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  db.query('DELETE FROM usuario_carreras WHERE usuario_id = ?', [usuarioId], (err) => {
    if (err) return cb(err);
    if (limpias.length === 0) return cb(null);
    db.query(
      'INSERT IGNORE INTO usuario_carreras (usuario_id, carrera_id) SELECT ?, id FROM carreras WHERE id IN (?)',
      [usuarioId, limpias],
      cb
    );
  });
}

/* ============================================================
   Validación de docentes
   ============================================================ */

const MSG_DOCENTE =
  'No pudimos validar tu cuenta de docente. Revisá tu nombre y apellido o contactá a la secretaría.';

// sin tildes, sin mayúsculas, sin importar el orden de las palabras
const norm = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const tokensDe = (t) => norm(t).split(/[^a-z0-9]+/).filter(Boolean);
const contiene = (grande, chico) => chico.length > 0 && chico.every((x) => grande.includes(x));
const nombreCompleto = (p) => [p.nombre, p.apellido].filter(Boolean).join(' ');

// límite de intentos fallidos: 5 errores y se bloquea 10 minutos
const intentos = new Map();
const MAX_INTENTOS = 5;
const BLOQUEO_MS = 10 * 60 * 1000;
function bloqueado(ip) {
  const r = intentos.get(ip);
  if (!r || !r.hasta) return false;
  if (r.hasta > Date.now()) return true;
  intentos.delete(ip);
  return false;
}
function falloIntento(ip) {
  const r = intentos.get(ip) || { n: 0, hasta: 0 };
  r.n += 1;
  if (r.n >= MAX_INTENTOS) {
    r.hasta = Date.now() + BLOQUEO_MS;
    r.n = 0;
  }
  intentos.set(ip, r);
}

// Busca al docente en la base académica. Si hay homónimos, desempata por carrera.
async function buscarDocente(nombre, carreras) {
  const buscados = tokensDe(nombre);
  if (buscados.length < 2) return null; // hace falta nombre y apellido

  const [profes] = await dbAcad.promise().query('SELECT id, nombre, apellido FROM profesores');
  let candidatos = profes.filter((p) => contiene(tokensDe(nombreCompleto(p)), buscados));
  if (candidatos.length <= 1) return candidatos[0] || null;

  const ids = [...new Set((Array.isArray(carreras) ? carreras : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (ids.length === 0) return null;

  const [mc] = await dbAcad.promise().query(
    'SELECT DISTINCT m.nombre AS materia FROM carrera_materias cm JOIN materias m ON m.id = cm.materia_id WHERE cm.carrera_id IN (?)',
    [ids]
  );
  const materiasDeLaCarrera = new Set(mc.map((r) => norm(r.materia)));

  const [dicta] = await dbAcad.promise().query(
    `SELECT cd.profesor_id, m.nombre AS materia
     FROM comision_docentes cd
     JOIN comisiones c ON c.id = cd.comision_id
     JOIN materias m ON m.id = c.materia_id
     WHERE cd.profesor_id IN (?)`,
    [candidatos.map((p) => p.id)]
  );
  const enCarrera = new Set(dicta.filter((r) => materiasDeLaCarrera.has(norm(r.materia))).map((r) => r.profesor_id));
  candidatos = candidatos.filter((p) => enCarrera.has(p.id));
  return candidatos.length === 1 ? candidatos[0] : null;
}

// Si ya hay una cuenta de profesor con ese nombre, no se crea otra
async function docenteYaRegistrado(docente) {
  const completo = tokensDe(nombreCompleto(docente));
  const [ya] = await db.promise().query("SELECT nombre FROM usuarios WHERE rol = 'profesor'");
  return ya.some((u) => {
    const t = tokensDe(u.nombre);
    return contiene(completo, t) || contiene(t, completo);
  });
}

/* ============================================================
   DNI
   ============================================================ */

// DNI argentino: 7 u 8 números. Se guarda como texto, sin puntos ni espacios.
const DNI_RE = /^\d{7,8}$/;
const limpiarDni = (v) => String(v ?? '').replace(/[.\s]/g, '');

/* ============================================================
   Registro y login
   ============================================================ */

app.post('/register', async (req, res) => {
  const { nombre, email, contrasena, carreras, rol } = req.body;
  if (!nombre || !email || !contrasena) {
    return res.status(400).json({ error: 'Faltan datos.' });
  }

  const esProfesor = rol === 'profesor';

  // DNI obligatorio para alumnos. Los docentes se validan contra la base académica, así que es opcional.
  const dni = limpiarDni(req.body.dni);
  if ((!esProfesor || dni) && !DNI_RE.test(dni)) {
    return res.status(400).json({ error: 'Ingresá tu DNI: 7 u 8 números, sin puntos.' });
  }
  const dniGuardar = dni || null;

  if (esProfesor) {
    if (bloqueado(req.ip)) {
      return res.status(429).json({ error: 'Demasiados intentos. Probá de nuevo en unos minutos.' });
    }
    try {
      const docente = await buscarDocente(nombre, carreras);
      const valido = !!docente && !(await docenteYaRegistrado(docente));
      if (!valido) {
        falloIntento(req.ip);
        return res.status(403).json({ error: MSG_DOCENTE });
      }
    } catch (e) {
      console.log('Error al validar docente:', e);
      return res.status(500).json({ error: 'Error del servidor.' });
    }
  }

  db.query(
    'SELECT email FROM usuarios WHERE email = ? OR (dni IS NOT NULL AND dni = ?)',
    [email, dniGuardar],
    (err, results) => {
      if (err) {
        console.log('Error al verificar email/dni:', err);
        return res.status(500).json({ error: 'Error del servidor.' });
      }
      if (results.length > 0) {
        const mismoEmail = results.some((r) => String(r.email).toLowerCase() === String(email).toLowerCase());
        return res.status(409).json({
          error: mismoEmail ? 'Ese email ya está registrado.' : 'Ese DNI ya está registrado.',
        });
      }

      db.query(
        'INSERT INTO usuarios (nombre, email, contraseña, rol, dni) VALUES (?, ?, ?, ?, ?)',
        [nombre, email, bcrypt.hashSync(String(contrasena), 10), esProfesor ? 'profesor' : 'estudiante', dniGuardar],
        (err2, result) => {
          if (err2) {
            if (err2.code === 'ER_DUP_ENTRY') {
              return res.status(409).json({ error: 'Ese email o DNI ya está registrado.' });
            }
            console.log('Error al registrar:', err2);
            return res.status(500).json({ error: 'No se pudo registrar.' });
          }
          guardarCarreras(result.insertId, carreras, (err3) => {
            if (err3) console.log('Error al guardar carreras:', err3);
            res.json({ ok: true });
          });
        }
      );
    }
  );
});

// ---------- contraseñas con bcrypt ----------
const esHash = (s) => /^\$2[aby]\$/.test(String(s || ''));

app.post('/login', (req, res) => {
  const { email, contrasena } = req.body;

  if (!email || !contrasena) {
    return res.status(400).json({ error: 'Faltan datos.' });
  }

  db.query(
    'SELECT id, nombre, email, rol, foto, dni, contraseña FROM usuarios WHERE email = ?',
    [email],
    async (err, results) => {
      if (err) {
        console.log('Error en login:', err);
        return res.status(500).json({ error: 'Error del servidor.' });
      }
      const u = results[0];
      let ok = false;
      if (u) {
        if (esHash(u.contraseña)) {
          ok = await bcrypt.compare(String(contrasena), u.contraseña);
        } else if (u.contraseña === contrasena) {
          // contraseña vieja (texto plano): entra y la guardamos encriptada
          ok = true;
          db.query('UPDATE usuarios SET contraseña = ? WHERE id = ?', [bcrypt.hashSync(String(contrasena), 10), u.id], () => {});
        }
      }
      if (!ok) return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
      const { contraseña, ...usuario } = u;
      res.json({ usuario });
    }
  );
});

/* ============================================================
   Recuperar contraseña (código de 6 dígitos por mail)
   ============================================================ */

async function mandarMail(para, asunto, texto) {
  const r = await fetch(process.env.MAIL_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ token: process.env.MAIL_TOKEN, para, asunto, texto }),
    redirect: 'follow',
  });
  const d = await r.json().catch(() => null);
  if (!r.ok || !d || !d.ok) throw new Error(`Script de mail ${r.status}: ${d ? d.error : 'sin respuesta'}`);
}

// máximo 5 pedidos de código por IP cada 15 minutos
const pedidosReset = new Map();
function reseteoLimitado(ip) {
  const ahora = Date.now();
  const r = (pedidosReset.get(ip) || []).filter((t) => ahora - t < 15 * 60 * 1000);
  const limitado = r.length >= 5;
  if (!limitado) r.push(ahora);
  pedidosReset.set(ip, r);
  return limitado;
}

// POST /olvide-contrasena  { email }   (siempre responde igual, exista o no el email)
app.post('/olvide-contrasena', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Ingresá un email válido.' });
  if (reseteoLimitado(req.ip)) return res.status(429).json({ error: 'Demasiados pedidos. Probá de nuevo en unos minutos.' });

  db.query('SELECT id FROM usuarios WHERE email = ?', [email], (err, rows) => {
    if (err) {
      console.log('Error en olvide-contrasena:', err);
      return res.status(500).json({ error: 'Error del servidor.' });
    }
    if (rows.length === 0) return res.json({ ok: true });
    const uid = rows[0].id;
    const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    db.query(
      'REPLACE INTO reset_contrasena (usuario_id, codigo_hash, vence, intentos) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 15 MINUTE), 0)',
      [uid, bcrypt.hashSync(codigo, 8)],
      async (err2) => {
        if (err2) {
          console.log('Error al guardar código:', err2);
          return res.status(500).json({ error: 'Error del servidor.' });
        }
        try {
          await mandarMail(
            email,
            'Tu código de UNM Connect',
            `Tu código para crear una contraseña nueva es: ${codigo}\n\nVence en 15 minutos. Si no lo pediste vos, ignorá este mail.`
          );
          res.json({ ok: true });
        } catch (e) {
          console.log('Error al mandar mail:', e.message);
          res.status(500).json({ error: 'No pudimos enviar el mail. Probá de nuevo más tarde.' });
        }
      }
    );
  });
});

// POST /restablecer-contrasena  { email, codigo, contrasena }
app.post('/restablecer-contrasena', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const codigo = String(req.body.codigo || '').trim();
  const nueva = String(req.body.contrasena || '');
  if (!/^\d{6}$/.test(codigo)) return res.status(400).json({ error: 'El código tiene 6 dígitos.' });
  if (nueva.length < 6 || nueva.length > 100) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
  const MALO = { error: 'El código es incorrecto o venció.' };

  db.query(
    `SELECT u.id, r.codigo_hash, r.intentos, (r.vence > NOW()) AS vigente
     FROM usuarios u JOIN reset_contrasena r ON r.usuario_id = u.id
     WHERE u.email = ?`,
    [email],
    async (err, rows) => {
      if (err) {
        console.log('Error en restablecer-contrasena:', err);
        return res.status(500).json({ error: 'Error del servidor.' });
      }
      if (rows.length === 0) return res.status(400).json(MALO);
      const r = rows[0];
      if (!r.vigente || r.intentos >= 5) {
        db.query('DELETE FROM reset_contrasena WHERE usuario_id = ?', [r.id], () => {});
        return res.status(400).json(MALO);
      }
      if (!(await bcrypt.compare(codigo, r.codigo_hash))) {
        db.query('UPDATE reset_contrasena SET intentos = intentos + 1 WHERE usuario_id = ?', [r.id], () => {});
        return res.status(400).json(MALO);
      }
      db.query('UPDATE usuarios SET contraseña = ? WHERE id = ?', [bcrypt.hashSync(nueva, 10), r.id], (err2) => {
        if (err2) {
          console.log('Error al cambiar contraseña:', err2);
          return res.status(500).json({ error: 'No se pudo guardar.' });
        }
        db.query('DELETE FROM reset_contrasena WHERE usuario_id = ?', [r.id], () => res.json({ ok: true }));
      });
    }
  );
});

/* ============================================================
   Datos académicos (base de las compañeras)
   ============================================================ */

// Una fila por cada horario, con todo lo necesario ya unido.
const SQL_HORARIOS = `
  SELECT h.id, h.dia_semana, h.desde, h.hasta, h.presencial, h.alterna, h.aula_texto,
         m.nombre AS materia, m.anio, m.cuatrimestre,
         c.codigo AS comision, c.modalidad,
         e.codigo_mapa, e.nombre AS espacio, e.piso, e.edificio_id,
         ed.nombre AS edificio,
         p.id AS profesor_id, p.slug, p.apellido, p.nombre AS profesor_nombre
  FROM horarios h
  JOIN comisiones c            ON c.id = h.comision_id
  JOIN materias m              ON m.id = c.materia_id
  LEFT JOIN espacios e         ON e.id = h.espacio_id
  LEFT JOIN edificios ed       ON ed.id = e.edificio_id
  LEFT JOIN comision_docentes cd ON cd.comision_id = c.id
  LEFT JOIN profesores p       ON p.id = cd.profesor_id
`;

const hhmm = (v) => (v == null ? '' : String(v).slice(0, 5));
// dia_semana: 1=lunes … 6=sábado, 7 (o 0)=domingo  ->  0=domingo … 6=sábado (como JS)
const diaJS = (d) => Number(d) % 7;
const nombreProfe = (r) => [r.profesor_nombre, r.apellido].filter(Boolean).join(' ').trim();

// Hora y día actuales en Argentina (el servidor de Railway está en UTC)
function ahoraAR() {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Argentina/Buenos_Aires', weekday: 'short',
  }).format(new Date());
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(f);
}

// GET /clases/hoy -> [{ aula_id, materia, desde, hasta, profesor }]
app.get('/clases/hoy', (req, res) => {
  // ?dia=1 (lunes) … 0 (domingo): solo para probar otro día
  const hoy = req.query.dia !== undefined ? Number(req.query.dia) : ahoraAR();
  dbAcad.query(SQL_HORARIOS + ' WHERE h.presencial = 1 AND e.codigo_mapa IS NOT NULL', (err, rows) => {
    if (err) {
      console.log('Error en /clases/hoy:', err);
      return res.status(500).json({ error: 'Error del servidor.' });
    }
    // Una fila por clase: si tiene varios docentes, se juntan en el mismo texto
    const porClase = new Map();
    for (const r of rows) {
      if (diaJS(r.dia_semana) !== hoy) continue;
      const clave = `${r.id}`;
      const nombre = nombreProfe(r);
      if (!porClase.has(clave)) {
        porClase.set(clave, {
          aula_id: r.codigo_mapa, materia: r.materia,
          desde: hhmm(r.desde), hasta: hhmm(r.hasta), profes: [],
        });
      }
      const c = porClase.get(clave);
      if (nombre && !c.profes.includes(nombre)) c.profes.push(nombre);
    }
    const out = [...porClase.values()]
      .map(({ profes, ...c }) => ({ ...c, profesor: profes.join(', ') }))
      .sort((a, b) => a.desde.localeCompare(b.desde));
    res.json(out);
  });
});

// GET /profesores -> [{ id, nombre, materias4, franjas: [...] }]  (misma forma que Profe/Franja de la app)
app.get('/profesores', (req, res) => {
  dbAcad.query(SQL_HORARIOS + ' WHERE p.id IS NOT NULL', (err, rows) => {
    if (err) {
      console.log('Error en /profesores:', err);
      return res.status(500).json({ error: 'Error del servidor.' });
    }
    const profes = new Map();
    for (const r of rows) {
      const key = r.slug || String(r.profesor_id);
      if (!profes.has(key)) profes.set(key, { id: key, nombre: nombreProfe(r), materias: new Set(), franjas: new Map() });
      const p = profes.get(key);
      p.materias.add(r.materia);

      const presencial = r.presencial === 1 || r.presencial === true;
      const lugar = presencial
        ? [r.edificio, r.espacio || r.aula_texto].filter(Boolean).join(' · ') || 'Sin aula asignada'
        : 'Virtual';
      // Se juntan los días que comparten mismo horario, materia y lugar
      const fk = [r.materia, r.comision, hhmm(r.desde), hhmm(r.hasta), lugar, presencial].join('|');
      if (!p.franjas.has(fk)) {
        p.franjas.set(fk, {
          dias: [], desde: hhmm(r.desde), hasta: hhmm(r.hasta),
          edificio: r.edificio || '', edificioId: r.edificio_id != null ? String(r.edificio_id) : null,
          aula: r.codigo_mapa || null, lugar, extra: [],
          materia: r.materia, comision: r.comision || '', anio: r.anio || 0,
          modo: presencial ? 'presencial' : 'virtual', alterna: r.alterna === 1 || r.alterna === true,
          cuatrimestre: r.cuatrimestre != null ? Number(r.cuatrimestre) : 0,
        });
      }
      const f = p.franjas.get(fk);
      const d = diaJS(r.dia_semana);
      if (!f.dias.includes(d)) f.dias.push(d);
    }
    res.json(
      [...profes.values()]
        .map((p) => ({ id: p.id, nombre: p.nombre, materias4: [...p.materias].slice(0, 4), franjas: [...p.franjas.values()] }))
        .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
    );
  });
});

// GET /aulas -> [{ aula_id, capacidad, enchufes, wifi, proyector, accesible, nota }]
// Usa SELECT * para no romperse si alguna columna todavía no existe.
app.get('/aulas', (req, res) => {
  dbAcad.query('SELECT * FROM espacios WHERE codigo_mapa IS NOT NULL', (err, rows) => {
    if (err) {
      console.log('Error en /aulas:', err);
      return res.status(500).json({ error: 'Error del servidor.' });
    }
    const bool = (v) => (v == null ? null : v === 1 || v === true || v === '1');
    res.json(rows.map((r) => ({
      aula_id: r.codigo_mapa,
      capacidad: r.capacidad ?? null,
      enchufes: r.enchufes == null ? null : Number(r.enchufes),
      wifi: bool(r.wifi),
      proyector: bool(r.proyector),
      accesible: bool(r.accesible),
      nota: r.nota ?? r.notas ?? null,
    })));
  });
});

// GET /materias -> [{ nombre, anio }]  (lista de materias tal cual están en la base, para asignarlas a carreras)
app.get('/materias', (req, res) => {
  dbAcad.query('SELECT DISTINCT nombre, anio FROM materias ORDER BY anio, nombre', (err, rows) => {
    if (err) {
      console.log('Error en /materias:', err);
      return res.status(500).json({ error: 'Error del servidor.' });
    }
    res.json(rows);
  });
});

/* ============================================================
   Inscripciones: las materias que cursa cada usuario
   ============================================================ */

const idValido = (v) => Number.isInteger(Number(v)) && Number(v) > 0;
const claveValida = (c) => typeof c === 'string' && c.length > 0 && c.length <= 255;

// GET /usuarios/:id/inscripciones -> { claves: ["Materia|comisión", ...] }
app.get('/usuarios/:id/inscripciones', (req, res) => {
  if (!idValido(req.params.id)) return res.status(400).json({ error: 'Usuario inválido.' });
  db.query('SELECT clave FROM inscripciones WHERE usuario_id = ? ORDER BY id', [req.params.id], (err, rows) => {
    if (err) {
      console.log('Error al leer inscripciones:', err);
      return res.status(500).json({ error: 'Error del servidor.' });
    }
    res.json({ claves: rows.map((r) => r.clave) });
  });
});

// POST /usuarios/:id/inscripciones  { clave }
app.post('/usuarios/:id/inscripciones', (req, res) => {
  const { clave } = req.body;
  if (!idValido(req.params.id) || !claveValida(clave)) return res.status(400).json({ error: 'Datos inválidos.' });
  db.query('INSERT IGNORE INTO inscripciones (usuario_id, clave) VALUES (?, ?)', [req.params.id, clave], (err) => {
    if (err) {
      console.log('Error al inscribir:', err);
      return res.status(500).json({ error: 'No se pudo guardar.' });
    }
    res.json({ ok: true });
  });
});

// DELETE /usuarios/:id/inscripciones?clave=...
app.delete('/usuarios/:id/inscripciones', (req, res) => {
  const clave = req.query.clave;
  if (!idValido(req.params.id) || !claveValida(clave)) return res.status(400).json({ error: 'Datos inválidos.' });
  db.query('DELETE FROM inscripciones WHERE usuario_id = ? AND clave = ?', [req.params.id, clave], (err) => {
    if (err) {
      console.log('Error al quitar inscripción:', err);
      return res.status(500).json({ error: 'No se pudo quitar.' });
    }
    res.json({ ok: true });
  });
});

/* ============================================================
   Carreras
   ============================================================ */

// GET /carreras -> [{ id, nombre }]
app.get('/carreras', (req, res) => {
  db.query('SELECT id, nombre FROM carreras ORDER BY nombre', (err, rows) => {
    if (err) {
      console.log('Error en /carreras:', err);
      return res.status(500).json({ error: 'Error del servidor.' });
    }
    res.json(rows);
  });
});

// GET /usuarios/:id/carreras -> { ids: [1, 2] }
app.get('/usuarios/:id/carreras', (req, res) => {
  const uid = Number(req.params.id);
  if (!Number.isInteger(uid) || uid <= 0) return res.status(400).json({ error: 'Usuario inválido.' });
  db.query('SELECT carrera_id FROM usuario_carreras WHERE usuario_id = ?', [uid], (err, rows) => {
    if (err) {
      console.log('Error al leer carreras:', err);
      return res.status(500).json({ error: 'Error del servidor.' });
    }
    res.json({ ids: rows.map((r) => r.carrera_id) });
  });
});

// PUT /usuarios/:id/carreras  { carreras: [1, 2] }
app.put('/usuarios/:id/carreras', (req, res) => {
  const uid = Number(req.params.id);
  if (!Number.isInteger(uid) || uid <= 0) return res.status(400).json({ error: 'Usuario inválido.' });
  guardarCarreras(uid, req.body.carreras, (err) => {
    if (err) {
      console.log('Error al guardar carreras:', err);
      return res.status(500).json({ error: 'No se pudo guardar.' });
    }
    res.json({ ok: true });
  });
});

// GET /materias/carreras -> [{ materia, carrera_id }]  (qué materia es de qué carrera)
app.get('/materias/carreras', (req, res) => {
  dbAcad.query(
    'SELECT DISTINCT m.nombre AS materia, cm.carrera_id FROM carrera_materias cm JOIN materias m ON m.id = cm.materia_id',
    (err, rows) => {
      if (err) {
        console.log('Error en /materias/carreras:', err);
        return res.status(500).json({ error: 'Error del servidor.' });
      }
      res.json(rows);
    }
  );
});

// GET /carreras/:id/plan -> [{ nombre, anio, cuatri, electiva }]  (plan de estudios, de carrera_materias)
app.get('/carreras/:id/plan', (req, res) => {
  const cid = Number(req.params.id);
  if (!Number.isInteger(cid) || cid <= 0) return res.status(400).json({ error: 'Carrera inválida.' });
  dbAcad.query(
    `SELECT m.nombre, m.anio, m.cuatrimestre, m.es_electiva
     FROM carrera_materias cm
     JOIN materias m ON m.id = cm.materia_id
     WHERE cm.carrera_id = ?
     ORDER BY m.anio, m.cuatrimestre, m.nombre`,
    [cid],
    (err, rows) => {
      if (err) {
        console.log('Error en /carreras/:id/plan:', err);
        return res.status(500).json({ error: 'Error del servidor.' });
      }
      res.json(rows.map((r) => ({
        nombre: r.nombre,
        anio: Number(r.anio) || 0,
        cuatri: Number(r.cuatrimestre) || 0,
        electiva: r.es_electiva === 1 || r.es_electiva === true,
      })));
    }
  );
});

/* ============================================================
   Perfil: nombre, email y foto
   ============================================================ */

// PUT /usuarios/:id  { nombre?, email?, foto? }  (foto = "data:image/jpeg;base64,..." o null para quitarla)
app.put('/usuarios/:id', (req, res) => {
  const uid = Number(req.params.id);
  if (!Number.isInteger(uid) || uid <= 0) return res.status(400).json({ error: 'Usuario inválido.' });

  const { nombre, email, foto } = req.body;
  const campos = [];
  const valores = [];

  if (nombre !== undefined) {
    const n = String(nombre).trim();
    if (n.length < 2 || n.length > 100) return res.status(400).json({ error: 'El nombre no es válido.' });
    campos.push('nombre = ?');
    valores.push(n);
  }

  let emailNuevo = null;
  if (email !== undefined) {
    emailNuevo = String(email).trim().toLowerCase();
    if (emailNuevo.length > 150 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNuevo)) {
      return res.status(400).json({ error: 'El email no es válido.' });
    }
    campos.push('email = ?');
    valores.push(emailNuevo);
  }

  if (foto !== undefined) {
    if (foto !== null && (typeof foto !== 'string' || !foto.startsWith('data:image/') || foto.length > 1500000)) {
      return res.status(400).json({ error: 'La foto no es válida.' });
    }
    campos.push('foto = ?');
    valores.push(foto);
  }

  if (campos.length === 0) return res.status(400).json({ error: 'No hay nada para actualizar.' });

  const actualizar = () =>
    db.query(`UPDATE usuarios SET ${campos.join(', ')} WHERE id = ?`, [...valores, uid], (err) => {
      if (err) {
        console.log('Error al actualizar usuario:', err);
        return res.status(500).json({ error: 'No se pudo guardar.' });
      }
      db.query('SELECT id, nombre, email, rol, foto, dni FROM usuarios WHERE id = ?', [uid], (err2, rows) => {
        if (err2 || rows.length === 0) return res.status(500).json({ error: 'Error del servidor.' });
        res.json({ usuario: rows[0] });
      });
    });

  if (!emailNuevo) return actualizar();

  // el email no puede estar usado por otra cuenta
  db.query('SELECT id FROM usuarios WHERE email = ? AND id <> ?', [emailNuevo, uid], (err, rows) => {
    if (err) {
      console.log('Error al verificar email:', err);
      return res.status(500).json({ error: 'Error del servidor.' });
    }
    if (rows.length > 0) return res.status(409).json({ error: 'Ese email ya está registrado.' });
    actualizar();
  });
});

// PUT /usuarios/:id/dni  { dni }  -> solo se puede cargar UNA vez; después queda de solo lectura
app.put('/usuarios/:id/dni', (req, res) => {
  const uid = Number(req.params.id);
  if (!Number.isInteger(uid) || uid <= 0) return res.status(400).json({ error: 'Usuario inválido.' });

  const dni = limpiarDni(req.body.dni);
  if (!DNI_RE.test(dni)) {
    return res.status(400).json({ error: 'Ingresá tu DNI: 7 u 8 números, sin puntos.' });
  }

  db.query('UPDATE usuarios SET dni = ? WHERE id = ? AND dni IS NULL', [dni, uid], (err, r) => {
    if (err) {
      if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ese DNI ya está registrado.' });
      console.log('Error al guardar DNI:', err);
      return res.status(500).json({ error: 'No se pudo guardar.' });
    }
    if (r.affectedRows === 0) return res.status(409).json({ error: 'Esta cuenta ya tiene un DNI cargado.' });

    db.query('SELECT id, nombre, email, rol, foto, dni FROM usuarios WHERE id = ?', [uid], (err2, rows) => {
      if (err2 || rows.length === 0) return res.status(500).json({ error: 'Error del servidor.' });
      res.json({ usuario: rows[0] });
    });
  });
});

/* ============================================================
   Novedades y notificaciones
   ============================================================ */

const uidValido = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// GET /usuarios/:id/novedades -> las que le corresponden a este usuario, con { leida }
// Una novedad con comisión llega solo a los inscriptos en esa comisión.
// Una sin comisión llega a todos los que cursan la materia (o a todos, si no tiene materia).
// Una con destinatario_id (por ejemplo, el aviso de una nota) llega solo a esa persona.
app.get('/usuarios/:id/novedades', (req, res) => {
  const uid = uidValido(req.params.id);
  if (!uid) return res.status(400).json({ error: 'Usuario inválido.' });

  // Primero se crean los avisos de las notas que ya son visibles y todavía no tienen uno
  db.query(
    `INSERT IGNORE INTO novedades (titulo, texto, tipo, destinatario_id, ref, fecha)
     SELECT 'Nueva nota publicada',
            CONCAT('Ya podés ver tu nota de ', e.nombre, ' en Mis notas.'),
            'aviso', n.alumno_id, CONCAT('nota:', n.evaluacion_id), NOW()
     FROM notas n
     JOIN evaluaciones e ON e.id = n.evaluacion_id
     WHERE n.alumno_id = ?
       AND (e.estado = 'publicada' OR (e.estado = 'programada' AND e.publicar_en <= UTC_TIMESTAMP()))`,
    [uid],
    (errN) => {
      if (errN) console.log('Error al generar avisos de notas:', errN);

      // Después se devuelven las novedades del usuario, incluyendo las personales
      db.query(
        `SELECT n.id, n.titulo, n.texto, n.tipo, n.materia, n.fecha,
                (l.novedad_id IS NOT NULL) AS leida
         FROM novedades n
         LEFT JOIN novedades_leidas l ON l.novedad_id = n.id AND l.usuario_id = ?
         WHERE NOT EXISTS (SELECT 1 FROM novedades_ocultas o WHERE o.novedad_id = n.id AND o.usuario_id = ?)
           AND (n.destinatario_id IS NULL OR n.destinatario_id = ?)
           AND (
                n.materia IS NULL
             OR (n.comision IS NULL AND n.materia IN
                   (SELECT DISTINCT SUBSTRING_INDEX(clave, '|', 1) FROM inscripciones WHERE usuario_id = ?))
             OR (n.comision IS NOT NULL AND CONCAT(n.materia, '|', n.comision) IN
                   (SELECT clave FROM inscripciones WHERE usuario_id = ?))
           )
         ORDER BY n.fecha DESC, n.id DESC
         LIMIT 50`,
        [uid, uid, uid, uid, uid],
        (err, rows) => {
          if (err) {
            console.log('Error en novedades del usuario:', err);
            return res.status(500).json({ error: 'Error del servidor.' });
          }
          res.json(rows.map((r) => ({ ...r, leida: !!r.leida })));
        }
      );
    }
  );
});

// POST /usuarios/:id/novedades/leer  { ids: [1, 2] }
app.post('/usuarios/:id/novedades/leer', (req, res) => {
  const uid = uidValido(req.params.id);
  if (!uid) return res.status(400).json({ error: 'Usuario inválido.' });
  const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (ids.length === 0) return res.json({ ok: true });
  db.query(
    'INSERT IGNORE INTO novedades_leidas (usuario_id, novedad_id) SELECT ?, id FROM novedades WHERE id IN (?)',
    [uid, ids],
    (err) => {
      if (err) {
        console.log('Error al marcar leídas:', err);
        return res.status(500).json({ error: 'Error del servidor.' });
      }
      res.json({ ok: true });
    }
  );
});
// POST /usuarios/:id/novedades/ocultar  { ids: [1, 2] }  (las borra solo para este usuario)
app.post('/usuarios/:id/novedades/ocultar', (req, res) => {
  const uid = uidValido(req.params.id);
  if (!uid) return res.status(400).json({ error: 'Usuario inválido.' });
  const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (ids.length === 0) return res.json({ ok: true });
  db.query(
    'INSERT IGNORE INTO novedades_ocultas (usuario_id, novedad_id) SELECT ?, id FROM novedades WHERE id IN (?)',
    [uid, ids],
    (err) => {
      if (err) {
        console.log('Error al ocultar novedades:', err);
        return res.status(500).json({ error: 'Error del servidor.' });
      }
      res.json({ ok: true });
    }
  );
});
// GET /usuarios/:id/notificaciones -> { push: true|false }
app.get('/usuarios/:id/notificaciones', (req, res) => {
  const uid = uidValido(req.params.id);
  if (!uid) return res.status(400).json({ error: 'Usuario inválido.' });
  db.query('SELECT notif_push FROM usuarios WHERE id = ?', [uid], (err, rows) => {
    if (err) {
      console.log('Error al leer preferencia:', err);
      return res.status(500).json({ error: 'Error del servidor.' });
    }
    if (rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado.' });
    res.json({ push: rows[0].notif_push === 1 });
  });
});

// PUT /usuarios/:id/notificaciones  { push: true|false }
app.put('/usuarios/:id/notificaciones', (req, res) => {
  const uid = uidValido(req.params.id);
  if (!uid) return res.status(400).json({ error: 'Usuario inválido.' });
  db.query('UPDATE usuarios SET notif_push = ? WHERE id = ?', [req.body.push ? 1 : 0, uid], (err) => {
    if (err) {
      console.log('Error al guardar preferencia:', err);
      return res.status(500).json({ error: 'No se pudo guardar.' });
    }
    res.json({ ok: true });
  });
});

/* ============================================================
   Progreso de la carrera (planilla de materias)
   ============================================================ */

// GET /usuarios/:id/progreso -> { datos: { "Materia": { estado, nota? } } }
app.get('/usuarios/:id/progreso', (req, res) => {
  const uid = uidValido(req.params.id);
  if (!uid) return res.status(400).json({ error: 'Usuario inválido.' });
  db.query('SELECT materia, estado, nota FROM progreso_materias WHERE usuario_id = ?', [uid], (err, rows) => {
    if (err) {
      console.log('Error al leer progreso:', err);
      return res.status(500).json({ error: 'Error del servidor.' });
    }
    const datos = {};
    for (const r of rows) {
      datos[r.materia] = r.nota == null ? { estado: r.estado } : { estado: r.estado, nota: Number(r.nota) };
    }
    res.json({ datos });
  });
});

// PUT /usuarios/:id/progreso  { datos }  (reemplaza todo el progreso del usuario)
app.put('/usuarios/:id/progreso', (req, res) => {
  const uid = uidValido(req.params.id);
  if (!uid) return res.status(400).json({ error: 'Usuario inválido.' });
  const datos = req.body && req.body.datos && typeof req.body.datos === 'object' ? req.body.datos : {};
  const filas = [];
  for (const [materia, r] of Object.entries(datos)) {
    if (!materia || materia.length > 160 || !r) continue;
    if (r.estado !== 'cursando' && r.estado !== 'aprobada') continue;
    const n = Number(r.nota);
    const nota = r.estado === 'aprobada' && Number.isFinite(n) && n >= 1 && n <= 10 ? Math.round(n * 10) / 10 : null;
    filas.push([uid, materia, r.estado, nota]);
  }
  db.query('DELETE FROM progreso_materias WHERE usuario_id = ?', [uid], (err) => {
    if (err) {
      console.log('Error al limpiar progreso:', err);
      return res.status(500).json({ error: 'No se pudo guardar.' });
    }
    if (filas.length === 0) return res.json({ ok: true });
    db.query('INSERT INTO progreso_materias (usuario_id, materia, estado, nota) VALUES ?', [filas], (err2) => {
      if (err2) {
        console.log('Error al guardar progreso:', err2);
        return res.status(500).json({ error: 'No se pudo guardar.' });
      }
      res.json({ ok: true });
    });
  });
});

/* ============================================================
   Avisos de docentes a sus alumnos
   ============================================================ */

// Busca al docente detrás de una cuenta (rol profesor) en la base académica
async function docenteDe(uid) {
  const [u] = await db.promise().query('SELECT nombre, rol FROM usuarios WHERE id = ?', [uid]);
  if (!u.length || u[0].rol !== 'profesor') return null;
  const [c] = await db.promise().query('SELECT carrera_id FROM usuario_carreras WHERE usuario_id = ?', [uid]);
  const docente = await buscarDocente(u[0].nombre, c.map((r) => r.carrera_id));
  return docente ? { usuario: u[0], docente } : null;
}

// CAMBIO: cuatrimestre en curso (1 o 2), según el mes en Argentina.
// Agosto a diciembre = 2.º; enero a julio = 1.º (incluye el verano, que es el que viene).
function cuatriActual() {
  const mes = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Argentina/Buenos_Aires', month: 'numeric' }).format(new Date())
  );
  return mes >= 8 ? 2 : 1;
}

// CAMBIO: las comisiones que dicta ese docente en el cuatrimestre en curso.
// Una materia sin cuatrimestre cargado (o anual) se muestra siempre.
async function comisionesDe(profesorId) {
  const [rows] = await dbAcad.promise().query(
    `SELECT DISTINCT m.nombre AS materia, COALESCE(c.codigo, '') AS comision
     FROM comision_docentes cd
     JOIN comisiones c ON c.id = cd.comision_id
     JOIN materias m ON m.id = c.materia_id
     WHERE cd.profesor_id = ?
       AND (m.cuatrimestre IS NULL OR m.cuatrimestre NOT IN (1, 2) OR m.cuatrimestre = ?)
     ORDER BY m.nombre, comision`,
    [profesorId, cuatriActual()]
  );
  return rows;
}

// GET /docentes/:id/comisiones -> [{ materia, comision, alumnos }]
app.get('/docentes/:id/comisiones', async (req, res) => {
  const uid = uidValido(req.params.id);
  if (!uid) return res.status(400).json({ error: 'Usuario inválido.' });
  try {
    const d = await docenteDe(uid);
    if (!d) return res.status(403).json({ error: 'Tu cuenta no figura como docente.' });
    const comisiones = await comisionesDe(d.docente.id);
    const claves = comisiones.map((c) => `${c.materia}|${c.comision}`);
    let conteo = new Map();
    if (claves.length) {
      const [rows] = await db.promise().query(
        'SELECT clave, COUNT(DISTINCT usuario_id) AS n FROM inscripciones WHERE clave IN (?) GROUP BY clave',
        [claves]
      );
      conteo = new Map(rows.map((r) => [r.clave, Number(r.n)]));
    }
    res.json(comisiones.map((c) => ({ ...c, alumnos: conteo.get(`${c.materia}|${c.comision}`) || 0 })));
  } catch (e) {
    console.log('Error en /docentes/comisiones:', e);
    res.status(500).json({ error: 'Error del servidor.' });
  }
});

// GET /docentes/:id/comisiones/alumnos -> [{ materia, comision, alumnos: [{ id, nombre, desde }] }]
// Solo nombre y fecha de inscripción: sin DNI ni email.
app.get('/docentes/:id/comisiones/alumnos', async (req, res) => {
  const uid = uidValido(req.params.id);
  if (!uid) return res.status(400).json({ error: 'Usuario inválido.' });
  try {
    const d = await docenteDe(uid);
    if (!d) return res.status(403).json({ error: 'Tu cuenta no figura como docente.' });

    const comisiones = await comisionesDe(d.docente.id);
    const claves = comisiones.map((c) => `${c.materia}|${c.comision}`);
    const porClave = new Map();
    if (claves.length) {
      const [rows] = await db.promise().query(
        `SELECT i.clave, u.id, u.nombre, i.creada
         FROM inscripciones i
         JOIN usuarios u ON u.id = i.usuario_id
         WHERE i.clave IN (?) AND u.rol = 'estudiante'
         ORDER BY u.nombre`,
        [claves]
      );
      for (const r of rows) {
        if (!porClave.has(r.clave)) porClave.set(r.clave, []);
        porClave.get(r.clave).push({ id: r.id, nombre: r.nombre, desde: r.creada });
      }
    }
    res.json(comisiones.map((c) => ({ ...c, alumnos: porClave.get(`${c.materia}|${c.comision}`) || [] })));
  } catch (e) {
    console.log('Error en /docentes/comisiones/alumnos:', e);
    res.status(500).json({ error: 'Error del servidor.' });
  }
});

// POST /docentes/:id/avisos  { claves: ["Materia|comisión"], titulo, texto }
app.post('/docentes/:id/avisos', async (req, res) => {
  const uid = uidValido(req.params.id);
  if (!uid) return res.status(400).json({ error: 'Usuario inválido.' });

  const titulo = String(req.body.titulo ?? '').trim();
  const texto = String(req.body.texto ?? '').trim();
  const claves = [...new Set((Array.isArray(req.body.claves) ? req.body.claves : []).filter((c) => typeof c === 'string' && c.includes('|')))];

  if (!titulo || titulo.length > 60 || !texto || texto.length > 300) {
    return res.status(400).json({ error: 'El título o el mensaje no son válidos.' });
  }
  if (claves.length === 0 || claves.length > 50) {
    return res.status(400).json({ error: 'Elegí a quién va el aviso.' });
  }

  try {
    const d = await docenteDe(uid);
    if (!d) return res.status(403).json({ error: 'Tu cuenta no figura como docente.' });

    const propias = new Set((await comisionesDe(d.docente.id)).map((c) => `${c.materia}|${c.comision}`));
    if (!claves.every((c) => propias.has(c))) {
      return res.status(403).json({ error: 'Solo podés avisar a las comisiones que dictás.' });
    }

    const ahora = new Date();
    const filas = claves.map((c) => {
      const i = c.indexOf('|');
      return [titulo, texto, 'aviso', c.slice(0, i), c.slice(i + 1), uid, ahora];
    });
    await db.promise().query(
      'INSERT INTO novedades (titulo, texto, tipo, materia, comision, autor_id, fecha) VALUES ?',
      [filas]
    );
    res.json({ ok: true, enviados: filas.length });
  } catch (e) {
    console.log('Error al enviar aviso:', e);
    res.status(500).json({ error: 'No se pudo enviar el aviso.' });
  }
});

/* ============================================================
   Evaluaciones y notas (carga manual del docente)
   ============================================================ */

const ESTADOS = ['borrador', 'programada', 'publicada'];

// Fecha UTC 'YYYY-MM-DD HH:MM:SS', o null si es inválida
const fechaUtc = (v) => {
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString().slice(0, 19).replace('T', ' ');
};

const errSrv = (res, e) => {
  console.log(e);
  res.status(500).json({ error: 'Error del servidor.' });
};

// El docente existe, es profesor y dicta en esa carrera
const docenteDeCarrera = (docenteId, carreraId, cb) =>
  db.query(
    `SELECT u.id FROM usuarios u
     JOIN usuario_carreras uc ON uc.usuario_id = u.id
     WHERE u.id = ? AND u.rol = 'profesor' AND uc.carrera_id = ?`,
    [docenteId, carreraId],
    (err, rows) => cb(err, !err && rows.length > 0)
  );

// La evaluación existe y es de ese docente
const evaluacionDe = (evalId, docenteId, cb) =>
  db.query('SELECT * FROM evaluaciones WHERE id = ? AND docente_id = ?', [evalId, docenteId],
    (err, rows) => cb(err, rows && rows[0]));

// POST /evaluaciones { docente_id, carrera_id, nombre, estado, publicar_en }
app.post('/evaluaciones', (req, res) => {
  const docenteId = uidValido(req.body.docente_id);
  const carreraId = uidValido(req.body.carrera_id);
  const nombre = String(req.body.nombre ?? '').trim();
  const estado = req.body.estado || 'borrador';
  if (!docenteId || !carreraId) return res.status(400).json({ error: 'Datos inválidos.' });
  if (!nombre || nombre.length > 120) return res.status(400).json({ error: 'Poné un nombre de hasta 120 caracteres.' });
  if (!ESTADOS.includes(estado)) return res.status(400).json({ error: 'Estado inválido.' });

  let publicarEn = null;
  if (estado === 'programada') {
    publicarEn = fechaUtc(req.body.publicar_en);
    if (!publicarEn) return res.status(400).json({ error: 'Indicá la fecha de publicación.' });
  }

  docenteDeCarrera(docenteId, carreraId, (err, ok) => {
    if (err) return errSrv(res, err);
    if (!ok) return res.status(403).json({ error: 'No dictás en esa carrera.' });
    db.query(
      'INSERT INTO evaluaciones (carrera_id, docente_id, nombre, estado, publicar_en) VALUES (?, ?, ?, ?, ?)',
      [carreraId, docenteId, nombre, estado, publicarEn],
      (err2, r) => (err2 ? errSrv(res, err2) : res.json({ id: r.insertId }))
    );
  });
});

// GET /evaluaciones?docente_id=  -> evaluaciones del docente
app.get('/evaluaciones', (req, res) => {
  const docenteId = uidValido(req.query.docente_id);
  if (!docenteId) return res.status(400).json({ error: 'Usuario inválido.' });
  db.query(
    `SELECT e.id, e.nombre, e.estado, e.publicar_en, e.carrera_id,
            (SELECT COUNT(*) FROM notas n WHERE n.evaluacion_id = e.id) AS cargadas
     FROM evaluaciones e WHERE e.docente_id = ? ORDER BY e.creada_en DESC`,
    [docenteId],
    (err, rows) => (err ? errSrv(res, err) : res.json({ evaluaciones: rows }))
  );
});

// PUT /evaluaciones/:id { docente_id, nombre?, estado?, publicar_en? }
app.put('/evaluaciones/:id', (req, res) => {
  const evalId = uidValido(req.params.id);
  const docenteId = uidValido(req.body.docente_id);
  if (!evalId || !docenteId) return res.status(400).json({ error: 'Datos inválidos.' });

  evaluacionDe(evalId, docenteId, (err, ev) => {
    if (err) return errSrv(res, err);
    if (!ev) return res.status(404).json({ error: 'Evaluación no encontrada.' });

    const nombre = req.body.nombre !== undefined ? String(req.body.nombre).trim() : ev.nombre;
    const estado = req.body.estado ?? ev.estado;
    if (!nombre || nombre.length > 120) return res.status(400).json({ error: 'Nombre inválido.' });
    if (!ESTADOS.includes(estado)) return res.status(400).json({ error: 'Estado inválido.' });

    let publicarEn = null;
    if (estado === 'programada') {
      publicarEn = fechaUtc(req.body.publicar_en ?? ev.publicar_en);
      if (!publicarEn) return res.status(400).json({ error: 'Indicá la fecha de publicación.' });
    }
    db.query(
      'UPDATE evaluaciones SET nombre = ?, estado = ?, publicar_en = ? WHERE id = ?',
      [nombre, estado, publicarEn, evalId],
      (err2) => (err2 ? errSrv(res, err2) : res.json({ ok: true }))
    );
  });
});

// DELETE /evaluaciones/:id?docente_id=
app.delete('/evaluaciones/:id', (req, res) => {
  const evalId = uidValido(req.params.id);
  const docenteId = uidValido(req.query.docente_id);
  if (!evalId || !docenteId) return res.status(400).json({ error: 'Datos inválidos.' });
  db.query('DELETE FROM evaluaciones WHERE id = ? AND docente_id = ?', [evalId, docenteId],
    (err, r) => {
      if (err) return errSrv(res, err);
      if (r.affectedRows === 0) return res.status(404).json({ error: 'Evaluación no encontrada.' });
      res.json({ ok: true });
    });
});

// GET /evaluaciones/:id/alumnos?docente_id=&q=  -> alumnos de la carrera con su nota (si ya tiene). Sin DNI.
app.get('/evaluaciones/:id/alumnos', (req, res) => {
  const evalId = uidValido(req.params.id);
  const docenteId = uidValido(req.query.docente_id);
  if (!evalId || !docenteId) return res.status(400).json({ error: 'Datos inválidos.' });
  const q = String(req.query.q ?? '').trim().slice(0, 60);

  evaluacionDe(evalId, docenteId, (err, ev) => {
    if (err) return errSrv(res, err);
    if (!ev) return res.status(404).json({ error: 'Evaluación no encontrada.' });
    db.query(
      `SELECT u.id, u.nombre, n.valor AS nota
       FROM usuarios u
       JOIN usuario_carreras uc ON uc.usuario_id = u.id AND uc.carrera_id = ?
       LEFT JOIN notas n ON n.alumno_id = u.id AND n.evaluacion_id = ?
       WHERE u.rol = 'estudiante' AND u.nombre LIKE ?
       ORDER BY u.nombre LIMIT 50`,
      [ev.carrera_id, evalId, `%${q.replace(/[%_]/g, '')}%`],
      (err2, rows) => (err2 ? errSrv(res, err2) : res.json({ alumnos: rows }))
    );
  });
});

// PUT /evaluaciones/:id/notas/:alumnoId { docente_id, valor }  -> crea o actualiza. Valor vacío = borra la nota.
app.put('/evaluaciones/:id/notas/:alumnoId', (req, res) => {
  const evalId = uidValido(req.params.id);
  const alumnoId = uidValido(req.params.alumnoId);
  const docenteId = uidValido(req.body.docente_id);
  const valor = String(req.body.valor ?? '').trim();
  if (!evalId || !alumnoId || !docenteId) return res.status(400).json({ error: 'Datos inválidos.' });
  if (valor.length > 40) return res.status(400).json({ error: 'La nota es demasiado larga (máx. 40).' });

  evaluacionDe(evalId, docenteId, (err, ev) => {
    if (err) return errSrv(res, err);
    if (!ev) return res.status(404).json({ error: 'Evaluación no encontrada.' });

    if (!valor) {
      return db.query('DELETE FROM notas WHERE evaluacion_id = ? AND alumno_id = ?', [evalId, alumnoId],
        (e2) => (e2 ? errSrv(res, e2) : res.json({ ok: true, nota: null })));
    }
    // El alumno tiene que cursar la carrera de la evaluación
    db.query(
      `SELECT u.id FROM usuarios u
       JOIN usuario_carreras uc ON uc.usuario_id = u.id AND uc.carrera_id = ?
       WHERE u.id = ? AND u.rol = 'estudiante'`,
      [ev.carrera_id, alumnoId],
      (e3, rows) => {
        if (e3) return errSrv(res, e3);
        if (rows.length === 0) return res.status(404).json({ error: 'Alumno no encontrado en esta carrera.' });
        db.query(
          `INSERT INTO notas (evaluacion_id, alumno_id, valor) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE valor = VALUES(valor)`,
          [evalId, alumnoId, valor],
          (e4) => (e4 ? errSrv(res, e4) : res.json({ ok: true, nota: valor }))
        );
      }
    );
  });
});

// GET /alumnos/:id/notas  -> solo las notas visibles (publicadas, o programadas cuya hora ya pasó)
app.get('/alumnos/:id/notas', (req, res) => {
  const uid = uidValido(req.params.id);
  if (!uid) return res.status(400).json({ error: 'Usuario inválido.' });
  db.query(
    `SELECT e.id AS evaluacion_id, e.nombre AS evaluacion, c.nombre AS carrera, n.valor AS nota
     FROM notas n
     JOIN evaluaciones e ON e.id = n.evaluacion_id
     JOIN carreras c ON c.id = e.carrera_id
     WHERE n.alumno_id = ?
       AND (e.estado = 'publicada' OR (e.estado = 'programada' AND e.publicar_en <= UTC_TIMESTAMP()))
     ORDER BY e.creada_en DESC`,
    [uid],
    (err, rows) => (err ? errSrv(res, err) : res.json({ notas: rows }))
  );
});

app.listen(process.env.PORT || 3000, () =>
  console.log('Servidor corriendo en el puerto', process.env.PORT || 3000)
);