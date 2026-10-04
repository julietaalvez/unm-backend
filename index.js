const express = require('express');
const mysql = require('mysql2');
require('dotenv').config();

const app = express();
app.use(require('cors')());
app.use(express.json());

const db = mysql.createConnection(process.env.MYSQL_PUBLIC_URL);

db.connect(err => {
  if (err) {
    console.error('Error al conectar a la base:', err);
  } else {
    console.log('Conectado a MySQL en Railway ✅');
  }
});

app.get('/espacios', (req, res) => {
  db.query('SELECT * FROM espacios', (err, results) => {
    if (err) return res.status(500).json(err);
    res.json(results);
  });
});

app.listen(3000, () => console.log('Servidor corriendo en el puerto 3000'));

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