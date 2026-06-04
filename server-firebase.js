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

// ─── helpers ─────────────────────────────────

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

// ─── POST /set ───────────────────────────────

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

// ─── GET /get/:key ───────────────────────────

app.get('/get/:key', async (req, res) => {
    try {
        const snap = await docRef(req.params.key).get();
        if (!snap.exists) return res.status(404).json({ ok: false, error: 'No existe' });

        res.json({ ok: true, key: req.params.key, value: unpack(snap.data()) });

    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── DELETE /delete/:key ─────────────────────

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

// ─── GET /keys ───────────────────────────────

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

// ─── GET /all ────────────────────────────────

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

// ─── POST /fetch ─────────────────────────────

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

// ─────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`✓ Servidor en http://localhost:${PORT}`);
    console.log(`✓ Firestore colección: "${COLLECTION}"`);
});