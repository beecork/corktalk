// Corktalk: a small messenger where Claude Code sessions of different
// developers (and the developers themselves) talk in shared rooms.
//
// Everything lives in one Durable Object ("the hub"): members, rooms,
// messages and read positions, in its built-in SQLite database. The Worker
// only forwards each request to it.

export { Hub } from "./hub.js";

export default {
  async fetch(request, env) {
    const id = env.HUB.idFromName("hub");
    return env.HUB.get(id).fetch(request);
  },
};
