const token = localStorage.getItem('token');
if (!token) {
  window.location.href = '/login.html';
}

const socket = io({
  auth: { token }
});

let globalResults = [];
let checkingActive = false;
let countValid = 0;
let countInvalid = 0;

// Navigation Handling
function switchView(viewName) {
  document.querySelectorAll('.view-section').forEach(sec => sec.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
  
  const activeSection = document.getElementById(`${viewName}View`);
  if (activeSection) activeSection.classList.add('active');
  
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(item => {
    if(item.textContent.toLowerCase().includes(viewName === 'bulkcek' ? 'bulk checker' : viewName)) {
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

function toggleMethodInputs() {
  const method = document.getElementById('authMethod').value;
  const pairingWrapper = document.getElementById('pairingNumberInputWrapper');
  if (method === 'pairing') {
    pairingWrapper.style.display = 'block';
  } else {
    pairingWrapper.style.display = 'none';
  }
}

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

// Handle upload text file nomor ke textarea
function handleFileUpload() {
  const fileInput = document.getElementById('fileTxt');
  const reader = new FileReader();
  reader.onload = function(e) {
    document.getElementById('manualList').value = e.target.result;
  };
  if(fileInput.files[0]) reader.readAsText(fileInput.files[0]);
}

// Core Bulk Processing
async function startBulkCheck() {
  const listRaw = document.getElementById('manualList').value;
  const numbers = listRaw.split('\n').map(n => n.trim().replace(/[^0-9]/g, '')).filter(n => n.length > 5);
  
  if(numbers.length === 0) return alert('Tidak ada nomor valid untuk dicek.');
  
  const delayType = document.getElementById('delaySetting').value;
  let delays = { superfast: 1500, fast: 3500, medium: 6000 };
  let currentDelay = delays[delayType];

  checkingActive = true;
  globalResults = [];
  countValid = 0;
  countInvalid = 0;
  
  document.getElementById('counterValid').textContent = '0';
  document.getElementById('counterInvalid').textContent = '0';
  document.getElementById('resultTableBody').innerHTML = '';
  document.getElementById('progressWrapper').style.display = 'block';
  document.getElementById('btnDownload').style.display = 'none';

  for(let i = 0; i < numbers.length; i++) {
    if(!checkingActive) break;

    let percent = Math.round(((i + 1) / numbers.length) * 100);
    document.getElementById('progressBar').style.width = percent + '%';
    document.getElementById('progressPercent').textContent = percent + '%';
    document.getElementById('progressLabel').textContent = `Memproses: ${i+1} dari ${numbers.length} nomor`;

    try {
      const response = await fetch(`/api/whatsapp/cekbio?jid=${numbers[i]}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const resData = await response.json();

      if(response.ok) {
        if(resData.registered === 'Terdaftar') {
          countValid++;
          document.getElementById('counterValid').textContent = countValid;
        } else {
          countInvalid++;
          document.getElementById('counterInvalid').textContent = countInvalid;
        }
        appendTableRow(resData);
        globalResults.push(resData);
      } else {
        countInvalid++;
        document.getElementById('counterInvalid').textContent = countInvalid;
        appendTableRow({ jid: numbers[i], registered: 'Tidak Terdaftar', type: '-', verified: '-', bio: '-', setAt: '-', age: '-' });
      }
    } catch (e) {
      countInvalid++;
      document.getElementById('counterInvalid').textContent = countInvalid;
      appendTableRow({ jid: numbers[i], registered: 'Error Network', type: '-', verified: '-', bio: '-', setAt: '-', age: '-' });
    }

    await new Promise(resolve => setTimeout(resolve, currentDelay));
  }

  checkingActive = false;
  document.getElementById('progressLabel').textContent = 'Pengecekan Selesai!';
  if(globalResults.length > 0) document.getElementById('btnDownload').style.display = 'inline-flex';
}

function stopBulkCheck() {
  checkingActive = false;
  document.getElementById('progressLabel').textContent = 'Pengecekan dihentikan oleh pengguna.';
}

function appendTableRow(data) {
  const tbody = document.getElementById('resultTableBody');
  const row = document.createElement('tr');
  const statusColor = data.registered === 'Terdaftar' ? '#10B981' : '#EF4444';

  row.innerHTML = `
    <td><b>${data.jid}</b></td>
    <td><span style="padding: 0.25rem 0.5rem; border-radius: 6px; font-size: 0.8rem; font-weight: 700; background: ${statusColor}1A; color: ${statusColor}">${data.registered}</span></td>
    <td><span style="color: ${data.type === 'Business' ? '#F59E0B' : '#10B981'}">${data.type}</span></td>
    <td><span style="color: ${data.verified === 'Yes' ? '#5B8CFF' : '#9CA3AF'}">${data.verified}</span></td>
    <td style="max-width:200px; overflow:hidden; text-overflow:ellipsis;">${data.bio}</td>
    <td>${data.setAt}</td>
    <td><span style="font-weight:600; color:var(--success);">${data.age}</span></td>
  `;
  tbody.appendChild(row);
}

function downloadResults() {
  let csvContent = "data:text/csv;charset=utf-8,Nomor,Status Akun,Tipe WA,Meta Verified,Bio,Estimasi Tgl Daftar,Umur Nomor\n";
  globalResults.forEach(r => {
    csvContent += `"${r.jid}","${r.registered}","${r.type}","${r.verified}","${r.bio}","${r.setAt}","${r.age}"\n`;
  });
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `Hasil_CekBio_Massal_${Date.now()}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
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
    if (document.getElementById('qrWrapper').style.display === 'none' && 
        document.getElementById('pairingWrapper').style.display === 'none') {
      document.getElementById('connectionMethodArea').style.display = 'block';
    }
  }
}
