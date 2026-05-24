const express = require('express');
const app = express();
const PORT = 50070; // Der Port im Container

app.use(express.json());

app.get('/', (req, res) => {
    res.send(`
        <style>
            body { font-family: Arial, sans-serif; background: #f4f6f9; padding: 40px; text-align: center; }
            .card { background: white; padding: 30px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); display: inline-block; }
            h1 { color: #2c3e50; }
            .status { color: #27ae60; font-weight: bold; }
        </style>
        <div class="card">
            <h1>JustChat Admin Dashboard</h1>
            <p>Status: <span class="status">Online und einsatzbereit 🚀</span></p>
            <small>Dieses Image läuft direkt aus GitHub!</small>
        </div>
    `);
});

// Wichtig: Auf 0.0.0.0 hören, damit Docker Verbindungen von außen erlaubt
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server läuft auf Port ${PORT}`);
});