/* BISCORD text formatting.
 *
 * Messages stay plain text on the wire and in the database. The formatting lives in the text itself as
 * small markers, so the server needs no changes and old messages are unaffected:
 *
 *   **bold**   *italic*  _italic_   __underline__   ~~strikethrough~~   ==highlight==   ||spoiler||
 *   [n]normal weight[/n]            [c=red]coloured text[/c]   (a name from COLORS, or #rgb / #rrggbb)
 *   `inline code`                   ```multi-line code block```
 *   > quote   (at the start of a line)
 *   \*  a backslash in front of a marker shows the marker itself
 *
 * Two ways to apply them: type the markers yourself, or select text and use the toolbar / shortcuts.
 * Everything is rendered with createElement + textContent (never innerHTML), so a message can't inject HTML.
 *
 * Public API (window.FX):
 *   FX.render(el, text, plain)    fill `el` with the formatted message; `plain(el, str)` writes plain runs (@mentions)
 *   FX.strip(text)                the message without any markers (reply snippets)
 *   FX.attach(textarea)           keyboard shortcuts for a textarea
 *   FX.mountToolbar(box, ta)      build the toolbar inside `box` for textarea `ta`
 *   FX.inOpenFence(ta)            true while the caret is inside an unclosed ``` block
 */
(function () {
    "use strict";

    // ---------- colours ----------
    // Names usable in [c=name]. Every coloured run also gets an ink outline (see style.css), so any of
    // them stays readable on both the white bubbles and your blue ones.
    const COLORS = {
        red: "#FF3B4E", orange: "#FF8A2B", yellow: "#FFD23F", green: "#35D07F", mint: "#35D07F",
        cyan: "#5CCBFF", sky: "#5CCBFF", blue: "#2D6BFF", purple: "#8B5CF6", pink: "#FF6FA5",
        white: "#FFFFFF", black: "#1B1230", gray: "#8D84A3", grey: "#8D84A3",
    };
    const SWATCHES = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "white", "black"];
    const COLOR_TAG = /^\[c=(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3}|[a-zA-Z]{3,8})\]/;

    function cssColor(name) {
        if (name[0] === "#") return name;
        return COLORS[name.toLowerCase()] || "";
    }

    // ---------- inline markers ----------
    const DOUBLE = {
        "**": ["strong", "fx fx-b"],
        "__": ["span", "fx fx-u"],
        "~~": ["span", "fx fx-s"],
        "==": ["mark", "fx fx-mark"],
        "||": ["span", "fx fx-spoiler"],
    };
    const ESCAPABLE = "\\*_~=|`[]>";
    const isWord = (c) => !!c && /\w/.test(c);
    const isSpace = (c) => !c || /\s/.test(c);

    function el(tag, cls) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        return e;
    }

    // Index of the marker that closes a pair opened before `from`, or -1.
    function findClose(src, from, mark) {
        let j = from;
        while (j < src.length) {
            const c = src[j];
            if (c === "\\") { j += 2; continue; }
            if (c === "`") {                                  // markers inside inline code don't count
                const k = src.indexOf("`", j + 1);
                if (k > 0 && src.slice(j + 1, k).indexOf("\n") < 0) { j = k + 1; continue; }
            }
            if (src.substr(j, mark.length) === mark) {
                let end = j;
                // ***both*** : the last two stars close the bold, the one left over belongs to the italic
                if (mark === "**") while (src[end + 2] === "*") end++;
                return end;
            }
            j++;
        }
        return -1;
    }

    // Closing * or _ for italics. A doubled ** inside is skipped (it belongs to a bold run).
    function findItalicClose(src, from, mark) {
        let j = from;
        while (j < src.length) {
            const c = src[j];
            if (c === "\\") { j += 2; continue; }
            if (c === "`") {
                const k = src.indexOf("`", j + 1);
                if (k > 0 && src.slice(j + 1, k).indexOf("\n") < 0) { j = k + 1; continue; }
            }
            if (c === mark) {
                if (mark === "*" && src[j + 1] === "*") { j += 2; continue; }
                if (mark === "_" && (src[j + 1] === "_" || isWord(src[j + 1]))) { j++; continue; }
                if (!isSpace(src[j - 1])) return j;
            }
            j++;
        }
        return -1;
    }

    function inlineRender(src, parent, plain) {
        let buf = "";
        const flush = () => { if (buf) { plain(parent, buf); buf = ""; } };
        const nest = (node, inner) => { flush(); inlineRender(inner, node, plain); parent.append(node); };
        let i = 0;
        while (i < src.length) {
            const ch = src[i];

            if (ch === "\\" && i + 1 < src.length && ESCAPABLE.indexOf(src[i + 1]) >= 0) {
                buf += src[i + 1]; i += 2; continue;
            }

            if (ch === "`") {                                  // `inline code`: nothing inside is formatted
                const j = src.indexOf("`", i + 1);
                const inner = j > i + 1 ? src.slice(i + 1, j) : "";
                if (inner && inner.indexOf("\n") < 0) {
                    flush();
                    const c = el("code", "fx fx-code");
                    c.textContent = inner;
                    parent.append(c);
                    i = j + 1;
                    continue;
                }
            }

            if (ch === "[") {
                const rest = src.slice(i, i + 24);
                const m = COLOR_TAG.exec(rest);
                if (m && cssColor(m[1])) {
                    const j = src.indexOf("[/c]", i + m[0].length);
                    if (j > 0) {
                        const span = el("span", "fx fx-color");
                        span.style.color = cssColor(m[1]);
                        nest(span, src.slice(i + m[0].length, j));
                        i = j + 4;
                        continue;
                    }
                } else if (rest.indexOf("[n]") === 0) {
                    const j = src.indexOf("[/n]", i + 3);
                    if (j > 0) {
                        nest(el("span", "fx fx-n"), src.slice(i + 3, j));
                        i = j + 4;
                        continue;
                    }
                }
            }

            const two = src.substr(i, 2);
            if (DOUBLE[two]) {
                const j = findClose(src, i + 2, two);
                const inner = j > 0 ? src.slice(i + 2, j) : "";
                if (inner && !isSpace(inner[0]) && !isSpace(inner[inner.length - 1])) {
                    const spec = DOUBLE[two];
                    nest(el(spec[0], spec[1]), inner);
                    i = j + 2;
                } else {
                    buf += two; i += 2;                        // not a pair: show the characters as typed
                }
                continue;
            }

            if (ch === "*" || (ch === "_" && !isWord(src[i - 1]))) {
                const j = isSpace(src[i + 1]) ? -1 : findItalicClose(src, i + 1, ch);
                if (j > 0) {
                    nest(el("em", "fx fx-i"), src.slice(i + 1, j));
                    i = j + 1;
                    continue;
                }
            }

            buf += ch;
            i++;
        }
        flush();
    }

    // ---------- blocks: code fences and quotes ----------
    function fenceNode(raw) {
        let body = raw.replace(/^[ \t]*\n/, "");               // the line break right after the opening ```
        let lang = "";
        const nl = body.indexOf("\n");
        if (nl > 0 && /^[\w+#.-]{1,15}$/.test(body.slice(0, nl).trim()) && body.slice(nl + 1).trim()) {
            lang = body.slice(0, nl).trim();
            body = body.slice(nl + 1);
        }
        body = body.replace(/\n[ \t]*$/, "");
        if (!body.trim()) return null;
        const pre = el("pre", "fx fx-pre");
        if (lang) pre.dataset.lang = lang;
        const code = el("code");
        code.textContent = body;
        pre.append(code);
        return pre;
    }

    // Text without code blocks: "> " lines become a quote, everything else is inline-formatted.
    function textRender(text, parent, plain) {
        const lines = text.split("\n");
        let normal = [];
        let quote = [];
        const flushNormal = () => {
            if (normal.length) { inlineRender(normal.join("\n"), parent, plain); normal = []; }
        };
        const flushQuote = () => {
            if (!quote.length) return;
            const bq = el("blockquote", "fx fx-quote");
            inlineRender(quote.join("\n"), bq, plain);
            parent.append(bq);
            quote = [];
        };
        lines.forEach((line) => {
            const q = /^>[ \t]?(?=\S)(.*)$/.exec(line);
            if (q) {
                if (normal.length) { flushNormal(); }
                quote.push(q[1]);
            } else {
                if (quote.length) { flushQuote(); }
                // the line break between a block and the next line is the block's own, not text
                normal.push(line);
            }
        });
        flushQuote();
        flushNormal();
    }

    function render(parent, text, plain) {
        plain = plain || ((e, s) => e.append(s));
        const re = /```([\s\S]*?)```/g;
        let last = 0, m;
        const pieces = [];
        while ((m = re.exec(text))) {
            const node = fenceNode(m[1]);
            if (!node) continue;                               // empty fence: leave it as typed
            pieces.push({ text: text.slice(last, m.index) }, { node });
            last = m.index + m[0].length;
        }
        pieces.push({ text: text.slice(last) });
        pieces.forEach((p, k) => {
            if (p.node) { parent.append(p.node); return; }
            let t = p.text;
            if (k > 0) t = t.replace(/^\n/, "");               // a block already ends its own line
            if (k < pieces.length - 1) t = t.replace(/\n$/, "");
            if (t) textRender(t, parent, plain);
        });
    }

    function strip(text) {
        const box = document.createElement("div");
        render(box, text, (e, str) => e.append(str));
        let out = "";
        let pending = false;                                   // a block just ended: the next text starts a new line
        (function walk(node) {
            Array.prototype.forEach.call(node.childNodes || node.children || [], (c) => {
                if (typeof c === "string" || c.nodeType === 3) {
                    const t = typeof c === "string" ? c : c.data;
                    if (pending && out && t) out += "\n";
                    if (t) pending = false;
                    out += t;
                    return;
                }
                const block = c.tagName === "PRE" || c.tagName === "BLOCKQUOTE" || c.tag === "pre" || c.tag === "blockquote";
                if (block && out) pending = true;
                walk(c);
                if (block) pending = true;
            });
        })(box);
        return out;
    }

    // Spoilers: click to reveal / hide.
    document.addEventListener("click", (e) => {
        const s = e.target.closest && e.target.closest(".fx-spoiler");
        if (s) s.classList.toggle("open");
    });

    // ---------- applying formats to a textarea ----------
    function replaceRange(ta, a, b, text, selA, selB) {
        if (ta.value.length - (b - a) + text.length > ta.maxLength && ta.maxLength > 0) {
            ta.classList.remove("fx-full");
            void ta.offsetWidth;
            ta.classList.add("fx-full");                       // little shake: no room for the markers
            return false;
        }
        ta.focus();
        ta.setSelectionRange(a, b);
        // execCommand keeps the browser's undo history (Ctrl+Z); setRangeText is the fallback
        let ok = false;
        try { ok = document.execCommand("insertText", false, text); } catch (err) { ok = false; }
        if (!ok || ta.value.slice(a, a + text.length) !== text) {
            ta.setRangeText(text, a, b, "end");
            ta.dispatchEvent(new Event("input", { bubbles: true }));
        }
        ta.setSelectionRange(selA, selB);
        return true;
    }

    // How many identical characters run away from `at` in direction dir (+1 / -1).
    function run(s, at, ch, dir) {
        let n = 0;
        while (s[at + dir * n] === ch) n++;
        return n;
    }

    // Wrap the selection in open/close markers, or take them off if they are already there.
    function toggleWrap(ta, open, close) {
        close = close === undefined ? open : close;
        const v = ta.value;
        let a = ta.selectionStart, b = ta.selectionEnd;

        if (a === b) {                                         // nothing selected: drop in a pair, caret in the middle
            replaceRange(ta, a, a, open + close, a + open.length, a + open.length);
            return;
        }
        // do not let leading / trailing spaces end up inside the markers (they would stop them working)
        while (a < b && /\s/.test(v[a])) a++;
        while (b > a && /\s/.test(v[b - 1])) b--;
        if (a === b) return;
        const sel = v.slice(a, b);
        const star = open === "*" && close === "*";

        // markers inside the selection
        if (sel.length >= open.length + close.length && sel.indexOf(open) === 0 &&
            sel.slice(sel.length - close.length) === close) {
            let ok = true;
            if (star) ok = Math.min(run(sel, 0, "*", 1), run(sel, sel.length - 1, "*", -1)) % 2 === 1;
            if (ok) {
                const inner = sel.slice(open.length, sel.length - close.length);
                replaceRange(ta, a, b, inner, a, a + inner.length);
                return;
            }
        }
        // markers just outside the selection
        if (v.slice(a - open.length, a) === open && v.slice(b, b + close.length) === close && a >= open.length) {
            let ok = true;
            if (star) ok = Math.min(run(v, a - 1, "*", -1), run(v, b, "*", 1)) % 2 === 1;
            if (ok) {
                replaceRange(ta, a - open.length, b + close.length, sel, a - open.length, a - open.length + sel.length);
                return;
            }
        }
        replaceRange(ta, a, b, open + sel + close, a + open.length, a + open.length + sel.length);
    }

    function toggleColor(ta, name) {
        const v = ta.value;
        let a = ta.selectionStart, b = ta.selectionEnd;
        const tagRe = /\[c=[#\w]+\]/;
        if (a === b) {
            const open = "[c=" + name + "]";
            replaceRange(ta, a, a, open + "[/c]", a + open.length, a + open.length);
            return;
        }
        while (a < b && /\s/.test(v[a])) a++;
        while (b > a && /\s/.test(v[b - 1])) b--;
        if (a === b) return;
        const sel = v.slice(a, b);
        const open = "[c=" + name + "]";

        // the selection already carries a colour tag (inside it, or just around it): recolour or remove
        let m = /^\[c=[#\w]+\]/.exec(sel);
        if (m && sel.slice(-4) === "[/c]" && sel.indexOf("[/c]") === sel.length - 4) {
            const inner = sel.slice(m[0].length, -4);
            const same = m[0].toLowerCase() === open.toLowerCase();
            const out = same ? inner : open + inner + "[/c]";
            replaceRange(ta, a, b, out, a + (same ? 0 : open.length), a + (same ? 0 : open.length) + inner.length);
            return;
        }
        const before = /\[c=[#\w]+\]$/.exec(v.slice(Math.max(0, a - 20), a));
        if (before && v.slice(b, b + 4) === "[/c]" && tagRe.test(before[0])) {
            const start = a - before[0].length;
            const same = before[0].toLowerCase() === open.toLowerCase();
            const out = same ? sel : open + sel + "[/c]";
            replaceRange(ta, start, b + 4, out, start + (same ? 0 : open.length), start + (same ? 0 : open.length) + sel.length);
            return;
        }
        replaceRange(ta, a, b, open + sel + "[/c]", a + open.length, a + open.length + sel.length);
    }

    function toggleBlock(ta) {
        const v = ta.value;
        let a = ta.selectionStart, b = ta.selectionEnd;
        if (a === b) {
            replaceRange(ta, a, a, "```\n\n```", a + 4, a + 4);
            return;
        }
        const sel = v.slice(a, b);
        const fenced = /^```\n?([\s\S]*?)\n?```$/.exec(sel);
        if (fenced) { replaceRange(ta, a, b, fenced[1], a, a + fenced[1].length); return; }
        const out = "```\n" + sel.replace(/^\n+|\n+$/g, "") + "\n```";
        replaceRange(ta, a, b, out, a + 4, a + out.length - 4);
    }

    function toggleQuote(ta) {
        const v = ta.value;
        const a = ta.selectionStart, b = ta.selectionEnd;
        const start = v.lastIndexOf("\n", a - 1) + 1;
        let end = v.indexOf("\n", b);
        if (end < 0) end = v.length;
        const lines = v.slice(start, end).split("\n");
        const all = lines.every((l) => /^>[ \t]?/.test(l));
        const out = lines.map((l) => (all ? l.replace(/^>[ \t]?/, "") : "> " + l)).join("\n");
        replaceRange(ta, start, end, out, start, start + out.length);
    }

    function clearFormats(ta) {
        const a = ta.selectionStart, b = ta.selectionEnd;
        if (a === b) return;
        const plainText = strip(ta.value.slice(a, b));
        replaceRange(ta, a, b, plainText, a, a + plainText.length);
    }

    // True while the caret sits inside a ``` block that hasn't been closed yet (Enter then adds a line
    // instead of sending, so you can type a code block without reaching for Ctrl+Enter every line).
    function inOpenFence(ta) {
        const before = ta.value.slice(0, ta.selectionStart);
        return (before.match(/```/g) || []).length % 2 === 1;
    }

    // ---------- the formats the toolbar and the shortcuts offer ----------
    const ACTIONS = {
        bold:      { label: "B",  title: "Bold (Ctrl+B)",                    cls: "t-b",    run: (ta) => toggleWrap(ta, "**") },
        italic:    { label: "I",  title: "Italic (Ctrl+I)",                  cls: "t-i",    run: (ta) => toggleWrap(ta, "*") },
        underline: { label: "U",  title: "Underline (Ctrl+U)",               cls: "t-u",    run: (ta) => toggleWrap(ta, "__") },
        strike:    { label: "S",  title: "Strikethrough (Ctrl+Shift+X)",     cls: "t-s",    run: (ta) => toggleWrap(ta, "~~") },
        normal:    { label: "N",  title: "Normal weight (lighter than the usual message text)", cls: "t-n", run: (ta) => toggleWrap(ta, "[n]", "[/n]") },
        mark:      { label: "H",  title: "Highlight (Ctrl+Shift+H)",         cls: "t-mark", run: (ta) => toggleWrap(ta, "==") },
        code:      { label: "</>", title: "Inline code (Ctrl+E)",            cls: "t-code", run: (ta) => toggleWrap(ta, "`") },
        block:     { label: "{ }", title: "Code block (multi-line)",         cls: "t-code", run: (ta) => toggleBlock(ta) },
        quote:     { label: "\u201C", title: "Quote",                         cls: "t-q",    run: (ta) => toggleQuote(ta) },
        spoiler:   { label: "\u25D0", title: "Spoiler (click to reveal)",     cls: "t-sp",   run: (ta) => toggleWrap(ta, "||") },
        clear:     { label: "Tx", title: "Clear formatting from the selection", cls: "t-clr", run: (ta) => clearFormats(ta) },
    };
    const ORDER = ["bold", "italic", "underline", "strike", "normal", "mark", "COLOR", "|", "code", "block", "quote", "spoiler", "|", "clear"];

    function attach(ta) {
        if (ta.dataset.fxAttached) return;
        ta.dataset.fxAttached = "1";
        ta.addEventListener("keydown", (e) => {
            if (e.isComposing || !(e.ctrlKey || e.metaKey) || e.altKey) return;
            const k = e.key.toLowerCase();
            let name = "";
            if (!e.shiftKey) name = { b: "bold", i: "italic", u: "underline", e: "code" }[k] || "";
            else name = { x: "strike", h: "mark" }[k] || "";
            if (!name) return;
            e.preventDefault();
            ACTIONS[name].run(ta);
        });
    }

    function mountToolbar(box, ta) {
        attach(ta);
        box.classList.add("fmt-tools");
        box.setAttribute("role", "toolbar");
        box.setAttribute("aria-label", "Text formatting");
        box.replaceChildren();
        // clicking a button must not take focus (and the selection) away from the text box
        const keepFocus = (e) => e.preventDefault();

        ORDER.forEach((name) => {
            if (name === "|") { box.append(el("span", "fmt-sep")); return; }
            if (name === "COLOR") { box.append(colorPicker(ta, keepFocus)); return; }
            const spec = ACTIONS[name];
            const b = el("button", "fmt-btn " + spec.cls);
            b.type = "button";
            b.textContent = spec.label;
            b.title = spec.title;
            b.setAttribute("aria-label", spec.title);
            b.addEventListener("mousedown", keepFocus);
            b.addEventListener("click", () => { if (ta.disabled) return; spec.run(ta); ta.focus(); });
            box.append(b);
        });
    }

    function colorPicker(ta, keepFocus) {
        const wrap = el("span", "fmt-color");
        const btn = el("button", "fmt-btn t-color");
        btn.type = "button";
        btn.title = "Font colour";
        btn.setAttribute("aria-label", "Font colour");
        btn.setAttribute("aria-haspopup", "true");
        btn.setAttribute("aria-expanded", "false");
        const a = el("span", "t-color-a", "A");
        const bar = el("span", "t-color-bar");
        btn.append(a, bar);

        const pop = el("div", "fmt-pop");
        pop.hidden = true;
        SWATCHES.forEach((name) => {
            const s = el("button", "fmt-swatch");
            s.type = "button";
            s.style.background = COLORS[name];
            s.title = name;
            s.setAttribute("aria-label", "Colour " + name);
            s.addEventListener("mousedown", keepFocus);
            s.addEventListener("click", () => { if (ta.disabled) return; toggleColor(ta, name); bar.style.background = COLORS[name]; close(); ta.focus(); });
            pop.append(s);
        });
        const custom = el("label", "fmt-custom");
        custom.title = "Pick any colour";
        const pick = document.createElement("input");
        pick.type = "color";
        pick.value = "#ff3b4e";
        pick.setAttribute("aria-label", "Custom colour");
        custom.append(pick, el("span", "", "+"));
        // the native colour dialog takes focus, so remember the selection and restore it after
        let saved = null;
        pick.addEventListener("pointerdown", () => { saved = [ta.selectionStart, ta.selectionEnd]; });
        pick.addEventListener("change", () => {
            if (saved) ta.setSelectionRange(saved[0], saved[1]);
            toggleColor(ta, pick.value.toUpperCase());
            bar.style.background = pick.value;
            close();
            ta.focus();
        });
        pop.append(custom);

        function close() { pop.hidden = true; btn.setAttribute("aria-expanded", "false"); }
        btn.addEventListener("mousedown", keepFocus);
        btn.addEventListener("click", () => {
            const open = pop.hidden;
            document.querySelectorAll(".fmt-pop").forEach((p) => { p.hidden = true; });
            pop.hidden = !open;
            btn.setAttribute("aria-expanded", open ? "true" : "false");
        });
        document.addEventListener("mousedown", (e) => { if (!wrap.contains(e.target)) close(); });
        ta.addEventListener("keydown", (e) => { if (e.key === "Escape" && !pop.hidden) { close(); e.stopPropagation(); } }, true);
        wrap.append(btn, pop);
        return wrap;
    }

    window.FX = { render, strip, attach, mountToolbar, inOpenFence, COLORS };
})();
