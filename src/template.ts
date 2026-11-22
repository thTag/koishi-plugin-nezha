/**
 * 极简 Jinja2 子集渲染器，只覆盖原 AstrBot 插件那 5 套模板用到的语法：
 * - {{ expr }}：路径、字符串/数字、比较、and/or/not、三元 (a if c else b)、过滤器
 * - {% if %} / {% elif %} / {% else %} / {% endif %}
 * - {% for x in list %} / {% endfor %}
 * - {% set x = expr %}
 * - 过滤器：default(v)、length、format(...)（Python % 格式化）、upper、lower
 * 这样模板可以原样沿用，不用改写 HTML。
 */

export type TemplateData = Record<string, any>

type Tok = { kind: 'text' | 'out' | 'tag'; src: string }

type Node =
  | { type: 'text'; value: string }
  | { type: 'out'; expr: string }
  | { type: 'set'; name: string; expr: string }
  | { type: 'if'; branches: { cond: string | null; body: Node[] }[] }
  | { type: 'for'; name: string; iter: string; body: Node[] }

const TAG_RE = /\{\{([\s\S]*?)\}\}|\{%([\s\S]*?)%\}/g

function tokenize(tpl: string): Tok[] {
  const out: Tok[] = []
  let last = 0
  TAG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TAG_RE.exec(tpl))) {
    if (m.index > last) out.push({ kind: 'text', src: tpl.slice(last, m.index) })
    if (m[1] !== undefined) out.push({ kind: 'out', src: m[1].trim() })
    else out.push({ kind: 'tag', src: (m[2] || '').trim() })
    last = m.index + m[0].length
  }
  if (last < tpl.length) out.push({ kind: 'text', src: tpl.slice(last) })
  return out
}

function head(tag: string) {
  return tag.split(/\s+/)[0] || ''
}

function parseBody(toks: Tok[], pos: { i: number }, stops: Set<string>): Node[] {
  const nodes: Node[] = []
  while (pos.i < toks.length) {
    const t = toks[pos.i]
    if (t.kind === 'text') {
      nodes.push({ type: 'text', value: t.src })
      pos.i++
      continue
    }
    if (t.kind === 'out') {
      nodes.push({ type: 'out', expr: t.src })
      pos.i++
      continue
    }
    const kw = head(t.src)
    if (stops.has(kw)) break
    if (kw === 'if') {
      nodes.push(parseIf(toks, pos))
      continue
    }
    if (kw === 'for') {
      nodes.push(parseFor(toks, pos))
      continue
    }
    if (kw === 'set') {
      const m = /^set\s+([A-Za-z_][\w]*)\s*=\s*([\s\S]+)$/.exec(t.src)
      if (m) nodes.push({ type: 'set', name: m[1], expr: m[2].trim() })
      pos.i++
      continue
    }
    // 未知标签直接忽略，避免渲染炸掉
    pos.i++
  }
  return nodes
}

function parseIf(toks: Tok[], pos: { i: number }): Node {
  const tag = toks[pos.i].src
  pos.i++
  const branches: { cond: string | null; body: Node[] }[] = []
  let cond: string | null = tag.slice(2).trim()
  for (;;) {
    const body = parseBody(toks, pos, new Set(['elif', 'else', 'endif']))
    branches.push({ cond, body })
    const stop = toks[pos.i]
    if (!stop || stop.kind !== 'tag') break
    const kw = head(stop.src)
    if (kw === 'elif') {
      cond = stop.src.slice(4).trim()
      pos.i++
      continue
    }
    if (kw === 'else') {
      pos.i++
      const elseBody = parseBody(toks, pos, new Set(['endif']))
      branches.push({ cond: null, body: elseBody })
      if (toks[pos.i]) pos.i++
      break
    }
    if (kw === 'endif') pos.i++
    break
  }
  return { type: 'if', branches }
}

function parseFor(toks: Tok[], pos: { i: number }): Node {
  const tag = toks[pos.i].src
  pos.i++
  const m = /^for\s+([A-Za-z_][\w]*)\s+in\s+([\s\S]+)$/.exec(tag)
  const body = parseBody(toks, pos, new Set(['endfor']))
  if (toks[pos.i]) pos.i++
  return { type: 'for', name: m ? m[1] : '_', iter: m ? m[2].trim() : '', body }
}

type ETok = { t: 'num' | 'str' | 'ident' | 'op'; v: string }

const EXPR_RE = /\s*(?:(\d+(?:\.\d+)?)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|([A-Za-z_][\w]*)|(==|!=|>=|<=|[><|(),.]))/g

function lexExpr(src: string): ETok[] {
  const out: ETok[] = []
  EXPR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = EXPR_RE.exec(src))) {
    if (m[1] !== undefined) out.push({ t: 'num', v: m[1] })
    else if (m[2] !== undefined) out.push({ t: 'str', v: m[2] })
    else if (m[3] !== undefined) out.push({ t: 'ident', v: m[3] })
    else out.push({ t: 'op', v: m[4] })
    if (m[0].length === 0) EXPR_RE.lastIndex++
  }
  return out
}

function unquote(raw: string) {
  return raw.slice(1, -1).replace(/\\(['"\\])/g, '$1')
}

function truthy(v: any): boolean {
  if (v === undefined || v === null || v === false) return false
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v)
  if (typeof v === 'string') return v.length > 0
  if (Array.isArray(v)) return v.length > 0
  return true
}

function stringify(v: any): string {
  if (v === undefined || v === null) return ''
  if (v === true) return 'True'
  if (v === false) return 'False'
  return String(v)
}

function looseEq(a: any, b: any) {
  if (a === b) return true
  if (a === undefined || a === null || b === undefined || b === null) return false
  return String(a) === String(b)
}

function compareValues(a: any, op: string, b: any): boolean {
  if (op === '==') return looseEq(a, b)
  if (op === '!=') return !looseEq(a, b)
  const na = Number(a)
  const nb = Number(b)
  const numeric = a !== null && a !== undefined && b !== null && b !== undefined
    && a !== '' && b !== '' && !Number.isNaN(na) && !Number.isNaN(nb)
  const x: any = numeric ? na : String(a ?? '')
  const y: any = numeric ? nb : String(b ?? '')
  switch (op) {
    case '>': return x > y
    case '<': return x < y
    case '>=': return x >= y
    case '<=': return x <= y
  }
  return false
}

/** Python 的 % 格式化，只支持模板里出现的写法 */
export function pyFormat(fmt: string, args: any[]) {
  let i = 0
  return String(fmt).replace(/%(-?\d+)?(?:\.(\d+))?([dfs%])/g, (_all, width: string, prec: string, type: string) => {
    if (type === '%') return '%'
    const v = args[i++]
    let s: string
    if (type === 'd') s = String(Math.trunc(Number(v) || 0))
    else if (type === 'f') s = (Number(v) || 0).toFixed(prec ? Number(prec) : 6)
    else s = stringify(v)
    if (width) s = s.padStart(Number(width), ' ')
    return s
  })
}

function applyFilter(name: string, value: any, args: any[]) {
  switch (name) {
    case 'default':
      return truthy(value) ? value : (args.length ? args[0] : '')
    case 'length':
      return value == null ? 0 : (Array.isArray(value) ? value.length : String(value).length)
    case 'format':
      return pyFormat(stringify(value), args)
    case 'upper':
      return stringify(value).toUpperCase()
    case 'lower':
      return stringify(value).toLowerCase()
    case 'round':
      return Math.round(Number(value) || 0)
    default:
      return value
  }
}

class ExprParser {
  private i = 0
  constructor(private toks: ETok[], private scope: any) {}

  parse(): any {
    return this.ternary()
  }

  private peek() {
    return this.toks[this.i]
  }

  private next() {
    return this.toks[this.i++]
  }

  private isOp(v: string) {
    const t = this.peek()
    return !!t && t.t === 'op' && t.v === v
  }

  private isKw(v: string) {
    const t = this.peek()
    return !!t && t.t === 'ident' && t.v === v
  }

  private ternary(): any {
    const value = this.or()
    if (this.isKw('if')) {
      this.next()
      const cond = this.or()
      if (this.isKw('else')) this.next()
      const other = this.ternary()
      return truthy(cond) ? value : other
    }
    return value
  }

  private or(): any {
    let v = this.and()
    while (this.isKw('or')) {
      this.next()
      const r = this.and()
      v = truthy(v) || truthy(r)
    }
    return v
  }

  private and(): any {
    let v = this.not()
    while (this.isKw('and')) {
      this.next()
      const r = this.not()
      v = truthy(v) && truthy(r)
    }
    return v
  }

  private not(): any {
    if (this.isKw('not')) {
      this.next()
      return !truthy(this.not())
    }
    return this.compare()
  }

  private compare(): any {
    let left = this.filter()
    for (;;) {
      const t = this.peek()
      if (!t || t.t !== 'op' || !['==', '!=', '>=', '<=', '>', '<'].includes(t.v)) break
      this.next()
      left = compareValues(left, t.v, this.filter())
    }
    return left
  }

  private filter(): any {
    let v = this.primary()
    while (this.isOp('|')) {
      this.next()
      const nameTok = this.next()
      const name = nameTok ? nameTok.v : ''
      const args: any[] = []
      if (this.isOp('(')) {
        this.next()
        if (!this.isOp(')')) {
          args.push(this.ternary())
          while (this.isOp(',')) {
            this.next()
            args.push(this.ternary())
          }
        }
        if (this.isOp(')')) this.next()
      }
      v = applyFilter(name, v, args)
    }
    return v
  }

  private primary(): any {
    const t = this.next()
    if (!t) return undefined
    if (t.t === 'num') return Number(t.v)
    if (t.t === 'str') return unquote(t.v)
    if (t.t === 'op' && t.v === '(') {
      const v = this.ternary()
      if (this.isOp(')')) this.next()
      return v
    }
    if (t.t === 'ident') {
      if (t.v === 'true' || t.v === 'True') return true
      if (t.v === 'false' || t.v === 'False') return false
      if (t.v === 'none' || t.v === 'None') return undefined
      let v = this.scope[t.v]
      while (this.isOp('.')) {
        this.next()
        const prop = this.next()
        if (!prop) break
        v = v == null ? undefined : v[prop.v]
      }
      return v
    }
    return undefined
  }
}

export function evalExpr(src: string, scope: any): any {
  try {
    return new ExprParser(lexExpr(src), scope).parse()
  } catch {
    return undefined
  }
}

function execNodes(nodes: Node[], scope: any, out: string[]) {
  for (const node of nodes) {
    if (node.type === 'text') {
      out.push(node.value)
    } else if (node.type === 'out') {
      out.push(stringify(evalExpr(node.expr, scope)))
    } else if (node.type === 'set') {
      scope[node.name] = evalExpr(node.expr, scope)
    } else if (node.type === 'if') {
      for (const branch of node.branches) {
        if (branch.cond === null || truthy(evalExpr(branch.cond, scope))) {
          execNodes(branch.body, scope, out)
          break
        }
      }
    } else if (node.type === 'for') {
      const list = evalExpr(node.iter, scope)
      const items = Array.isArray(list) ? list : []
      for (const item of items) {
        const child = Object.create(scope)
        child[node.name] = item
        execNodes(node.body, child, out)
      }
    }
  }
}

export function renderTemplate(tpl: string, data: TemplateData): string {
  const toks = tokenize(tpl)
  const nodes = parseBody(toks, { i: 0 }, new Set())
  const out: string[] = []
  execNodes(nodes, Object.assign(Object.create(null), data), out)
  return out.join('')
}
