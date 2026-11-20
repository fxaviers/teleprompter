import {
  DEFAULT_SETTINGS,
  SAMPLE_SCRIPT_TEXT,
  loadSettings,
  saveSettings,
  loadScripts,
  saveScripts,
  getActiveScriptId,
  setActiveScriptId,
  createScript,
  exportScriptTxt,
  importScriptFile,
  estimateReadingStats,
} from './storage.js';
import { PrompterEngine } from './prompter.js';
import { VoiceTracker } from './voice.js';
import {
  initInvokerCommandsFallback,
  initDialogClosedByFallback,
  initFocusgroupFallback,
  initSwitchFallback,
  closeDialogAnimated,
  syncRangeSlider,
} from './ui-polyfills.js';

const $ = (selector) => document.querySelector(selector);

const els = {
  stageEl: $('#prompter-stage'),
  contentEl: $('#script-content'),
  focusGuide: $('#focus-guide'),
  topHud: $('#top-hud'),
  bottomHud: $('#bottom-hud'),
  toolbar: $('#main-toolbar'),
  liveStatus: $('#live-status'),

  btnOpenEditor: $('#btn-open-editor'),
  activeScriptTitle: $('#active-script-title'),
  btnInstall: $('#btn-install-app'),

  voiceChip: $('#voice-chip'),
  voiceChipText: $('#voice-chip-text'),

  countdownOverlay: $('#countdown-overlay'),
  countdownValue: $('#countdown-value'),

  btnReset: $('#btn-reset'),
  btnPlay: $('#btn-play'),
  btnVoice: $('#btn-voice'),
  btnSpeedDown: $('#btn-speed-down'),
  speedReadout: $('#speed-readout'),
  btnSpeedUp: $('#btn-speed-up'),

  settingsSheet: $('#settings-sheet'),
  rangeFontSize: $('#range-font-size'),
  valFontSize: $('#val-font-size'),
  rangeLineHeight: $('#range-line-height'),
  valLineHeight: $('#val-line-height'),
  rangeSpeed: $('#range-speed'),
  valSpeed: $('#val-speed'),
  rangeMargin: $('#range-margin'),
  valMargin: $('#val-margin'),
  rangeFocusLine: $('#range-focus-line'),
  valFocusLine: $('#val-focus-line'),
  selectCountdown: $('#select-countdown'),
  selectVoiceLang: $('#select-voice-lang'),
  selectTheme: $('#select-theme'),
  switchMirror: $('#switch-mirror'),
  switchGuide: $('#switch-guide'),
  switchWakeLock: $('#switch-wakelock'),
  switchAutoHide: $('#switch-autohide'),

  editorDialog: $('#editor-dialog'),
  scriptList: $('#script-list'),
  scriptTitleInput: $('#script-title-input'),
  scriptTextarea: $('#script-textarea'),
  scriptStats: $('#script-stats'),
  btnNewScript: $('#btn-new-script'),
  btnImportScript: $('#btn-import-script'),
  fileImport: $('#file-import'),
  btnExportScript: $('#btn-export-script'),
  btnDeleteScript: $('#btn-delete-script'),
  btnRestoreSample: $('#btn-restore-sample'),
  btnApplyScript: $('#btn-apply-script'),
};

let settings = loadSettings();
let scripts = loadScripts();
let activeScriptId = getActiveScriptId();
if (!scripts.some((s) => s.id === activeScriptId)) {
  activeScriptId = scripts[0].id;
  setActiveScriptId(activeScriptId);
}

let wakeLockSentinel = null;
let countdownTimer = 0;
let hudAutoHideTimer = 0;
let editorSaveTimer = 0;
let deferredInstallPrompt = null;

function getActiveScript() {
  return scripts.find((s) => s.id === activeScriptId) || scripts[0];
}

function announce(message) {
  els.liveStatus.textContent = message;
}

const prompter = new PrompterEngine({
  stageEl: els.stageEl,
  contentEl: els.contentEl,
  onTokenCursorChange(index) {
    voiceTracker.setCursor(index);
  },
  onPlaybackStateChange(isPlaying, { reachedEnd } = {}) {
    document.body.classList.toggle('is-playing', isPlaying);
    els.btnPlay.setAttribute('aria-label', isPlaying ? 'Pausar rolagem' : 'Iniciar rolagem');
    syncWakeLock();

    if (isPlaying) {
      scheduleHudAutoHide();
    } else {
      revealHud();
      if (reachedEnd) {
        announce('Fim do roteiro');
      }
    }
  },
});

const voiceTracker = new VoiceTracker({
  lang: settings.voiceLang,
  getVisibleRange: () => prompter.getVisibleTokenRange(),
  onSpeechActivity: () => prompter.notifyVoiceActivity(),
  onMatch({ matchedIndex, isRecovery }) {
    prompter.scrollToToken(matchedIndex, { isRecovery });
    scheduleHudAutoHide();
  },
  onInterim(text) {
    if (text) {
      els.voiceChipText.textContent = text;
    }
  },
  onStatus(status) {
    prompter.setVoiceTrackingActive(status === 'listening');
    if (status === 'listening') {
      els.voiceChip.hidden = false;
      els.voiceChip.dataset.state = 'listening';
      els.voiceChipText.textContent = 'Ouvindo voz...';
      els.btnVoice.setAttribute('aria-pressed', 'true');
      syncWakeLock();
      scheduleHudAutoHide();
    } else if (status === 'paused') {
      els.voiceChip.dataset.state = 'paused';
      els.voiceChipText.textContent = 'Voz pausada em segundo plano';
      syncWakeLock();
    } else if (status === 'stopped') {
      els.voiceChip.hidden = true;
      delete els.voiceChip.dataset.state;
      els.btnVoice.setAttribute('aria-pressed', 'false');
      prompter.clearHighlights();
      syncWakeLock();
      revealHud();
    }
  },
  onError(message) {
    els.voiceChip.hidden = false;
    els.voiceChip.dataset.state = 'error';
    els.voiceChipText.textContent = message;
    announce(message);
  },
});

/* ---------------- Wake Lock ---------------- */

async function syncWakeLock() {
  const shouldKeepAwake =
    settings.wakeLock &&
    !document.hidden &&
    (prompter.isPlaying || voiceTracker.active);

  if (shouldKeepAwake) {
    if (!wakeLockSentinel && 'wakeLock' in navigator) {
      try {
        wakeLockSentinel = await navigator.wakeLock.request('screen');
        wakeLockSentinel.addEventListener('release', () => {
          wakeLockSentinel = null;
        });
      } catch {
        // Ignore battery-saver or permission rejections.
      }
    }
  } else if (wakeLockSentinel) {
    try {
      await wakeLockSentinel.release();
    } catch {
      // Ignore already released lock.
    }
    wakeLockSentinel = null;
  }
}

document.addEventListener('visibilitychange', () => {
  syncWakeLock();
});

/* ---------------- HUD Auto-Hide ---------------- */

function revealHud() {
  clearTimeout(hudAutoHideTimer);
  document.body.classList.remove('hud-hidden');
}

function isPopoverOpen(el) {
  if (!el) return false;
  try {
    return el.matches(':popover-open');
  } catch {
    return el.classList.contains(':popover-open');
  }
}

function scheduleHudAutoHide() {
  clearTimeout(hudAutoHideTimer);
  const overlaysOpen = els.editorDialog.open || isPopoverOpen(els.settingsSheet);

  if (!settings.autoHideHud || overlaysOpen) {
    revealHud();
    return;
  }

  if (prompter.isPlaying || voiceTracker.active) {
    hudAutoHideTimer = setTimeout(() => {
      document.body.classList.add('hud-hidden');
    }, 2600);
  }
}

for (const bar of [els.topHud, els.bottomHud, els.settingsSheet]) {
  bar.addEventListener('pointerdown', () => {
    revealHud();
    if (prompter.isPlaying || voiceTracker.active) {
      scheduleHudAutoHide();
    }
  }, { passive: true });
}

/* ---------------- Countdown & Playback ---------------- */

function cancelCountdown() {
  if (!countdownTimer) return;
  clearInterval(countdownTimer);
  countdownTimer = 0;
  els.countdownOverlay.hidden = true;
}

function startPlaybackWithCountdown() {
  if (countdownTimer) {
    cancelCountdown();
    return;
  }

  if (voiceTracker.active) {
    voiceTracker.stop();
  }

  if (prompter.isPlaying) {
    prompter.pause();
    return;
  }

  const seconds = Number(settings.countdown) || 0;
  if (seconds <= 0) {
    prompter.play();
    return;
  }

  prompter.updateMetrics();
  if (prompter.tokens.length === 0 || prompter.maxScroll <= 0) return;

  if (prompter.stageEl.scrollTop >= prompter.maxScroll - 1) {
    prompter.reset();
  }

  let remaining = seconds;
  els.countdownValue.textContent = String(remaining);
  els.countdownOverlay.hidden = false;

  countdownTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      cancelCountdown();
      prompter.play();
    } else {
      els.countdownValue.textContent = String(remaining);
    }
  }, 1000);
}

els.countdownOverlay.addEventListener('click', () => {
  cancelCountdown();
  announce('Contagem cancelada');
});

function toggleVoiceMode() {
  cancelCountdown();
  if (voiceTracker.active) {
    voiceTracker.stop();
    announce('Avanço por voz desativado');
    return;
  }

  if (!voiceTracker.isSupported) {
    const msg = 'Reconhecimento de voz não disponível neste navegador.';
    els.voiceChip.hidden = false;
    els.voiceChip.dataset.state = 'error';
    els.voiceChipText.textContent = msg;
    announce(msg);
    return;
  }

  if (prompter.isPlaying) {
    prompter.pause();
  }

  voiceTracker.setScriptTokens(prompter.tokens);
  voiceTracker.setCursor(prompter.cursorIndex);
  voiceTracker.start();
  announce('Avanço por voz ativado');
}

/* ---------------- Settings Synchronization ---------------- */

function formatSpeed(val) {
  return `${Number(val).toFixed(1)}x`;
}

function applySettingsToUI() {
  const root = document.documentElement;
  root.style.setProperty('--prompt-font-size', `${settings.fontSize}px`);
  root.style.setProperty('--prompt-line-height', String(settings.lineHeight));
  root.style.setProperty('--prompt-margin', `${settings.margin}%`);
  root.style.setProperty('--focus-line-pos', `${settings.focusLine}%`);

  if (settings.theme === 'oled') {
    root.removeAttribute('data-theme');
  } else {
    root.dataset.theme = settings.theme;
  }

  els.contentEl.dataset.mirrored = String(Boolean(settings.mirror));
  els.focusGuide.hidden = !settings.showGuide;

  prompter.setSpeed(settings.speed);
  prompter.setFocusLine(settings.focusLine);
  prompter.updateMetrics();
  voiceTracker.setLang(settings.voiceLang);

  // Sync range sliders and readouts
  els.rangeFontSize.value = String(settings.fontSize);
  els.valFontSize.textContent = `${settings.fontSize} px`;
  syncRangeSlider(els.rangeFontSize, (v) => `${v} pixels`);

  els.rangeLineHeight.value = String(settings.lineHeight);
  els.valLineHeight.textContent = Number(settings.lineHeight).toFixed(2);
  syncRangeSlider(els.rangeLineHeight);

  els.rangeSpeed.value = String(settings.speed);
  els.valSpeed.textContent = formatSpeed(settings.speed);
  els.speedReadout.textContent = formatSpeed(settings.speed);
  els.speedReadout.setAttribute(
    'aria-label',
    `Velocidade atual: ${Number(settings.speed).toFixed(1)}. Abrir ajustes`
  );
  syncRangeSlider(els.rangeSpeed, (v) => `${Number(v).toFixed(1)}x`);

  els.rangeMargin.value = String(settings.margin);
  els.valMargin.textContent = `${settings.margin}%`;
  syncRangeSlider(els.rangeMargin, (v) => `${v} porcento`);

  els.rangeFocusLine.value = String(settings.focusLine);
  els.valFocusLine.textContent = `${settings.focusLine}%`;
  syncRangeSlider(els.rangeFocusLine, (v) => `${v} porcento`);

  els.selectCountdown.value = String(settings.countdown);
  els.selectVoiceLang.value = settings.voiceLang;
  els.selectTheme.value = settings.theme;

  els.switchMirror.checked = Boolean(settings.mirror);
  els.switchGuide.checked = Boolean(settings.showGuide);
  els.switchWakeLock.checked = Boolean(settings.wakeLock);
  els.switchAutoHide.checked = Boolean(settings.autoHideHud);
}

function updateSetting(patch) {
  settings = { ...settings, ...patch };
  saveSettings(settings);
  applySettingsToUI();
}

function adjustSpeed(delta) {
  const next = Math.max(0.5, Math.min(10, Math.round((settings.speed + delta) * 4) / 4));
  updateSetting({ speed: next });
}

els.rangeFontSize.addEventListener('input', (e) => {
  updateSetting({ fontSize: Number(e.target.value) });
});

els.rangeLineHeight.addEventListener('input', (e) => {
  updateSetting({ lineHeight: Number(e.target.value) });
});

els.rangeSpeed.addEventListener('input', (e) => {
  updateSetting({ speed: Number(e.target.value) });
});

els.rangeMargin.addEventListener('input', (e) => {
  updateSetting({ margin: Number(e.target.value) });
});

els.rangeFocusLine.addEventListener('input', (e) => {
  updateSetting({ focusLine: Number(e.target.value) });
});

els.selectCountdown.addEventListener('change', (e) => {
  updateSetting({ countdown: Number(e.target.value) });
});

els.selectVoiceLang.addEventListener('change', (e) => {
  updateSetting({ voiceLang: e.target.value });
});

els.selectTheme.addEventListener('change', (e) => {
  updateSetting({ theme: e.target.value });
});

els.switchMirror.addEventListener('change', (e) => {
  updateSetting({ mirror: e.target.checked });
});

els.switchGuide.addEventListener('change', (e) => {
  updateSetting({ showGuide: e.target.checked });
});

els.switchWakeLock.addEventListener('change', (e) => {
  updateSetting({ wakeLock: e.target.checked });
  syncWakeLock();
});

els.switchAutoHide.addEventListener('change', (e) => {
  updateSetting({ autoHideHud: e.target.checked });
  if (!e.target.checked) {
    revealHud();
  } else {
    scheduleHudAutoHide();
  }
});

/* ---------------- Toolbar & Stage Interactions ---------------- */

els.btnPlay.addEventListener('click', startPlaybackWithCountdown);

els.btnReset.addEventListener('click', () => {
  cancelCountdown();
  prompter.reset();
  voiceTracker.setCursor(0);
  announce('Roteiro reiniciado');
});

els.btnVoice.addEventListener('click', toggleVoiceMode);
els.btnSpeedDown.addEventListener('click', () => adjustSpeed(-0.25));
els.btnSpeedUp.addEventListener('click', () => adjustSpeed(0.25));

// Single tap on stage reveals HUD; double tap toggles playback (without interfering with drags)
let lastTapTime = 0;
let tapStartPos = null;

els.stageEl.addEventListener('pointerdown', (event) => {
  tapStartPos = { x: event.clientX, y: event.clientY };
}, { passive: true });

els.stageEl.addEventListener('pointerup', (event) => {
  if (!tapStartPos) return;
  const dist = Math.hypot(event.clientX - tapStartPos.x, event.clientY - tapStartPos.y);
  tapStartPos = null;
  if (dist > 12) return;

  const now = Date.now();
  if (now - lastTapTime < 280) {
    lastTapTime = 0;
    startPlaybackWithCountdown();
  } else {
    lastTapTime = now;
    if (document.body.classList.contains('hud-hidden')) {
      revealHud();
      scheduleHudAutoHide();
    }
  }
});

// Pause HUD auto-hide while popover settings sheet is open
els.settingsSheet.addEventListener('toggle', (event) => {
  if (event.newState === 'open') {
    revealHud();
  } else {
    scheduleHudAutoHide();
  }
});

/* ---------------- Script Library & Editor ---------------- */

function renderScriptList() {
  const frag = document.createDocumentFragment();
  for (const script of scripts) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'script-tab';
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', String(script.id === activeScriptId));
    btn.textContent = script.title || 'Sem título';
    btn.addEventListener('click', () => selectScript(script.id));
    frag.appendChild(btn);
  }
  els.scriptList.replaceChildren(frag);
}

function loadActiveScriptIntoStage() {
  const current = getActiveScript();
  els.activeScriptTitle.textContent = current.title || 'Sem título';
  prompter.setText(current.text);
  voiceTracker.setScriptTokens(prompter.tokens);
}

function loadActiveScriptIntoEditor() {
  const current = getActiveScript();
  els.scriptTitleInput.value = current.title;
  els.scriptTextarea.value = current.text;
  els.scriptStats.textContent = estimateReadingStats(current.text).label;
  renderScriptList();
}

function selectScript(id) {
  flushEditorEdits();
  activeScriptId = id;
  setActiveScriptId(id);
  loadActiveScriptIntoEditor();
  loadActiveScriptIntoStage();
}

function flushEditorEdits() {
  clearTimeout(editorSaveTimer);
  const current = getActiveScript();
  if (!current) return;

  const newTitle = els.scriptTitleInput.value.trim() || 'Sem título';
  const newText = els.scriptTextarea.value;
  if (current.title !== newTitle || current.text !== newText) {
    current.title = newTitle;
    current.text = newText;
    current.updatedAt = Date.now();
    saveScripts(scripts);
    renderScriptList();
    els.activeScriptTitle.textContent = current.title;
  }
}

function handleEditorInput() {
  els.scriptStats.textContent = estimateReadingStats(els.scriptTextarea.value).label;
  clearTimeout(editorSaveTimer);
  editorSaveTimer = setTimeout(flushEditorEdits, 220);
}

els.scriptTitleInput.addEventListener('input', handleEditorInput);
els.scriptTextarea.addEventListener('input', handleEditorInput);

els.btnNewScript.addEventListener('click', () => {
  flushEditorEdits();
  const created = createScript(`Roteiro ${scripts.length + 1}`, '');
  scripts.unshift(created);
  saveScripts(scripts);
  activeScriptId = created.id;
  setActiveScriptId(created.id);
  loadActiveScriptIntoEditor();
  loadActiveScriptIntoStage();
  els.scriptTextarea.focus();
});

els.btnImportScript.addEventListener('click', () => {
  els.fileImport.click();
});

els.fileImport.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;

  try {
    const imported = await importScriptFile(file);
    flushEditorEdits();
    const created = createScript(imported.title, imported.text);
    scripts.unshift(created);
    saveScripts(scripts);
    activeScriptId = created.id;
    setActiveScriptId(created.id);
    loadActiveScriptIntoEditor();
    loadActiveScriptIntoStage();
    announce('Roteiro importado');
  } catch {
    announce('Não foi possível ler o arquivo');
  }
});

els.btnExportScript.addEventListener('click', () => {
  flushEditorEdits();
  exportScriptTxt(getActiveScript());
  announce('Roteiro exportado');
});

els.btnDeleteScript.addEventListener('click', () => {
  if (scripts.length <= 1) {
    const only = scripts[0];
    only.title = 'Roteiro 1';
    only.text = '';
    only.updatedAt = Date.now();
    saveScripts(scripts);
    loadActiveScriptIntoEditor();
    loadActiveScriptIntoStage();
    announce('Conteúdo limpo');
    return;
  }

  scripts = scripts.filter((s) => s.id !== activeScriptId);
  activeScriptId = scripts[0].id;
  saveScripts(scripts);
  setActiveScriptId(activeScriptId);
  loadActiveScriptIntoEditor();
  loadActiveScriptIntoStage();
  announce('Roteiro excluído');
});

els.btnRestoreSample.addEventListener('click', () => {
  els.scriptTitleInput.value = 'Guia Rápido — PromptCam';
  els.scriptTextarea.value = SAMPLE_SCRIPT_TEXT;
  els.scriptStats.textContent = estimateReadingStats(SAMPLE_SCRIPT_TEXT).label;
  flushEditorEdits();
  loadActiveScriptIntoStage();
});

els.btnApplyScript.addEventListener('click', () => {
  flushEditorEdits();
  loadActiveScriptIntoStage();
});

els.editorDialog.addEventListener('close', () => {
  flushEditorEdits();
  loadActiveScriptIntoStage();
  els.editorDialog.returnValue = '';
  scheduleHudAutoHide();
});

els.btnOpenEditor.addEventListener('click', () => {
  cancelCountdown();
  prompter.pause();
  revealHud();
  loadActiveScriptIntoEditor();
});

/* ---------------- Keyboard & Clicker Shortcuts ---------------- */

document.addEventListener('keydown', (event) => {
  const tag = event.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || els.editorDialog.open) {
    return;
  }

  // Keep toolbar arrow keys intact when focus is inside the toolbar
  const insideToolbar = els.toolbar.contains(document.activeElement);

  switch (event.code) {
    case 'Space':
      event.preventDefault();
      startPlaybackWithCountdown();
      break;
    case 'ArrowUp':
      event.preventDefault();
      adjustSpeed(0.25);
      break;
    case 'ArrowDown':
      event.preventDefault();
      adjustSpeed(-0.25);
      break;
    case 'ArrowRight':
      if (!insideToolbar) {
        event.preventDefault();
        adjustSpeed(0.25);
      }
      break;
    case 'ArrowLeft':
      if (!insideToolbar) {
        event.preventDefault();
        adjustSpeed(-0.25);
      }
      break;
    case 'KeyR':
      event.preventDefault();
      cancelCountdown();
      prompter.reset();
      voiceTracker.setCursor(0);
      break;
    case 'KeyV':
      event.preventDefault();
      toggleVoiceMode();
      break;
    case 'KeyM':
      event.preventDefault();
      updateSetting({ mirror: !settings.mirror });
      break;
  }
});

/* ---------------- PWA Install & Service Worker ---------------- */

const supportsWebInstall = typeof Navigator.prototype.install === 'function';
let relatedAppInstalled = false;
const DISPLAY_MODE_QUERIES = [
  '(display-mode: standalone)',
  '(display-mode: fullscreen)',
  '(display-mode: minimal-ui)',
  '(display-mode: window-controls-overlay)',
].map((query) => window.matchMedia(query));

function isInstalledApp() {
  return (
    relatedAppInstalled ||
    DISPLAY_MODE_QUERIES.some((mq) => mq.matches) ||
    window.navigator.standalone === true ||
    document.referrer.startsWith('android-app://')
  );
}

function syncInstallButtonVisibility() {
  if (isInstalledApp()) {
    els.btnInstall.hidden = true;
    return;
  }
  if (supportsWebInstall || deferredInstallPrompt) {
    els.btnInstall.hidden = false;
  }
}

for (const mq of DISPLAY_MODE_QUERIES) {
  mq.addEventListener('change', syncInstallButtonVisibility);
}

if (typeof navigator.getInstalledRelatedApps === 'function') {
  navigator.getInstalledRelatedApps()
    .then((apps) => {
      if (apps?.length > 0) {
        relatedAppInstalled = true;
        syncInstallButtonVisibility();
      }
    })
    .catch(() => {
      // Ignore unsupported environments.
    });
}

syncInstallButtonVisibility();

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  if (!supportsWebInstall) {
    syncInstallButtonVisibility();
  }
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  els.btnInstall.hidden = true;
  announce('PromptCam instalado');
});

els.btnInstall.addEventListener('click', async () => {
  if (els.btnInstall.getAttribute('aria-disabled') === 'true') return;
  els.btnInstall.setAttribute('aria-disabled', 'true');

  try {
    if (supportsWebInstall) {
      await navigator.install();
      announce('Aplicativo instalado ou aberto');
      els.btnInstall.hidden = true;
    } else if (deferredInstallPrompt) {
      const promptEvent = deferredInstallPrompt;
      deferredInstallPrompt = undefined;
      await promptEvent.prompt();
      const { outcome } = await promptEvent.userChoice;
      announce(outcome === 'accepted' ? 'Aplicativo instalado' : 'Instalação cancelada');
      if (!deferredInstallPrompt) {
        els.btnInstall.hidden = true;
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      announce('Instalação cancelada');
    } else {
      announce('Não foi possível iniciar a instalação');
    }
  } finally {
    els.btnInstall.removeAttribute('aria-disabled');
  }
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {
      // Service worker registration failed (e.g. insecure origin).
    });
  });
}

/* ---------------- Bootstrap ---------------- */

initInvokerCommandsFallback();
initDialogClosedByFallback();
initFocusgroupFallback(els.toolbar);
initSwitchFallback();

applySettingsToUI();
loadActiveScriptIntoStage();
loadActiveScriptIntoEditor();
