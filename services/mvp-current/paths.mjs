import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const appRoot=fileURLToPath(new URL('.',import.meta.url));
export const dataRoot=path.resolve(process.env.MVP_DATA_DIR || path.join(appRoot,'data'));
export const demoBase=path.join(dataRoot,'demo');
export const sourceRoot=path.resolve(process.env.MVP_SOURCE_DIR || path.join(dataRoot,'source'));
export const priceSource=path.resolve(process.env.MVP_PRICE_SOURCE || path.join(dataRoot,'price.xlsx'));
export const python=process.env.MVP_PYTHON || (process.platform==='win32'?'python':'python3');
export const albumV2Base=path.resolve(process.env.MVP_ALBUM_V2_DIR || path.join(dataRoot,'demo-20261127-ac'));
