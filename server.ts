import express from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

dotenv.config();

const app = express();
const PORT = 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-fallback-key-for-dev';

const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

const dbFile = path.join(process.cwd(), 'db.json');
if (!fs.existsSync(dbFile)) {
  fs.writeFileSync(dbFile, JSON.stringify({ users: [], photos: [] }));
}

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    cb(null, `${uuidv4()}${path.extname(file.originalname)}`);
  }
});
const upload = multer({ storage });

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

function getDb() {
  let data = fs.readFileSync(dbFile, 'utf8');
  let parsed = JSON.parse(data);
  // Migrate old db if it doesn't have users
  if (!parsed.users) {
    parsed = { users: [], photos: parsed.photos || parsed };
    saveDb(parsed);
  }
  return parsed;
}

function saveDb(data: any) {
  fs.writeFileSync(dbFile, JSON.stringify(data, null, 2));
}

const backgroundQueue: any[] = [];
let isProcessingQueue = false;

async function processBackgroundQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  while (backgroundQueue.length > 0) {
    const item = backgroundQueue.shift();
    if (!item) continue;

    const { photoId, file, filePath } = item;
    
    const isVideo = file.mimetype.startsWith('video/');
    const isImage = file.mimetype.startsWith('image/');
    const isAudio = file.mimetype.startsWith('audio/');
    const isText = file.mimetype.startsWith('text/') || file.mimetype === 'application/pdf';

    let theme = 'Overig';
    let tags: string[] = [];
    let description = `Bestand: ${file.originalname}`;

    try {
      const isSupportedMedia = isImage || isVideo || isAudio || isText;
      const isSmallEnough = file.size < 15 * 1024 * 1024; // 15MB limit for inline base64

      if (isSupportedMedia && isSmallEnough) {
        const fileBytes = fs.readFileSync(filePath);
        const base64Data = fileBytes.toString('base64');

        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: {
            parts: [
              {
                inlineData: {
                  mimeType: file.mimetype,
                  data: base64Data,
                }
              },
              {
                text: `Analyseer dit document, foto of video en geef een JSON-antwoord met de volgende sleutels:
  - 'theme': Een enkele, korte categorische themanaam in het Nederlands (bijv. 'Natuur', 'Documenten', 'Mensen', 'Werk', 'Muziek'). Houd het algemeen genoeg om vergelijkbare bestanden te groeperen.
  - 'tags': Een array van 3-5 beschrijvende trefwoorden in het Nederlands.
  - 'description': Een korte beschrijving van 1 zin van het bestand in het Nederlands.`
              }
            ]
          },
          config: {
            responseMimeType: "application/json",
          }
        });

        const aiText = response.text || "{}";
        const analysis = JSON.parse(aiText.trim());
        theme = analysis.theme || theme;
        tags = analysis.tags || tags;
        description = analysis.description || description;
      } else {
        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: {
            parts: [
              {
                text: `Gis de categorie van dit bestand op basis van de naam en mimetype, en geef een JSON-antwoord met de volgende sleutels:
  - 'theme': Een enkele, korte categorische themanaam in het Nederlands (bijv. 'Archieven', 'Programma's', 'Documenten', 'Systeem').
  - 'tags': Een array van 3-5 beschrijvende trefwoorden in het Nederlands.
  - 'description': Een korte beschrijving van 1 zin in het Nederlands.
  
  Bestandsnaam: ${file.originalname}
  MimeType: ${file.mimetype}`
              }
            ]
          },
          config: {
            responseMimeType: "application/json",
          }
        });

        const aiText = response.text || "{}";
        const analysis = JSON.parse(aiText.trim());
        theme = analysis.theme || (isVideo ? 'Video' : 'Bestanden');
        tags = analysis.tags || [file.mimetype];
        description = analysis.description || description;
      }
    } catch (err: any) {
      console.error('Error analyzing media in background:', err);
      theme = 'Ongecategoriseerd';
    }

    const db = getDb();
    const photoIndex = db.photos.findIndex((p: any) => p.id === photoId);
    if (photoIndex !== -1) {
      db.photos[photoIndex].theme = theme;
      db.photos[photoIndex].tags = tags;
      db.photos[photoIndex].description = description;
      saveDb(db);
    }
  }

  isProcessingQueue = false;
}

app.use(express.json());
app.use('/uploads', express.static(uploadsDir));

// Auth Middleware
const authenticateToken = (req: any, res: any, next: any) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token == null) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// --- AUTH ROUTES ---
app.post('/api/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) {
    return res.status(400).json({ error: 'Vul alle velden in' });
  }

  const db = getDb();
  if (db.users.find((u: any) => u.email === email)) {
    return res.status(400).json({ error: 'E-mailadres is al in gebruik' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const newUser = {
    id: uuidv4(),
    email,
    name,
    passwordHash,
    createdAt: new Date().toISOString()
  };

  db.users.push(newUser);
  saveDb(db);

  const token = jwt.sign({ id: newUser.id, email: newUser.email, name: newUser.name }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: newUser.id, email: newUser.email, name: newUser.name } });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Vul alle velden in' });
  }

  const db = getDb();
  const user = db.users.find((u: any) => u.email === email);
  if (!user) {
    return res.status(400).json({ error: 'Ongeldige inloggegevens' });
  }

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) {
    return res.status(400).json({ error: 'Ongeldige inloggegevens' });
  }

  const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
});

app.get('/api/me', authenticateToken, (req: any, res: any) => {
  res.json({ user: req.user });
});

// --- API ROUTES ---
app.post('/api/upload', authenticateToken, upload.single('photo'), async (req: any, res: any) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const file = req.file;
  const filePath = file.path;

  const newPhoto = {
    id: uuidv4(),
    filename: file.filename,
    originalName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
    theme: 'Wordt geanalyseerd...',
    tags: ['ai-analyse'],
    description: 'De AI is dit bestand momenteel aan het analyseren...',
    uploadedAt: new Date().toISOString(),
    userId: req.user.id
  };

  const db = getDb();
  db.photos.push(newPhoto);
  saveDb(db);

  res.json(newPhoto);

  // Queue background processing
  backgroundQueue.push({
    photoId: newPhoto.id,
    file: file,
    filePath: file.path
  });
  
  processBackgroundQueue().catch(console.error);
});

app.get('/api/photos', authenticateToken, (req: any, res: any) => {
  try {
    const db = getDb();
    // Only return photos that belong to the authenticated user
    const userPhotos = db.photos.filter((p: any) => p.userId === req.user.id);
    res.json(userPhotos);
  } catch(err) {
    res.status(500).json({ error: 'Failed to fetch photos' });
  }
});

app.put('/api/albums/rename', authenticateToken, (req: any, res: any) => {
  const { oldName, newName } = req.body;
  if (!oldName || !newName || typeof newName !== 'string') {
    return res.status(400).json({ error: 'Nieuwe en oude naam zijn vereist' });
  }
  if (newName.trim() === '') {
    return res.status(400).json({ error: 'Nieuwe naam mag niet leeg zijn' });
  }

  try {
    const db = getDb();
    let updatedCount = 0;
    
    // Update all photos of the current user that belong to the old album name
    db.photos = db.photos.map((p: any) => {
      if (p.userId === req.user.id && p.theme === oldName) {
        updatedCount++;
        return { ...p, theme: newName.trim() };
      }
      return p;
    });

    if (updatedCount > 0) {
      saveDb(db);
    }
    
    res.json({ success: true, updatedCount, newName: newName.trim() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to rename album' });
  }
});

app.delete('/api/photos/:id', authenticateToken, (req: any, res: any) => {
  const photoId = req.params.id;
  try {
    const db = getDb();
    const photoIndex = db.photos.findIndex((p: any) => p.id === photoId && p.userId === req.user.id);
    
    if (photoIndex === -1) {
      return res.status(404).json({ error: 'Foto niet gevonden' });
    }

    const photo = db.photos[photoIndex];
    // Remove from db
    db.photos.splice(photoIndex, 1);
    saveDb(db);

    // Delete file
    const filePath = path.join(uploadsDir, photo.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: 'Verwijderen mislukt' });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
