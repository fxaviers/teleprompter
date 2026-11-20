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

/**
 * Applies lightweight Portuguese far-field phonetic normalization for longer words
 * to tolerate 2-meter microphone sibilant/nasal confusions without colliding short words.
 * @param {string} norm
 * @returns {string}
 */
export function phoneticPt(norm) {
  if (!norm || norm.length < 4) return norm;
  return norm
    .replace(/ch/g, 'x')
    .replace(/h/g, '')
    .replace(/qu/g, 'k')
    .replace(/xc(?=[ei])/g, 's')
    .replace(/ss/g, 's')
    .replace(/c(?=[ei])/g, 's')
    .replace(/g(?=[ei])/g, 'j')
    .replace(/z/g, 's')
    .replace(/[rs]$/, '');
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
 * Computes fuzzy and far-field Portuguese phonetic similarity between two normalized words in [0, 1].
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function wordSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1.0;

  const minLen = Math.min(a.length, b.length);
  const maxLen = Math.max(a.length, b.length);

  let best = 0;

  if (minLen >= 4 && maxLen - minLen <= 2) {
    const dist = levenshtein(a, b);
    if (dist === 1) best = 0.85;
    else if (dist === 2 && minLen >= 6) best = 0.75;
  }

  // Secondary phonetic tier for words >= 5 chars (allows e.g. "falar"/"fala" or "gravassao"/"gravacao")
  if (maxLen >= 5 && minLen >= 4) {
    const pa = phoneticPt(a);
    const pb = phoneticPt(b);
    if (pa.length >= 4 && pb.length >= 4) {
      if (pa === pb) {
        best = Math.max(best, 0.82);
      } else if (
        Math.min(pa.length, pb.length) >= 5 &&
        Math.abs(pa.length - pb.length) <= 1 &&
        levenshtein(pa, pb) === 1
      ) {
        best = Math.max(best, 0.8);
      }
    }
  }

  return best;
}

function isContentWord(norm) {
  return Boolean(norm) && !STOPWORDS.has(norm) && norm.length >= 3;
}

/**
 * Finds the longest suffix of `prefix` (normalized) that equals a prefix of `words` (normalized).
 */
function findOverlapLength(prefixNorms, nextNorms) {
  const maxCheck = Math.min(prefixNorms.length, nextNorms.length, 12);
  for (let len = maxCheck; len >= 1; len--) {
    let matched = true;
    const offset = prefixNorms.length - len;
    for (let i = 0; i < len; i++) {
      if (prefixNorms[offset + i] !== nextNorms[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return len;
  }
  return 0;
}

/**
 * Extracts deduplicated spoken alternatives from Web Speech API `event.results`,
 * stripping cumulative prefix echoes emitted by Chrome on Android.
 *
 * @param {ArrayLike<any>} results
 * @param {number} [resultIndex=0]
 * @returns {{alternatives: string[][], isFinal: boolean, displayWords: string[]}}
 */
export function extractFreshAlternatives(results, resultIndex = 0) {
  if (!results || results.length === 0) {
    return { alternatives: [], isFinal: false, displayWords: [] };
  }

  const safeResultIdx = Math.max(0, Math.min(resultIndex, results.length - 1));
  const lastIdx = results.length - 1;
  const startCtx = Math.max(0, safeResultIdx - 1);

  const prefixWords = [];
  const prefixNorms = [];

  for (let i = startCtx; i < lastIdx; i++) {
    const rawText = results[i]?.[0]?.transcript || '';
    const words = rawText.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;

    const norms = words.map(normalizeWord);
    const overlap = findOverlapLength(prefixNorms, norms);
    for (let k = overlap; k < words.length; k++) {
      if (norms[k]) {
        prefixWords.push(words[k]);
        prefixNorms.push(norms[k]);
      }
    }
  }

  // Keep only recent context before the newest result
  const ctxSliceStart = Math.max(0, prefixWords.length - 6);
  const ctxWords = prefixWords.slice(ctxSliceStart);
  const ctxNorms = prefixNorms.slice(ctxSliceStart);

  const lastResult = results[lastIdx];
  const altCount = Math.min(3, lastResult?.length || 0);
  const alternatives = [];
  const seenSignatures = new Set();

  for (let a = 0; a < altCount; a++) {
    const rawAlt = lastResult[a]?.transcript || '';
    const altWords = rawAlt.trim().split(/\s+/).filter(Boolean);
    const altNorms = altWords.map(normalizeWord);
    const overlap = findOverlapLength(ctxNorms, altNorms);
    const combined = [...ctxWords];

    for (let k = overlap; k < altWords.length; k++) {
      if (altNorms[k]) {
        combined.push(altWords[k]);
      }
    }

    if (combined.length === 0) continue;
    const sig = combined.map(normalizeWord).join('|');
    if (!seenSignatures.has(sig)) {
      seenSignatures.add(sig);
      alternatives.push(combined);
    }
  }

  let isFinal = true;
  for (let i = safeResultIdx; i <= lastIdx; i++) {
    if (!results[i]?.isFinal) {
      isFinal = false;
      break;
    }
  }

  return {
    alternatives,
    isFinal,
    displayWords: alternatives[0] || [],
  };
}

/**
 * Matches a tail of recognized words against either a tight local tracking window
 * around `cursor` or a full-viewport `recoveryRange`.
 *
 * @param {Array<{norm: string}>} scriptTokens
 * @param {number} cursor
 * @param {string[]} spokenWords
 * @param {{recoveryRange?: {start: number, end: number}}} [options]
 * @returns {{matchedIndex: number, confidence: number, matchedCount: number, contentMatches: number, score: number} | null}
 */
export function matchSpokenChunk(scriptTokens, cursor, spokenWords, options = {}) {
  if (!scriptTokens?.length || !spokenWords?.length) return null;

  const normalizedSpoken = spokenWords
    .map(normalizeWord)
    .filter(Boolean)
    .slice(-8);

  if (normalizedSpoken.length === 0) return null;

  const isRecovery = Boolean(options.recoveryRange);
  const clampedCursor = Math.max(0, Math.min(cursor, scriptTokens.length - 1));

  const winStart = isRecovery
    ? Math.max(0, options.recoveryRange.start)
    : Math.max(0, clampedCursor - 4);
  const winEnd = isRecovery
    ? Math.min(scriptTokens.length - 1, options.recoveryRange.end)
    : Math.min(scriptTokens.length - 1, clampedCursor + 16);

  if (winStart > winEnd) return null;

  let best = null;

  for (let j = winStart; j <= winEnd; j++) {
    const targetNorm = scriptTokens[j].norm;

    for (let tailSkip = 0; tailSkip <= Math.min(1, normalizedSpoken.length - 1); tailSkip++) {
      const sEnd = normalizedSpoken.length - 1 - tailSkip;

      // Determine anchor match: 1-to-1, 2 spoken words -> 1 compound token, or 1 spoken word -> 2 script tokens
      const anchorCandidates = [];

      const sim1 = wordSimilarity(normalizedSpoken[sEnd], targetNorm);
      if (sim1 >= 0.75) {
        anchorCandidates.push({
          sim: sim1,
          spokenConsumed: 1,
          scriptBackStep: 1,
          matchedInc: 1,
          contentInc: isContentWord(targetNorm) ? 1 : 0,
        });
      }

      if (sEnd >= 1 && targetNorm.length >= 6) {
        const mergedSpoken = normalizedSpoken[sEnd - 1] + normalizedSpoken[sEnd];
        const simCompound = wordSimilarity(mergedSpoken, targetNorm);
        if (simCompound >= 0.85) {
          anchorCandidates.push({
            sim: simCompound,
            spokenConsumed: 2,
            scriptBackStep: 2,
            matchedInc: 2,
            contentInc: isContentWord(targetNorm) ? 1 : 0,
          });
        }
      }

      if (j >= 1 && normalizedSpoken[sEnd].length >= 6) {
        const mergedScript = scriptTokens[j - 1].norm + targetNorm;
        const simSplit = wordSimilarity(normalizedSpoken[sEnd], mergedScript);
        if (simSplit >= 0.85) {
          anchorCandidates.push({
            sim: simSplit,
            spokenConsumed: 1,
            scriptBackStep: 2,
            matchedInc: 2,
            contentInc:
              (isContentWord(scriptTokens[j - 1].norm) || isContentWord(targetNorm)) ? 1 : 0,
          });
        }
      }

      for (const anchor of anchorCandidates) {
        let matchedCount = anchor.matchedInc;
        let simSum = anchor.sim * anchor.matchedInc;
        let contentMatches = anchor.contentInc;
        let earliestScriptIdx = j - (anchor.scriptBackStep === 2 && anchor.spokenConsumed === 1 ? 1 : 0);

        let scriptPos = j - anchor.scriptBackStep;
        let sPos = sEnd - anchor.spokenConsumed;
        const minScriptBound = Math.max(0, j - 11);

        while (sPos >= 0 && scriptPos >= minScriptBound) {
          const spokenWord = normalizedSpoken[sPos];
          let matched = false;

          // 1) Normal lookback (allow up to 1 skipped word or filler)
          for (let lookback = 0; lookback <= 2 && scriptPos - lookback >= minScriptBound; lookback++) {
            const idx = scriptPos - lookback;
            const candNorm = scriptTokens[idx].norm;
            const sim = wordSimilarity(spokenWord, candNorm);
            if (sim >= 0.75) {
              matchedCount += 1;
              simSum += sim;
              if (isContentWord(candNorm)) contentMatches += 1;
              earliestScriptIdx = Math.min(earliestScriptIdx, idx);
              scriptPos = idx - 1;
              sPos -= 1;
              matched = true;
              break;
            }
          }
          if (matched) continue;

          // 2) Two spoken words merged into one compound script word
          if (sPos >= 1) {
            const mergedSpoken = normalizedSpoken[sPos - 1] + spokenWord;
            for (let lookback = 0; lookback <= 1 && scriptPos - lookback >= minScriptBound; lookback++) {
              const idx = scriptPos - lookback;
              const candNorm = scriptTokens[idx].norm;
              if (candNorm.length >= 6 && wordSimilarity(mergedSpoken, candNorm) >= 0.85) {
                matchedCount += 2;
                simSum += 1.9;
                if (isContentWord(candNorm)) contentMatches += 1;
                earliestScriptIdx = Math.min(earliestScriptIdx, idx);
                scriptPos = idx - 1;
                sPos -= 2;
                matched = true;
                break;
              }
            }
          }
          if (matched) continue;

          // 3) One spoken word split across two consecutive script words
          if (spokenWord.length >= 6 && scriptPos - 1 >= minScriptBound) {
            const mergedScript = scriptTokens[scriptPos - 1].norm + scriptTokens[scriptPos].norm;
            if (wordSimilarity(spokenWord, mergedScript) >= 0.85) {
              matchedCount += 2;
              simSum += 1.9;
              if (isContentWord(scriptTokens[scriptPos - 1].norm) || isContentWord(scriptTokens[scriptPos].norm)) {
                contentMatches += 1;
              }
              earliestScriptIdx = Math.min(earliestScriptIdx, scriptPos - 1);
              scriptPos -= 2;
              sPos -= 1;
              continue;
            }
          }

          sPos -= 1;
        }

        const span = j - earliestScriptIdx + 1;
        const delta = j - clampedCursor;

        if (isRecovery) {
          if (span > matchedCount + 2) continue;
          const strongEnough =
            (matchedCount >= 2 && contentMatches >= 2) ||
            (matchedCount >= 3 && contentMatches >= 1);
          if (!strongEnough) continue;
        } else {
          if (matchedCount === 1) {
            if (delta < 1 || delta > 4) continue;
            if (contentMatches === 0 || targetNorm.length < 4 || anchor.sim < 0.85) continue;
          } else if (matchedCount === 2) {
            if (delta < 0 || delta > 10 || contentMatches === 0) continue;
            if (delta === 0 && clampedCursor > 0) continue;
          } else {
            // 3+ matched words
            if (delta >= 0) {
              if (delta > 16) continue;
              if (contentMatches === 0) continue;
            } else {
              // Deliberate small backtrack requires >= 2 content words within -4..0
              if (delta < -4 || contentMatches < 2) continue;
            }
          }
        }

        let score = simSum * 1.4 + matchedCount * 0.85 + contentMatches * 0.7;
        score -= tailSkip * 0.35;

        if (!isRecovery) {
          if (delta >= 1 && delta <= 5) {
            score += 0.75;
          } else if (delta > 5 && delta <= 10) {
            score += 0.25 - (delta - 5) * 0.08;
          } else if (delta > 10) {
            score -= (delta - 10) * 0.14;
          } else if (delta < 0) {
            score -= 0.7 + Math.abs(delta) * 0.15;
          }
        } else {
          // Slight bias toward closer visible matches when tied
          score -= Math.abs(delta) * 0.01;
        }

        const minScore = isRecovery ? 3.8 : 2.3;
        if (score < minScore) continue;

        if (!best || score > best.score) {
          best = {
            matchedIndex: j,
            confidence: Math.min(1, simSum / Math.max(1, matchedCount)),
            matchedCount,
            contentMatches,
            score,
          };
        }
      }
    }
  }

  return best;
}

/**
 * Evaluates multiple SpeechRecognition alternatives and selects the strongest script match.
 *
 * @param {Array<{norm: string}>} scriptTokens
 * @param {number} cursor
 * @param {string[][]} alternativeWordLists
 * @param {{recoveryRange?: {start: number, end: number}}} [options]
 */
export function matchAlternatives(scriptTokens, cursor, alternativeWordLists, options = {}) {
  if (!alternativeWordLists?.length) return null;

  let best = null;
  for (let i = 0; i < alternativeWordLists.length; i++) {
    const hit = matchSpokenChunk(scriptTokens, cursor, alternativeWordLists[i], options);
    if (!hit) continue;

    // Slight preference for higher-ranked speech alternatives on near-ties
    const adjustedScore = hit.score - i * 0.12;
    if (
      !best ||
      hit.matchedCount > best.matchedCount + 1 ||
      (Math.abs(hit.matchedCount - best.matchedCount) <= 1 && adjustedScore > best.adjustedScore)
    ) {
      best = { ...hit, altIndex: i, adjustedScore };
    }
  }

  if (!best) return null;
  return {
    matchedIndex: best.matchedIndex,
    confidence: best.confidence,
    matchedCount: best.matchedCount,
    contentMatches: best.contentMatches,
    score: best.score,
    altIndex: best.altIndex,
  };
}

/**
 * Wraps the browser Web Speech API (SpeechRecognition / webkitSpeechRecognition)
 * with Android Chrome cumulative deduplication, multi-alternative scoring,
 * interim jump capping, and visible-screen deadlock recovery.
 */
export class VoiceTracker {
  constructor({
    lang = 'pt-BR',
    onMatch,
    onInterim,
    onSpeechActivity,
    getVisibleRange,
    onStatus,
    onError,
  }) {
    this.SpeechRecognitionCtor =
      typeof window !== 'undefined'
        ? window.SpeechRecognition || window.webkitSpeechRecognition
        : null;

    this.lang = lang;
    this.onMatch = onMatch;
    this.onInterim = onInterim;
    this.onSpeechActivity = onSpeechActivity;
    this.getVisibleRange = getVisibleRange;
    this.onStatus = onStatus;
    this.onError = onError;

    this.recognition = null;
    this.active = false;
    this.scriptTokens = [];
    this.committedCursor = 0;
    this.tentativeCursor = 0;
    this.lastInterimCandidate = -1;
    this.lastMatchTime = 0;
    this.unmatchedCount = 0;

    this.backoffMs = 120;
    this.restartTimer = 0;
    this.lastTailSignature = '';
    this.lastWasFinal = false;
    this.pausedByVisibility = false;

    this._handleVisibility = this._handleVisibility.bind(this);
  }

  get isSupported() {
    return Boolean(this.SpeechRecognitionCtor);
  }

  get cursor() {
    return this.tentativeCursor;
  }

  setScriptTokens(tokens) {
    this.scriptTokens = tokens || [];
    this.committedCursor = 0;
    this.tentativeCursor = 0;
    this.lastInterimCandidate = -1;
    this.lastMatchTime = 0;
    this.unmatchedCount = 0;
    this.lastTailSignature = '';
    this.lastWasFinal = false;
  }

  setCursor(index) {
    const clamped = Math.max(0, Math.min(index, Math.max(0, this.scriptTokens.length - 1)));
    this.committedCursor = clamped;
    this.tentativeCursor = clamped;
    this.lastInterimCandidate = clamped;
    this.lastMatchTime = 0;
    this.unmatchedCount = 0;
    this.lastTailSignature = '';
    this.lastWasFinal = false;
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
    this.backoffMs = 120;
    this.lastTailSignature = '';
    this.lastWasFinal = false;
    this.unmatchedCount = 0;

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
      instance.onstart = null;
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
    rec.maxAlternatives = 3;

    rec.onstart = () => {
      this.lastTailSignature = '';
      this.lastWasFinal = false;
      this.onStatus?.('listening');
    };

    rec.onresult = (event) => {
      this.backoffMs = 120;
      const { alternatives, isFinal, displayWords } = extractFreshAlternatives(
        event.results,
        event.resultIndex
      );

      if (alternatives.length === 0) return;

      this.onInterim?.(displayWords.slice(-5).join(' '));

      const tailSignature = alternatives[0].slice(-8).map(normalizeWord).join('|');
      if (!tailSignature || (tailSignature === this.lastTailSignature && isFinal === this.lastWasFinal)) {
        return;
      }
      this.lastTailSignature = tailSignature;
      this.lastWasFinal = isFinal;

      const hit = matchAlternatives(this.scriptTokens, this.tentativeCursor, alternatives);

      if (hit) {
        const jumpFromCommitted = hit.matchedIndex - this.committedCursor;

        // Prevent unconfirmed single/weak interim bursts from cascading far ahead
        if (!isFinal && jumpFromCommitted > 8 && !(hit.matchedCount >= 3 && hit.contentMatches >= 2)) {
          this.onSpeechActivity?.();
          return;
        }

        if (isFinal) {
          this.committedCursor = hit.matchedIndex;
        } else if (
          (hit.matchedCount >= 3 && hit.contentMatches >= 2) ||
          Math.abs(hit.matchedIndex - this.lastInterimCandidate) <= 2
        ) {
          this.committedCursor = hit.matchedIndex;
        }

        this.lastInterimCandidate = hit.matchedIndex;
        this.tentativeCursor = hit.matchedIndex;
        this.lastMatchTime = Date.now();
        this.unmatchedCount = 0;

        this.onSpeechActivity?.();
        this.onMatch?.({ ...hit, isRecovery: false });
        return;
      }

      // No local window match
      this.unmatchedCount += 1;
      const timeSinceMatch = this.lastMatchTime > 0 ? Date.now() - this.lastMatchTime : Infinity;

      if (timeSinceMatch < 2000 && this.unmatchedCount < 2) {
        this.onSpeechActivity?.();
      }

      if (
        (this.unmatchedCount >= 2 || timeSinceMatch >= 1800) &&
        typeof this.getVisibleRange === 'function'
      ) {
        const range = this.getVisibleRange();
        if (range) {
          const recHit = matchAlternatives(
            this.scriptTokens,
            this.tentativeCursor,
            alternatives,
            { recoveryRange: range }
          );
          if (recHit) {
            this.committedCursor = recHit.matchedIndex;
            this.tentativeCursor = recHit.matchedIndex;
            this.lastInterimCandidate = recHit.matchedIndex;
            this.lastMatchTime = Date.now();
            this.unmatchedCount = 0;

            this.onSpeechActivity?.();
            this.onMatch?.({ ...recHit, isRecovery: true });
          }
        }
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
        this.backoffMs = Math.min(1200, Math.round(this.backoffMs * 1.5));
        this._createAndStart();
      }, this.backoffMs);
    };

    this.recognition = rec;
    try {
      rec.start();
    } catch {
      this.restartTimer = setTimeout(() => this._createAndStart(), 250);
    }
  }
}
