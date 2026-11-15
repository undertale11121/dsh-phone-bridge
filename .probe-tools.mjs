import { desktopTools } from './src/desktop.mjs'

const list = desktopTools(null)
console.log('工具数', list.length)
console.log('名字', list.map((x) => x.name).join(','))
console.log('都有 schema:', list.every((x) => x.inputSchema && x.name && x.description))
console.log('第一个:', JSON.stringify(list[0]))