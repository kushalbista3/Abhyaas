import { createApp } from './app.js';
import { config } from './config.js';
import { openDb } from './db.js';

const db = openDb(config.dbPath);
const app = createApp(db);

// 0.0.0.0 so the SMS gateway phone on the same LAN can reach this laptop.
app.listen(config.port, '0.0.0.0', () => {
  console.log(`Abhyaas server on http://0.0.0.0:${config.port}`);
});
