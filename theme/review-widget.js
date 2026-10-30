/*
 * Staging review widget: comment on rendered HTML, land the comment on the PR at the DITA
 * source line that produced it.
 *
 * stage_diff.py injects a <script type="application/json" id="review-config"> into every
 * staged page (repo, PR, head SHA, commentable line ranges, this page's path) and elements
 * carry data-src="content/path.dita:line:col" from the sourcemap DITA-OT plugin.
 *
 * Auth: a fine-grained GitHub token pasted by the reviewer, kept in this browser's
 * localStorage and only ever sent to api.github.com. Comments post as the reviewer.
 *
 * No build step. Pure helpers are exported for `node --test scripts/review-widget.test.mjs`.
 */
(function () {
  'use strict';

  var API = 'https://api.github.com';
  var MARKER = 'staging-review';
  var QUOTE_MAX = 280;

  // ------------------------------------------------------------------ pure helpers

  /** "content/x.dita:34:9" -> {path, line, col}; null when there's no source. */
  function parseSrc(src) {
    if (!src) return null;
    var m = /^(.+?):(\d+)(?::(\d+))?$/.exec(src);
    if (!m) return { path: src, line: null, col: null };
    return { path: m[1], line: +m[2], col: m[3] ? +m[3] : null };
  }

  /**
   * Where a comment on `src` can go. GitHub only takes line comments on lines shown in the
   * PR diff, so: inline on a diff line, else file-level on a changed file, else a PR
   * conversation comment.
   */
  function placement(src, config) {
    var s = parseSrc(src);
    if (!s) return { kind: 'conversation', path: null, line: null };
    var ranges = (config.files || {})[s.path];
    if (ranges && s.line && ranges.some(function (r) { return s.line >= r[0] && s.line <= r[1]; })) {
      return { kind: 'line', path: s.path, line: s.line };
    }
    if (ranges) return { kind: 'file', path: s.path, line: s.line };
    return { kind: 'conversation', path: s.path, line: s.line };
  }

  function placementLabel(p) {
    if (p.kind === 'line') return 'Inline review comment on line ' + p.line + ' of ' + p.path;
    if (p.kind === 'file') return 'File comment on ' + p.path + ' (line ' + p.line + ' isn’t part of the diff)';
    if (p.path) return 'PR conversation comment (' + p.path + ' isn’t changed in this PR)';
    return 'PR conversation comment (this content has no source in the PR)';
  }

  /** Hidden marker appended to every comment, so the widget can find its comments again. */
  function buildMarker(meta) {
    // "--" can't appear inside an HTML comment; JSON-escape it (only occurs in strings).
    var json = JSON.stringify(meta).replace(/--/g, '\\u002d\\u002d');
    return '<!-- ' + MARKER + ' ' + json + ' -->';
  }

  /**
   * Read the marker from a comment body. Only a marker at the very end counts: the widget
   * appends it after the reviewer's text, so text typed into a comment can't fake a location.
   */
  function parseMarker(body) {
    var m = new RegExp('<!-- ' + MARKER + ' (\\{.*\\}) -->\\s*$').exec(body || '');
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (e) { return null; }
  }

  function blobUrl(config, path, line) {
    return 'https://github.com/' + config.repo + '/blob/' + config.head_sha + '/' + path +
      (line ? '#L' + line : '');
  }

  function buildBody(opts) {
    var config = opts.config, p = opts.placement, lines = [];
    var quote = (opts.quote || '').replace(/\s+/g, ' ').trim();
    if (quote) {
      if (quote.length > QUOTE_MAX) quote = quote.slice(0, QUOTE_MAX - 1) + '…';
      lines.push('> ' + quote, '');
    }
    lines.push(opts.comment.trim(), '');
    var where = 'on the [staging preview](' + config.preview_url + config.page + ') of **' +
      (config.page_title || config.page) + '**';
    if (p.path) {
      var loc = '`' + p.path + (p.line ? ':' + p.line : '') + '`';
      where += ' · source ' + (p.kind === 'line' ? loc : '[' + loc + '](' + blobUrl(config, p.path, p.line) + ')');
    }
    lines.push('<sub>Comment ' + where + '</sub>', '');
    lines.push(buildMarker({ page: config.page, src: opts.src || null }));
    return lines.join('\n');
  }

  /** The GitHub REST request for a comment. */
  function requestFor(p, config, body) {
    var base = API + '/repos/' + config.repo;
    if (p.kind === 'line') {
      return { method: 'POST', url: base + '/pulls/' + config.pr + '/comments',
        payload: { body: body, commit_id: config.head_sha, path: p.path, line: p.line, side: 'RIGHT' } };
    }
    if (p.kind === 'file') {
      return { method: 'POST', url: base + '/pulls/' + config.pr + '/comments',
        payload: { body: body, commit_id: config.head_sha, path: p.path, subject_type: 'file' } };
    }
    return { method: 'POST', url: base + '/issues/' + config.pr + '/comments', payload: { body: body } };
  }

  /** Comment text for display: drop the marker and the widget's footer. */
  function displayText(body) {
    return (body || '')
      .replace(new RegExp('<!-- ' + MARKER + ' .*-->\\s*$'), '')
      .replace(/<sub>Comment on the \[staging preview\][\s\S]*?<\/sub>\s*$/, '')
      .trim();
  }

  /** Split a comment for display into its leading "> " quote and the comment text. */
  function splitComment(body) {
    var lines = displayText(body).split('\n'), quote = [];
    while (lines.length && /^>/.test(lines[0])) quote.push(lines.shift().replace(/^>\s?/, ''));
    while (lines.length && !lines[0].trim()) lines.shift();
    return { quote: quote.join(' ').trim(), text: lines.join('\n').trim() };
  }

  function byDate(a, b) { return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0; }

  /**
   * Group a PR's comments into the threads that belong to `page`.
   *  - Review threads (inline and file comments): the root carries the widget marker; replies,
   *    whether posted from the widget or on GitHub, point at it with in_reply_to_id.
   *  - Conversation threads: GitHub doesn't thread issue comments, so widget replies carry a
   *    marker with reply_to = the root comment's id.
   * Returns [{kind: 'review' | 'issue', src, root, replies}], oldest thread first.
   */
  function buildThreads(reviewComments, issueComments, page) {
    var threads = {}, list = [];
    (reviewComments || []).forEach(function (c) {
      if (c.in_reply_to_id) return;
      var meta = parseMarker(c.body);
      if (!meta || meta.page !== page) return;
      list.push(threads['review:' + c.id] = { kind: 'review', src: meta.src || '', root: c, replies: [] });
    });
    (reviewComments || []).forEach(function (c) {
      var t = c.in_reply_to_id && threads['review:' + c.in_reply_to_id];
      if (t) t.replies.push(c);
    });
    var issueReplies = [];
    (issueComments || []).forEach(function (c) {
      var meta = parseMarker(c.body);
      if (!meta || meta.page !== page) return;
      if (meta.reply_to) { issueReplies.push([meta.reply_to, c]); return; }
      list.push(threads['issue:' + c.id] = { kind: 'issue', src: meta.src || '', root: c, replies: [] });
    });
    issueReplies.forEach(function (pair) {
      var t = threads['issue:' + pair[0]];
      if (t) t.replies.push(pair[1]);
    });
    list.forEach(function (t) { t.replies.sort(byDate); });
    return list.sort(function (a, b) { return byDate(a.root, b.root); });
  }

  /** Body for a reply. Review replies are plain; conversation replies need a reply_to marker. */
  function buildReplyBody(opts) {
    var t = opts.thread, text = opts.comment.trim();
    if (t.kind === 'review') return text;
    var author = (t.root.user && t.root.user.login) || 'comment';
    var excerpt = splitComment(t.root.body).text.replace(/\s+/g, ' ');
    if (excerpt.length > 120) excerpt = excerpt.slice(0, 119) + '\u2026';
    return '> @' + author + ': ' + excerpt + '\n\n' + text + '\n\n' +
      buildMarker({ page: opts.config.page, src: t.src || null, reply_to: t.root.id });
  }

  function replyRequestFor(thread, config, body) {
    var base = API + '/repos/' + config.repo;
    if (thread.kind === 'review') {
      return { method: 'POST', url: base + '/pulls/' + config.pr + '/comments/' + thread.root.id + '/replies',
        payload: { body: body } };
    }
    return { method: 'POST', url: base + '/issues/' + config.pr + '/comments', payload: { body: body } };
  }

  var helpers = { parseSrc: parseSrc, placement: placement, placementLabel: placementLabel,
    buildMarker: buildMarker, parseMarker: parseMarker, buildBody: buildBody,
    requestFor: requestFor, displayText: displayText, splitComment: splitComment,
    buildThreads: buildThreads, buildReplyBody: buildReplyBody, replyRequestFor: replyRequestFor };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = helpers;
    return;
  }

  // ------------------------------------------------------------------------- browser

  var cfgEl = document.getElementById('review-config');
  if (!cfgEl) return;
  var config;
  try { config = JSON.parse(cfgEl.textContent); } catch (e) { return; }
  var root = document.querySelector('main') || document.body;
  var storeKey = 'staging-review-token:' + config.repo;

  function getToken() { try { return localStorage.getItem(storeKey) || ''; } catch (e) { return ''; } }
  function setToken(t) { try { t ? localStorage.setItem(storeKey, t) : localStorage.removeItem(storeKey); } catch (e) { /* private mode */ } }

  function gh(method, url, payload, token) {
    var headers = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (payload) headers['Content-Type'] = 'application/json';
    // GETs revalidate (ETag) instead of trusting GitHub's 60s cache, so a reload is always current.
    return fetch(url, { method: method, headers: headers, cache: method === 'GET' ? 'no-cache' : 'default',
      body: payload ? JSON.stringify(payload) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (!r.ok) { var err = new Error(data.message || ('HTTP ' + r.status)); err.status = r.status; throw err; }
          return { data: data, link: r.headers.get('Link') || '' };
        });
      });
  }

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'on') Object.keys(attrs.on).forEach(function (ev) { n.addEventListener(ev, attrs.on[ev]); });
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }

  // ---- choosing a target -------------------------------------------------------------

  var current = null; // {el, src, quote, orphans}

  function targetFor(node) {
    var e = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!e || !root.contains(e) || e.closest('.staging-banner, .rw-ui')) return null;
    var withSrc = e.closest('[data-src]');
    var removed = e.closest('.diff-removed');
    if (removed && (!withSrc || removed.contains(withSrc) || !withSrc.contains(removed))) return { el: removed, src: null };
    return withSrc && root.contains(withSrc) && withSrc !== root ? { el: withSrc, src: withSrc.getAttribute('data-src') } : null;
  }

  var NESTED_BLOCKS = 'p, div, table, ul, ol, dl, pre, li, section, blockquote, figure';

  /**
   * Text of a block as the PR has it: without widget badges, diff anchors or deleted words.
   * Nested blocks (a step's info paragraph or choice table) are left out so the quote is the
   * block's own text, unless that would leave nothing (e.g. a note whose text is in a div).
   */
  function textOf(node) {
    var copy = node.cloneNode(true);
    Array.prototype.forEach.call(copy.querySelectorAll('.rw-ui, .diff-anchor, del'), function (n) { n.remove(); });
    var own = copy.cloneNode(true);
    Array.prototype.forEach.call(own.querySelectorAll(NESTED_BLOCKS), function (n) { n.remove(); });
    return own.textContent.trim() ? own.textContent : copy.textContent;
  }

  var gutter = el('button', { type: 'button', class: 'rw-ui rw-gutter', title: 'Comment on this', 'aria-label': 'Comment on this', text: '💬' });
  var selBtn = el('button', { type: 'button', class: 'rw-ui rw-selbtn', text: '💬 Comment' });
  var hoverTarget = null;
  document.body.appendChild(gutter);
  document.body.appendChild(selBtn);
  gutter.hidden = true;
  selBtn.hidden = true;

  function place(node, x, y) { node.style.left = x + 'px'; node.style.top = y + 'px'; node.hidden = false; }

  // The 💬 button sits just right of the hovered block (inside it if the window is too narrow).
  root.addEventListener('mouseover', function (ev) {
    if (panel.classList.contains('rw-open')) return;
    var t = targetFor(ev.target);
    if (!t) return;
    if (hoverTarget) hoverTarget.el.classList.remove('rw-hover');
    hoverTarget = t;
    t.el.classList.add('rw-hover');
    var r = t.el.getBoundingClientRect();
    var x = r.right + 8;
    if (x + 30 > document.documentElement.clientWidth) x = r.right - 32;
    place(gutter, window.scrollX + x, window.scrollY + r.top);
  });
  root.addEventListener('mouseleave', function (ev) {
    if (ev.relatedTarget === gutter) return;
    if (hoverTarget) hoverTarget.el.classList.remove('rw-hover');
  });
  gutter.addEventListener('click', function () {
    if (hoverTarget) openPanel({ el: hoverTarget.el, src: hoverTarget.src, quote: textOf(hoverTarget.el) });
  });

  document.addEventListener('mouseup', function (ev) {
    if (ev.target.closest && ev.target.closest('.rw-ui')) return;
    setTimeout(function () {
      var sel = window.getSelection();
      var text = '';
      if (sel && !sel.isCollapsed) {
        var frag = document.createElement('div');
        frag.appendChild(sel.getRangeAt(0).cloneContents());
        text = textOf(frag).trim();
      }
      var t = text ? targetFor(sel.getRangeAt(0).commonAncestorContainer) : null;
      if (!t) { selBtn.hidden = true; return; }
      var r = sel.getRangeAt(0).getBoundingClientRect();
      place(selBtn, window.scrollX + r.right - 40, window.scrollY + r.bottom + 6);
      selBtn.onclick = function () { selBtn.hidden = true; openPanel({ el: t.el, src: t.src, quote: text }); };
    }, 0);
  });

  // ---- comment state -----------------------------------------------------------------

  var reviewComments = [], issueComments = [], threads = [];

  function rebuild() {
    threads = buildThreads(reviewComments, issueComments, config.page);
    renderBadges();
  }

  function remember(comment, kind) {
    var list = kind === 'review' ? reviewComments : issueComments;
    if (!list.some(function (c) { return c.id === comment.id; })) list.push(comment);
    rebuild();
  }

  function threadsFor(src) { return threads.filter(function (t) { return t.src === src; }); }
  function countOf(ts) { return ts.reduce(function (n, t) { return n + 1 + t.replies.length; }, 0); }

  // ---- panel -------------------------------------------------------------------------

  var panel = el('aside', { class: 'rw-ui rw-panel', 'aria-label': 'Review comments', role: 'dialog' });
  document.body.appendChild(panel);
  var toast = el('div', { class: 'rw-ui rw-toast', role: 'status' });
  document.body.appendChild(toast);
  toast.hidden = true;

  function showToast(children, isError) {
    toast.textContent = '';
    children.forEach(function (c) { toast.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    toast.classList.toggle('rw-error', !!isError);
    toast.hidden = false;
    clearTimeout(showToast.t);
    showToast.t = setTimeout(function () { toast.hidden = true; }, isError ? 9000 : 6000);
  }

  function closePanel() {
    panel.classList.remove('rw-open');
    if (current && current.el) current.el.classList.remove('rw-active');
    current = null;
  }

  function openPanel(target) {
    if (current && current.el) current.el.classList.remove('rw-active');
    current = target;
    if (current.el) { current.el.classList.add('rw-active'); current.el.classList.remove('rw-hover'); }
    gutter.hidden = true;
    renderPanel();
    panel.classList.add('rw-open');
  }

  function header(title) {
    return el('div', { class: 'rw-head' }, [
      el('strong', { text: title }),
      el('button', { type: 'button', class: 'rw-x', 'aria-label': 'Close', text: '×', on: { click: closePanel } })
    ]);
  }

  /** Re-render the panel for `current`, keeping any text typed into its boxes. */
  function renderPanel() {
    if (!current) return;
    var drafts = {};
    Array.prototype.forEach.call(panel.querySelectorAll('textarea[data-draft]'), function (ta) {
      if (ta.value) drafts[ta.getAttribute('data-draft')] = ta.value;
    });
    var focusKey = document.activeElement && panel.contains(document.activeElement) ? document.activeElement.getAttribute('data-draft') : null;

    var ts = current.orphans ? threads.filter(function (t) { return !findTarget(t.src); }) : threadsFor(current.src);
    panel.textContent = '';
    panel.appendChild(header(current.orphans ? 'Comments on content that moved'
      : ts.length ? countOf(ts) + ' comment' + (countOf(ts) === 1 ? '' : 's') + ' on this content' : 'Comment on this content'));

    if (!current.orphans) {
      var s = parseSrc(current.src);
      var srcLine = el('div', { class: 'rw-src' });
      if (s) {
        srcLine.appendChild(el('a', { href: blobUrl(config, s.path, s.line), target: '_blank', rel: 'noopener',
          text: s.path + (s.line ? ':' + s.line : '') }));
      } else {
        srcLine.appendChild(document.createTextNode(current.el && current.el.classList.contains('diff-removed')
          ? 'Removed content (no source in this PR)' : 'No source location'));
      }
      panel.appendChild(srcLine);
      if (s && config.topic_src && s.path !== config.topic_src && /\.dita$/.test(s.path)) {
        panel.appendChild(el('p', { class: 'rw-reuse', text: 'This text is reused from ' + s.path +
          '. Changing it there affects every page that uses it.' }));
      }
    } else {
      panel.appendChild(el('p', { class: 'rw-fine', text: 'The source lines these comments were made on aren’t on this page any more (the PR changed since).' }));
    }

    ts.forEach(function (t) { panel.appendChild(renderThread(t, drafts)); });

    if (!current.orphans) panel.appendChild(renderComposer(ts.length > 0, drafts['new'] || ''));
    panel.appendChild(accountLine());

    var focus = focusKey && panel.querySelector('textarea[data-draft="' + focusKey + '"]');
    if (focus) focus.focus();
    else if (!ts.length) { var ta = panel.querySelector('textarea[data-draft="new"]'); if (ta) setTimeout(function () { ta.focus(); }, 0); }
  }

  function renderComment(c, isRoot) {
    var parts = splitComment(c.body);
    var box = el('div', { class: 'rw-comment' + (isRoot ? ' rw-root' : '') }, [
      el('div', { class: 'rw-meta' }, [
        el('strong', { text: (c.user && c.user.login) || 'unknown' }),
        ' · ' + new Date(c.created_at).toLocaleString() + ' · ',
        el('a', { href: c.html_url, target: '_blank', rel: 'noopener', text: 'GitHub' })
      ])
    ]);
    if (isRoot && parts.quote) box.appendChild(el('blockquote', { class: 'rw-quote', text: parts.quote }));
    box.appendChild(el('div', { class: 'rw-text', text: parts.text }));
    return box;
  }

  function renderThread(t, drafts) {
    var key = t.kind + ':' + t.root.id;
    var box = el('section', { class: 'rw-threadbox' });
    box.appendChild(renderComment(t.root, true));
    t.replies.forEach(function (c) { box.appendChild(renderComment(c, false)); });

    var ta = el('textarea', { rows: '3', 'data-draft': key, placeholder: 'Reply…  (Ctrl/⌘+Enter to send)' });
    ta.value = drafts[key] || '';
    var send = el('button', { type: 'button', class: 'rw-primary', text: 'Reply' });
    var form = el('div', { class: 'rw-reply' }, [ta, el('div', { class: 'rw-actions' }, [send])]);
    var opener = el('button', { type: 'button', class: 'rw-replybtn', text: 'Reply…' });
    form.hidden = !ta.value;
    opener.hidden = !!ta.value;
    opener.addEventListener('click', function () { opener.hidden = true; form.hidden = false; ta.focus(); });
    box.appendChild(opener);
    box.appendChild(form);

    function go() {
      var text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      if (!getToken()) { renderConnect(); return; }
      send.disabled = true; send.textContent = 'Sending…';
      var req = replyRequestFor(t, config, buildReplyBody({ config: config, thread: t, comment: text }));
      gh(req.method, req.url, req.payload, getToken()).then(function (res) {
        ta.value = '';
        remember(res.data, t.kind);
        renderPanel();
        showToast(['Reply posted. ', el('a', { href: res.data.html_url, target: '_blank', rel: 'noopener', text: 'View on GitHub' })]);
      }, function (err) {
        send.disabled = false; send.textContent = 'Reply';
        showToast([errorMessage(err, 'reply')], true);
      });
    }
    send.addEventListener('click', go);
    ta.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); go(); }
    });
    return box;
  }

  function renderComposer(hasThreads, draft) {
    var p = placement(current.src, config);
    var box = el('section', { class: 'rw-compose' });
    if (hasThreads) box.appendChild(el('h4', { text: 'Start a new thread' }));
    var quote = (current.quote || '').replace(/\s+/g, ' ').trim();
    if (quote) box.appendChild(el('blockquote', { class: 'rw-quote', text: quote.length > QUOTE_MAX ? quote.slice(0, QUOTE_MAX - 1) + '…' : quote }));
    var ta = el('textarea', { rows: hasThreads ? '3' : '6', 'data-draft': 'new', placeholder: 'Leave a comment…  (Ctrl/⌘+Enter to post)' });
    ta.value = draft;
    box.appendChild(ta);
    box.appendChild(el('p', { class: 'rw-where', text: 'Posts as: ' + placementLabel(p) }));
    var submit = el('button', { type: 'button', class: 'rw-primary', text: 'Comment' });
    box.appendChild(el('div', { class: 'rw-actions' }, [
      el('button', { type: 'button', text: 'Close', on: { click: closePanel } }), submit]));

    function go() {
      var text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      if (!getToken()) { renderConnect(); return; }
      submit.disabled = true; submit.textContent = 'Posting…';
      post(p, text).then(function () { ta.value = ''; renderPanel(); }, function () {
        submit.disabled = false; submit.textContent = 'Comment';
      });
    }
    submit.addEventListener('click', go);
    ta.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); go(); }
    });
    return box;
  }

  function accountLine() {
    var line = el('div', { class: 'rw-account' });
    var login = '';
    try { login = localStorage.getItem(storeKey + ':login') || ''; } catch (e) { /* ignore */ }
    if (getToken()) {
      line.appendChild(document.createTextNode('Signed in to GitHub' + (login ? ' as ' + login : '') + ' · '));
      line.appendChild(el('button', { type: 'button', class: 'rw-link', text: 'Sign out', on: { click: function () {
        setToken(''); try { localStorage.removeItem(storeKey + ':login'); } catch (e) { /* ignore */ }
        renderPanel();
      } } }));
    } else {
      line.appendChild(el('button', { type: 'button', class: 'rw-link', text: 'Connect GitHub', on: { click: function () { renderConnect(); } } }));
    }
    line.appendChild(document.createTextNode(' · '));
    line.appendChild(el('button', { type: 'button', class: 'rw-link', text: 'Refresh comments', on: { click: function () {
      loadComments().then(renderPanel);
    } } }));
    return line;
  }

  function renderConnect() {
    // Keep drafts: hide the panel body instead of discarding it.
    var saved = Array.prototype.slice.call(panel.childNodes);
    saved.forEach(function (n) { n.remove(); });
    function back() { panel.textContent = ''; saved.forEach(function (n) { panel.appendChild(n); }); }

    panel.appendChild(header('Connect GitHub'));
    panel.appendChild(el('p', { text: 'Comments are posted to the pull request as you. Create a fine-grained personal access token and paste it below:' }));
    panel.appendChild(el('ol', { class: 'rw-steps' }, [
      el('li', {}, ['Open ', el('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener', text: 'GitHub → Fine-grained tokens → Generate' }), '.']),
      el('li', { text: 'Repository access: Only select repositories → ' + config.repo + '.' }),
      el('li', { text: 'Permissions: Pull requests → Read and write.' }),
      el('li', { text: 'Generate the token and copy it.' })
    ]));
    var input = el('input', { type: 'password', placeholder: 'github_pat_…', autocomplete: 'off', spellcheck: 'false' });
    panel.appendChild(input);
    panel.appendChild(el('p', { class: 'rw-fine', text: 'Stored only in this browser and sent only to api.github.com.' }));
    var save = el('button', { type: 'button', class: 'rw-primary', text: 'Save token' });
    panel.appendChild(el('div', { class: 'rw-actions' }, [
      el('button', { type: 'button', text: 'Back', on: { click: back } }), save]));
    save.addEventListener('click', function () {
      var t = input.value.trim();
      if (!t) { input.focus(); return; }
      save.disabled = true; save.textContent = 'Checking…';
      gh('GET', API + '/user', null, t).then(function (res) {
        setToken(t);
        try { localStorage.setItem(storeKey + ':login', res.data.login || ''); } catch (e) { /* ignore */ }
        back();
        loadComments().then(renderPanel);
      }, function (err) {
        save.disabled = false; save.textContent = 'Save token';
        showToast(['That token didn’t work: ' + err.message], true);
      });
    });
    setTimeout(function () { input.focus(); }, 0);
  }

  function errorMessage(err, what) {
    return err.status === 401 ? 'GitHub rejected the token. Sign out and connect again.'
      : err.status === 403 || err.status === 404 ? 'This token can’t comment on ' + config.repo + ' (needs Pull requests: Read and write).'
      : 'Couldn’t post the ' + what + ': ' + err.message;
  }

  function post(p, text) {
    var token = getToken();
    var attempt = function (pl) {
      var req = requestFor(pl, config, buildBody({ config: config, placement: pl, quote: current.quote, comment: text, src: current.src }));
      return gh(req.method, req.url, req.payload, token).then(function (res) {
        return { comment: res.data, kind: pl.kind === 'conversation' ? 'issue' : 'review' };
      }, function (err) {
        // 422: GitHub rejected the line or file (e.g. the PR moved on). Fall back a level.
        if (err.status === 422 && pl.kind === 'line') return attempt({ kind: 'file', path: pl.path, line: pl.line });
        if (err.status === 422 && pl.kind === 'file') return attempt({ kind: 'conversation', path: pl.path, line: pl.line });
        throw err;
      });
    };
    return attempt(p).then(function (res) {
      remember(res.comment, res.kind);
      showToast(['Comment posted. ', el('a', { href: res.comment.html_url, target: '_blank', rel: 'noopener', text: 'View on GitHub' })]);
    }, function (err) {
      showToast([errorMessage(err, 'comment')], true);
      throw err;
    });
  }

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') { closePanel(); selBtn.hidden = true; }
  });

  // ---- badges for existing threads -----------------------------------------------------

  var badges = {};      // src -> badge button
  var orphanBtn = null; // threads whose source isn't on this page any more

  function findTarget(src) {
    if (!src) return null;
    var nodes = root.querySelectorAll('[data-src]');
    for (var i = 0; i < nodes.length; i++) if (nodes[i].getAttribute('data-src') === src) return nodes[i];
    return null;
  }

  function renderBadges() {
    var bySrc = {}, orphans = [];
    threads.forEach(function (t) {
      if (findTarget(t.src)) (bySrc[t.src] = bySrc[t.src] || []).push(t);
      else orphans.push(t);
    });
    Object.keys(bySrc).forEach(function (src) {
      var target = findTarget(src), b = badges[src];
      if (!b) {
        b = badges[src] = el('button', { type: 'button', class: 'rw-ui rw-badge', title: 'Show comments' });
        b.addEventListener('click', function (ev) {
          ev.stopPropagation();
          openPanel({ el: target, src: src, quote: textOf(target) });
        });
        target.insertBefore(b, target.firstChild);
      }
      b.textContent = '💬 ' + countOf(bySrc[src]);
    });
    var banner = document.querySelector('.staging-banner');
    if (orphans.length && banner) {
      if (!orphanBtn) {
        orphanBtn = el('button', { type: 'button', class: 'rw-ui rw-orphans' });
        orphanBtn.addEventListener('click', function (ev) { ev.stopPropagation(); openPanel({ el: null, src: null, orphans: true }); });
        banner.appendChild(orphanBtn);
      }
      orphanBtn.textContent = '💬 ' + countOf(orphans) + ' on moved content';
    }
  }

  function fetchAll(url, token, acc) {
    acc = acc || [];
    return gh('GET', url, null, token).then(function (res) {
      acc = acc.concat(res.data || []);
      var next = /<([^>]+)>;\s*rel="next"/.exec(res.link);
      return next ? fetchAll(next[1], token, acc) : acc;
    });
  }

  /** Fetch every review and conversation comment on the PR (runs on each page load). */
  function loadComments() {
    var token = getToken();
    var base = API + '/repos/' + config.repo;
    var q = '?per_page=100';
    return Promise.all([
      fetchAll(base + '/pulls/' + config.pr + '/comments' + q, token).catch(function () { return null; }),
      fetchAll(base + '/issues/' + config.pr + '/comments' + q, token).catch(function () { return null; })
    ]).then(function (lists) {
      if (lists[0]) reviewComments = lists[0];
      if (lists[1]) issueComments = lists[1];
      rebuild();
    });
  }

  loadComments();
})();
