import type { Key } from "ink";

const SPECIAL: ReadonlyArray<[(k: Key) => boolean, string]> = [
  [(k) => k.escape,     "escape"],
  [(k) => k.return,     "return"],
  [(k) => k.backspace,  "backspace"],
  [(k) => k.delete,     "delete"],
  [(k) => k.upArrow,    "upArrow"],
  [(k) => k.downArrow,  "downArrow"],
  [(k) => k.leftArrow,  "leftArrow"],
  [(k) => k.rightArrow, "rightArrow"],
  [(k) => k.pageUp,     "pageUp"],
  [(k) => k.pageDown,   "pageDown"],
  [(k) => k.tab,        "tab"],
];

export function keyOf(input: string, key: Key): string {
  for (const [pred, name] of SPECIAL) if (pred(key)) return name;
  return input;
}
