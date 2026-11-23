
'use strict';

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const HOST = '127.0.0.1';
const PORT = 8765;
const TOKEN = crypto.randomBytes(32).toString('hex');

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      windowsHide: true,
      timeout: 15000,
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

function send(res, status, data) {
  const body = JSON.stringify(data, null, 2);

  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Private-Network': 'true'
  });

  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', chunk => {
      body += chunk;
      if (body.length > 4096) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });

    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    return send(res, 204, {});
  }

  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    return send(res, 401, { error: 'Invalid access token' });
  }

  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, {
      online: true,
      service: 'HACKER TERMINAL WIFI AGENT'
    });
  }

  if (req.method === 'GET' && req.url === '/api/audit') {
    try {
      return send(res, 200, await audit());
    } catch (error) {
      return send(res, 500, { error: error.message });
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
      });
    } catch (error) {
      return send(res, 500, { error: error.message });
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
        return send(res, 400, { error: 'Invalid saved profile name' });
      }

      const output = await run('netsh.exe', [
        'wlan',
        'connect',
        `name=${profile}`
      ]);

      return send(res, 200, {
        success: true,
        output
      });
    } catch (error) {
      return send(res, 500, { error: error.message });
    }
  }

  return send(res, 404, { error: 'Endpoint not found' });
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('HACKER TERMINAL // WIFI AGENT');
  console.log('STATUS: ONLINE');
  console.log(`ADDRESS: http://${HOST}:${PORT}`);
  console.log(`ACCESS TOKEN: ${TOKEN}`);
  console.log('');
  console.log('Keep this window open while using the Wi-Fi module.');
  console.log('Press CTRL+C to stop.');
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
