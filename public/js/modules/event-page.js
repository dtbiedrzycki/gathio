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
      const setPanel = (open) => {
        sharePanel.hidden = !open;
        shareButton.setAttribute("aria-expanded", String(open));
      };
      // Phones and tablets get their own share sheet; with a mouse, the
      // panel's link and Copy buttons are more useful
      const isTouch =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(pointer: coarse)").matches;
      shareButton.addEventListener("click", () => {
        if (!sharePanel.hidden) {
          setPanel(false);
        } else if (isTouch && typeof navigator.share === "function") {
          // Fall back to the panel if the guest dismisses the sheet
          navigator
            .share({
              title: shareButton.dataset.shareTitle,
              url: shareButton.dataset.shareUrl,
            })
            .catch(() => setPanel(true));
        } else {
          setPanel(true);
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
