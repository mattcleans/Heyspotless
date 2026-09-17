/**
 * A CSV parser, because the export is a CSV and adding a dependency to read one
 * file once is not a trade worth making.
 *
 * THE THREE THINGS A NAIVE SPLIT GETS WRONG, all of which are in a real
 * Housecall Pro export:
 *
 *   1. A quoted field containing a comma — every address with a unit number.
 *   2. A quoted field containing a NEWLINE — every "notes" field where somebody
 *      pressed enter. Splitting on newlines first turns one customer into three
 *      broken rows, and the broken ones look enough like data to be imported.
 *   3. A doubled quote inside a quoted field (`""`), which is how CSV escapes a
 *      quote — the 6" baseboards note.
 *
 * RFC 4180, plus the one deviation everybody needs: a bare CR or CRLF is a row
 * break, because exports come off Windows.
 */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false;

  // Strip a UTF-8 BOM. Excel writes one, and it otherwise becomes part of the
  // first column's name — so `id` silently never matches.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const pushField = () => {
    row.push(field);
    field = "";
    started = false;
  };
  const pushRow = () => {
    pushField();
    // A trailing newline should not produce a final empty row.
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };

  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;

    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && !started) {
      quoted = true;
      started = true;
      continue;
    }

    if (char === ",") {
      pushField();
      continue;
    }

    if (char === "\r") {
      if (input[i + 1] === "\n") i++;
      pushRow();
      continue;
    }

    if (char === "\n") {
      pushRow();
      continue;
    }

    field += char;
    started = true;
  }

  // Whatever is left when the file ends, unless the file ended on a newline.
  if (field !== "" || row.length > 0) pushRow();

  return rows;
}

/**
 * Rows keyed by column name, with the names normalised.
 *
 * WHY NORMALISE. Housecall Pro's exports have changed their column headings at
 * least twice — "Customer ID", "customer_id", "Customer Id" — and an importer
 * that breaks on a capital letter is an importer somebody edits at 11pm on
 * migration night. Lower-cased, non-alphanumerics collapsed to a single
 * underscore, so all three read as `customer_id`.
 */
export function toRecords(rows: readonly string[][]): Record<string, string>[] {
  const [header, ...body] = rows;
  if (!header) return [];

  const keys = header.map(normaliseHeader);

  return body
    .filter((row) => row.some((cell) => cell.trim() !== ""))
    .map((row) => {
      const record: Record<string, string> = {};
      keys.forEach((key, i) => {
        if (key) record[key] = (row[i] ?? "").trim();
      });
      return record;
    });
}

export function normaliseHeader(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * The first of several column names that is present and non-empty.
 *
 * Exports name the same thing differently across versions and across the three
 * files. Rather than one canonical guess, every read says what it will accept.
 */
export function pick(record: Record<string, string>, ...names: string[]): string | null {
  for (const name of names) {
    const value = record[name];
    if (value !== undefined && value.trim() !== "") return value.trim();
  }
  return null;
}
