
export async function csvToJson(csv: string): Promise<Record<string, string>[]> {
	let records = [] as Record<string, string>[];

	const parser = new CsvRecordParser((record) => records.push(record));
	parser.write(csv);
	parser.end();

	return records;
}

// parses csv incrementally - write() chunks of text as they arrive, and onRecord is called as each row is
// completed, so large files (e.g. a fetch response body) never need to be held in memory in full
export class CsvRecordParser {
	private headers: string[] | null = null;
	private remainder = ""; // an incomplete row from the end of the previous chunk

	constructor(private onRecord: (record: Record<string, string>) => void) { }

	write(chunk: string) {
		const text = this.remainder + chunk;
		const consumed = parseRows(text, false, (fields) => this.onRow(fields));
		this.remainder = text.slice(consumed);
	}

	end() {
		parseRows(this.remainder, true, (fields) => this.onRow(fields));
		this.remainder = "";
	}

	private onRow(fields: string[]) {
		if (fields.length === 1 && fields[0] === "") {
			return; // blank line
		}
		if (!this.headers) {
			this.headers = fields;
			return;
		}
		const headers = this.headers;
		this.onRecord(Object.fromEntries(headers.map((h, i) => [h, fields[i] ?? ""])));
	}
}

const DELIMITER = ",";
const QUOTE = '"';
const SPECIAL_CHARS = new RegExp(`[${DELIMITER}${QUOTE}\r\n]`, "g");

// calls onRow for each complete row in str, and returns the index after the last complete row.
// unless isFinal, a trailing row without a newline is left unparsed, as the rest of it may be in the next chunk
function parseRows(str: string, isFinal: boolean, onRow: (fields: string[]) => void): number {
	let pos = 0;
	let rowStart = 0;
	let fields = [] as string[];
	let fieldStart = 0;
	let inQuotes = false;
	let hasEscapes = false; // only slice-and-fix if we saw "" in this field
	let quotedField = null as string | null; // value of a quoted field, emitted at the following delimiter/newline

	function emitField(end: number) {
		if (quotedField !== null) {
			fields.push(quotedField);
			quotedField = null;
			return;
		}
		fields.push(str.slice(fieldStart, end));
	}

	while (pos < str.length) {
		SPECIAL_CHARS.lastIndex = pos;
		const match = SPECIAL_CHARS.exec(str);

		if (!match) {
			break;
		}

		pos = match.index;
		const ch = match[0];

		if (inQuotes) {
			if (ch === QUOTE) {
				if (str[pos + 1] === QUOTE) {
					hasEscapes = true;
					pos += 2;
				} else {
					// Closing quote — keep the value without the surrounding quotes
					const raw = str.slice(fieldStart, pos);
					quotedField = hasEscapes ? raw.replaceAll(QUOTE + QUOTE, QUOTE) : raw;
					hasEscapes = false;
					inQuotes = false;
					pos++;
					// Skip to next delimiter/newline (handles whitespace after closing quote)
					fieldStart = pos;
				}
			} else {
				pos++;
			}
		} else if (ch === QUOTE) {
			inQuotes = true;
			fieldStart = pos + 1; // exclude the opening quote
			pos++;
		} else if (ch === DELIMITER) {
			emitField(pos);
			fieldStart = pos + 1;
			pos++;
		} else {
			// a \r at the end of a chunk may be the first half of a \r\n
			if (ch === "\r" && pos + 1 === str.length && !isFinal) {
				break;
			}
			emitField(pos);
			onRow(fields);
			fields = [];
			pos += ch === "\r" && str[pos + 1] === "\n" ? 2 : 1;
			fieldStart = pos;
			rowStart = pos;
		}
	}

	if (isFinal && rowStart < str.length) {
		emitField(str.length);
		onRow(fields);
		return str.length;
	}

	return rowStart;
}
