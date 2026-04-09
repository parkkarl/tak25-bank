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

const children = [];

for (const svc of services) {
  const child = fork(join(__dirname, svc.file), { stdio: ['pipe', 'inherit', 'inherit', 'ipc'] });
  child.on('exit', (code) => {
    console.error(`${svc.name} exited with code ${code}`);
    // Restart on crash
    if (code !== 0) {
      console.log(`Restarting ${svc.name}...`);
      setTimeout(() => {
        const restarted = fork(join(__dirname, svc.file), { stdio: ['pipe', 'inherit', 'inherit', 'ipc'] });
        children.push(restarted);
      }, 1000);
    }
  });
  children.push(child);
}

process.on('SIGINT', () => {
  children.forEach(c => c.kill());
  process.exit(0);
});
process.on('SIGTERM', () => {
  children.forEach(c => c.kill());
  process.exit(0);
});

console.log('All services starting...');
