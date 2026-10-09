// passes on only the first line (e.g. a csv header) and the lines containing pattern, so the rest of a large
// file can be skipped without being parsed. write() chunks of text as they arrive - a line split across
// chunks is held until the rest of it arrives
export class LineFilter {
	private remainder = ""; // an incomplete line from the end of the previous chunk
	private passedFirstLine = false;

	constructor(private pattern: string, private onText: (text: string) => void) { }

	write(chunk: string) {
		const text = this.remainder + chunk;
		const lastNewline = text.lastIndexOf("\n");
		this.remainder = text.slice(lastNewline + 1);

		if (lastNewline === -1) {
			return;
		}

		const kept = [] as string[];
		let pos = 0;

		if (!this.passedFirstLine) {
			pos = text.indexOf("\n") + 1;
			kept.push(text.slice(0, pos));
			this.passedFirstLine = true;
		}

		// jump straight to each match, rather than checking every line
		let match;
		while ((match = text.indexOf(this.pattern, pos)) !== -1 && match < lastNewline) {
			const lineStart = text.lastIndexOf("\n", match) + 1;
			pos = text.indexOf("\n", match) + 1;
			kept.push(text.slice(lineStart, pos));
		}

		if (kept.length > 0) {
			this.onText(kept.join(""));
		}
	}

	end() {
		if (!this.passedFirstLine || this.remainder.includes(this.pattern)) {
			this.onText(this.remainder);
		}
		this.remainder = "";
	}
}
