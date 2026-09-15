import { defineChannel, POST } from "eve/channels";
import { receiveFinContext } from "../lib/fin-context-route.js";

export default defineChannel({
  routes: [
    POST("/internal/fin/context", (request) => receiveFinContext(request)),
  ],
});
