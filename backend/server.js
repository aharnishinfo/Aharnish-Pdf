import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { PDFDocument, degrees, rgb, StandardFonts } from 'pdf-lib';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import pool, { initializeDatabase } from './db.js';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tempDir = path.join(__dirname, 'temp');
const execFileAsync = promisify(execFile);
const sofficePath = process.env.LIBREOFFICE_PATH || 'C:\\Program Files\\LibreOffice\\program\\soffice.exe';
await fs.mkdir(tempDir, { recursive: true });
const app = express();
app.set('trust proxy', true);
const allowedOrigins = [
  'https://aharnish-pdf.vercel.app',
  'http://localhost:5173',
  'http://localhost:3000',
  process.env.CLIENT_ORIGIN
].filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    // Requests without an Origin header include curl, mobile clients, and server-to-server calls.
    if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      return callback(null, true);
    }
    return callback(new Error('Blocked by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
const upload = multer({ dest: tempDir, limits: { fileSize: 50 * 1024 * 1024 } });
const safeName = (name) => name.replace(/[^a-z0-9._-]/gi, '_');
const outputPath = (prefix, extension) => path.join(tempDir, `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${extension}`);
const writePdf = async (doc, prefix) => { const out = outputPath(prefix, 'pdf'); await fs.writeFile(out, await doc.save()); return path.basename(out); };
const requestedPages = (value, total) => new Set((value || '').split(',').flatMap(part => { const [start, end] = part.trim().split('-').map(Number); return Number.isFinite(start) ? Array.from({ length: Math.max(0, (end || start) - start + 1) }, (_, i) => start - 1 + i) : []; }).filter(index => index >= 0 && index < total));

app.post('/api/track-visit', async (req, res, next) => {
  try {
    const [result] = await pool.execute('INSERT INTO visitor_logs (ip_address, user_agent, page_visited) VALUES (?, ?, ?)',
      [req.ip, req.get('user-agent') || '', req.body.pageVisited || '/']);
    res.status(201).json({ visitorId: result.insertId });
  } catch (error) { next(error); }
});

app.post('/api/pdf/merge', upload.array('files', 20), async (req, res, next) => {
  try {
    if (!req.files?.length) throw new Error('Please upload at least one PDF.');
    const merged = await PDFDocument.create();
    for (const file of req.files) { const source = await PDFDocument.load(await fs.readFile(file.path)); const pages = await merged.copyPages(source, source.getPageIndices()); pages.forEach(p => merged.addPage(p)); }
    res.json({ filename: await writePdf(merged, 'merged'), originalName: req.files[0].originalname });
  } catch (error) { next(error); }
});

app.post('/api/pdf/split', upload.single('file'), async (req, res, next) => {
  try {
    const source = await PDFDocument.load(await fs.readFile(req.file.path));
    const raw = req.body.pages || '1';
    const indexes = new Set();
    raw.split(',').forEach(part => { const [a, b] = part.trim().split('-').map(Number); for (let i = a; i <= (b || a); i++) if (i > 0 && i <= source.getPageCount()) indexes.add(i - 1); });
    if (!indexes.size) throw new Error('Enter valid page numbers, e.g. 1-3,5.');
    const result = await PDFDocument.create(); const pages = await result.copyPages(source, [...indexes]); pages.forEach(p => result.addPage(p));
    res.json({ filename: await writePdf(result, 'split'), originalName: req.file.originalname });
  } catch (error) { next(error); }
});

app.post('/api/pdf/remove-pages', upload.single('file'), async (req, res, next) => {
  try { const source = await PDFDocument.load(await fs.readFile(req.file.path)); const remove = requestedPages(req.body.pages, source.getPageCount()); if (!remove.size) throw new Error('Enter page numbers to remove, for example 2,4-6.'); const result = await PDFDocument.create(); const keep = source.getPageIndices().filter(index => !remove.has(index)); if (!keep.length) throw new Error('At least one page must remain.'); const pages = await result.copyPages(source, keep); pages.forEach(page => result.addPage(page)); res.json({ filename: await writePdf(result, 'pages-removed'), originalName: req.file.originalname }); } catch (error) { next(error); }
});

app.post('/api/pdf/from-images', upload.array('files', 20), async (req, res, next) => {
  try { if (!req.files?.length) throw new Error('Please select one or more JPG or PNG images.'); const doc = await PDFDocument.create(); for (const file of req.files) { const bytes = await fs.readFile(file.path); const image = file.mimetype === 'image/png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes); const page = doc.addPage([image.width, image.height]); page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height }); } res.json({ filename: await writePdf(doc, 'images-to-pdf'), originalName: req.files[0].originalname }); } catch (error) { next(error); }
});

app.post('/api/pdf/office-to-pdf', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw new Error('Please select a document.');
    const extension = path.extname(req.file.originalname);
    const source = path.join(tempDir, `${path.basename(req.file.filename)}${extension}`);
    await fs.rename(req.file.path, source);
    await execFileAsync(sofficePath, ['--headless', '--convert-to', 'pdf', '--outdir', tempDir, source], { windowsHide: true, timeout: 120000 });
    const filename = `${path.basename(source, extension)}.pdf`;
    await fs.access(path.join(tempDir, filename));
    res.json({ filename, originalName: req.file.originalname });
  } catch (error) { next(new Error(`Document conversion failed: ${error.message}`)); }
});

app.post('/api/pdf/from-pdf', upload.single('file'), async (req, res, next) => {
  try { const formats = { word: 'docx', powerpoint: 'pptx', excel: 'xlsx' }; const extension = formats[req.query.format]; if (!extension) throw new Error('Unsupported output format.'); const source = path.join(tempDir, `${req.file.filename}-source.pdf`); await fs.rename(req.file.path, source); await execFileAsync(sofficePath, ['--headless', '--convert-to', extension, '--outdir', tempDir, source], { windowsHide: true, timeout: 120000 }); const filename = `${path.basename(source, '.pdf')}.${extension}`; await fs.access(path.join(tempDir, filename)); res.json({ filename, originalName: req.file.originalname }); } catch (error) { next(new Error(`PDF conversion failed: ${error.message}`)); }
});

app.post('/api/pdf/rotate', upload.single('file'), async (req, res, next) => {
  try {
    const doc = await PDFDocument.load(await fs.readFile(req.file.path)); const angle = Number(req.body.angle || 90);
    const chosen = req.body.pages ? new Set(req.body.pages.split(',').map(x => Number(x.trim()) - 1)) : null;
    doc.getPages().forEach((page, index) => { if (!chosen || chosen.has(index)) page.setRotation(degrees((page.getRotation().angle + angle) % 360)); });
    res.json({ filename: await writePdf(doc, 'rotated'), originalName: req.file.originalname });
  } catch (error) { next(error); }
});

app.post('/api/pdf/watermark', upload.single('file'), async (req, res, next) => {
  try {
    const doc = await PDFDocument.load(await fs.readFile(req.file.path)); const font = await doc.embedFont(StandardFonts.HelveticaBold); const text = req.body.text || 'CONFIDENTIAL';
    doc.getPages().forEach(page => { const { width, height } = page.getSize(); page.drawText(text, { x: width * .16, y: height * .48, size: Math.min(48, width / Math.max(text.length, 1) * 1.5), font, color: rgb(.85, .12, .16), opacity: .25, rotate: degrees(35) }); });
    res.json({ filename: await writePdf(doc, 'watermarked'), originalName: req.file.originalname });
  } catch (error) { next(error); }
});

app.post('/api/pdf/page-numbers', upload.single('file'), async (req, res, next) => {
  try { const doc = await PDFDocument.load(await fs.readFile(req.file.path)); const font = await doc.embedFont(StandardFonts.Helvetica); doc.getPages().forEach((page, index) => { const { width } = page.getSize(); const label = `${index + 1}`; page.drawText(label, { x: width / 2 - 4, y: 22, size: 11, font, color: rgb(.15, .18, .3) }); }); res.json({ filename: await writePdf(doc, 'numbered'), originalName: req.file.originalname }); } catch (error) { next(error); }
});

app.post('/api/pdf/crop', upload.single('file'), async (req, res, next) => {
  try { const doc = await PDFDocument.load(await fs.readFile(req.file.path)); const percent = Math.min(20, Math.max(0, Number(req.body.margin || 5))) / 100; doc.getPages().forEach(page => { const { width, height } = page.getSize(); page.setCropBox(width * percent, height * percent, width * (1 - percent * 2), height * (1 - percent * 2)); }); res.json({ filename: await writePdf(doc, 'cropped'), originalName: req.file.originalname }); } catch (error) { next(error); }
});

app.post('/api/pdf/edit-text', upload.single('file'), async (req, res, next) => {
  try { const doc = await PDFDocument.load(await fs.readFile(req.file.path)); const font = await doc.embedFont(StandardFonts.Helvetica); const page = doc.getPages()[0]; page.drawText(req.body.text || 'Edited with Aharnish PDF', { x: 48, y: 48, size: 16, font, color: rgb(.08, .54, .5) }); res.json({ filename: await writePdf(doc, 'edited'), originalName: req.file.originalname }); } catch (error) { next(error); }
});

app.post('/api/pdf/forms', upload.single('file'), async (req, res, next) => {
  try { const doc = await PDFDocument.load(await fs.readFile(req.file.path)); const page = doc.getPages()[0]; const form = doc.getForm(); const field = form.createTextField(`aharnish_field_${Date.now()}`); field.setText(req.body.label || ''); field.addToPage(page, { x: 48, y: page.getHeight() - 95, width: 250, height: 28, borderColor: rgb(.08, .54, .5), borderWidth: 1 }); res.json({ filename: await writePdf(doc, 'form'), originalName: req.file.originalname }); } catch (error) { next(error); }
});

app.post('/api/pdf/to-jpg', upload.single('file'), async (req, res, next) => {
  try {
    const out = outputPath('pdf-page-1', 'jpg');
    await sharp(req.file.path, { density: 180, page: 0 }).jpeg({ quality: 90 }).toFile(out);
    res.json({ filename: path.basename(out), originalName: req.file.originalname });
  } catch (error) { next(error); }
});

app.post('/api/track-download', async (req, res, next) => {
  try { const { visitorId, toolUsed, originalFileName, fileSizeKb, downloadStatus = 'completed' } = req.body; await pool.execute('INSERT INTO download_logs (visitor_id, tool_used, original_file_name, file_size_kb, download_status) VALUES (?, ?, ?, ?, ?)', [visitorId || null, toolUsed, originalFileName, fileSizeKb || 0, downloadStatus]); res.status(201).json({ ok: true }); } catch (error) { next(error); }
});
app.get('/api/download/:filename', async (req, res, next) => { try { const filename = safeName(req.params.filename); const file = path.join(tempDir, filename); await fs.access(file); res.download(file); } catch (error) { next(error); } });
setInterval(async () => { const cutoff = Date.now() - 30 * 60 * 1000; for (const file of await fs.readdir(tempDir)) { const full = path.join(tempDir, file); if ((await fs.stat(full)).mtimeMs < cutoff) await fs.unlink(full); } }, 10 * 60 * 1000).unref();
app.use((error, req, res, next) => { console.error(error); res.status(400).json({ error: error.message || 'Unable to process this file.' }); });
initializeDatabase().then(() => app.listen(process.env.PORT || 5000, () => console.log('API ready'))).catch(err => { console.error('Database setup failed:', err.message); process.exit(1); });
