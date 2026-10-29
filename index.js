const express = require('express');
const mysql = require('mysql2');
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

   const [mc] = await dbAcad.promise().query('SELECT DISTINCT m.nombre AS materia FROM carrera_materias cm JOIN materias m ON m.id = cm.materia_id WHERE cm.carrera_id IN (?)', [ids]);
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
   Registro y login
   ============================================================ */

app.post('/register', async (req, res) => {
  const { nombre, email, contrasena, carreras, rol } = req.body;

  if (!nombre || !email || !contrasena) {
    return res.status(400).json({ error: 'Faltan datos.' });
  }

  const esProfesor = rol === 'profesor';

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

  db.query('SELECT id FROM usuarios WHERE email = ?', [email], (err, results) => {
    if (err) {
      console.log('Error al verificar email:', err);
      return res.status(500).json({ error: 'Error del servidor.' });
    }
    if (results.length > 0) {
      return res.status(409).json({ error: 'Ese email ya está registrado.' });
    }

    db.query(
      'INSERT INTO usuarios (nombre, email, contraseña, rol) VALUES (?, ?, ?, ?)',
      [nombre, email, contrasena, esProfesor ? 'profesor' : 'estudiante'],
      (err2, result) => {
        if (err2) {
          console.log('Error al registrar:', err2);
          return res.status(500).json({ error: 'No se pudo registrar.' });
        }
        guardarCarreras(result.insertId, carreras, (err3) => {
          if (err3) console.log('Error al guardar carreras:', err3);
          res.json({ ok: true });
        });
      }
    );
  });
});

app.post('/login', (req, res) => {
  const { email, contrasena } = req.body;

  if (!email || !contrasena) {
    return res.status(400).json({ error: 'Faltan datos.' });
  }

  db.query(
    'SELECT id, nombre, email, rol, foto FROM usuarios WHERE email = ? AND contraseña = ?',
    [email, contrasena],
    (err, results) => {
      if (err) {
        console.log('Error en login:', err);
        return res.status(500).json({ error: 'Error del servidor.' });
      }
      if (results.length === 0) {
        return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
      }
      res.json({ usuario: results[0] });
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
   dbAcad.query(`SELECT DISTINCT m.nombre AS materia, cm.carrera_id FROM carrera_materias cm JOIN materias m ON m.id = cm.materia_id`, (err, rows) => {
    if (err) {
      console.log('Error en /materias/carreras:', err);
      return res.status(500).json({ error: 'Error del servidor.' });
    }
    res.json(rows);
  });
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
      db.query('SELECT id, nombre, email, rol, foto FROM usuarios WHERE id = ?', [uid], (err2, rows) => {
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

/* ============================================================
   Novedades y notificaciones
   ============================================================ */

const uidValido = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// GET /usuarios/:id/novedades -> las que le corresponden a este usuario, con { leida }
app.get('/usuarios/:id/novedades', (req, res) => {
  const uid = uidValido(req.params.id);
  if (!uid) return res.status(400).json({ error: 'Usuario inválido.' });
  db.query(
    `SELECT n.id, n.titulo, n.texto, n.tipo, n.materia, n.fecha,
            (l.novedad_id IS NOT NULL) AS leida
     FROM novedades n
     LEFT JOIN novedades_leidas l ON l.novedad_id = n.id AND l.usuario_id = ?
     WHERE n.materia IS NULL
        OR n.materia IN (SELECT DISTINCT SUBSTRING_INDEX(clave, '|', 1) FROM inscripciones WHERE usuario_id = ?)
     ORDER BY n.fecha DESC, n.id DESC
     LIMIT 50`,
    [uid, uid],
    (err, rows) => {
      if (err) {
        console.log('Error en novedades del usuario:', err);
        return res.status(500).json({ error: 'Error del servidor.' });
      }
      res.json(rows.map((r) => ({ ...r, leida: !!r.leida })));
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

app.listen(process.env.PORT || 3000, () =>
  console.log('Servidor corriendo en el puerto', process.env.PORT || 3000)
);