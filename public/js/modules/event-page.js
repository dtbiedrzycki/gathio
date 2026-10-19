// Guest-facing controls on the event page that don't need jQuery: the Share
// button and its fallback panel, and the Who's going expand toggle.
(function () {
  function init() {
    initAttendeesToggle();
    const shareButton = document.getElementById("shareEvent");
    const sharePanel = document.getElementById("sharePanel");
    if (shareButton && sharePanel) {
      const openPanel = () => {
        sharePanel.hidden = false;
        shareButton.setAttribute("aria-expanded", "true");
      };
      shareButton.addEventListener("click", () => {
        // Prefer the phone's own share sheet; fall back to the panel when it
        // isn't available or the guest dismisses it
        if (typeof navigator.share === "function") {
          navigator
            .share({
              title: shareButton.dataset.shareTitle,
              url: shareButton.dataset.shareUrl,
            })
            .catch(openPanel);
        } else if (sharePanel.hidden) {
          openPanel();
        } else {
          sharePanel.hidden = true;
          shareButton.setAttribute("aria-expanded", "false");
        }
      });
    }
  }

  function initAttendeesToggle() {
    const toggle = document.getElementById("attendeesToggle");
    const list = document.getElementById("attendeesListWrap");
    if (!toggle || !list) return;
    toggle.addEventListener("click", () => {
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!expanded));
      list.hidden = expanded;
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
