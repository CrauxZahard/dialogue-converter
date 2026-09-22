/*
 * Dialogue Converter - core conversion library.
 *
 * This file is deliberately dependency-free so it can run both in the browser
 * (attached to window.DialogueConverter) and in Node for tests (module.exports).
 *
 * Responsibilities:
 *   - Normalize raw input text (mojibake, non-breaking spaces).
 *   - Detect the canonical BatchDialogueGenerator txt dialect and parse it with
 *     the exact same semantics as Assets/Editor/BatchDialogueGenerator.cs.
 *   - Convert freeform prose (a .docx storyline) into canonical blocks.
 *   - Serialize blocks back to the canonical .txt dialect.
 *   - Serialize blocks to a Unity .asset (YAML) matching DialogueAsset.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DialogueConverter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants mirrored from the Unity project.
  // ---------------------------------------------------------------------------

  var DIALOGUE_TYPE = { DIALOGUE: 0, QUESTION: 1, MONOLOGUE: 2 };

  var TYPE_TO_INT = { dialogue: 0, question: 1, monologue: 2 };
  var INT_TO_TYPE = { 0: 'dialogue', 1: 'question', 2: 'monologue' };

  var TEXT_POSITION = { NORMAL: 0, CENTER_BOTTOM: 1 };

  // CharacterExpression enum order from Assets/Scripts/Types/GameEnums.cs
  var CHARACTER_EXPRESSIONS = [
    'Neutral', 'Happy', 'Sad', 'Angry', 'Surprised',
    'Confused', 'Excited', 'Scared', 'Tired', 'Bored'
  ];

  // Speaker map from BatchDialogueGenerator.BuildSpeakerMap(). Speakers outside
  // this set are kept verbatim but flagged as unmapped (no portrait will resolve).
  var KNOWN_SPEAKERS = [
    '@Player', 'Nadezhda', 'Carol', 'Leon', 'Amaya', 'Officer #1',
    'Old Dweller #1', 'Soldier #1', 'Soldier #2', 'Soldier on Comm',
    'Announcer', 'Tutorial', 'Medein'
  ];

  var ASSET_SCRIPT_GUID = 'c1220b904cdf32142a8ad7e98d130775';

  // ---------------------------------------------------------------------------
  // Small utilities.
  // ---------------------------------------------------------------------------

  function splitLines(text) {
    return String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  }

  function normalizeInputText(text, options) {
    var opts = options || {};
    var out = String(text == null ? '' : text);
    out = out.replace(/\r\n?/g, '\n');
    out = out.replace(/\u00a0/g, ' ');

    if (opts.fixMojibake !== false) {
      // Common UTF-8 -> Windows-1252 mojibake sequences.
      var mojibake = [
        ['\u00e2\u0080\u0099', '\u2019'],
        ['\u00e2\u0080\u0098', '\u2018'],
        ['\u00e2\u0080\u009c', '\u201c'],
        ['\u00e2\u0080\u009d', '\u201d'],
        ['\u00e2\u0080\u0093', '\u2013'],
        ['\u00e2\u0080\u0094', '\u2014'],
        ['\u00e2\u0080\u00a6', '\u2026'],
        ['\u00c2\u00a0', ' ']
      ];
      for (var i = 0; i < mojibake.length; i++) {
        out = out.split(mojibake[i][0]).join(mojibake[i][1]);
      }
      // U+FFFD replacement character -> apostrophe (most common lost glyph).
      if (opts.replaceReplacementChar !== false) {
        out = out.replace(/\uFFFD/g, "'");
      }
    }
    return out;
  }

  function trimEnd(text) {
    return String(text).replace(/\s+$/, '');
  }

  function endsWithSemicolon(text) {
    return /;\s*$/.test(String(text));
  }

  function normalizeMultiline(text) {
    return String(text).trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  function removeTrailingSemicolon(text) {
    var trimmed = trimEnd(text);
    if (trimmed.charAt(trimmed.length - 1) === ';') {
      trimmed = trimmed.slice(0, -1);
    }
    return normalizeMultiline(trimmed);
  }

  // Mirrors BatchDialogueGenerator.ExtractValue (case-sensitive prefix).
  function extractValue(line, keyword) {
    var value = line.slice(keyword.length).trim();
    if (value.charAt(value.length - 1) === ';') {
      value = value.slice(0, -1);
    }
    return value;
  }

  // Mirrors BatchDialogueGenerator.ExtractRawAfterKeyword (case-insensitive).
  function extractRawAfterKeyword(line, keyword) {
    var index = line.toLowerCase().indexOf(keyword.toLowerCase());
    if (index < 0) return '';
    return line.slice(index + keyword.length).trim();
  }

  // Mirrors BatchDialogueGenerator.ParseChoicesRaw.
  function parseChoicesRaw(raw) {
    var content = String(raw == null ? '' : raw).trim();
    if (content.charAt(0) === '[' && content.charAt(content.length - 1) === ']') {
      content = content.slice(1, -1);
    }
    var results = [];
    var regex = /("([^"]*)")|('([^']*)')|([^,]+)/g;
    var match;
    while ((match = regex.exec(content)) !== null) {
      var token = null;
      if (match[2] !== undefined) token = match[2];
      else if (match[4] !== undefined) token = match[4];
      else if (match[5] !== undefined) token = match[5].trim();
      if (token != null && token !== '') results.push(token.trim());
    }
    return results;
  }

  function parseDialogueTypeString(typeStr, onWarn) {
    switch (String(typeStr).trim().toLowerCase()) {
      case 'monologue': return 'monologue';
      case 'question': return 'question';
      case 'dialogue': return 'dialogue';
      default:
        if (onWarn) onWarn('Unknown TYPE "' + typeStr + '" - defaulting to dialogue.');
        return 'dialogue';
    }
  }

  function typeToInt(type) {
    return Object.prototype.hasOwnProperty.call(TYPE_TO_INT, type) ? TYPE_TO_INT[type] : 0;
  }

  function intToType(value) {
    return Object.prototype.hasOwnProperty.call(INT_TO_TYPE, value) ? INT_TO_TYPE[value] : 'dialogue';
  }

  // ---------------------------------------------------------------------------
  // Block model.
  // ---------------------------------------------------------------------------

  function createBlock(overrides) {
    var block = {
      type: 'dialogue',
      character: '',
      text: '',
      choices: [],
      expression: 0,
      text_type: TEXT_POSITION.NORMAL,
      directive: false
    };
    if (overrides) {
      for (var key in overrides) {
        if (Object.prototype.hasOwnProperty.call(overrides, key)) block[key] = overrides[key];
      }
    }
    return block;
  }

  // ---------------------------------------------------------------------------
  // Canonical dialect detection + parser (mirrors ParseDialogueAsset exactly).
  // ---------------------------------------------------------------------------

  function isCanonicalDialect(text) {
    var lines = splitLines(text);
    var hasType = false;
    var hasText = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (/^TYPE\s+\S+/i.test(line)) hasType = true;
      if (/^TEXT\b/i.test(line)) hasText = true;
      if (hasType && hasText) return true;
    }
    return false;
  }

  function parseCanonicalTxt(text) {
    var warnings = [];
    var blocks = [];
    var lines = splitLines(text);

    var lastType = 'dialogue';
    var current = createBlock();
    var textBuffer = '';
    var readingText = false;

    function warn(message) { warnings.push(message); }

    function commit(lastTypeForLine) {
      var hasChoices = current.choices && current.choices.length > 0;
      if (current.text !== '' || current.character !== '' || hasChoices) {
        current.type = lastTypeForLine;
        blocks.push(current);
        current = createBlock();
      }
    }

    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var line = raw.trim();
      if (line === '') continue;

      if (line.indexOf('TYPE') === 0) {
        current.type = parseDialogueTypeString(extractValue(line, 'TYPE'), warn);
        lastType = current.type;
      } else if (line.indexOf('CHAR') === 0) {
        commit(lastType);
        current.character = extractValue(line, 'CHAR');
        current.type = lastType;
        current.text = '';
        current.choices = [];
      } else if (line.indexOf('TEXT') === 0) {
        var after = extractRawAfterKeyword(raw, 'TEXT');
        if (endsWithSemicolon(after)) {
          current.text = removeTrailingSemicolon(after);
          current.type = lastType;
          commit(lastType);
        } else {
          readingText = true;
          textBuffer = after;
        }
      } else if (readingText) {
        textBuffer += '\n' + raw;
        if (/;\s*$/.test(line)) {
          current.text = removeTrailingSemicolon(textBuffer);
          current.type = lastType;
          commit(lastType);
          textBuffer = '';
          readingText = false;
        }
      } else if (line.indexOf('EXPRESSION') === 0) {
        var exprStr = extractValue(line, 'EXPRESSION');
        var exprIndex = parseInt(exprStr, 10);
        if (!isNaN(exprIndex) && String(exprIndex) === exprStr) {
          current.expression = exprIndex;
        } else {
          var named = CHARACTER_EXPRESSIONS.indexOf(exprStr);
          if (named >= 0) {
            current.expression = named;
          } else {
            warn('Unrecognized EXPRESSION "' + exprStr + '" - keeping default 0.');
          }
        }
      } else if (line.indexOf('CHOICES') === 0) {
        var rawChoices = removeTrailingSemicolon(extractRawAfterKeyword(raw, 'CHOICES'));
        current.choices = parseChoicesRaw(rawChoices);
        current.type = 'question';
        commit('question');
      }
    }

    if (readingText) {
      warn('File ended while reading a multi-line TEXT block; the last line was force-closed (mirrors CommitLine flush at EOF).');
    }
    commit(lastType);
    return { blocks: blocks, warnings: warnings };
  }

  // ---------------------------------------------------------------------------
  // Freeform -> canonical blocks.
  // ---------------------------------------------------------------------------

  var RE_TIMESTAMP = /^\d{1,2}:\d{2}\s*(am|pm)\b/i;
  var RE_DIRECTIVE = /^(if|when|objective|stage|gimmick|condition|note|cutscene|else)\b/i;
  var RE_MONOLOGUE_PREFIX = /(^|\s)monologue\b/i;
  var RE_CHOICE = /^[-\u2013\u2014\u2022*]\s+(.*)$/;
  var RE_DASH = /^[-\u2013\u2014]/;
  var RE_BRACKET = /^\[/;
  var RE_PAREN = /^\(/;

  function isNameLikePrefix(prefix) {
    if (!prefix) return false;
    if (prefix.length > 60) return false;
    if (RE_TIMESTAMP.test(prefix + ' AM')) return false;
    if (RE_DIRECTIVE.test(prefix)) return false;
    if (/^\d+$/.test(prefix)) return false;
    // Letters, numbers, spaces and the punctuation that appears in speaker names
    // such as "@Player", "Officer #1", "Old Dweller#1", "Leon & Carol", "???".
    return /^[\p{L}\p{N}\s@#&._'\u2019\-?]+$/u.test(prefix);
  }

  function splitSpeaker(line) {
    var index = line.indexOf(':');
    if (index < 0) return null;
    var prefix = line.slice(0, index).trim();
    var rest = line.slice(index + 1).trim();
    if (!isNameLikePrefix(prefix)) return null;
    return { prefix: prefix, rest: rest };
  }

  function classifyLine(raw) {
    var line = String(raw).trim();
    if (line === '') return { kind: 'blank' };
    if (RE_BRACKET.test(line)) return { kind: 'monologue', text: line, directive: true };
    if (RE_PAREN.test(line)) return { kind: 'monologue', text: line, directive: true };
    if (RE_TIMESTAMP.test(line)) return { kind: 'monologue', text: line, directive: true };

    var choice = line.match(RE_CHOICE);
    if (choice) return { kind: 'choice', text: choice[1].trim() };

    if (RE_DASH.test(line)) return { kind: 'monologue', text: line, directive: true };
    // Directive keywords ("IF ...:", "When ...:") only count when the line is
    // actually a labelled directive, so prose like "When I was a child" is safe.
    if (RE_DIRECTIVE.test(line) && line.indexOf(':') >= 0) {
      return { kind: 'monologue', text: line, directive: true };
    }

    var speaker = splitSpeaker(line);
    if (speaker) {
      if (RE_MONOLOGUE_PREFIX.test(speaker.prefix)) {
        return { kind: 'monologue', text: speaker.rest, speakerMarker: speaker.prefix };
      }
      return { kind: 'speaker', character: speaker.prefix, text: speaker.rest };
    }

    if (RE_MONOLOGUE_PREFIX.test(line)) return { kind: 'monologue', text: line };
    return { kind: 'plain', text: line };
  }

  function endsWithTerminator(text) {
    return /[.!?\u2026]+["'\u201d\u2019)\]]*$/.test(trimEnd(text));
  }

  function startsLikeNewSentence(text) {
    var t = String(text).replace(/^\s+/, '');
    if (t === '') return false;
    var ch = t.charAt(0);
    if (/\p{Lu}/u.test(ch)) return true;
    if ('\u201c"\'[\u2018\u300c'.indexOf(ch) >= 0) return true;
    return false;
  }

  function canAppendPlain(text, current) {
    if (!current) return false;
    if (current.type === 'question') return false;
    if (current.directive) return false;
    if (current.text === '') return true;
    if (endsWithTerminator(current.text)) return false;
    return !startsLikeNewSentence(text);
  }

  function appendText(block, text) {
    if (block.text === '') block.text = text;
    else block.text = block.text + ' ' + text;
  }

  function convertFreeform(paragraphs) {
    var blocks = [];
    var warnings = [];
    var current = null;
    var pendingChoices = false;
    var prevBlank = true;

    function pushBlock(block) {
      blocks.push(block);
      current = block;
      return block;
    }

    for (var i = 0; i < paragraphs.length; i++) {
      var info = classifyLine(paragraphs[i]);

      if (info.kind === 'blank') {
        prevBlank = true;
        pendingChoices = false;
        continue;
      }

      if (info.kind === 'choice') {
        if (current && !prevBlank && pendingChoices) {
          if (current.type !== 'question') current.type = 'question';
          current.choices.push(info.text);
        } else {
          // Orphan choice: keep it as a monologue so nothing is silently dropped.
          pushBlock(createBlock({ type: 'monologue', text: info.text, directive: true }));
          warnings.push('Choice-like line outside a question block kept as monologue: "' + info.text + '"');
        }
        prevBlank = false;
        continue;
      }

      if (info.kind === 'plain' || info.kind === 'monologue') {
        var canAppend = info.directive !== true && current && !prevBlank &&
          canAppendPlain(info.text, current);
        if (canAppend) {
          appendText(current, info.text);
        } else {
          pushBlock(createBlock({
            type: 'monologue',
            text: info.text,
            directive: info.directive === true
          }));
        }
        pendingChoices = false;
        prevBlank = false;
        continue;
      }

      // Speaker line. Adjacent lines from the same speaker are merged, matching
      // how the shipped canonical DialogueSource files were produced.
      var sameSpeaker = current && !prevBlank &&
        current.type === 'dialogue' &&
        current.character === info.character;

      if (sameSpeaker) {
        appendText(current, info.text);
      } else {
        pushBlock(createBlock({
          type: 'dialogue',
          character: info.character,
          text: info.text
        }));
      }
      pendingChoices = true;
      prevBlank = false;
    }

    // Drop content-free blocks: they carry neither text nor choices and cannot
    // round-trip through the canonical parser.
    var kept = [];
    var removedEmpty = 0;
    for (var b = 0; b < blocks.length; b++) {
      var hasText = blocks[b].text != null && blocks[b].text !== '';
      var hasChoices = blocks[b].choices && blocks[b].choices.length > 0;
      if (hasText || hasChoices) kept.push(blocks[b]);
      else removedEmpty++;
    }
    if (removedEmpty > 0) {
      warnings.push(removedEmpty + ' content-free block(s) removed (no text and no choices).');
    }

    return { blocks: kept, warnings: warnings };
  }

  // ---------------------------------------------------------------------------
  // Canonical .txt serialization.
  // ---------------------------------------------------------------------------

  function serializeChoicesToken(choice) {
    if (/[,\[\]"]/.test(choice)) {
      return '"' + choice.replace(/"/g, '') + '"';
    }
    return choice;
  }

  function serializeCanonicalTxt(blocks) {
    var out = [];
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      var type = block.type || 'dialogue';
      out.push('TYPE ' + type);

      // EXPRESSION is emitted right after TYPE: the Unity parser commits the
      // previous line on CHAR/TEXT, so this placement binds the expression to
      // the block that follows.
      if (block.expression && block.expression !== 0) {
        out.push('EXPRESSION ' + block.expression);
      }

      if (type !== 'monologue' && block.character) {
        out.push('CHAR ' + block.character);
      }

      var text = block.text == null ? '' : String(block.text);
      if (text !== '') {
        var textLines = text.replace(/\r\n?/g, '\n').split('\n');
        if (textLines.length === 1) {
          out.push('TEXT ' + textLines[0] + ';');
        } else {
          out.push('TEXT ' + textLines[0]);
          for (var l = 1; l < textLines.length; l++) out.push(textLines[l]);
          out[out.length - 1] = out[out.length - 1] + ';';
        }
      }

      if (type === 'question' && block.choices && block.choices.length > 0) {
        var tokens = [];
        for (var c = 0; c < block.choices.length; c++) {
          tokens.push(serializeChoicesToken(String(block.choices[c])));
        }
        out.push('CHOICES [' + tokens.join(', ') + '];');
      }

      out.push('');
    }
    return out.join('\n').replace(/\n+$/, '\n');
  }

  // ---------------------------------------------------------------------------
  // Unity YAML scalar helpers.
  // ---------------------------------------------------------------------------

  function yamlNeedsQuote(value) {
    if (/^[\s]|[\s]$/.test(value)) return true;
    if (/[\n\r\t]/.test(value)) return true;
    if (/^[-?:,\[\]{}#&*!|>'"%@`]/.test(value)) return true;
    if (value.indexOf(': ') >= 0 || value.charAt(value.length - 1) === ':') return true;
    if (/^(null|Null|NULL|true|false|yes|no|on|off|~)$/.test(value)) return true;
    return false;
  }

  function yamlScalar(value) {
    var s = value == null ? '' : String(value);
    if (s === '') return '';
    if (yamlNeedsQuote(s)) return "'" + s.replace(/'/g, "''") + "'";
    return s;
  }

  function yamlDoubleQuoted(value) {
    var s = value == null ? '' : String(value);
    if (s === '') return '';
    var out = '"';
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      var code = s.charCodeAt(i);
      if (ch === '"') out += '\\"';
      else if (ch === '\\') out += '\\\\';
      else if (ch === '\n') out += '\\n';
      else if (ch === '\r') { /* drop CR */ }
      else if (ch === '\t') out += '\\t';
      else if (code < 0x20 || code > 0x7e) out += '\\u' + code.toString(16).padStart(4, '0');
      else out += ch;
    }
    return out + '"';
  }

  function sanitizeAssetName(name) {
    var base = String(name == null ? '' : name);
    base = base.replace(/^.*[\\/]/, '');        // strip any path
    base = base.replace(/\.[^.]+$/, '');        // strip extension
    base = base.replace(/[\\/:*?"<>|]+/g, '_'); // illegal filename characters
    base = base.replace(/\s+/g, '_');           // whitespace -> underscore
    base = base.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    if (base === '' || base === '.' || base === '..') base = 'DialogueAsset';
    return base;
  }

  // ---------------------------------------------------------------------------
  // .asset generation.
  // ---------------------------------------------------------------------------

  function buildAssetYaml(meta, blocks, options) {
    var opts = options || {};
    var assetName = sanitizeAssetName(meta.assetName || 'DialogueAsset');
    var dialogueId = parseInt(meta.dialogueId, 10);
    if (isNaN(dialogueId)) dialogueId = 0;
    var title = meta.title == null || meta.title === '' ? assetName : String(meta.title);
    var description = meta.description == null ? '' : String(meta.description);
    var nextSceneName = meta.nextSceneName == null ? '' : String(meta.nextSceneName);

    var lines = [];
    lines.push('%YAML 1.1');
    lines.push('%TAG !u! tag:unity3d.com,2011:');
    lines.push('--- !u!114 &11400000');
    lines.push('MonoBehaviour:');
    lines.push('  m_ObjectHideFlags: 0');
    lines.push('  m_CorrespondingSourceObject: {fileID: 0}');
    lines.push('  m_PrefabInstance: {fileID: 0}');
    lines.push('  m_PrefabAsset: {fileID: 0}');
    lines.push('  m_GameObject: {fileID: 0}');
    lines.push('  m_Enabled: 1');
    lines.push('  m_EditorHideFlags: 0');
    lines.push('  m_Script: {fileID: 11500000, guid: ' + ASSET_SCRIPT_GUID + ', type: 3}');
    lines.push('  m_Name: ' + yamlScalar(assetName));
    lines.push('  m_EditorClassIdentifier: Assembly-CSharp::DialogueAsset');
    lines.push('  dialogue_id: ' + (dialogueId | 0));
    lines.push('  title: ' + yamlScalar(title));
    lines.push('  description: ' + yamlScalar(description));

    if (!blocks || blocks.length === 0) {
      lines.push('  dialogueLines: []');
    } else {
      lines.push('  dialogueLines:');
      for (var i = 0; i < blocks.length; i++) {
        var block = blocks[i];
        var type = block.type || 'dialogue';
        var textType = block.text_type === TEXT_POSITION.CENTER_BOTTOM ? 1 : 0;
        var expression = parseInt(block.expression, 10);
        if (isNaN(expression)) expression = 0;
        var character = type === 'monologue' ? '' : (block.character || '');

        lines.push('  - type: ' + typeToInt(type));
        lines.push('    text_type: ' + textType);
        lines.push('    character: ' + yamlScalar(character));
        lines.push('    expression: ' + (expression | 0));
        lines.push('    text: ' + yamlDoubleQuoted(block.text || ''));
        if (block.choices && block.choices.length > 0) {
          lines.push('    choices:');
          for (var c = 0; c < block.choices.length; c++) {
            lines.push('    - ' + yamlScalar(String(block.choices[c])));
          }
        } else {
          lines.push('    choices: []');
        }
        lines.push('    background: {fileID: 0}');
        lines.push('    char_icon: {fileID: 0}');
        lines.push('    char_fullPortrait: {fileID: 0}');
        lines.push('    glitch_text: ');
        lines.push('    voice_over:');
        lines.push('      audio_clip: {fileID: 0}');
        lines.push('      start_time: 0');
        lines.push('      end_time: 0');
      }
    }

    lines.push('  nextDialogue: {fileID: 0}');
    lines.push('  nextSceneName: ' + yamlScalar(nextSceneName));
    return lines.join('\n') + '\n';
  }

  // ---------------------------------------------------------------------------
  // Warnings analysis shared by both pipelines.
  // ---------------------------------------------------------------------------

  function analyzeBlocks(blocks, extraWarnings) {
    var warnings = (extraWarnings || []).slice();
    var unmapped = [];
    var seenUnmapped = {};
    var emptyText = [];
    var questionsWithoutChoices = [];

    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      var character = block.type === 'monologue' ? '' : (block.character || '');
      if (character && character !== '???' && KNOWN_SPEAKERS.indexOf(character) < 0 && !seenUnmapped[character]) {
        seenUnmapped[character] = true;
        unmapped.push(character);
      }
      if (character === '???') {
        warnings.push('Line ' + (i + 1) + ': speaker is "???". Portrait cannot be resolved automatically.');
      }
      var hasChoices = block.choices && block.choices.length > 0;
      if ((block.text == null || block.text === '') && !hasChoices) {
        emptyText.push(i + 1);
      }
      if (block.type === 'question' && !hasChoices) {
        questionsWithoutChoices.push(i + 1);
      }
    }

    if (unmapped.length > 0) {
      warnings.push('Unmapped speaker(s) have no portrait entry and will stay null: ' + unmapped.join(', ') + '. (' + (unmapped.length) + ')');
    }
    if (emptyText.length > 0) {
      warnings.push('Block(s) with empty text: ' + summarizeIndices(emptyText) + '.');
    }
    if (questionsWithoutChoices.length > 0) {
      warnings.push('Question block(s) without choices: ' + summarizeIndices(questionsWithoutChoices) + '.');
    }

    var directiveCount = 0;
    var directiveSamples = [];
    for (var d = 0; d < blocks.length; d++) {
      if (blocks[d].directive) {
        directiveCount++;
        if (directiveSamples.length < 5) {
          directiveSamples.push('"' + (blocks[d].text || '').slice(0, 60) + '"');
        }
      }
    }
    if (directiveCount > 0) {
      warnings.push(directiveCount + ' stage/directive line(s) kept as monologue (e.g. ' + directiveSamples.join(', ') + '). Delete them in the preview if unwanted.');
    }

    return { warnings: warnings, unmapped: unmapped, emptyText: emptyText, questionsWithoutChoices: questionsWithoutChoices };
  }

  function summarizeIndices(indices) {
    if (indices.length <= 8) return indices.join(', ');
    return indices.slice(0, 8).join(', ') + ' ... (+' + (indices.length - 8) + ' more)';
  }

  // ---------------------------------------------------------------------------
  // Top-level pipeline.
  // ---------------------------------------------------------------------------

  function paragraphsFromText(text) {
    return splitLines(text);
  }

  // mammoth's extractRawText puts "\n\n" between paragraphs and a single "\n"
  // for in-paragraph line breaks. Collapse the paragraph separators so wrapped
  // lines stay adjacent (mergeable) while genuine blank paragraphs survive.
  function paragraphsFromDocxRawText(text) {
    var blocks = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n\n');
    var lines = [];
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      if (block.trim() === '') {
        lines.push('');
        continue;
      }
      var sub = block.split('\n');
      for (var j = 0; j < sub.length; j++) lines.push(sub[j]);
    }
    return lines;
  }

  // Every committed DialogueAsset uses NORMAL for dialogue/question and
  // CENTER_BOTTOM for monologue. The preview can override this per row.
  function applyTextTypeDefaults(blocks) {
    for (var i = 0; i < blocks.length; i++) {
      blocks[i].text_type = blocks[i].type === 'monologue'
        ? TEXT_POSITION.CENTER_BOTTOM
        : TEXT_POSITION.NORMAL;
    }
    return blocks;
  }

  function convert(text, options) {
    var opts = options || {};
    var normalized = normalizeInputText(text, opts);
    var pipeline;
    if (isCanonicalDialect(normalized)) {
      pipeline = parseCanonicalTxt(normalized);
      pipeline.mode = 'canonical';
    } else {
      var paragraphs = opts.sourceType === 'docx'
        ? paragraphsFromDocxRawText(normalized)
        : paragraphsFromText(normalized);
      pipeline = convertFreeform(paragraphs);
      pipeline.mode = 'freeform';
    }
    applyTextTypeDefaults(pipeline.blocks);
    var analysis = analyzeBlocks(pipeline.blocks, pipeline.warnings);
    return {
      mode: pipeline.mode,
      blocks: pipeline.blocks,
      warnings: analysis.warnings,
      parseWarnings: pipeline.warnings,
      unmapped: analysis.unmapped,
      emptyText: analysis.emptyText,
      questionsWithoutChoices: analysis.questionsWithoutChoices
    };
  }

  function toAsset(meta, blocks, options) {
    return buildAssetYaml(meta, blocks, options);
  }

  function toTxt(blocks) {
    return serializeCanonicalTxt(blocks);
  }

  return {
    DIALOGUE_TYPE: DIALOGUE_TYPE,
    TYPE_TO_INT: TYPE_TO_INT,
    TEXT_POSITION: TEXT_POSITION,
    CHARACTER_EXPRESSIONS: CHARACTER_EXPRESSIONS,
    KNOWN_SPEAKERS: KNOWN_SPEAKERS,
    normalizeInputText: normalizeInputText,
    isCanonicalDialect: isCanonicalDialect,
    parseCanonicalTxt: parseCanonicalTxt,
    convertFreeform: convertFreeform,
    paragraphsFromDocxRawText: paragraphsFromDocxRawText,
    classifyLine: classifyLine,
    serializeCanonicalTxt: serializeCanonicalTxt,
    buildAssetYaml: buildAssetYaml,
    sanitizeAssetName: sanitizeAssetName,
    analyzeBlocks: analyzeBlocks,
    parseChoicesRaw: parseChoicesRaw,
    convert: convert,
    toAsset: toAsset,
    toTxt: toTxt
  };
});
