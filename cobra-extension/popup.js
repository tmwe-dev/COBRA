// P1-10: versione unificata da manifest
document.getElementById('extVersion').textContent = 'v' + chrome.runtime.getManifest().version;

// Check connection status — verifica sia server che bridge WS
async function checkStatus() {
  try {
    const [verResp, brResp] = await Promise.all([
      fetch('http://127.0.0.1:3000/api/version'),
      fetch('http://127.0.0.1:3000/api/bridge-status')
    ]);
    if (!verResp.ok) throw new Error('Server down');
    const ver = await verResp.json();
    const bridge = brResp.ok ? await brResp.json() : { connected: false };

    if (bridge.connected) {
      document.getElementById('status').className = 'status connected';
      document.getElementById('dot').className = 'dot on';
      document.getElementById('statusText').textContent = `Connesso — COBRA v${ver.version}`;
    } else {
      document.getElementById('status').className = 'status disconnected';
      document.getElementById('dot').className = 'dot off';
      document.getElementById('statusText').textContent = `Server OK — Bridge WS disconnesso`;
    }
  } catch {
    document.getElementById('status').className = 'status disconnected';
    document.getElementById('dot').className = 'dot off';
    document.getElementById('statusText').textContent = 'Server non raggiungibile';
  }
}

document.getElementById('openCobra').addEventListener('click', () => {
  chrome.tabs.create({ url: 'http://127.0.0.1:3000' });
});

checkStatus();
