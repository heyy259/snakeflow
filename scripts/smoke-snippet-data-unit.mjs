// 选区浮条候选（bubbleSnippetGroups）回归：纯 Node，无 DOM / 编辑器依赖。
// 口径：内置只收可作用于选区的 wrap/prefix（分割线等 insert 不进浮条）；
//       用户片段全量可见（insert 在非空选区上按"替换"应用），hidden 一律剔除。
// 运行：node scripts/smoke-snippet-data-unit.mjs（全过退出码 0）。

import assert from 'node:assert/strict';
import {
  bubbleSnippetGroups,
  normalizeSnippets,
  snippetType,
} from '../src/editor/snippetData.js';

// 直接测过滤函数本身（不经 normalizeSnippets，避免补齐内置干扰断言）。
const snippets = [
  { group: 'builtin', name: '加粗', text: '**{sel}**' },
  { group: 'builtin', name: '标题1', text: '# {sel}' },
  { group: 'builtin', name: '分割线', text: '---' },
  { group: 'user', name: '后台交互', text: '"$keep_stdin":true' },
  { group: 'user', name: '引用', text: '> {sel}' },
  { group: 'user', name: '仅标题字', text: '{sel:2}' },
  { group: 'user', name: '隐藏项', text: 'X', hidden: true },
  { name: '缺省分组', text: 'plain' },
];

const groups = bubbleSnippetGroups(snippets);
const names = (arr) => arr.map((x) => x.s.name);

// 内置：wrap + prefix 保留，insert（分割线）继续被策展掉。
assert.deepEqual(names(groups.builtin), ['加粗', '标题1']);
assert.ok(!names(groups.builtin).includes('分割线'));

// 用户：insert / prefix / wrap 全部可见，保持原顺序；hidden 剔除；缺省 group 归 user。
assert.deepEqual(names(groups.user), ['后台交互', '引用', '仅标题字', '缺省分组']);
assert.equal(snippetType(groups.user[0].s.text), 'insert');
assert.equal(snippetType(groups.user[1].s.text), 'prefix');
assert.equal(snippetType(groups.user[2].s.text), 'wrap');

// 索引必须指回原数组（SelBubble 的「⋯」菜单与 onApply 依赖它）。
for (const item of [...groups.builtin, ...groups.user]) {
  assert.equal(snippets[item.i], item.s);
  assert.ok(!item.s.hidden);
}

// 归一化后的真实内置集合：insert 的「分割线」仍被策展掉，其余内置均可作用于选区。
const normalized = normalizeSnippets(null);
const builtinOnly = bubbleSnippetGroups(normalized);
assert.ok(!names(builtinOnly.builtin).includes('分割线'));
assert.ok(
  builtinOnly.builtin.every((x) => {
    const ty = snippetType(x.s.text);
    return ty === 'wrap' || ty === 'prefix';
  })
);

// 空输入。
assert.deepEqual(bubbleSnippetGroups(null), { builtin: [], user: [] });
assert.deepEqual(bubbleSnippetGroups(undefined), { builtin: [], user: [] });

console.log('smoke-snippet-data-unit: OK');
