// Tests for theme/review-widget.js pure helpers. Run: node --test scripts/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const w = require('../theme/review-widget.js');

const config = {
  repo: 'owner/repo', pr: 7, head_sha: 'abc1234def', page: 'user/topics/a.html', page_title: 'Topic A',
  preview_url: 'https://owner.github.io/repo/pr-preview/pr-7/',
  files: { 'content/topics/a.dita': [[10, 20], [40, 45]] },
};

test('parseSrc', () => {
  assert.deepEqual(w.parseSrc('content/topics/a.dita:34:9'), { path: 'content/topics/a.dita', line: 34, col: 9 });
  assert.deepEqual(w.parseSrc('content/topics/a.dita:34'), { path: 'content/topics/a.dita', line: 34, col: null });
  assert.equal(w.parseSrc(''), null);
  assert.equal(w.parseSrc(null), null);
});

test('placement: inline on a diff line', () => {
  assert.deepEqual(w.placement('content/topics/a.dita:12:3', config), { kind: 'line', path: 'content/topics/a.dita', line: 12 });
  assert.equal(w.placement('content/topics/a.dita:45:1', config).kind, 'line');
});

test('placement: file-level when the file changed but the line did not', () => {
  assert.equal(w.placement('content/topics/a.dita:30:1', config).kind, 'file');
});

test('placement: conversation when the file is not in the PR or there is no source', () => {
  assert.equal(w.placement('content/shared/reuse.dita:11:4', config).kind, 'conversation');
  assert.deepEqual(w.placement(null, config), { kind: 'conversation', path: null, line: null });
});

test('requestFor builds the right GitHub requests', () => {
  const line = w.requestFor({ kind: 'line', path: 'content/topics/a.dita', line: 12 }, config, 'B');
  assert.equal(line.url, 'https://api.github.com/repos/owner/repo/pulls/7/comments');
  assert.deepEqual(line.payload, { body: 'B', commit_id: 'abc1234def', path: 'content/topics/a.dita', line: 12, side: 'RIGHT' });

  const file = w.requestFor({ kind: 'file', path: 'content/topics/a.dita', line: 30 }, config, 'B');
  assert.deepEqual(file.payload, { body: 'B', commit_id: 'abc1234def', path: 'content/topics/a.dita', subject_type: 'file' });

  const conv = w.requestFor({ kind: 'conversation', path: null, line: null }, config, 'B');
  assert.equal(conv.url, 'https://api.github.com/repos/owner/repo/issues/7/comments');
  assert.deepEqual(conv.payload, { body: 'B' });
});

test('marker round-trips, including "--" in paths', () => {
  const meta = { page: 'user/topics/a--b.html', src: 'content/x--y.dita:3:1' };
  const marker = w.buildMarker(meta);
  assert.ok(!marker.slice(4, -3).includes('--'), 'no "--" inside the HTML comment');
  assert.deepEqual(w.parseMarker('text\n\n' + marker), meta);
});

test('buildBody: quote, comment, footer, marker; links source unless inline', () => {
  const p = { kind: 'conversation', path: 'content/shared/reuse.dita', line: 11 };
  const body = w.buildBody({ config, placement: p, quote: '  Disconnect   the   dog  ', comment: 'Typo here', src: 'content/shared/reuse.dita:11:4' });
  assert.match(body, /^> Disconnect the dog\n\nTypo here\n/);
  assert.match(body, /\[`content\/shared\/reuse\.dita:11`\]\(https:\/\/github\.com\/owner\/repo\/blob\/abc1234def\/content\/shared\/reuse\.dita#L11\)/);
  assert.match(body, /\[staging preview\]\(https:\/\/owner\.github\.io\/repo\/pr-preview\/pr-7\/user\/topics\/a\.html\) of \*\*Topic A\*\*/);
  assert.deepEqual(w.parseMarker(body), { page: 'user/topics/a.html', src: 'content/shared/reuse.dita:11:4' });

  const inline = w.buildBody({ config, placement: { kind: 'line', path: 'content/topics/a.dita', line: 12 }, comment: 'x', src: 'content/topics/a.dita:12:3' });
  assert.match(inline, /source `content\/topics\/a\.dita:12`/);
  assert.doesNotMatch(inline, /blob\//);
});

test('a fake marker typed into the comment cannot spoof the location', () => {
  const fake = '<!-- staging-review {"page":"admin/x.html","src":"content/evil.dita:1:1"} -->';
  const body = w.buildBody({ config, placement: { kind: 'conversation', path: null, line: null }, comment: fake, src: 'content/topics/a.dita:12:3' });
  assert.deepEqual(w.parseMarker(body), { page: 'user/topics/a.html', src: 'content/topics/a.dita:12:3' });
  // ...and a body that merely contains a marker mid-text, not at the end, has none
  assert.equal(w.parseMarker(fake + '\nmore text'), null);
});

test('long quotes are truncated', () => {
  const body = w.buildBody({ config, placement: { kind: 'conversation', path: null, line: null }, quote: 'a'.repeat(1000), comment: 'x' });
  assert.ok(body.split('\n')[0].length <= 282);
});

test('displayText strips the footer and marker', () => {
  const body = w.buildBody({ config, placement: { kind: 'line', path: 'content/topics/a.dita', line: 12 }, quote: 'Q', comment: 'Please reword', src: 'content/topics/a.dita:12:3' });
  assert.equal(w.displayText(body), '> Q\n\nPlease reword');
});

// ---- threads and replies ----------------------------------------------------------------

const mk = (id, body, extra = {}) => ({ id, body, created_at: `2026-10-28T10:0${id % 10}:00Z`, user: { login: 'u' + id }, html_url: '#' + id, ...extra });
const rootBody = (src, page = config.page) => w.buildBody({ config: { ...config, page }, placement: { kind: 'line', path: 'p', line: 1 }, quote: 'Q', comment: 'Root text', src });

test('buildThreads: review threads pick up GitHub-native replies via in_reply_to_id', () => {
  const review = [
    mk(1, rootBody('content/a.dita:12:1')),
    mk(3, 'Reply typed on GitHub, no marker', { in_reply_to_id: 1 }),
    mk(2, 'Another reply', { in_reply_to_id: 1 }),
    mk(4, 'Ordinary review comment, not from the widget'),
    mk(5, 'Reply to the ordinary comment', { in_reply_to_id: 4 }),
  ];
  const threads = w.buildThreads(review, [], config.page);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].kind, 'review');
  assert.equal(threads[0].src, 'content/a.dita:12:1');
  assert.deepEqual(threads[0].replies.map((c) => c.id), [2, 3]); // sorted by time
});

test('buildThreads: conversation replies attach via reply_to markers', () => {
  const root = mk(10, rootBody('content/shared/reuse.dita:27:30'));
  const t0 = w.buildThreads([], [root], config.page)[0];
  const reply = mk(11, w.buildReplyBody({ config, thread: t0, comment: 'Agreed' }));
  const stray = mk(12, w.buildReplyBody({ config, thread: { ...t0, root: { ...root, id: 999 } }, comment: 'orphan reply' }));
  const threads = w.buildThreads([], [root, reply, stray, mk(13, 'plain PR chatter')], config.page);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].kind, 'issue');
  assert.deepEqual(threads[0].replies.map((c) => c.id), [11]);
});

test('buildThreads: only threads for this page; ordered oldest first', () => {
  const threads = w.buildThreads(
    [mk(7, rootBody('content/a.dita:1:1')), mk(6, rootBody('content/b.dita:1:1', 'admin/other.html'))],
    [mk(5, rootBody(null))], config.page);
  assert.deepEqual(threads.map((t) => [t.kind, t.root.id, t.src]), [['issue', 5, ''], ['review', 7, 'content/a.dita:1:1']]);
});

test('reply requests and bodies', () => {
  const review = { kind: 'review', src: 'content/a.dita:12:1', root: mk(1, rootBody('content/a.dita:12:1')), replies: [] };
  assert.equal(w.buildReplyBody({ config, thread: review, comment: '  Fixed, thanks  ' }), 'Fixed, thanks');
  assert.deepEqual(w.replyRequestFor(review, config, 'B'), {
    method: 'POST', url: 'https://api.github.com/repos/owner/repo/pulls/7/comments/1/replies', payload: { body: 'B' } });

  const issue = { kind: 'issue', src: 'content/shared/reuse.dita:27:30', root: mk(10, rootBody('content/shared/reuse.dita:27:30')), replies: [] };
  const body = w.buildReplyBody({ config, thread: issue, comment: 'Will do' });
  assert.match(body, /^> @u10: Root text\n\nWill do\n/);
  assert.deepEqual(w.parseMarker(body), { page: config.page, src: 'content/shared/reuse.dita:27:30', reply_to: 10 });
  assert.equal(w.replyRequestFor(issue, config, 'B').url, 'https://api.github.com/repos/owner/repo/issues/7/comments');
});

test('splitComment separates the quoted content from the comment', () => {
  assert.deepEqual(w.splitComment(rootBody('content/a.dita:1:1')), { quote: 'Q', text: 'Root text' });
  assert.deepEqual(w.splitComment('Just text <b>x</b>'), { quote: '', text: 'Just text <b>x</b>' });
});
