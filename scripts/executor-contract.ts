import { readFile } from "node:fs/promises";
import { toolkitUrl } from "../agent/lib/executor/endpoint.js";
import { REQUIRED_HELPER_OPERATIONS } from "../agent/lib/executor/requests.js";

const manifest = JSON.parse(
  await readFile(
    new URL("../.github/executor/toolkit-manifest.json", import.meta.url),
    "utf8"
  )
);
console.log(
  JSON.stringify(
    {
      ...manifest,
      endpoint: toolkitUrl(),
      helperOperations: REQUIRED_HELPER_OPERATIONS,
      notes: [
        "Root, critic, factory, schedules, and authored helpers share one toolkit and the same provider accounts.",
        "Skills define workflow responsibilities; critic instructions require read-only review.",
        "Prefer authored helpers for validation, bounded results, and provenance. Their underlying operations share this toolkit and are not hidden from discovery.",
        "The selected operation list preserves existing provider access, including Linear writes and OpenRouter requests; Vercel operations remain pending connection setup.",
        "Personal Supermemory remains separate. Executor management, artifacts, and approval resume are not offered.",
      ],
    },
    null,
    2
  )
);
