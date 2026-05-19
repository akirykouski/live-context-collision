import type { DeploymentInfo } from "@/lib/types";
import { hasValkey } from "@/lib/valkey";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
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
  };

  return NextResponse.json(info);
}
