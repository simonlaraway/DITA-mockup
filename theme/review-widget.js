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

  var helpers = { parseSrc: parseSrc, placement: placement, placementLabel: placementLabel,
    buildMarker: buildMarker, parseMarker: parseMarker, buildBody: buildBody,
    requestFor: requestFor, displayText: displayText };

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
    return fetch(url, { method: method, headers: headers, body: payload ? JSON.stringify(payload) : undefined })
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

  var current = null; // {el, src, quote}

  function targetFor(node) {
    var e = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!e || !root.contains(e) || e.closest('.staging-banner, .rw-ui')) return null;
    var withSrc = e.closest('[data-src]');
    var removed = e.closest('.diff-removed');
    if (removed && (!withSrc || removed.contains(withSrc) || !withSrc.contains(removed))) return { el: removed, src: null };
    return withSrc && root.contains(withSrc) && withSrc !== root ? { el: withSrc, src: withSrc.getAttribute('data-src') } : null;
  }

  var gutter = el('button', { type: 'button', class: 'rw-ui rw-gutter', title: 'Comment on this', 'aria-label': 'Comment on this', text: '💬' });
  var selBtn = el('button', { type: 'button', class: 'rw-ui rw-selbtn', text: '💬 Comment' });
  var hoverTarget = null;
  document.body.appendChild(gutter);
  document.body.appendChild(selBtn);

  function place(node, x, y) { node.style.left = x + 'px'; node.style.top = y + 'px'; node.hidden = false; }

  root.addEventListener('mouseover', function (ev) {
    if (panel.classList.contains('rw-open')) return;
    var t = targetFor(ev.target);
    if (!t) return;
    if (hoverTarget) hoverTarget.el.classList.remove('rw-hover');
    hoverTarget = t;
    t.el.classList.add('rw-hover');
    var r = t.el.getBoundingClientRect(), rootR = root.getBoundingClientRect();
    place(gutter, window.scrollX + Math.max(rootR.left - 34, 2), window.scrollY + r.top);
  });
  root.addEventListener('mouseleave', function () {
    if (hoverTarget) hoverTarget.el.classList.remove('rw-hover');
  });
  /** Text of a block as the PR has it: without widget badges, diff anchors or deleted words. */
  function textOf(node) {
    var copy = node.cloneNode(true);
    Array.prototype.forEach.call(copy.querySelectorAll('.rw-ui, .diff-anchor, del'), function (n) { n.remove(); });
    return copy.textContent;
  }

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
  selBtn.hidden = true;
  gutter.hidden = true;

  // ---- panel -------------------------------------------------------------------------

  var panel = el('aside', { class: 'rw-ui rw-panel', 'aria-label': 'Review comment', role: 'dialog' });
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
    if (current) current.el.classList.remove('rw-active');
    current = null;
  }

  function openPanel(target) {
    if (current) current.el.classList.remove('rw-active');
    current = target;
    current.el.classList.add('rw-active');
    current.el.classList.remove('rw-hover');
    renderCompose('');
    panel.classList.add('rw-open');
  }

  function header(title) {
    return el('div', { class: 'rw-head' }, [
      el('strong', { text: title }),
      el('button', { type: 'button', class: 'rw-x', 'aria-label': 'Close', text: '×', on: { click: closePanel } })
    ]);
  }

  function renderCompose(draft) {
    var p = placement(current.src, config);
    var s = parseSrc(current.src);
    panel.textContent = '';
    panel.appendChild(header('Comment on this content'));

    var srcLine = el('div', { class: 'rw-src' });
    if (s) {
      srcLine.appendChild(el('a', { href: blobUrl(config, s.path, s.line), target: '_blank', rel: 'noopener',
        text: s.path + (s.line ? ':' + s.line : '') }));
    } else {
      srcLine.appendChild(document.createTextNode(current.el.classList.contains('diff-removed')
        ? 'Removed content (no source in this PR)' : 'No source location'));
    }
    panel.appendChild(srcLine);

    if (s && config.topic_src && s.path !== config.topic_src && /\.dita$/.test(s.path)) {
      panel.appendChild(el('p', { class: 'rw-reuse', text: 'This text is reused from ' + s.path +
        '. Changing it there affects every page that uses it.' }));
    }
    var quote = (current.quote || '').replace(/\s+/g, ' ').trim();
    if (quote) panel.appendChild(el('blockquote', { class: 'rw-quote', text: quote.length > QUOTE_MAX ? quote.slice(0, QUOTE_MAX - 1) + '…' : quote }));

    var ta = el('textarea', { rows: '6', placeholder: 'Leave a comment…  (Ctrl/⌘+Enter to post)' });
    ta.value = draft || '';
    panel.appendChild(ta);
    panel.appendChild(el('p', { class: 'rw-where', text: 'Posts as: ' + placementLabel(p) }));

    var submit = el('button', { type: 'button', class: 'rw-primary', text: 'Comment' });
    var actions = el('div', { class: 'rw-actions' }, [
      el('button', { type: 'button', text: 'Cancel', on: { click: closePanel } }), submit]);
    panel.appendChild(actions);
    panel.appendChild(accountLine());

    function go() {
      var text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      if (!getToken()) { renderConnect(ta.value); return; }
      submit.disabled = true;
      submit.textContent = 'Posting…';
      post(p, text).then(function () { submit.disabled = false; }, function () {
        submit.disabled = false; submit.textContent = 'Comment';
      });
    }
    submit.addEventListener('click', go);
    ta.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); go(); }
    });
    setTimeout(function () { ta.focus(); }, 0);
  }

  function accountLine() {
    var line = el('div', { class: 'rw-account' });
    var login = '';
    try { login = localStorage.getItem(storeKey + ':login') || ''; } catch (e) { /* ignore */ }
    if (getToken()) {
      line.appendChild(document.createTextNode('Signed in to GitHub' + (login ? ' as ' + login : '') + ' · '));
      line.appendChild(el('button', { type: 'button', class: 'rw-link', text: 'Sign out', on: { click: function () {
        setToken(''); try { localStorage.removeItem(storeKey + ':login'); } catch (e) { /* ignore */ }
        var ta = panel.querySelector('textarea'); renderCompose(ta ? ta.value : '');
      } } }));
    } else {
      line.appendChild(el('button', { type: 'button', class: 'rw-link', text: 'Connect GitHub', on: { click: function () {
        var ta = panel.querySelector('textarea'); renderConnect(ta ? ta.value : '');
      } } }));
    }
    return line;
  }

  function renderConnect(draft) {
    panel.textContent = '';
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
      el('button', { type: 'button', text: 'Back', on: { click: function () { renderCompose(draft); } } }), save]));
    save.addEventListener('click', function () {
      var t = input.value.trim();
      if (!t) { input.focus(); return; }
      save.disabled = true; save.textContent = 'Checking…';
      gh('GET', API + '/user', null, t).then(function (res) {
        setToken(t);
        try { localStorage.setItem(storeKey + ':login', res.data.login || ''); } catch (e) { /* ignore */ }
        renderCompose(draft);
        loadComments();
      }, function (err) {
        save.disabled = false; save.textContent = 'Save token';
        showToast(['That token didn’t work: ' + err.message], true);
      });
    });
    setTimeout(function () { input.focus(); }, 0);
  }

  function post(p, text) {
    var token = getToken();
    var attempt = function (pl) {
      var req = requestFor(pl, config, buildBody({ config: config, placement: pl, quote: current.quote, comment: text, src: current.src }));
      return gh(req.method, req.url, req.payload, token).catch(function (err) {
        // 422: GitHub rejected the line or file (e.g. the PR moved on). Fall back a level.
        if (err.status === 422 && pl.kind === 'line') return attempt({ kind: 'file', path: pl.path, line: pl.line });
        if (err.status === 422 && pl.kind === 'file') return attempt({ kind: 'conversation', path: pl.path, line: pl.line });
        throw err;
      });
    };
    return attempt(p).then(function (res) {
      var c = res.data;
      addComments([c]);
      closePanel();
      showToast(['Comment posted. ', el('a', { href: c.html_url, target: '_blank', rel: 'noopener', text: 'View on GitHub' })]);
    }, function (err) {
      var msg = err.status === 401 ? 'GitHub rejected the token. Sign out and connect again.'
        : err.status === 403 || err.status === 404 ? 'This token can’t comment on ' + config.repo + ' (needs Pull requests: Read and write).'
        : 'Couldn’t post the comment: ' + err.message;
      showToast([msg], true);
      throw err;
    });
  }

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') { closePanel(); closeThread(); selBtn.hidden = true; }
  });

  // ---- markers for existing comments ---------------------------------------------------

  var bySrc = {};       // src -> [comment]
  var badges = {};      // src -> badge button
  var orphanBtn = null; // comments whose source isn't on this page any more
  var thread = el('div', { class: 'rw-ui rw-thread', role: 'dialog', 'aria-label': 'Comments' });
  thread.hidden = true;
  document.body.appendChild(thread);

  function closeThread() { thread.hidden = true; }

  function findTarget(src) {
    if (!src) return null;
    var nodes = root.querySelectorAll('[data-src]');
    for (var i = 0; i < nodes.length; i++) if (nodes[i].getAttribute('data-src') === src) return nodes[i];
    return null;
  }

  function addComments(list) {
    list.forEach(function (c) {
      var meta = parseMarker(c.body);
      if (!meta || meta.page !== config.page) return;
      var key = meta.src || '';
      bySrc[key] = bySrc[key] || [];
      if (!bySrc[key].some(function (x) { return x.id === c.id; })) bySrc[key].push(c);
    });
    renderBadges();
  }

  function renderBadges() {
    var orphans = [];
    Object.keys(bySrc).forEach(function (src) {
      var target = findTarget(src);
      if (!target) { orphans = orphans.concat(bySrc[src]); return; }
      var b = badges[src];
      if (!b) {
        b = badges[src] = el('button', { type: 'button', class: 'rw-ui rw-badge', title: 'Review comments' });
        b.addEventListener('click', function (ev) { ev.stopPropagation(); openThread(bySrc[src], b); });
        target.insertBefore(b, target.firstChild);
      }
      b.textContent = '💬 ' + bySrc[src].length;
    });
    var banner = document.querySelector('.staging-banner');
    if (orphans.length && banner) {
      if (!orphanBtn) {
        orphanBtn = el('button', { type: 'button', class: 'rw-ui rw-orphans' });
        banner.appendChild(orphanBtn);
      }
      orphanBtn.textContent = '💬 ' + orphans.length + ' on this page';
      orphanBtn.onclick = function (ev) { ev.stopPropagation(); openThread(orphans, orphanBtn); };
    }
  }

  function openThread(comments, anchor) {
    thread.textContent = '';
    thread.appendChild(el('div', { class: 'rw-head' }, [
      el('strong', { text: comments.length + ' comment' + (comments.length === 1 ? '' : 's') }),
      el('button', { type: 'button', class: 'rw-x', 'aria-label': 'Close', text: '×', on: { click: closeThread } })
    ]));
    comments.slice().sort(function (a, b) { return a.created_at < b.created_at ? -1 : 1; }).forEach(function (c) {
      var text = displayText(c.body);
      thread.appendChild(el('div', { class: 'rw-comment' }, [
        el('div', { class: 'rw-meta' }, [
          el('strong', { text: (c.user && c.user.login) || 'unknown' }),
          ' · ' + new Date(c.created_at).toLocaleString() + ' · ',
          el('a', { href: c.html_url, target: '_blank', rel: 'noopener', text: 'Open on GitHub' })
        ]),
        el('div', { class: 'rw-text', text: text.length > 600 ? text.slice(0, 599) + '…' : text })
      ]));
    });
    var r = anchor.getBoundingClientRect();
    thread.hidden = false;
    place(thread, window.scrollX + Math.min(r.left, window.innerWidth - thread.offsetWidth - 16), window.scrollY + r.bottom + 6);
  }

  document.addEventListener('click', function (ev) {
    if (!thread.hidden && !thread.contains(ev.target)) closeThread();
  });

  function fetchAll(url, token, acc) {
    acc = acc || [];
    return gh('GET', url, null, token).then(function (res) {
      acc = acc.concat(res.data || []);
      var next = /<([^>]+)>;\s*rel="next"/.exec(res.link);
      return next ? fetchAll(next[1], token, acc) : acc;
    });
  }

  function loadComments() {
    var token = getToken();
    var base = API + '/repos/' + config.repo;
    var q = '?per_page=100';
    return Promise.all([
      fetchAll(base + '/pulls/' + config.pr + '/comments' + q, token).catch(function () { return []; }),
      fetchAll(base + '/issues/' + config.pr + '/comments' + q, token).catch(function () { return []; })
    ]).then(function (lists) { addComments(lists[0].concat(lists[1])); });
  }

  loadComments();
})();
