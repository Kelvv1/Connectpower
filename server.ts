import express, { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'BlackVelve!@#123';

const APPLICATIONS_FILE = path.join(__dirname, 'applications.json');
const UPLOADS_INDEX_FILE = path.join(__dirname, 'uploads-index.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

export interface ApplicationRecord {
  reference: string;
  amount: number;
  email: string;
  paidAt: string;
  fullname: string;
  nin: string;
  track: string;
  documents: Record<string, string>;
  paymentStatus?: string;
}

function loadApplications(): ApplicationRecord[] {
  try {
    if (fs.existsSync(APPLICATIONS_FILE)) {
      return JSON.parse(fs.readFileSync(APPLICATIONS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error loading applications:', err);
  }
  return [];
}

function saveApplications(list: ApplicationRecord[]): void {
  fs.writeFileSync(APPLICATIONS_FILE, JSON.stringify(list, null, 2), 'utf8');
}

function loadUploadsIndex(): Record<string, Record<string, string>> {
  try {
    if (fs.existsSync(UPLOADS_INDEX_FILE)) {
      return JSON.parse(fs.readFileSync(UPLOADS_INDEX_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error loading uploads index:', err);
  }
  return {};
}

function saveUploadsIndex(index: Record<string, Record<string, string>>): void {
  fs.writeFileSync(UPLOADS_INDEX_FILE, JSON.stringify(index, null, 2), 'utf8');
}

// In-memory admin session tokens
const validAdminTokens = new Set<string>();

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  const out: Record<string, string> = {};
  if (!header) return out;
  header.split(';').forEach(pair => {
    const [k, ...v] = pair.trim().split('=');
    if (k) {
      out[k] = decodeURIComponent(v.join('='));
    }
  });
  return out;
}

function requireAdmin(req: Request, res: Response, next: NextFunction) {
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
  destination: (req, _file, cb) => {
    const rawRef = (req.body.reference || 'unknown').toString();
    const cleanRef = rawRef.replace(/[^a-zA-Z0-9_-]/g, '');
    const dir = path.join(UPLOADS_DIR, cleanRef);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const safeOriginal = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${file.fieldname}-${Date.now()}-${safeOriginal}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB per file
});

// API Routes
app.post(
  '/api/upload-documents',
  upload.fields(DOC_SLOTS.map(name => ({ name, maxCount: 1 }))),
  (req: Request, res: Response) => {
    const ref = (req.body.reference || '').toString().trim();
    if (!ref) {
      return res.status(400).json({ success: false, message: 'Missing reference' });
    }

    const files: Record<string, string> = {};
    const reqFiles = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;

    DOC_SLOTS.forEach(slot => {
      if (reqFiles && reqFiles[slot] && reqFiles[slot][0]) {
        files[slot] = reqFiles[slot][0].filename;
      }
    });

    const index = loadUploadsIndex();
    index[ref] = { ...(index[ref] || {}), ...files };
    saveUploadsIndex(index);

    return res.json({ success: true, uploadedSlots: Object.keys(files) });
  }
);

// Admin-only: download or view an uploaded document
app.get('/api/uploads/:ref/:filename', requireAdmin, (req: Request, res: Response) => {
  const cleanRef = req.params.ref.replace(/[^a-zA-Z0-9_-]/g, '');
  const cleanFilename = path.basename(req.params.filename);
  const filePath = path.join(UPLOADS_DIR, cleanRef, cleanFilename);

  if (!filePath.startsWith(UPLOADS_DIR)) {
    return res.status(400).end();
  }

  return res.sendFile(filePath, err => {
    if (err) {
      if (!res.headersSent) {
        res.status(404).json({ success: false, message: 'File not found' });
      }
    }
  });
});

// Submit application without payment (Paystack temporarily paused)
app.post('/api/submit-application', (req: Request, res: Response) => {
  const { reference, email, applicant } = req.body;

  if (!reference) {
    return res.status(400).json({ success: false, message: 'Missing reference' });
  }

  const uploadsIndex = loadUploadsIndex();
  const documents = uploadsIndex[reference] || {};

  const applications = loadApplications();
  const newApp: ApplicationRecord = {
    reference,
    amount: 0,
    email: email || '',
    paidAt: new Date().toISOString(),
    fullname: applicant?.fullname || '',
    nin: applicant?.nin || '',
    track: applicant?.track || '',
    documents,
    paymentStatus: 'not collected (Paystack paused)'
  };

  applications.push(newApp);
  saveApplications(applications);

  return res.json({ success: true, reference });
});

// Payment verification with Paystack (when payment is enabled)
app.post('/api/verify-payment', async (req: Request, res: Response) => {
  const { reference, applicant } = req.body;

  if (!reference) {
    return res.status(400).json({ success: false, message: 'Missing reference' });
  }

  try {
    const paystackRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
        }
      }
    );
    const data = await paystackRes.json();
    const paid = data && data.status === true && data.data && data.data.status === 'success';

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

      return res.json({
        success: true,
        amount: data.data.amount,
        email: data.data.customer?.email,
        reference
      });
    }

    return res.json({ success: false, message: 'Payment not successful' });
  } catch (err) {
    console.error('Paystack verification error:', err);
    return res.status(500).json({ success: false, message: 'Verification failed' });
  }
});

// Admin login
app.post('/api/admin-login', (req: Request, res: Response) => {
  const { username, password } = req.body;

  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    validAdminTokens.add(token);
    res.setHeader('Set-Cookie', `admin_token=${token}; HttpOnly; Path=/; SameSite=Lax`);
    return res.json({ success: true, token });
  }

  return res.status(401).json({ success: false, message: 'Wrong username or password' });
});

// Admin logout
app.post('/api/admin-logout', (req: Request, res: Response) => {
  const cookies = parseCookies(req);
  if (cookies.admin_token) {
    validAdminTokens.delete(cookies.admin_token);
  }
  res.setHeader('Set-Cookie', 'admin_token=; HttpOnly; Path=/; Max-Age=0');
  return res.json({ success: true });
});

// Admin: list all applications
app.get('/api/applications', requireAdmin, (_req: Request, res: Response) => {
  res.json({ success: true, applications: loadApplications() });
});

// Seed sample application if applications.json is completely fresh, so admin dashboard can be tested immediately
const existingApps = loadApplications();
if (existingApps.length === 0) {
  const sampleRef = 'NP-2017-8492015';
  const sampleApps: ApplicationRecord[] = [
    {
      reference: sampleRef,
      amount: 0,
      email: 'chidi.okafor@example.com',
      paidAt: new Date(Date.now() - 3600000 * 2).toISOString(),
      fullname: 'Chidi Okafor',
      nin: '12345678901',
      track: 'Tech Connect',
      documents: {
        birth: 'birth-demo.pdf',
        waec: 'waec-demo.pdf',
        photo: 'photo-demo.jpg',
        govid: 'govid-demo.pdf',
        degree: 'degree-demo.pdf'
      },
      paymentStatus: 'not collected (Paystack paused)'
    }
  ];
  saveApplications(sampleApps);

  const idx = loadUploadsIndex();
  idx[sampleRef] = sampleApps[0].documents;
  saveUploadsIndex(idx);

  const sampleDir = path.join(UPLOADS_DIR, sampleRef);
  fs.mkdirSync(sampleDir, { recursive: true });
  fs.writeFileSync(path.join(sampleDir, 'birth-demo.pdf'), 'Sample Birth Certificate document content for testing.');
  fs.writeFileSync(path.join(sampleDir, 'waec-demo.pdf'), 'Sample WAEC Result Certificate document content for testing.');
  fs.writeFileSync(path.join(sampleDir, 'photo-demo.jpg'), 'Sample Passport Photo image content for testing.');
  fs.writeFileSync(path.join(sampleDir, 'govid-demo.pdf'), 'Sample Government ID document content for testing.');
  fs.writeFileSync(path.join(sampleDir, 'degree-demo.pdf'), 'Sample Tertiary Degree document content for testing.');
}

// Alias routes for /connectpower
app.get('/connectpower', (_req: Request, res: Response) => {
  res.redirect('/');
});

app.get('/connectpower/:page', (req: Request, res: Response) => {
  const page = req.params.page;
  if (page.endsWith('.html')) {
    res.redirect(`/${page}`);
  } else {
    res.redirect(`/${page}.html`);
  }
});

// Static files
if (fs.existsSync(path.join(__dirname, 'dist'))) {
  app.use(express.static(path.join(__dirname, 'dist')));
}
app.use(express.static(__dirname));

// Setup Vite middleware in dev or static serving in production
async function startServer() {
  const isProduction = process.env.NODE_ENV === 'production';
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  if (!isProduction) {
    try {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa'
      });
      app.use(vite.middlewares);
    } catch (e) {
      console.warn('Vite middleware skipped, using static serving:', e);
    }
  }

  app.get('*', (_req, res) => {
    const distIndex = path.join(__dirname, 'dist', 'index.html');
    if (fs.existsSync(distIndex)) {
      return res.sendFile(distIndex);
    }
    return res.sendFile(path.join(__dirname, 'index.html'));
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Connect Power Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
});
