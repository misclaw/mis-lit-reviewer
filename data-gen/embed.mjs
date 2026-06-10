// Generate bge-small int8 embeddings for the slim corpus, in the SAME order as
// papers.slim.jsonl. Resumable: if emb_int8.bin already has N vectors, continue
// from row N. Reads the whole file and splits on "\n" only (NOT readline, which
// also breaks on U+2028/U+2029) so Node matches the browser loader exactly.
//
// Run: node data-gen/embed.mjs   (from the project root; --force to rebuild)
import { pipeline } from "@huggingface/transformers";
import fs from "fs";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = ROOT + "data-gen/papers.slim.jsonl";   // staging (not shipped)
const OUT_BIN = ROOT + "public/data/emb_int8.bin";
const OUT_META = ROOT + "public/data/meta.json";
const MODEL = "Xenova/bge-small-en-v1.5";
const DIM = 384;

const lines = fs.readFileSync(SRC, "utf8").split("\n").filter((l) => l.length);
const total = lines.length;

function meta(count) {
  return { model: MODEL, dim: DIM, count, quant: "int8/127", normalized: true,
    query_prefix: "Represent this sentence for searching relevant passages: " };
}

let startRow = 0;
if (process.argv.includes("--force")) {
  if (fs.existsSync(OUT_BIN)) fs.unlinkSync(OUT_BIN);
} else if (fs.existsSync(OUT_BIN)) {
  startRow = Math.floor(fs.statSync(OUT_BIN).size / DIM);
}
console.log(`total ${total} · already embedded ${startRow} · remaining ${total - startRow}`);
if (startRow >= total) {
  fs.writeFileSync(OUT_META, JSON.stringify(meta(total), null, 2));
  console.log("nothing to do; wrote meta.json");
  process.exit(0);
}

const extractor = await pipeline("feature-extraction", MODEL, { dtype: "q8" });
console.log("model loaded:", MODEL);
const out = fs.createWriteStream(OUT_BIN, { flags: "a" });

async function embed(texts) {
  const o = await extractor(texts, { pooling: "mean", normalize: true });
  return o.tolist();
}

let batch = [], count = startRow;
const t0 = Date.now();
async function flush() {
  if (!batch.length) return;
  const vecs = await embed(batch);
  const buf = Buffer.alloc(vecs.length * DIM);
  let k = 0;
  for (const v of vecs)
    for (let i = 0; i < DIM; i++) {
      let q = Math.round(v[i] * 127);
      q = q > 127 ? 127 : q < -128 ? -128 : q;
      buf.writeInt8(q, k++);
    }
  out.write(buf);
  count += vecs.length;
  batch = [];
  if (count % 2048 === 0)
    process.stdout.write(`  ${count}/${total} (${((count - startRow) / ((Date.now() - t0) / 1000)).toFixed(0)}/s)\r`);
}

for (let r = startRow; r < total; r++) {
  const p = JSON.parse(lines[r]);
  batch.push(((p.title || "") + "\n\n" + (p.abstract || "")).slice(0, 2000));
  if (batch.length >= 64) await flush();
}
await flush();
await new Promise((res) => out.end(res));
fs.writeFileSync(OUT_META, JSON.stringify(meta(count), null, 2));
console.log(`\ndone: ${count} vectors, ${(count * DIM / 1048576).toFixed(0)} MB int8`);
