import * as fs from "fs";

/**
 * Write `text` to `file` and read it back to confirm it landed. Returns an error
 * message if the file is missing or the wrong size afterwards, or null if it's
 * fine. Exists because a run output once came back empty from a successful model
 * call; a silent empty file must be caught where it happens, not downstream.
 */
export function writeVerified(file: string, text: string): string | null {
  try {
    fs.writeFileSync(file, text, "utf8");
    const expected = Buffer.byteLength(text, "utf8");
    const actual = fs.statSync(file).size;
    if (actual !== expected) return `wrote ${expected} bytes to ${file} but it holds ${actual} bytes`;
    return null;
  } catch (e) {
    return `could not write ${file}: ${e}`;
  }
}
