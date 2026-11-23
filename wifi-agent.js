
'use strict';

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const HOST = '127.0.0.1';
const PORT = 8765;

const ALLOWED_ORIGINS = new Set([
  'https://hacker-terminal-hiwg.onrender.com'
]);

function run(file, args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      windowsHide: true,
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      encoding: 'utf8'
    }, (error, stdout, stderr) => {
      if (error && !stdout) {
        return reject(new Error(stderr || error.message));
      }
      resolve(stdout || '');
    });
  });
}

async function audit() {
  const report = {
    computer: os.hostname(),
    date: new Date().toISOString(),
    system: os.platform(),
    results: {}
  };

  const checks = [
    ['interfaces', 'netsh.exe', ['wlan', 'show', 'interfaces']],
    ['available_networks', 'netsh.exe', ['wlan', 'show', 'networks', 'mode=bssid']],
    ['saved_profiles', 'netsh.exe', ['wlan', 'show', 'profiles']],
    ['drivers', 'netsh.exe', ['wlan', 'show', 'drivers']],
    ['ip_configuration', 'ipconfig.exe', ['/all']]
  ];

  for (const [name, file, args] of checks) {
    try {
      report.results[name] = await run(file, args);
    } catch (error) {
      report.results[name] = 'ERROR: ' + error.message;
    }
  }

  try {
    report.results.adapters = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-NetAdapter -Physical | Select-Object Name,InterfaceDescription,Status,LinkSpeed | ConvertTo-Json -Compress'
    ]);
  } catch (error) {
    report.results.adapters = error.message;
  }

  try {
    report.results.firewall = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-NetFirewallProfile | Select-Object Name,Enabled,DefaultInboundAction,DefaultOutboundAction | ConvertTo-Json -Compress'
    ]);
  } catch (error) {
    report.results.firewall = error.message;
  }

  return report;
}

function corsHeaders(origin) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Private-Network': 'true'
  };

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }

  return headers;
}

function send(res, status, data, origin) {
  const headers = corsHeaders(origin);

  if (status === 204) {
    res.writeHead(status, headers);
    return res.end();
  }

  res.writeHead(status, headers);
  res.end(JSON.stringify(data, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let finished = false;

    req.on('data', chunk => {
      if (finished) return;

      body += chunk;

      if (body.length > 8192) {
        finished = true;
        reject(new Error('Request too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (finished) return;

      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });

    req.on('error', error => {
      if (!finished) reject(error);
    });
  });
}

function xmlEscape(value) {
  return String(value).replace(/[<>&'"]/g, char => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '"': '&quot;'
  })[char]);
}

// Одна ручная попытка подключения к WPA2-Personal сети.
async function connectWithPassword(ssid, password) {
  if (!ssid || ssid.length > 32 || /[\r\n\0]/.test(ssid)) {
    throw new Error('Invalid Wi-Fi network name (SSID).');
  }

  if (
    typeof password !== 'string' ||
    password.length < 8 ||
    password.length > 63
  ) {
    throw new Error('Для WPA2-Personal пароль должен содержать 8–63 символа.');
  }

  const profileName = 'HT_WIFI_' + crypto.randomBytes(6).toString('hex');
  const tempFile = path.join(os.tmpdir(), profileName + '.xml');

  const profileXml = `<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
  <name>${xmlEscape(profileName)}</name>
  <SSIDConfig>
    <SSID>
      <name>${xmlEscape(ssid)}</name>
    </SSID>
  </SSIDConfig>
  <connectionType>ESS</connectionType>
  <connectionMode>manual</connectionMode>
  <MSM>
    <security>
      <authEncryption>
        <authentication>WPA2PSK</authentication>
        <encryption>AES</encryption>
        <useOneX>false</useOneX>
      </authEncryption>
      <sharedKey>
        <keyType>passPhrase</keyType>
        <protected>false</protected>
        <keyMaterial>${xmlEscape(password)}</keyMaterial>
      </sharedKey>
    </security>
  </MSM>
</WLANProfile>`;

  try {
    fs.writeFileSync(tempFile, profileXml, {
      encoding: 'utf8',
      mode: 0o600
    });

    await run('netsh.exe', [
      'wlan',
      'add',
      'profile',
      `filename=${tempFile}`,
      'user=current'
    ]);

    const output = await run('netsh.exe', [
      'wlan',
      'connect',
      `name=${profileName}`,
      `ssid=${ssid}`
    ]);

    return {
      success: true,
      profile: profileName,
      output,
      message: 'Windows received the connection request. Check Wi-Fi status.'
    };
  } finally {
    try {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    } catch {
      // Не прерываем работу агента из-за временного файла.
    }
  }
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;

  if (req.headers.host !== `${HOST}:${PORT}`) {
    return send(res, 403, { error: 'Invalid local host' }, origin);
  }

  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    return send(res, 403, { error: 'Origin not allowed' }, origin);
  }

  if (req.method === 'OPTIONS') {
    if (
      req.headers['access-control-request-headers'] &&
      !req.headers['access-control-request-headers']
        .toLowerCase().split(',').map(x => x.trim())
        .every(x => x === 'content-type')
    ) {
      return send(res, 403, { error: 'Request headers not allowed' }, origin);
    }

    return send(res, 204, {}, origin);
  }

  if (req.method === 'POST' &&
      req.headers['content-type']?.split(';')[0] !== 'application/json') {
    return send(res, 415, { error: 'JSON required' }, origin);
  }

  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, {
      online: true,
      service: 'HACKER TERMINAL WIFI AGENT'
    }, origin);
  }

  if (req.method === 'GET' && req.url === '/api/audit') {
    try {
      return send(res, 200, await audit(), origin);
    } catch (error) {
      return send(res, 500, { error: error.message }, origin);
    }
  }

  if (req.method === 'GET' && req.url === '/api/report') {
    try {
      const report = await audit();
      const desktop = path.join(os.homedir(), 'Desktop');
      const folder = fs.existsSync(desktop) ? desktop : os.homedir();
      const filename = `HACKER_WIFI_REPORT_${Date.now()}.json`;
      const filepath = path.join(folder, filename);

      fs.writeFileSync(filepath, JSON.stringify(report, null, 2), 'utf8');

      return send(res, 200, {
        success: true,
        savedTo: filepath
      }, origin);
    } catch (error) {
      return send(res, 500, { error: error.message }, origin);
    }
  }

  if (req.method === 'POST' && req.url === '/api/connect') {
    try {
      const body = await readBody(req);
      const profile = String(body.profile || '').trim();

      if (
        !profile ||
        profile.length > 128 ||
        /[\r\n\0]/.test(profile)
      ) {
        return send(res, 400, {
          error: 'Invalid saved profile name'
        }, origin);
      }

      const output = await run('netsh.exe', [
        'wlan',
        'connect',
        `name=${profile}`
      ]);

      return send(res, 200, {
        success: true,
        output
      }, origin);
    } catch (error) {
      return send(res, 500, { error: error.message }, origin);
    }
  }

  if (req.method === 'POST' && req.url === '/api/connect-password') {
    try {
      const body = await readBody(req);
      const ssid = String(body.ssid || '').trim();
      const password = body.password;

      const result = await connectWithPassword(ssid, password);

      return send(res, 200, result, origin);
    } catch (error) {
      return send(res, 400, {
        success: false,
        error: error.message
      }, origin);
    }
  }

  return send(res, 404, {
    error: 'Endpoint not found'
  }, origin);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('HACKER TERMINAL // WIFI AGENT');
  console.log('STATUS: ONLINE');
  console.log(`ADDRESS: http://${HOST}:${PORT}`);
  console.log('ACCESS TOKEN: NOT REQUIRED');
  console.log('Access restricted to the configured website origin.');
  console.log('');
  console.log('Keep this window open while using the Wi-Fi module.');
  console.log('Press CTRL+C to stop.');
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
