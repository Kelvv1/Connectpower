// Backend: verifies Paystack payments, saves applications and uploaded documents
// to local files, and provides an admin login + dashboard to view them.

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('.'));

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'BlackVelve!@#123';

const APPLICATIONS_FILE = path.join(__dirname, 'applications.json');
const UPLOADS_INDEX_FILE = path.join(__dirname, 'uploads-index.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function loadApplications() {
  try {
    if (fs.existsSync(APPLICATIONS_FILE)) {
      return JSON.parse(fs.readFileSync(APPLICATIONS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error(err);
  }
  return [];
}
function saveApplications(list) {
  fs.writeFileSync(APPLICATIONS_FILE, JSON.stringify(list, null, 2));
}

function loadUploadsIndex() {
  try {
    if (fs.existsSync(UPLOADS_INDEX_FILE)) {
      return JSON.parse(fs.readFileSync(UPLOADS_INDEX_FILE, 'utf8'));
    }
  } catch (err) {
    console.error(err);
  }
  return {};
}
function saveUploadsIndex(index) {
  fs.writeFileSync(UPLOADS_INDEX_FILE, JSON.stringify(index, null, 2));
}

// In-memory admin session
const validAdminTokens = new Set();

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(pair => {
    const [k, ...v] = pair.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  });
  return out;
}

function requireAdmin(req, res, next) {
  const cookies = parseCookies(req);
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const token = cookies.admin_token || bearerToken;

  if (token && validAdminTokens.has(token)) {
    return next();
  }
  return res.status(401).json({ success: false, message: 'Not logged in' });
}

// Document uploads
const DOC_SLOTS = ['birth', 'nysc', 'waec', 'photo', 'govid', 'prof', 'degree', 'cv'];

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const ref = (req.body.reference || 'unknown').toString().replace(/[^a-zA-Z0-9_-]/g, '');
    const dir = path.join(UPLOADS_DIR, ref);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, file.fieldname + '-' + Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_'));
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

app.post('/api/upload-documents', upload.fields(DOC_SLOTS.map(name => ({ name, maxCount: 1 }))), (req, res) => {
  const ref = req.body.reference;
  if (!ref) return res.status(400).json({ success: false, message: 'Missing reference' });

  const files = {};
  DOC_SLOTS.forEach(slot => {
    if (req.files && req.files[slot] && req.files[slot][0]) {
      files[slot] = req.files[slot][0].filename;
    }
  });

  const index = loadUploadsIndex();
  index[ref] = { ...(index[ref] || {}), ...files };
  saveUploadsIndex(index);

  res.json({ success: true });
});

// Admin-only: download/view a specific uploaded document
app.get('/api/uploads/:ref/:filename', requireAdmin, (req, res) => {
  const ref = req.params.ref.replace(/[^a-zA-Z0-9_-]/g, '');
  const cleanFilename = path.basename(req.params.filename);
  const filePath = path.join(UPLOADS_DIR, ref, cleanFilename);
  if (!filePath.startsWith(UPLOADS_DIR)) return res.status(400).end();
  res.sendFile(filePath, err => {
    if (err && !res.headersSent) res.status(404).json({ success: false, message: 'File not found' });
  });
});

// Submit application without payment (Paystack temporarily paused)
app.post('/api/submit-application', (req, res) => {
  const { reference, email, applicant } = req.body;

  if (!reference) {
    return res.status(400).json({ success: false, message: 'Missing reference' });
  }

  const uploadsIndex = loadUploadsIndex();
  const documents = uploadsIndex[reference] || {};

  const applications = loadApplications();
  applications.push({
    reference,
    amount: 0,
    email: email || '',
    paidAt: new Date().toISOString(),
    fullname: applicant?.fullname || '',
    nin: applicant?.nin || '',
    track: applicant?.track || '',
    documents,
    paymentStatus: 'not collected (Paystack paused)'
  });
  saveApplications(applications);

  res.json({ success: true, reference });
});

// Payment verification + saving the application (Paystack)
app.post('/api/verify-payment', async (req, res) => {
  const { reference, applicant } = req.body;

  if (!reference) {
    return res.status(400).json({ success: false, message: 'Missing reference' });
  }

  try {
    const paystackRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
    );
    const data = await paystackRes.json();

    const paid = data.status === true && data.data && data.data.status === 'success';

    if (paid) {
      const uploadsIndex = loadUploadsIndex();
      const documents = uploadsIndex[reference] || {};

      const applications = loadApplications();
      applications.push({
        reference,
        amount: data.data.amount,
        email: data.data.customer?.email || '',
        paidAt: new Date().toISOString(),
        fullname: applicant?.fullname || '',
        nin: applicant?.nin || '',
        track: applicant?.track || '',
        documents,
        paymentStatus: 'verified via Paystack'
      });
      saveApplications(applications);

      return res.json({ success: true, amount: data.data.amount, email: data.data.customer?.email, reference });
    }

    return res.json({ success: false, message: 'Payment not successful' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Verification failed' });
  }
});

// Admin login
app.post('/api/admin-login', (req, res) => {
  const { username, password } = req.body;

  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    validAdminTokens.add(token);
    res.setHeader('Set-Cookie', `admin_token=${token}; HttpOnly; Path=/; SameSite=Lax`);
    return res.json({ success: true, token });
  }

  return res.status(401).json({ success: false, message: 'Wrong username or password' });
});

app.post('/api/admin-logout', (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.admin_token) validAdminTokens.delete(cookies.admin_token);
  res.setHeader('Set-Cookie', 'admin_token=; HttpOnly; Path=/; Max-Age=0');
  res.json({ success: true });
});

// Admin: list all applications
app.get('/api/applications', requireAdmin, (req, res) => {
  res.json({ success: true, applications: loadApplications() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on http://0.0.0.0:${PORT}`));
