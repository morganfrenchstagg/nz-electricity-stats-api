export type PocpOutage = {
    id: string;
    orgId: string;
    outageBlock: string;
    ownerOutageId: string;
    revisionId: number;
    revisionVersion: number;
    timeStart: string;
    timeEnd: string;
    timeType: string;
    gridPoints: [];
    category: string;
    mwattRemaining: number;
    mwattLost: number;
    planningStatus: string;
    recallTime: string;
    nature: string;
    outageReason: string;
    pci: boolean;
    lastModifiedAt: string;
    lastModifiedBy: string;
    lastModifiedByName: string;
    howOutageModified: string;
    createdAt: string;
}