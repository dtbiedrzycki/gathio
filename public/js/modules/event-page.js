// Guest-facing controls on the event page that don't need jQuery: the Share
// button and its fallback panel, the Who's going expand toggle, and the RSVP
// bar's Change button.
(function () {
  function init() {
    initDisclosure("attendeesToggle");
    initDisclosure("changeRsvp");
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

  // A button that shows and hides the element named by its aria-controls
  function initDisclosure(buttonId) {
    const button = document.getElementById(buttonId);
    const target =
      button && document.getElementById(button.getAttribute("aria-controls"));
    if (!target) return;
    button.addEventListener("click", () => {
      const expanded = button.getAttribute("aria-expanded") === "true";
      button.setAttribute("aria-expanded", String(!expanded));
      target.hidden = expanded;
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
