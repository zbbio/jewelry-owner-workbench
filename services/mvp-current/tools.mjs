import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { appRoot, albumV2Base, sourceRoot, python } from "./paths.mjs";

const execFileAsync = promisify(execFile);
const visionScript = path.join(appRoot,"vision_classify.py");
import {applyPhotoClassifications} from "./catalog-projection.mjs";
const visionSource = sourceRoot;
const visionOutput = albumV2Base;

const products = {
  A: { id: "A", version: 1, name: "测试店 A 号手串", price: "315.50", size: "17.2 cm", certificate: "待核实", images: ["A-1.jpg", "A-2.jpg", "A-3.jpg"], video: "A-v2" },
  B: { id: "B", version: 1, name: "测试店 B 号手串", price: "待核实", size: "待核实", certificate: "待核实", images: ["B-1.jpg", "B-2.jpg", "B-3.jpg"], video: null }
};

const albumManifestPath = path.join(albumV2Base,"分类结果.json");
const fallbackAlbum = {
  source: "demo-album",
  files: ["A-1.jpg", "A-2.jpg", "A-3.jpg", "B-1.jpg", "B-2.jpg"],
  groups: [{ group: "A", count: 3 }, { group: "B", count: 2 }],
  resultRoot: "",
  manifestPath: "",
  classificationMode: "fixture"
};

function loadAlbumManifest() {
  try {
    const manifest = JSON.parse(fs.readFileSync(albumManifestPath, "utf8"));
    return {
      source: manifest.sourceRoot,
      files: manifest.items.map((item) => item.file),
      groups: Object.entries(manifest.groups).map(([group, count]) => ({
        group,
        count,
        directory: path.join(albumV2Base,"分类结果",group)
      })),
      resultRoot: path.join(albumV2Base,"分类结果"),
      manifestPath: albumManifestPath,
      classificationMode: manifest.classificationMode
    };
  } catch {
    return fallbackAlbum;
  }
}

export const demoData = { products, album: loadAlbumManifest(), drafts: [] };

function receipt(tool, result, sideEffects = []) {
  return { status: "completed", tool, result, sideEffects, receiptId: `demo-${tool}-${Date.now()}` };
}

export const toolDefinitions = [
  { type: "function", function: { name: "album_classify_batch", description: "整理演示相册并按实物分组，不修改原图，不建商品卡。店主要求视觉自动识别时 mode 使用 vision。", parameters: { type: "object", properties: { mode: { type: "string", enum: ["demo", "vision"], description: "demo 使用固定演示映射；vision 调用 DeepSeek 视觉模型重建分类结果。" } }, additionalProperties: false } } },
  { type: "function", function: { name: "catalog_create_or_read_card", description: "按已完成相册批次为已核货号继承分类展示，不二次看图，不根据单图编造商品。批量建卡草稿使用 mode=vision。", parameters: { type: "object", properties: { productId: { type: "string", enum: ["A", "B"] }, mode: { type: "string", enum: ["demo", "vision"] } }, additionalProperties: false } } },
  { type: "function", function: { name: "sales_prepare_reply", description: "根据商品卡生成销售回复草稿，只生成不发送。", parameters: { type: "object", properties: { productId: { type: "string", enum: ["A", "B"] }, question: { type: "string" } }, required: ["productId", "question"], additionalProperties: false } } },
  { type: "function", function: { name: "content_prepare_shooting_checklist", description: "根据商品卡列出三个拍摄镜头，只列清单不制作视频。", parameters: { type: "object", properties: { productId: { type: "string", enum: ["A", "B"] }, goal: { type: "string" } }, required: ["productId", "goal"], additionalProperties: false } } }
];

export function executeTool(name, args = {}) {
  if (name === "album_classify_batch") return receipt(name, { source: demoData.album.source, groups: demoData.album.groups, total: demoData.album.files.length, resultRoot: demoData.album.resultRoot, manifestPath: demoData.album.manifestPath, classificationMode: demoData.album.classificationMode }, ["原图未修改", "商品卡未创建"]);
  const id = args.productId || "A";
  const card = products[id];
  if (!card) throw new Error("unknown product");
  if (name === "catalog_create_or_read_card") return receipt(name, { card: { ...card }, draft: true }, ["仅保存演示草稿"]);
  if (name === "sales_prepare_reply") {
    const text = /证书/.test(args.question || "") ? "您好，这件是否有证书，我先核实一下。" : `您好，关于${card.name}的信息我先帮您核实一下。`;
    return receipt(name, { productId: id, draft: text, sent: false }, ["未发送"]);
  }
  if (name === "content_prepare_shooting_checklist") return receipt(name, { productId: id, reference: "V08", shots: ["戴上手腕和手掌一起入镜，拍整体比例。", "手腕缓慢转到侧面，拍厚度和贴腕效果。", "取下同一件放掌心，拍局部细节。"], produced: false }, ["未制作视频"]);
  throw new Error(`unknown tool ${name}`);
}

async function executeUnlocked(name, args = {}) {
  if (name === "catalog_create_or_read_card" && args.mode === "vision") {
    const result=applyPhotoClassifications();
    return receipt(name,result,result.status==="requires_album"?[]:["沿用已核照片的本批分类","原商品资料未修改","没有重新识图"]);
  }
  if (name !== "album_classify_batch" || args.mode !== "vision") return executeTool(name, args);
  try {
    const {stdout}=await execFileAsync(python,["-X","utf8","-B",visionScript,visionSource,visionOutput],{env:{...process.env,MVP_NODE:process.execPath},maxBuffer:2*1024*1024,timeout:20*60*1000});
    const result=JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
    if(result.publishStatus!=="published")throw Error("ALBUM_NOT_PUBLISHED");
    delete result.resultRoot;delete result.manifestPath;
    return receipt(name,{...result,classificationMode:"deepseek_vision"},["原图未修改","商品卡未创建"]);
  }catch{
    return {...receipt(name,{publishStatus:"not_published",retainedPrevious:loadAlbumManifest().classificationMode!=="fixture"},[]),status:"failed"};
  }
}

let writeJob=false;
export async function executeToolAsync(name,args={}){
  const writes=['album_classify_batch','catalog_create_or_read_card'].includes(name) && args.mode==='vision';
  if(!writes)return executeUnlocked(name,args);
  if(writeJob){const error=new Error('已有相册或商品卡任务正在运行，请稍后查看结果。');error.statusCode=409;throw error;}
  writeJob=true;try{return await executeUnlocked(name,args);}finally{writeJob=false;}
}

export function inferFixtureTool(text) {
  if (/照片|相册|分组/.test(text)) return ["album_classify_batch", {}];
  if (/商品卡|建卡|商品资料|卡片/.test(text)) return ["catalog_create_or_read_card", { productId: /B|第二/.test(text) ? "B" : "A" }];
  if (/证书|回复|客人|顾客/.test(text)) return ["sales_prepare_reply", { productId: /B|第二/.test(text) ? "B" : "A", question: text }];
  if (/镜头|戴起来|拍片|视频|内容/.test(text)) return ["content_prepare_shooting_checklist", { productId: /B|第二/.test(text) ? "B" : "A", goal: text }];
  return ["catalog_create_or_read_card", { productId: "A" }];
}
