/* DealDataCRE — One Pager intake → disclaimer → Stripe Checkout
   No dependencies. Talks to the Pages Function at /api/create-checkout-session. */
(function () {
  "use strict";

  var form = document.getElementById("intakeForm");
  var modal = document.getElementById("disclaimerModal");
  var modalBody = modal ? modal.querySelector(".modal__body") : null;
  var closeBtn = document.getElementById("modalClose");
  var ackBox = document.getElementById("ackBox");
  var payBtn = document.getElementById("payBtn");
  var busy = document.getElementById("modalBusy");
  var errBox = document.getElementById("modalErr");

  if (!form) return;

  // Fields that block checkout if empty. Phone, company, description and goal
  // are intentionally optional so an assistant can pay without them.
  var REQUIRED = ["name", "email", "property_address", "property_type"];
  var lastFocused = null;

  /* ---------- word counters ---------- */
  function countWords(s) {
    s = (s || "").trim();
    return s ? s.split(/\s+/).length : 0;
  }
  Array.prototype.forEach.call(document.querySelectorAll("[data-maxwords]"), function (ta) {
    var max = parseInt(ta.getAttribute("data-maxwords"), 10);
    var counter = document.querySelector('[data-count-for="' + ta.id + '"]');
    function update() {
      var n = countWords(ta.value);
      if (counter) {
        counter.textContent = n + " / " + max + " words";
        counter.classList.toggle("over", n > max);
      }
    }
    ta.addEventListener("input", update);
    update();
  });

  /* ---------- date field: keep a picked value dark, placeholder ghosted ---------- */
  Array.prototype.forEach.call(document.querySelectorAll('input[type="date"]'), function (d) {
    function sync() { d.classList.toggle("filled", !!d.value); }
    d.addEventListener("input", sync);
    d.addEventListener("change", sync);
    sync();
  });

  /* ---------- validation ---------- */
  function fieldEl(name) { return form.elements[name]; }
  function wrap(el) { return el ? el.closest(".field") : null; }

  function validateField(name) {
    var el = fieldEl(name);
    if (!el) return true;
    var ok = !!el.value && !!String(el.value).trim();
    if (ok && name === "email") {
      ok = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(el.value.trim());
    }
    // word-limit fields must also be within range
    if (ok && el.hasAttribute("data-maxwords")) {
      var max = parseInt(el.getAttribute("data-maxwords"), 10);
      if (countWords(el.value) > max) ok = false;
    }
    var w = wrap(el);
    if (w) w.classList.toggle("is-invalid", !ok);
    return ok;
  }

  function validateAll() {
    var firstBad = null;
    REQUIRED.forEach(function (name) {
      var ok = validateField(name);
      if (!ok && !firstBad) firstBad = fieldEl(name);
    });
    // The two textareas are optional, but if filled they must stay within the
    // word limit — flag only when over, never when empty.
    ["description", "goal"].forEach(function (name) {
      var el = fieldEl(name);
      if (!el || !el.hasAttribute("data-maxwords")) return;
      var max = parseInt(el.getAttribute("data-maxwords"), 10);
      var over = countWords(el.value) > max;
      var w = wrap(el);
      if (w) w.classList.toggle("is-invalid", over);
      if (over && !firstBad) firstBad = el;
    });
    if (firstBad) {
      firstBad.focus({ preventScroll: false });
      var w = wrap(firstBad);
      if (w && w.scrollIntoView) {
        try { w.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) {}
      }
    }
    return !firstBad;
  }

  // Clear the invalid state as the user fixes a field.
  REQUIRED.concat(["description", "goal"]).forEach(function (name) {
    var el = fieldEl(name);
    if (!el) return;
    var evt = el.tagName === "SELECT" ? "change" : "input";
    el.addEventListener(evt, function () {
      var w = wrap(el);
      if (w && w.classList.contains("is-invalid")) validateField(name);
    });
  });

  /* ---------- modal open / close ---------- */
  function openModal() {
    lastFocused = document.activeElement;
    modal.hidden = false;
    // Force a reflow so the transition runs, then reveal synchronously.
    // (Avoid requestAnimationFrame here — it can be throttled when the
    //  tab/iframe isn't actively painting, leaving the modal stuck hidden.)
    void modal.offsetWidth;
    modal.classList.add("is-open");
    document.body.style.overflow = "hidden";
    resetCheckoutState();
    if (ackBox) { ackBox.checked = false; syncPayBtn(); }
    if (modalBody) modalBody.scrollTop = 0;
    setTimeout(function () { if (closeBtn) closeBtn.focus(); }, 60);
    document.addEventListener("keydown", onKeydown);
  }
  function closeModal() {
    modal.classList.remove("is-open");
    document.body.style.overflow = "";
    document.removeEventListener("keydown", onKeydown);
    setTimeout(function () { modal.hidden = true; }, 200);
    if (lastFocused && lastFocused.focus) lastFocused.focus();
  }
  function onKeydown(e) {
    if (e.key === "Escape") { closeModal(); return; }
    if (e.key === "Tab") trapFocus(e);
  }
  function trapFocus(e) {
    var f = modal.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), [tabindex="0"]');
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /* ---------- checkout state ---------- */
  function resetCheckoutState() {
    if (busy) busy.classList.remove("is-on");
    if (errBox) { errBox.classList.remove("is-on"); errBox.textContent = ""; }
  }
  function syncPayBtn() {
    var on = !!(ackBox && ackBox.checked);
    payBtn.disabled = !on;
    payBtn.setAttribute("aria-disabled", on ? "false" : "true");
  }
  function showError(msg) {
    if (busy) busy.classList.remove("is-on");
    if (errBox) { errBox.textContent = msg; errBox.classList.add("is-on"); }
    payBtn.disabled = !(ackBox && ackBox.checked);
    payBtn.setAttribute("aria-disabled", payBtn.disabled ? "true" : "false");
  }

  function collect() {
    var d = {};
    ["name", "phone", "email", "company", "property_address", "property_type",
     "description", "goal", "deadline", "price", "building_size", "land_size"].forEach(function (k) {
      var el = fieldEl(k);
      d[k] = el ? String(el.value || "").trim() : "";
    });
    d.product = "The One Pager";
    return d;
  }

  async function startCheckout() {
    resetCheckoutState();
    if (busy) busy.classList.add("is-on");
    payBtn.disabled = true;
    payBtn.setAttribute("aria-disabled", "true");

    try {
      var resp = await fetch("/api/create-checkout-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(collect()),
      });
      var data = await resp.json().catch(function () { return {}; });
      if (!resp.ok || !data.url) {
        showError(data.error || "We couldn't start checkout. Please try again or email admin@dealdatacre.com.");
        return;
      }
      window.location.href = data.url; // → Stripe-hosted Checkout
    } catch (err) {
      showError("Network error — please check your connection and try again.");
    }
  }

  /* ---------- wire events ---------- */
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (validateAll()) openModal();
  });
  if (closeBtn) closeBtn.addEventListener("click", closeModal);
  modal.addEventListener("click", function (e) {
    if (e.target === modal) closeModal();
  });
  if (ackBox) ackBox.addEventListener("change", syncPayBtn);
  if (payBtn) payBtn.addEventListener("click", function () {
    if (ackBox && ackBox.checked) startCheckout();
  });
  syncPayBtn();
})();
