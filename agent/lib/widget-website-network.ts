import { Resolver } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { z } from "zod";

const denied = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  denied.addSubnet(address, prefix, "ipv4");
}
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const) {
  denied.addSubnet(address, prefix, "ipv6");
}

export function isPublicWebsiteAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? !denied.check(address, "ipv4")
    : family === 6 &&
        globalV6.check(address, "ipv6") &&
        !denied.check(address, "ipv6");
}

const dnsRecord = z.object({
  status: z.enum(["answered", "no_records", "unavailable"]),
  values: z.array(z.string().max(256)).max(10),
});
export const websiteNetworkSchema = z.object({
  dns: z.object({
    A: dnsRecord,
    AAAA: dnsRecord,
    CNAME: dnsRecord,
    NS: dnsRecord,
  }),
  domain: z.string().max(256),
  http: z.object({
    contentType: z.string().max(128).optional(),
    redirectHostname: z.string().max(256).nullable().optional(),
    status: z.enum([
      "responded",
      "blocked_address",
      "no_address",
      "unavailable",
    ]),
    statusCode: z.number().int().optional(),
  }),
});
type DnsRecord = z.infer<typeof dnsRecord>;
type HttpResult = z.infer<typeof websiteNetworkSchema>["http"];
interface DnsReader {
  cancel: () => void;
  resolve4: (domain: string) => Promise<string[]>;
  resolve6: (domain: string) => Promise<string[]>;
  resolveCname: (domain: string) => Promise<string[]>;
  resolveNs: (domain: string) => Promise<string[]>;
}

async function records(read: () => Promise<string[]>): Promise<DnsRecord> {
  try {
    const values = await read();
    return {
      status: values.length ? "answered" : "no_records",
      values: values.slice(0, 10),
    };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error ? error.code : null;
    return {
      status:
        code === "ENODATA" || code === "ENOTFOUND"
          ? "no_records"
          : "unavailable",
      values: [],
    };
  }
}

/** No cookies, auth, redirects, body reads or user-selected path. DNS is pinned
 * into the connection lookup, so a rebinding between check and connect cannot
 * switch the request onto an internal IP. TLS still verifies the original host. */
export function readWebsiteHttps(
  domain: string,
  address: string,
  signal: AbortSignal,
  requester: typeof request = request
): Promise<HttpResult> {
  return new Promise((resolve) => {
    const req = requester(
      {
        agent: false,
        family: isIP(address),
        hostname: domain,
        lookup: (_hostname, _options, callback) =>
          callback(null, address, isIP(address)),
        maxHeaderSize: 16_384,
        method: "GET",
        path: "/",
        port: 443,
        signal,
      },
      (response) => {
        let redirectHostname: string | null = null;
        if (response.headers.location) {
          try {
            redirectHostname = new URL(
              response.headers.location,
              `https://${domain}/`
            ).hostname;
          } catch {
            /* Invalid redirect: report HTTP status only. */
          }
        }
        resolve({
          contentType: response.headers["content-type"]?.slice(0, 128),
          redirectHostname,
          status: "responded",
          statusCode: response.statusCode,
        });
        response.destroy();
      }
    );
    req.on("error", () => resolve({ status: "unavailable" }));
    req.end();
  });
}

/** Called only after the tool proves current workspace and hosting assignment.
 * One root URL, four DNS questions, 8s total; browser rendering remains distinct. */
export async function readWebsiteNetwork(
  domain: string,
  signal: AbortSignal,
  resolver: DnsReader = new Resolver({ timeout: 2000, tries: 1 }),
  httpsRead = readWebsiteHttps
): Promise<z.infer<typeof websiteNetworkSchema>> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
  deadline.throwIfAborted();
  const cancel = () => resolver.cancel();
  deadline.addEventListener("abort", cancel, { once: true });
  try {
    const [A, AAAA, CNAME, NS] = await Promise.all([
      records(() => resolver.resolve4(domain)),
      records(() => resolver.resolve6(domain)),
      records(() => resolver.resolveCname(domain)),
      records(() => resolver.resolveNs(domain)),
    ]);
    signal.throwIfAborted();
    const addresses = [...A.values, ...AAAA.values];
    let http: HttpResult;
    if (addresses.some((address) => !isPublicWebsiteAddress(address))) {
      http = { status: "blocked_address" };
    } else if (A.status === "unavailable" || AAAA.status === "unavailable") {
      http = { status: "unavailable" };
    } else if (addresses.length === 0) {
      http = { status: "no_address" };
    } else {
      http = await httpsRead(domain, addresses[0], deadline);
    }
    signal.throwIfAborted();
    return {
      dns: { A, AAAA, CNAME, NS },
      domain,
      http,
    };
  } finally {
    deadline.removeEventListener("abort", cancel);
  }
}
