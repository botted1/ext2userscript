// A JavaScript scanner just deep enough for the analyzer (spec §3.4) and the asset collector (§3.6). It skips comments,
// string and template text and regular expressions, then reads three things from what's left: member chains rooted at
// chrome or browser, the string-literal arguments of getURL(...), and whether the code uses dynamic import().
// Ceilings: aliasing (const c = chrome) and computed access (chrome["tabs"]) are missed, and a regular expression
// right after `)` or `}` is read as a division.

export type ScanResult = {
  /** Chains such as "chrome.tabs.query", in source order. browser.* is reported as chrome.*. */
  chains: string[];
  /** String literals passed to runtime.getURL or extension.getURL, as written. */
  urls: string[];
  dynamicImport: boolean;
};

type Token = { kind: "name" | "punct" | "string" | "template" | "regex"; value: string };

const NAME_CHAR = /[\w$\u0080-￿]/;
/** Keywords after which a `/` starts a regular expression rather than a division. */
const BEFORE_EXPRESSION = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
/** `window.chrome` and friends are the global chrome; `foo.chrome` is someone else's property. */
const GLOBAL_OWNERS = new Set(["window", "globalThis", "self"]);

export function scan(code: string): ScanResult {
  const tokens = tokenize(code);
  const result: ScanResult = { chains: [], urls: [], dynamicImport: false };
  const isDot = (token: Token | undefined) => token?.kind === "punct" && (token.value === "." || token.value === "?.");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== "name") continue;
    if (token.value === "import" && tokens[i + 1]?.value === "(" && !isDot(tokens[i - 1])) result.dynamicImport = true;
    if (token.value === "getURL" && isDot(tokens[i - 1]) && tokens[i + 1]?.value === "(" && tokens[i + 2]?.kind === "string") {
      const after = tokens[i + 3]?.value;
      if (after === ")" || after === ",") result.urls.push(tokens[i + 2].value);
    }
    if (token.value !== "chrome" && token.value !== "browser") continue;
    if (isDot(tokens[i - 1]) && !(tokens[i - 2]?.kind === "name" && GLOBAL_OWNERS.has(tokens[i - 2].value))) continue;
    const parts = ["chrome"];
    let j = i + 1;
    while (isDot(tokens[j]) && tokens[j + 1]?.kind === "name") {
      parts.push(tokens[j + 1].value);
      j += 2;
    }
    if (parts.length > 1) result.chains.push(parts.join("."));
  }
  return result;
}

function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  /** For each open `${`, the brace depth its closing `}` returns to. */
  const substitutions: number[] = [];
  let braces = 0;
  let i = 0;

  const regexAllowed = () => {
    const last = tokens[tokens.length - 1];
    if (!last) return true;
    if (last.kind === "name") return BEFORE_EXPRESSION.has(last.value);
    if (last.kind === "punct") return !(last.value === ")" || last.value === "]" || last.value === "}");
    return false;
  };

  /** Reads template text from `start` up to its closing backtick or the next `${`. */
  const templatePart = (start: number) => {
    let text = "";
    let j = start;
    while (j < code.length) {
      const char = code[j];
      if (char === "\\") {
        text += code[j + 1] ?? "";
        j += 2;
      } else if (char === "`") {
        return { text, end: j + 1, open: false };
      } else if (char === "$" && code[j + 1] === "{") {
        return { text, end: j + 2, open: true };
      } else {
        text += char;
        j++;
      }
    }
    return { text, end: j, open: false };
  };

  const template = (start: number, first: boolean) => {
    const part = templatePart(start);
    if (part.open) {
      substitutions.push(braces);
      braces++;
      tokens.push({ kind: "punct", value: "${" });
    } else {
      // A template without substitutions is a plain string; the end of one with substitutions is just "a value".
      tokens.push(first ? { kind: "string", value: part.text } : { kind: "template", value: "" });
    }
    return part.end;
  };

  while (i < code.length) {
    const char = code[i];
    const next = code[i + 1];
    if (char === "/" && next === "/") {
      const end = code.indexOf("\n", i);
      i = end === -1 ? code.length : end;
    } else if (char === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end === -1 ? code.length : end + 2;
    } else if (char === '"' || char === "'") {
      let value = "";
      let j = i + 1;
      while (j < code.length && code[j] !== char && code[j] !== "\n") {
        if (code[j] === "\\") {
          value += code[j + 1] ?? "";
          j += 2;
        } else {
          value += code[j];
          j++;
        }
      }
      tokens.push({ kind: "string", value });
      i = j + 1;
    } else if (char === "`") {
      i = template(i + 1, true);
    } else if (char === "}" && substitutions.length > 0 && substitutions[substitutions.length - 1] === braces - 1) {
      substitutions.pop();
      braces--;
      i = template(i + 1, false);
    } else if (char === "/" && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < code.length && code[j] !== "\n") {
        const c = code[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (inClass) {
          if (c === "]") inClass = false;
        } else if (c === "[") {
          inClass = true;
        } else if (c === "/") {
          j++;
          while (j < code.length && NAME_CHAR.test(code[j])) j++;
          break;
        }
        j++;
      }
      tokens.push({ kind: "regex", value: "" });
      i = j;
    } else if (NAME_CHAR.test(char)) {
      let j = i + 1;
      while (j < code.length && NAME_CHAR.test(code[j])) j++;
      tokens.push({ kind: "name", value: code.slice(i, j) });
      i = j;
    } else if (char === "?" && next === "." && !/\d/.test(code[i + 2] ?? "")) {
      tokens.push({ kind: "punct", value: "?." });
      i += 2;
    } else if (/\s/.test(char)) {
      i++;
    } else {
      if (char === "{") braces++;
      else if (char === "}") braces--;
      tokens.push({ kind: "punct", value: char });
      i++;
    }
  }
  return tokens;
}
