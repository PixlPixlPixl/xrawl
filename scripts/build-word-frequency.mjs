#!/usr/bin/env node
/**
 * Build the compressed local word-frequency table from a wordfreq "cBpack".
 *
 *   npm run build:wordfreq -- ./small_en.msgpack.gz
 *
 * The input is the small English wordlist that ships with wordfreq
 * (https://github.com/rspeer/wordfreq): a gzipped msgpack list whose first
 * element is a header and whose remaining elements are alphabetical lists of
 * words, one list per centibel bucket, where
 *
 *   zipf(word) = (900 - bucketIndex) / 100
 *
 * This script exists so the extension never depends on Python, at runtime or
 * build time: it reads the source data once and writes a plain TypeScript
 * string table, front-coded against the previous word and quantized to the
 * centibel the source already uses.
 *
 * The frequency DATA is CC BY-SA 4.0 (see wordfreq-attribution.md next to the
 * generated table); this derived table is shared under those terms too. The
 * wordfreq code itself is Apache 2.0.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = resolve(ROOT, "src/progression/data/wordfreq-en.ts");

/* ------------------------------------------------------------------ */
/* Minimal msgpack reader: only the subset a cBpack can contain       */
/* ------------------------------------------------------------------ */

function decodeMsgpack(buffer) {
  let offset = 0;

  function readString(length) {
    const value = buffer.subarray(offset, offset + length).toString("utf8");
    offset += length;
    return value;
  }

  function readUint(size) {
    let value = 0;
    for (let index = 0; index < size; index += 1) value = value * 256 + buffer[offset + index];
    offset += size;
    return value;
  }

  function readFloat(size) {
    const view = new DataView(buffer.buffer, buffer.byteOffset + offset, size);
    offset += size;
    return size === 4 ? view.getFloat32(0) : view.getFloat64(0);
  }

  function skipBytes(length) {
    offset += length;
    return null;
  }

  function read() {
    const marker = buffer[offset];
    offset += 1;

    if (marker <= 0x7f) return marker;
    if (marker >= 0x80 && marker <= 0x8f) return readMap(marker & 0x0f);
    if (marker >= 0x90 && marker <= 0x9f) return readArray(marker & 0x0f);
    if (marker >= 0xa0 && marker <= 0xbf) return readString(marker & 0x1f);

    switch (marker) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: return skipBytes(readUint(1));
      case 0xc5: return skipBytes(readUint(2));
      case 0xc6: return skipBytes(readUint(4));
      case 0xca: return readFloat(4);
      case 0xcb: return readFloat(8);
      case 0xcc: return readUint(1);
      case 0xcd: return readUint(2);
      case 0xce: return readUint(4);
      case 0xcf: return Number(readUint(8));
      case 0xd9: return readString(readUint(1));
      case 0xda: return readString(readUint(2));
      case 0xdb: return readString(readUint(4));
      case 0xdc: return readArray(readUint(2));
      case 0xdd: return readArray(readUint(4));
      case 0xde: return readMap(readUint(2));
      case 0xdf: return readMap(readUint(4));
      default:
        throw new Error("Unsupported msgpack marker 0x" + marker.toString(16) + " at " + (offset - 1));
    }
  }

  function readArray(length) {
    const values = [];
    for (let index = 0; index < length; index += 1) values.push(read());
    return values;
  }

  function readMap(length) {
    const values = {};
    for (let index = 0; index < length; index += 1) {
      const key = read();
      values[key] = read();
    }
    return values;
  }

  return read();
}

/* ------------------------------------------------------------------ */
/* Normalization + table encoding                                      */
/* ------------------------------------------------------------------ */

// Mirrors normalizeWord in src/world/perception/word-segmentation.ts so a page
// word hits exactly the key the extension looks up.
const EDGE_PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const APOSTROPHES = /[\u2018\u2019\u02BC]/g;

function normalizeWord(raw) {
  return raw.normalize("NFKC").toLowerCase().replace(APOSTROPHES, "'").replace(EDGE_PUNCTUATION, "");
}

const MAX_WORD_LENGTH = 64;
const MAX_PREFIX = 35;
const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

function digit(value) {
  if (value < 0 || value >= BASE36.length) throw new Error("Cannot encode " + value);
  return BASE36[value];
}

function packCode(code) {
  return digit(Math.floor(code / 36)) + digit(code % 36);
}

function main() {
  const input = process.argv[2];
  if (!input) {
    console.error("Usage: node scripts/build-word-frequency.mjs <small_en.msgpack.gz>");
    process.exit(1);
  }

  const decoded = decodeMsgpack(gunzipSync(readFileSync(input)));
  const header = decoded[0];
  if (!header || header.format !== "cB" || header.version !== 1) {
    throw new Error("Expected a cBpack v1 file (wordfreq small_en.msgpack.gz)");
  }

  // word -> zipf code, deduped on the normalized form. A duplicate keeps the
  // higher (more common) value: normalization merged two spellings.
  const frequencies = new Map();
  const buckets = decoded.slice(1);

  for (let bucketIndex = 0; bucketIndex < buckets.length; bucketIndex += 1) {
    const code = 900 - bucketIndex;
    if (code < 300 || code > 900) continue;
    for (const raw of buckets[bucketIndex]) {
      const word = normalizeWord(String(raw));
      if (word.length === 0 || word.length > MAX_WORD_LENGTH) continue;
      if (/\s/.test(word)) continue;
      const previous = frequencies.get(word);
      if (previous === undefined || code > previous) frequencies.set(word, code);
    }
  }

  const words = [...frequencies.keys()].sort(function compare(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
  });

  // Front coding: store only the suffix that differs from the previous word.
  // Sorting alphabetically first is what makes long prefixes shareable.
  let previous = "";
  const lines = [];
  for (const word of words) {
    let prefix = 0;
    const limit = Math.min(previous.length, word.length, MAX_PREFIX);
    while (prefix < limit && previous[prefix] === word[prefix]) prefix += 1;
    lines.push(digit(prefix) + word.slice(prefix) + packCode(frequencies.get(word)));
    previous = word;
  }

  const sourceHeader = [
    "/**",
    " * GENERATED FILE - do not edit by hand. Regenerate with:",
    " *",
    " *   npm run build:wordfreq -- <small_en.msgpack.gz>",
    " *",
    " * Encoded wordfreq data, front-coded against the previous word and quantized",
    " * to the centibels the source already uses. Each line is",
    " * <sharedPrefixLen><suffix><zipfCode>, where the last two characters are the",
    " * Zipf frequency times 100, in base 36.",
    " *",
    " * Source: wordfreq small_en wordlist by Robyn Speer",
    " * (https://wordfreq.readthedocs.io). Data license: CC BY-SA 4.0 - see",
    " * ./wordfreq-attribution.md for the notice and the ShareAlike terms that",
    " * apply to this derived table.",
    " */",
  ].join("\n");

  const bodyLines = lines.map(function quote(line) { return "  " + JSON.stringify(line); }).join(",\n");

  const output = sourceHeader
    + "\n\nexport const WORD_FREQUENCY_SOURCE = {\n"
    + "  dataset: \"wordfreq small_en\",\n"
    + "  attribution: \"Robyn Speer, wordfreq (https://github.com/rspeer/wordfreq)\",\n"
    + "  dataLicense: \"CC BY-SA 4.0\",\n"
    + "  format: \"cB-prefix-v1\",\n"
    + "  entryCount: " + words.length + ",\n"
    + "  maxZipfCode: 900,\n"
    + "} as const;\n\n"
    + "/** One encoded entry per line. Decoded lazily by frequency.ts. */\n"
    + "export const WORD_FREQUENCY_TABLE = [\n"
    + bodyLines + "\n"
    + "].join(\"\\n\");\n";

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, output);
  console.log("Wrote " + words.length + " words to " + OUTPUT + " (" + output.length + " bytes)");
}

main();
