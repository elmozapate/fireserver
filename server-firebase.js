// server-firebase.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const admin = require('firebase-admin');

admin.initializeApp({
    credential: admin.credential.cert({
        type: process.env.FIREBASE_TYPE,
        project_id: process.env.FIREBASE_PROJECT_ID,
        private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
        private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/\n/g, '\n'),
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        client_id: process.env.FIREBASE_CLIENT_ID,
        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
        token_uri: 'https://oauth2.googleapis.com/token',
        client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
    }),
});

const db = admin.firestore();
const COLLECTION = process.env.FIREBASE_COLLECTION || 'storage';

const app = express();
const PORT = process.env.PORT || 3090;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ─── Git / GitHub config ──────────────────────────────────────────────────

const DEFAULT_BRANCH = process.env.DEFAULT_BRANCH || 'main';
const GITHUB_USER    = process.env.GITHUB_USER;
const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
const REPO_NAME      = process.env.REPO_NAME || 'writter';
const API_KEY        = process.env.API_KEY || '';

// ─── Firebase helpers ─────────────────────────────────────────────────────

function safeKey(key) {
    return key.replace(/[^a-zA-Z0-9_\-]/g, '_');
}

function docRef(key) {
    return db.collection(COLLECTION).doc(safeKey(key));
}

function pack(value) {
    return { __json: JSON.stringify(value) };
}

function unpack(data) {
    if (data.__json !== undefined) return JSON.parse(data.__json);
    const { __w, __v, ...rest } = data;
    if (__w === true) return __v;
    return rest;
}

// ─── POST /set ───────────────────────────────────────────────────────────

app.post('/set', async (req, res) => {
    try {
        const { key, value } = req.body;
        if (!key) return res.status(400).json({ ok: false, error: 'Key requerida' });

        await docRef(key).set(pack(value));
        res.json({ ok: true, key });

    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── GET /get/:key ───────────────────────────────────────────────────────

app.get('/get/:key', async (req, res) => {
    try {
        const snap = await docRef(req.params.key).get();
        if (!snap.exists) return res.status(404).json({ ok: false, error: 'No existe' });

        res.json({ ok: true, key: req.params.key, value: unpack(snap.data()) });

    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── DELETE /delete/:key ─────────────────────────────────────────────────

app.delete('/delete/:key', async (req, res) => {
    try {
        const ref = docRef(req.params.key);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ ok: false, error: 'No existe' });

        await ref.delete();
        res.json({ ok: true, deleted: req.params.key });

    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── GET /keys ───────────────────────────────────────────────────────────

app.get('/keys', async (req, res) => {
    try {
        let query = db.collection(COLLECTION);

        if (req.query.prefix) {
            const p = safeKey(req.query.prefix);
            const end = p.slice(0, -1) + String.fromCharCode(p.charCodeAt(p.length - 1) + 1);
            query = query
                .where(admin.firestore.FieldPath.documentId(), '>=', p)
                .where(admin.firestore.FieldPath.documentId(), '<', end);
        }

        const snap = await query.select().get();
        res.json({ ok: true, keys: snap.docs.map(d => d.id) });

    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── GET /all ────────────────────────────────────────────────────────────

app.get('/all', async (req, res) => {
    try {
        const snap = await db.collection(COLLECTION).get();
        const items = {};
        snap.docs.forEach(d => { items[d.id] = unpack(d.data()); });
        res.json({ ok: true, items });

    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── POST /fetch ─────────────────────────────────────────────────────────

app.post('/fetch', async (req, res) => {
    try {
        const { url, options } = req.body;
        if (!url) return res.status(400).json({ ok: false, error: 'URL requerida' });

        const response = await fetch(url, options || {});
        const text = await response.text();
        res.json({ ok: true, status: response.status, data: text });

    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── Template helper ─────────────────────────────────────────────────────

function createArticleTemplate(name) {
  return `<!DOCTYPE html>
<html lang="es" data-lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${name}</title>
  <link rel="stylesheet" href="arqueostyles.css" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&family=Spectral:ital,wght@0,300;0,400;1,300&family=DM+Mono:wght@300;400&display=swap" rel="stylesheet" />
  <script>window.SA_KEY = "${name}";</script>
  <script src="content.js"></script>
</head>
<body>
  <div id="loader">
    <div class="loader-inner">
      <div class="loader-glyph">⊕</div>
      <div class="loader-text" id="loader-text">Cargando…</div>
    </div>
  </div>
  <div id="cursor"></div>
  <div id="cursor-trail"></div>
  <script src="arqueomain.js"></script>
  <script src="screenSmart.js"></script>
  <script src="mosueclick.js"></script>
  <script src="narradorJS.js"></script>
  <script src="pdf-exporter.js"></script>
</body>
</html>`;
}

// ─── POST /create-template ───────────────────────────────────────────────

app.post('/create-template', async (req, res) => {
  const apiKey = req.header('x-api-key') || req.body?.apiKey;
  if (!apiKey || apiKey !== API_KEY) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  let { name, branch } = req.body;
  if (!name) return res.status(400).json({ ok: false, error: 'name is required' });

  branch = branch || DEFAULT_BRANCH;
  name = String(name).trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
  if (!name) return res.status(400).json({ ok: false, error: 'invalid name' });

  const filePath = `public/dabeiba/${name}.html`;
  const apiUrl   = `https://api.github.com/repos/${GITHUB_USER}/${REPO_NAME}/contents/${filePath}`;
  const headers  = {
    Authorization: `token ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };

  try {
    // 1) verificar si ya existe
    const checkRes = await fetch(`${apiUrl}?ref=${branch}`, { headers });

    if (checkRes.status === 200) {
      return res.status(409).json({ ok: false, error: 'template already exists' });
    }
    if (checkRes.status !== 404) {
      const err = await checkRes.json();
      return res.status(500).json({ ok: false, error: err.message });
    }

    // 2) crear directo en GitHub — sin tocar disco
    const html    = createArticleTemplate(name);
    const content = Buffer.from(html).toString('base64');

    const createRes = await fetch(apiUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `Create template ${name}`,
        content,
        branch,
      }),
    });

    if (!createRes.ok) {
      const err = await createRes.json();
      return res.status(500).json({ ok: false, error: err.message });
    }

    const data = await createRes.json();

    return res.status(200).json({
      ok: true,
      changed: true,
      name,
      path: filePath,
      url: `/${name}.html`,
      branch,
      sha:    data.content?.sha,
      commit: data.commit?.sha,
    });

  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// ─── Arranque ────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`✓ Servidor en http://localhost:${PORT}`);
    console.log(`✓ Firestore colección: "${COLLECTION}"`);
});