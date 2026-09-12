import { defineChannel, POST } from "eve/channels";
import { receiveFinProbe } from "../lib/fin-preview.js";

export default defineChannel({
  routes: [POST("/internal/fin-preview", receiveFinProbe)],
});
