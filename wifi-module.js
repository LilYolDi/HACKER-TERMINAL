
(() => {
  'use strict';

  const selector = document.getElementById('modeSelector');
  const buttonsBox = selector?.querySelector('.mode-buttons');
  const locationPanel = document.getElementById('locationPanel');

  if (!selector || !buttonsBox || !locationPanel) return;

  if (/^\/(connect|ip|location)\//.test(location.pathname)) return;

  const modeButton = document.createElement('button');
  modeButton.id = 'wifiModeButton';
  modeButton.className = 'mode-button';
  modeButton.type = 'button';
  modeButton.textContent = '04 // WI-FI AUDIT';
  buttonsBox.appendChild(modeButton);

  const panel = document.createElement('section');
  panel.id = 'wifiPanel';
  panel.className = 'panel mode-panel hidden';

  panel.innerHTML = `
    <h2 class="section-title">WI-FI AUDIT SYSTEM</h2>

    <p class="description">
      Локальная диагностика Wi-Fi адаптера и сетей Windows.
    </p>

    <div class="wifi-agent-box">
      <div class="wifi-agent-title">LOCAL AGENT CONNECTION</div>

      <label for="wifiToken">ACCESS TOKEN</label>
      <input id="wifiToken" type="password"
        placeholder="Вставь токен из окна wifi-agent.js"
        autocomplete="off">

      <button id="wifiCheckAgent" class="main-button" type="button">
        CHECK AGENT CONNECTION
      </button>

      <div id="wifiAgentStatus" class="device-info">
        AGENT NOT CONNECTED
      </div>
    </div>

    <div class="wifi-actions">
      <button id="wifiScan" type="button">01 // WIFI SCANNER</button>
      <button id="wifiSecurity" type="button">02 // SECURITY AUDIT</button>
      <button id="wifiWps" type="button">03 // WPS STATUS</button>
      <button id="wifiReport" type="button">04 // GENERATE REPORT</button>
    </div>

    <div class="wifi-agent-box">
      <div class="wifi-agent-title">CONNECT SAVED WIFI PROFILE</div>

      <label for="wifiProfile">SAVED PROFILE NAME</label>
      <input id="wifiProfile" type="text"
        placeholder="Название сохранённого профиля">

      <button id="wifiConnect" class="main-button" type="button">
        CONNECT
      </button>
    </div>

    <div class="wifi-agent-box">
      <div class="wifi-agent-title">PASSWORD STRENGTH AUDIT</div>

      <label for="wifiPassword">ENTER PASSWORD FOR LOCAL CHECK</label>
      <input id="wifiPassword" type="password"
        placeholder="Пароль проверяется только в браузере"
        autocomplete="off">

      <button id="wifiPasswordCheck" class="main-button" type="button">
        CHECK PASSWORD STRENGTH
      </button>

      <div id="wifiPasswordResult" class="device-info">
        WAITING FOR INPUT
      </div>
    </div>

    <div class="wifi-agent-box">
      <div class="wifi-agent-title">SCAN RESULTS</div>
      <pre id="wifiOutput" class="wifi-output">WAITING FOR COMMAND...</pre>
    </div>
  `;

  locationPanel.insertAdjacentElement('afterend', panel);

  const $ = id => document.getElementById(id);

  function log(message) {
    if (typeof window.log === 'function') {
      window.log(message);
    }
  }

  function switchToWifi() {
    ['ipPanel', 'hostPanel', 'locationPanel'].forEach(id => {
      $(id)?.classList.add('hidden');
    });

    document.querySelectorAll('.mode-button').forEach(button => {
      button.classList.remove('active');
    });

    modeButton.classList.add('active');
    panel.classList.remove('hidden');

    log('WI-FI AUDIT mode activated.');
  }

  modeButton.addEventListener('click', switchToWifi);

  ['ipModeButton', 'phoneModeButton', 'locationModeButton'].forEach(id => {
    $(id)?.addEventListener('click', () => {
      panel.classList.add('hidden');
      modeButton.classList.remove('active');
    });
  });

  function output(value) {
    $('wifiOutput').textContent =
      typeof value === 'string'
        ? value
        : JSON.stringify(value, null, 2);
  }

  function token() {
    return $('wifiToken').value.trim();
  }

  async function request(endpoint, options = {}) {
    const accessToken = token();

    if (!accessToken) {
      throw new Error('Сначала вставь ACCESS TOKEN из окна агента.');
    }

    const response = await fetch(
      'http://127.0.0.1:8765' + endpoint,
      {
        method: options.method || 'GET',
        headers: {
          'Authorization': 'Bearer ' + accessToken,
          ...(options.body ? { 'Content-Type': 'application/json' } : {})
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        credentials: 'omit'
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Agent request failed.');
    }

    return data;
  }

  async function checkAgent() {
    $('wifiAgentStatus').textContent = 'CONNECTING...';

    try {
      const result = await request('/health');

      $('wifiAgentStatus').textContent =
        result.online ? 'AGENT ONLINE' : 'AGENT OFFLINE';

      log('Local Wi-Fi agent connected.', 'green');
    } catch (error) {
      $('wifiAgentStatus').textContent = error.message;
    }
  }

  async function getAudit() {
    $('wifiOutput').textContent = 'SCANNING...';
    return request('/api/audit');
  }

  $('wifiCheckAgent').addEventListener('click', checkAgent);

  $('wifiScan').addEventListener('click', async () => {
    try {
      const data = await getAudit();
      output(data.results.available_networks);
      log('Wi-Fi scan completed.', 'green');
    } catch (error) {
      output(error.message);
    }
  });

  $('wifiSecurity').addEventListener('click', async () => {
    try {
      const data = await getAudit();

      output({
        interfaces: data.results.interfaces,
        drivers: data.results.drivers,
        adapters: data.results.adapters,
        firewall: data.results.firewall
      });

      log('Wi-Fi security diagnostics completed.', 'green');
    } catch (error) {
      output(error.message);
    }
  });

  $('wifiWps').addEventListener('click', async () => {
    try {
      const data = await getAudit();

      output(
        'AVAILABLE NETWORKS:\n' +
        data.results.available_networks +
        '\n\nWPS STATUS:\n' +
        'Windows does not reliably report router WPS status. ' +
        'Check WPS in the administration panel of your own router.'
      );
    } catch (error) {
      output(error.message);
    }
  });

  $('wifiReport').addEventListener('click', async () => {
    try {
      const result = await request('/api/report');
      output('REPORT SAVED:\n' + result.savedTo);
      log('Wi-Fi report saved.', 'green');
    } catch (error) {
      output(error.message);
    }
  });

  $('wifiConnect').addEventListener('click', async () => {
    const profile = $('wifiProfile').value.trim();

    if (!profile) {
      output('Enter a saved Wi-Fi profile name.');
      return;
    }

    try {
      const result = await request('/api/connect', {
        method: 'POST',
        body: { profile }
      });

      output(result.output || 'Connection command sent.');
      log('Wi-Fi connection command sent.');
    } catch (error) {
      output(error.message);
    }
  });

  $('wifiPasswordCheck').addEventListener('click', () => {
    const password = $('wifiPassword').value;
    let score = 0;

    if (password.length >= 12) score++;
    if (/[a-z]/.test(password)) score++;
    if (/[A-Z]/.test(password)) score++;
    if (/[0-9]/.test(password)) score++;
    if (/[^a-zA-Z0-9]/.test(password)) score++;

    let strength = 'WEAK';

    if (score >= 4) strength = 'STRONG';
    else if (score === 3) strength = 'MEDIUM';

    $('wifiPasswordResult').textContent =
      'LENGTH: ' + password.length +
      '\nSTRENGTH: ' + strength +
      '\nCHECKED LOCALLY IN YOUR BROWSER.';

    $('wifiPassword').value = '';
  });

  log('WI-FI AUDIT module loaded.');
})();
