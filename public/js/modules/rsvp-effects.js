// One-off moments after a guest replies, played from the ?m= flag the RSVP
// redirect leaves on the URL (so each plays once): an emoji burst for "I'm
// going". With reduced motion nothing moves; a still emoji sits in the RSVP
// bar instead.
(function () {
  const DEFAULT_CELEBRATION_EMOJI = "😀";
  const BURST_SIZE = 16;
  const BURST_CLEANUP_MS = 2500;

  function prefersReducedMotion() {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  // A host-chosen emoji on the bar wins, once events can have one
  function celebrationEmoji() {
    const bar = document.getElementById("rsvpBar");
    return (bar && bar.dataset.celebrationEmoji) || DEFAULT_CELEBRATION_EMOJI;
  }

  function addStillEmoji(emoji) {
    const status = document.querySelector(".rsvp-bar__status");
    if (!status) return;
    const span = document.createElement("span");
    span.className = "rsvp-bar__emoji";
    span.setAttribute("aria-hidden", "true");
    span.textContent = emoji;
    status.appendChild(span);
  }

  // Effects rise from the top edge of the RSVP bar, or from the bottom of
  // the screen if there's no bar
  function barOrigin() {
    const bar = document.getElementById("rsvpBar");
    if (bar) {
      const rect = bar.getBoundingClientRect();
      return { left: rect.left, width: rect.width, top: rect.top };
    }
    return { left: 0, width: window.innerWidth, top: window.innerHeight };
  }

  function between(min, max) {
    return min + Math.random() * (max - min);
  }

  function burst(emoji) {
    const origin = barOrigin();
    const layer = document.createElement("div");
    layer.className = "rsvp-burst";
    layer.setAttribute("aria-hidden", "true");
    for (let i = 0; i < BURST_SIZE; i++) {
      const particle = document.createElement("span");
      particle.className =
        "rsvp-burst__emoji rsvp-burst__emoji--" + "abc".charAt(i % 3);
      particle.textContent = emoji;
      // Across the left two-thirds of the bar, where "I'm going" was
      particle.style.left =
        origin.left + between(0, (origin.width * 2) / 3) + "px";
      particle.style.top = origin.top + "px";
      particle.style.fontSize = Math.round(between(22, 36)) + "px";
      particle.style.animationDelay = Math.round(between(0, 360)) + "ms";
      particle.style.animationDuration = Math.round(between(1300, 1900)) + "ms";
      layer.appendChild(particle);
    }
    document.body.appendChild(layer);
    setTimeout(() => layer.remove(), BURST_CLEANUP_MS);
  }

  function celebrateGoing() {
    if (prefersReducedMotion()) {
      addStillEmoji(celebrationEmoji());
      return;
    }
    burst(celebrationEmoji());
    const check = document.querySelector(".rsvp-bar__status .fa-check");
    if (check) check.classList.add("rsvp-pop");
  }

  function play(messageType) {
    try {
      if (messageType === "rsvpgoing") celebrateGoing();
    } catch (e) {
      // A missed flourish must never break the page
      console.error(e);
    }
  }

  window.gathioRsvpEffects = { play };
})();
