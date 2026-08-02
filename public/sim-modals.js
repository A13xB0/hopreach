// The simulator's modal system: opening and closing the stacked detail dialogs, and keeping keyboard focus trapped inside the top one.
//
// Split out of simulator.js. Shared mutable state comes from sim-state.js;
// everything else this module needs from the simulator arrives through the
// context object passed to init().
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SimModals = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const S = window.SimState;

  let goBackPacketModal;

  // --- modal system --------------------------------------------------
  //
  // Every heavier chunk of the simulator's own output (results, bottleneck
  // analysis, predicted settings, repeater config) lives in its own modal
  // rather than a permanently-docked section, so the side panel itself
  // stays a short, fixed list of controls instead of growing a long
  // scrolling stack of mostly-empty sections. Only one modal is open at a
  // time — opening a new one closes whichever was already up.
  // Where focus was before a modal opened — restored on close so keyboard/
  // screen-reader users land back where they were, not at the top of the
  // document (see openModal/closeModals).
  
  const MODAL_FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

  function openModal(id) {
    document.querySelectorAll(".sim-modal").forEach((m) => m.classList.add("hidden"));
    const modal = document.getElementById(id);
    modal.classList.remove("hidden");
    document.getElementById("sim-modal-backdrop").classList.remove("hidden");
    S.modalReturnFocusEl = document.activeElement;
    const firstFocusable = modal.querySelector(MODAL_FOCUSABLE_SELECTOR);
    (firstFocusable || modal).focus({ preventScroll: true });
  }

  function closeModals() {
    document.getElementById("sim-modal-backdrop").classList.add("hidden");
    document.querySelectorAll(".sim-modal").forEach((m) => m.classList.add("hidden"));
    if (S.modalReturnFocusEl && document.body.contains(S.modalReturnFocusEl)) S.modalReturnFocusEl.focus({ preventScroll: true });
    S.modalReturnFocusEl = null;
  }

  // Keyboard handling is bound here, not at module load: goBackPacketModal
  // arrives with the context, and binding earlier would capture undefined.
  function bindKeyboard() {
    // Escape either pops one level of the packet inspector's own node<->packet
    // drill history (mirroring "← Back", since that history exists precisely
    // so a user can back out of a detour without losing their place) or, with
    // nothing to pop, closes the modal outright.
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (document.getElementById("sim-modal-backdrop").classList.contains("hidden")) return;
      if (S.packetModalHistory.length > 0) goBackPacketModal();
      else closeModals();
    });

    // A simple focus trap: Tab/Shift+Tab wrap within whichever modal is open
    // rather than escaping to the page underneath (which the backdrop hides
    // visually but doesn't otherwise block from keyboard focus).
    document.getElementById("sim-modal-backdrop").addEventListener("keydown", (e) => {
      if (e.key !== "Tab") return;
      const modal = document.querySelector(".sim-modal:not(.hidden)");
      if (!modal) return;
      const focusable = Array.from(modal.querySelectorAll(MODAL_FOCUSABLE_SELECTOR)).filter((el) => el.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
  }

  function init(context) {
    ({ goBackPacketModal } = context);
    bindKeyboard();
    return api;
  }

  const api = {
    init,
    closeModals,
    openModal,
  };
  return api;
});
