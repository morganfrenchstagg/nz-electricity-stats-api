export const ONE_DAY_IN_SECONDS = 60 * 60 * 24;

export function getJsonResponseWithMaxAgeHeader(json: any, headers?: Record<string, string>) {
    headers = {
        ...headers,
        "Cache-Control": `max-age=${ONE_DAY_IN_SECONDS}`
    }
    return getJsonResponseWithHeaders(json, headers);
}

export function getJsonResponseWithHeaders(json: any, headers: Record<string, string>) {
    const headersObj = new Headers();

    for (let obj in headers) {
        headersObj.set(obj, headers[obj]);
    }

    const resp = Response.json(json, {
        headers: headersObj
    });

    return resp;
}