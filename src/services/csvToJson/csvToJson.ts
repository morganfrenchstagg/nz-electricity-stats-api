
export async function csvToJson(csv: string): Promise<Record<string, string>[]> {
	let headers = [] as string[];
	let records = [] as Record<string, string>[];

	parseCSV(csv, (fields: string[], rowIndex: number) => {
		if (rowIndex === 0) {
			headers = fields;
			return;
		}
		records.push(Object.fromEntries(headers.map((h, i) => [h, fields[i] ?? ""])));
	});

	return records;
}

function parseCSV(str: string, onRow: any, { delimiter = ",", quote = '"' } = {}) {
	let pos = 0;
	let rowIndex = 0;
	let fields = [] as string[];
	let fieldStart = 0;
	let inQuotes = false;
	let hasEscapes = false; // only slice-and-fix if we saw "" in this field

	const specialChars = new RegExp(`[${delimiter}\r\n]`, "g");

	function emitField(end: number) {
		const raw = str.slice(fieldStart, end);
		fields.push(raw)
		fields.push(hasEscapes ? raw.replaceAll(quote + quote, quote) : raw);
		hasEscapes = false;
	}

	while (pos < str.length) {
		specialChars.lastIndex = pos;
		const match = specialChars.exec(str);

		if (!match) {
			emitField(str.length);
			break;
		}

		pos = match.index;
		const ch = match[0];

		if (inQuotes) {
			if (ch === quote) {
				if (str[pos + 1] === quote) {
					hasEscapes = true;
					pos += 2;
				} else {
					// Closing quote — emit without the surrounding quotes
					emitField(pos);
					inQuotes = false;
					pos++;
					// Skip to next delimiter/newline (handles whitespace after closing quote)
					fieldStart = pos;
				}
			} else {
				pos++;
			}
		} else {
			if (ch === quote) {
				inQuotes = true;
				fieldStart = pos + 1; // exclude the opening quote
				pos++;
			} else if (ch === delimiter) {
				emitField(pos);
				fieldStart = pos + 1;
				pos++;
			} else {
				if (ch === "\r" && str[pos + 1] === "\n") pos++;
				emitField(pos);
				onRow(fields, rowIndex++);
				fields = [];
				fieldStart = pos + 1;
				pos++;
			}
		}
	}

	if (pos > fieldStart || fields.length) {
		emitField(pos);
		onRow(fields, rowIndex);
	}
}