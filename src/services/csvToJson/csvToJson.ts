
export function csvToJson(csv: string): Record<string, string>[] {
	const lines = csv.trim().split('\n');
	if (lines.length < 2) return [];

	const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));

	return lines.slice(1).map(line => {
		const values = line.split(",");
		return headers.reduce((obj, header, i) => {
			obj[header] = (values[i] || '').trim().replace(/^"|"$/g, '');
			return obj;
		}, {} as Record<string, string>);
	});
}