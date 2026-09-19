import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { GameStore } from './store.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(currentDirectory, '..');
const port = Number(process.env.PORT || 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`PORT 必须是 1-65535 之间的整数，当前值：${process.env.PORT}`);
  process.exit(1);
}
const isProduction = process.env.NODE_ENV === 'production' || process.env.npm_lifecycle_event === 'start';
const dataFile = process.env.DATA_FILE || path.join(currentDirectory, 'data', 'game-state.json');
const clientDist = path.join(rootDirectory, 'dist');
const store = new GameStore(dataFile, { days: 14 });

let initialState;
try {
  initialState = store.load();
} catch (error) {
  console.error(`[浮空岛邮政署] ${error.message}`);
  console.error('[浮空岛邮政署] 原存档文件未被修改，请处理后重启服务。');
  process.exit(1);
}

const recovery = store.getRecovery();
if (recovery) {
  console.warn(`[浮空岛邮政署] ${recovery.reason}`);
}

const app = createApp({ store, clientDist });
const server = app.listen(port, () => {
  console.log(`[浮空岛邮政署] API 已启动：http://localhost:${port}`);
  console.log(`[浮空岛邮政署] 当前进度：第 ${initialState.day} 日 / ${initialState.days} 日`);
  if (!isProduction) {
    console.log('[浮空岛邮政署] 开发面板由 Vite 提供：http://localhost:5173');
  }
});

function shutdown(signal) {
  console.log(`收到 ${signal}，正在关闭服务...`);
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
