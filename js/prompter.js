import { normalizeWord } from './voice.js?v=4';

const WORD_REGEX = /\p{L}[\p{L}\p{N}'’-]*|\p{N}+/gu;

/**
 * High-efficiency teleprompter engine with zero idle CPU usage,
 * CSS Custom Highlight API word tracking, and fluid voice-pacing physics.
 */
export class PrompterEngine {
  constructor({ stageEl, contentEl, onTokenCursorChange, onPlaybackStateChange }) {
    this.stageEl = stageEl;
    this.contentEl = contentEl;
    this.onTokenCursorChange = onTokenCursorChange;
    this.onPlaybackStateChange = onPlaybackStateChange;

    this.tokens = [];
    this.firstTextNode = null;
    this.cursorIndex = 0;

    this.isPlaying = false;
    this.speed = 3.0;
    this.focusLinePct = 42;

    this.virtualScrollY = 0;
    this.lastWrittenScrollTop = 0;
    this.targetScrollY = null;
    this.maxScroll = 0;
    this.lineHeightPx = 64;

    // Fluid voice-tracking physics state
    this.voiceTrackingActive = false;
    this.voiceAnchorY = null;
    this.voiceVelocity = 0;
    this.estimatedPacePxPerSec = 52;
    this.lastVoiceMatchTime = 0;
    this.lastSpeechPulseTime = 0;
    this.lastPaceAnchorY = null;
    this.lastPaceTime = 0;

    this.rafId = 0;
    this.lastTimestamp = 0;
    this.isUserTouching = false;
    this.hasManualScroll = false;
    this.touchReleaseTimer = 0;
    this.manualSyncTimer = 0;

    this.supportsHighlights =
      typeof CSS !== 'undefined' &&
      'highlights' in CSS &&
      typeof Highlight !== 'undefined';

    this.measureRange = document.createRange();

    this._tick = this._tick.bind(this);
    this._handleVisibility = this._handleVisibility.bind(this);
    this._onUserTouchStart = this._onUserTouchStart.bind(this);
    this._onUserTouchEnd = this._onUserTouchEnd.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onScroll = this._onScroll.bind(this);
    this._onScrollSettled = this._onScrollSettled.bind(this);

    this._bindEvents();
  }

  _bindEvents() {
    document.addEventListener('visibilitychange', this._handleVisibility);

    this.stageEl.addEventListener('pointerdown', this._onUserTouchStart, { passive: true });
    this.stageEl.addEventListener('pointerup', this._onUserTouchEnd, { passive: true });
    this.stageEl.addEventListener('pointercancel', this._onUserTouchEnd, { passive: true });
    this.stageEl.addEventListener('touchstart', this._onUserTouchStart, { passive: true });
    this.stageEl.addEventListener('touchend', this._onUserTouchEnd, { passive: true });
    this.stageEl.addEventListener('wheel', this._onWheel, { passive: true });
    this.stageEl.addEventListener('scroll', this._onScroll, { passive: true });

    if ('onscrollend' in window) {
      this.stageEl.addEventListener('scrollend', this._onScrollSettled, { passive: true });
    }

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.updateMetrics());
      this.resizeObserver.observe(this.stageEl);
      this.resizeObserver.observe(this.contentEl);
    }
  }

  destroy() {
    this._stopRaf();
    clearTimeout(this.touchReleaseTimer);
    clearTimeout(this.manualSyncTimer);
    document.removeEventListener('visibilitychange', this._handleVisibility);
    this.resizeObserver?.disconnect();
  }

  /**
   * Renders plain text paragraphs into clean text nodes and indexes tokens via TreeWalker.
   * @param {string} text
   */
  setText(text) {
    this.pause();
    this.targetScrollY = null;
    this._resetVoicePhysics();
    this.clearHighlights();

    this.tokens = [];
    this.firstTextNode = null;
    this.cursorIndex = 0;
    this.virtualScrollY = 0;
    this.lastWrittenScrollTop = 0;
    this.hasManualScroll = false;

    const paragraphs = (text || '')
      .replace(/\r\n/g, '\n')
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);

    const frag = document.createDocumentFragment();

    if (paragraphs.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = 'Toque no título acima para colar ou escrever seu roteiro.';
      empty.dataset.emptyHint = 'true';
      frag.appendChild(empty);
      this.contentEl.replaceChildren(frag);
      this.stageEl.scrollTop = 0;
      this.updateMetrics();
      return;
    }

    for (const para of paragraphs) {
      const p = document.createElement('p');
      p.appendChild(document.createTextNode(para));
      frag.appendChild(p);
    }

    this.contentEl.replaceChildren(frag);
    this._indexTokens();
    this.stageEl.scrollTop = 0;
    this.updateMetrics();
    this.onTokenCursorChange?.(0);
  }

  _indexTokens() {
    const walker = document.createTreeWalker(this.contentEl, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let current = walker.nextNode();
    while (current) {
      textNodes.push(current);
      current = walker.nextNode();
    }

    this.firstTextNode = textNodes[0] || null;
    const tokens = [];

    for (const node of textNodes) {
      const str = node.textContent || '';
      WORD_REGEX.lastIndex = 0;
      let match;
      while ((match = WORD_REGEX.exec(str)) !== null) {
        const norm = normalizeWord(match[0]);
        if (!norm) continue;
        tokens.push({
          index: tokens.length,
          raw: match[0],
          norm,
          node,
          start: match.index,
          end: match.index + match[0].length,
        });
      }
    }

    this.tokens = tokens;
  }

  updateMetrics() {
    this.maxScroll = Math.max(0, this.stageEl.scrollHeight - this.stageEl.clientHeight);
    if (this.virtualScrollY > this.maxScroll) {
      this.virtualScrollY = this.maxScroll;
    }

    const cs = getComputedStyle(this.contentEl);
    const parsedLh = parseFloat(cs.lineHeight);
    const parsedFs = parseFloat(cs.fontSize) || 44;
    this.lineHeightPx = Number.isFinite(parsedLh) ? parsedLh : parsedFs * 1.45;
  }

  setSpeed(speed) {
    this.speed = Math.max(0.5, Math.min(10, Number(speed) || 3.0));
  }

  setFocusLine(pct) {
    this.focusLinePct = Math.max(15, Math.min(75, Number(pct) || 42));
  }

  /**
   * Enables or disables fluid voice-following physics.
   * @param {boolean} active
   */
  setVoiceTrackingActive(active) {
    this.voiceTrackingActive = Boolean(active);
    this._resetVoicePhysics();
    if (!this.voiceTrackingActive && !this.isPlaying && this.targetScrollY === null) {
      this._stopRaf();
    }
  }

  _resetVoicePhysics() {
    this.voiceAnchorY = null;
    this.voiceVelocity = 0;
    this.lastVoiceMatchTime = 0;
    this.lastSpeechPulseTime = 0;
    this.lastPaceAnchorY = null;
    this.lastPaceTime = 0;
  }

  /**
   * Keeps fluid voice-coasting alive during interim speech activity only when
   * recently anchored to a valid script match (immune to ambient noise).
   */
  notifyVoiceActivity() {
    if (!this.voiceTrackingActive || this.isPlaying || this.isUserTouching) return;
    const now = performance.now();
    if (this.lastVoiceMatchTime <= 0 || now - this.lastVoiceMatchTime >= 2200) {
      return;
    }
    this.lastSpeechPulseTime = now;
    if (this.voiceAnchorY !== null) {
      this._ensureRaf();
    }
  }

  /**
   * Non-linear speed curve (px/sec) providing fine control at slow reading speeds.
   * @param {number} speed
   * @returns {number}
   */
  mapSpeedToPxPerSec(speed) {
    const clamped = Math.max(0.5, Math.min(10, speed));
    const ratio = (clamped - 0.5) / 9.5;
    return 8 + Math.pow(ratio, 1.35) * 232;
  }

  play() {
    this.updateMetrics();
    if (this.tokens.length === 0 || this.maxScroll <= 0) return false;

    if (this.stageEl.scrollTop >= this.maxScroll - 1) {
      this.reset();
    }

    this.targetScrollY = null;
    this._resetVoicePhysics();
    this.hasManualScroll = false;
    this.virtualScrollY = this.stageEl.scrollTop;
    this.lastWrittenScrollTop = this.virtualScrollY;
    this.isPlaying = true;
    this.onPlaybackStateChange?.(true, { reachedEnd: false });
    this._ensureRaf();
    return true;
  }

  pause({ reachedEnd = false } = {}) {
    const wasPlaying = this.isPlaying;
    this.isPlaying = false;
    if (this.targetScrollY === null && (!this.voiceTrackingActive || this.voiceAnchorY === null)) {
      this._stopRaf();
    }
    if (wasPlaying || reachedEnd) {
      this.onPlaybackStateChange?.(false, { reachedEnd });
    }
  }

  reset() {
    this.pause();
    this.targetScrollY = null;
    this._resetVoicePhysics();
    this.hasManualScroll = false;
    this.cursorIndex = 0;
    this.virtualScrollY = 0;
    this.lastWrittenScrollTop = 0;
    this.stageEl.scrollTop = 0;
    this.clearHighlights();
    this.onTokenCursorChange?.(0);
  }

  clearHighlights() {
    if (this.supportsHighlights) {
      CSS.highlights.clear();
    }
  }

  updateHighlights(index) {
    if (!this.supportsHighlights || this.tokens.length === 0) return;

    const token = this.tokens[index];
    if (!token) return;

    CSS.highlights.clear();

    if (index > 0 && this.firstTextNode) {
      try {
        const spokenRange = new Range();
        spokenRange.setStart(this.firstTextNode, 0);
        spokenRange.setEnd(token.node, token.start);
        const spokenHighlight = new Highlight(spokenRange);
        spokenHighlight.priority = 0;
        CSS.highlights.set('spoken-text', spokenHighlight);
      } catch {
        // Ignore stale node offsets during rapid edits.
      }
    }

    try {
      const currentRange = new Range();
      currentRange.setStart(token.node, token.start);
      currentRange.setEnd(token.node, token.end);
      const currentHighlight = new Highlight(currentRange);
      currentHighlight.priority = 1;
      CSS.highlights.set('current-word', currentHighlight);
    } catch {
      // Ignore stale node offsets during rapid edits.
    }
  }

  _getTokenCenterY(token) {
    this.measureRange.setStart(token.node, token.start);
    this.measureRange.setEnd(token.node, token.end);
    const rect = this.measureRange.getBoundingClientRect();
    return rect.top + rect.height * 0.5;
  }

  /**
   * Binary-searches indexed tokens to find the word closest to the reading focus line.
   * @returns {number}
   */
  findTokenAtFocusLine() {
    if (this.tokens.length === 0) return 0;

    const stageRect = this.stageEl.getBoundingClientRect();
    const focusY = stageRect.top + stageRect.height * (this.focusLinePct / 100);

    let lo = 0;
    let hi = this.tokens.length - 1;
    let bestIdx = 0;
    let bestDist = Infinity;

    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const y = this._getTokenCenterY(this.tokens[mid]);
      const dist = Math.abs(y - focusY);

      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = mid;
      }

      if (y < focusY) {
        lo = mid + 1;
      } else if (y > focusY) {
        hi = mid - 1;
      } else {
        return mid;
      }
    }

    return bestIdx;
  }

  /**
   * Returns the token index bounds currently visible inside the viewport (plus a small
   * lookahead buffer below the bottom edge) to break out of off-window voice deadlocks.
   * @returns {{start: number, end: number} | null}
   */
  getVisibleTokenRange() {
    if (this.tokens.length === 0) return null;

    const stageRect = this.stageEl.getBoundingClientRect();
    const topY = stageRect.top;
    const bottomY = stageRect.bottom;

    // Lower bound: first token with centerY >= topY
    let lo = 0;
    let hi = this.tokens.length - 1;
    let startIdx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const y = this._getTokenCenterY(this.tokens[mid]);
      if (y < topY) {
        lo = mid + 1;
      } else {
        startIdx = mid;
        hi = mid - 1;
      }
    }

    // Upper bound: last token with centerY <= bottomY
    lo = startIdx;
    hi = this.tokens.length - 1;
    let endIdx = startIdx;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const y = this._getTokenCenterY(this.tokens[mid]);
      if (y <= bottomY) {
        endIdx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    return {
      start: Math.max(0, startIdx - 2),
      end: Math.min(this.tokens.length - 1, endIdx + 8),
    };
  }

  /**
   * Highlights token at `index` and smoothly paces or scrolls it to the camera focus line.
   * Stops rAF completely once settled.
   * @param {number} index
   * @param {{immediate?: boolean, isRecovery?: boolean}} [options]
   */
  scrollToToken(index, { immediate = false, isRecovery = false } = {}) {
    if (this.tokens.length === 0) return;

    const clamped = Math.max(0, Math.min(index, this.tokens.length - 1));
    this.cursorIndex = clamped;
    this.updateHighlights(clamped);

    if (this.isUserTouching) return;

    this.updateMetrics();
    const stageRect = this.stageEl.getBoundingClientRect();
    const focusY = stageRect.top + stageRect.height * (this.focusLinePct / 100);
    const tokenY = this._getTokenCenterY(this.tokens[clamped]);
    const leadOffset = this.voiceTrackingActive ? this.lineHeightPx * 0.28 : 0;
    const desired = Math.max(
      0,
      Math.min(this.maxScroll, this.stageEl.scrollTop + (tokenY - (focusY - leadOffset)))
    );

    if (immediate) {
      this.targetScrollY = null;
      this.voiceAnchorY = this.voiceTrackingActive ? desired : null;
      this.voiceVelocity = 0;
      this.virtualScrollY = desired;
      this.lastWrittenScrollTop = desired;
      this.stageEl.scrollTop = desired;
      return;
    }

    if (this.voiceTrackingActive) {
      const now = performance.now();
      if (!isRecovery && this.lastPaceAnchorY !== null && this.lastPaceTime > 0) {
        const deltaY = desired - this.lastPaceAnchorY;
        const elapsedSec = (now - this.lastPaceTime) / 1000;
        if (deltaY > 12 && deltaY < 320 && elapsedSec > 0.2 && elapsedSec < 6.0) {
          const measured = Math.max(22, Math.min(190, deltaY / elapsedSec));
          this.estimatedPacePxPerSec = 0.72 * this.estimatedPacePxPerSec + 0.28 * measured;
        }
      }

      this.lastPaceAnchorY = desired;
      this.lastPaceTime = now;
      this.lastVoiceMatchTime = now;
      this.lastSpeechPulseTime = now;
      this.voiceAnchorY = desired;
      this.targetScrollY = null;
      this.virtualScrollY = this.stageEl.scrollTop;
      this._ensureRaf();
      return;
    }

    this.virtualScrollY = this.stageEl.scrollTop;
    this.targetScrollY = desired;
    this._ensureRaf();
  }

  _ensureRaf() {
    if (this.rafId || document.hidden) return;
    this.lastTimestamp = performance.now();
    this.rafId = requestAnimationFrame(this._tick);
  }

  _stopRaf() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  _handleVisibility() {
    if (document.hidden) {
      this._stopRaf();
    } else if (
      this.isPlaying ||
      this.targetScrollY !== null ||
      (this.voiceTrackingActive && this.voiceAnchorY !== null)
    ) {
      this._ensureRaf();
    }
  }

  _tick(now) {
    this.rafId = 0;
    if (document.hidden) return;

    const dt = Math.min((now - this.lastTimestamp) / 1000, 0.1);
    this.lastTimestamp = now;

    if (this.isUserTouching) {
      this.virtualScrollY = this.stageEl.scrollTop;
      if (this.isPlaying || this.targetScrollY !== null) {
        this._ensureRaf();
      }
      return;
    }

    if (this.isPlaying) {
      this.virtualScrollY += this.mapSpeedToPxPerSec(this.speed) * dt;
      if (this.virtualScrollY >= this.maxScroll) {
        this.virtualScrollY = this.maxScroll;
        this.lastWrittenScrollTop = this.maxScroll;
        this.stageEl.scrollTop = this.maxScroll;
        this.pause({ reachedEnd: true });
        return;
      }

      this.lastWrittenScrollTop = this.virtualScrollY;
      this.stageEl.scrollTop = this.virtualScrollY;
      this._ensureRaf();
      return;
    }

    if (this.voiceTrackingActive && this.voiceAnchorY !== null) {
      const diff = this.voiceAnchorY - this.virtualScrollY;
      const sinceSpeech = now - Math.max(this.lastVoiceMatchTime, this.lastSpeechPulseTime);
      const maxLeadPx = this.lineHeightPx * 1.35;

      let desiredVelocity = 0;
      if (diff > 2) {
        const maxCatchup = Math.max(260, this.estimatedPacePxPerSec * 2.5);
        desiredVelocity = Math.min(maxCatchup, diff * 2.8 + this.estimatedPacePxPerSec * 0.45);
      } else if (diff < -14) {
        desiredVelocity = Math.max(-240, diff * 3.0);
      } else if (
        sinceSpeech < 1300 &&
        this.virtualScrollY < this.voiceAnchorY + maxLeadPx &&
        this.virtualScrollY < this.maxScroll
      ) {
        const timeDecay = 1 - sinceSpeech / 1300;
        const leadRatio = Math.max(0, this.virtualScrollY - this.voiceAnchorY) / maxLeadPx;
        const distDecay = Math.max(0, 1 - leadRatio);
        desiredVelocity = this.estimatedPacePxPerSec * 0.72 * timeDecay * distDecay;
      }

      const blend = 1 - Math.exp(-7 * dt);
      this.voiceVelocity += (desiredVelocity - this.voiceVelocity) * blend;

      if (Math.abs(this.voiceVelocity) < 0.6 && desiredVelocity === 0 && Math.abs(diff) <= 2) {
        this.voiceVelocity = 0;
        return; // Halt rAF completely once settled (0% idle CPU)
      }

      this.virtualScrollY = Math.max(
        0,
        Math.min(this.maxScroll, this.virtualScrollY + this.voiceVelocity * dt)
      );
      this.lastWrittenScrollTop = this.virtualScrollY;
      this.stageEl.scrollTop = this.virtualScrollY;
      this._ensureRaf();
      return;
    }

    if (this.targetScrollY !== null) {
      const diff = this.targetScrollY - this.virtualScrollY;
      if (Math.abs(diff) < 0.5) {
        this.virtualScrollY = this.targetScrollY;
        this.lastWrittenScrollTop = this.virtualScrollY;
        this.stageEl.scrollTop = this.virtualScrollY;
        this.targetScrollY = null;
        return; // Halt rAF completely once settled (0% idle CPU)
      }

      const factor = 1 - Math.exp(-8 * dt);
      this.virtualScrollY += diff * factor;
      this.lastWrittenScrollTop = this.virtualScrollY;
      this.stageEl.scrollTop = this.virtualScrollY;
      this._ensureRaf();
    }
  }

  _onUserTouchStart() {
    clearTimeout(this.touchReleaseTimer);
    this.isUserTouching = true;
    this.hasManualScroll = true;
    this.targetScrollY = null;
    this.voiceVelocity = 0;
  }

  _onUserTouchEnd() {
    clearTimeout(this.touchReleaseTimer);
    this.touchReleaseTimer = setTimeout(() => {
      this.isUserTouching = false;
      this.virtualScrollY = this.stageEl.scrollTop;
    }, 80);
  }

  _onWheel() {
    this.isUserTouching = true;
    this.hasManualScroll = true;
    this.targetScrollY = null;
    this.voiceVelocity = 0;
    clearTimeout(this.touchReleaseTimer);
    this.touchReleaseTimer = setTimeout(() => {
      this.isUserTouching = false;
      this.virtualScrollY = this.stageEl.scrollTop;
      this._onScrollSettled();
    }, 160);
  }

  _onScroll() {
    const isProgrammatic =
      (this.isPlaying ||
        this.targetScrollY !== null ||
        (this.voiceTrackingActive && this.voiceAnchorY !== null && this.rafId !== 0)) &&
      !this.isUserTouching &&
      Math.abs(this.stageEl.scrollTop - this.lastWrittenScrollTop) < 3;

    if (isProgrammatic) return;

    this.hasManualScroll = true;
    this.virtualScrollY = this.stageEl.scrollTop;
    if (this.voiceTrackingActive) {
      this.voiceAnchorY = null;
      this.voiceVelocity = 0;
    }

    if (!('onscrollend' in window)) {
      clearTimeout(this.manualSyncTimer);
      this.manualSyncTimer = setTimeout(this._onScrollSettled, 140);
    }
  }

  _onScrollSettled() {
    if (!this.hasManualScroll || this.isPlaying || this.targetScrollY !== null) return;
    this.hasManualScroll = false;
    this.virtualScrollY = this.stageEl.scrollTop;
    if (this.tokens.length === 0) return;

    this.lastPaceAnchorY = null;
    this.lastPaceTime = 0;
    if (this.voiceTrackingActive) {
      this.voiceAnchorY = this.stageEl.scrollTop;
    }

    const index = this.findTokenAtFocusLine();
    if (index !== this.cursorIndex) {
      this.cursorIndex = index;
      this.onTokenCursorChange?.(index);
    }
  }
}
