#!/usr/bin/env node
/**
 * 打印 workspace-assistant preset 的工具面清单。
 *
 * 为什么要这个脚本：preset 的工具行只写在 cordis.patch.yml 里，运行中的 /health 拿不到
 * preset 的 plugins（roseter/resolve 都不透出），所以「工具面到底有哪些」需要一个能从源码
 * 直接读出来的口径。F11 之后工具面的验收就是跑这个脚本。
 *
 * 用法：node scripts/preset-tools.mjs   （或 npm run tools）
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const yaml = readFileSync(join(here, '..', 'cordis.patch.yml'), 'utf8')
const lines = yaml.split(/\r?\n/)

const rows = []
for (let i = 0; i < lines.length; i += 1) {
  const m = /^ {10}- id: (\S+)\s*$/.exec(lines[i])
  if (m === null) continue
  const id = m[1]
  let name = ''
  let disabled = ''
  for (let j = i + 1; j < lines.length; j += 1) {
    if (/^ {10}- id: /.test(lines[j])) break
    const nm = /^ {12}name: '?([^'\n]+)'?\s*$/.exec(lines[j])
    if (nm !== null && name === '') name = nm[1]
    const dm = /^ {12}disabled: (.+)$/.exec(lines[j])
    if (dm !== null) disabled = dm[1].trim()
  }
  rows.push({ id, name, disabled })
}

const groups = rows.filter((r) => r.name === 'cordis:group')
const tools = rows.filter((r) => r.name !== 'cordis:group')
console.log(`workspace-assistant preset：${rows.length} 行（${groups.length} 个 group，${tools.length} 项），来源 cordis.patch.yml\n`)
for (const r of tools) {
  const note = r.disabled === '' ? '' : `  [disabled: ${r.disabled}]`
  console.log(`- ${r.id.padEnd(22)} ${r.name}${note}`)
}
for (const g of groups) console.log(`- ${g.id.padEnd(22)} (group)`)
