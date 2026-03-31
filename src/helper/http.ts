/* oxlint-disable no-unused-vars */

const Soup = imports.gi.Soup;
const GLib = imports.gi.GLib;

const _session = new Soup.Session();
_session.timeout = 10;

function httpGet(
  url: string,
  headers: Record<string, string>,
): { status: number; body: string } {
  const message = Soup.Message.new("GET", url);
  const reqHeaders = message.get_request_headers();
  for (const key of Object.keys(headers)) {
    reqHeaders.append(key, headers[key]);
  }
  const bytes = _session.send_and_read(message, null);
  return {
    status: message.get_status(),
    body: bytes ? new TextDecoder().decode(bytes.get_data()) : "",
  };
}

function httpPost(
  url: string,
  headers: Record<string, string>,
  body: any,
): { status: number; body: string } {
  const message = Soup.Message.new("POST", url);
  const reqHeaders = message.get_request_headers();
  for (const key of Object.keys(headers)) {
    reqHeaders.append(key, headers[key]);
  }
  const encoded = new TextEncoder().encode(JSON.stringify(body));
  message.set_request_body_from_bytes("application/json", new GLib.Bytes(encoded));
  const responseBytes = _session.send_and_read(message, null);
  return {
    status: message.get_status(),
    body: responseBytes ? new TextDecoder().decode(responseBytes.get_data()) : "",
  };
}

var Http = { httpGet, httpPost };
