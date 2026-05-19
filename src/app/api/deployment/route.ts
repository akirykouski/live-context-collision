import type { DeploymentInfo } from "@/lib/types";
import { classifyRequest, getResidencyStatus } from "@/lib/residency";
import { hasValkey } from "@/lib/valkey";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const status = getResidencyStatus();
  // Cloudflare adds CF-IPCountry; our edge Worker also forwards X-WG-Country.
  const country =
    req.headers.get("x-wg-country") || req.headers.get("cf-ipcountry") || null;
  const routing = classifyRequest(country);

  const info: DeploymentInfo = {
    runtime: process.env.WORKGRAPH_RUNTIME || "local-dev",
    region: process.env.WORKGRAPH_REGION || "local",
    queue: process.env.WORKGRAPH_QUEUE || (hasValkey() ? "Valkey" : "JSON fallback"),
    loadBalancer: process.env.WORKGRAPH_LOAD_BALANCER === "true",
    rawAudioStored: false,
    transcriptTtl: "24h",
    serverSideKeys: true,
    modules: ["Live Assist", "AI Gateway", "Service Agents", "Action Center"],
    valkeyConfigured: hasValkey(),
    timestamp: new Date().toISOString(),
    residency: {
      activeZone: status.activeZone,
      dataZone: status.dataZone,
      consistent: status.consistent,
      strict: status.strict,
      zones: status.zones,
      requestCountry: routing.country,
      routedCorrectly: routing.routedCorrectly,
    },
  };

  return NextResponse.json(info);
}
