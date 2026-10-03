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