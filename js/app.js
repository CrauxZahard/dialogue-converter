/* Dialogue Converter - UI wiring. Depends on js/converter.js and mammoth.browser. */
(function () {
  'use strict';

  var DC = window.DialogueConverter;
  var MAX_FILE_BYTES = 5 * 1024 * 1024;

  var el = {};
  var state = {
    fileName: '',
    fileSize: 0,
    rawText: '',
    sourceType: '',
    mode: '',
    blocks: [],
    parseWarnings: [],
    meta: { assetName: '', title: '', dialogueId: 0, description: '', nextSceneName: '' },
    options: { fixMojibake: true, replaceReplacementChar: true },
    page: 0,
    pageSize: 100
  };

  // ---------------------------------------------------------------------------
  // DOM helpers.
  // ---------------------------------------------------------------------------

  function $(id) { return document.getElementById(id); }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function show(node, visible) {
    if (!node) return;
    node.classList.toggle('is-hidden', !visible);
  }

  var toastTimer = null;
  function toast(message, isError) {
    el.toast.textContent = message;
    el.toast.classList.toggle('is-error', !!isError);
    el.toast.classList.add('is-visible');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove('is-visible'); }, 2600);
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  // ---------------------------------------------------------------------------
  // File intake.
  // ---------------------------------------------------------------------------

  function setupUpload() {
    var dz = el.dropzone;
    var input = el.fileInput;

    dz.addEventListener('click', function (event) {
      if (event.target.closest('.btn')) return;
      input.click();
    });
    dz.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); input.click(); }
    });
    el.browseBtn.addEventListener('click', function (event) {
      event.stopPropagation();
      input.click();
    });

    input.addEventListener('change', function () {
      if (input.files && input.files[0]) handleFile(input.files[0]);
      input.value = '';
    });

    ['dragenter', 'dragover'].forEach(function (type) {
      dz.addEventListener(type, function (event) {
        event.preventDefault();
        dz.classList.add('is-dragover');
      });
    });
    ['dragleave', 'drop'].forEach(function (type) {
      dz.addEventListener(type, function (event) {
        event.preventDefault();
        dz.classList.remove('is-dragover');
      });
    });
    dz.addEventListener('drop', function (event) {
      var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) handleFile(file);
    });

    el.resetBtn.addEventListener('click', resetAll);
    el.reconvertBtn.addEventListener('click', function () {
      if (!state.rawText) return;
      runConversion();
      toast('Conversion re-run from the original file.');
    });
    el.optMojibake.addEventListener('change', function () {
      state.options.fixMojibake = el.optMojibake.checked;
      state.options.replaceReplacementChar = el.optMojibake.checked;
      if (state.rawText) runConversion();
    });
  }

  function detectSourceType(name) {
    var lower = name.toLowerCase();
    if (lower.endsWith('.docx')) return 'docx';
    if (lower.endsWith('.txt')) return 'txt';
    return '';
  }

  function handleFile(file) {
    var sourceType = detectSourceType(file.name);
    if (!sourceType) {
      showError('Unsupported file type. Upload a .docx or .txt file.');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      showError('File is ' + formatBytes(file.size) + ', which exceeds the 5 MB limit.');
      return;
    }

    showError('');
    state.fileName = file.name;
    state.fileSize = file.size;
    state.sourceType = sourceType;

    extractText(file, sourceType).then(function (text) {
      if (!text || text.trim() === '') {
        showError('No text could be extracted from this file (it may be empty or image-only).');
        return;
      }
      state.rawText = text;
      applyMetaDefaults(file.name);
      runConversion();
      renderFileSummary();

      show(el.stepMeta, true);
      show(el.stepPreview, true);
      show(el.stepDownload, true);
      toast(sourceType.toUpperCase() + ' loaded: ' + file.name);
      el.stepMeta.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (error) {
      showError('Could not read the file: ' + (error && error.message ? error.message : error));
    });
  }

  function extractText(file, sourceType) {
    if (sourceType === 'txt') {
      return file.text();
    }
    return file.arrayBuffer().then(function (buffer) {
      if (!window.mammoth || typeof window.mammoth.extractRawText !== 'function') {
        throw new Error('The DOCX parser (mammoth.js) failed to load.');
      }
      return window.mammoth.extractRawText({ arrayBuffer: buffer }).then(function (result) {
        return result.value;
      });
    });
  }

  function showError(message) {
    if (!message) {
      show(el.errorPanel, false);
      el.errorMessage.textContent = '';
      return;
    }
    show(el.errorPanel, true);
    el.errorMessage.textContent = message;
    toast(message, true);
  }

  function renderFileSummary() {
    el.fileName.textContent = state.fileName;
    el.fileSize.textContent = formatBytes(state.fileSize);
    el.modePill.textContent = state.mode === 'canonical' ? 'canonical txt' : 'freeform prose';
    el.modePill.classList.toggle('is-canonical', state.mode === 'canonical');
    show(el.fileSummary, true);
  }

  // ---------------------------------------------------------------------------
  // Conversion.
  // ---------------------------------------------------------------------------

  function runConversion() {
    if (!state.rawText) return;
    var result = DC.convert(state.rawText, {
      sourceType: state.sourceType,
      fixMojibake: state.options.fixMojibake,
      replaceReplacementChar: state.options.replaceReplacementChar
    });
    state.mode = result.mode;
    state.blocks = result.blocks;
    state.parseWarnings = result.parseWarnings || [];
    state.page = 0;

    refreshWarnings();
    renderTable();
    renderPagination();
    updateDownloadLabels();
  }

  function refreshWarnings() {
    var analysis = DC.analyzeBlocks(state.blocks, state.parseWarnings);
    var list = analysis.warnings;
    if (list.length === 0) {
      el.warnings.innerHTML =
        '<div class="warning-item is-ok">' +
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' +
        '<span>No warnings. Every block mapped cleanly.</span></div>';
      return;
    }
    el.warnings.innerHTML = list.map(function (warning) {
      return '<div class="warning-item">' +
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6A2 2 0 0 0 22 18L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>' +
        '<span>' + escapeHtml(warning) + '</span></div>';
    }).join('');
  }

  // ---------------------------------------------------------------------------
  // Metadata form.
  // ---------------------------------------------------------------------------

  function applyMetaDefaults(fileName) {
    var assetName = DC.sanitizeAssetName(fileName);
    state.meta.assetName = assetName;
    state.meta.title = assetName;
    state.meta.dialogueId = 0;
    state.meta.description = 'Batch generated from ' + fileName;
    state.meta.nextSceneName = '';
    syncMetaInputs();
  }

  function syncMetaInputs() {
    el.metaAssetName.value = state.meta.assetName;
    el.metaTitle.value = state.meta.title;
    el.metaDialogueId.value = state.meta.dialogueId;
    el.metaDescription.value = state.meta.description;
    el.metaNextScene.value = state.meta.nextSceneName;
  }

  function readMetaInputs() {
    state.meta.assetName = DC.sanitizeAssetName(el.metaAssetName.value || 'DialogueAsset');
    state.meta.title = el.metaTitle.value;
    state.meta.dialogueId = parseInt(el.metaDialogueId.value, 10);
    if (isNaN(state.meta.dialogueId)) state.meta.dialogueId = 0;
    state.meta.description = el.metaDescription.value;
    state.meta.nextSceneName = el.metaNextScene.value;
    updateDownloadLabels();
  }

  function setupMeta() {
    ['input', 'change'].forEach(function (type) {
      el.stepMeta.addEventListener(type, function (event) {
        var target = event.target;
        if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) {
          readMetaInputs();
        }
      });
    });
    el.metaAssetName.addEventListener('blur', function () {
      el.metaAssetName.value = DC.sanitizeAssetName(el.metaAssetName.value || 'DialogueAsset');
      readMetaInputs();
    });
  }

  // ---------------------------------------------------------------------------
  // Preview table.
  // ---------------------------------------------------------------------------

  function rowHtml(block, index) {
    var type = block.type || 'dialogue';
    var isMonologue = type === 'monologue';
    var isQuestion = type === 'question';
    var choicesText = (block.choices || []).join('\n');

    return '<tr data-index="' + index + '">' +
      '<td class="col-index row-index">' + (index + 1) + '</td>' +
      '<td class="col-type"><select data-field="type" aria-label="Block ' + (index + 1) + ' type">' + typeOptions(type) + '</select></td>' +
      '<td class="col-speaker"><input type="text" data-field="character" aria-label="Block ' + (index + 1) + ' speaker" value="' + escapeHtml(block.character || '') + '"' +
        (isMonologue ? ' disabled' : '') + ' spellcheck="false"></td>' +
      '<td class="col-text"><textarea data-field="text" aria-label="Block ' + (index + 1) + ' text" rows="2" spellcheck="false">' + escapeHtml(block.text || '') + '</textarea></td>' +
      '<td class="col-choices"><textarea data-field="choices" aria-label="Block ' + (index + 1) + ' choices" rows="2" spellcheck="false"' +
        (isQuestion ? '' : ' disabled') + ' placeholder="' + (isQuestion ? '' : 'question only') + '">' +
        escapeHtml(choicesText) + '</textarea></td>' +
      '<td class="col-expr"><select data-field="expression" aria-label="Block ' + (index + 1) + ' expression">' + exprOptions(block.expression) + '</select></td>' +
      '<td class="col-pos"><select data-field="text_type" aria-label="Block ' + (index + 1) + ' text position">' + posOptions(block.text_type) + '</select></td>' +
      '<td class="col-del"><button type="button" class="del-btn" data-action="delete" title="Delete row" aria-label="Delete block ' + (index + 1) + '">&#10005;</button></td>' +
      '</tr>';
  }

  function typeOptions(selected) {
    return ['dialogue', 'question', 'monologue'].map(function (type) {
      return '<option value="' + type + '"' + (type === selected ? ' selected' : '') + '>' + type + '</option>';
    }).join('');
  }

  function exprOptions(selected) {
    var value = parseInt(selected, 10);
    if (isNaN(value)) value = 0;
    return DC.CHARACTER_EXPRESSIONS.map(function (name, index) {
      return '<option value="' + index + '"' + (index === value ? ' selected' : '') + '>' + index + ' \u00b7 ' + escapeHtml(name) + '</option>';
    }).join('');
  }

  function posOptions(selected) {
    var value = parseInt(selected, 10) === 1 ? 1 : 0;
    return '<option value="0"' + (value === 0 ? ' selected' : '') + '>Normal</option>' +
           '<option value="1"' + (value === 1 ? ' selected' : '') + '>Center bottom</option>';
  }

  function renderTable() {
    var total = state.blocks.length;
    var pageCount = Math.max(1, Math.ceil(total / state.pageSize));
    if (state.page >= pageCount) state.page = pageCount - 1;
    if (state.page < 0) state.page = 0;

    var start = state.page * state.pageSize;
    var end = Math.min(start + state.pageSize, total);

    if (total === 0) {
      el.previewBody.innerHTML = '<tr><td colspan="8" style="padding:24px;text-align:center;color:var(--muted)">No blocks parsed.</td></tr>';
    } else {
      var html = '';
      for (var i = start; i < end; i++) html += rowHtml(state.blocks[i], i);
      el.previewBody.innerHTML = html;
    }

    el.previewSub.textContent = total + ' block' + (total === 1 ? '' : 's') +
      ' parsed from ' + state.fileName + '. Delete or edit anything before downloading.';
    autoGrowAll();
    renderPagination();
  }

  function renderPagination() {
    var total = state.blocks.length;
    var pageCount = Math.max(1, Math.ceil(total / state.pageSize));
    if (total <= state.pageSize) {
      el.pagination.innerHTML = '';
      return;
    }
    var from = state.page * state.pageSize + 1;
    var to = Math.min((state.page + 1) * state.pageSize, total);
    el.pagination.innerHTML =
      '<button type="button" data-page="prev"' + (state.page === 0 ? ' disabled' : '') + '>&larr; Prev</button>' +
      '<span class="page-info">Rows ' + from + '\u2013' + to + ' of ' + total + ' \u00b7 page ' + (state.page + 1) + ' / ' + pageCount + '</span>' +
      '<button type="button" data-page="next"' + (state.page >= pageCount - 1 ? ' disabled' : '') + '>Next &rarr;</button>';
  }

  function setupPreview() {
    el.previewBody.addEventListener('input', function (event) {
      var target = event.target;
      var field = target.getAttribute && target.getAttribute('data-field');
      if (!field) return;
      var row = target.closest('tr');
      if (!row) return;
      var index = parseInt(row.getAttribute('data-index'), 10);
      var block = state.blocks[index];
      if (!block) return;

      if (field === 'text') {
        block.text = target.value;
        autoGrow(target);
        refreshWarnings();
      } else if (field === 'character') {
        block.character = target.value;
        refreshWarnings();
      } else if (field === 'choices') {
        block.choices = target.value.split('\n').map(function (line) { return line.trim(); }).filter(Boolean);
        refreshWarnings();
      }
    });

    el.previewBody.addEventListener('change', function (event) {
      var target = event.target;
      var field = target.getAttribute && target.getAttribute('data-field');
      if (!field) return;
      var row = target.closest('tr');
      if (!row) return;
      var index = parseInt(row.getAttribute('data-index'), 10);
      var block = state.blocks[index];
      if (!block) return;

      if (field === 'type') {
        block.type = target.value;
        if (block.type === 'question' && !block.choices) block.choices = [];
        renderTable();
      } else if (field === 'expression') {
        block.expression = parseInt(target.value, 10) || 0;
      } else if (field === 'text_type') {
        block.text_type = parseInt(target.value, 10) === 1 ? 1 : 0;
      }
      refreshWarnings();
      updateDownloadLabels();
    });

    el.previewBody.addEventListener('click', function (event) {
      var button = event.target.closest('[data-action="delete"]');
      if (!button) return;
      var row = button.closest('tr');
      var index = parseInt(row.getAttribute('data-index'), 10);
      state.blocks.splice(index, 1);
      renderTable();
      refreshWarnings();
      updateDownloadLabels();
      toast('Row deleted.');
    });

    el.pageSize.addEventListener('change', function () {
      state.pageSize = parseInt(el.pageSize.value, 10) || 100;
      state.page = 0;
      renderTable();
    });

    el.pagination.addEventListener('click', function (event) {
      var button = event.target.closest('button[data-page]');
      if (!button) return;
      if (button.getAttribute('data-page') === 'prev') state.page = Math.max(0, state.page - 1);
      else state.page = state.page + 1;
      renderTable();
      el.stepPreview.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function autoGrow(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight + 2, 260) + 'px';
  }

  function autoGrowAll() {
    var areas = el.previewBody.querySelectorAll('textarea');
    for (var i = 0; i < areas.length; i++) autoGrow(areas[i]);
  }

  // ---------------------------------------------------------------------------
  // Downloads.
  // ---------------------------------------------------------------------------

  function currentAssetName() {
    return DC.sanitizeAssetName(state.meta.assetName || 'DialogueAsset');
  }

  function updateDownloadLabels() {
    var name = currentAssetName();
    el.downloadNames.textContent = name + '.asset  \u00b7  ' + name + '.txt';
  }

  function setupDownload() {
    el.downloadAsset.addEventListener('click', function () {
      if (!ensureDownloadable()) return;
      var content = DC.toAsset(state.meta, state.blocks);
      download(currentAssetName() + '.asset', content);
      toast('Downloaded ' + currentAssetName() + '.asset');
    });
    el.downloadTxt.addEventListener('click', function () {
      if (!ensureDownloadable()) return;
      var content = DC.toTxt(state.blocks);
      download(currentAssetName() + '.txt', content);
      toast('Downloaded ' + currentAssetName() + '.txt');
    });
  }

  function ensureDownloadable() {
    if (!state.blocks || state.blocks.length === 0) {
      toast('Nothing to download yet - load a file first.', true);
      return false;
    }
    readMetaInputs();
    return true;
  }

  function download(filename, content) {
    var blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ---------------------------------------------------------------------------
  // Reset.
  // ---------------------------------------------------------------------------

  function resetAll() {
    state.fileName = '';
    state.fileSize = 0;
    state.rawText = '';
    state.sourceType = '';
    state.mode = '';
    state.blocks = [];
    state.parseWarnings = [];
    state.page = 0;
    show(el.fileSummary, false);
    show(el.stepMeta, false);
    show(el.stepPreview, false);
    show(el.stepDownload, false);
    showError('');
    el.warnings.innerHTML = '';
    el.previewBody.innerHTML = '';
    el.pagination.innerHTML = '';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    toast('Ready for a new file.');
  }

  // ---------------------------------------------------------------------------
  // Boot.
  // ---------------------------------------------------------------------------

  function init() {
    el.dropzone = $('dropzone');
    el.fileInput = $('file-input');
    el.browseBtn = $('browse-btn');
    el.fileSummary = $('file-summary');
    el.fileName = $('file-name');
    el.fileSize = $('file-size');
    el.modePill = $('mode-pill');
    el.resetBtn = $('reset-btn');
    el.errorPanel = $('error-panel');
    el.errorMessage = $('error-message');

    el.stepMeta = $('step-meta');
    el.metaAssetName = $('meta-asset-name');
    el.metaTitle = $('meta-title-input');
    el.metaDialogueId = $('meta-dialogue-id');
    el.metaDescription = $('meta-description');
    el.metaNextScene = $('meta-next-scene');
    el.optMojibake = $('opt-mojibake');
    el.reconvertBtn = $('reconvert-btn');

    el.stepPreview = $('step-preview');
    el.previewSub = $('preview-sub');
    el.warnings = $('warnings');
    el.previewBody = $('preview-body');
    el.pagination = $('pagination');
    el.pageSize = $('page-size');

    el.stepDownload = $('step-download');
    el.downloadAsset = $('download-asset');
    el.downloadTxt = $('download-txt');
    el.downloadNames = $('download-names');
    el.toast = $('toast');

    setupUpload();
    setupMeta();
    setupPreview();
    setupDownload();
    updateDownloadLabels();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
