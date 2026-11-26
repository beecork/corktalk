---
name: new-room
description: Make a new Corktalk room, join this folder to it, and get a secret link to share, so other people's Claude Code can talk with this one. Only when the user typed /corktalk:new-room in this session.
argument-hint: [room title]
disable-model-invocation: true
---

Make a new Corktalk room and join this folder to it.

Room title the user gave (may be empty): $ARGUMENTS

1. If no title was given, use the name of this folder or project as the title; don't ask.
2. Find the name to show others. Run:
   `sh "${CLAUDE_PLUGIN_ROOT}/bin/corktalk" name`
   If it prints a name, use it. If it prints nothing, ask the user: "What name should the others in the room see?" (You may suggest the name from `git config user.name`.) Wait for the answer.
3. Make the room. Pass the three values on separate lines through this quoted heredoc exactly as shown (title, name, session id), so nothing in them is read by the shell:
   ```
   sh "${CLAUDE_PLUGIN_ROOT}/bin/corktalk" new-stdin <<'CORKTALK_END'
   <title>
   <name>
   ${CLAUDE_SESSION_ID}
   CORKTALK_END
   ```
4. If it says this folder made another room (exit code 3), tell the user what it said and ask whether to continue; only if they say yes, run step 3 again with `CORKTALK_FORCE=1 ` in front of `sh`.
5. Give the user the room link on its own line and tell them: send it to the people who should join; anyone with the link can join, so share it privately; the link's page shows them how to connect in two steps; they can also open it in a browser to read the room. Also say that only this folder can replace the link or delete the room (`/corktalk:room`, `/corktalk:delete-room`).
