/**
 * 极简表达式求值器。
 *
 * 目标：能解析 ModelEntry.soft_labels.avoid_patterns[*].condition_expr，
 *      也用于 Layer 3 中其它简单条件断言。
 *
 * 语法（手写递归下降）：
 *   Or       := And ('OR' And)*
 *   And      := Compare ('AND' Compare)*
 *   Compare  := Unary OP Unary | Unary
 *   Unary    := '(' Or ')' | Literal | Ident
 *   OP       := == != > < >= <=
 *   Literal  := 'string' | "string" | number | true | false | null
 *   Ident    := [A-Za-z_][A-Za-z0-9_.]*
 *
 * 标识符按点路径在 ctx 上查找。例：
 *   task_type == 'long_writing' AND analyzed.estimated_output_tokens > 6000
 *
 * 求值返回 boolean；任意非布尔结果或解析错误都视为 false（保守、不抛）。
 * 调用方可设 strict: true 让错误抛出（便于单测/调试）。
 */

export type ExprValue = string | number | boolean | null | undefined;
export type ExprContext = Record<string, unknown>;

interface Token {
  type: "ident" | "string" | "number" | "op" | "kw" | "lparen" | "rparen";
  value: string;
}

const KEYWORDS = new Set(["AND", "OR", "true", "false", "null"]);
const OPS = ["==", "!=", ">=", "<=", ">", "<"] as const;
type Op = (typeof OPS)[number];

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "(") {
      tokens.push({ type: "lparen", value: "(" });
      i++;
      continue;
    }
    if (c === ")") {
      tokens.push({ type: "rparen", value: ")" });
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      let buf = "";
      while (j < src.length && src[j] !== quote) {
        if (src[j] === "\\" && j + 1 < src.length) {
          buf += src[j + 1];
          j += 2;
        } else {
          buf += src[j];
          j++;
        }
      }
      if (j >= src.length) throw new Error("Unterminated string literal");
      tokens.push({ type: "string", value: buf });
      i = j + 1;
      continue;
    }
    // number
    if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < src.length && /[0-9.]/.test(src[j]!)) j++;
      tokens.push({ type: "number", value: src.slice(i, j) });
      i = j;
      continue;
    }
    // operators
    let matched = false;
    for (const op of OPS) {
      if (src.startsWith(op, i)) {
        tokens.push({ type: "op", value: op });
        i += op.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    // identifier or keyword
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_.]/.test(src[j]!)) j++;
      const word = src.slice(i, j);
      if (KEYWORDS.has(word)) {
        tokens.push({ type: "kw", value: word });
      } else {
        tokens.push({ type: "ident", value: word });
      }
      i = j;
      continue;
    }
    throw new Error(`Unexpected character '${c}' at position ${i}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private toks: Token[]) {}

  private peek(): Token | undefined {
    return this.toks[this.pos];
  }
  private take(): Token | undefined {
    return this.toks[this.pos++];
  }
  private expect(pred: (t: Token) => boolean, msg: string): Token {
    const t = this.take();
    if (!t || !pred(t)) throw new Error(msg);
    return t;
  }

  parse(): AstNode {
    const node = this.parseOr();
    if (this.pos < this.toks.length) {
      throw new Error(`Unexpected trailing token: ${this.peek()?.value}`);
    }
    return node;
  }

  private parseOr(): AstNode {
    let left = this.parseAnd();
    while (this.peek()?.type === "kw" && this.peek()?.value === "OR") {
      this.take();
      const right = this.parseAnd();
      left = { kind: "or", left, right };
    }
    return left;
  }

  private parseAnd(): AstNode {
    let left = this.parseCompare();
    while (this.peek()?.type === "kw" && this.peek()?.value === "AND") {
      this.take();
      const right = this.parseCompare();
      left = { kind: "and", left, right };
    }
    return left;
  }

  private parseCompare(): AstNode {
    const left = this.parseAtom();
    if (this.peek()?.type === "op") {
      const op = this.take()!.value as Op;
      const right = this.parseAtom();
      return { kind: "cmp", op, left, right };
    }
    return left;
  }

  private parseAtom(): AstNode {
    const t = this.peek();
    if (!t) throw new Error("Unexpected end of expression");
    if (t.type === "lparen") {
      this.take();
      const node = this.parseOr();
      this.expect((x) => x.type === "rparen", "Expected ')'");
      return node;
    }
    if (t.type === "string") {
      this.take();
      return { kind: "lit", value: t.value };
    }
    if (t.type === "number") {
      this.take();
      return { kind: "lit", value: Number(t.value) };
    }
    if (t.type === "kw") {
      this.take();
      if (t.value === "true") return { kind: "lit", value: true };
      if (t.value === "false") return { kind: "lit", value: false };
      if (t.value === "null") return { kind: "lit", value: null };
    }
    if (t.type === "ident") {
      this.take();
      return { kind: "ident", path: t.value };
    }
    throw new Error(`Unexpected token: ${t.value}`);
  }
}

type AstNode =
  | { kind: "and"; left: AstNode; right: AstNode }
  | { kind: "or"; left: AstNode; right: AstNode }
  | { kind: "cmp"; op: Op; left: AstNode; right: AstNode }
  | { kind: "lit"; value: ExprValue }
  | { kind: "ident"; path: string };

function lookup(ctx: ExprContext, path: string): ExprValue {
  const parts = path.split(".");
  let cur: unknown = ctx;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  if (cur === undefined) return undefined;
  if (cur === null) return null;
  if (typeof cur === "string" || typeof cur === "number" || typeof cur === "boolean") return cur;
  return undefined;
}

function evalNode(node: AstNode, ctx: ExprContext): ExprValue {
  switch (node.kind) {
    case "lit":
      return node.value;
    case "ident":
      return lookup(ctx, node.path);
    case "and": {
      const l = evalNode(node.left, ctx);
      if (!l) return false;
      return Boolean(evalNode(node.right, ctx));
    }
    case "or": {
      const l = evalNode(node.left, ctx);
      if (l) return true;
      return Boolean(evalNode(node.right, ctx));
    }
    case "cmp": {
      const l = evalNode(node.left, ctx);
      const r = evalNode(node.right, ctx);
      return compare(node.op, l, r);
    }
  }
}

function compare(op: Op, l: ExprValue, r: ExprValue): boolean {
  // 严格相等：类型不同 == 视为 false
  if (op === "==") return l === r;
  if (op === "!=") return l !== r;
  // 数值比较：双方都需 number
  if (typeof l !== "number" || typeof r !== "number") return false;
  switch (op) {
    case ">":
      return l > r;
    case "<":
      return l < r;
    case ">=":
      return l >= r;
    case "<=":
      return l <= r;
  }
}

/**
 * 求值入口。strict=false 时遇错返回 false；strict=true 时抛错。
 */
export function evaluate(expr: string, ctx: ExprContext, strict = false): boolean {
  try {
    const toks = tokenize(expr);
    const ast = new Parser(toks).parse();
    return Boolean(evalNode(ast, ctx));
  } catch (e) {
    if (strict) throw e;
    return false;
  }
}
