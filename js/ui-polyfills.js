let cachedDisplayTransitionSupport;

/**
 * Probes real discrete display transition support (handles Firefox bug 1882408).
 * @returns {boolean}
 */
export function canTransitionDisplay() {
  if (cachedDisplayTransitionSupport !== undefined) {
    return cachedDisplayTransitionSupport;
  }
  if (!window.CSS?.supports?.('transition-behavior', 'allow-discrete') || !document.body) {
    return false;
  }
  const probe = document.createElement('div');
  probe.style.cssText = 'transition: display 1s allow-discrete !important; display: block;';
  document.body.appendChild(probe);
  getComputedStyle(probe).display;
  probe.style.display = 'none';
  cachedDisplayTransitionSupport = getComputedStyle(probe).display === 'block';
  probe.remove();
  return cachedDisplayTransitionSupport;
}

/**
 * Returns true when native overlay + discrete display exit animations work.
 * @returns {boolean}
 */
export function supportsTopLayerExit() {
  return Boolean(window.CSS?.supports?.('overlay', 'auto')) && canTransitionDisplay();
}

/**
 * Closes a modal <dialog> cleanly, animating exit when native overlay/display
 * transitions are unavailable.
 * @param {HTMLDialogElement} dialog
 */
export async function closeDialogAnimated(dialog) {
  if (!dialog || !dialog.open) return;

  if (!supportsTopLayerExit()) {
    dialog.setAttribute('data-closing', '');
    const animations = dialog.getAnimations({ subtree: true });
    if (animations.length > 0) {
      await Promise.race([
        Promise.allSettled(animations.map((a) => a.finished)),
        new Promise((resolve) => setTimeout(resolve, 400)),
      ]);
    }
    if (!dialog.hasAttribute('data-closing')) return;
    dialog.removeAttribute('data-closing');
  }

  dialog.close();
}

/**
 * Polyfills `command` / `commandfor` invoker buttons only when native support is missing.
 */
export function initInvokerCommandsFallback() {
  if ('commandForElement' in HTMLButtonElement.prototype) return;

  document.addEventListener('click', (event) => {
    const button = event.target.closest('button[command][commandfor]');
    if (!button) return;

    const targetId = button.getAttribute('commandfor');
    const command = button.getAttribute('command');
    const target = targetId ? document.getElementById(targetId) : null;
    if (!(target instanceof HTMLDialogElement)) return;

    if (command === 'show-modal' && !target.open) {
      target.showModal();
    } else if (command === 'close' && target.open) {
      closeDialogAnimated(target);
    } else if (command === 'request-close' && target.open) {
      if (typeof target.requestClose === 'function') {
        target.requestClose();
      } else {
        closeDialogAnimated(target);
      }
    }
  });
}

/**
 * Polyfills `<dialog closedby="any">` light dismiss only when native support is missing.
 */
export function initDialogClosedByFallback() {
  const dialogs = document.querySelectorAll('dialog');

  if (!supportsTopLayerExit()) {
    for (const dialog of dialogs) {
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        closeDialogAnimated(dialog);
      });
    }
  }

  if ('closedBy' in HTMLDialogElement.prototype) return;

  const isOutside = (event, dialog) => {
    const rect = dialog.getBoundingClientRect();
    return (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    );
  };

  for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', (event) => {
      pressedOutside = isOutside(event, dialog);
    });
    dialog.addEventListener('pointerup', (event) => {
      if (pressedOutside && isOutside(event, dialog)) {
        closeDialogAnimated(dialog);
      }
      pressedOutside = false;
    });
  }
}

/**
 * Provides roving-tabindex keyboard navigation for a toolbar when native
 * `focusgroup` is unsupported.
 * @param {HTMLElement | null} toolbar
 */
export function initFocusgroupFallback(toolbar) {
  if (!toolbar || 'focusGroup' in HTMLElement.prototype) return;

  const items = Array.from(toolbar.querySelectorAll('button, [role="button"]'));
  if (items.length === 0) return;

  items.forEach((item, index) => {
    item.tabIndex = index === 0 ? 0 : -1;
  });

  toolbar.addEventListener('focusin', ({ target }) => {
    if (!items.includes(target)) return;
    for (const item of items) {
      item.tabIndex = item === target ? 0 : -1;
    }
  });

  toolbar.addEventListener('keydown', (event) => {
    const current = items.indexOf(document.activeElement);
    if (current === -1) return;

    const vertical = toolbar.getAttribute('aria-orientation') === 'vertical';
    const rtl = getComputedStyle(toolbar).direction === 'rtl';

    let next = null;
    if (!vertical && event.key === 'ArrowRight') {
      next = (current + (rtl ? -1 : 1) + items.length) % items.length;
    } else if (!vertical && event.key === 'ArrowLeft') {
      next = (current + (rtl ? 1 : -1) + items.length) % items.length;
    } else if (vertical && event.key === 'ArrowDown') {
      next = (current + 1) % items.length;
    } else if (vertical && event.key === 'ArrowUp') {
      next = (current - 1 + items.length) % items.length;
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = items.length - 1;
    }

    if (next !== null) {
      event.preventDefault();
      items[next].focus();
    }
  });
}

/**
 * Enhances `<input type="checkbox" switch>` with accessible switch semantics and
 * visual styling when the browser lacks native `switch` support.
 */
export function initSwitchFallback() {
  if ('switch' in HTMLInputElement.prototype) return;

  for (const input of document.querySelectorAll('input[type="checkbox"][switch]')) {
    input.setAttribute('role', 'switch');
    input.classList.add('switch-enhanced');
  }
}

/**
 * Syncs range slider CSS custom properties (`--attr-min`, `--attr-max`,
 * `--control-value`) and optional `aria-valuetext`.
 * @param {HTMLInputElement} input
 * @param {(val: string) => string} [formatValueText]
 */
export function syncRangeSlider(input, formatValueText) {
  input.style.setProperty('--attr-min', input.min || '0');
  input.style.setProperty('--attr-max', input.max || '100');
  input.style.setProperty('--control-value', input.value);
  if (formatValueText) {
    input.setAttribute('aria-valuetext', formatValueText(input.value));
  }
}
