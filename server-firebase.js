// server-firebase.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const admin = require('firebase-admin');
const path = require('path');
const fs   = require('fs');

const PUBLIC_DIR = path.join(__dirname, 'public');


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
const CONFIG_KEY = 'my_prefs';

const app = express();
const PORT = process.env.PORT || 3090;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ─── GitHub config ────────────────────────────────────────────────────────

const DEFAULT_BRANCH = process.env.DEFAULT_BRANCH || 'main';
const GITHUB_USER = process.env.GITHUB_USER;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_NAME = process.env.REPO_NAME || 'writter';
const API_KEY = process.env.API_KEY || '';

// ─── Socket notifier ──────────────────────────────────────────────────────

const SOCKET_SERVER = process.env.SOCKET_SERVER_URL || 'http://localhost:3000';
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || 'internal_dev_secret';

/**
 * Fire-and-forget — nunca bloquea ni lanza excepciones al caller.
 * room:   'public' | 'authenticated' | cualquier room custom
 * entity: opcional, para emitEntityUpdated en el otro server
 */
function notifySocket({ entity, room, event, data, meta } = {}) {
    fetch(`${SOCKET_SERVER}/internal/update`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-internal-secret': INTERNAL_SECRET,
        },
        body: JSON.stringify({ entity, room, event, data, meta }),
    }).catch(err => console.warn('[socket-notify] fallo silencioso:', err.message));
}

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

// ─── GitHub helper ────────────────────────────────────────────────────────

async function githubPut({ filePath, content, branch, message }) {
    const apiUrl = `https://api.github.com/repos/${GITHUB_USER}/${REPO_NAME}/contents/${filePath}`;
    const headers = {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
    };

    let sha;
    const checkRes = await fetch(`${apiUrl}?ref=${branch}`, { headers });
    if (checkRes.status === 200) {
        const existing = await checkRes.json();
        sha = existing.sha;
    } else if (checkRes.status !== 404) {
        const err = await checkRes.json();
        throw new Error(err.message);
    }

    const base64 = Buffer.isBuffer(content)
        ? content.toString('base64')
        : Buffer.from(content).toString('base64');

    const res = await fetch(apiUrl, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
            message: message || `Upload ${filePath}`,
            content: base64,
            branch,
            ...(sha && { sha }),
        }),
    });

    if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message);
    }

    return res.json();
}

function ensureAuth(req, res, next) {
    if (!API_KEY) return next();
    const apiKey = req.header('x-api-key') || req.body?.apiKey;
    if (apiKey !== API_KEY) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    next();
}

// ════════════════════════════════════════════════════════
// LIBRARY
// ════════════════════════════════════════════════════════

const LIBRARY_KEY = 'library_index';

const TYPE_TO_LIST = {
    page: 'pages',
    file: 'files',
    asset: 'assets',
    service: 'services',
    template: 'templates',
    json: 'jsons',
};

async function getLibrary() {
    const snap = await docRef(LIBRARY_KEY).get();
    if (!snap.exists) {
        return {
            id: LIBRARY_KEY,
            pages: [],
            files: [],
            assets: [],
            services: [],
            templates: [],
            jsons: [],
            meta: {
                totalPages: 0, totalFiles: 0, totalAssets: 0,
                totalServices: 0, totalTemplates: 0, totalJsons: 0,
                updatedAt: Date.now(),
            },
        };
    }
    return unpack(snap.data());
}

async function getLibraryWithObjects() {
    const [library, snap] = await Promise.all([
        getLibrary(),
        db.collection(COLLECTION).get(),
    ]);

    const objects = {};
    snap.docs.forEach(d => {
        if (d.id !== LIBRARY_KEY) objects[d.id] = unpack(d.data());
    });

    return { ...library, objects };
}

async function saveLibrary(library) {
    library.meta = {
        totalPages: (library.pages || []).length,
        totalFiles: (library.files || []).length,
        totalAssets: (library.assets || []).length,
        totalServices: (library.services || []).length,
        totalTemplates: (library.templates || []).length,
        totalJsons: (library.jsons || []).length,
        updatedAt: Date.now(),
    };
    await docRef(LIBRARY_KEY).set(pack(library));

    // Notifica a usuarios autenticados que la library cambió
    notifySocket({
        room: 'authenticated',
        event: 'library:updated',
        data: { meta: library.meta },
    });

    return library;
}

function buildLibraryEntry(key, value, extra = {}) {
    const now = Date.now();
    const existing = typeof value === 'object' && value !== null ? value : {};

    return {
        id: existing.id || safeKey(key),
        type: existing.type || extra.type,
        title: existing.title || existing.name || extra.title || key,
        name: existing.name || existing.title || extra.name || key,
        slug: existing.slug || extra.slug || null,
        path: existing.path || extra.path || null,
        branch: existing.branch || extra.branch || DEFAULT_BRANCH,
        sha: existing.sha || extra.sha || null,
        status: existing.status || extra.status || 'active',
        tags: existing.tags || extra.tags || [],
        createdAt: existing.createdAt || extra.createdAt || now,
        updatedAt: now,
    };
}

async function syncToLibrary(key, value, extra = {}) {
    const type = (typeof value === 'object' && value?.type) || extra.type;
    const listName = TYPE_TO_LIST[type];
    if (!listName) return;

    const library = await getLibrary();
    if (!library[listName]) library[listName] = [];

    const entry = buildLibraryEntry(key, value, extra);
    const idx = library[listName].findIndex(e => e.id === entry.id);

    if (idx >= 0) {
        // Preserva createdAt original
        entry.createdAt = library[listName][idx].createdAt;
        library[listName][idx] = entry;
    } else {
        // Nueva entrada: se inserta completa tal como viene
        library[listName].push(entry);
    }

    await saveLibrary(library);
    return entry;
}

async function removeFromLibrary(key) {
    const id = safeKey(key);
    const library = await getLibrary();
    let changed = false;

    for (const listName of Object.values(TYPE_TO_LIST)) {
        if (!library[listName]) continue;
        const before = library[listName].length;
        library[listName] = library[listName].filter(e => e.id !== id);
        if (library[listName].length !== before) changed = true;
    }

    if (changed) await saveLibrary(library);
    return changed;
}

// ─── GET /health ──────────────────────────────────────────────────────────

app.get('/health', async (req, res) => {
    try {
        res.json({
            ok: true,
            service: 'fireserver',
            status: 'healthy',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            memory: process.memoryUsage().rss,
        });
    } catch (err) {
        res.status(500).json({ ok: false, status: 'unhealthy', error: err.message });
    }
});

// ─── POST /set ───────────────────────────────────────────────────────────
const PATCH_SCHEMAS = {

    pages: {
        admin: [
            'title',
            'status'
        ],
        config: [
            'title',
        ],

        systemload: [
            'type',
            'relativePath',
            'absolutePath',
            'directory',
            'size',
            'content',
            'fs'
        ]
    },

    files: {
        admin: [
            'title',
            'status'],
        config: [
            'title'
        ],

        systemload: [
            'type',
            'relativePath',
            'absolutePath',
            'directory',
            'size',
            'content',
            'fs'
        ]
    },

    assets: {
        admin: [
            'title',
            'status'],
        config: [
            'title'],

        systemload: [
            'type',
            'relativePath',
            'absolutePath',
            'directory',
            'size',
            'content',
            'fs'
        ]
    },

    services: {
        admin: [
            'title',
            'status'],
        config: [
            'title'
        ],

        systemload: [
            'type',
            'config',
            'logs',
            'pid',
            'port',
            'running'
        ]
    },

    meta: {
        config: [],

        systemload: [
            'publicDir',
            'scannedAt',
            'totalPages',
            'totalFiles',
            'totalAssets',
            'totalServices'
        ]
    }

};

function resolveSchema(doc) {

    switch (doc.type) {

        case 'page':
            return 'pages';

        case 'file':
            return 'files';

        case 'asset':
            return 'assets';

        case 'service':
            return 'services';

        default:
            return 'meta';
    }
}
function buildPatchedObject(
    original,
    incoming,
    schema = 'config'
) {

    const schemaName =
        resolveSchema(original || incoming);

    const allowedFields =
        PATCH_SCHEMAS[schemaName]?.[schema] || [];

    const result = { ...original };

    for (const field of allowedFields) {
        if (field in incoming) {
            result[field] = incoming[field];
        }
    }

    result.updatedAt = Date.now();

    return result;
}

async function PatchedResponse(req, res, mode = false
) {
    try {

        const {
            key,
            value,
            schema = 'admin'
        } = req.body;
        if (!key) {
            return res.status(400).json({
                ok: false,
                error: 'Key requerida'
            });
        }

        const ref = docRef(key);

        const currentSnap = await ref.get();
        let finalValue = value;

        if (!currentSnap.exists) {

            if (schema !== 'systemload') {
                return res.status(404).json({
                    ok: false,
                    error: 'Documento no existe'
                });
            }
            if (
                req.headers['x-system-load'] !== 'true' ||
                req.headers['x-api-key'] !== API_KEY
            ) {
                return res.status(403).json({
                    ok: false,
                    error: 'Forbidden'
                });
            }

            finalValue = {
                ...value,
                id: value.id || Date.now(),
                createdAt: Date.now(),
                updatedAt: Date.now()
            };
        }

        if (currentSnap.exists) {
            const original = unpack(currentSnap.data());
            finalValue = buildPatchedObject(
                original,
                value,
                !!mode ? 'config' : schema
            );
        }

        await ref.set(pack(finalValue));

        const entry =
            key !== LIBRARY_KEY
                ? await syncToLibrary(key, finalValue)
                : null;

        res.json({
            ok: true,
            key,
            libraryUpdated: !!entry
        });

    } catch (err) {
        res.status(500).json({
            ok: false,
            error: err.message
        });
    }
}


app.post('/set', async (req, res) => {
    try {
        const { key, value } = req.body;
        if (!key) return res.status(400).json({ ok: false, error: 'Key requerida' });
        if (key === 'llibrary_index') {
            return await PatchedResponse(req, res, true)
        }
        await docRef(key).set(pack(value));
        const entry = key !== LIBRARY_KEY ? await syncToLibrary(key, value) : null;

        res.json({ ok: true, key, libraryUpdated: !!entry });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

app.patch('/set', async (req, res) => {
    await PatchedResponse(req, res)
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
        const removed = await removeFromLibrary(req.params.key);

        res.json({ ok: true, deleted: req.params.key, libraryUpdated: removed });
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

// ─── Template helper ──────────────────────────────────────────────────────

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

app.post('/create-template', ensureAuth, async (req, res) => {
    let { name, branch } = req.body;
    if (!name) return res.status(400).json({ ok: false, error: 'name is required' });

    branch = branch || DEFAULT_BRANCH;
    name = String(name).trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
    if (!name) return res.status(400).json({ ok: false, error: 'invalid name' });

    const filePath = `public/dabeiba/${name}.html`;
    const apiUrl = `https://api.github.com/repos/${GITHUB_USER}/${REPO_NAME}/contents/${filePath}`;
    const headers = {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
    };

    try {
        const checkRes = await fetch(`${apiUrl}?ref=${branch}`, { headers });
        if (checkRes.status === 200)
            return res.status(409).json({ ok: false, error: 'template already exists' });
        if (checkRes.status !== 404) {
            const err = await checkRes.json();
            return res.status(500).json({ ok: false, error: err.message });
        }

        const html = createArticleTemplate(name);
        const content = Buffer.from(html).toString('base64');

        const createRes = await fetch(apiUrl, {
            method: 'PUT',
            headers,
            body: JSON.stringify({ message: `Create template ${name}`, content, branch }),
        });

        if (!createRes.ok) {
            const err = await createRes.json();
            return res.status(500).json({ ok: false, error: err.message });
        }

        const data = await createRes.json();

        const entry = await syncToLibrary(`template_${name}`, {
            id: `template_${name}`,
            type: 'template',
            title: name,
            name,
            path: filePath,
            slug: `/${name}.html`,
            branch,
            sha: data.content?.sha,
            status: 'published',
        });

        // → authenticated: nuevo template disponible
        notifySocket({
            entity: 'template',
            room: 'authenticated',
            event: 'template:created',
            data: entry,
        });

        return res.status(200).json({
            ok: true,
            changed: true,
            name,
            path: filePath,
            url: `/${name}.html`,
            branch,
            sha: data.content?.sha,
            commit: data.commit?.sha,
            libraryEntry: entry,
        });
    } catch (error) {
        return res.status(500).json({ ok: false, error: error.message });
    }
});

// ─── POST /github-push ────────────────────────────────────────────────────

app.post('/github-push', ensureAuth, async (req, res) => {
    const { path: filePath, content, url, firebaseKey,
        branch, message, saveToFirebase, firebaseSaveKey,
        libraryMeta } = req.body;

    if (!filePath) return res.status(400).json({ ok: false, error: 'path is required' });

    const targetBranch = branch || DEFAULT_BRANCH;

    try {
        let rawContent;

        if (content !== undefined) {
            rawContent = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
        } else if (url) {
            const downloaded = await fetch(url);
            if (!downloaded.ok) throw new Error(`Failed to download: ${downloaded.status}`);
            rawContent = await downloaded.buffer();
        } else if (firebaseKey) {
            const snap = await docRef(firebaseKey).get();
            if (!snap.exists) return res.status(404).json({ ok: false, error: 'Firebase key not found' });
            const value = unpack(snap.data());
            rawContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        } else {
            return res.status(400).json({ ok: false, error: 'Provide content, url, or firebaseKey' });
        }

        const data = await githubPut({ filePath, content: rawContent, branch: targetBranch, message });

        if (saveToFirebase && firebaseSaveKey) {
            const saveValue = typeof rawContent === 'string'
                ? rawContent
                : rawContent.toString('base64');
            await docRef(firebaseSaveKey).set(pack(saveValue));
        }

        let entry = null;
        if (libraryMeta?.type && TYPE_TO_LIST[libraryMeta.type]) {
            entry = await syncToLibrary(
                libraryMeta.id || filePath,
                { ...libraryMeta, path: filePath, branch: targetBranch, sha: data.content?.sha }
            );
        }

        // → authenticated: archivo pusheado a GitHub
        notifySocket({
            room: 'authenticated',
            event: 'file:pushed',
            data: { path: filePath, branch: targetBranch, sha: data.content?.sha, commit: data.commit?.sha },
        });

        return res.json({
            ok: true,
            path: filePath,
            branch: targetBranch,
            sha: data.content?.sha,
            commit: data.commit?.sha,
            updated: !!data.content?.sha,
            libraryEntry: entry,
        });
    } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── GET /github-file ─────────────────────────────────────────────────────

app.get('/github-file', ensureAuth, async (req, res) => {
    const { path: filePath, branch, saveToFirebase, firebaseSaveKey } = req.query;
    if (!filePath) return res.status(400).json({ ok: false, error: 'path is required' });

    const targetBranch = branch || DEFAULT_BRANCH;
    const apiUrl = `https://api.github.com/repos/${GITHUB_USER}/${REPO_NAME}/contents/${filePath}?ref=${targetBranch}`;

    try {
        const ghRes = await fetch(apiUrl, {
            headers: {
                Authorization: `token ${GITHUB_TOKEN}`,
                Accept: 'application/vnd.github+json',
            },
        });

        if (ghRes.status === 404) return res.status(404).json({ ok: false, error: 'File not found' });
        if (!ghRes.ok) {
            const err = await ghRes.json();
            return res.status(500).json({ ok: false, error: err.message });
        }

        const data = await ghRes.json();
        const content = Buffer.from(data.content, 'base64').toString('utf8');

        if (saveToFirebase === 'true' && firebaseSaveKey) {
            await docRef(firebaseSaveKey).set(pack(content));
        }

        return res.json({
            ok: true,
            path: filePath,
            branch: targetBranch,
            sha: data.sha,
            size: data.size,
            content,
        });
    } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── POST /github-push-from-fb ────────────────────────────────────────────

app.post('/github-push-from-fb', ensureAuth, async (req, res) => {
    const { firebaseKey, path: filePath, branch, message, libraryMeta } = req.body;
    if (!firebaseKey) return res.status(400).json({ ok: false, error: 'firebaseKey is required' });
    if (!filePath) return res.status(400).json({ ok: false, error: 'path is required' });

    try {
        const snap = await docRef(firebaseKey).get();
        if (!snap.exists) return res.status(404).json({ ok: false, error: 'Firebase key not found' });

        const value = unpack(snap.data());
        const content = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        const targetBranch = branch || DEFAULT_BRANCH;

        const data = await githubPut({ filePath, content, branch: targetBranch, message });

        const type = (typeof value === 'object' && value?.type) || libraryMeta?.type;
        const syncValue = type && TYPE_TO_LIST[type]
            ? { ...(typeof value === 'object' ? value : libraryMeta), path: filePath, branch: targetBranch, sha: data.content?.sha }
            : null;

        const entry = syncValue ? await syncToLibrary(firebaseKey, syncValue) : null;

        // → authenticated: archivo pusheado desde Firebase
        notifySocket({
            room: 'authenticated',
            event: 'file:pushed',
            data: { firebaseKey, path: filePath, branch: targetBranch, sha: data.content?.sha, commit: data.commit?.sha },
        });

        return res.json({
            ok: true,
            firebaseKey,
            path: filePath,
            sha: data.content?.sha,
            commit: data.commit?.sha,
            libraryEntry: entry,
        });
    } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── GET /library ─────────────────────────────────────────────────────────

app.get('/library', async (req, res) => {
    try {
        const library = await getLibraryWithObjects();
        res.json({ ok: true, library });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── GET /library/refresh ─────────────────────────────────────────────────

app.get('/library/refresh', ensureAuth, async (req, res) => {
    try {
        const library = await getLibraryWithObjects();
        res.json({ ok: true, library });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── POST /library/bootstrap ──────────────────────────────────────────────

app.post('/library/bootstrap', ensureAuth, async (req, res) => {
    try {
        const library = await bootstrapLibrary();
        res.json({ ok: true, library });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── POST /library/sync-entry ─────────────────────────────────────────────

app.post('/library/sync-entry', ensureAuth, async (req, res) => {
    try {
        const { key, value, extra } = req.body;
        if (!key) return res.status(400).json({ ok: false, error: 'key is required' });

        const entry = await syncToLibrary(key, value || {}, extra || {});
        if (!entry) return res.status(400).json({ ok: false, error: 'type not recognized — cannot sync' });

        res.json({ ok: true, entry });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── DELETE /library/remove-entry/:key ───────────────────────────────────

app.delete('/library/remove-entry/:key', ensureAuth, async (req, res) => {
    try {
        const removed = await removeFromLibrary(req.params.key);
        res.json({ ok: true, removed });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── GET /api/pages ──────────────────────────────────────────────────────

app.get('/api/pages', async (req, res) => {
    try {
        const library = await getLibrary();
        res.json(library.pages || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/pages_blocked', async (req, res) => {
    try {
        const library = await getLibrary();
        const pages = Array.isArray(library?.pages) ? library.pages : [];
        res.json(pages.filter(item => item?.status === "draft"));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/assets_blocked', async (req, res) => {
    try {
        const library = await getLibrary();
        const assets = Array.isArray(library?.assets) ? library.assets : [];
        res.json(assets.filter(item => item?.status === "draft"));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/files_blocked', async (req, res) => {
    try {
        const library = await getLibrary();
        const files = Array.isArray(library?.files) ? library.files : [];
        res.json(files.filter(item => item?.status === "draft"));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/services', async (req, res) => {
    try {
        const library = await getLibrary();
        res.json(library.services || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/assets', async (req, res) => {
    try {
        const library = await getLibrary();
        res.json(library.assets || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/files', async (req, res) => {
    try {
        const library = await getLibrary();
        res.json(library.files || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/templates', async (req, res) => {
    try {
        const library = await getLibrary();
        res.json(library.templates || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/jsons', async (req, res) => {
    try {
        const library = await getLibrary();
        res.json(library.jsons || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/config ─────────────────────────────────────────────────────

app.get('/api/config', async (req, res) => {
    try {
        const snap = await docRef(CONFIG_KEY).get();
        if (!snap.exists) return res.json({});
        res.json(unpack(snap.data()));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── PUT /api/config ─────────────────────────────────────────────────────

app.put('/api/config', ensureAuth, async (req, res) => {
    try {
        const config = req.body;
        if (!config || typeof config !== 'object') {
            return res.status(400).json({ ok: false, error: 'Body debe ser un objeto JSON' });
        }

        if (!config.meta) config.meta = {};
        config.meta.ultimo_guardado = new Date().toISOString();
        config.meta.guardado_por = req.user?.uid || req.header('x-uid') || 'admin';

        await docRef(CONFIG_KEY).set(pack(config));

        // → public: config cambiada, todos los clientes deben recargar
        notifySocket({
            room: 'public',
            event: 'config:updated',
            data: config,
        });

        res.json({ ok: true, key: CONFIG_KEY, config });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── PATCH /api/config ───────────────────────────────────────────────────

app.patch('/api/config', ensureAuth, async (req, res) => {
    try {
        const updates = req.body;
        if (!updates || typeof updates !== 'object') {
            return res.status(400).json({ ok: false, error: 'Body debe ser un objeto JSON' });
        }

        const snap = await docRef(CONFIG_KEY).get();
        const current = snap.exists ? unpack(snap.data()) : {};

        const merged = { ...current };
        for (const [section, value] of Object.entries(updates)) {
            if (section === 'meta') continue;
            if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                merged[section] = { ...(current[section] || {}), ...value };
            } else {
                merged[section] = value;
            }
        }

        if (!merged.meta) merged.meta = {};
        merged.meta.ultimo_guardado = new Date().toISOString();
        merged.meta.guardado_por = req.user?.uid || req.header('x-uid') || 'admin';

        await docRef(CONFIG_KEY).set(pack(merged));

        // → public: config parcialmente actualizada
        notifySocket({
            room: 'public',
            event: 'config:updated',
            data: merged,
        });

        res.json({ ok: true, key: CONFIG_KEY, config: merged });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── PATCH /api/pages/:id/active ─────────────────────────────────────────
app.patch('/api/pages/:id/active', ensureAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { activo } = req.body;

        if (typeof activo !== 'boolean') {
            return res.status(400).json({
                ok: false,
                error: 'activo debe ser boolean'
            });
        }

        const library = await getLibrary();

        const idx = library.pages.findIndex(
            p => p.id === id
        );

        if (idx === -1) {
            return res.status(404).json({
                ok: false,
                error: `Página '${id}' no encontrada`
            });
        }

        // Mantener compatibilidad con la ruta y el nombre "activo"
        library.pages[idx].status = activo
            ? 'published'
            : 'draft';

        library.pages[idx].updatedAt = Date.now();

        await saveLibrary(library);

        notifySocket({
            entity: 'page',
            room: 'public',
            event: 'pages:updated',
            data: library.pages[idx],
        });

        res.json({
            ok: true,
            id,
            activo,
            status: library.pages[idx].status,
            page: library.pages[idx]
        });

    } catch (err) {
        res.status(500).json({
            ok: false,
            error: err.message
        });
    }
});

// ─── PATCH /api/pages/:id/guest ──────────────────────────────────────────

app.patch('/api/pages/:id/guest', ensureAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { set } = req.body;

        if (typeof set !== 'boolean') {
            return res.status(400).json({ ok: false, error: 'set debe ser boolean' });
        }

        const library = await getLibrary();
        const page = library.pages.find(p => p.id === id);
        if (!page) {
            return res.status(404).json({ ok: false, error: `Página '${id}' no encontrada` });
        }

        const slug = page.relativePath || page.slug || page.url || '';

        const snap = await docRef(CONFIG_KEY).get();
        const config = snap.exists ? unpack(snap.data()) : {};
        if (!config.guest) config.guest = {};

        if (set) {
            config.guest.pagina_guest = slug;
            config.guest.activo = true;
        } else {
            if (config.guest.pagina_guest === slug) {
                config.guest.pagina_guest = '';
                config.guest.activo = false;
            }
        }

        if (!config.meta) config.meta = {};
        config.meta.ultimo_guardado = new Date().toISOString();
        config.meta.guardado_por = req.user?.uid || req.header('x-uid') || 'admin';

        await docRef(CONFIG_KEY).set(pack(config));

        // → public: la página guest cambió, guests deben saber a dónde redirigir
        notifySocket({
            entity: 'page',
            room: 'public',
            event: 'pages:updated',
            data: { id, slug, guest_activo: config.guest.activo, pagina_guest: config.guest.pagina_guest },
        });

        res.json({ ok: true, id, slug, guest_activo: config.guest.activo, pagina_guest: config.guest.pagina_guest });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ════════════════════════════════════════════════════════
// BUNDLE SERVER
// ════════════════════════════════════════════════════════

const BUNDLE_MANIFEST_KEY = 'bundle_manifest';
const BUNDLE_PAGES_KEY = 'bundle_pages';
const BUNDLE_LIBMODS_KEY = 'bundle_libmods';
const MODULE_CACHE = new Map();
const LIBMOD_CACHE = new Map();
const BUNDLE_CACHE_MAP = new Map();
const JS_MODULES_BASE = 'public/js_modules';

// ─── Manifest helpers ─────────────────────────────────────────────────────

async function getBundleManifest() {
    const snap = await docRef(BUNDLE_MANIFEST_KEY).get();
    if (!snap.exists) return {};
    return unpack(snap.data());
}

async function saveBundleManifest(manifest) {
    await docRef(BUNDLE_MANIFEST_KEY).set(pack(manifest));
    MODULE_CACHE.clear();
    BUNDLE_CACHE_MAP.clear();
    notifySocket({
        room: 'authenticated',
        event: 'bundle:manifest-updated',
        data: { keys: Object.keys(manifest) },
    });
    return manifest;
}

// ─── Pages helpers ────────────────────────────────────────────────────────

async function getBundlePages() {
    const snap = await docRef(BUNDLE_PAGES_KEY).get();
    if (!snap.exists) return {};
    return unpack(snap.data());
}

async function saveBundlePages(pages) {
    await docRef(BUNDLE_PAGES_KEY).set(pack(pages));
    BUNDLE_CACHE_MAP.clear();
    notifySocket({
        room: 'authenticated',
        event: 'bundle:pages-updated',
        data: { keys: Object.keys(pages) },
    });
    return pages;
}

// ─── Libmods helpers ──────────────────────────────────────────────────────

async function getBundleLibmods() {
    const snap = await docRef(BUNDLE_LIBMODS_KEY).get();
    if (!snap.exists) return {};
    return unpack(snap.data());
}

async function saveBundleLibmods(libmods) {
    await docRef(BUNDLE_LIBMODS_KEY).set(pack(libmods));
    LIBMOD_CACHE.clear();
    BUNDLE_CACHE_MAP.clear();
    notifySocket({
        room: 'authenticated',
        event: 'bundle:libmods-updated',
        data: { keys: Object.keys(libmods) },
    });
    return libmods;
}

// ─── Dependency resolver (topo sort) ─────────────────────────────────────

function topoSort(names, manifest) {
    const visited = new Set();
    const result = [];

    function visit(name) {
        if (visited.has(name)) return;
        visited.add(name);
        const mod = manifest[name];
        if (!mod) throw new Error(`Módulo desconocido: "${name}"`);
        for (const dep of (mod.deps || [])) visit(dep);
        result.push(name);
    }

    for (const name of names) visit(name);
    return result;
}

// ─── Module fetcher ───────────────────────────────────────────────────────

async function fetchBundleModule(name, mod) {
    if (MODULE_CACHE.has(name)) return MODULE_CACHE.get(name);

    if (!mod.githubPath) throw new Error(`Módulo "${name}" no tiene "githubPath"`);

    const filename = mod.githubPath.split('/').pop();
    const resolvedPath = `${JS_MODULES_BASE}/${filename}`;
    const branch = mod.branch || DEFAULT_BRANCH;

    console.log(`[bundle] fetch: ${resolvedPath}@${branch}`);

    const apiUrl = `https://api.github.com/repos/${GITHUB_USER}/${REPO_NAME}/contents/${resolvedPath}?ref=${branch}`;
    const ghRes = await fetch(apiUrl, {
        headers: {
            Authorization: `token ${GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
        },
    });

    if (ghRes.status === 404) throw new Error(`No encontrado en repo: ${resolvedPath}`);
    if (!ghRes.ok) {
        const err = await ghRes.json();
        throw new Error(`GitHub error ${resolvedPath}: ${err.message}`);
    }

    const data = await ghRes.json();
    const raw = Buffer.from(data.content, 'base64').toString('utf8');
    const wrapped = `\n/* ── ${name} (${resolvedPath}) ── */\n${raw}\n`;

    MODULE_CACHE.set(name, wrapped);
    return wrapped;
}

// ─── Libmod file fetcher ──────────────────────────────────────────────────

async function fetchLibmodFile(libmodName, basePath, fileEntry, branchOverride) {
    const fileName  = typeof fileEntry === 'string' ? fileEntry : fileEntry.file;
    const fileLabel = typeof fileEntry === 'string' ? '' : (fileEntry.label || '');
    const resolvedPath = basePath
        ? `${basePath}/${fileName}`.replace(/\/\//g, '/')
        : fileName;
    const branch = branchOverride || DEFAULT_BRANCH;
    const cacheKey = `${libmodName}::${resolvedPath}@${branch}`;

    if (LIBMOD_CACHE.has(cacheKey)) return LIBMOD_CACHE.get(cacheKey);

    console.log(`[libmod] fetch: ${resolvedPath}@${branch}`);

    const apiUrl = `https://api.github.com/repos/${GITHUB_USER}/${REPO_NAME}/contents/${resolvedPath}?ref=${branch}`;
    const ghRes = await fetch(apiUrl, {
        headers: {
            Authorization: `token ${GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
        },
    });

    if (ghRes.status === 404) throw new Error(`LibMod file not found: ${resolvedPath}`);
    if (!ghRes.ok) {
        const err = await ghRes.json();
        throw new Error(`GitHub error ${resolvedPath}: ${err.message}`);
    }

    const data = await ghRes.json();
    const raw  = Buffer.from(data.content, 'base64').toString('utf8');
    const comment = fileLabel
        ? `/* ── ${libmodName}/${fileName} — ${fileLabel} ── */`
        : `/* ── ${libmodName}/${fileName} ── */`;

    const wrapped = `\n${comment}\n${raw}\n`;
    LIBMOD_CACHE.set(cacheKey, wrapped);
    return wrapped;
}

// ─── Bundle builder ───────────────────────────────────────────────────────

async function buildBundle(orderedNames, manifest) {
    const parts = await Promise.all(
        orderedNames.map(name => fetchBundleModule(name, manifest[name]))
    );
    return parts.join('');
}

// ─── Libmod bundle builder ────────────────────────────────────────────────

async function buildLibmodBundle(libmodName, cfg, headerOnly = false) {
    const basePath  = cfg.basePath || '';
    const branch    = cfg.branch   || DEFAULT_BRANCH;
    const headFiles = cfg.head     || [];
    const bodyFiles = cfg.body_end || [];
    const filesToLoad = headerOnly ? headFiles : [...headFiles, ...bodyFiles];

    const parts = await Promise.all(
        filesToLoad.map(f => fetchLibmodFile(libmodName, basePath, f, branch))
    );

    const header = [
        `/* LibMod: ${libmodName} (${new Date().toISOString()}) */`,
        cfg.description ? `/* ${cfg.description} */` : '',
        `/* base: ${basePath || '/'} @ ${branch} */`,
        headFiles.length ? `/* head:     ${headFiles.map(f => f.file || f).join(' → ')} */` : '',
        !headerOnly && bodyFiles.length ? `/* body_end: ${bodyFiles.map(f => f.file || f).join(' → ')} */` : '',
        '',
    ].filter(Boolean).join('\n');

    return header + parts.join('');
}

// ─── Resolver principal ───────────────────────────────────────────────────

async function resolveModules({ page, needs, headerOnly }, manifest, pages) {
    let headMods = [];
    let bodyEndMods = [];

    if (page) {
        const cfg = pages[page];
        if (!cfg) throw new Error(`Página desconocida: "${page}"`);
        headMods    = cfg.head     || [];
        bodyEndMods = cfg.body_end || [];
    }

    if (needs && needs.length) {
        const existing = new Set([...headMods, ...bodyEndMods]);
        for (const n of needs) {
            if (!existing.has(n)) {
                bodyEndMods.push(n);
                existing.add(n);
            }
        }
    }

    const sortedHead    = headMods.length    ? topoSort(headMods,    manifest) : [];
    const sortedBodyEnd = bodyEndMods.length ? topoSort(bodyEndMods, manifest) : [];

    if (headerOnly) return { head: sortedHead, body_end: [] };
    return { head: sortedHead, body_end: sortedBodyEnd };
}

// ─── GET /bundle ──────────────────────────────────────────────────────────
//
//  ?needs=a,b,c                        → módulos directos
//  ?page=dabeiba                       → preset completo
//  ?page=dabeiba&header=true           → solo head del preset
//  ?page=dabeiba&needs=a,b             → preset + extras en body_end
//  ?libmod=avatarStudio                → library module completo
//  ?libmod=avatarStudio&header=true    → solo head del libmod
//  ?page=X&libmod=Y&needs=Z            → todo combinado
//  &nocache=1                          → salta bundle cache
//
app.get('/bundle', async (req, res) => {
    const pageParam   = req.query.page?.trim();
    const needsParam  = req.query.needs;
    const libmodParam = req.query.libmod?.trim();
    const headerOnly  = req.query.header === 'true';
    const nocache     = req.query.nocache === '1';

    if (!pageParam && !needsParam && !libmodParam) {
        return res.status(400).json({
            error: 'Requiere ?needs=mod1,mod2, ?page=nombre y/o ?libmod=nombre',
        });
    }

    const needsList = needsParam
        ? needsParam.split(',').map(s => s.trim()).filter(Boolean)
        : [];

    try {
        const [manifest, pages, libmods] = await Promise.all([
            getBundleManifest(),
            (pageParam || needsList.length) ? getBundlePages()   : Promise.resolve({}),
            libmodParam                     ? getBundleLibmods() : Promise.resolve({}),
        ]);

        // ── Módulos normales (page + needs) ───────────────────────────────
        let modulesBundle = '';
        let headMods = [], bodyMods = [];

        if (pageParam || needsList.length) {
            if (!Object.keys(manifest).length)
                return res.status(404).json({ error: 'bundle_manifest vacío' });

            const resolved = await resolveModules(
                { page: pageParam, needs: needsList, headerOnly },
                manifest,
                pages,
            );
            headMods = resolved.head;
            bodyMods = resolved.body_end;

            const allOrdered = [...headMods, ...bodyMods];
            const hdr = [
                `/* Bundle: ${new Date().toISOString()} */`,
                pageParam ? `/* Page: ${pageParam} */` : '',
                headMods.length ? `/* Head:     ${headMods.join(' → ')} */` : '',
                bodyMods.length ? `/* Body-end: ${bodyMods.join(' → ')} */` : '',
                '',
            ].filter(Boolean).join('\n');

            modulesBundle = hdr + await buildBundle(allOrdered, manifest);
        }

        // ── LibraryModule ─────────────────────────────────────────────────
        let libBundle = '';
        let libHeadFiles = [], libBodyFiles = [];

        if (libmodParam) {
            const cfg = libmods[libmodParam];
            if (!cfg) return res.status(404).json({ error: `LibMod desconocido: "${libmodParam}"` });

            const libCacheKey = `libmod:${libmodParam}:${headerOnly ? 'head' : 'full'}`;

            if (!nocache && BUNDLE_CACHE_MAP.has(libCacheKey)) {
                console.log(`[bundle] libmod cache hit: ${libCacheKey}`);
                libBundle = BUNDLE_CACHE_MAP.get(libCacheKey);
            } else {
                libBundle = await buildLibmodBundle(libmodParam, cfg, headerOnly);
                BUNDLE_CACHE_MAP.set(libCacheKey, libBundle);
            }

            libHeadFiles = (cfg.head     || []).map(f => f.file || f);
            libBodyFiles = headerOnly ? [] : (cfg.body_end || []).map(f => f.file || f);
        }

        // ── Cache global ──────────────────────────────────────────────────
        const cacheKey = [
            pageParam   ? `page:${pageParam}`     : '',
            libmodParam ? `lib:${libmodParam}`     : '',
            headerOnly  ? 'head' : 'full',
            headMods.join('+'),
            bodyMods.join('+'),
        ].filter(Boolean).join('|');

        const finalBundle = modulesBundle + libBundle;

        if (!nocache) BUNDLE_CACHE_MAP.set(cacheKey, finalBundle);

        res.set('Content-Type', 'application/javascript; charset=utf-8');
        res.set('X-Bundle-Cache',       'MISS');
        res.set('X-Bundle-Head',        headMods.join(', '));
        res.set('X-Bundle-Body-End',    bodyMods.join(', '));
        res.set('X-Bundle-LibMod-Head', libHeadFiles.join(', '));
        res.set('X-Bundle-LibMod-Body', libBodyFiles.join(', '));
        res.send(finalBundle);

    } catch (err) {
        console.error('[bundle] error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /bundle/list ────────────────────────────────────────────────────

app.get('/bundle/list', async (req, res) => {
    try {
        const [manifest, pages, libmods] = await Promise.all([
            getBundleManifest(),
            getBundlePages(),
            getBundleLibmods(),
        ]);
        res.json({
            ok: true,
            base: `${GITHUB_USER}/${REPO_NAME}/${JS_MODULES_BASE}`,
            modules: Object.entries(manifest).map(([name, mod]) => ({
                name,
                file: mod.githubPath?.split('/').pop(),
                resolvedPath: `${JS_MODULES_BASE}/${mod.githubPath?.split('/').pop()}`,
                branch: mod.branch || DEFAULT_BRANCH,
                deps: mod.deps || [],
            })),
            pages: Object.entries(pages).map(([name, cfg]) => ({
                name,
                description: cfg.description || '',
                head:     cfg.head     || [],
                body_end: cfg.body_end || [],
            })),
            libmods: Object.entries(libmods).map(([name, cfg]) => ({
                name,
                description: cfg.description || '',
                basePath: cfg.basePath || '',
                branch:   cfg.branch   || DEFAULT_BRANCH,
                head:     cfg.head     || [],
                body_end: cfg.body_end || [],
            })),
        });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── PUT /api/bundle/manifest ────────────────────────────────────────────

app.put('/api/bundle/manifest', ensureAuth, async (req, res) => {
    try {
        const manifest = req.body;
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
            return res.status(400).json({ ok: false, error: 'Body debe ser objeto { modName: {...} }' });
        await saveBundleManifest(manifest);
        res.json({ ok: true, keys: Object.keys(manifest) });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── PATCH /api/bundle/manifest ──────────────────────────────────────────

app.patch('/api/bundle/manifest', ensureAuth, async (req, res) => {
    try {
        const updates = req.body;
        if (!updates || typeof updates !== 'object' || Array.isArray(updates))
            return res.status(400).json({ ok: false, error: 'Body debe ser objeto { modName: {...} }' });
        const current = await getBundleManifest();
        const merged  = { ...current, ...updates };
        await saveBundleManifest(merged);
        res.json({ ok: true, updated: Object.keys(updates), total: Object.keys(merged).length });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── DELETE /api/bundle/manifest/:name ───────────────────────────────────

app.delete('/api/bundle/manifest/:name', ensureAuth, async (req, res) => {
    try {
        const { name } = req.params;
        const current = await getBundleManifest();
        if (!(name in current))
            return res.status(404).json({ ok: false, error: `Módulo "${name}" no existe` });
        delete current[name];
        await saveBundleManifest(current);
        res.json({ ok: true, deleted: name, remaining: Object.keys(current).length });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── PUT /api/bundle/pages ───────────────────────────────────────────────

app.put('/api/bundle/pages', ensureAuth, async (req, res) => {
    try {
        const pages = req.body;
        if (!pages || typeof pages !== 'object' || Array.isArray(pages))
            return res.status(400).json({ ok: false, error: 'Body debe ser objeto { pageName: {...} }' });
        await saveBundlePages(pages);
        res.json({ ok: true, keys: Object.keys(pages) });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── PATCH /api/bundle/pages ─────────────────────────────────────────────

app.patch('/api/bundle/pages', ensureAuth, async (req, res) => {
    try {
        const updates = req.body;
        if (!updates || typeof updates !== 'object' || Array.isArray(updates))
            return res.status(400).json({ ok: false, error: 'Body debe ser objeto { pageName: {...} }' });
        const current = await getBundlePages();
        const merged  = { ...current, ...updates };
        await saveBundlePages(merged);
        res.json({ ok: true, updated: Object.keys(updates), total: Object.keys(merged).length });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── DELETE /api/bundle/pages/:name ──────────────────────────────────────

app.delete('/api/bundle/pages/:name', ensureAuth, async (req, res) => {
    try {
        const { name } = req.params;
        const current = await getBundlePages();
        if (!(name in current))
            return res.status(404).json({ ok: false, error: `Página "${name}" no existe` });
        delete current[name];
        await saveBundlePages(current);
        res.json({ ok: true, deleted: name, remaining: Object.keys(current).length });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── GET /api/bundle/pages/:name ─────────────────────────────────────────

app.get('/api/bundle/pages/:name', async (req, res) => {
    try {
        const pages = await getBundlePages();
        const cfg = pages[req.params.name];
        if (!cfg) return res.status(404).json({ ok: false, error: `Página "${req.params.name}" no existe` });
        res.json({ ok: true, name: req.params.name, ...cfg });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── GET /api/bundle/libmods ─────────────────────────────────────────────

app.get('/api/bundle/libmods', async (req, res) => {
    try {
        const libmods = await getBundleLibmods();
        res.json({
            ok: true,
            libmods: Object.entries(libmods).map(([name, cfg]) => ({
                name,
                description: cfg.description || '',
                basePath: cfg.basePath || '',
                branch:   cfg.branch   || DEFAULT_BRANCH,
                head:     cfg.head     || [],
                body_end: cfg.body_end || [],
            })),
        });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── GET /api/bundle/libmods/:name ───────────────────────────────────────

app.get('/api/bundle/libmods/:name', async (req, res) => {
    try {
        const libmods = await getBundleLibmods();
        const cfg = libmods[req.params.name];
        if (!cfg) return res.status(404).json({ ok: false, error: `LibMod "${req.params.name}" no existe` });
        res.json({ ok: true, name: req.params.name, ...cfg });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── PUT /api/bundle/libmods ─────────────────────────────────────────────

app.put('/api/bundle/libmods', ensureAuth, async (req, res) => {
    try {
        const libmods = req.body;
        if (!libmods || typeof libmods !== 'object' || Array.isArray(libmods))
            return res.status(400).json({ ok: false, error: 'Body debe ser { libmodName: {...} }' });
        await saveBundleLibmods(libmods);
        res.json({ ok: true, keys: Object.keys(libmods) });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── PATCH /api/bundle/libmods ───────────────────────────────────────────

app.patch('/api/bundle/libmods', ensureAuth, async (req, res) => {
    try {
        const updates = req.body;
        if (!updates || typeof updates !== 'object' || Array.isArray(updates))
            return res.status(400).json({ ok: false, error: 'Body debe ser { libmodName: {...} }' });
        const current = await getBundleLibmods();
        const merged  = { ...current, ...updates };
        await saveBundleLibmods(merged);
        res.json({ ok: true, updated: Object.keys(updates), total: Object.keys(merged).length });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── DELETE /api/bundle/libmods/:name ────────────────────────────────────

app.delete('/api/bundle/libmods/:name', ensureAuth, async (req, res) => {
    try {
        const { name } = req.params;
        const current = await getBundleLibmods();
        if (!(name in current))
            return res.status(404).json({ ok: false, error: `LibMod "${name}" no existe` });
        delete current[name];
        await saveBundleLibmods(current);
        res.json({ ok: true, deleted: name, remaining: Object.keys(current).length });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── POST /bundle/invalidate ─────────────────────────────────────────────

app.post('/bundle/invalidate', ensureAuth, async (req, res) => {
    const mc = MODULE_CACHE.size;
    const lc = LIBMOD_CACHE.size;
    const bc = BUNDLE_CACHE_MAP.size;
    MODULE_CACHE.clear();
    LIBMOD_CACHE.clear();
    BUNDLE_CACHE_MAP.clear();
    res.json({ ok: true, cleared: { modules: mc, libmods: lc, bundles: bc } });
});

app.get('/console', (req, res) => {
    const index = path.join(PUBLIC_DIR, 'index.html');
    if (!fs.existsSync(index)) {
        return res.status(404).send('index.html not found');
    }
    res.sendFile(index);
});
// ════════════════════════════════════════════════════════════════════════
// BOOTSTRAP
// ════════════════════════════════════════════════════════════════════════


async function bootstrapLibrary() {
    const snap = await docRef(LIBRARY_KEY).get();
    if (!snap.exists) {
        console.warn('⚠ library_index not found in Firestore — waiting for scanner to push it');
        return {
            id: LIBRARY_KEY,
            pages: [], files: [], assets: [], services: [],
            templates: [], jsons: [],
            meta: { totalPages: 0, totalFiles: 0, totalAssets: 0, totalServices: 0, updatedAt: Date.now() },
        };
    }
    return unpack(snap.data());
}

(async () => {
    try {
        await bootstrapLibrary();
        const library = await getLibraryWithObjects();
        console.log(`✓ Library initialized — pages: ${library.pages?.length ?? 0}, files: ${library.files?.length ?? 0}, assets: ${library.assets?.length ?? 0}, objects: ${Object.keys(library.objects).length}`);
    } catch (err) {
        console.error('Library bootstrap error:', err.message);
    }

    app.listen(PORT, () => {
        console.log(`✓ Servidor en http://localhost:${PORT}`);
        console.log(`✓ Firestore colección: "${COLLECTION}"`);
        console.log(`✓ Socket notify → ${SOCKET_SERVER}`);
    });
})();