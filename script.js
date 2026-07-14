const token = localStorage.getItem('token');
if (!token) {
  window.location.href = '/login.html';
}

const socket = io({
  auth: { token }
});

// Navigation Handling
function switchView(viewName) {
  document.querySelectorAll('.view-section').forEach(sec => sec.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
  
  const activeSection = document.getElementById(`${viewName}View`);
  if (activeSection) activeSection.classList.add('active');
  
  // Highlighting active nav item
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(item => {
    if(item.textContent.toLowerCase().includes(viewName === 'cekbio' ? 'cek bio' : viewName)) {
      item.classList.add('active');
    }
  });

  if(viewName === 'profile') loadProfileData();
  if(viewName === 'session') checkCurrentStatus();
}

function logout() {
  localStorage.removeItem('token');
  window.location.href = '/login.html';
}

// Fetch Profile Data
async function loadProfileData() {
  try {
    const res = await fetch('/api/user/profile', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if(!res.ok) throw new Error();
    const data = await res.json();
    document.getElementById('profUser').textContent = data.username;
    document.getElementById('profEmail').textContent = data.email;
    document.getElementById('profDate').textContent = new Date(data.createdAt).toLocaleDateString('id-ID');
  } catch {
    logout();
  }
}

// WhatsApp Actions
async function checkCurrentStatus() {
  try {
    const res = await fetch('/api/whatsapp/status', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    updateStatusBadge(data.status);
  } catch (err) { console.error(err); }
}

// Handler visibility input form berdasarkan tipe auth
function toggleMethodInputs() {
  const method = document.getElementById('authMethod').value;
  const pairingWrapper = document.getElementById('pairingNumberInputWrapper');
  if (method === 'pairing') {
    pairingWrapper.style.display = 'block';
  } else {
    pairingWrapper.style.display = 'none';
  }
}

// Reset visual container penautan
function resetAuthVisuals() {
  document.getElementById('qrWrapper').style.display = 'none';
  document.getElementById('pairingWrapper').style.display = 'none';
  document.getElementById('connectionMethodArea').style.display = 'block';
}

async function triggerConnect() {
  const method = document.getElementById('authMethod').value;
  let phoneNumber = '';

  if (method === 'pairing') {
    phoneNumber = document.getElementById('myPhoneNumber').value.trim();
    if (!phoneNumber) {
      alert('Masukkan nomor WhatsApp Anda terlebih dahulu untuk meminta pairing code!');
      return;
    }
    phoneNumber = phoneNumber.replace(/[^0-9]/g, '');
  }

  updateStatusBadge('connecting');
  document.getElementById('qrWrapper').style.display = 'none';
  document.getElementById('pairingWrapper').style.display = 'none';

  await fetch('/api/whatsapp/connect', {
    method: 'POST',
    headers: { 
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json' 
    },
    body: JSON.stringify({ method, phoneNumber })
  });
}

async function triggerDisconnect() {
  await fetch('/api/whatsapp/disconnect', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` }
  });
  updateStatusBadge('disconnected');
  resetAuthVisuals();
}

async function triggerDeleteSession() {
  if(confirm('Hapus seluruh konfigurasi session permanen?')) {
    await fetch('/api/whatsapp/session', {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    updateStatusBadge('disconnected');
    resetAuthVisuals();
  }
}

// Cek Bio Processor
async function prosesCekBio() {
  const target = document.getElementById('targetJid').value.trim();
  const loading = document.getElementById('cekLoading');
  const resultDiv = document.getElementById('cekResult');
  
  if(!target) return alert('Masukkan nomor target!');
  
  loading.style.display = 'block';
  resultDiv.style.display = 'none';
  
  try {
    const res = await fetch(`/api/whatsapp/cekbio?jid=${target}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.message || 'Gagal mengambil bio');
    
    document.getElementById('resJid').textContent = data.jid;
    document.getElementById('resBio').textContent = data.bio || '(Tidak Ada Bio)';
    document.getElementById('resTime').textContent = data.setAt ? new Date(data.setAt).toLocaleString('id-ID') : '-';
    resultDiv.style.display = 'block';
  } catch (err) {
    alert(err.message);
  } finally {
    loading.style.display = 'none';
  }
}

// Socket updates
socket.on('whatsapp_status', (data) => {
  updateStatusBadge(data.status);
});

socket.on('whatsapp_qr', (data) => {
  if(data.qr) {
    document.getElementById('connectionMethodArea').style.display = 'none';
    document.getElementById('pairingWrapper').style.display = 'none';
    
    const qrWrapper = document.getElementById('qrWrapper');
    const qrContainer = document.getElementById('qrContainer');
    qrWrapper.style.display = 'block';
    qrContainer.innerHTML = `<img src="${data.qr}" alt="WA QR Code">`;
  }
});

socket.on('whatsapp_pairing_code', (data) => {
  if(data.code) {
    document.getElementById('connectionMethodArea').style.display = 'none';
    document.getElementById('qrWrapper').style.display = 'none';
    
    const pairingWrapper = document.getElementById('pairingWrapper');
    const codeContainer = document.getElementById('pairingCodeContainer');
    pairingWrapper.style.display = 'block';
    codeContainer.textContent = data.code;
  }
});

function updateStatusBadge(status) {
  const badge = document.getElementById('whatsappStatus');
  if(!badge) return;
  badge.className = 'status-badge';
  badge.textContent = status.toUpperCase();
  
  if (status === 'connected') {
    badge.classList.add('status-connected');
    document.getElementById('qrWrapper').style.display = 'none';
    document.getElementById('pairingWrapper').style.display = 'none';
    document.getElementById('connectionMethodArea').style.display = 'none';
  } else if (status === 'connecting') {
    badge.classList.add('status-connecting');
  } else {
    badge.classList.add('status-disconnected');
    // Jika memang terputus dan tidak sedang loading, tampilkan opsi penautan kembali
    if (document.getElementById('qrWrapper').style.display === 'none' && 
        document.getElementById('pairingWrapper').style.display === 'none') {
      document.getElementById('connectionMethodArea').style.display = 'block';
    }
  }
}
