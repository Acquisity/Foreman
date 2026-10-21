// Lets a scheduled check that finds nothing end its turn without posting; eve 0.69 removed the empty-delivery marker.
import { noReply } from "eve/tools/no_reply";

export default noReply();
