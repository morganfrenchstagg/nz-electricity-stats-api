import { getElementsByTagName, getText } from "domutils";
import { parseDocument } from "htmlparser2";

const emiDatasetsUrl = "https://emidatasets.blob.core.windows.net/publicdata?restype=container&comp=list";

export type EmiBlob = {
    name: string;
    url: string;
    lastModified: number; // epoch ms
}

/**
 * Lists every blob in EMI's public datasets under the given prefix. Azure returns at most 5000 blobs per
 * request, so this follows NextMarker until the listing is complete
 */
export async function listEmiDatasetBlobs(prefix: string): Promise<EmiBlob[]> {
    const blobs: EmiBlob[] = [];
    let marker = "";

    do {
        const url = `${emiDatasetsUrl}&prefix=${encodeURIComponent(prefix)}` + (marker ? `&marker=${encodeURIComponent(marker)}` : "");
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to list EMI datasets under ${prefix}: ${response.status}`);
        }

        const xmlDoc = parseDocument(await response.text(), { xmlMode: true, decodeEntities: true });

        for (const blob of getElementsByTagName("Blob", xmlDoc)) {
            blobs.push({
                name: getText(getElementsByTagName("Name", blob)[0]) || "",
                url: getText(getElementsByTagName("Url", blob)[0]),
                lastModified: Date.parse(getText(getElementsByTagName("Last-Modified", blob)[0])),
            });
        }

        const nextMarker = getElementsByTagName("NextMarker", xmlDoc)[0];
        marker = nextMarker ? getText(nextMarker) : "";
    } while (marker);

    return blobs;
}
