import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Adapted from the project's cloud release paths.mjs; defaults belong to this package.
export const appRoot = fileURLToPath(new URL('.', import.meta.url));
export const dataRoot = path.resolve(process.env.MVP_DATA_DIR || path.join(appRoot, '..', 'data'));
export const demoBase = path.join(dataRoot, 'demo');
export const sourceRoot = path.resolve(process.env.MVP_SOURCE_DIR || path.join(dataRoot, 'source'));
export const priceSource = path.resolve(process.env.MVP_PRICE_SOURCE || path.join(dataRoot, 'price.xlsx'));
export const mainPort = Number(process.env.PORT || process.env.MVP_MAIN_PORT || 4297);
export const salesPort = Number(process.env.MVP_SALES_PORT || process.env.ANRAN_PORT || 4299);
for (const port of [mainPort, salesPort]) if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid demo port');
export const guestOrigin = `http://127.0.0.1:${salesPort}`;
export const ownerOrigin = `http://localhost:${salesPort}`;
export const sqlitePath = path.resolve(process.env.ANRAN_DB || path.join(dataRoot, 'runtime', 'messages.sqlite'));
export function pythonExecutable() {
  if (!process.env.MVP_PYTHON) throw new Error('MVP_PYTHON must point to the bundled Python executable');
  return path.resolve(process.env.MVP_PYTHON);
}
// Old manifests may contain another PC's absolute path; resolve by the manifest's filename only.
export function sourceImagePath(value) {
  const file = path.win32.basename(String(value || '').replaceAll('/', '\\'));
  if (!file || file === '.' || file === '..') throw new Error('Invalid image filename');
  return path.join(sourceRoot, file);
}
