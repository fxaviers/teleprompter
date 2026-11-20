const STOPWORDS = new Set([
  'a', 'o', 'e', 'de', 'da', 'do', 'das', 'dos', 'em', 'na', 'no', 'nas', 'nos',
  'um', 'uma', 'uns', 'umas', 'que', 'se', 'por', 'para', 'pra', 'com', 'sem',
  'mas', 'ou', 'ao', 'aos', 'as', 'os', 'eu', 'tu', 'ele', 'ela', 'nos', 'vos',
  'eles', 'elas', 'me', 'te', 'lhe', 'ja', 'so', 'nao', 'sim', 'ne', 'entao',
  'ai', 'eh', 'ah', 'the', 'and', 'or', 'in', 'on', 'to', 'of', 'is', 'it',
]);

/**
 * Normalizes a word for accent- and punctuation-insensitive voice matching.
 * @param {string} word
 * @returns {string}
 */
export function normalizeWord(word) {
  if (!word) return '';
  return word
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Tokenizes plain text into indexed words while preserving raw substrings.
 * @param {string} text
 * @returns {Array<{index: number, raw: string, norm: string}>}
 */
export function tokenizeText(text) {
  const tokens = [];
  const regex = /\p{L}[\p{L}\p{N}'’-]*|\p{N}+/gu;
  let match;
  while ((match = regex.exec(text || '')) !== null) {
    const norm = normalizeWord(match[0]);
    if (norm) {
      tokens.push({ index: tokens.length, raw: match[0], norm });
    }
  }
  return tokens;
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost
      );
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

/**
 * Computes fuzzy similarity between two normalized words in [0, 1].
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function wordSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1.0;

  const minLen = Math.min(a.length, b.length);
  const maxLen = Math.max(a.length, b.length);
  if (minLen < 4 || maxLen - minLen > 2) return 0;

  const dist = levenshtein(a, b);
  if (dist === 1) return 0.85;
  if (dist === 2 && minLen >= 6) return 0.75;
  return 0;
}

/**
 * Matches a tail of recognized words against a sliding window around `cursor`.
 * Prevents single-stopword jumps, bounds jumps to nearby lines, and requires
 * strong multi-word confirmation to backtrack.
 *
 * @param {Array<{norm: string}>} scriptTokens
 * @param {number} cursor
 * @param {string[]} spokenWords
 * @returns {{matchedIndex: number, confidence: number, matchedCount: number} | null}
 */
export function matchSpokenChunk(scriptTokens, cursor, spokenWords) {
  if (!scriptTokens?.length || !spokenWords?.length) return null;

  const normalizedSpoken = spokenWords
    .map(normalizeWord)
    .filter(Boolean)
    .slice(-6);

  if (normalizedSpoken.length === 0) return null;

  const clampedCursor = Math.max(0, Math.min(cursor, scriptTokens.length - 1));
  const winStart = Math.max(0, clampedCursor - 6);
  const winEnd = Math.min(scriptTokens.length - 1, clampedCursor + 35);

  let best = null;

  for (let j = winStart; j <= winEnd; j++) {
    const targetNorm = scriptTokens[j].norm;

    // Try aligning the newest spoken word (or second-newest if user added a trailing filler)
    for (let tailSkip = 0; tailSkip <= Math.min(1, normalizedSpoken.length - 1); tailSkip++) {
      const sEnd = normalizedSpoken.length - 1 - tailSkip;
      const anchorSim = wordSimilarity(normalizedSpoken[sEnd], targetNorm);
      if (anchorSim < 0.75) continue;

      let matchedCount = 1;
      let simSum = anchorSim;
      let contentMatches = !STOPWORDS.has(targetNorm) && targetNorm.length >= 3 ? 1 : 0;

      // Walk backwards from (sEnd - 1, j - 1) allowing up to 1 filler/skip gap per step
      let scriptPos = j - 1;
      let sPos = sEnd - 1;
      while (sPos >= 0 && scriptPos >= Math.max(0, j - 10)) {
        const spokenWord = normalizedSpoken[sPos];
        let matchedAt = -1;
        let stepSim = 0;

        for (let lookback = 0; lookback <= 2 && scriptPos - lookback >= Math.max(0, j - 10); lookback++) {
          const candNorm = scriptTokens[scriptPos - lookback].norm;
          const sim = wordSimilarity(spokenWord, candNorm);
          if (sim >= 0.75) {
            matchedAt = scriptPos - lookback;
            stepSim = sim;
            break;
          }
        }

        if (matchedAt !== -1) {
          matchedCount += 1;
          simSum += stepSim;
          const candNorm = scriptTokens[matchedAt].norm;
          if (!STOPWORDS.has(candNorm) && candNorm.length >= 3) {
            contentMatches += 1;
          }
          scriptPos = matchedAt - 1;
        }
        sPos -= 1;
      }

      const delta = j - clampedCursor;

      // Guardrails against false jumps and accidental backtracking
      if (matchedCount === 1) {
        if (delta < 0) continue; // never backtrack on 1 word
        if (delta > 12) continue; // never leap far on 1 word
        if (contentMatches === 0 || targetNorm.length < 4 || anchorSim < 0.85) continue;
      }

      if (delta < 0 && matchedCount < 2) continue;
      if (delta < 0 && contentMatches === 0 && matchedCount < 3) continue;

      // Score rewards sequential matches & content words, biases toward small forward steps
      let score = simSum * 1.4 + matchedCount * 0.8 + contentMatches * 0.65;
      score -= tailSkip * 0.35;

      if (delta >= 0 && delta <= 8) {
        score += 0.65;
      } else if (delta > 8 && delta <= 18) {
        score -= (delta - 8) * 0.09;
      } else if (delta > 18) {
        if (matchedCount < 2) continue;
        score -= 0.9 + (delta - 18) * 0.16;
      } else if (delta < 0) {
        score -= 0.8 + Math.abs(delta) * 0.12;
      }

      if (!best || score > best.score) {
        best = {
          matchedIndex: j,
          confidence: Math.min(1, simSum / Math.max(1, matchedCount)),
          matchedCount,
          score,
        };
      }
    }
  }

  if (!best || best.score < 2.2) return null;

  return {
    matchedIndex: best.matchedIndex,
    confidence: best.confidence,
    matchedCount: best.matchedCount,
  };
}

/**
 * Wraps the browser Web Speech API (SpeechRecognition / webkitSpeechRecognition)
 * with Android Chrome continuous restart, interim deduplication, and visibility safety.
 */
export class VoiceTracker {
  constructor({ lang = 'pt-BR', onMatch, onInterim, onStatus, onError }) {
    this.SpeechRecognitionCtor =
      typeof window !== 'undefined'
        ? window.SpeechRecognition || window.webkitSpeechRecognition
        : null;

    this.lang = lang;
    this.onMatch = onMatch;
    this.onInterim = onInterim;
    this.onStatus = onStatus;
    this.onError = onError;

    this.recognition = null;
    this.active = false;
    this.scriptTokens = [];
    this.cursor = 0;
    this.backoffMs = 180;
    this.restartTimer = 0;
    this.lastProcessedTail = '';
    this.pausedByVisibility = false;

    this._handleVisibility = this._handleVisibility.bind(this);
  }

  get isSupported() {
    return Boolean(this.SpeechRecognitionCtor);
  }

  setScriptTokens(tokens) {
    this.scriptTokens = tokens || [];
    this.cursor = 0;
    this.lastProcessedTail = '';
  }

  setCursor(index) {
    this.cursor = Math.max(0, Math.min(index, Math.max(0, this.scriptTokens.length - 1)));
    this.lastProcessedTail = '';
  }

  setLang(lang) {
    if (this.lang === lang) return;
    this.lang = lang;
    if (this.active) {
      this.stop();
      this.start();
    }
  }

  start() {
    if (!this.SpeechRecognitionCtor) {
      this.onError?.('Reconhecimento de voz não suportado neste navegador');
      return false;
    }

    clearTimeout(this.restartTimer);
    this.active = true;
    this.pausedByVisibility = false;
    this.backoffMs = 180;
    this.lastProcessedTail = '';

    document.addEventListener('visibilitychange', this._handleVisibility);
    this._createAndStart();
    return true;
  }

  stop() {
    this.active = false;
    this.pausedByVisibility = false;
    clearTimeout(this.restartTimer);
    document.removeEventListener('visibilitychange', this._handleVisibility);

    if (this.recognition) {
      const instance = this.recognition;
      this.recognition = null;
      instance.onresult = null;
      instance.onerror = null;
      instance.onend = null;
      try {
        instance.abort();
      } catch {
        // Ignore already stopped instances.
      }
    }
    this.onStatus?.('stopped');
  }

  _handleVisibility() {
    if (!this.active) return;
    if (document.hidden) {
      this.pausedByVisibility = true;
      clearTimeout(this.restartTimer);
      if (this.recognition) {
        try {
          this.recognition.abort();
        } catch {
          // Ignore stop errors.
        }
      }
      this.onStatus?.('paused');
    } else if (this.pausedByVisibility) {
      this.pausedByVisibility = false;
      this._createAndStart();
    }
  }

  _createAndStart() {
    if (!this.active || document.hidden) return;

    if (this.recognition) {
      try {
        this.recognition.abort();
      } catch {
        // Ignore cleanup errors.
      }
    }

    const rec = new this.SpeechRecognitionCtor();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      this.onStatus?.('listening');
    };

    rec.onresult = (event) => {
      this.backoffMs = 180;
      const results = event.results;
      if (!results || results.length === 0) return;

      // Combine the latest finalized/interim window from the active session.
      const startIdx = Math.max(0, event.resultIndex - 1);
      let transcript = '';
      for (let i = startIdx; i < results.length; i++) {
        transcript += ` ${results[i][0]?.transcript || ''}`;
      }
      transcript = transcript.trim();
      if (!transcript) return;

      const words = transcript.split(/\s+/).filter(Boolean);
      const tailSignature = words.slice(-6).map(normalizeWord).join('|');
      this.onInterim?.(words.slice(-5).join(' '));

      if (!tailSignature || tailSignature === this.lastProcessedTail) {
        return;
      }
      this.lastProcessedTail = tailSignature;

      const hit = matchSpokenChunk(this.scriptTokens, this.cursor, words);
      if (hit) {
        this.cursor = hit.matchedIndex;
        this.onMatch?.(hit);
      }
    };

    rec.onerror = (event) => {
      const code = event.error;
      if (code === 'no-speech' || code === 'aborted') {
        return;
      }

      let message = 'Erro no reconhecimento de voz';
      let fatal = false;

      if (code === 'not-allowed' || code === 'service-not-allowed') {
        message = 'Permissão de microfone negada';
        fatal = true;
      } else if (code === 'audio-capture') {
        message = 'Microfone não encontrado';
        fatal = true;
      } else if (code === 'network') {
        message = 'Sem conexão para voz online';
      }

      this.onError?.(message);
      if (fatal) {
        this.stop();
      }
    };

    rec.onend = () => {
      if (!this.active || document.hidden || this.pausedByVisibility) return;
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => {
        this.backoffMs = Math.min(2000, Math.round(this.backoffMs * 1.6));
        this._createAndStart();
      }, this.backoffMs);
    };

    this.recognition = rec;
    try {
      rec.start();
    } catch {
      this.restartTimer = setTimeout(() => this._createAndStart(), 300);
    }
  }
}
