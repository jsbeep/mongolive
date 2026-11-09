// 쿼리 입력창의 글자 → Canonical EJSON 쿼리. mongosh에서 쓰던 모양을 그대로 받는다:
//   { age: { $gt: 51 }, 'author.name': "kim", _id: ObjectId("64b7…"), at: ISODate("2024-01-01"), name: /^ki/i }
// eval을 쓰지 않는 작은 파서다 — 받는 것은 객체·배열·문자열·숫자·true/false/null·정규식 리터럴과
// 아래 도우미 함수뿐. 숫자 타입은 편집기와 같은 규칙(parseNumberInput: int32 → Int32, 큰 정수 → Long, 소수 → Double).
// 이미 Canonical인 입력({ "$oid": "…" })은 그냥 객체라 그대로 통과한다.
import { makeDate, makeDecimal, makeInt32, makeLong, makeOid, parseNumberInput, valueKind, type EjsonObject, type EjsonValue } from './ejson';

export interface QueryParseError {
  message: string;
  // 0부터 센 글자 위치와 사람이 읽는 줄·칸(1부터)
  offset: number;
  line: number;
  column: number;
}

export type QueryParseResult = { ok: true; filter: EjsonObject } | { ok: false; error: QueryParseError };

class ParseFail extends Error {
  constructor(message: string, public offset: number) {
    super(message);
  }
}

const IDENT_START = /[A-Za-z_$]/;
// 따옴표 없는 키는 점도 받는다(author.name) — JS 문법은 아니지만 쿼리에선 흔해서
const IDENT_PART = /[\w$.]/;

// 도우미 함수 — 이름 → (인자들) → 값. 앞의 `new`는 있어도 없어도 된다
const HELPERS: Record<string, (args: EjsonValue[], at: number) => EjsonValue> = {
  ObjectId: (args, at) => {
    const [hex] = args;
    if (typeof hex !== 'string' || !/^[0-9a-fA-F]{24}$/.test(hex)) throw new ParseFail('ObjectId needs a 24-character hex string', at);
    return makeOid(hex);
  },
  ISODate: (args, at) => dateHelper(args, at),
  Date: (args, at) => dateHelper(args, at),
  NumberInt: (args, at) => {
    const n = numberArg(args, at, 'NumberInt');
    if (!Number.isInteger(n) || n < -2147483648 || n > 2147483647) throw new ParseFail('NumberInt needs a 32-bit integer', at);
    return makeInt32(n);
  },
  NumberLong: (args, at) => {
    const [v] = args;
    const text = typeof v === 'string' ? v : numericText(v);
    if (text === undefined || !/^[+-]?\d+$/.test(text)) throw new ParseFail('NumberLong needs an integer', at);
    return makeLong(text);
  },
  NumberDecimal: (args, at) => {
    const [v] = args;
    const text = typeof v === 'string' ? v : numericText(v);
    if (text === undefined || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text.trim())) throw new ParseFail('NumberDecimal needs a number', at);
    return makeDecimal(text);
  },
};

const numericText = (v: EjsonValue | undefined): string | undefined => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const inner = v.$numberInt ?? v.$numberLong ?? v.$numberDouble;
    if (typeof inner === 'string') return inner;
  }
  return undefined;
};

const numberArg = (args: EjsonValue[], at: number, name: string): number => {
  const text = numericText(args[0]) ?? (typeof args[0] === 'string' ? args[0] : undefined);
  const n = text === undefined ? NaN : Number(text);
  if (Number.isNaN(n)) throw new ParseFail(`${name} needs a number`, at);
  return n;
};

const dateHelper = (args: EjsonValue[], at: number): EjsonValue => {
  // 인자 없으면 지금(mongosh와 같다)
  if (args.length === 0) return makeDate(Date.now());
  const [v] = args;
  const ms = typeof v === 'string' ? Date.parse(v) : Number(numericText(v));
  if (Number.isNaN(ms)) throw new ParseFail('Not a valid date — try ISODate("2024-01-31") or ISODate("2024-01-31T09:00:00Z")', at);
  return makeDate(ms);
};

class Parser {
  pos = 0;
  constructor(private text: string) {}

  fail(message: string, at = this.pos): never {
    throw new ParseFail(message, at);
  }

  skipSpace() {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) this.pos++;
  }

  peek(): string {
    this.skipSpace();
    return this.text[this.pos] ?? '';
  }

  expect(ch: string) {
    if (this.peek() !== ch) this.fail(this.pos >= this.text.length ? `Missing "${ch}"` : `Expected "${ch}" but found "${this.text[this.pos]}"`);
    this.pos++;
  }

  value(): EjsonValue {
    const ch = this.peek();
    if (ch === '{') return this.object();
    if (ch === '[') return this.array();
    if (ch === '"' || ch === "'") return this.string();
    if (ch === '/') return this.regex();
    if (ch === '-' || ch === '+' || ch === '.' || /\d/.test(ch)) return this.number();
    if (IDENT_START.test(ch)) return this.word();
    if (ch === '') this.fail('Unexpected end of query');
    return this.fail(`Unexpected "${ch}"`);
  }

  object(): EjsonObject {
    this.expect('{');
    const result: EjsonObject = {};
    while (this.peek() !== '}') {
      const keyAt = this.pos;
      const key = this.key();
      if (Object.prototype.hasOwnProperty.call(result, key)) this.fail(`Duplicate key "${key}"`, keyAt);
      this.expect(':');
      // 대입(result[key] = …) 대신 — 키가 "__proto__"여도 프로토타입이 아니라 그냥 필드가 되게
      Object.defineProperty(result, key, { value: this.value(), enumerable: true, writable: true, configurable: true });
      if (this.peek() === ',') this.pos++;
      else if (this.peek() !== '}') this.fail(this.pos >= this.text.length ? 'Missing "}"' : 'Expected "," or "}"');
    }
    this.pos++;
    return result;
  }

  array(): EjsonValue[] {
    this.expect('[');
    const result: EjsonValue[] = [];
    while (this.peek() !== ']') {
      result.push(this.value());
      if (this.peek() === ',') this.pos++;
      else if (this.peek() !== ']') this.fail(this.pos >= this.text.length ? 'Missing "]"' : 'Expected "," or "]"');
    }
    this.pos++;
    return result;
  }

  key(): string {
    const ch = this.peek();
    if (ch === '"' || ch === "'") return this.string();
    if (!IDENT_START.test(ch)) this.fail(ch ? `Expected a field name but found "${ch}"` : 'Missing "}"');
    const start = this.pos;
    while (this.pos < this.text.length && IDENT_PART.test(this.text[this.pos])) this.pos++;
    return this.text.slice(start, this.pos);
  }

  string(): string {
    const quote = this.text[this.pos];
    const start = this.pos;
    this.pos++;
    let out = '';
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (ch === quote) {
        this.pos++;
        return out;
      }
      if (ch === '\n') break;
      if (ch === '\\') {
        const next = this.text[this.pos + 1];
        const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '\\': '\\', '/': '/', '"': '"', "'": "'" };
        if (next in simple) {
          out += simple[next];
          this.pos += 2;
          continue;
        }
        if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(this.text.slice(this.pos + 2, this.pos + 6))) {
          out += String.fromCharCode(parseInt(this.text.slice(this.pos + 2, this.pos + 6), 16));
          this.pos += 6;
          continue;
        }
        this.fail(`Unknown escape "\\${next ?? ''}"`);
      }
      out += ch;
      this.pos++;
    }
    return this.fail('Unclosed string', start);
  }

  number(): EjsonValue {
    const start = this.pos;
    const match = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(this.text.slice(this.pos));
    if (!match) this.fail('Not a number');
    this.pos += match[0].length;
    const value = parseNumberInput(match[0].replace(/^\+/, ''));
    if (value === null) this.fail('Not a number', start);
    return value;
  }

  // /pattern/flags → { $regularExpression }. 패턴 안의 [...]에서는 /가 끝이 아니다
  regex(): EjsonValue {
    const start = this.pos;
    this.pos++;
    let pattern = '';
    let inClass = false;
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (ch === '\n') break;
      if (ch === '\\') {
        pattern += ch + (this.text[this.pos + 1] ?? '');
        this.pos += 2;
        continue;
      }
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) {
        this.pos++;
        const flags = /^[a-z]*/.exec(this.text.slice(this.pos))![0];
        if (/[^imsx]/.test(flags)) this.fail('Regex flags can only be i, m, s, x', this.pos);
        this.pos += flags.length;
        return { $regularExpression: { pattern, options: [...flags].sort().join('') } };
      }
      pattern += ch;
      this.pos++;
    }
    return this.fail('Unclosed regex', start);
  }

  // true/false/null 또는 도우미 함수(ObjectId(...), new Date(...))
  word(): EjsonValue {
    const start = this.pos;
    let name = this.identifier();
    if (name === 'new') {
      this.skipSpace();
      name = this.identifier();
    }
    if (name === 'true') return true;
    if (name === 'false') return false;
    if (name === 'null') return null;
    const helper = HELPERS[name];
    if (!helper) {
      return this.fail(`Unknown value "${name}" — strings need quotes; helpers: ${Object.keys(HELPERS).join(', ')}`, start);
    }
    this.expect('(');
    const args: EjsonValue[] = [];
    while (this.peek() !== ')') {
      args.push(this.value());
      if (this.peek() === ',') this.pos++;
      else if (this.peek() !== ')') this.fail('Expected "," or ")"');
    }
    this.pos++;
    return helper(args, start);
  }

  identifier(): string {
    const start = this.pos;
    if (!IDENT_START.test(this.text[this.pos] ?? '')) this.fail('Expected a name');
    while (this.pos < this.text.length && /[\w$]/.test(this.text[this.pos])) this.pos++;
    return this.text.slice(start, this.pos);
  }
}

const locate = (text: string, offset: number): { line: number; column: number } => {
  const before = text.slice(0, offset).split('\n');
  return { line: before.length, column: before[before.length - 1].length + 1 };
};

// 빈 입력 = 조건 없음({}) — 호출한 쪽이 '쿼리 해제'로 다룬다
export const parseQueryText = (text: string): QueryParseResult => {
  if (text.trim() === '') return { ok: true, filter: {} };
  const parser = new Parser(text);
  try {
    if (parser.peek() !== '{') parser.fail('A query starts with "{" — like { age: 51 }');
    const filter = parser.object();
    if (parser.peek() !== '') parser.fail('Unexpected text after the query');
    return { ok: true, filter };
  } catch (e) {
    if (e instanceof ParseFail) return { ok: false, error: { message: e.message, offset: e.offset, ...locate(text, e.offset) } };
    throw e;
  }
};

// aggregation 파이프라인 — 맨 바깥이 배열이고 원소는 스테이지 객체. 빈 입력 = 빈 파이프라인([])
export type PipelineParseResult = { ok: true; pipeline: EjsonObject[] } | { ok: false; error: QueryParseError };

export const parsePipelineText = (text: string): PipelineParseResult => {
  if (text.trim() === '') return { ok: true, pipeline: [] };
  const parser = new Parser(text);
  try {
    if (parser.peek() !== '[') parser.fail('A pipeline starts with "[" — like [{ $match: { … } }]');
    const start = parser.pos;
    const items = parser.array();
    // EJSON 래퍼({ $numberInt })도 객체라 valueKind로 '일반 객체'인지 본다
    const notObject = items.findIndex((item) => valueKind(item) !== 'object');
    if (notObject >= 0) parser.fail(`Stage ${notObject + 1} is not an object`, start);
    if (parser.peek() !== '') parser.fail('Unexpected text after the pipeline');
    return { ok: true, pipeline: items as EjsonObject[] };
  } catch (e) {
    if (e instanceof ParseFail) return { ok: false, error: { message: e.message, offset: e.offset, ...locate(text, e.offset) } };
    throw e;
  }
};

// 스테이지 하나({ $group: … }) — 스테이지 편집기의 입력. 키가 하나인지·허용된 스테이지인지는 validatePipelineStage가 본다
export type StageParseResult = { ok: true; stage: EjsonObject } | { ok: false; error: QueryParseError };

export const parseStageText = (text: string): StageParseResult => {
  const parser = new Parser(text);
  try {
    if (parser.peek() !== '{') parser.fail('A stage starts with "{" — like { $match: { … } }');
    const stage = parser.object();
    if (parser.peek() !== '') parser.fail('Unexpected text after the stage — one stage per card');
    return { ok: true, stage };
  } catch (e) {
    if (e instanceof ParseFail) return { ok: false, error: { message: e.message, offset: e.offset, ...locate(text, e.offset) } };
    throw e;
  }
};
