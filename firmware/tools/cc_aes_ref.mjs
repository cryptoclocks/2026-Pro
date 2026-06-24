#!/usr/bin/env node
/*
 * cc_aes_ref.mjs — confirm which padding AESLib's `set_paddingmode((paddingMode)1)`
 * actually uses, so the ESP-IDF (mbedtls) firmware can match it byte-for-byte.
 *
 * The legacy CryptoClock firmware builds its MQTT clientId as:
 *     encodedClientId = aesEncrypt(deviceId + "-" + mac)   // AES-128-CBC, hex
 * with key = iv = "ClocktoCrypt1234". This script reproduces AES-128-CBC under
 * several candidate paddings and prints the hex for each.
 *
 * Usage:
 *   node cc_aes_ref.mjs "<plaintext>"
 *   node cc_aes_ref.mjs "<plaintext>" "<legacy-hex>"   # also tells you which one matches
 *
 * Get a real sample from a legacy device: it Serial.prints `encodedClientId`
 * right after connecting; the plaintext is `deviceId-mac` (rawId in the code).
 * No npm install needed — uses Node's built-in crypto.
 */
import crypto from "node:crypto";

const KEY = Buffer.from("ClocktoCrypt1234", "utf8"); // 16 bytes -> AES-128
const IV = Buffer.from("ClocktoCrypt1234", "utf8");  // 16 bytes

const BLOCK = 16;

/** Pad to a 16-byte multiple. When already aligned, AESLib appends a full block. */
function pad(buf, mode) {
  const rem = buf.length % BLOCK;
  const padLen = BLOCK - rem; // 1..16 (full block when aligned)
  const out = Buffer.alloc(buf.length + padLen);
  buf.copy(out);
  switch (mode) {
    case "pkcs7": // each pad byte = padLen
      out.fill(padLen, buf.length);
      break;
    case "bit": // ISO/IEC 7816-4: 0x80 then 0x00...
      out[buf.length] = 0x80;
      break; // rest already 0x00 from alloc
    case "zero": // 0x00...
      break; // already 0x00
    case "space": // 0x20...
      out.fill(0x20, buf.length);
      break;
  }
  return out;
}

function enc(plain, mode) {
  const c = crypto.createCipheriv("aes-128-cbc", KEY, IV);
  c.setAutoPadding(false);
  const padded = pad(Buffer.from(plain, "utf8"), mode);
  return Buffer.concat([c.update(padded), c.final()]).toString("hex");
}

const plain = process.argv[2];
const legacy = (process.argv[3] || "").toLowerCase().trim();
if (!plain) {
  console.error('usage: node cc_aes_ref.mjs "<plaintext>" ["<legacy-hex>"]');
  process.exit(1);
}

console.log(`plaintext: "${plain}" (${Buffer.byteLength(plain)} bytes)\n`);
let matched = null;
for (const mode of ["pkcs7", "bit", "zero", "space"]) {
  const hex = enc(plain, mode);
  const hit = legacy && hex === legacy ? "  <== MATCHES legacy" : "";
  if (hit) matched = mode;
  console.log(`${mode.padEnd(6)} : ${hex}${hit}`);
}
if (legacy) {
  console.log(
    matched
      ? `\n✅ AESLib paddingMode(1) == "${matched}" — set CC_AES_PAD to it in cc_aes.c`
      : `\n❌ none matched — paste the exact legacy hex (and confirm plaintext = deviceId-mac)`,
  );
}
