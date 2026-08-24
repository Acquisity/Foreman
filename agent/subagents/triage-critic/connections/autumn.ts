import { defineMcpClientConnection } from "eve/connections";
import autumn, { AUTUMN_READ_TOOLS } from "../../../connections/autumn.js";

export default defineMcpClientConnection({
  ...autumn,
  description:
    "Autumn entitlement and provisioning evidence, read-only. The inherited user authorization remains in force, and unavailable access is an explicit evidence gap.",
  tools: { allow: [...AUTUMN_READ_TOOLS] },
});
