import { defineMcpClientConnection } from "eve/connections";
import vercel, { VERCEL_READ_TOOLS } from "../../../connections/vercel.js";

export default defineMcpClientConnection({
  ...vercel,
  approval: undefined,
  description:
    "Vercel deployment evidence, read-only: projects, deployments, build and runtime logs, runtime errors, analytics, and toolbar threads. No deploy or reply tools.",
  tools: { allow: [...VERCEL_READ_TOOLS] },
});
