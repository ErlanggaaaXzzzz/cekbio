import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import dotenv from 'dotenv';
import qrcode from 'qrcode';

import makeWASocket, { 
  DisconnectReason, 
  useMultiFileAuthState, 
  fetchLatestBaileysVersion 
} from '@whiskeysockets/baileys';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server);

const waClients = {};

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { message: 'Terlalu banyak request dari IP Anda.' }
});
app.use('/api/', limiter);

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB Connected Successfully'))
  .catch(err => console.error('Database Connection Error:', err));

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, default: 'user' },
  status: { type: String, default: 'active' },
  sessionName: { type: String }
}, { timestamps: true });

const User = mongoose.model('User', UserSchema);

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Akses ditolak' });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: 'Token tidak valid' });
    req.user = user;
    next();
  });
};

app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || password.length < 8) {
      return res.status(400).json({ message: 'Validasi gagal. Password wajib minimal 8 karakter.' });
    }
    const encryptedPassword = await bcrypt.hash(password, 10);
    const newUser = await User.create({
      username,
      email,
      password: encryptedPassword,
      sessionName: username.toLowerCase().replace(/[^a-z0-9]/g, '')
    });
    res.status(201).json({ message: 'User berhasil didaftarkan', userId: newUser._id });
  } catch (error) {
    res.status(400).json({ message: 'Username atau email sudah digunakan.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(400).json({ message: 'Kredensial salah.' });
    }
    const token = jwt.sign({ id: user._id, username: user.username, sessionName: user.sessionName }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.json({ token });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/user/profile', authenticateToken, async (req, res) => {
  const user = await User.findById(req.user.id).select('-password');
  res.json(user);
});

const initWhatsApp = async (sessionName, userId, method = 'qr', phoneNumber = '') => {
  if (waClients[sessionName] && waClients[sessionName].sock) {
    return waClients[sessionName];
  }

  const sessionPath = path.join(__dirname, 'sessions', sessionName);
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket.default({
    version,
    auth: state,
    printQRInTerminal: false,
    phoneNumber: method === 'pairing' ? phoneNumber : undefined,
    defaultQueryTimeoutMs: undefined
  });

  waClients[sessionName] = { sock, status: 'connecting', qr: null, pairingCode: null };

  sock.ev.on('creds.update', saveCreds);

  if (method === 'pairing' && !sock.authState.creds.registered && phoneNumber) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        waClients[sessionName].pairingCode = code;
        io.to(userId).emit('whatsapp_pairing_code', { code });
      } catch (err) {
        console.error('Gagal meminta pairing code dari server WhatsApp:', err);
      }
    }, 2000);
  }
  
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr && method === 'qr') {
      const qrDataUrl = await qrcode.toDataURL(qr);
      waClients[sessionName].qr = qrDataUrl;
      waClients[sessionName].status = 'disconnected';
      io.to(userId).emit('whatsapp_qr', { qr: qrDataUrl });
      io.to(userId).emit('whatsapp_status', { status: 'disconnected' });
    }

    if (connection === 'connecting') {
      waClients[sessionName].status = 'connecting';
      io.to(userId).emit('whatsapp_status', { status: 'connecting' });
    }

    if (connection === 'open') {
      waClients[sessionName].status = 'connected';
      waClients[sessionName].qr = null;
      waClients[sessionName].pairingCode = null;
      io.to(userId).emit('whatsapp_status', { status: 'connected' });
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      waClients[sessionName].status = 'disconnected';
      io.to(userId).emit('whatsapp_status', { status: 'disconnected' });
      
      if (shouldReconnect) {
        initWhatsApp(sessionName, userId, 'qr', '');
      } else {
        fs.rmSync(sessionPath, { recursive: true, force: true });
        delete waClients[sessionName];
      }
    }
  });

  return waClients[sessionName];
};

app.get('/api/whatsapp/status', authenticateToken, (req, res) => {
  const client = waClients[req.user.sessionName];
  res.json({ status: client ? client.status : 'disconnected' });
});

app.post('/api/whatsapp/connect', authenticateToken, async (req, res) => {
  try {
    const { method, phoneNumber } = req.body;
    const client = await initWhatsApp(req.user.sessionName, req.user.id, method, phoneNumber);
    
    if(method === 'qr' && client.qr && client.status === 'disconnected') {
      io.to(req.user.id).emit('whatsapp_qr', { qr: client.qr });
    } else if (method === 'pairing' && client.pairingCode) {
      io.to(req.user.id).emit('whatsapp_pairing_code', { code: client.pairingCode });
    }
    res.json({ message: 'Proses inisialisasi dimulai' });
  } catch (err) {
    res.status(500).json({ message: 'Gagal inisialisasi engine WA.' });
  }
});

app.post('/api/whatsapp/disconnect', authenticateToken, async (req, res) => {
  const client = waClients[req.user.sessionName];
  if(client && client.sock) {
    try { client.sock.logout(); } catch(e){}
    delete waClients[req.user.sessionName];
  }
  res.json({ message: 'Terputus dari sistem WhatsApp' });
});

app.delete('/api/whatsapp/session', authenticateToken, async (req, res) => {
  const client = waClients[req.user.sessionName];
  if(client && client.sock) {
    try { client.sock.end(); } catch(e){}
    delete waClients[req.user.sessionName];
  }
  const sessionPath = path.join(__dirname, 'sessions', req.user.sessionName);
  fs.rmSync(sessionPath, { recursive: true, force: true });
  res.json({ message: 'Data session dibersihkan total' });
});

// --- ADVANCED ADVANCED BULK WORKER ENDPOINT ---
app.get('/api/whatsapp/cekbio', authenticateToken, async (req, res) => {
  const client = waClients[req.user.sessionName];
  if (!client || client.status !== 'connected') {
    return res.status(400).json({ message: 'WhatsApp Anda belum terhubung. Silakan koneksikan terlebih dahulu.' });
  }

  let target = req.query.jid;
  if (!target) return res.status(400).json({ message: 'Parameter jid target dibutuhkan.' });
  
  target = target.replace(/[^0-9]/g, '');
  let targetJid = `${target}@s.whatsapp.net`;

  try {
    // 1. Cek Apakah Nomor Terdaftar di WhatsApp (onWhatsApp)
    const [exists] = await client.sock.onWhatsApp(targetJid);
    
    if (!exists || !exists.exists) {
      return res.json({
        jid: target,
        registered: 'Tidak Terdaftar',
        type: '-',
        verified: '-',
        bio: '-',
        setAt: '-',
        age: '-'
      });
    }

    // 2. Jika Terdaftar, Lanjutkan Tarik Data Bio
    let bioData = { status: "(Tidak ada bio)", setAt: null };
    try { 
      const fetchBio = await client.sock.fetchStatus(targetJid);
      if (fetchBio) bioData = fetchBio;
    } catch(e){}

    // 3. Cek Profil Bisnis & Status Meta Verified
    let type = "Messenger";
    let verified = "No";
    try {
      const bizProfile = await client.sock.getBusinessProfile(targetJid);
      if (bizProfile) {
        type = "Business";
        if (bizProfile.verified_level || bizProfile.brands) verified = "Yes";
      }
    } catch(e){}

    // 4. Kalkulasi Estimasi Tanggal & Umur Pendaftaran Nomor
    let estimasiTgl = "Tidak Diketahui";
    let umurNomor = "Tidak Diketahui";

    if (bioData && bioData.setAt) {
      const dateObj = new Date(bioData.setAt);
      estimasiTgl = dateObj.toLocaleDateString('id-ID');
      
      const diffTime = Math.abs(new Date() - dateObj);
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      
      if(diffDays > 365) {
        umurNomor = `${Math.floor(diffDays/365)} Tahun ${Math.floor((diffDays%365)/30)} Bulan`;
      } else {
        umurNomor = `${Math.floor(diffDays/30)} Bulan ${diffDays%30} Hari`;
      }
    } else {
      estimasiTgl = "Estimasi > 1 Tahun lalu";
      umurNomor = "Aktif (Lama)";
    }

    res.json({
      jid: target,
      registered: 'Terdaftar',
      type,
      verified,
      bio: bioData.status || "(Kosong)",
      setAt: estimasiTgl,
      age: umurNomor
    });

  } catch (error) {
    res.status(500).json({ message: 'Gagal memproses validasi nomor' });
  }
});

const adminSecurityCheck = (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (ip === '::1' || ip === '127.0.0.1' || ip.includes('localhost')) {
    next();
  } else {
    res.status(404).send('Not Found');
  }
};

app.get('/admin', adminSecurityCheck, async (req, res) => {
  try {
    const users = await User.find().select('-password');
    const activeSessionsCount = Object.keys(waClients).length;
    
    let userRows = users.map(u => `
      <tr style="border-bottom: 1px solid rgba(255,255,255,.05);">
        <td style="padding: 12px;">${u.username}</td>
        <td style="padding: 12px;">${u.email}</td>
        <td style="padding: 12px;">${u.role}</td>
        <td style="padding: 12px; color: #10B981;">${u.status}</td>
      </tr>
    `).join('');

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>CekBio Hyper-Admin Panel</title>
        <style>
          body { background: #09090B; color: #fff; font-family: sans-serif; padding: 3rem; }
          .metrics { display: flex; gap: 2rem; margin-bottom: 2rem; }
          .card { background: #111113; border: 1px solid rgba(255,255,255,.08); padding: 1.5rem; border-radius: 12px; flex: 1; }
          table { width: 100%; border-collapse: collapse; background: #111113; border-radius: 12px; overflow: hidden; }
          th { background: rgba(255,255,255,.03); text-align: left; padding: 12px; color: #9CA3AF; }
        </style>
      </head>
      <body>
        <h1>Admin Control Tower</h1>
        <p style="color: #9CA3AF;">Akses lokal terbatas (Localhost Security Active)</p>
        <div class="metrics">
          <div class="card"><h3>Total Pengguna</h3><p style="font-size: 2rem; color: #5B8CFF;">${users.length}</p></div>
          <div class="card"><h3>Active Memory Sessions</h3><p style="font-size: 2rem; color: #10B981;">${activeSessionsCount}</p></div>
        </div>
        <table>
          <thead><tr><th>Username</th><th>Email</th><th>Role</th><th>Status</th></tr></thead>
          <tbody>${userRows}</tbody>
        </table>
      </body>
      </html>
    `);
  } catch(e) {
    res.status(500).send('Admin layer breakdown.');
  }
});

app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/regis.html', (req, res) => res.sendFile(path.join(__dirname, 'regis.html')));
app.get('/script.js', (req, res) => res.sendFile(path.join(__dirname, 'script.js')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/', (req, res) => res.redirect('/login.html'));

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error("Authentication error"));
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return next(new Error("Authentication error"));
    socket.userId = decoded.id;
    next();
  });
});

io.on('connection', (socket) => {
  socket.join(socket.userId);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`CekBio Core Server running smoothly on platform port ${PORT}`);
});
