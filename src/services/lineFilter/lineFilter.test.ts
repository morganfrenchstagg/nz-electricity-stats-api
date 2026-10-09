import { describe, expect, it } from "vitest";
import { LineFilter } from "./lineFilter";

function filter(pattern: string, chunks: string[]) {
    let output = "";
    const lineFilter = new LineFilter(pattern, (text) => output += text);
    chunks.forEach(chunk => lineFilter.write(chunk));
    lineFilter.end();
    return output;
}

describe("LineFilter", () => {
    it("should keep the first line, and lines containing the pattern", () => {
        const text = "Name,IsLatest\nA,N,1\nB,Y,2\nC,N,3\nD,Y,4\n";

        expect(filter(",Y,", [text])).toEqual("Name,IsLatest\nB,Y,2\nD,Y,4\n");
    });

    it("should give the same output wherever the chunks are split", () => {
        const text = "Name,IsLatest\nA,N,1\nB,Y,2\nC,N,3\nD,Y,4\nE,Y,5\nF,N,6\n";
        const expected = filter(",Y,", [text]);

        for (let i = 0; i <= text.length; i++) {
            for (let j = i; j <= text.length; j++) {
                expect(filter(",Y,", [text.slice(0, i), text.slice(i, j), text.slice(j)])).toEqual(expected);
            }
        }
    });

    it("should keep crlf line endings", () => {
        expect(filter(",Y,", ["Name,IsLatest\r\nA,N,1\r\nB,Y,2\r\n"])).toEqual("Name,IsLatest\r\nB,Y,2\r\n");
    });

    it("should keep a matching last line without a newline", () => {
        expect(filter(",Y,", ["Name,IsLatest\nA,N,1\nB,Y,2"])).toEqual("Name,IsLatest\nB,Y,2");
        expect(filter(",Y,", ["Name,IsLatest\nA,Y,1\nB,N,2"])).toEqual("Name,IsLatest\nA,Y,1\n");
    });

    it("should keep the first line even if nothing matches", () => {
        expect(filter(",Y,", ["Name,IsLatest\nA,N,1\n"])).toEqual("Name,IsLatest\n");
        expect(filter(",Y,", ["Name,IsLatest"])).toEqual("Name,IsLatest");
    });
});
