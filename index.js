const express = require('express');
const mysql = require('mysql2');
require('dotenv').config();

const app = express();
app.use(require('cors')());
app.use(express.json());

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

app.post('/register', (req, res) => {
  const { nombre, email, contrasena } = req.body;

  if (!nombre || !email || !contrasena) {
    return res.status(400).json({ error: 'Faltan datos.' });
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
      [nombre, email, contrasena, 'estudiante'],
      (err2) => {
        if (err2) {
          console.log('Error al registrar:', err2);
          return res.status(500).json({ error: 'No se pudo registrar.' });
        }
        res.json({ ok: true });
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
/*Inscripciones: las materias que cursa cada usuario*/
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
app.listen(process.env.PORT || 3000, () =>
  console.log('Servidor corriendo en el puerto', process.env.PORT || 3000)
);