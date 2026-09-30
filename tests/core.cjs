'use strict';
const assert = require('node:assert/strict');
const core = require('../chatgpt-export.user.js');
const id = 'test-conversation';
const msg = (id, role, text, extra = {}) => ({ id, author: { role }, content: { content_type: 'text', parts: [text] }, ...extra });
const node = (id, parent, message) => ({ id, parent, message });
const reject = async (base, pattern, fetch = async () => { throw Error('Unexpected page request'); }) =>
  assert.rejects(core.loadHistory(base, id, fetch), pattern);

(async () => {
  let checks = 0;
  const mapping = {
    root: node('root', null, null),
    system: node('system', 'root', msg('system', 'system', 'INTERNAL_SYSTEM')),
    user: node('user', 'system', msg('user', 'user', 'Hello 🌍')),
    other: node('other', 'user', msg('other', 'assistant', 'WRONG_BRANCH')),
    think: node('think', 'user', msg('think', 'assistant', '', { channel: 'analysis', content: { content_type: 'thoughts', thoughts: [{ summary: 'Plan', content: 'REASONING_SECRET' }] } })),
    call: node('call', 'think', msg('call', 'assistant', 'TOOL_CALL', { recipient: 'python', channel: 'analysis', content: { content_type: 'code', text: 'print("TOOL_CALL")' } })),
    tool: node('tool', 'call', msg('tool', 'tool', 'TOOL_RESULT', { author: { role: 'tool', name: 'python' } })),
    final: node('final', 'tool', msg('final', 'assistant', '# Answer\n\n**Bold** and `code`.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```html\n<script>evil()</script>\n```', { metadata: { reasoning_recap: 'METADATA_SECRET', accessToken: 'TOKEN_SECRET', content_references: [{ url: 'https://example.com/' }] } }))
  };
  const base = { conversation_id: id, title: '<script>alert(1)</script>', current_node: 'final', mapping };
  const history = await core.loadHistory(base, id, async () => assert.fail('No pages needed'));
  assert.deepEqual(history.selected.map(record => record.id), ['root', 'system', 'user', 'think', 'call', 'tool', 'final']); checks++;
  const normal = core.exportData(history, id, 'Fallback', false, 'https://chatgpt.com/c/test-conversation');
  assert.deepEqual(normal.messages.map(message => message.id), ['user', 'final']);
  const plain = JSON.stringify(normal);
  for (const secret of ['INTERNAL_SYSTEM', 'WRONG_BRANCH', 'REASONING_SECRET', 'TOOL_CALL', 'TOOL_RESULT', 'METADATA_SECRET', 'TOKEN_SECRET']) assert(!plain.includes(secret)); checks++;
  const full = core.exportData(history, id, '', true, 'https://chatgpt.com/c/test-conversation');
  assert.equal(full.messages.length, 5);
  assert.deepEqual(full.messages.map(message => message.kind), ['message', 'reasoning', 'tool', 'tool', 'message']); checks++;
  const html = core.htmlDocument(full);
  assert(!html.includes('<script>'));
  assert(html.includes('&lt;script&gt;evil()&lt;/script&gt;'));
  assert(html.includes('<table>'));
  assert(!core.markdown('[bad](javascript:alert(1))').includes('href='));
  assert(!core.markdown('<img src=x onerror=alert(1)>').includes('<img'));
  checks++;

  const total = 12000;
  const longMap = { root: node('root', null, null) };
  for (let i = 0; i < total; i++) longMap[`m${i}`] = node(`m${i}`, i ? `m${i - 1}` : 'root', msg(`m${i}`, i % 2 ? 'assistant' : 'user', `Message ${i}`));
  const long = await core.loadHistory({ conversation_id: id, current_node: `m${total - 1}`, mapping: longMap }, id, async () => assert.fail('No pages needed'));
  assert.equal(core.exportData(long, id, 'Long chat', false, '').messages.length, total); checks++;

  const flat = index => ({ ...msg(`p${index}`, index % 2 ? 'assistant' : 'user', `Page message ${index}`) });
  let calls = 0;
  const pages = 75;
  const pagedBase = { conversation_id: id, current_node: 'p74', messages: [flat(74)], page_info: { has_previous_page: true, start_cursor: '73', has_next_page: false } };
  const paged = await core.loadHistory(pagedBase, id, async (direction, cursor) => {
    assert.equal(direction, 'before');
    const i = Number(cursor); calls++;
    return { messages: [flat(i)], page_info: { has_previous_page: i > 0, start_cursor: i > 0 ? String(i - 1) : null } };
  });
  assert.equal(calls, pages - 1); assert.equal(paged.pageCount, pages);
  assert.equal(paged.selected.length, pages); assert.equal(paged.selected[0].id, 'p0'); assert.equal(paged.selected.at(-1).id, 'p74'); checks++;

  const linked = { conversation_id: id, current_node: 'p2', messages: [{ ...flat(2), parent: 'p1' }], page_info: { has_previous_page: true, start_cursor: 'first' } };
  const linkedHistory = await core.loadHistory(linked, id, async () => ({ messages: [{ ...flat(0), parent: null }, { ...flat(1), parent: 'p0' }], page_info: { has_previous_page: false } }));
  assert.deepEqual(linkedHistory.selected.map(record => record.id), ['p0', 'p1', 'p2']); checks++;
  await reject({ ...base, current_node: 'absent' }, /missing/); checks++;
  await reject({ ...base, mapping: { final: node('final', 'missing-parent', msg('final', 'assistant', 'answer')) } }, /older message is missing/); checks++;
  await reject({ ...base, mapping: { final: node('final', 'final', msg('final', 'assistant', 'answer')) } }, /parent cycle/); checks++;
  await reject({ ...base, conversation_id: 'different-chat' }, /different conversation/); checks++;
  await reject({ ...pagedBase, page_info: { has_previous_page: true } }, /no cursor/); checks++;
  await reject(pagedBase, /repeated.*cursor/, async () => ({ messages: [flat(73)], page_info: { has_previous_page: true, start_cursor: '73' } })); checks++;
  await reject(pagedBase, /did not report/, async () => ({ messages: [flat(73)] })); checks++;
  await reject({ ...pagedBase, page_info: undefined }, /did not report/); checks++;
  await reject({ ...base, is_truncated: true }, /truncated/); checks++;
  await reject({ ...base, mapping: { final: node('final', null, msg('final', 'assistant', 'answer', { status: 'in_progress' })) } }, /still being generated/); checks++;
  assert(!core.filename('CON', id, 'json').startsWith('CON')); assert(!core.filename('A/B:*?', id, 'html').includes('/')); checks++;
  assert.deepEqual(core.exportData({ ...history, selected: [{ id: 'mixed', message: msg('mixed', 'assistant', '', { content: { content_type: 'multimodal_text', parts: ['Answer', { content_type: 'reasoning', text: 'REMOVE_ME' }, { content_type: 'image_asset_pointer', asset_pointer: 'file-service://image' }], tool_calls: ['REMOVE_ME'] } }) }] }, id, '', false, '').messages[0].content.parts.length, 2); checks++;
  console.log(`PASS: ${checks} core checks, including 12,000 messages, 75 pages, branch filtering, toggle privacy, incomplete-history rejection, and escaped HTML.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
