import Soup from "gi://Soup?version=2.4";

const ByteArray = (globalThis as any).imports?.byteArray;

function bytesToString(bytes: Uint8Array | null | undefined) {
    if (!bytes) return "";
    if (typeof TextDecoder !== "undefined") return new TextDecoder().decode(bytes);
    if (!ByteArray) throw new Error("ByteArray support is unavailable");
    return ByteArray.toString(bytes);
}

function stringToBytes(text: string) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text);
    if (!ByteArray) throw new Error("ByteArray support is unavailable");
    return ByteArray.fromString(text);
}

const _session = new Soup.SessionAsync();
_session.timeout = 10;

function httpGet(url: string, headers: Record<string, string>): { status: number; body: string } {
    const message = Soup.Message.new("GET", url);
    for (const key of Object.keys(headers)) {
        const value = headers[key];
        if (value !== undefined) message.request_headers.append(key, value);
    }
    _session.send_message(message);
    const bytes = message.response_body ? message.response_body.flatten().get_data() : null;
    return {
        status: message.status_code,
        body: bytesToString(bytes),
    };
}

function httpPost(url: string, headers: Record<string, string>, body: any): { status: number; body: string } {
    const message = Soup.Message.new("POST", url);
    for (const key of Object.keys(headers)) {
        const value = headers[key];
        if (value !== undefined) message.request_headers.append(key, value);
    }
    message.set_request("application/json", Soup.MemoryUse.COPY, stringToBytes(JSON.stringify(body)));
    _session.send_message(message);
    const bytes = message.response_body ? message.response_body.flatten().get_data() : null;
    return {
        status: message.status_code,
        body: bytesToString(bytes),
    };
}

export const Http = { httpGet, httpPost };
