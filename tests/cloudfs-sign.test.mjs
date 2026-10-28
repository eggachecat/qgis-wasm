#!/usr/bin/env node
// Unit test: the browser-side SigV4 signing of web/shell/cloudfs.js against a node:crypto reference implementation.
//   node tests/cloudfs-sign.test.mjs
import fs from "node:fs";
import crypto from "node:crypto";
import vm from "node:vm";

const src = fs.readFileSync(new URL("../web/shell/cloudfs.js", import.meta.url), "utf8");
const sandbox = { window: {}, console, TextEncoder, TextDecoder, URL, XMLHttpRequest: function () { throw new Error("no network in unit test"); }, DOMParser: function () {} };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const { sha256, hmac, hex, S3Backend } = sandbox.window.qgisCloud._internal;

let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? " — " + detail : ""}`); if (!ok) failures++; };

// hashes
const enc = new TextEncoder();
check("sha256('')", hex(sha256(new Uint8Array(0))) === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
check("sha256(abc)", hex(sha256(enc.encode("abc"))) === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
const big = new Uint8Array(100000).map((_, i) => i & 255);
check("sha256(100 kB)", hex(sha256(big)) === crypto.createHash("sha256").update(big).digest("hex"));
check("hmac", hex(hmac(enc.encode("key"), enc.encode("The quick brown fox jumps over the lazy dog"))) === "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");

// SigV4 reference (same algorithm as tests/s3-mock.mjs)
function referenceSign(method, url, headers, secret, date, region) {
  const u = new URL(url);
  const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  const query = [...u.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&");
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = names.map((n) => `${n}:${String(headers[Object.keys(headers).find((k) => k.toLowerCase() === n)]).trim()}\n`).join("");
  const cr = [method, enc(decodeURIComponent(u.pathname)).replace(/%2F/g, "/"), query, canonicalHeaders, names.join(";"), "UNSIGNED-PAYLOAD"].join("\n");
  const scope = `${date.slice(0, 8)}/${region}/s3/aws4_request`;
  const sts = ["AWS4-HMAC-SHA256", date, scope, crypto.createHash("sha256").update(cr).digest("hex")].join("\n");
  const h = (k, d) => crypto.createHmac("sha256", k).update(d).digest();
  return crypto.createHmac("sha256", h(h(h(h("AWS4" + secret, date.slice(0, 8)), region), "s3"), "aws4_request")).update(sts).digest("hex");
}

const cases = [
  { name: "list root", method: "GET", key: "", params: { "list-type": "2", delimiter: "/", prefix: "", "max-keys": "1000" }, extra: {} },
  { name: "ranged get with spaces", method: "GET", key: "data/my file (1).gpkg", params: {}, extra: { Range: "bytes=0-1023" } },
  { name: "put", method: "PUT", key: "projects/a.qgz", params: {}, extra: { "Content-Type": "application/octet-stream" } },
  { name: "copy", method: "PUT", key: "b.txt", params: {}, extra: { "x-amz-copy-source": "/gis/a%20b.txt" } },
];
for (const c of cases) {
  const b = new S3Backend({ endpoint: "http://127.0.0.1:9123", bucket: "gis", accessKeyId: "TESTKEY", secretAccessKey: "TESTSECRET", region: "us-east-1" });
  const signed = b.sign(c.method, c.key, c.params, c.extra);
  const auth = signed.headers.Authorization;
  const sig = /Signature=([0-9a-f]+)/.exec(auth)[1];
  const headersForRef = { host: new URL(signed.url).host, ...Object.fromEntries(Object.entries(signed.headers).filter(([k]) => k !== "Authorization")) };
  const expected = referenceSign(c.method, signed.url, headersForRef, "TESTSECRET", signed.headers["x-amz-date"], "us-east-1");
  check(`SigV4 ${c.name}`, sig === expected, signed.url);
}
console.log(failures ? "FAILED" : "OK");
process.exit(failures ? 1 : 0);
