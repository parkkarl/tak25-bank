import { fork } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const services = [
  { name: 'User Service', file: 'services/user-service.js' },
  { name: 'Account Service', file: 'services/account-service.js' },
  { name: 'Transfer Service', file: 'services/transfer-service.js' },
  { name: 'API Gateway', file: 'services/gateway.js' },
];

const MAX_RESTARTS = 5;
const children = new Array(services.length).fill(null);
const restartCounts = new Array(services.length).fill(0);

function startService(index) {
  const svc = services[index];
  const child = fork(join(__dirname, svc.file), { stdio: ['pipe', 'inherit', 'inherit', 'ipc'] });
  child.on('exit', (code) => {
    console.error(`${svc.name} exited with code ${code}`);
    children[index] = null;
    if (code !== 0 && restartCounts[index] < MAX_RESTARTS) {
      restartCounts[index]++;
      console.log(`Restarting ${svc.name} (${restartCounts[index]}/${MAX_RESTARTS})...`);
      setTimeout(() => startService(index), 1000);
    } else if (restartCounts[index] >= MAX_RESTARTS) {
      console.error(`${svc.name} exceeded max restarts (${MAX_RESTARTS}). Giving up.`);
    }
  });
  children[index] = child;
}

for (let i = 0; i < services.length; i++) {
  startService(i);
}

function shutdown() {
  children.forEach(c => { if (c) c.kill(); });
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('All services starting...');
