"use strict";
const $ = (s) => document.querySelector(s);

/* Tiny DOM builder. Uses textContent-style appends, so typed text can never inject HTML. */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid);
  return el;
}

/* ---------- Data model ---------- */
// A "word" is { id, english, thai }. english is stored normalised (lowercase, single spaces).
let words = [];
const state = {
  tab: "sentence",
  tokens: [],
  drafts: {},        // unsaved Thai text typed for unknown words, keyed by english
  suggested: {},     // what auto-translate proposed, so unchanged drafts can be labelled "Suggested"
  sentenceThai: "",  // auto-translation of the whole sentence (for context only, never saved)
  options: {},       // dictionary meanings per word: { english: [ {thai, pos, note}, ... ] }
  busy: false,       // an auto-translate request is in flight
  editing: null,     // id of the vocabulary row being edited
  filter: "",
  review: { deck: null, i: 0, flipped: false, got: 0, missed: [], reverse: false, label: "" },
};

const normalize = (s) => s.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
const idFor = (english) =>
  english.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") ||
  "w_" + [...english].map((c) => c.codePointAt(0).toString(16)).join("_");
const findWord = (english) => words.find((w) => w.english === english);

function tokenize(sentence) {
  const found = normalize(sentence).match(/[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu) || [];
  return [...new Set(found)];
}

/* ---------- Storage: database when available, this browser otherwise ---------- */
let serverUser = null;   // who the Flask server says you are: null until your first save, then { kind: "guest" | "google", email }

const store = {
  mode: "connecting",   // becomes "server", "db" or "local" once we know which one works
  async put(w) {},
  async del(id) {},
};

function useLocalStore() {
  store.mode = "local";
  try { words = JSON.parse(localStorage.getItem("thai-flashcards") || "[]"); } catch (e) { words = []; }
  const persist = () => { try { localStorage.setItem("thai-flashcards", JSON.stringify(words)); } catch (e) {} };
  store.put = async (w) => {
    words = words.filter((x) => x.id !== w.id).concat(w);
    persist(); renderAll();
  };
  store.del = async (id) => { words = words.filter((x) => x.id !== id); persist(); renderAll(); };
  renderAll();
}

async function useDatabase(db) {
  store.mode = "db";
  const col = db.collection("words");
  store.put = (w) => col.doc(w.id).set({ english: w.english, thai: w.thai, added: Date.now() });
  store.del = (id) => col.doc(id).delete();
  col.onSnapshot(
    (snap) => {
      words = snap.docs.map((d) => ({ id: d.id, english: d.data().english, thai: d.data().thai }))
        .sort((a, b) => a.english.localeCompare(b.english));
      renderAll();
    },
    () => { useLocalStore(); }
  );
}

// Google's sign-in script is loaded only when the server has Google sign-in set up, and only for guests.
function loadGoogleScript() {
  return new Promise((resolve, reject) => {
    if (window.google && window.google.accounts) return resolve();
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = resolve;
    s.onerror = reject;
    document.head.append(s);
  });
}

// Show Google's "Sign in" button. When someone taps it, Google hands the page a signed proof of who they are
// (the "credential"). The page forwards it to our server, which checks it with Google before trusting it.
async function setupGoogleSignIn(clientId) {
  try { await loadGoogleScript(); } catch (e) { return; }   // offline or blocked: guests can still use the app
  google.accounts.id.initialize({
    client_id: clientId,
    callback: async ({ credential }) => {
      try {
        const r = await fetch("/api/google-login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credential }) });
        const info = await r.json().catch(() => ({}));
        if (r.ok) { location.reload(); return; }   // reload: the page now loads the signed-in account's words
        toast(info.error || "Google sign-in failed. Try again.");
      } catch (e) {
        toast("Couldn't reach the server. Try again.");
      }
    },
  });
  google.accounts.id.renderButton($("#google-button"), { type: "standard", theme: "outline", size: "medium", shape: "pill", text: "signin" });
  $("#google-button").hidden = false;
}

// Third option: your own Flask server (app.py). Every save is a fetch() request to one of its routes.
// Nobody has to sign in: the server gives each visitor a private guest account the first time they save a word.
async function useServer() {
  // Ask who we are. This also proves a server is here (a plain file, or a site without our server, fails and the
  // caller falls back to the next option).
  const session = await fetch("/api/session").then((r) => r.json());
  serverUser = session.user;   // null until the first save, then { kind: "guest" | "google", email }

  if (serverUser && serverUser.kind === "google") {
    $("#signout").hidden = false;
    $("#signout").onclick = async () => { await fetch("/api/logout", { method: "POST" }); location.reload(); };
  } else if (session.googleClientId) {
    $("#status").title = "You are a guest: your words stay in this browser. Sign in with Google to keep them on every device.";
    setupGoogleSignIn(session.googleClientId);   // not awaited: the app should never wait for Google
  }

  const res = await fetch("/api/words");
  if (!res.ok) throw new Error("No server here");   // the caller catches this and tries the next option
  words = await res.json();
  store.mode = "server";
  // Ask the server which optional features it has. If this fails, the translate buttons simply stay hidden.
  serverFeatures = await fetch("/api/config").then((r) => r.json()).then((c) => ({ translate: !!c.translate, dictionary: !!c.dictionary, tagger: !!c.tagger }))
    .catch(() => ({ translate: false, dictionary: false, tagger: false }));
  $("#credit").hidden = !serverFeatures.dictionary;   // the dictionary's license asks us to credit NECTEC

  // One helper for all writes: send JSON, and turn an error reply into a JavaScript error.
  const call = async (url, method, body) => {
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) {
      const info = await r.json().catch(() => ({}));
      const err = new Error(info.error || "Request failed");
      err.code = "http_" + r.status;
      throw err;
    }
  };
  // After every change, ask the server for the fresh list so the screen always matches the database.
  const reload = async () => { words = await readJson(await fetch("/api/words")); renderAll(); };

  store.put = async (w) => {
    const existing = findWord(w.english);
    if (existing) await call("/api/words/" + existing.id, "PUT", { thai: w.thai });          // edit
    else await call("/api/words", "POST", { english: w.english, thai: w.thai });             // create
    await reload();
  };
  store.del = async (id) => { await call("/api/words/" + id, "DELETE"); await reload(); };
  renderAll();
}

/* ---------- Auto-translate (asks Claude through the "sample" capability) ---------- */
let sample = null;   // stays null when this view can't ask Claude; the buttons then stay hidden

function translateError(e) {
  const code = e && e.code;
  if (code === "not_granted" || code === "sampling_disabled") { sample = null; renderAll(); return "Auto-translate isn't allowed for this page. You can still type the Thai yourself."; }
  if (typeof code === "string" && code.startsWith("http_")) return e.message;   // our server already wrote a clear message
  if (code === "rate_limited") return "Too many translation requests. Wait a moment and try again.";
  if (code === "invalid_json") return "Claude's answer wasn't usable. Try again.";
  console.error("Translation error", e);
  return "Translation failed (" + ((e && e.code) || "unknown") + "). Try again in a moment.";
}

// Ask Claude for JSON. Uses sample.json when this viewer has it, otherwise plain sample() and parses the reply here.
async function askJson(prompt) {
  if (typeof sample.json === "function") return sample.json(prompt, { modelTier: "quick" });
  const { text } = await sample(prompt, { modelTier: "quick" });
  const a = text.search(/[\[{]/), b = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (a < 0 || b < a) throw { code: "invalid_json", message: "No JSON in reply", text };
  return JSON.parse(text.slice(a, b + 1));
}

const cleanThai = (v) => (typeof v === "string" ? v.trim().slice(0, 80) : "");

// Two ways to translate. Inside the Claude website, `sample` asks Claude directly. On your own Flask server,
// the page asks /api/translate and the server calls Claude with its secret key (the page never sees the key).
let serverFeatures = { translate: false, dictionary: false, tagger: false };   // what the Flask server says it can do (see /api/config)
const canTranslate = () => !!sample || serverFeatures.translate || serverFeatures.dictionary;

// Read a fetch() reply as JSON; turn an error reply (4xx/5xx) into a JavaScript error with the server's message.
async function readJson(r) {
  const info = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(info.error || "Translation failed");
    err.code = "http_" + r.status;
    throw err;
  }
  return info;
}

// Words come from the LEXiTRON dictionary (/api/lookup), the whole sentence from DeepL (/api/translate).
// The two requests run at the same time. Either one may be switched off on the server.
async function translateViaServer(list, sentence) {
  const oneWordOnly = list.length === 1 && sentence === list[0];   // Vocabulary tab: no sentence to translate
  const askMeanings = serverFeatures.dictionary
    ? fetch("/api/lookup?words=" + encodeURIComponent(list.join(","))).then(readJson)
    : Promise.resolve(null);
  // DeepL translates the sentence and, in the same call, each word *inside that sentence* (so "love" in "I love you" becomes the verb).
  const askSentence = serverFeatures.translate
    ? fetch("/api/translate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(oneWordOnly ? { sentence } : { sentence, words: list }) }).then(readJson)
    : Promise.resolve(null);
  // spaCy's grammar label for each word *in this sentence* ("love" = verb in "I love you"). Optional: no label if it fails.
  const askTags = serverFeatures.tagger && !oneWordOnly
    ? fetch("/api/tag", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sentence, words: list }) }).then(readJson)
    : Promise.resolve(null);
  const [meanings, whole, tagged] = await Promise.allSettled([askMeanings, askSentence, askTags]);
  if (meanings.status === "rejected" && whole.status === "rejected") throw meanings.reason;
  const tags = tagged.status === "fulfilled" && tagged.value ? tagged.value.labels || {} : {};   // { english: "verb" }

  const dictionary = meanings.status === "fulfilled" && meanings.value ? meanings.value : {};   // { english: [ {thai, pos, note}, ... ] }
  const deepl = whole.status === "fulfilled" && whole.value ? whole.value : null;
  // For a single word typed on the Vocabulary tab, DeepL's "sentence" is simply that word translated.
  const deeplWords = deepl ? (oneWordOnly ? { [list[0]]: deepl.sentence } : deepl.words || {}) : {};

  // Best guess = DeepL's in-context answer. The dictionary's meanings follow as alternatives (DeepL's answer is
  // added to the front of the buttons unless the dictionary already has the same Thai).
  const options = {}, words = {};
  for (const w of list) {
    const tag = tags[w] || "";
    let alternatives = (dictionary[w] || []).map((m) => ({ ...m, label: posLabel(m.pos) }));
    // Meanings of the type the sentence needs come first (a verb in "I love you"), the others follow.
    if (tag) alternatives = [...alternatives.filter((m) => m.label === tag), ...alternatives.filter((m) => m.label !== tag)];
    const fromDeepL = cleanThai(deeplWords[w]);
    if (!fromDeepL) {
      options[w] = alternatives;
    } else {
      // DeepL gives no part of speech. Label it with spaCy's answer for this sentence. Without that, borrow it from
      // the dictionary: DeepL's word is one of its meanings (use that label), or every ordinary meaning agrees.
      const same = alternatives.find((m) => m.thai === fromDeepL);
      const answer = same
        ? { ...same, fromDeepL: true, label: tag || same.label }
        : { thai: fromDeepL, note: "", label: tag || agreedLabel(alternatives), fromDeepL: true };
      options[w] = [answer, ...alternatives.filter((m) => m !== same)];
    }
    if (options[w][0]) words[w] = options[w][0].thai;
  }
  return {
    left: deepl && typeof deepl.translationsLeft === "number" ? deepl.translationsLeft : null,   // translations left today
    sentence: oneWordOnly ? "" : deepl ? deepl.sentence : "",
    words,
    options,
    warning: whole.status === "rejected" ? whole.reason.message : meanings.status === "rejected" ? meanings.reason.message : "",
  };
}

async function translateWords(list, sentence) {
  if (!sample) return translateViaServer(list, sentence);
  const prompt =
    "You help a beginner learn Thai with flashcards. For each English word below, give the most common Thai equivalent " +
    "that fits the sentence, written in Thai script only (no romanization, no explanations). " +
    "Also give a natural Thai translation of the whole sentence.\n" +
    'Reply with only JSON in this shape: {"sentence": "<Thai sentence>", "words": {"<english word>": "<Thai>"}}\n\n' +
    "Sentence: " + JSON.stringify(sentence) + "\nWords: " + JSON.stringify(list);
  return askJson(prompt);
}

async function autoTranslate() {
  const need = state.tokens.filter((t) => !findWord(t));
  if (!canTranslate() || !need.length || state.busy) return;
  state.busy = true; renderSentence();
  try {
    const out = await translateWords(need, $("#sentence-input").value);
    const got = (out && out.words) || {};
    let n = 0;
    for (const tok of need) {
      const thai = cleanThai(got[tok]);
      if (thai && !(state.drafts[tok] || "").trim()) { state.drafts[tok] = thai; state.suggested[tok] = thai; n++; }
    }
    state.sentenceThai = cleanThai(out && out.sentence);
    state.options = (out && out.options) || {};
    if (out && out.warning) { toast(out.warning); return; }   // one half failed: say why (the other half still filled in above)
    const left = out && out.left != null ? " " + out.left + (out.left === 1 ? " translation" : " translations") + " left today." : "";
    toast((n ? "Filled in " + n + (n === 1 ? " suggestion. Check it, then save." : " suggestions. Check them, then save.") : "No new suggestions.") + left);
  } catch (e) {
    if (!e || e.code !== "cancelled") toast(translateError(e));
  } finally {
    state.busy = false; renderAll();
  }
}

async function saveAllDrafts() {
  const pending = state.tokens.filter((t) => !findWord(t) && (state.drafts[t] || "").trim());
  let saved = 0;
  for (const tok of pending) {
    const res = await saveWord(tok, state.drafts[tok]);
    if (!res.ok) { toast(res.error); break; }
    delete state.drafts[tok]; delete state.suggested[tok]; saved++;
  }
  if (saved) toast("Saved " + saved + (saved === 1 ? " word" : " words"));
  renderAll();
}

async function connect() {
  // No window.claude means we are not inside the Claude website, so try our own Flask server first.
  if (!window.claude) {
    try { return await useServer(); } catch (e) {}   // opened as a plain file? fall through to local storage
  }
  // Not awaited: the database should never wait on the translation feature.
  if (window.claude && window.claude.use) {
    window.claude.use("sample").then((s) => { sample = s; renderAll(); }).catch(() => { sample = null; });
  }
  try {
    const db = window.claude && window.claude.use ? await window.claude.use("db") : null;
    if (db) return useDatabase(db);
  } catch (e) {}
  useLocalStore();
}

/* ---------- Actions ---------- */
let toastTimer;
function toast(text) {
  const t = $("#toast");
  t.textContent = text; t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2400);
}

async function saveWord(englishRaw, thaiRaw) {
  const english = normalize(englishRaw), thai = thaiRaw.trim();
  if (!english || !thai) return { ok: false, error: "Enter both the English word and its Thai meaning." };
  try {
    await store.put({ id: idFor(english), english, thai });
    return { ok: true, english };
  } catch (e) {
    const denied = e && e.code === "invalid_argument";
    const fromServer = e && typeof e.code === "string" && e.code.startsWith("http_");   // our Flask server explained what was wrong
    return { ok: false, error: denied ? "You have view-only access, so changes can't be saved." : fromServer ? e.message : "Couldn't save. Try again in a moment." };
  }
}

async function removeWord(id) {
  try { await store.del(id); } catch (e) { toast("Couldn't delete. Try again."); }
}

/* ---------- Rendering ---------- */
function captureFocus() {
  const a = document.activeElement;
  return a && a.dataset && a.dataset.focusKey ? { key: a.dataset.focusKey, pos: a.selectionStart } : null;
}
function restoreFocus(f) {
  if (!f) return;
  const el = document.querySelector('[data-focus-key="' + CSS.escape(f.key) + '"]');
  if (el) { el.focus(); try { el.setSelectionRange(f.pos, f.pos); } catch (e) {} }
}

function renderAll() {
  const f = captureFocus();
  renderStatus(); renderTabs(); renderSentence(); renderVocab(); renderReview();
  restoreFocus(f);
}

function renderStatus() {
  $("#suggest-btn").hidden = !canTranslate();
  const s = $("#status");
  const labels = {
    connecting: "Connecting…",
    server: serverUser && serverUser.email ? serverUser.email : "Guest · saved on the server",
    db: "Saved to database",
    local: "Saved in this browser only",
  };
  s.textContent = labels[store.mode];
  s.classList.toggle("ok", store.mode === "server" || store.mode === "db");
}

function renderTabs() {
  for (const t of document.querySelectorAll(".tab")) {
    const on = t.dataset.tab === state.tab;
    t.setAttribute("aria-selected", on);
    t.tabIndex = on ? 0 : -1;
    $("#panel-" + t.dataset.tab).hidden = !on;
  }
  $("#vocab-count").textContent = words.length ? "(" + words.length + ")" : "";
}

function renderSentence() {
  const box = $("#tokens");
  box.replaceChildren();
  const toks = state.tokens;
  if (!toks.length) {
    box.append(h("p", { class: "empty" }, "Type a sentence above and press Split. Each word becomes a flashcard."));
    return;
  }
  const known = toks.filter(findWord);
  const fresh = toks.length - known.length;
  const hasDrafts = toks.some((t) => !findWord(t) && (state.drafts[t] || "").trim());
  box.append(h("div", { class: "summary" },
    h("p", { class: "muted" }, toks.length + (toks.length === 1 ? " word" : " words") + " · " + known.length + " in your vocabulary" + (fresh ? " · " + fresh + " new" : "")),
    h("div", { class: "actions" },
      canTranslate() && fresh ? h("button", { class: "btn", type: "button", disabled: state.busy, onclick: autoTranslate }, state.busy ? "Translating…" : "Auto-translate new words") : null,
      hasDrafts ? h("button", { class: "btn primary", type: "button", onclick: saveAllDrafts }, "Save all") : null,
      h("button", { class: "btn", type: "button", disabled: !known.length, onclick: () => startReview(known.map(findWord), "this sentence") }, "Review these words"))
  ));
  if (state.sentenceThai) {
    box.append(h("p", { style: "margin-top:12px" },
      h("span", { class: "label" }, "Whole sentence in Thai "),
      h("span", { class: "th", lang: "th" }, state.sentenceThai),
      h("span", { class: "muted", style: "font-size:0.85rem" }, " (machine translation for context, not saved)")));
  }
  box.append(h("div", { class: "list", style: "margin-top:12px" }, toks.map((tok) => {
    const w = findWord(tok);
    if (w) {
      return h("div", { class: "item" },
        h("div", { class: "en" }, tok, h("span", { class: "pill" }, "Known")),
        h("div", { class: "th", lang: "th" }, w.thai),
        h("div", { class: "actions" })
      );
    }
    const input = h("input", {
      type: "text", lang: "th", placeholder: "Thai for “" + tok + "”", autocomplete: "off",
      value: state.drafts[tok] || "", "aria-label": "Thai meaning of " + tok, "data-focus-key": "draft-" + tok,
      oninput: (e) => { state.drafts[tok] = e.target.value; },
      onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); saveToken(tok); } },
    });
    return h("div", { class: "item" },
      h("div", { class: "en" }, tok, state.suggested[tok] && state.drafts[tok] === state.suggested[tok]
        ? h("span", { class: "pill sug" }, "Suggested") : h("span", { class: "pill new" }, "New")),
      input,
      h("div", { class: "actions" }, h("button", { class: "btn primary small", type: "button", onclick: () => saveToken(tok) }, "Save")),
      meaningChips(tok)
    );
  })));
}

// Short labels for the dictionary's part-of-speech codes.
const POS_LABEL = { N: "noun", VT: "verb", VI: "verb", ADJ: "adj.", ADV: "adv.", PRON: "pronoun", PREP: "prep.", CONJ: "conj.", PHRV: "phrasal verb", IDM: "idiom", ABBR: "abbr." };

const posLabel = (pos) => POS_LABEL[pos] || pos.toLowerCase();

// Dictionary entries that are not plain word meanings: phrasal verbs, idioms, abbreviations, and the dictionary's
// descriptions of the English letter ("...ภาษาอังกฤษ" = "in the English language"). They are ignored when voting on a label.
const NOT_PLAIN_POS = ["PHRV", "IDM", "SL", "ABBR", "PRF", "SUF"];

// The one label that all ordinary meanings share ("noun" if every meaning is a noun), or "" when they disagree.
function agreedLabel(meanings) {
  const labels = new Set(meanings
    .filter((m) => !NOT_PLAIN_POS.includes(m.pos) && !m.thai.includes("ภาษาอังกฤษ"))
    .map((m) => m.label));
  return labels.size === 1 ? [...labels][0] : "";
}

// Meanings shown as tap-to-choose buttons under the word. DeepL's answer is first, in green.
function meaningChips(tok) {
  const list = state.options[tok];
  // Nothing to choose between, unless the one answer is DeepL's and has a type label worth showing (e.g. "you" = pronoun).
  if (!list || (list.length < 2 && !(list[0] && list[0].fromDeepL && list[0].label))) return null;
  return h("div", { class: "options" }, list.map((m) =>
    h("button", {
      class: "chip" + (m.fromDeepL ? " deepl" : "") + (state.drafts[tok] === m.thai ? " on" : ""), type: "button",
      title: (m.fromDeepL ? "Suggested by DeepL" : "") + (m.note ? (m.fromDeepL ? " · " : "") + m.note : ""),
      onclick: () => { state.drafts[tok] = m.thai; state.suggested[tok] = m.thai; renderAll(); },
    }, m.thai, m.label ? h("small", null, m.label) : null)
  ));
}

async function saveToken(tok) {
  const res = await saveWord(tok, state.drafts[tok] || "");
  if (res.ok) { delete state.drafts[tok]; delete state.suggested[tok]; toast("Saved “" + tok + "”"); renderAll(); }
  else toast(res.error);
}

function renderVocab() {
  const box = $("#vocab-list");
  box.replaceChildren();
  const q = normalize(state.filter);
  const shown = words.filter((w) => !q || w.english.includes(q) || w.thai.includes(state.filter.trim()));
  if (!words.length) { box.append(h("p", { class: "empty" }, "No words yet. Add one above, or split a sentence and fill in the new words.")); return; }
  if (!shown.length) { box.append(h("p", { class: "empty" }, "No words match “" + state.filter + "”.")); return; }
  box.append(h("div", { class: "list" }, shown.map((w) => {
    if (state.editing === w.id) {
      const inp = h("input", {
        type: "text", lang: "th", value: w.thai, "aria-label": "Thai meaning of " + w.english, "data-focus-key": "edit-" + w.id,
        onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); commitEdit(w, inp.value); } if (e.key === "Escape") { state.editing = null; renderAll(); } },
      });
      return h("div", { class: "item" },
        h("div", { class: "en" }, w.english), inp,
        h("div", { class: "actions" },
          h("button", { class: "btn primary small", type: "button", onclick: () => commitEdit(w, inp.value) }, "Save"),
          h("button", { class: "btn small", type: "button", onclick: () => { state.editing = null; renderAll(); } }, "Cancel"))
      );
    }
    return h("div", { class: "item" },
      h("div", { class: "en" }, w.english),
      h("div", { class: "th", lang: "th" }, w.thai),
      h("div", { class: "actions" },
        h("button", { class: "btn small", type: "button", onclick: () => { state.editing = w.id; renderAll(); const i = document.querySelector('[data-focus-key="edit-' + CSS.escape(w.id) + '"]'); if (i) i.focus(); } }, "Edit"),
        h("button", { class: "btn small danger", type: "button", onclick: (e) => confirmDelete(e.currentTarget, w) }, "Delete"))
    );
  })));
}

async function commitEdit(w, value) {
  const res = await saveWord(w.english, value);
  if (res.ok) { state.editing = null; toast("Updated “" + w.english + "”"); renderAll(); } else toast(res.error);
}

function confirmDelete(btn, w) {
  // No confirm() dialogs in artifacts, so the button asks a second time itself.
  if (btn.dataset.armed) { removeWord(w.id).then(() => toast("Deleted “" + w.english + "”")); return; }
  btn.dataset.armed = "1"; btn.textContent = "Sure?";
  setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = "Delete"; } }, 3000);
}

/* ---------- Review ---------- */
function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function startReview(list, label) {
  if (!list.length) { toast("Add some words first."); return; }
  Object.assign(state.review, { deck: shuffle(list), i: 0, flipped: false, got: 0, missed: [], label });
  state.tab = "review"; renderAll();
}

function renderReview() {
  const box = $("#review");
  const r = state.review;
  box.replaceChildren();

  if (!r.deck) {
    box.append(h("div", { class: "done" },
      h("h2", null, words.length ? "Ready to review?" : "Nothing to review yet"),
      h("p", { class: "muted" }, words.length ? "You have " + words.length + (words.length === 1 ? " word." : " words.") + " Cards come up in random order." : "Add vocabulary first, then come back here."),
      h("button", { class: "btn primary", type: "button", disabled: !words.length, onclick: () => startReview(words, "all words") }, "Start with all words")
    ));
    return;
  }

  if (r.i >= r.deck.length) {
    box.append(h("div", { class: "done" },
      h("div", { "aria-hidden": "true", style: "font-size:2rem" }, "🎉"),
      h("div", { class: "big" }, r.got + " / " + r.deck.length),
      h("p", { class: "muted" }, "cards remembered from " + r.label),
      h("div", { class: "grade" },
        h("button", { class: "btn", type: "button", onclick: () => startReview(r.deck, r.label) }, "Go again"),
        r.missed.length ? h("button", { class: "btn primary", type: "button", onclick: () => startReview(r.missed, "missed cards") }, "Missed only (" + r.missed.length + ")") : null)
    ));
    return;
  }

  const w = r.deck[r.i];
  const front = r.reverse ? h("div", { class: "big", lang: "th", style: "font-family:var(--font-thai);font-weight:600" }, w.thai) : h("div", { class: "big" }, w.english);
  const back = r.reverse ? h("div", { class: "big", style: "font-family:var(--font-display);font-weight:700;font-size:clamp(2rem,9vw,3rem)" }, w.english) : h("div", { class: "big", lang: "th" }, w.thai);
  box.append(h("div", { style: "display:flex;flex-direction:column;gap:16px" },
    h("div", { class: "deck-controls" },
      h("span", { class: "muted", style: "font-variant-numeric:tabular-nums" }, "Card " + (r.i + 1) + " of " + r.deck.length + " · " + r.label),
      h("label", { class: "check" }, h("input", { type: "checkbox", id: "reverse", checked: r.reverse, onchange: (e) => { r.reverse = e.target.checked; r.flipped = false; renderReview(); } }), "Thai first")),
    h("div", { class: "progress" }, h("i", { style: "width:" + (r.i / r.deck.length) * 100 + "%" })),
    h("div", { class: "scene" },
      h("button", { class: "card" + (r.flipped ? " flipped" : ""), type: "button", "aria-label": r.flipped ? "Card showing the answer. Press to flip back." : "Show the answer", id: "card", onclick: flip },
        h("div", { class: "face front" }, h("span", { class: "label" }, r.reverse ? "Thai" : "English"), front),
        h("div", { class: "face back" }, h("span", { class: "label" }, r.reverse ? "English" : "Thai"), back))),
    h("div", { class: "hint" }, r.flipped ? null : "Try to recall it, then flip the card."),
    r.flipped ? h("div", { class: "grade" },
      h("button", { class: "btn", type: "button", onclick: () => grade(false) }, "Missed it"),
      h("button", { class: "btn primary", type: "button", onclick: () => grade(true) }, "Got it")) : null
  ));
}

function flip() {
  const r = state.review; r.flipped = !r.flipped;
  const card = $("#card");
  if (card) card.classList.toggle("flipped", r.flipped);
  // Rebuild only the controls under the card so the flip animation is not interrupted.
  const box = $("#review"); const grade = box.querySelector(".grade"); const hint = box.querySelector(".hint");
  if (hint) hint.textContent = r.flipped ? "" : "Try to recall it, then flip the card.";
  if (grade) grade.remove();
  if (r.flipped) {
    hint.after(h("div", { class: "grade" },
      h("button", { class: "btn", type: "button", onclick: () => gradeCard(false) }, "Missed it"),
      h("button", { class: "btn primary", type: "button", id: "got", onclick: () => gradeCard(true) }, "Got it")));
  }
  if (card) card.setAttribute("aria-label", r.flipped ? "Card showing the answer. Press to flip back." : "Show the answer");
}
function gradeCard(ok) {
  const r = state.review;
  if (ok) r.got++; else r.missed.push(r.deck[r.i]);
  r.i++; r.flipped = false; renderReview();
  const c = $("#card"); if (c) c.focus();
}
const grade = gradeCard;

/* ---------- Wiring ---------- */
$("#sentence-form").addEventListener("submit", (e) => {
  e.preventDefault();
  state.tokens = tokenize($("#sentence-input").value);
  state.sentenceThai = "";
  state.options = {};
  renderSentence();
});

$("#suggest-btn").addEventListener("click", async () => {
  const en = $("#add-en"), th = $("#add-th"), msg = $("#add-msg"), btn = $("#suggest-btn");
  const key = normalize(en.value);
  if (!canTranslate() || !key) { msg.className = "msg err"; msg.textContent = "Type the English word first."; return; }
  btn.disabled = true; btn.textContent = "Translating…"; msg.className = "msg"; msg.textContent = "";
  try {
    const out = await translateWords([key], key);   // same helper as the Sentence tab, for one word
    const thai = cleanThai(out && out.words && out.words[key]);
    if (thai) { th.value = thai; th.focus(); msg.className = "msg good"; msg.textContent = "Suggested. Check it, then press Add word."; }
    else { msg.className = "msg err"; msg.textContent = "No suggestion came back. Type the Thai yourself."; }
  } catch (e) { msg.className = "msg err"; msg.textContent = translateError(e); }
  finally { btn.disabled = false; btn.textContent = "Suggest Thai"; }
});

$("#add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const en = $("#add-en"), th = $("#add-th"), msg = $("#add-msg");
  const key = normalize(en.value);
  const dupe = key && findWord(key);
  if (dupe) { msg.className = "msg err"; msg.textContent = "“" + key + "” is already saved as " + dupe.thai + ". Use Edit in the list to change it."; return; }
  const res = await saveWord(en.value, th.value);
  if (res.ok) {
    msg.className = "msg good"; msg.textContent = "Added “" + res.english + "”.";
    en.value = ""; th.value = ""; en.focus();
  } else { msg.className = "msg err"; msg.textContent = res.error; }
});

$("#filter").addEventListener("input", (e) => { state.filter = e.target.value; renderVocab(); });

for (const t of document.querySelectorAll(".tab")) {
  t.addEventListener("click", () => { state.tab = t.dataset.tab; try { localStorage.setItem("thai-flashcards-tab", state.tab); } catch (e) {} renderAll(); });
  t.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const tabs = [...document.querySelectorAll(".tab")];
    const next = tabs[(tabs.indexOf(t) + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    next.click(); next.focus();
  });
}

/* ---------- Day / night switch ---------- */
// The page's colors are CSS variables. Setting data-theme on <html> picks the palette; with no
// data-theme the browser's own light/dark setting decides. The switch just sets that attribute.
const root = document.documentElement;
const sw = $("#theme-switch");
const isNight = () => root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
function syncSwitch() { sw.setAttribute("aria-checked", String(isNight())); }
sw.addEventListener("click", () => {
  const next = isNight() ? "light" : "dark";
  root.dataset.theme = next;
  try { localStorage.setItem("thai-flashcards-theme", next); } catch (e) {}
  syncSwitch();
});
try { const t = localStorage.getItem("thai-flashcards-theme"); if (t === "light" || t === "dark") root.dataset.theme = t; } catch (e) {}
new MutationObserver(syncSwitch).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", syncSwitch);
syncSwitch();

/* Twinkling background stars: [left %, top %, size px, delay s, duration s] */
const STARS = [[6,8,10,0,4],[18,22,6,1.2,5],[32,6,8,2.1,4.5],[47,15,5,0.6,6],[61,7,10,1.7,5.5],[76,20,6,2.6,4],[90,10,8,0.3,5],
  [12,45,6,2.2,6],[27,62,10,0.9,4.5],[52,50,5,1.5,5],[70,58,8,2.8,6],[88,44,6,0.4,4],[8,80,8,1.1,5.5],[40,88,6,2.4,4.5],[82,84,10,1.9,5]];
$("#stars").append(...STARS.map(([x, y, s, d, t]) => h("i", { style: "left:" + x + "%;top:" + y + "%;width:" + s + "px;height:" + s + "px;animation-delay:" + d + "s;animation-duration:" + t + "s" })));

try { const saved = localStorage.getItem("thai-flashcards-tab"); if (saved && $("#panel-" + saved)) state.tab = saved; } catch (e) {}
state.tokens = tokenize($("#sentence-input").value);
renderAll();
connect();
