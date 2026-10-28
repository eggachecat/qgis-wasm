#!/usr/bin/env node
/**
 * Minimal S3-compatible object store for tests (in memory, path-style, one bucket).
 * Implements what cloudfs.js uses: ListObjectsV2, GET (with Range), HEAD, PUT (incl. x-amz-copy-source), DELETE,
 * CORS preflight, and AWS Signature V4 verification (so the browser-side signing is really tested).
 *
 *   node tests/s3-mock.mjs --port 9123 --bucket gis --access TESTKEY --secret TESTSECRET [--seed dir] [--anonymous]
 *   GET /_debug/keys → JSON list of stored keys (no auth)
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(arg("--port", 9123));
const BUCKET = arg("--bucket", "gis");
const ACCESS = arg("--access", "TESTKEY");
const SECRET = arg("--secret", "TESTSECRET");
const SEED = arg("--seed", null);
const ANON = args.includes("--anonymous");

const objects = new Map(); // key → { body: Buffer, mtime: Date }
if (SEED) {
  const walk = (dir, prefix) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, prefix + e.name + "/");
      else objects.set(prefix + e.name, { body: fs.readFileSync(p), mtime: fs.statSync(p).mtime });
    }
  };
  walk(SEED, "");
  console.error(`[s3-mock] seeded ${objects.size} objects from ${SEED}`);
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, PUT, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Range, Mcp-Session-Id, Mcp-Protocol-Version, X-Amz-Date, X-Amz-Content-Sha256, X-Amz-Security-Token, X-Amz-Copy-Source, X-Amz-User-Agent, If-None-Match, If-Modified-Since, Cache-Control, Pragma",
  "Access-Control-Expose-Headers": "ETag, Content-Length, Content-Range, Accept-Ranges, Last-Modified, x-amz-request-id",
  "Access-Control-Max-Age": "600",
};
const xmlEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const errorXml = (res, status, code, message) => {
  res.writeHead(status, { ...cors, "Content-Type": "application/xml" });
  res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message></Error>`);
};
const uriEncode = (s, keepSlash) => {
  const e = encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return keepSlash ? e.replace(/%2F/g, "/") : e;
};

function verifySignature(req, url) {
  const auth = req.headers.authorization || "";
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request,\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-f]+)$/.exec(auth);
  if (!m) return "missing or malformed Authorization header";
  const [, accessKey, date, region, signedHeaders, signature] = m;
  if (accessKey !== ACCESS) return `unknown access key ${accessKey}`;
  const amzDate = req.headers["x-amz-date"];
  if (!amzDate) return "missing x-amz-date";
  const canonicalQuery = [...url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join("&");
  const names = signedHeaders.split(";");
  const canonicalHeaders = names.map((n) => `${n}:${String(n === "host" ? req.headers.host : req.headers[n] ?? "").trim().replace(/\s+/g, " ")}\n`).join("");
  const payloadHash = req.headers["x-amz-content-sha256"] || "UNSIGNED-PAYLOAD";
  const canonicalRequest = [req.method, uriEncode(decodeURIComponent(url.pathname), true), canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, crypto.createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");
  const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();
  const kSigning = hmac(hmac(hmac(hmac("AWS4" + SECRET, date), region), "s3"), "aws4_request");
  const expected = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  if (expected !== signature) {
    console.error(`[s3-mock] SignatureDoesNotMatch\n--- canonical request (server)\n${canonicalRequest}\n--- string to sign\n${stringToSign}`);
    return "SignatureDoesNotMatch";
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (url.pathname === "/_debug/keys") {
    res.writeHead(200, { ...cors, "Content-Type": "application/json" });
    return res.end(JSON.stringify([...objects.entries()].map(([k, o]) => ({ key: k, size: o.body.length }))));
  }
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== BUCKET) return errorXml(res, 404, "NoSuchBucket", `bucket ${parts[0]} does not exist`);
  if (!ANON) {
    const err = verifySignature(req, url);
    if (err) return errorXml(res, 403, err === "SignatureDoesNotMatch" ? err : "AccessDenied", err);
  }
  const key = parts.slice(1).join("/") + (url.pathname.endsWith("/") && parts.length > 1 ? "/" : "");
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);

  if (req.method === "GET" && parts.length === 1) {
    // ListObjectsV2
    const prefix = url.searchParams.get("prefix") || "";
    const delimiter = url.searchParams.get("delimiter") || "";
    const contents = [], prefixes = new Set();
    for (const [k, o] of [...objects.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      const idx = delimiter ? rest.indexOf(delimiter) : -1;
      if (idx >= 0) prefixes.add(prefix + rest.slice(0, idx + delimiter.length));
      else contents.push(`<Contents><Key>${xmlEscape(k)}</Key><LastModified>${o.mtime.toISOString()}</LastModified><ETag>"${crypto.createHash("md5").update(o.body).digest("hex")}"</ETag><Size>${o.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`);
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${BUCKET}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${contents.length + prefixes.size}</KeyCount><MaxKeys>1000</MaxKeys><Delimiter>${xmlEscape(delimiter)}</Delimiter><IsTruncated>false</IsTruncated>${contents.join("")}${[...prefixes].map((p) => `<CommonPrefixes><Prefix>${xmlEscape(p)}</Prefix></CommonPrefixes>`).join("")}</ListBucketResult>`;
    res.writeHead(200, { ...cors, "Content-Type": "application/xml" });
    return res.end(xml);
  }
  if (req.method === "PUT") {
    const copySource = req.headers["x-amz-copy-source"];
    if (copySource) {
      const src = decodeURIComponent(copySource.replace(/^\//, "")).split("/").slice(1).join("/");
      const o = objects.get(src);
      if (!o) return errorXml(res, 404, "NoSuchKey", `copy source ${src} does not exist`);
      objects.set(key, { body: Buffer.from(o.body), mtime: new Date() });
      res.writeHead(200, { ...cors, "Content-Type": "application/xml" });
      return res.end(`<CopyObjectResult><LastModified>${new Date().toISOString()}</LastModified><ETag>"copy"</ETag></CopyObjectResult>`);
    }
    objects.set(key, { body, mtime: new Date() });
    console.error(`[s3-mock] PUT ${key} (${body.length} bytes)`);
    res.writeHead(200, { ...cors, ETag: `"${crypto.createHash("md5").update(body).digest("hex")}"` });
    return res.end();
  }
  if (req.method === "DELETE") {
    objects.delete(key);
    res.writeHead(204, cors);
    return res.end();
  }
  if (req.method === "GET" || req.method === "HEAD") {
    const o = objects.get(key);
    if (!o) return errorXml(res, 404, "NoSuchKey", `${key} does not exist`);
    const headers = { ...cors, "Content-Type": "application/octet-stream", "Accept-Ranges": "bytes", "Last-Modified": o.mtime.toUTCString(), ETag: `"${crypto.createHash("md5").update(o.body).digest("hex")}"` };
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
    if (range && req.method === "GET") {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), o.body.length - 1) : o.body.length - 1;
      res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${o.body.length}`, "Content-Length": end - start + 1 });
      return res.end(o.body.subarray(start, end + 1));
    }
    res.writeHead(200, { ...headers, "Content-Length": o.body.length });
    return res.end(req.method === "HEAD" ? undefined : o.body);
  }
  errorXml(res, 405, "MethodNotAllowed", req.method);
});
server.listen(PORT, () => console.log(`[s3-mock] bucket ${BUCKET} at http://127.0.0.1:${PORT}/${BUCKET} (${ANON ? "anonymous" : "SigV4 " + ACCESS})`));
