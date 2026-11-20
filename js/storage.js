const KEYS = {
  settings: 'promptcam.settings.v1',
  scripts: 'promptcam.scripts.v1',
  activeScriptId: 'promptcam.activeScriptId.v1',
};

export const DEFAULT_SETTINGS = Object.freeze({
  fontSize: 44,
  lineHeight: 1.45,
  speed: 3.0,
  margin: 10,
  focusLine: 42,
  countdown: 3,
  voiceLang: 'pt-BR',
  theme: 'oled',
  mirror: false,
  showGuide: true,
  wakeLock: true,
  autoHideHud: true,
});

export const SAMPLE_SCRIPT_TEXT = `Bem-vindo ao PromptCam, seu teleprompter leve feito para rodar no Chrome do Android acima da câmera.

Posicione o texto logo abaixo da borda superior do celular para manter o olhar natural direto para a lente durante toda a gravação.

Você pode ajustar o tamanho da letra, a entrelinha e a posição da linha de foco em tempo real tocando no botão Aa na barra inferior.

Para gravar no seu próprio ritmo, ative o ícone do microfone e comece a falar normalmente: o roteiro acompanha suas palavras automaticamente.

Se preferir a rolagem contínua clássica, toque no botão Play e ajuste a velocidade com os botões de menos e mais ou com as setas do teclado.

Quando terminar de testar, toque no título no topo da tela para escrever, colar ou importar o seu próprio roteiro em texto.`;

function createDefaultScripts() {
  return [
    {
      id: 'sample-welcome',
      title: 'Guia Rápido — PromptCam',
      text: SAMPLE_SCRIPT_TEXT,
      updatedAt: Date.now(),
    },
  ];
}

function safeReadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function safeWriteJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * Loads persisted user settings merged with defaults.
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function loadSettings() {
  const saved = safeReadJSON(KEYS.settings, null);
  if (!saved || typeof saved !== 'object') {
    return { ...DEFAULT_SETTINGS };
  }
  return { ...DEFAULT_SETTINGS, ...saved };
}

/**
 * Persists user settings to localStorage.
 * @param {object} settings
 */
export function saveSettings(settings) {
  safeWriteJSON(KEYS.settings, settings);
}

/**
 * Loads saved teleprompter scripts, seeding a Portuguese sample if empty.
 * @returns {Array<{id: string, title: string, text: string, updatedAt: number}>}
 */
export function loadScripts() {
  const saved = safeReadJSON(KEYS.scripts, null);
  if (Array.isArray(saved) && saved.length > 0) {
    return saved;
  }
  const initial = createDefaultScripts();
  saveScripts(initial);
  return initial;
}

/**
 * Saves the scripts collection to localStorage.
 * @param {Array<object>} scripts
 */
export function saveScripts(scripts) {
  safeWriteJSON(KEYS.scripts, scripts);
}

/**
 * Reads the currently selected script ID.
 * @returns {string | null}
 */
export function getActiveScriptId() {
  try {
    return localStorage.getItem(KEYS.activeScriptId);
  } catch {
    return null;
  }
}

/**
 * Stores the active script ID.
 * @param {string} id
 */
export function setActiveScriptId(id) {
  try {
    localStorage.setItem(KEYS.activeScriptId, id);
  } catch {
    // Ignore storage quota or private mode restrictions.
  }
}

/**
 * Creates a new script entry object.
 * @param {string} title
 * @param {string} text
 */
export function createScript(title = 'Novo Roteiro', text = '') {
  const id = typeof crypto !== 'undefined' && crypto.randomUUID
    ? `script-${crypto.randomUUID()}`
    : `script-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  return {
    id,
    title: title.trim() || 'Novo Roteiro',
    text,
    updatedAt: Date.now(),
  };
}

/**
 * Downloads a script as a plain UTF-8 .txt file.
 * @param {{title: string, text: string}} script
 */
export function exportScriptTxt(script) {
  const safeName = (script.title || 'roteiro')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'roteiro';

  const blob = new Blob([script.text || ''], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${safeName}.txt`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Imports a plain text file and returns its normalized title and text.
 * @param {File} file
 * @returns {Promise<{title: string, text: string}>}
 */
export async function importScriptFile(file) {
  const text = await file.text();
  const baseTitle = file.name.replace(/\.[^.]+$/, '').trim() || 'Roteiro Importado';
  return { title: baseTitle, text: text.replace(/\r\n/g, '\n') };
}

/**
 * Computes word count and estimated speaking duration (~135 words/min).
 * @param {string} text
 * @returns {{words: number, label: string}}
 */
export function estimateReadingStats(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    return { words: 0, label: '0 palavras · 0s' };
  }
  const words = trimmed.split(/\s+/).length;
  const totalSeconds = Math.max(1, Math.round((words / 135) * 60));
  if (totalSeconds < 60) {
    return { words, label: `${words} palavras · ~${totalSeconds}s` };
  }
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  const timeStr = secs >= 10 ? `${mins}m ${secs}s` : `${mins} min`;
  return { words, label: `${words} palavras · ~${timeStr}` };
}
