// fetch for a URL an AGENT chose: the public internet only. This server
// sits on the stack's private network, where docker-proxy, disk-quota and
// cloudbeaver answer anyone who can reach them — the network is their
// boundary. A fetch of an agent's URL must not cross it (SSRF), so every
// connection — the first and each redirect — resolves the name here and
// refuses any address that is not public unicast: loopback, private,
// link-local (cloud metadata), unique-local, multicast, unspecified. The
// check sits at connect time, on the address actually dialled, so a name
// that resolves privately or a redirect to one is caught the same way.
//
// undici's OWN fetch, not Node's global: the dispatcher must come from the
// same undici (see telegram/connect.ts).
import dns from 'node:dns/promises';
import net from 'node:net';
import { Agent, buildConnector, fetch } from 'undici';
import ipaddr from 'ipaddr.js';

export class PrivateAddressError extends Error {
  constructor(hostname: string, address: string) { super(`${hostname} resolves to ${address}, which is not a public address`); this.name = 'PrivateAddressError'; }
}

/** Public unicast — every other range ipaddr.js names is local to somewhere. */
export function isPublicAddress(address: string): boolean {
  let ip = ipaddr.parse(address);
  if (ip.kind() === 'ipv6' && (ip as ipaddr.IPv6).isIPv4MappedAddress()) ip = (ip as ipaddr.IPv6).toIPv4Address();
  return ip.range() === 'unicast';
}

/** The public address a host name stands for right now; the name itself
 *  may already be an address. */
async function publicAddressOf(hostname: string): Promise<string> {
  const address = net.isIP(hostname) ? hostname : (await dns.lookup(hostname)).address;
  if (!isPublicAddress(address)) throw new PrivateAddressError(hostname, address);
  return address;
}

const dial = buildConnector({});
const agent = new Agent({
  connect: (options, callback) => {
    // Connect to the checked address; `host` stays the name, so TLS still
    // presents it (SNI) and the far end sees the URL it was asked for.
    publicAddressOf(options.hostname).then(
      (address) => dial({ ...options, hostname: address }, callback),
      (error: Error) => callback(error, null));
  },
});

/** fetch, allowed to reach the public internet only. */
export function publicFetch(url: string, init: Parameters<typeof fetch>[1] = {}): Promise<Response> {
  return fetch(url, { ...init, dispatcher: agent }) as unknown as Promise<Response>;
}
