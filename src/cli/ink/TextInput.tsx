import { Text } from "ink";
import chalk from "chalk";
import type { TextBuffer } from "./hooks/useTextInput.js";

interface Props {
  buffer: TextBuffer;
  prompt: string;
  /** Render caret inverted on the current character. */
  showCaret: boolean;
  /** Shown in dim style when the buffer is empty. The caret inverts its first char. */
  placeholder?: string;
}

/**
 * Renders a multiline text buffer with an inverted caret at the cursor position.
 * Prefixes the first line with `prompt`; continuation lines are indented to match.
 */
export function TextInput({ buffer, prompt, showCaret, placeholder }: Props) {
  const plainPromptLen = stripAnsi(prompt).length;
  const indent = " ".repeat(plainPromptLen);

  const isEmpty = buffer.lines.length === 1 && buffer.lines[0] === "";
  if (isEmpty && placeholder && placeholder.length > 0) {
    return (
      <Text>
        {prompt}
        {showCaret ? <Text inverse>{chalk.dim(placeholder[0])}</Text> : chalk.dim(placeholder[0])}
        {chalk.dim(placeholder.slice(1))}
      </Text>
    );
  }

  return (
    <>
      {buffer.lines.map((line, row) => {
        const isCursorRow = showCaret && row === buffer.row;
        const prefix = row === 0 ? prompt : indent;
        if (!isCursorRow) {
          return (
            <Text key={row}>
              {prefix}
              {line || " "}
            </Text>
          );
        }
        const before = line.slice(0, buffer.col);
        const caretChar = buffer.col < line.length ? line[buffer.col] : " ";
        const after = buffer.col < line.length ? line.slice(buffer.col + 1) : "";
        return (
          <Text key={row}>
            {prefix}
            {before}
            <Text inverse>{caretChar}</Text>
            {after}
          </Text>
        );
      })}
    </>
  );
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}
