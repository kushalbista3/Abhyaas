import { createApp } from './app.js';
import { config } from './config.js';
import { openDb } from './db.js';
import { lanAddresses, startupBanner } from './lan.js';

const db = openDb(config.dbPath);
const app = createApp(db);

// 0.0.0.0 so the SMS gateway phone on the same LAN can reach this laptop.
// Express 5 passes a listen failure (e.g. port taken) to this callback instead
// of throwing, so check it: otherwise the process prints the banner and exits 0.
const server = app.listen(config.port, '0.0.0.0', (err) => {
  if (err) {
    console.error(
      err.code === 'EADDRINUSE'
        ? `Port ${config.port} is already in use by another program. Stop it, or set PORT in .env (the Vite proxy reads it too).`
        : `Could not start the server: ${err.message}`,
    );
    db.close();
    process.exit(1);
  }
  const { port } = server.address();
  console.log(`Abhyaas server on http://0.0.0.0:${port}`);
  for (const line of startupBanner(port, lanAddresses())) console.log(line);
});
