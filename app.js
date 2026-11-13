
const $ = id => document.getElementById(id);
const terminal = $("terminal");
const results = $("results");
let target = "";
let busy = false;
const start = Date.now();

function log(message, type="") {
  const line = document.createElement("div");
  line.className = type;
  line.textContent = "> " + message;
  terminal.appendChild(line);
  terminal.scrollTop = terminal.scrollHeight;
}

function print(data) {
  results.textContent = JSON.stringify(data,null,2);
}

async function api(endpoint) {
  if (!target) throw new Error("Set an authorized target domain first.");

  const response = await fetch("/api/"+endpoint,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({host:target})
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function run(command) {
  command=command.toLowerCase().trim();
  if (!command) return;

  log("root@hacker:~$ "+command);

  if (busy) {
    log("Wait for the current check.", "warning");
    return;
  }

  if (command==="help") {
    log("dns     - real DNS analysis");
    log("ssl     - SSL certificate check");
    log("headers - HTTP security headers");
    log("ports   - check selected TCP ports");
    log("status  - server status");
    log("clear   - clear terminal");
    return;
  }

  if (command==="clear") {
    terminal.textContent="";
    results.textContent="Waiting for command...";
    return;
  }

  if (command==="status") {
    log("Checking server...");
    try {
      const r=await fetch("/api/status");
      const d=await r.json();
      print(d);
      log("Server: "+d.status,"success");
    } catch(e) { log(e.message,"error"); }
    return;
  }

  if (!["dns","ssl","headers","ports"].includes(command)) {
    log("Unknown command. Type help.","error");
    return;
  }

  busy=true;
  log("Running real "+command.toUpperCase()+" check...");

  try {
    const data=await api(command);
    print(data);
    log(command.toUpperCase()+" completed successfully.","success");
  } catch(e) {
    print({error:e.message});
    log(e.message,"error");
  } finally {
    busy=false;
  }
}

$("setTarget").addEventListener("click",()=>{
  const value=$("host").value.trim().toLowerCase();
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(value)) {
    log("Enter a valid domain name.","error");
    return;
  }
  target=value;
  log("Target selected: "+target,"success");
  log("Server authorization is still required.");
});

$("commandForm").addEventListener("submit",e=>{
  e.preventDefault();
  const value=$("command").value;
  $("command").value="";
  run(value);
});

document.querySelectorAll("[data-cmd]").forEach(button=>{
  button.addEventListener("click",()=>run(button.dataset.cmd));
});

async function checkStatus(){
  try {
    const r=await fetch("/api/status");
    const d=await r.json();
    $("serverStatus").textContent=d.status.toUpperCase();
    $("status").innerHTML='<span class="dot"></span> SYSTEM ONLINE';
  } catch {
    $("serverStatus").textContent="OFFLINE";
    $("status").textContent="SERVER OFFLINE";
  }
}

setInterval(()=>{
  const s=Math.floor((Date.now()-start)/1000);
  $("uptime").textContent=[
    Math.floor(s/3600),
    Math.floor(s%3600/60),
    s%60
  ].map(n=>String(n).padStart(2,"0")).join(":");
},1000);

checkStatus();
log("HACKER TERMINAL v2.0");
log("Real diagnostic modules initialized.","success");
log("Type HELP to see available commands.");
