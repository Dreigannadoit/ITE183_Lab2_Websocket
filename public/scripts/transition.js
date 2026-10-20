// BISCORD page transitions. Loaded in the <head> of login.html, chat.html and 404.html (before anything is drawn).
//
// Moving between the pages is a full page load, so the animation is played in two halves:
//   leaving:   a coloured curtain grows over the old page from where you clicked   (pageGo)
//   arriving:  the new page starts covered, then the curtain shrinks away to show it
// A short note in sessionStorage tells the new page that it was opened this way. If it is missing
// (typed address, refresh, "reduce motion") the page just opens normally.
//
// Use:  pageGo("/chat")   or   pageGo("/", { replace: true })   instead of  location.href = ...
// Plain <a href="/"> links on the same site are picked up automatically.
// The look of the curtain lives in style.css under "PAGE TRANSITIONS".
(function () {
    var KEY = "chatterbox.transition";
    var EXIT_MS = 640;        // curtain closing: a little longer than the CSS animation (.42s + 3 x 60ms of stagger)
    var REVEAL_MS = 700;      // curtain opening
    var HOLD_MS = 180;        // how long the new page stays covered, so the mascot is seen and the page can settle
    var GIVE_UP_MS = 4000;    // navigation never happened (cancelled, blocked): take the curtain away again

    var root = document.documentElement;
    var reduced = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
    var going = false;

    // ----- the curtain: four coloured layers and the mascot -----
    var curtain = document.createElement("div");
    curtain.className = "pt-curtain";
    curtain.setAttribute("aria-hidden", "true");
    curtain.innerHTML =
        '<i class="pt-layer l1"></i><i class="pt-layer l2"></i><i class="pt-layer l3"></i><i class="pt-layer l4"></i>' +
        '<svg class="pt-badge" viewBox="0 0 120 110">' +
        '<path d="M20 10 H100 Q112 10 112 22 V66 Q112 78 100 78 H66 L46 100 L48 78 H20 Q8 78 8 66 V22 Q8 10 20 10 Z" fill="#FFD23F" stroke="#1B1230" stroke-width="6" stroke-linejoin="round"/>' +
        '<ellipse cx="40" cy="40" rx="7" ry="10" fill="#1B1230"/><ellipse cx="80" cy="40" rx="7" ry="10" fill="#1B1230"/>' +
        '<circle cx="42" cy="35" r="3" fill="#fff"/><circle cx="82" cy="35" r="3" fill="#fff"/>' +
        '<circle cx="26" cy="56" r="6" fill="#FF6FA5"/><circle cx="94" cy="56" r="6" fill="#FF6FA5"/>' +
        '<path d="M46 55 Q60 68 74 55" fill="none" stroke="#1B1230" stroke-width="5" stroke-linecap="round"/></svg>';
    // The body does not exist yet while the <head> is being read, so the curtain goes straight under <html>.
    root.appendChild(curtain);

    // ----- arriving -----
    var arriving = false;
    try {
        var t = Number(sessionStorage.getItem(KEY));
        sessionStorage.removeItem(KEY);
        arriving = !reduced && t > 0 && Date.now() - t < 6000;   // a stale note (old tab, refresh later) is ignored
    } catch (err) { /* storage unavailable: no arrival animation */ }
    // pt-arriving: covered from the very first frame (removed when the curtain is gone).
    // pt-came: stays, so the page's own entrance animation can wait for the curtain (see style.css).
    if (arriving) root.classList.add("pt-arriving", "pt-came");

    function reveal() {
        if (!arriving) return;
        arriving = false;
        // two frames, so the covered state is really on screen before the curtain starts to open
        requestAnimationFrame(function () {
            requestAnimationFrame(function () {
                root.classList.add("pt-reveal");
                setTimeout(function () { root.classList.remove("pt-arriving", "pt-reveal"); }, REVEAL_MS);
            });
        });
    }
    function scheduleReveal() { setTimeout(reveal, HOLD_MS); }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scheduleReveal);
    else scheduleReveal();
    setTimeout(reveal, 4000);   // safety net

    // ----- leaving -----
    // opts.replace: don't add a history entry.  opts.x / opts.y: where the curtain starts growing (default: the middle).
    function pageGo(url, opts) {
        opts = opts || {};
        if (going) return;
        going = true;
        function nav() { if (opts.replace) location.replace(url); else location.href = url; }
        if (reduced) { nav(); return; }
        try { sessionStorage.setItem(KEY, String(Date.now())); } catch (err) { }
        curtain.style.setProperty("--x", isFinite(opts.x) ? opts.x + "px" : "50%");
        curtain.style.setProperty("--y", isFinite(opts.y) ? opts.y + "px" : "50%");
        root.classList.remove("pt-arriving", "pt-reveal");
        root.classList.add("pt-leaving");
        setTimeout(nav, EXIT_MS);
        setTimeout(function () {         // still here long after: the navigation didn't happen
            going = false;
            root.classList.remove("pt-leaving");
            try { sessionStorage.removeItem(KEY); } catch (err) { }
        }, EXIT_MS + GIVE_UP_MS);
    }
    window.pageGo = pageGo;

    // Same-site links get the animation too (for example "Back to BISCORD" on the 404 page).
    document.addEventListener("click", function (e) {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        var a = e.target.closest && e.target.closest("a[href]");
        if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
        var href = a.getAttribute("href");
        if (!href || href.charAt(0) === "#" || a.origin !== location.origin) return;
        if (a.pathname === location.pathname && a.search === location.search) return;
        e.preventDefault();
        pageGo(a.pathname + a.search + a.hash, { x: e.clientX, y: e.clientY });
    });

    // Back / forward can show the page from the browser's cache exactly as we left it: take the curtain away.
    window.addEventListener("pageshow", function (e) {
        if (!e.persisted) return;
        going = false;
        arriving = false;
        root.classList.remove("pt-leaving", "pt-arriving", "pt-reveal");
    });
})();
