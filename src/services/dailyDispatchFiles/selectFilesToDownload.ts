export type EmiDailyFile = {
    date: string; // YYYYMMDD
    url: string;
    lastModified: number; // epoch ms, when EMI last published the file
}

/**
 * Picks which of EMI's daily dispatch files need downloading, oldest first:
 * - any file for a date after the last sync
 * - older files we don't have a copy of, or that EMI has republished since we stored them
 */
export function selectFilesToDownload(emiFiles: EmiDailyFile[], lastSyncDate: string | null, storedUploadTimes: Map<string, number>): EmiDailyFile[] {
    return emiFiles
        .filter(file => {
            if (!lastSyncDate || file.date > lastSyncDate) {
                return true;
            }
            const uploaded = storedUploadTimes.get(file.date);
            return uploaded === undefined || file.lastModified > uploaded;
        })
        .sort((a, b) => a.date.localeCompare(b.date));
}
