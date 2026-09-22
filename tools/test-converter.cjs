/*
 * Local checks for the conversion core.
 *
 *   node tools/test-converter.cjs
 *
 * Optional environment overrides:
 *   UNITY_PROJECT  path to the "Into The Stars" Unity project
 *                  (default: D:\Coding project\Into The Stars)
 *   DOCX_PARAGRAPHS  a text file with one paragraph per line used for the
 *                    freeform test (default: %TEMP%\redrain_paras.txt)
 *
 * The script skips checks whose input files are missing instead of failing.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const DC = require(path.join(__dirname, '..', 'js', 'converter.js'));

const unity = process.env.UNITY_PROJECT || 'D:\\Coding project\\Into The Stars';
const ch0Txt = path.join(unity, 'Assets', 'Editor', 'DialogueSource', 'Ch0_10_TopFloor.txt');
const ch0Asset = path.join(unity, 'Assets', 'Resources', 'Scriptables', 'Dialogues', 'Arc1', 'Prologue', 'Ch0_10_TopFloor.asset');
const redRainParas = process.env.DOCX_PARAGRAPHS || path.join(process.env.TEMP || '.', 'redrain_paras.txt');

let failures = 0;
let skipped = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log('  PASS  ' + name);
  } else {
    failures++;
    console.log('  FAIL  ' + name + (detail ? ' :: ' + detail : ''));
  }
}
function skip(name) {
  skipped++;
  console.log('  SKIP  ' + name);
}

function decodeAssetDouble(raw) {
  let v = raw.trim();
  if (v.startsWith('"')) v = v.slice(1, -1);
  return v
    .replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function readAssetBlocks(assetRaw) {
  const assetLines = assetRaw.split(/\r?\n/);
  const assetBlocks = [];
  let pendingText = null;
  for (const line of assetLines) {
    if (pendingText) {
      const continues = pendingText.quoted ? true : /^      \S/.test(line);
      if (continues) {
        pendingText.parts.push(line.trim());
        if (pendingText.quoted && /"\s*$/.test(line)) {
          pendingText.block.text = decodeAssetDouble(pendingText.parts.join(' '));
          pendingText = null;
        }
        continue;
      }
      pendingText.block.text = pendingText.quoted
        ? decodeAssetDouble(pendingText.parts.join(' '))
        : pendingText.parts.join(' ');
      pendingText = null;
    }
    const typeMatch = line.match(/^  - type: (\d+)/);
    if (typeMatch) { assetBlocks.push({ type: Number(typeMatch[1]), character: '', text: '', text_type: 0 }); continue; }
    const ttMatch = line.match(/^    text_type: (\d+)/);
    if (ttMatch && assetBlocks.length) { assetBlocks[assetBlocks.length - 1].text_type = Number(ttMatch[1]); continue; }
    const charMatch = line.match(/^    character: (.*)$/);
    if (charMatch && assetBlocks.length) {
      let v = charMatch[1].trim();
      if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1).replace(/''/g, "'");
      assetBlocks[assetBlocks.length - 1].character = v;
      continue;
    }
    const textMatch = line.match(/^    text: (.*)$/);
    if (textMatch && assetBlocks.length) {
      const rest = textMatch[1].trim();
      const block = assetBlocks[assetBlocks.length - 1];
      if (rest.startsWith('"') && !/"\s*$/.test(rest)) {
        pendingText = { block: block, parts: [rest], quoted: true };
      } else if (rest.startsWith('"')) {
        block.text = decodeAssetDouble(rest);
      } else if (rest.startsWith("'")) {
        block.text = rest.slice(1, -1).replace(/''/g, "'");
      } else {
        block.text = rest;
        pendingText = { block: block, parts: [rest], quoted: false };
      }
    }
  }
  if (pendingText) {
    pendingText.block.text = pendingText.quoted
      ? decodeAssetDouble(pendingText.parts.join(' '))
      : pendingText.parts.join(' ');
  }
  return assetBlocks;
}

// --- 1. canonical detection + round trip -----------------------------------
console.log('\n[1] Canonical dialect round-trip (Ch0_10_TopFloor.txt)');
let parsed = null;
if (!fs.existsSync(ch0Txt)) {
  skip('canonical source not found at ' + ch0Txt);
} else {
  const canonical = fs.readFileSync(ch0Txt, 'utf8');
  check('detected as canonical', DC.isCanonicalDialect(canonical));

  parsed = DC.parseCanonicalTxt(canonical);
  console.log('  blocks: ' + parsed.blocks.length + ', warnings: ' + parsed.warnings.length);
  const reserialized = DC.serializeCanonicalTxt(parsed.blocks);
  const reparsed = DC.parseCanonicalTxt(reserialized);
  check('reparse block count stable', reparsed.blocks.length === parsed.blocks.length,
    parsed.blocks.length + ' vs ' + reparsed.blocks.length);

  let mismatch = -1;
  for (let i = 0; i < parsed.blocks.length; i++) {
    if (parsed.blocks[i].text !== reparsed.blocks[i].text ||
        parsed.blocks[i].character !== reparsed.blocks[i].character ||
        parsed.blocks[i].type !== reparsed.blocks[i].type) {
      mismatch = i; break;
    }
  }
  check('reparse text/character/type identical', mismatch === -1, 'first mismatch at block ' + mismatch);

  if (fs.existsSync(ch0Asset)) {
    const converted = DC.convert(canonical, { sourceType: 'txt' });
    const assetBlocks = readAssetBlocks(fs.readFileSync(ch0Asset, 'utf8'));
    check('asset block count equals parsed block count', assetBlocks.length === converted.blocks.length,
      assetBlocks.length + ' vs ' + converted.blocks.length);
    let assetMismatch = -1;
    for (let i = 0; i < converted.blocks.length; i++) {
      const a = assetBlocks[i];
      if (!a) { assetMismatch = i; break; }
      if (a.type !== DC.TYPE_TO_INT[converted.blocks[i].type] ||
          a.character !== converted.blocks[i].character ||
          a.text !== converted.blocks[i].text ||
          a.text_type !== converted.blocks[i].text_type) {
        assetMismatch = i; break;
      }
    }
    check('parsed lines match committed asset lines (incl. text_type)', assetMismatch === -1,
      'first mismatch at block ' + assetMismatch +
      (assetMismatch >= 0 ? ' parsed=' + JSON.stringify(converted.blocks[assetMismatch]) + ' asset=' + JSON.stringify(assetBlocks[assetMismatch]) : ''));
  } else {
    skip('committed asset not found at ' + ch0Asset);
  }
}

// --- 2. freeform conversion on the real docx --------------------------------
console.log('\n[2] Freeform conversion (docx paragraphs)');
if (!fs.existsSync(redRainParas)) {
  skip('paragraph file not found at ' + redRainParas);
} else {
  const paras = fs.readFileSync(redRainParas, 'utf8').split(/\r?\n/);
  const result = DC.convert(paras.join('\n'), {});
  check('detected as freeform', result.mode === 'freeform');
  console.log('  paragraphs: ' + paras.length + ', blocks: ' + result.blocks.length + ', warnings: ' + result.warnings.length);

  const haystack = result.blocks.map(b => (b.text || '') + ' ' + (b.choices || []).join(' ')).join('\n');
  const dropped = [];
  for (const raw of paras) {
    const text = raw.trim();
    if (!text) continue;
    const withoutDash = text.replace(/^[-\u2013\u2014\u2022*]\s+/, '');
    const idx = withoutDash.indexOf(':');
    const payload = idx >= 0 ? withoutDash.slice(idx + 1).trim() : withoutDash;
    if (payload === '') continue; // bare labels carry no content
    if (!haystack.includes(payload)) dropped.push(text);
  }
  check('no paragraphs dropped', dropped.length === 0, dropped.slice(0, 5).join(' | '));

  console.log('  unmapped: ' + result.unmapped.join(', '));
  console.log('  question blocks: ' + result.blocks.filter(b => b.type === 'question').length);
}

// --- 3. asset YAML smoke test ----------------------------------------------
console.log('\n[3] Asset YAML generation');
if (!parsed) {
  skip('needs section 1 output');
} else {
  const yaml = DC.toAsset(
    {
      assetName: 'Red_Rain_Storyline_Dialogue_1',
      title: 'Red_Rain_Storyline_Dialogue_1',
      dialogueId: 0,
      description: 'Batch generated from Red Rain Storyline Dialogue (1).docx',
      nextSceneName: ''
    },
    parsed.blocks
  );
  check('yaml starts with %YAML', yaml.startsWith('%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:'));
  check('yaml has script guid', yaml.includes('guid: c1220b904cdf32142a8ad7e98d130775'));
  check('yaml has nextSceneName', yaml.includes('  nextSceneName: '));
  check('sprite stubs are null', yaml.includes('background: {fileID: 0}') && yaml.includes('char_icon: {fileID: 0}'));
  check('asset name sanitised',
    DC.sanitizeAssetName('Red Rain Storyline Dialogue (1).docx') === 'Red_Rain_Storyline_Dialogue_(1)',
    DC.sanitizeAssetName('Red Rain Storyline Dialogue (1).docx'));
}

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED') +
  (skipped ? ' (' + skipped + ' skipped)' : ''));
process.exit(failures === 0 ? 0 : 1);
