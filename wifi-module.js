
(() => {
  'use strict';

  const $ = id => document.getElementById(id);

  const selector = $('modeSelector');
  const buttonsBox = selector?.querySelector('.mode-buttons');
  const locationPanel = $('locationPanel');

  if (!selector || !buttonsBox || !locationPanel) return;
  if (/^\/(connect|ip|location)\//.test(location.pathname)) return;
  if ($('wifiPanel')) return;

  let modeButton = $('wifiModeButton');

  if (!modeButton) {
    modeButton = document.createElement('button');
    modeButton.id = 'wifiModeButton';
    modeButton.className = 'mode-button';
    modeButton.type = 'button';
    modeButton.textContent = '04 // ВЗЛОМ WI-FI';
    buttonsBox.appendChild(modeButton);
  }

  const panel = document.createElement('section');
  panel.id = 'wifiPanel';
  panel.className = 'panel mode-panel hidden';

  panel.innerHTML = `
    <h2 class="section-title">WI-FI NETWORK SCANNER</h2>
    <p class="description">
      Поиск доступных сетей и проверка подключения к собственной сети.
    </p>

    <div class="wifi-agent-box">
      <div class="wifi-agent-title">ПОДКЛЮЧЕНИЕ К ПОМОЩНИКУ</div>

      <label for="wifiToken">ACCESS TOKEN</label>
      <input id="wifiToken" type="password"
        placeholder="Токен локального помощника"
        autocomplete="off">

      <button id="wifiCheckAgent" class="main-button" type="button">
        ПОДКЛЮЧИТЬ ПОМОЩНИКА
      </button>

      <div id="wifiAgentStatus" class="device-info">
        ПОМОЩНИК НЕ ПОДКЛЮЧЁН
      </div>
    </div>

    <div class="wifi-agent-box">
      <div class="wifi-agent-title">ДОСТУПНЫЕ WI-FI СЕТИ</div>

      <button id="wifiScan" class="main-button" type="button">
        ОБНОВИТЬ СПИСОК СЕТЕЙ
      </button>

      <div id="wifiNetworkList" style="
        display:grid;gap:9px;margin-top:15px;">
        <div class="device-info">Нажми «Обновить список сетей»</div>
      </div>

      <div id="wifiSelectedNetwork" class="device-info"
        style="margin-top:12px;">
        СЕТЬ НЕ ВЫБРАНА
      </div>
    </div>

    <div class="wifi-agent-box">
      <div class="wifi-agent-title">ПРОВЕРКА ПАРОЛЯ И ПОДКЛЮЧЕНИЕ</div>

      <label for="wifiPassword">ПАРОЛЬ ВЫБРАННОЙ СЕТИ</label>
      <input id="wifiPassword" type="password"
        placeholder="Введи предполагаемый пароль"
        autocomplete="off">

      <button id="wifiPasswordCheck" class="main-button" type="button">
        ПРОВЕРИТЬ И ПОДКЛЮЧИТЬ
      </button>

      <div id="wifiPasswordResult" class="device-info">
        ОЖИДАНИЕ ВЫБОРА СЕТИ
      </div>
    </div>

    <div class="wifi-actions">
      <button id="wifiSecurity" type="button">SECURITY AUDIT</button>
      <button id="wifiWps" type="button">WPS STATUS</button>
      <button id="wifiReport" type="button">GENERATE REPORT</button>
    </div>

    <div class="wifi-agent-box">
      <div class="wifi-agent-title">РЕЗУЛЬТАТ</div>
      <pre id="wifiOutput" class="wifi-output">СИСТЕМА ГОТОВА</pre>
    </div>
  `;

  locationPanel.insertAdjacentElement('afterend', panel);

  let selectedSSID = '';
  let networks = [];

  function log(message) {
    if (typeof window.log === 'function') window.log(message);
  }

  function output(message) {
    $('wifiOutput').textContent =
      typeof message === 'string'
        ? message
        : JSON.stringify(message, null, 2);
  }

  function status(message) {
    $('wifiPasswordResult').textContent = message;
  }

  function switchToWifi() {
    [
      'ipPanel',
      'hostPanel',
      'locationPanel',
      'visitorPanel',
      'guestPanel'
    ].forEach(id => $(id)?.classList.add('hidden'));

    document.querySelectorAll('.mode-button').forEach(button => {
      button.classList.remove('active');
    });

    modeButton.classList.add('active');
    panel.classList.remove('hidden');
    log('WI-FI mode activated.');
  }

  modeButton.addEventListener('click', switchToWifi);

  [
    'ipModeButton',
    'phoneModeButton',
    'locationModeButton'
  ].forEach(id => {
    $(id)?.addEventListener('click', () => {
      panel.classList.add('hidden');
      modeButton.classList.remove('active');
    });
  });

  function token() {
    return $('wifiToken').value.trim();
  }

  async function request(endpoint, options = {}) {
    const accessToken = token();

    if (!accessToken) {
      throw new Error('Введи ACCESS TOKEN локального помощника.');
    }

    const response = await fetch(
      'http://127.0.0.1:8765' + endpoint,
      {
        method: options.method || 'GET',
        headers: {
          Authorization: 'Bearer ' + accessToken,
          ...(options.body ? {
            'Content-Type': 'application/json'
          } : {})
        },
        body: options.body
          ? JSON.stringify(options.body)
          : undefined,
        credentials: 'omit'
      }
    );

    let data;

    try {
      data = await response.json();
    } catch {
      throw new Error('Помощник вернул некорректный ответ.');
    }

    if (!response.ok) {
      throw new Error(data.error || 'Ошибка локального помощника.');
    }

    return data;
  }

  function parseNetworks(raw) {
    const lines = String(raw || '').split(/\r?\n/);
    const found = [];

    for (const line of lines) {
      const match = line.match(/^\s*SSID\s+\d+\s*:\s*(.*)$/i);

      if (match) {
        const name = match[1].trim();

        if (name && !found.includes(name)) {
          found.push(name);
        }
      }
    }

    return found;
  }

  function renderNetworks() {
    const list = $('wifiNetworkList');
    list.innerHTML = '';

    if (!networks.length) {
      list.textContent =
        'Сети не найдены или формат ответа Windows не распознан.';
      return;
    }

    networks.forEach(ssid => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '◉  ' + ssid;
      button.style.cssText = `
        width:100%;
        padding:13px;
        text-align:left;
        border:1px solid var(--border);
        background:#030904;
        color:var(--green);
        cursor:pointer;
        font:inherit;
      `;

      button.addEventListener('click', () => {
        selectedSSID = ssid;

        [...list.children].forEach(item => {
          item.style.borderColor = 'var(--border)';
        });

        button.style.borderColor = 'var(--green)';

        $('wifiSelectedNetwork').textContent =
          'ВЫБРАНА СЕТЬ: ' + selectedSSID;

        $('wifiPassword').value = '';
        status('Введи пароль для проверки подключения.');
        log('Selected Wi-Fi: ' + ssid);
      });

      list.appendChild(button);
    });
  }

  async function checkAgent() {
    $('wifiAgentStatus').textContent = 'ПОДКЛЮЧЕНИЕ...';

    try {
      const result = await request('/health');

      $('wifiAgentStatus').textContent = result.online
        ? 'ПОМОЩНИК ПОДКЛЮЧЁН'
        : 'ПОМОЩНИК НЕ В СЕТИ';
    } catch (error) {
      $('wifiAgentStatus').textContent = error.message;
    }
  }

  async function scanNetworks() {
    $('wifiNetworkList').textContent = 'ПОИСК СЕТЕЙ...';
    selectedSSID = '';
    $('wifiSelectedNetwork').textContent = 'СЕТЬ НЕ ВЫБРАНА';

    try {
      const data = await request('/api/audit');
      const raw = data.results?.available_networks || '';

      networks = parseNetworks(raw);
      renderNetworks();

      output(
        networks.length
          ? 'Найдено сетей: ' + networks.length
          : 'Не удалось распознать список сетей.\\n\\n' + raw
      );

      log('Wi-Fi scan completed.');
    } catch (error) {
      $('wifiNetworkList').textContent = error.message;
      output(error.message);
    }
  }

  async function verifyConnection(ssid) {
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1000));

      try {
        const data = await request('/api/audit');
        const info = String(data.results?.interfaces || '');

        const hasSSID = info.split(/\r?\n/).some(line => {
          const match = line.match(/^\s*SSID\s*:\s*(.*)$/i);
          return match && match[1].trim() === ssid;
        });

        const connected =
          /State\s*:\s*connected/i.test(info) ||
          /Состояние\s*:\s*подключено/i.test(info);

        if (hasSSID && connected) return true;
      } catch {
        // Продолжаем проверку состояния подключения.
      }
    }

    return false;
  }

  async function testPassword() {
    const password = $('wifiPassword').value;

    if (!selectedSSID) {
      status('СНАЧАЛА ВЫБЕРИ WI-FI СЕТЬ');
      return;
    }

    if (!password) {
      status('ВВЕДИ ПАРОЛЬ');
      return;
    }

    if (password.length < 8 || password.length > 63) {
      status('ДЛЯ WPA2-ПАРОЛЯ НУЖНО ОТ 8 ДО 63 СИМВОЛОВ');
      return;
    }

    status('ОТПРАВКА ЗАПРОСА НА ПОДКЛЮЧЕНИЕ...');
    $('wifiPasswordCheck').disabled = true;

    try {
      const result = await request('/api/connect-password', {
        method: 'POST',
        body: {
          ssid: selectedSSID,
          password
        }
      });

      $('wifiPassword').value = '';

      if (!result.success) {
        status('WINDOWS НЕ ПРИНЯЛА ЗАПРОС НА ПОДКЛЮЧЕНИЕ');
        output(result.error || result.output || 'Подключение не выполнено.');
        return;
      }

      status('ПРОВЕРЯЕМ ФАКТИЧЕСКОЕ ПОДКЛЮЧЕНИЕ...');
      output('Запрос передан Windows. Ожидаем результат проверки...');

      const connected = await verifyConnection(selectedSSID);

      if (connected) {
        status('ПОДКЛЮЧЕНИЕ ПОДТВЕРЖДЕНО. СЕТЬ ДОСТУПНА.');
        output('Устройство подключено к сети: ' + selectedSSID);
        log('Wi-Fi connection confirmed.');
      } else {
        status('ПОДКЛЮЧЕНИЕ НЕ ПОДТВЕРЖДЕНО');
        output(
          'Windows получила команду, но подключение к выбранной сети ' +
          'не подтверждено. Проверь пароль и настройки роутера.'
        );
      }
    } catch (error) {
      status('ОШИБКА ПОДКЛЮЧЕНИЯ');
      output(error.message);
    } finally {
      $('wifiPasswordCheck').disabled = false;
    }
  }

  $('wifiCheckAgent').addEventListener('click', checkAgent);
  $('wifiScan').addEventListener('click', scanNetworks);
  $('wifiPasswordCheck').addEventListener('click', testPassword);

  $('wifiSecurity').addEventListener('click', async () => {
    try {
      const data = await request('/api/audit');

      output({
        interfaces: data.results?.interfaces,
        drivers: data.results?.drivers,
        adapters: data.results?.adapters,
        firewall: data.results?.firewall
      });
    } catch (error) {
      output(error.message);
    }
  });

  $('wifiWps').addEventListener('click', async () => {
    try {
      const data = await request('/api/audit');

      output(
        'ДОСТУПНЫЕ СЕТИ:\\n' +
        data.results?.available_networks +
        '\\n\\nСтатус WPS проверяй в настройках собственного роутера.'
      );
    } catch (error) {
      output(error.message);
    }
  });

  $('wifiReport').addEventListener('click', async () => {
    try {
      const result = await request('/api/report');
      output('ОТЧЁТ СОХРАНЁН:\\n' + result.savedTo);
    } catch (error) {
      output(error.message);
    }
  });

  log('WI-FI module loaded.');
})();
