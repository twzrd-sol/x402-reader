import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
const bl = new BlockList();
for (const [n, p, t] of [
  ['0.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.168.0.0', 16, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['::1', 128, 'ipv6'], ['::', 128, 'ipv6'], ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6'],
]) bl.addSubnet(n, p, t);
const BAD_NAME = /^(localhost|metadata\.google\.internal)$|\.(local|localhost|internal|lan)$/i;
export function ipBlocked(addr) {
  const a = addr.toLowerCase().replace(/^\[|\]$/g, '');
  if (a.startsWith('::ffff:')) return ipBlocked(a.slice(7));
  const v = isIP(a);
  return !v || bl.check(a, v === 4 ? 'ipv4' : 'ipv6');
}
function weirdHost(host) {
  if (BAD_NAME.test(host) || /^0x[0-9a-f]+$/i.test(host)) return true;
  if (/^\d+$/.test(host)) return Number(host) <= 0xffffffff;
  return /^[\d.]+$/.test(host) && !isIP(host);
}
export async function assertPublicHttpUrl(input) {
  let u;
  try { u = new URL(input); } catch { throw Object.assign(new Error('bad url'), { code: 'BAD_URL' }); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw Object.assign(new Error('bad url'), { code: 'BAD_URL' });
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (weirdHost(host) || (isIP(host) && ipBlocked(host))) {
    throw Object.assign(new Error('private target'), { code: 'SSRF' });
  }
  let recs;
  try { recs = await lookup(host, { all: true }); }
  catch { throw Object.assign(new Error('dns failed'), { code: 'SSRF' }); }
  if (!recs.length || recs.some((r) => ipBlocked(r.address))) {
    throw Object.assign(new Error('private target'), { code: 'SSRF' });
  }
  return u;
}
